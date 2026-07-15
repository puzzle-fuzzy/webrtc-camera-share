use std::error::Error;

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

    let config = Config::from_env()?;
    let listener = TcpListener::bind(config.address).await?;

    tracing::info!(address = %config.address, web_dist = %config.web_dist.display(), "server started");

    axum::serve(listener, build_app(AppState::default(), config.web_dist))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}
