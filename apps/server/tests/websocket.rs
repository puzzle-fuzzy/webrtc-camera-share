use std::{net::SocketAddr, path::PathBuf};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Error, Message, client::IntoClientRequest, http::HeaderValue, protocol::CloseFrame,
    },
};
use webrtc_camera_share_server::{AppState, ResourceLimits, build_app};

type ClientSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct TestServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    async fn start(limits: ResourceLimits) -> Self {
        Self::start_with_origins(limits, Vec::new()).await
    }

    async fn start_with_origins(limits: ResourceLimits, origins: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let app = build_app(
            AppState::new(limits, Vec::new(), None, false).with_security(origins, None),
            PathBuf::from("missing-test-dist"),
        );
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("test server failed");
        });
        Self { address, task }
    }

    async fn connect(&self, role: &str, room: &str) -> ClientSocket {
        let url = format!("ws://{}/ws?role={role}&room={room}", self.address);
        connect_async(url).await.expect("connect websocket").0
    }

    async fn connect_with_origin(
        &self,
        role: &str,
        room: &str,
        origin: &str,
    ) -> Result<ClientSocket, Error> {
        let url = format!("ws://{}/ws?role={role}&room={room}", self.address);
        let mut request = url.into_client_request().expect("websocket request");
        request.headers_mut().insert(
            "origin",
            HeaderValue::from_str(origin).expect("valid origin header"),
        );
        connect_async(request).await.map(|(socket, _)| socket)
    }
}

async fn authenticate(socket: &mut ClientSocket, key: &str) {
    socket
        .send(Message::Text(
            json!({ "type": "authenticate", "key": key })
                .to_string()
                .into(),
        ))
        .await
        .expect("send authentication");
    let authenticated = next_json(socket).await;
    assert_eq!(authenticated["type"], "authenticated");
    assert!(authenticated["iceServers"].is_array());
    assert!(authenticated["maxReceivers"].is_number());
}

async fn next_json(socket: &mut ClientSocket) -> Value {
    match socket
        .next()
        .await
        .expect("websocket ended")
        .expect("websocket error")
    {
        Message::Text(message) => serde_json::from_str(message.as_str()).expect("valid JSON"),
        other => panic!("expected text message, got {other:?}"),
    }
}

