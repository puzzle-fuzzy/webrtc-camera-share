use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderName, HeaderValue, Request, StatusCode,
        header::{CACHE_CONTROL, REFERRER_POLICY},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

use crate::{
    room::{
        JoinResult, PeerSender, RoomRegistry, hash_access_code, is_valid_access_code,
        normalize_room_id,
    },
    signal::{Role, ValidatedSignal, parse_client_signal},
};

#[derive(Clone, Default)]
pub struct AppState {
    rooms: Arc<Mutex<RoomRegistry>>,
}

#[derive(Deserialize)]
struct ConnectParams {
    role: Role,
    room: String,
    key: String,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    rooms: usize,
    peers: usize,
}

pub fn build_app(state: AppState, web_dist: PathBuf) -> Router {
    let index = web_dist.join("index.html");
    let static_files = ServeDir::new(web_dist).fallback(ServeFile::new(index));

    Router::new()
        .route("/health", get(health))
        .route("/ws", get(websocket))
        .fallback_service(static_files)
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let rooms = state.rooms.lock().expect("room registry lock poisoned");
    Json(HealthResponse {
        ok: true,
        rooms: rooms.room_count(),
        peers: rooms.peer_count(),
    })
}

async fn websocket(
    State(state): State<AppState>,
    Query(params): Query<ConnectParams>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(room_id) = normalize_room_id(&params.room) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !is_valid_access_code(&params.key) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let access_code_hash = hash_access_code(&params.key);
    upgrade
        .max_message_size(256 * 1024)
        .on_upgrade(move |socket| {
            handle_socket(socket, state, room_id, access_code_hash, params.role)
        })
        .into_response()
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    room_id: String,
    access_code_hash: [u8; 32],
    role: Role,
) {
    let peer_id = Uuid::new_v4();
    let (outbound, mut outbound_messages) = mpsc::unbounded_channel::<String>();

    let join_result = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .join(&room_id, access_code_hash, role, peer_id, outbound.clone());

    let receiver_ids = match join_result {
        JoinResult::Joined { receiver_ids } => receiver_ids,
        JoinResult::InvalidAccessCode => {
            close_socket(&mut socket, 4003, "invalid access code").await;
            return;
        }
        JoinResult::RoleOccupied => {
            close_socket(&mut socket, 4009, "role occupied").await;
            return;
        }
        JoinResult::RoomFull => {
            close_socket(&mut socket, 4010, "room full").await;
            return;
        }
    };

    tracing::info!(%room_id, %peer_id, %role, "signal peer connected");
    for receiver_id in receiver_ids {
        send_json(
            &outbound,
            json!({ "type": "receiver-ready", "peerId": receiver_id }),
        );
    }

    let (mut socket_sender, mut socket_receiver) = socket.split();
    loop {
        tokio::select! {
            outgoing = outbound_messages.recv() => {
                let Some(outgoing) = outgoing else { break };
                if socket_sender.send(Message::Text(outgoing.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket_receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(message))) => {
                        handle_signal(&state, &room_id, role, peer_id, &outbound, message.as_str());
                    }
                    Some(Ok(Message::Binary(_))) => {
                        send_error(&outbound, "INVALID_SIGNAL", "仅支持文本格式的 JSON 信令", None);
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Err(error)) => {
                        tracing::warn!(%room_id, %peer_id, %role, %error, "websocket receive failed");
                        break;
                    }
                }
            }
        }
    }

    let notify = state
        .rooms
        .lock()
        .expect("room registry lock poisoned")
        .leave(&room_id, role, peer_id);
    let left_message = match role {
        Role::Send => json!({ "type": "peer-left", "role": "send" }),
        Role::Recv => json!({ "type": "peer-left", "role": "recv", "peerId": peer_id }),
    };
    for peer in notify {
        send_json(&peer, left_message.clone());
    }
    tracing::info!(%room_id, %peer_id, %role, "signal peer disconnected");
}

fn handle_signal(
    state: &AppState,
    room_id: &str,
    role: Role,
    peer_id: Uuid,
    outbound: &PeerSender,
    message: &str,
) {
    let signal = match parse_client_signal(role, message) {
        Ok(signal) => signal,
        Err(message) => {
            send_error(outbound, "INVALID_SIGNAL", &message, None);
            return;
        }
    };

    match role {
        Role::Send => route_sender_signal(state, room_id, outbound, signal),
        Role::Recv => route_receiver_signal(state, room_id, peer_id, signal),
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
        send_json(&receiver, signal.value);
    } else {
        send_error(outbound, "PEER_NOT_FOUND", "接收端已离线", Some(peer_id));
    }
}

fn route_receiver_signal(
    state: &AppState,
    room_id: &str,
    peer_id: Uuid,
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
    send_json(&sender, signal.value);
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
    send_json(outbound, value);
}

fn send_json(outbound: &PeerSender, value: Value) {
    let _ = outbound.send(value.to_string());
}

async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(self), microphone=()"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn exposes_health_with_security_headers() {
        let response = build_app(AppState::default(), PathBuf::from("missing-dist"))
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("health body");
        let health: Value = serde_json::from_slice(&body).expect("health JSON");
        assert_eq!(health, json!({ "ok": true, "rooms": 0, "peers": 0 }));
    }
}
