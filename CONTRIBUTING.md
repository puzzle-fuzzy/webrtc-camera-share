# Contributing

感谢参与 WebRTC Camera Share。变更应保持当前产品边界：一台发送端、最多八台接收端、WebSocket 只传信令、媒体直接通过 WebRTC 传输，不引入账号、录制、持久化房间或 SFU。

## 开发环境

需要 Bun 1.4、Rust 1.97、Git；浏览器验收还需要 Chromium。首次准备：

```bash
bun install --frozen-lockfile
bunx playwright install chromium
```

本地开发使用 `cargo xtask dev`。提交前至少运行：

```bash
cargo xtask verify
cargo xtask e2e
```

涉及发布、静态资源、安全头或运行时配置时，还要运行：

```bash
cargo xtask release
cargo xtask smoke -- target/release/webrtc-camera-share-server.exe
```

Linux 和 macOS 使用不带 `.exe` 的二进制路径。

## 变更要求

- 优先添加能先失败、修复后通过的自动化测试。
- 保持信令 JSON、接收链接 Fragment 和 `/metrics` JSON 的兼容性，除非变更已经明确讨论并记录迁移方式。
- 不记录房间访问码、完整接收链接、TURN shared secret 或指标 Token。
- 更新行为、配置或运维流程时同步更新 README、CHANGELOG 和部署文档。
- 提交聚焦单一目的，Pull Request 说明风险、验证命令和仍未覆盖的外部条件。

安全漏洞不要通过公开 Pull Request 首次披露，请遵循 [SECURITY.md](SECURITY.md)。
