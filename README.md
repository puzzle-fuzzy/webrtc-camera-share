# WebRTC Camera Share

一发多收的浏览器摄像头共享应用。后台使用 Rust + Axum 提供静态资源、健康检查与 WebSocket 信令，前端使用 Vite + React + TypeScript，并只组合 shadcn/ui 原生组件与深色主题。

## 功能

- 一个房间只允许一个发送端，接收端上限可配置为 1–8 个（默认 8 个）
- 房间 ID 与访问码校验，服务端只保存访问码的 SHA-256 摘要
- 默认房间 ID 由浏览器生成 96 位随机值，访问码生成 128 位随机值；鉴权失败还会按 IP 与房间限流
- 访问码通过 WebSocket 建立后的首个鉴权帧发送，不进入请求 URL 或后台访问日志
- 每个接收端使用独立的 `RTCPeerConnection`，信令按服务端生成的 peer ID 定向路由
- 发送端可复制包含房间信息的接收链接；访问码保存在 URL Fragment 中，不随 HTTP 请求发送
- 支持发送端或接收端先进入房间
- 支持公开 STUN 与鉴权后临时 TURN 凭据，不将 TURN 密钥编译进前端产物或暴露在公开接口；临时凭据按 IP 限制为每 10 分钟 64 个
- 提供 `/health`、`/ready`、`/metrics`、请求 ID、WebSocket 心跳及安全响应头
- 全局、单 IP、房间、接收端、鉴权、消息速率、消息大小及信令队列数量/字节数均有明确上限
- 配置请求、媒体流、WebSocket 与 PeerConnection 均有取消、超时和断线清理机制
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
│   │       ├── metrics.rs   # 运行指标与资源计数
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

Vite 会把 `/ws`、`/config`、`/health`、`/ready` 与 `/metrics` 代理到 Rust 后台。

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
| `MAX_CONNECTIONS` | `256` | WebSocket 全局并发上限，范围 1–4096 |
| `MAX_CONNECTIONS_PER_IP` | `32` | 单个来源 IP 的 WebSocket 并发上限，范围 1–256，且不大于全局上限 |
| `MAX_RECEIVERS` | `8` | 每个房间的接收端上限，范围 1–8 |
| `MAX_ROOMS` | `128` | 内存中同时存在的房间上限，范围 1–1024，且不大于全局连接上限 |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For`/`X-Real-IP`；仅在可信反向代理会覆盖这些头时启用 |
| `ICE_SERVERS_JSON` | 公共 STUN 列表 | 公开下发的 `RTCIceServer[]` JSON；只允许无凭据的 STUN URL |
| `TURN_URLS_JSON` | 未启用 | 一个 TURN URL 字符串，或由多个 `turn:`/`turns:` URL 组成的 JSON 数组 |
| `TURN_SHARED_SECRET` | 未启用 | 与 coturn `static-auth-secret` 相同的共享密钥，至少 16 个字符 |
| `TURN_TTL_SECONDS` | `3600` | 临时 TURN 凭据有效期，范围 300–86400 秒 |
| `RUST_LOG` | `webrtc_camera_share_server=info` | Rust 日志过滤器 |

TURN 配置示例：

```bash
ICE_SERVERS_JSON='[{"urls":"stun:stun.example.com:3478"}]'
TURN_URLS_JSON='["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"]'
TURN_SHARED_SECRET='replace-with-at-least-16-random-characters'
TURN_TTL_SECONDS=3600
```

coturn 需启用 `use-auth-secret`，并把 `static-auth-secret` 配置为相同密钥。后台只会在房间鉴权成功后向该 WebSocket 下发临时凭据；公开的 `/config` 不包含 TURN 密钥或凭据。生产环境还应在 coturn 设置合理的 `user-quota`、`total-quota` 和带宽上限，形成签发端与中继端两层保护。

`/health` 只表示进程存活；`/ready` 还会确认生产前端的 `index.html` 可用；`/metrics` 返回房间、连接、排队信令字节数、限流、TURN 签发拒绝与鉴权拦截等 JSON 指标。容器编排和负载均衡应使用 `/ready` 接收流量，并在外部监控进程 RSS 与 `/metrics` 中的 `queuedSignalBytes`。

## 验证

```bash
bun run verify
```

该命令依次执行前端类型检查、前后端 Lint、Bun/Rust 单测与 Vite 生产构建。

## 怎么使用

1. 按“本地开发”启动后，打开发送端 `http://127.0.0.1:5173/send`；生产环境直接打开后台地址的 `/send`。
2. 确认或修改自动生成的房间 ID 与访问码，点击“开始发送”，并允许浏览器使用摄像头。
3. 点击“复制接收链接”，把链接发送给接收者。访问码位于链接的 URL Fragment 中，不会进入 HTTP 请求日志。
4. 接收者打开链接并点击“开始接收”；也可以打开 `/recv`，手动填写相同房间 ID 和访问码。
5. 发送者点击“停止发送”即可释放摄像头和全部连接；刷新或关闭页面也会自动清理资源。

生产部署前先执行：

```bash
bun install --frozen-lockfile
bun run verify
bun run build
./target/release/webrtc-camera-share-server
```

如果从项目目录之外启动可执行文件，请将 `WEB_DIST` 设置为 `apps/web/dist` 的绝对路径。建议由 Caddy、Nginx 或云负载均衡终止 HTTPS，再反向代理到 `127.0.0.1:5011`；只有在代理会清除并重写客户端 IP 请求头时才设置 `TRUST_PROXY=true`。

跨公网使用时必须提供 HTTPS 才能稳定获得浏览器摄像头权限。复杂 NAT 或企业网络环境应配置临时 TURN 凭据；仅使用公共 STUN 不能保证所有网络都能连通。

当前媒体拓扑是有容量边界的 P2P fan-out：发送端会为每个接收端维护一个 PeerConnection，并在多个接收端之间分配总视频码率预算。默认 8 个接收端适合小规模临时共享；若需要几十或更多接收端，应改用 SFU（例如 LiveKit、Janus 或 mediasoup），而不是继续调高 `MAX_RECEIVERS`。

## License

[MIT](LICENSE)
