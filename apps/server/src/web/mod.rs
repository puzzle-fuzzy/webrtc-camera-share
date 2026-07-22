mod security;
mod static_files;
mod websocket;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::SystemTime,
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::WWW_AUTHENTICATE},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::{
    config::{IceServerConfig, ResourceLimits, TurnConfig, default_ice_servers},
    domain::room::{PeerSender, RoomRegistry},
    infrastructure::{
        limits::{AuthenticationLimiter, ConnectionLimiter, TurnCredentialLimiter},
        metrics::ServerMetrics,
    },
};

#[derive(Clone)]
pub struct AppState {
    rooms: Arc<Mutex<RoomRegistry>>,
    connections: Arc<ConnectionLimiter>,
    ice_servers: Arc<Vec<IceServerConfig>>,
    turn: Option<Arc<TurnConfig>>,
    authentication: Arc<AuthenticationLimiter>,
    turn_credentials: Arc<TurnCredentialLimiter>,
    metrics: Arc<ServerMetrics>,
    max_receivers: usize,
    trust_proxy: bool,
    allowed_origins: Arc<Vec<String>>,
    metrics_token: Option<Arc<String>>,
    shutdown: watch::Sender<bool>,
}

impl AppState {
    pub fn new(
        limits: ResourceLimits,
        ice_servers: Vec<IceServerConfig>,
        turn: Option<TurnConfig>,
        trust_proxy: bool,
    ) -> Self {
        let (shutdown, _) = watch::channel(false);
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
            turn: turn.map(Arc::new),
            authentication: Arc::new(AuthenticationLimiter::new()),
            turn_credentials: Arc::new(TurnCredentialLimiter::new()),
            metrics: Arc::new(ServerMetrics::default()),
            max_receivers: limits.max_receivers,
            trust_proxy,
            allowed_origins: Arc::new(Vec::new()),
            metrics_token: None,
            shutdown,
        }
    }

    pub fn with_security(
        mut self,
        allowed_origins: Vec<String>,
        metrics_token: Option<String>,
    ) -> Self {
        self.allowed_origins = Arc::new(allowed_origins);
        self.metrics_token = metrics_token.map(Arc::new);
        self
    }

    pub fn begin_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    fn disconnect_overloaded_peer(&self, peer: &PeerSender) {
        self.metrics.record_outbound_overload();
        peer.disconnect();
    }

    fn authenticated_ice_servers(&self, peer_id: Uuid) -> Vec<IceServerConfig> {
        let mut ice_servers = self.ice_servers.as_ref().clone();
        if let Some(turn) = &self.turn {
            match turn.ephemeral_server(SystemTime::now(), &peer_id.to_string()) {
                Ok(server) => ice_servers.push(server),
                Err(error) => {
                    tracing::error!(%error, "failed to generate ephemeral TURN credentials");
                }
            }
        }
        ice_servers
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(
            ResourceLimits::default(),
            default_ice_servers(),
            None,
            false,
        )
    }
}

#[derive(Clone)]
struct HttpState {
    app: AppState,
    web_dist: Arc<PathBuf>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsResponse {
    rooms: usize,
    peers: usize,
    connections: usize,
    queued_signal_bytes: usize,
    routed_signals: u64,
    outbound_overloads: u64,
    rate_limited_connections: u64,
    connection_rejections: u64,
    authentication_failures: u64,
    authentication_blocks: u64,
    turn_credential_rejections: u64,
    authenticated_connections: u64,
    disconnected_connections: u64,
}

pub fn build_app(state: AppState, web_dist: PathBuf) -> Router {
    let http_state = HttpState {
        app: state,
        web_dist: Arc::new(web_dist.clone()),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/config", get(runtime_config))
        .route("/ws", get(websocket::websocket));

    static_files::mount(router, web_dist)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(security::security_headers))
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
    let web_ready = static_files::is_ready(&state.web_dist);
    let status = if web_ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(ReadinessResponse {
            ok: web_ready,
            web: web_ready,
        }),
    )
        .into_response()
}

