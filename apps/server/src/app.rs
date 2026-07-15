use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        ConnectInfo, Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderMap, HeaderName, HeaderValue, Request, StatusCode,
        header::{CACHE_CONTROL, REFERRER_POLICY},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::mpsc,
    time::{Instant, MissedTickBehavior, interval_at, timeout},
};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

use crate::{
    config::{IceServerConfig, ResourceLimits, default_ice_servers},
    room::{
        JoinResult, OutboundMessage, PeerSender, RoomRegistry, hash_access_code,
        is_valid_access_code, normalize_room_id,
    },
    signal::{Role, ValidatedSignal, parse_client_signal},
};

const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const WRITER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const OUTBOUND_QUEUE_CAPACITY: usize = 32;
const SIGNAL_WINDOW: Duration = Duration::from_secs(1);
const MAX_SIGNAL_MESSAGES_PER_WINDOW: usize = 64;
const MAX_SIGNAL_BYTES_PER_WINDOW: usize = 512 * 1024;
const MAX_WEBSOCKET_MESSAGE_SIZE: usize = 128 * 1024;

#[derive(Clone)]
pub struct AppState {
    rooms: Arc<Mutex<RoomRegistry>>,
    connections: Arc<ConnectionLimiter>,
    ice_servers: Arc<Vec<IceServerConfig>>,
    max_receivers: usize,
    trust_proxy: bool,
}

