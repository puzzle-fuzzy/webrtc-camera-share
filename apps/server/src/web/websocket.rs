use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{
        ConnectInfo, Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};
use uuid::Uuid;

use crate::{
    domain::{
        room::{
            JoinResult, OutboundMessage, PeerSender, QueuedOutbound, hash_access_code,
            is_valid_access_code, normalize_room_id,
        },
        signal::{Role, ValidatedSignal, parse_client_signal},
    },
    infrastructure::limits::{ConnectionLease, SignalBudget},
};

use super::{
    AppState, HttpState,
    security::{client_ip, origin_allowed},
};

const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const WRITER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_WEBSOCKET_MESSAGE_SIZE: usize = 96 * 1024;

#[derive(Deserialize)]
pub(super) struct ConnectParams {
    role: Role,
    room: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthenticationMessage {
    #[serde(rename = "type")]
    kind: String,
    key: String,
}

pub(super) async fn websocket(
    State(state): State<HttpState>,
    Query(params): Query<ConnectParams>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers, &state.app.allowed_origins) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(room_id) = normalize_room_id(&params.room) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let ip = client_ip(&headers, address.ip(), state.app.trust_proxy);
    let Some(lease) = state.app.connections.acquire(ip) else {
        state.app.metrics.record_connection_rejection();
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };

    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, state.app, room_id, params.role, ip, lease))
        .into_response()
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    room_id: String,
    role: Role,
    ip: IpAddr,
    _lease: ConnectionLease,
) {
    let peer_id = Uuid::new_v4();
    let (outbound, outbound_messages) = PeerSender::channel(state.metrics.clone());
    let Some(receiver_ids) = authenticate_and_join(
        &mut socket,
        &state,
        &room_id,
        role,
        peer_id,
        ip,
        outbound.clone(),
    )
    .await
    else {
        return;
    };
    let mut shutdown = state.subscribe_shutdown();
    if *shutdown.borrow() {
        close_socket(&mut socket, 1012, "service restart").await;
        disconnect_peer(&state, &room_id, role, peer_id);
        return;
    }

    if state.turn.is_some() && !state.turn_credentials.allow(ip) {
        state.metrics.record_turn_credential_rejection();
        close_socket(&mut socket, 4030, "TURN credential rate exceeded").await;
        disconnect_peer(&state, &room_id, role, peer_id);
        return;
    }

    let authenticated = json!({
        "type": "authenticated",
        "iceServers": state.authenticated_ice_servers(peer_id),
        "maxReceivers": state.max_receivers,
    });
    if socket
        .send(Message::Text(authenticated.to_string().into()))
        .await
        .is_err()
    {
        disconnect_peer(&state, &room_id, role, peer_id);
        return;
    }
    for receiver_id in receiver_ids {
        if socket
            .send(Message::Text(
                json!({ "type": "receiver-ready", "peerId": receiver_id })
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
        {
            disconnect_peer(&state, &room_id, role, peer_id);
            return;
        }
    }

    tracing::info!(%room_id, %peer_id, %role, %ip, "signal peer connected");
    let (socket_sender, mut socket_receiver) = socket.split();
    let mut writer = tokio::spawn(write_socket(socket_sender, outbound_messages));
    let mut heartbeat = interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_seen = Instant::now();
    let mut signal_budget = SignalBudget::new();
    let mut receiver_ready_sent = false;

    let writer_finished = loop {
        tokio::select! {
            shutdown_result = shutdown.changed() => {
                if shutdown_result.is_ok() && *shutdown.borrow() {
                    let _ = send_outbound(
                        &outbound,
                        OutboundMessage::Close {
                            code: 1012,
                            reason: "service restart".to_owned(),
                        },
                    );
                }
                break false;
            }
            _ = outbound.cancelled() => break false,
            writer_result = &mut writer => {
                if let Err(error) = writer_result {
                    tracing::warn!(%room_id, %peer_id, %error, "websocket writer task failed");
                }
                break true;
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= IDLE_TIMEOUT {
                    let _ = send_outbound(
                        &outbound,
                        OutboundMessage::Close {
                            code: 4008,
                            reason: "idle timeout".to_owned(),
                        },
                    );
                    break false;
                }
                if !send_outbound(&outbound, OutboundMessage::Ping) {
                    break false;
                }
            }
            incoming = socket_receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(message))) => {
                        last_seen = Instant::now();
                        if rate_limit_exceeded(&state, &outbound, &mut signal_budget, message.len()) {
                            break false;
                        }
                        handle_signal(
                            &state,
                            &room_id,
                            role,
                            peer_id,
                            &outbound,
                            &mut receiver_ready_sent,
                            message.as_str(),
                        );
                    }
                    Some(Ok(Message::Binary(payload))) => {
                        last_seen = Instant::now();
                        if rate_limit_exceeded(&state, &outbound, &mut signal_budget, payload.len()) {
                            break false;
                        }
                        send_error(
                            &outbound,
                            "INVALID_SIGNAL",
                            "仅支持文本格式的 JSON 信令",
                            None,
                        );
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        last_seen = Instant::now();
                        if rate_limit_exceeded(&state, &outbound, &mut signal_budget, payload.len()) {
                            break false;
                        }
                        if !send_outbound(&outbound, OutboundMessage::Pong(payload.to_vec())) {
                            break false;
                        }
                    }
                    Some(Ok(Message::Pong(payload))) => {
                        last_seen = Instant::now();
                        if rate_limit_exceeded(&state, &outbound, &mut signal_budget, payload.len()) {
                            break false;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break false,
                    Some(Err(error)) => {
                        tracing::warn!(%room_id, %peer_id, %role, %error, "websocket receive failed");
                        break false;
                    }
                }
            }
        }
    };

    disconnect_peer(&state, &room_id, role, peer_id);
    drop(outbound);
    if !writer_finished && timeout(WRITER_SHUTDOWN_TIMEOUT, &mut writer).await.is_err() {
        writer.abort();
        let _ = writer.await;
    }
    tracing::info!(%room_id, %peer_id, %role, %ip, "signal peer disconnected");
}

