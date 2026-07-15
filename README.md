# WebRTC Camera Share

一发多收的浏览器摄像头共享应用。后台使用 Rust + Axum 提供静态资源、健康检查与 WebSocket 信令，前端使用 Vite + React + TypeScript，并只组合 shadcn/ui 原生组件与深色主题。

## 功能

- 一个房间只允许一个发送端，最多允许 8 个接收端
- 房间 ID 与访问码校验，服务端只保存访问码的 SHA-256 摘要
- 每个接收端使用独立的 `RTCPeerConnection`，信令按服务端生成的 peer ID 定向路由
- 发送端可复制包含房间信息的接收链接；访问码保存在 URL Fragment 中，不随 HTTP 请求发送
- 支持发送端或接收端先进入房间
- 提供 `/health` 健康检查、WebSocket 消息大小限制和基础安全响应头
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

Vite 会把 `/ws` 与 `/health` 代理到 Rust 后台。

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
| `RUST_LOG` | `webrtc_camera_share_server=info` | Rust 日志过滤器 |

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

跨公网使用时，HTTPS 是浏览器摄像头权限的必要条件之一。当前项目仅配置公共 STUN；复杂 NAT 或企业网络环境建议配置自有 TURN 服务。

## License

[MIT](LICENSE)