async fn runtime_config(State(state): State<HttpState>) -> Json<RuntimeConfigResponse> {
    Json(RuntimeConfigResponse {
        ice_servers: state.app.ice_servers.as_ref().clone(),
        max_receivers: state.app.max_receivers,
    })
}

async fn metrics(State(state): State<HttpState>, headers: HeaderMap) -> Response {
    if let Some(token) = &state.app.metrics_token
        && !metrics_token_matches(&headers, token)
    {
        return (StatusCode::UNAUTHORIZED, [(WWW_AUTHENTICATE, "Bearer")]).into_response();
    }
    let rooms = state.app.rooms.lock().expect("room registry lock poisoned");
    Json(MetricsResponse {
        rooms: rooms.room_count(),
        peers: rooms.peer_count(),
        connections: state.app.connections.active_count(),
        queued_signal_bytes: state.app.metrics.queued_signal_bytes(),
        routed_signals: state.app.metrics.routed_signals(),
        outbound_overloads: state.app.metrics.outbound_overloads(),
        rate_limited_connections: state.app.metrics.rate_limited_connections(),
        connection_rejections: state.app.metrics.connection_rejections(),
        authentication_failures: state.app.metrics.authentication_failures(),
        authentication_blocks: state.app.metrics.authentication_blocks(),
        turn_credential_rejections: state.app.metrics.turn_credential_rejections(),
        authenticated_connections: state.app.metrics.authenticated_connections(),
        disconnected_connections: state.app.metrics.disconnected_connections(),
    })
    .into_response()
}

fn metrics_token_matches(headers: &HeaderMap, expected: &str) -> bool {
    let mut values = headers.get_all("authorization").iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some((scheme, candidate)) = value.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer")
        && bool::from(expected.as_bytes().ct_eq(candidate.as_bytes()))
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, body::to_bytes, http::Request};
    use serde_json::{Value, json};
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
        assert!(response.headers().contains_key("x-request-id"));
        assert_eq!(
            response.headers()["content-security-policy"],
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        );
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
        let expected = if cfg!(feature = "embed-web") {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        assert_eq!(response.status(), expected);
    }

    #[tokio::test]
    async fn protects_metrics_with_an_optional_bearer_token() {
        let token = "0123456789abcdef";
        let app = build_app(
            AppState::default().with_security(Vec::new(), Some(token.to_owned())),
            PathBuf::from("missing-dist"),
        );
        let request = |authorization: Option<&str>| {
            let mut request = Request::builder().uri("/metrics");
            if let Some(authorization) = authorization {
                request = request.header("authorization", authorization);
            }
            request.body(Body::empty()).expect("request")
        };

        for authorization in [None, Some("Bearer wrong-token")] {
            let response = app
                .clone()
                .oneshot(request(authorization))
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()["www-authenticate"], "Bearer");
        }

        let response = app
            .oneshot(request(Some("Bearer 0123456789abcdef")))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("metrics body");
        let metrics: Value = serde_json::from_slice(&body).expect("metrics JSON");
        assert_eq!(metrics["rooms"], 0);
        assert_eq!(metrics["connections"], 0);
    }

    #[cfg(not(feature = "embed-web"))]
    #[tokio::test]
    async fn readiness_recovers_when_the_web_build_appears() {
        let web_dist = std::env::temp_dir().join(format!("web-dist-{}", Uuid::new_v4()));
        let app = build_app(AppState::default(), web_dist.clone());
        let request = || {
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .expect("request")
        };

        let response = app.clone().oneshot(request()).await.expect("response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        std::fs::create_dir_all(&web_dist).expect("create temporary web dist");
        std::fs::write(web_dist.join("index.html"), "<!doctype html>")
            .expect("write temporary index");
        let response = app.oneshot(request()).await.expect("response");
        assert_eq!(response.status(), StatusCode::OK);

        std::fs::remove_dir_all(web_dist).expect("remove temporary web dist");
    }
}