async fn authenticate_and_join(
    socket: &mut WebSocket,
    state: &AppState,
    room_id: &str,
    role: Role,
    peer_id: Uuid,
    ip: IpAddr,
    outbound: PeerSender,
) -> Option<Vec<Uuid>> {
    if state.authentication.is_blocked(ip, room_id) {
        state.metrics.record_authentication_block();
        close_socket(socket, 4028, "too many authentication failures").await;
        return None;
    }

    let message = match timeout(AUTHENTICATION_TIMEOUT, socket.next()).await {
        Ok(Some(Ok(Message::Text(message)))) => message,
        Ok(Some(Ok(_))) => {
            close_socket(socket, 4000, "authentication message required").await;
            return None;
        }
        Ok(Some(Err(_))) | Ok(None) => return None,
        Err(_) => {
            close_socket(socket, 4012, "authentication timeout").await;
            return None;
        }
    };
    let authentication = match serde_json::from_str::<AuthenticationMessage>(message.as_str()) {
        Ok(authentication)
            if authentication.kind == "authenticate"
                && is_valid_access_code(&authentication.key) =>
        {
            authentication
        }
        _ => {
            state.authentication.record_failure(ip, room_id);
            state.metrics.record_authentication_failure();
            close_socket(socket, 4000, "invalid authentication message").await;
            return None;
        }
    };

    let join_result = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .join(
            room_id,
            hash_access_code(&authentication.key),
            role,
            peer_id,
            outbound,
        );
    match join_result {
        JoinResult::Joined { receiver_ids } => {
            state.authentication.record_success(ip, room_id);
            Some(receiver_ids)
        }
        JoinResult::InvalidAccessCode => {
            state.authentication.record_failure(ip, room_id);
            state.metrics.record_authentication_failure();
            close_socket(socket, 4003, "invalid access code").await;
            None
        }
        JoinResult::RoleOccupied => {
            state.authentication.record_success(ip, room_id);
            close_socket(socket, 4009, "role occupied").await;
            None
        }
        JoinResult::RoomFull => {
            state.authentication.record_success(ip, room_id);
            close_socket(socket, 4010, "room full").await;
            None
        }
        JoinResult::ServerFull => {
            close_socket(socket, 4011, "room capacity reached").await;
            None
        }
    }
}

async fn write_socket(
    mut socket: SplitSink<WebSocket, Message>,
    mut outbound: tokio::sync::mpsc::Receiver<QueuedOutbound>,
) {
    while let Some(mut queued) = outbound.recv().await {
        let message = queued.take_message();
        let should_close = matches!(message, OutboundMessage::Close { .. });
        let message = match message {
            OutboundMessage::Text(message) => Message::Text(message.into()),
            OutboundMessage::Ping => Message::Ping(Bytes::new()),
            OutboundMessage::Pong(payload) => Message::Pong(payload.into()),
            OutboundMessage::Close { code, reason } => Message::Close(Some(CloseFrame {
                code,
                reason: reason.into(),
            })),
        };
        if socket.send(message).await.is_err() || should_close {
            break;
        }
    }
}

