use std::{error::Error, net::SocketAddr};

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use webrtc_camera_share_server::{AppState, Config, build_app, shutdown_signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("webrtc_camera_share_server=info")),
        )
        .init();

    let Config {
        address,
        web_dist,
        limits,
        ice_servers,
        turn,
        trust_proxy,
        allowed_origins,
        metrics_token,
    } = Config::from_env()?;
    let listener = TcpListener::bind(address).await?;

    tracing::info!(address = %address, web_dist = %web_dist.display(), "server started");

    let app = build_app(
        AppState::new(limits, ice_servers, turn, trust_proxy)
            .with_security(allowed_origins, metrics_token),
        web_dist,
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}
