# WebRTC Camera Share

一发多收的浏览器摄像头共享应用。后台使用 Rust + Axum 提供静态资源、健康检查与 WebSocket 信令，前端使用 Vite + React + TypeScript，并只组合 shadcn/ui 原生组件与深色主题。

## 功能

- 一个房间只允许一个发送端，接收端上限可配置（默认 8 个）
- 房间 ID 与访问码校验，服务端只保存访问码的 SHA-256 摘要
- 访问码通过 WebSocket 建立后的首个鉴权帧发送，不进入请求 URL 或后台访问日志
- 每个接收端使用独立的 `RTCPeerConnection`，信令按服务端生成的 peer ID 定向路由
- 发送端可复制包含房间信息的接收链接；访问码保存在 URL Fragment 中，不随 HTTP 请求发送
- 支持发送端或接收端先进入房间
- 支持从后台运行时配置 STUN/TURN，不将 TURN 凭据编译进前端产物
- 提供 `/health` 存活检查、`/ready` 就绪检查、WebSocket 心跳及安全响应头
- 全局、单 IP、房间、接收端、消息速率、消息大小及信令队列均有明确上限
- 兼容旧入口 `/send.html` 与 `/recv.html`

## 技术栈

- 后台：Rust 1.97、Axum、Tokio、Serde、Tower HTTP
- 前端：Bun、Vite、React 19、TypeScript、Tailwind CSS 4
- UI：shadcn/ui `base-nova`，固定原生 `dark` 主题
- 实时通信：WebSocket 信令 + WebRTC 视频传输

## 目录结构

```text
webrtc-camera-share/
├── apps/
│   ├── server/              # Rust/Axum 后台
│   │   └── src/
│   │       ├── app.rs       # HTTP、WebSocket、静态资源和安全响应头
│   │       ├── config.rs    # 环境变量配置
│   │       ├── room.rs      # 房间、角色、容量和访问码策略
│   │       └── signal.rs    # 信令校验与规范化
│   └── web/                 # Vite + React 前端
│       └── src/
│           ├── components/ui/ # shadcn/ui CLI 生成组件
│           └── features/      # 会话、发送端和接收端功能
├── Cargo.toml               # Rust workspace
├── package.json             # Bun workspace 与统一脚本
└── docs/PRODUCT.md          # 产品边界与交互原则
```

## 本地开发

需要 Bun 1.4+ 与 Rust 1.97+。

```bash
bun install
bun run dev
```

默认地址：

- 前端开发服务器：`http://127.0.0.1:5173/send`
- Rust 后台：`http://127.0.0.1:5011`
- 接收端：`http://127.0.0.1:5173/recv`

Vite 会把 `/ws`、`/config`、`/health` 与 `/ready` 代理到 Rust 后台。

也可以分别启动：

```bash
bun run dev:server
bun run dev:web
```

## 生产构建与启动

```bash
bun run build
cargo run --release --manifest-path apps/server/Cargo.toml
```

Rust 后台默认从 `apps/web/dist` 提供生产前端，并监听 `0.0.0.0:5011`。

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 后台监听 IP |
| `PORT` | `5011` | 后台监听端口 |
| `WEB_DIST` | `apps/web/dist` | Vite 构建目录 |
| `MAX_CONNECTIONS` | `256` | WebSocket 全局并发上限 |
| `MAX_CONNECTIONS_PER_IP` | `32` | 单个来源 IP 的 WebSocket 并发上限 |
| `MAX_RECEIVERS` | `8` | 每个房间的接收端上限 |
| `MAX_ROOMS` | `128` | 内存中同时存在的房间上限 |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For`/`X-Real-IP`；仅在可信反向代理会覆盖这些头时启用 |
| `ICE_SERVERS_JSON` | 公共 STUN 列表 | 下发给浏览器的 `RTCIceServer[]` JSON；TURN 条目必须提供用户名和凭据 |
| `RUST_LOG` | `webrtc_camera_share_server=info` | Rust 日志过滤器 |

TURN 配置示例：

```bash
ICE_SERVERS_JSON='[{"urls":"stun:stun.example.com:3478"},{"urls":"turns:turn.example.com:5349","username":"camera","credential":"replace-me"}]'
```

`/health` 只表示进程存活；`/ready` 还会确认生产前端的 `index.html` 可用。容器编排和负载均衡应使用 `/ready` 接收流量。

## 验证

```bash
bun run verify
```

该命令依次执行前端类型检查、前后端 Lint、Bun/Rust 单测与 Vite 生产构建。

## 使用说明

1. 打开发送端，确认或修改自动生成的房间 ID 与访问码。
2. 点击“开始发送”并允许浏览器访问摄像头。
3. 复制接收链接，在另一台设备或另一个浏览器中打开。
4. 接收端点击“开始接收”，等待 WebRTC 连接建立。

跨公网使用时，HTTPS 是浏览器摄像头权限的必要条件之一。复杂 NAT 或企业网络环境应通过 `ICE_SERVERS_JSON` 配置自有 TURN 服务。

当前媒体拓扑是有容量边界的 P2P fan-out：发送端会为每个接收端维护一个 PeerConnection，并在多个接收端之间分配总视频码率预算。默认 8 个接收端适合小规模临时共享；若需要几十或更多接收端，应改用 SFU（例如 LiveKit、Janus 或 mediasoup），而不是继续调高 `MAX_RECEIVERS`。

## License

[MIT](LICENSE)