fn handle_signal(
    state: &AppState,
    room_id: &str,
    role: Role,
    peer_id: Uuid,
    outbound: &PeerSender,
    receiver_ready_sent: &mut bool,
    message: &str,
) {
    let signal = match parse_client_signal(role, message) {
        Ok(signal) => signal,
        Err(message) => {
            send_error(outbound, "INVALID_SIGNAL", &message, None);
            return;
        }
    };

    if signal.value.get("type").and_then(Value::as_str) == Some("receiver-ready") {
        if *receiver_ready_sent {
            send_error(
                outbound,
                "INVALID_SIGNAL",
                "receiver-ready 每个连接只能发送一次",
                None,
            );
            return;
        }
        *receiver_ready_sent = true;
    }

    match role {
        Role::Send => route_sender_signal(state, room_id, outbound, signal),
        Role::Recv => route_receiver_signal(state, room_id, peer_id, outbound, signal),
    }
}

fn route_sender_signal(
    state: &AppState,
    room_id: &str,
    outbound: &PeerSender,
    signal: ValidatedSignal,
) {
    let Some(peer_id) = signal.target_peer_id else {
        return;
    };
    let receiver = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .receiver(room_id, peer_id);

    if let Some(receiver) = receiver {
        if !send_json(&receiver, signal.value) {
            state.disconnect_overloaded_peer(&receiver);
            send_error(
                outbound,
                "PEER_OVERLOADED",
                "接收端处理信令过慢",
                Some(peer_id),
            );
        } else {
            state.metrics.record_routed_signal();
        }
    } else {
        send_error(outbound, "PEER_NOT_FOUND", "接收端已离线", Some(peer_id));
    }
}

fn route_receiver_signal(
    state: &AppState,
    room_id: &str,
    peer_id: Uuid,
    outbound: &PeerSender,
    mut signal: ValidatedSignal,
) {
    let sender = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .sender(room_id);
    let Some(sender) = sender else {
        return;
    };

    if let Some(object) = signal.value.as_object_mut() {
        object.insert("peerId".to_owned(), Value::String(peer_id.to_string()));
    }
    if !send_json(&sender, signal.value) {
        state.disconnect_overloaded_peer(&sender);
        send_error(outbound, "PEER_OVERLOADED", "发送端处理信令过慢", None);
    } else {
        state.metrics.record_routed_signal();
    }
}

fn disconnect_peer(state: &AppState, room_id: &str, role: Role, peer_id: Uuid) {
    let notify = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .leave(room_id, role, peer_id);
    let left_message = match role {
        Role::Send => json!({ "type": "peer-left", "role": "send" }),
        Role::Recv => json!({ "type": "peer-left", "role": "recv", "peerId": peer_id }),
    };
    for peer in notify {
        if !send_json(&peer, left_message.clone()) {
            state.disconnect_overloaded_peer(&peer);
        }
    }
}

fn send_error(outbound: &PeerSender, code: &str, message: &str, peer_id: Option<Uuid>) {
    let mut value = json!({
        "type": "error",
        "code": code,
        "message": message,
    });
    if let (Some(object), Some(peer_id)) = (value.as_object_mut(), peer_id) {
        object.insert("peerId".to_owned(), Value::String(peer_id.to_string()));
    }
    let _ = send_json(outbound, value);
}

fn send_json(outbound: &PeerSender, value: Value) -> bool {
    send_outbound(outbound, OutboundMessage::Text(value.to_string()))
}

fn send_outbound(outbound: &PeerSender, message: OutboundMessage) -> bool {
    outbound.try_send(message)
}

fn rate_limit_exceeded(
    state: &AppState,
    outbound: &PeerSender,
    budget: &mut SignalBudget,
    bytes: usize,
) -> bool {
    if budget.allow(bytes) {
        return false;
    }
    state.metrics.record_rate_limited_connection();
    let _ = send_outbound(
        outbound,
        OutboundMessage::Close {
            code: 4029,
            reason: "signal rate exceeded".to_owned(),
        },
    );
    true
}

async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}