async fn next_close(socket: &mut ClientSocket) -> CloseFrame {
    loop {
        match socket
            .next()
            .await
            .expect("websocket ended")
            .expect("websocket error")
        {
            Message::Close(Some(frame)) => return frame,
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .expect("reply to ping"),
            other => panic!("expected close message, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn enforces_browser_origin_without_breaking_non_browser_clients() {
    let server = TestServer::start(ResourceLimits::default()).await;

    let no_origin = server.connect("recv", "no-origin-room").await;
    drop(no_origin);

    let same_origin = format!("http://{}", server.address);
    let socket = server
        .connect_with_origin("recv", "same-origin-room", &same_origin)
        .await
        .expect("same-origin websocket");
    drop(socket);

    for origin in ["null", "https://cross-origin.example"] {
        let error = server
            .connect_with_origin("recv", "rejected-origin-room", origin)
            .await
            .expect_err("origin must be rejected");
        match error {
            Error::Http(response) => assert_eq!(response.status(), 403),
            other => panic!("expected HTTP rejection, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn accepts_an_explicitly_configured_browser_origin() {
    let server = TestServer::start_with_origins(
        ResourceLimits::default(),
        vec!["https://viewer.example".to_owned()],
    )
    .await;
    let socket = server
        .connect_with_origin("recv", "configured-origin-room", "https://viewer.example")
        .await
        .expect("configured browser origin");
    drop(socket);
}

#[tokio::test]
async fn routes_offer_answer_and_peer_lifecycle() {
    let server = TestServer::start(ResourceLimits::default()).await;
    let mut receiver = server.connect("recv", "integration-room").await;
    authenticate(&mut receiver, "123456").await;
    receiver
        .send(Message::Text(
            json!({ "type": "receiver-ready" }).to_string().into(),
        ))
        .await
        .expect("mark receiver ready");

    let mut sender = server.connect("send", "integration-room").await;
    authenticate(&mut sender, "123456").await;
    let ready = next_json(&mut sender).await;
    assert_eq!(ready["type"], "receiver-ready");
    let peer_id = ready["peerId"].as_str().expect("receiver peer id");

    sender
        .send(Message::Text(
            json!({
                "peerId": peer_id,
                "sdp": { "type": "offer", "sdp": "v=0\r\n" }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send offer");
    let offer = next_json(&mut receiver).await;
    assert_eq!(offer["sdp"]["type"], "offer");

    receiver
        .send(Message::Text(
            json!({ "sdp": { "type": "answer", "sdp": "v=0\r\n" } })
                .to_string()
                .into(),
        ))
        .await
        .expect("send answer");
    let answer = next_json(&mut sender).await;
    assert_eq!(answer["peerId"], peer_id);
    assert_eq!(answer["sdp"]["type"], "answer");

    receiver.close(None).await.expect("close receiver");
    let peer_left = next_json(&mut sender).await;
    assert_eq!(peer_left["type"], "peer-left");
    assert_eq!(peer_left["role"], "recv");
    assert_eq!(peer_left["peerId"], peer_id);
}

#[tokio::test]
async fn rejects_wrong_access_code_after_the_private_authentication_frame() {
    let server = TestServer::start(ResourceLimits::default()).await;
    let mut receiver = server.connect("recv", "private-room").await;
    authenticate(&mut receiver, "123456").await;

    let mut intruder = server.connect("send", "private-room").await;
    intruder
        .send(Message::Text(
            json!({ "type": "authenticate", "key": "654321" })
                .to_string()
                .into(),
        ))
        .await
        .expect("send wrong authentication");
    assert_eq!(u16::from(next_close(&mut intruder).await.code), 4003);
}

#[tokio::test]
async fn enforces_the_configured_receiver_limit() {
    let limits = ResourceLimits {
        max_receivers: 1,
        ..ResourceLimits::default()
    };
    let server = TestServer::start(limits).await;
    let mut first = server.connect("recv", "limited-room").await;
    authenticate(&mut first, "123456").await;

    let mut second = server.connect("recv", "limited-room").await;
    second
        .send(Message::Text(
            json!({ "type": "authenticate", "key": "123456" })
                .to_string()
                .into(),
        ))
        .await
        .expect("send authentication");
    assert_eq!(u16::from(next_close(&mut second).await.code), 4010);
}

#[tokio::test]
async fn rejects_connections_above_the_global_and_per_ip_limit() {
    let limits = ResourceLimits {
        max_connections: 2,
        max_connections_per_ip: 2,
        ..ResourceLimits::default()
    };
    let server = TestServer::start(limits).await;
    let first = server.connect("recv", "first-room").await;
    let second = server.connect("recv", "second-room").await;
    let url = format!("ws://{}/ws?role=recv&room=third-room", server.address);

    let error = connect_async(url)
        .await
        .expect_err("third connection must be rejected");
    match error {
        Error::Http(response) => assert_eq!(response.status(), 429),
        other => panic!("expected HTTP rejection, got {other:?}"),
    }

    drop(first);
    drop(second);
}

#[tokio::test]
async fn blocks_repeated_access_code_failures() {
    let server = TestServer::start(ResourceLimits::default()).await;
    let mut receiver = server.connect("recv", "protected-room").await;
    authenticate(&mut receiver, "Correct123").await;

    for _ in 0..8 {
        let mut intruder = server.connect("send", "protected-room").await;
        intruder
            .send(Message::Text(
                json!({ "type": "authenticate", "key": "Wrong123" })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send wrong authentication");
        assert_eq!(u16::from(next_close(&mut intruder).await.code), 4003);
    }

    let mut blocked = server.connect("send", "protected-room").await;
    blocked
        .send(Message::Text(
            json!({ "type": "authenticate", "key": "Correct123" })
                .to_string()
                .into(),
        ))
        .await
        .expect("send blocked authentication");
    assert_eq!(u16::from(next_close(&mut blocked).await.code), 4028);
}

#[tokio::test]
async fn rate_limits_binary_frames_too() {
    let server = TestServer::start(ResourceLimits::default()).await;
    let mut receiver = server.connect("recv", "binary-room").await;
    authenticate(&mut receiver, "123456").await;

    for _ in 0..64 {
        receiver
            .send(Message::Binary(vec![1].into()))
            .await
            .expect("send binary signal");
        let error = next_json(&mut receiver).await;
        assert_eq!(error["code"], "INVALID_SIGNAL");
    }
    receiver
        .send(Message::Binary(vec![1].into()))
        .await
        .expect("send rate-limited signal");
    assert_eq!(u16::from(next_close(&mut receiver).await.code), 4029);
}
