# coturn 配置说明

`turnserver.conf.example` 只保存非敏感的协议、端口、配额和日志策略。Compose 在启动时通过命令行注入 realm、外部 IP 映射、TLS 文件和 `static-auth-secret`，避免把密钥提交到仓库。

生产前必须确认：

- `TURN_SHARED_SECRET` 与应用进程使用完全相同的随机值，至少 16 个字符；
- `TURN_EXTERNAL_IP` 在直连公网时填公网 IP，在 1:1 NAT 后填 `PUBLIC_IP/PRIVATE_IP`；
- `TURN_CERT_FILE` 和 `TURN_KEY_FILE` 是 `TURN_DOMAIN` 的有效 PEM 证书与私钥，续期后重启 coturn；
- 安全组与主机防火墙放行 3478 TCP/UDP、5349 TCP 和 49160–49200 UDP；
- `max-bps`、`bps-capacity`、`user-quota` 与服务器真实出口带宽和预期并发一致。

回环健康检查只证明 STUN 监听器响应。完整验收还必须从不同公网网络确认浏览器出现 `relay` candidate，并在 coturn 日志中看到 allocation；只看到 `host`/`srflx` candidate 不能证明 TURN 可用。

常用诊断：

```bash
docker compose -f compose.example.yml --env-file .env logs --tail=200 coturn
docker compose -f compose.example.yml --env-file .env exec coturn turnutils_stunclient -p 3478 127.0.0.1
```

请勿把 shared secret、临时用户名/credential 或完整接收链接复制到 Issue 和公开日志。
