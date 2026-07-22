# Changelog

本项目的显著变更记录在此文件中，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

### Added

- 增加浏览器能力检查、结构化连接状态、媒体等待状态和发送端会话轮换。
- 增加 Chromium 真实 WebRTC 端到端验收、独立测试服务编排和移动端可用性检查。
- 增加可选指标 Bearer 鉴权、浏览器 WebSocket Origin 策略和 1012 优雅停机通知。
- 增加跨平台发布冒烟、依赖自动更新、CI 和草稿 Release 工作流。
- 增加非 root 应用镜像、Caddy/coturn/Compose/systemd 示例和完整生产运维手册。
- 增加可由容器和 systemd 外部探针调用的内置 `--healthcheck`。
- 增加 1/2/4/8 接收端有界 soak 工具、脱敏健康/指标/RTCStats 摘要和多视口发布验收。

### Changed

- 收紧 Content Security Policy，仅允许同源连接。
- 发送过程中继续允许复制接收链接，并为各入口设置独立页面标题。
- 统一中文底部导航，并让视频与按钮在减少动画偏好下停用非必要过渡。

### Security

- 显式拒绝 `Origin: null` 和未授权的跨源浏览器 WebSocket。
- 生产指标可通过至少 16 字符的 `METRICS_TOKEN` 保护。

[Unreleased]: https://github.com/puzzle-fuzzy/webrtc-camera-share/compare/v1.0.0...HEAD
