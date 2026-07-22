use std::{
    env,
    error::Error,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use webrtc_camera_share_server::{AppState, Config, build_app, shutdown_signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    match env::args().nth(1).as_deref() {
        Some("--healthcheck") => return healthcheck(),
        Some(argument) => return Err(format!("unknown argument: {argument}").into()),
        None => {}
    }

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

    let state = AppState::new(limits, ice_servers, turn, trust_proxy)
        .with_security(allowed_origins, metrics_token);
    let shutdown_state = state.clone();
    let app = build_app(state, web_dist);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        shutdown_state.begin_shutdown();
    })
    .await?;

    Ok(())
}

fn healthcheck() -> Result<(), Box<dyn Error>> {
    let host = env::var("HEALTHCHECK_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = env::var("PORT").unwrap_or_else(|_| "5011".to_owned());
    let address = format!("{host}:{port}")
        .to_socket_addrs()?
        .next()
        .ok_or("healthcheck address did not resolve")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /ready HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = [0_u8; 1024];
    let length = stream.read(&mut response)?;
    if !String::from_utf8_lossy(&response[..length]).starts_with("HTTP/1.1 200") {
        return Err("readiness endpoint did not return HTTP 200".into());
    }
    Ok(())
}