impl AppState {
    pub fn new(
        limits: ResourceLimits,
        ice_servers: Vec<IceServerConfig>,
        trust_proxy: bool,
    ) -> Self {
        Self {
            rooms: Arc::new(Mutex::new(RoomRegistry::new(
                limits.max_receivers,
                limits.max_rooms,
            ))),
            connections: Arc::new(ConnectionLimiter::new(
                limits.max_connections,
                limits.max_connections_per_ip,
            )),
            ice_servers: Arc::new(ice_servers),
            max_receivers: limits.max_receivers,
            trust_proxy,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(ResourceLimits::default(), default_ice_servers(), false)
    }
}

#[derive(Clone)]
struct HttpState {
    app: AppState,
    index_path: Arc<PathBuf>,
}

#[derive(Deserialize)]
struct ConnectParams {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigResponse {
    ice_servers: Vec<IceServerConfig>,
    max_receivers: usize,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    rooms: usize,
    peers: usize,
    connections: usize,
}

#[derive(Serialize)]
struct ReadinessResponse {
    ok: bool,
    web: bool,
}

pub fn build_app(state: AppState, web_dist: PathBuf) -> Router {
    let index_path = web_dist.join("index.html");
    let http_state = HttpState {
        app: state,
        index_path: Arc::new(index_path.clone()),
    };

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/config", get(runtime_config))
        .route("/ws", get(websocket))
        .nest_service("/assets", ServeDir::new(web_dist.join("assets")))
        .fallback_service(ServeFile::new(index_path))
        .layer(middleware::from_fn(security_headers))
        .with_state(http_state)
}

async fn health(State(state): State<HttpState>) -> Json<HealthResponse> {
    let rooms = state.app.rooms.lock().expect("room registry lock poisoned");
    Json(HealthResponse {
        ok: true,
        rooms: rooms.room_count(),
        peers: rooms.peer_count(),
        connections: state.app.connections.active_count(),
    })
}

async fn ready(State(state): State<HttpState>) -> Response {
    let web = state.index_path.is_file();
    let status = if web {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(ReadinessResponse { ok: web, web })).into_response()
}

async fn runtime_config(State(state): State<HttpState>) -> Json<RuntimeConfigResponse> {
    Json(RuntimeConfigResponse {
        ice_servers: state.app.ice_servers.as_ref().clone(),
        max_receivers: state.app.max_receivers,
    })
}

async fn websocket(
    State(state): State<HttpState>,
    Query(params): Query<ConnectParams>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(room_id) = normalize_room_id(&params.room) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let ip = client_ip(&headers, address.ip(), state.app.trust_proxy);
    let Some(lease) = state.app.connections.acquire(ip) else {
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
    let (outbound, outbound_messages) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
    let Some(receiver_ids) = authenticate_and_join(
        &mut socket,
        &state,
        &room_id,
        role,
        peer_id,
        outbound.clone(),
    )
    .await
    else {
        return;
    };

    if socket
        .send(Message::Text(
            json!({ "type": "authenticated" }).to_string().into(),
        ))
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
                        if !signal_budget.allow(message.len()) {
                            let _ = send_outbound(
                                &outbound,
                                OutboundMessage::Close {
                                    code: 4029,
                                    reason: "signal rate exceeded".to_owned(),
                                },
                            );
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
                    Some(Ok(Message::Binary(_))) => {
                        send_error(
                            &outbound,
                            "INVALID_SIGNAL",
                            "仅支持文本格式的 JSON 信令",
                            None,
                        );
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        last_seen = Instant::now();
                        if !send_outbound(&outbound, OutboundMessage::Pong(payload.to_vec())) {
                            break false;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_seen = Instant::now();
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
    outbound: PeerSender,
) -> Option<Vec<Uuid>> {
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
        JoinResult::Joined { receiver_ids } => Some(receiver_ids),
        JoinResult::InvalidAccessCode => {
            close_socket(socket, 4003, "invalid access code").await;
            None
        }
        JoinResult::RoleOccupied => {
            close_socket(socket, 4009, "role occupied").await;
            None
        }
        JoinResult::RoomFull => {
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
    mut outbound: mpsc::Receiver<OutboundMessage>,
) {
    while let Some(message) = outbound.recv().await {
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
            send_error(
                outbound,
                "PEER_OVERLOADED",
                "接收端处理信令过慢",
                Some(peer_id),
            );
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
        send_error(outbound, "PEER_OVERLOADED", "发送端处理信令过慢", None);
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
        let _ = send_json(&peer, left_message.clone());
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
    outbound.try_send(message).is_ok()
}

async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

fn client_ip(headers: &HeaderMap, direct_ip: IpAddr, trust_proxy: bool) -> IpAddr {
    if !trust_proxy {
        return direct_ip;
    }

    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<IpAddr>().ok())
        })
        .unwrap_or(direct_ip)
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let immutable_asset = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(if immutable_asset {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        }),
    );
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

struct SignalBudget {
    window_started: Instant,
    messages: usize,
    bytes: usize,
}

impl SignalBudget {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            messages: 0,
            bytes: 0,
        }
    }

    fn allow(&mut self, bytes: usize) -> bool {
        if self.window_started.elapsed() >= SIGNAL_WINDOW {
            self.window_started = Instant::now();
            self.messages = 0;
            self.bytes = 0;
        }
        self.messages = self.messages.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        self.messages <= MAX_SIGNAL_MESSAGES_PER_WINDOW && self.bytes <= MAX_SIGNAL_BYTES_PER_WINDOW
    }
}

struct ConnectionCounts {
    total: usize,
    by_ip: HashMap<IpAddr, usize>,
}

struct ConnectionLimiter {
    counts: Mutex<ConnectionCounts>,
    max_total: usize,
    max_per_ip: usize,
}

impl ConnectionLimiter {
    fn new(max_total: usize, max_per_ip: usize) -> Self {
        Self {
            counts: Mutex::new(ConnectionCounts {
                total: 0,
                by_ip: HashMap::new(),
            }),
            max_total,
            max_per_ip,
        }
    }

    fn acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ConnectionLease> {
        let mut counts = self
            .counts
            .lock()
            .expect("connection limiter lock poisoned");
        let current_for_ip = counts.by_ip.get(&ip).copied().unwrap_or_default();
        if counts.total >= self.max_total || current_for_ip >= self.max_per_ip {
            return None;
        }
        counts.total += 1;
        *counts.by_ip.entry(ip).or_default() += 1;
        drop(counts);
        Some(ConnectionLease {
            limiter: self.clone(),
            ip,
        })
    }

    fn active_count(&self) -> usize {
        self.counts
            .lock()
            .expect("connection limiter lock poisoned")
            .total
    }
}

struct ConnectionLease {
    limiter: Arc<ConnectionLimiter>,
    ip: IpAddr,
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        let mut counts = self
            .limiter
            .counts
            .lock()
            .expect("connection limiter lock poisoned");
        counts.total = counts.total.saturating_sub(1);
        if let Some(count) = counts.by_ip.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.by_ip.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn exposes_liveness_and_readiness_separately() {
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
        assert_eq!(
            health,
            json!({ "ok": true, "rooms": 0, "peers": 0, "connections": 0 })
        );

        let response = build_app(AppState::default(), PathBuf::from("missing-dist"))
            .oneshot(
                Request::builder()
                    .uri("/ready")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn limits_connections_globally_and_per_ip() {
        let limiter = Arc::new(ConnectionLimiter::new(2, 1));
        let first_ip = "127.0.0.1".parse().expect("IP");
        let second_ip = "127.0.0.2".parse().expect("IP");
        let first = limiter.acquire(first_ip).expect("first connection");
        assert!(limiter.acquire(first_ip).is_none());
        let second = limiter.acquire(second_ip).expect("second connection");
        assert!(limiter.acquire("127.0.0.3".parse().expect("IP")).is_none());
        drop(first);
        assert!(limiter.acquire(first_ip).is_some());
        drop(second);
    }

    #[test]
    fn rate_budget_is_bounded() {
        let mut budget = SignalBudget::new();
        for _ in 0..MAX_SIGNAL_MESSAGES_PER_WINDOW {
            assert!(budget.allow(1));
        }
        assert!(!budget.allow(1));
    }
}
