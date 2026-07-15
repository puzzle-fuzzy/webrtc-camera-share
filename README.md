# @voasx/p2p-video：WebRTC 摄像头共享

基于 WebRTC 与 Bun WebSocket 信令的一发多收摄像头共享演示。每个房间支持一个发送端和最多八个接收端；发送端为每个接收端建立独立 WebRTC 连接，服务器只负责会话隔离与定向信令转发。

## 当前定位

这是一个功能优先的演示型网站。多个房间可以同时存在，每个房间用房间 ID 和访问码隔离；一个发送端可以同时向多个接收端发送摄像头画面，并保证任意加入顺序都能开始协商。

```text
                            +--> 接收端 A
发送端浏览器 <--> Bun 信令服务 +--> 接收端 B
      |                     +--> 接收端 C ...
      +--------- 每个接收端一条独立 WebRTC P2P 视频连接 --------->
```

## 功能

- 使用浏览器原生 `RTCPeerConnection` 传输视频
- 使用 `Bun.serve()` 和 WebSocket pub/sub 转发信令
- 支持多个内存态房间，不同房间的信令完全隔离
- 每个接收端由服务端分配 `peerId`，SDP 和 ICE 只转发给目标连接
- 发送端为每个接收端维护独立 `RTCPeerConnection`
- 使用访问码哈希匹配会话，不在服务端保存访问码明文
- 发送端自动生成房间信息和带 URL Fragment 的接收链接
- 支持发送端或接收端以任意顺序进入
- 对端离线后保持等待，对端重新进入时重新协商
- 缓存并延迟处理早于 Remote Description 到达的 ICE candidate
- 校验角色、SDP 方向、ICE 和控制信令
- 每个房间限制一个发送端和最多八个接收端
- 限制 WebSocket 消息大小，并只暴露固定静态页面
- 原生 HTML/CSS/JS，无前端运行时依赖

## 快速开始

```bash
bun install
bun run dev
```

生产式启动：

```bash
bun run start
```

默认地址：

- 发送端：<http://127.0.0.1:5011/send.html>
- 接收端：<http://127.0.0.1:5011/recv.html>
- 健康检查：<http://127.0.0.1:5011/health>

1. 打开发送端，复制接收链接或直接点击「打开接收端」
2. 接收端从链接自动读取房间 ID 和访问码
3. 发送端和各接收端可以按任意顺序点击开始；每个接收端就绪后都会触发自己的 Offer

房间信息放在页面 URL Fragment 中，不会随页面 HTTP 请求发送；建立 WebSocket 时才会作为连接参数提交给当前服务。

## 配置

服务支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5011` | HTTP 与 WebSocket 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

例如：

```bash
PORT=8080 bun run start
```

## 项目结构

```text
webrtc-camera-share/
├── src/
│   ├── main.ts             # 读取运行配置并启动服务
│   ├── server.ts           # 可测试的 HTTP/WebSocket 服务工厂
│   ├── rooms.ts            # 房间注册表、输入校验和访问码哈希
│   └── signaling.ts        # 信令类型、角色约束和运行时校验
├── docs/
│   └── PRODUCT.md          # 展示定位与功能优先的设计原则
├── public/
│   ├── send.html           # 摄像头采集、Offer 和发送端生命周期
│   └── recv.html           # Answer、远端播放和接收端生命周期
├── tests/
│   ├── signaling.test.ts   # 信令校验单元测试
│   ├── rooms.test.ts       # 房间隔离和访问码测试
│   ├── public-scripts.test.ts # 页面脚本语法测试
│   └── server.test.ts      # HTTP/WebSocket 集成测试
├── package.json
├── tsconfig.json
└── bun.lock
```

## 信令流程

```text
Receiver                   Server                    Sender
   |                          |                         |
   |-- receiver-ready ------->|-- ready + peerId ------>|
   |                          |                         |-- createOffer(peerId)
   |<-- offer + peerId -------|<-- offer + peerId ------|
   |-- setRemoteDescription() |                         |
   |-- createAnswer()         |                         |
   |--------- SDP answer ---->|------------------------>|
   |                          |                         |-- setRemoteDescription()
   |<====================== ICE candidates ==========================>|
   |<======================= WebRTC video ============================|
```

服务端为每个接收端生成 `peerId`。发送端的 Offer 和 ICE 必须携带目标 `peerId`；接收端的 Answer 和 ICE 由服务端补充来源 `peerId` 后转发给发送端。如果接收端先上线，发送端连接时会收到每个在线接收端的 `receiver-ready`。

## WebSocket 协议

端点：

- `/ws?role=send&room=<room-id>&key=<access-code>`
- `/ws?role=recv&room=<room-id>&key=<access-code>`

房间 ID 为 3 到 32 位小写字母、数字或连字符；访问码为 6 到 32 位字母或数字。首个进入者创建进程内房间，最后一个参与者离开后房间自动删除。

客户端消息：

| 消息 | 发送角色 | 说明 |
| --- | --- | --- |
| `{ "type": "receiver-ready" }` | `recv` | 请求发送端为当前接收端开始协商 |
| `{ "peerId": "...", "sdp": { "type": "offer", ... } }` | `send` | 发给指定接收端的 WebRTC Offer |
| `{ "sdp": { "type": "answer", ... } }` | `recv` | WebRTC Answer |
| `{ "peerId": "...", "ice": { ... } }` | `send` | 发给指定接收端的 ICE candidate |
| `{ "ice": { ... } }` | `recv` | 接收端 ICE candidate，服务端自动补充 `peerId` |

服务器控制消息：

| 消息 | 说明 |
| --- | --- |
| `{ "type": "receiver-ready", "peerId": ... }` | 指定接收端已经就绪 |
| `{ "type": "peer-left", "role": "recv", "peerId": ... }` | 指定接收端已经离线 |
| `{ "type": "peer-left", "role": "send" }` | 发送端已经离线 |
| `{ "type": "error", "code": "INVALID_SIGNAL", ... }` | 信令校验失败 |

WebSocket 关闭码：

| 关闭码 | 说明 |
| --- | --- |
| `4003` | 房间已存在，但访问码不匹配 |
| `4009` | 同一房间已有发送端在线 |
| `4010` | 房间已有八个接收端 |

## 验证

```bash
bun run typecheck
bun test
bun run verify
```

测试覆盖固定静态路由、健康检查、任意连接顺序、多接收端定向路由、单接收端离线、房间隔离、容量限制、访问码、非法信令和页面脚本语法。

## 网络与浏览器要求

- Chrome、Edge、Firefox 或 Safari 15+
- 本机 `localhost` / `127.0.0.1` 可以通过 HTTP 使用摄像头
- 手机或其他局域网设备通过非本机地址访问时，浏览器通常要求 HTTPS 才允许 `getUserMedia()`
- 当前使用 Google 和 Mozilla STUN，没有配置 TURN；严格 NAT 环境仍可能连接失败

## 当前限制

- 每个房间支持一个发送端和最多八个接收端
- 这是 P2P mesh 推流，发送端上行带宽和编码负载会随接收端数量增长
- 房间和访问码只保存在当前服务进程中，重启后自动清空
- 访问码是演示级会话隔离，不包含账号、持久化、限流或生产级认证
- WebSocket URL 会携带访问码，部署时应避免在代理访问日志中记录完整查询参数
- 仅传输视频，不包含音频
- 没有 TURN、录制和自动网络故障重试

## 后续路线

1. 支持可配置 TURN 与 HTTPS 部署
2. 增加浏览器端到端测试、连接诊断和重试策略
3. 将接收端容量、STUN/TURN 和视频质量改为运行配置

## License

MIT
