# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete all repository-local reliability, UX, security, testing, CI, deployment-template, and release-readiness work approved in the 2026-07-20 design.

**Architecture:** Keep the existing Axum single-binary backend and React frontend. Extract only pure frontend policy and presentation helpers, add opt-in server security configuration, make WebSocket shutdown deterministic, and wrap the existing canonical verification command with browser, smoke, audit, and deployment tooling.

**Tech Stack:** Rust 1.97, Axum 0.8, Tokio, Bun 1.4, React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Playwright.

## Global Constraints

- Preserve one sender, one to eight receivers, in-memory rooms, direct WebRTC media, and WebSocket signaling.
- Do not add accounts, persistence, recording, audio, chat, analytics tracking, an SFU, or public-cloud mutations.
- Keep existing receiver URLs, WebSocket query parameters, signaling payloads, and `/metrics` JSON compatible.
- Accept WebSocket clients without an Origin header; browser origins are same-origin by default.
- Keep access credentials out of HTTP request URLs and logs.
- Use Python for repository scripts and inspection helpers to avoid PowerShell encoding problems.
- Public Tencent Cloud deployment remains a later phase after the user provides server access.

---

### Task 1: Frontend status, environment, and session policy

**Files:**
- Create: `apps/web/src/features/connection-status.ts`
- Create: `apps/web/src/features/connection-status.test.ts`
- Create: `apps/web/src/features/browser-environment.ts`
- Create: `apps/web/src/features/browser-environment.test.ts`
- Modify: `apps/web/src/features/session.ts`
- Modify: `apps/web/src/features/session.test.ts`

**Interfaces:**
- Produces: `ConnectionStatus`, `infoStatus`, `successStatus`, `errorStatus`, `connectionStateStatus`.
- Produces: `BrowserEnvironment`, `senderEnvironmentIssue`, `receiverEnvironmentIssue`.
- Produces: `newSenderSession(): Session`, which always rotates both room and key and does not reuse the location fragment.

- [ ] **Step 1: Write failing status and environment tests**

```ts
expect(connectionStateStatus("connecting")).toEqual({
  tone: "info",
  message: "正在建立视频连接...",
})
expect(connectionStateStatus("failed").tone).toBe("error")
expect(senderEnvironmentIssue({
  secureContext: false,
  hostname: "camera.example.com",
  hasWebSocket: true,
  hasPeerConnection: true,
  hasMediaDevices: true,
  hasGetUserMedia: true,
  hasCrypto: true,
})?.message).toContain("HTTPS")
```

- [ ] **Step 2: Write the failing session-rotation test**

```ts
const previous = randomSenderSession()
const next = newSenderSession()
expect(next.room).not.toBe(previous.room)
expect(next.key).not.toBe(previous.key)
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `bun test apps/web/src/features/connection-status.test.ts apps/web/src/features/browser-environment.test.ts apps/web/src/features/session.test.ts`

Expected: failure because the new modules and `newSenderSession` do not exist.

- [ ] **Step 4: Implement pure policy modules**

```ts
export type StatusTone = "info" | "success" | "error"
export type ConnectionStatus = { message: string; tone: StatusTone }

export function connectionStateStatus(state: RTCPeerConnectionState): ConnectionStatus {
  const statuses: Record<RTCPeerConnectionState, ConnectionStatus> = {
    new: infoStatus("等待视频连接..."),
    connecting: infoStatus("正在建立视频连接..."),
    connected: successStatus("视频连接已建立"),
    disconnected: infoStatus("视频连接暂时中断，正在恢复..."),
    failed: errorStatus("视频连接失败，请停止后重试"),
    closed: infoStatus("视频连接已关闭"),
  }
  return statuses[state]
}
```

Environment checks receive a plain object so tests never need to mutate browser globals. Loopback hosts `localhost`, `127.0.0.1`, and `::1` are accepted for insecure local development.

- [ ] **Step 5: Implement `newSenderSession` using the existing cryptographic generator**

Refactor the random byte helper so `randomSenderSession` can still restore an incoming fragment while `newSenderSession` always creates new values.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `bun test apps/web/src/features/connection-status.test.ts apps/web/src/features/browser-environment.test.ts apps/web/src/features/session.test.ts`

Expected: all focused tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/web/src/features
git commit -m "test: define frontend reliability policies"
```

---

### Task 2: Sender and receiver interaction hardening

**Files:**
- Create: `apps/web/src/features/video-stage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/status-alert.tsx`
- Modify: `apps/web/src/features/sender/sender-page.tsx`
- Modify: `apps/web/src/features/sender/use-sender.ts`
- Modify: `apps/web/src/features/receiver/receiver-page.tsx`
- Modify: `apps/web/src/features/receiver/use-receiver.ts`

**Interfaces:**
- Consumes: Task 1 status and environment helpers.
- Produces: hooks returning `{ status: ConnectionStatus, hasMedia: boolean }`.
- Produces: `VideoStage` with `label`, `hasMedia`, `placeholder`, and a forwarded video ref.

- [ ] **Step 1: Add failing compile-time usages**

Update pages to access `sender.status.message`, `sender.status.tone`, `sender.hasMedia`, and equivalent receiver fields before changing the hooks.

- [ ] **Step 2: Run typecheck and confirm RED**

Run: `bun run --cwd apps/web typecheck`

Expected: missing structured status and `hasMedia` fields.

- [ ] **Step 3: Convert hooks to structured status**

Replace raw status strings with `ConnectionStatus`. Mark permission denial, missing camera, signaling failure, invalid remote descriptions, candidate overflow, and recovery timeout as `error`; authenticated and connected states use `success`; transient progress uses `info`.

Before resource acquisition, call the Task 1 environment policy. Set `hasMedia` after local preview or remote track attachment and clear it during cleanup.

- [ ] **Step 4: Implement the media stage and accessibility behavior**

`VideoStage` keeps the existing 16:9 geometry. While `hasMedia` is false it displays a centered, non-interactive explanation over the media surface. The video remains in the DOM to avoid layout shift.

`StatusAlert` uses `role="alert"` only for error tone and `role="status" aria-live="polite"` otherwise.

- [ ] **Step 5: Fix the sender flow and page titles**

- Remove `disabled={sender.running}` from “复制接收链接”.
- Add “生成新会话”, disabled only while running.
- Keep session fields immutable while running.
- Do not copy validation text into the connection status region.
- Set route titles to “发送端 · 摄像头共享”, “接收端 · 摄像头共享”, and “关于 · 摄像头共享”.

- [ ] **Step 6: Run frontend verification**

Run: `bun run --cwd apps/web typecheck && bun run --cwd apps/web lint && bun run --cwd apps/web test && bun run --cwd apps/web build`

Expected: all commands pass and no raw `setStatus(connection.connectionState)` remains.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src
git commit -m "fix: harden camera sharing interactions"
```

---

### Task 3: Browser end-to-end coverage

**Files:**
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/ui.spec.ts`
- Create: `apps/web/e2e/webrtc.spec.ts`
- Modify: `xtask/src/main.rs`
- Modify: `README.md`

**Interfaces:**
- Produces: `bun run --cwd apps/web test:e2e`.
- Produces: `cargo xtask e2e` that builds the filesystem frontend, starts the Rust server on an isolated port, and runs Playwright.

- [ ] **Step 1: Add Playwright and scripts**

Run: `bun add --cwd apps/web --dev @playwright/test`

Add scripts `test:unit`, `test:e2e`, and keep `test` as the unit-test compatibility entry.

- [ ] **Step 2: Write failing UI tests**

```ts
await page.goto("/send")
await expect(page).toHaveTitle("发送端 · 摄像头共享")
await page.getByLabel("房间 ID").fill("ab")
await page.getByRole("button", { name: "开始发送" }).click()
await expect(page.getByRole("alert")).toHaveCount(1)
await expect(page.getByRole("status")).not.toContainText("房间 ID 需为")
```

The responsive test uses a 390x844 viewport, asserts no horizontal overflow, and verifies all primary actions are at least 44 pixels high.

- [ ] **Step 3: Write the failing WebRTC scenario**

Chromium launches with fake camera flags. Start the sender, assert “复制接收链接” remains enabled, open its receiver URL in a second page, start the receiver, and wait for both pages to report a connected state and non-empty media streams.

- [ ] **Step 4: Run E2E and confirm RED or missing-browser prerequisite**

Run: `bunx playwright install chromium` then `cargo xtask e2e`

Expected before harness completion: the command fails because `xtask e2e` is not implemented.

- [ ] **Step 5: Implement the isolated E2E harness**

The xtask command reserves a test port, builds the web app, starts the server with loopback-only host and test ICE configuration, waits for `/ready`, runs Playwright, and always terminates the child server.

- [ ] **Step 6: Run E2E and confirm GREEN**

Run: `cargo xtask e2e`

Expected: UI and Chromium WebRTC scenarios pass with no unexpected console errors.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web xtask README.md bun.lock
git commit -m "test: add browser WebRTC acceptance coverage"
```

---

### Task 4: Origin policy and protected metrics

**Files:**
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/web/security.rs`
- Modify: `apps/server/src/web/websocket.rs`
- Modify: `apps/server/src/web/mod.rs`
- Modify: `apps/server/tests/websocket.rs`
- Modify: `README.md`

**Interfaces:**
- Produces: `Config.allowed_origins: Vec<String>` and `Config.metrics_token: Option<String>`.
- Produces: `origin_allowed(headers, allowed_origins) -> bool`.
- Produces: bearer-protected existing `/metrics` JSON.

- [ ] **Step 1: Write failing configuration tests**

Test normalized HTTP/HTTPS origins, reject paths/query/fragments, reject invalid JSON and duplicate normalized origins, and reject metrics tokens shorter than 16 characters.

- [ ] **Step 2: Write failing HTTP and WebSocket tests**

Add cases for same-origin browser upgrade, rejected `Origin: null`, rejected cross-origin, configured extra origin, no-Origin client compatibility, missing bearer token, wrong token, and correct token.

- [ ] **Step 3: Run focused Rust tests and confirm RED**

Run: `cargo test --package webrtc-camera-share-server origin metrics websocket`

Expected: compile failure or assertion failure for missing policy.

- [ ] **Step 4: Implement strict configuration parsing**

Parse origins as `http::Uri`-compatible absolute origins with no userinfo, path beyond `/`, query, or fragment. Store normalized `scheme://authority` values. Compare bearer tokens with constant-time equality.

- [ ] **Step 5: Enforce origin before WebSocket upgrade**

Return `403` before acquiring a connection lease when a browser origin is not allowed. Preserve clients that omit Origin.

- [ ] **Step 6: Protect metrics and tighten CSP**

Keep public behavior when no token exists. When configured, require Bearer authentication. Change `connect-src` from scheme-wide `ws: wss:` to `'self'`.

- [ ] **Step 7: Run Rust tests and confirm GREEN**

Run: `cargo test --package webrtc-camera-share-server --all-features`

Expected: all existing and new tests pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/server README.md
git commit -m "fix: enforce signaling and metrics boundaries"
```

---

### Task 5: Deterministic WebSocket shutdown

**Files:**
- Modify: `apps/server/src/web/mod.rs`
- Modify: `apps/server/src/web/websocket.rs`
- Modify: `apps/server/src/main.rs`
- Modify: `apps/server/tests/websocket.rs`

**Interfaces:**
- Produces: `AppState::begin_shutdown()` and an internal shutdown subscription.
- WebSocket close code: `1012` (service restart), mapped to actionable frontend copy.

- [ ] **Step 1: Write the failing graceful-shutdown integration test**

Start the test server with a clonable `AppState`, authenticate a socket, call `begin_shutdown`, and assert close code 1012 plus eventual zero room/connection counts.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cargo test --package webrtc-camera-share-server graceful_shutdown -- --nocapture`

Expected: failure because shutdown notification is absent.

- [ ] **Step 3: Implement watch-based shutdown notification**

`AppState` owns a Tokio watch sender. Each socket subscribes after authentication and selects shutdown alongside heartbeat, outbound cancellation, writer completion, and incoming messages.

The main shutdown future calls `begin_shutdown` before returning control to Axum graceful shutdown.

- [ ] **Step 4: Add frontend close-code copy**

Map code 1012 to “服务正在重启，请稍后重新连接” for both roles.

- [ ] **Step 5: Run backend and frontend focused tests**

Run: `cargo test --workspace --all-features` and `bun test apps/web/src/features/connection-status.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/server apps/web/src/features
git commit -m "fix: drain signaling connections on shutdown"
```

---

### Task 6: CI, smoke checks, dependency automation, and draft releases

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/smoke.py`
- Modify: `xtask/src/main.rs`
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Produces: `cargo xtask smoke -- <binary>`.
- Produces: CI verify, audit, E2E, release-build, and smoke jobs.
- Produces: tag-triggered Windows/Linux artifacts, SHA-256 files, and draft GitHub Releases.

- [ ] **Step 1: Write the smoke checker and run it against a missing binary**

Run: `python -X utf8 scripts/smoke.py --binary target/release/missing.exe`

Expected: non-zero exit with a concise missing-binary message.

- [ ] **Step 2: Implement smoke assertions**

The script selects a free loopback port, supplies a test metrics token, starts the binary without a visible window on Windows, and verifies health, readiness, pages, configuration, metrics 401/200 behavior, security headers, immutable successful assets, and `no-store` missing assets. It always terminates the child.

- [ ] **Step 3: Add CI and Dependabot configuration**

Pin Bun 1.4 and Rust 1.97. Run canonical verification, `bun audit --registry=https://registry.npmjs.org`, `cargo audit`, Chromium E2E, embedded release, and smoke.

- [ ] **Step 4: Add draft release automation**

On `v*` tags, build Windows and Linux embedded binaries, generate SHA-256 files, upload artifacts, and create a draft release. Do not publish automatically.

- [ ] **Step 5: Add maintainer documents**

Document security reporting, supported versions, contribution verification, versioning, release notes, and the unreleased reliability-hardening changes.

- [ ] **Step 6: Validate workflow syntax and smoke locally**

Run: `cargo xtask release` then `python -X utf8 scripts/smoke.py --binary target/release/webrtc-camera-share-server.exe` on Windows.

Expected: smoke passes. Inspect workflow YAML with a Python YAML parser when available and at minimum parse it as text for required jobs, permissions, and pinned versions.

- [ ] **Step 7: Commit Task 6**

```bash
git add .github scripts xtask README.md CHANGELOG.md SECURITY.md CONTRIBUTING.md
git commit -m "ci: automate verification and draft releases"
```

---

### Task 7: Production deployment templates and runbook

**Files:**
- Create: `.env.example`
- Create: `.dockerignore`
- Create: `Dockerfile`
- Create: `compose.example.yml`
- Create: `deploy/caddy/Caddyfile.example`
- Create: `deploy/coturn/turnserver.conf.example`
- Create: `deploy/coturn/README.md`
- Create: `deploy/systemd/webrtc-camera-share.service.example`
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md`

**Interfaces:**
- Produces: secret-free examples that require explicit production domain, metrics token, and TURN secret values.
- Produces: documented ports 80/443, 3478 TCP/UDP, 5349 TCP, and a bounded UDP relay range.

- [ ] **Step 1: Add safe environment and container build definitions**

The multi-stage Dockerfile builds the Vite frontend and embedded Rust release, then runs as a non-root user with only the binary and required CA certificates.

- [ ] **Step 2: Add Caddy and coturn examples**

Caddy terminates HTTPS, preserves WebSocket upgrades, overwrites forwarded client headers, and blocks `/metrics` unless the caller supplies the configured bearer token to the app. Coturn uses long-term secret authentication, quotas, a bounded relay range, and explicit external/public IP placeholders.

- [ ] **Step 3: Add Compose and systemd examples**

Compose contains app and coturn health checks without embedding secrets. The systemd unit uses an environment file, restart policy, resource limits, and graceful stop timeout.

- [ ] **Step 4: Write the production runbook**

Cover prerequisites, DNS, firewall, secrets, first deployment, health checks, metrics, alert thresholds, logs, TURN diagnosis, upgrades, rollback, backup expectations for an in-memory service, incident response, and the later Tencent Cloud checklist.

- [ ] **Step 5: Validate examples mechanically**

Run: `docker compose -f compose.example.yml config` when Docker is available. Independently scan examples to ensure no real credentials, private keys, user IPs, or production domains are present.

- [ ] **Step 6: Commit Task 7**

```bash
git add .env.example .dockerignore Dockerfile compose.example.yml deploy docs/DEPLOYMENT.md README.md
git commit -m "docs: add production deployment package"
```

---

### Task 8: Load/soak tooling, polish, and final verification

**Files:**
- Create: `scripts/soak.py`
- Create: `apps/web/e2e/soak.spec.ts`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `python -X utf8 scripts/soak.py --receivers 1|2|4|8 --duration <seconds>`.
- Produces: JSON summaries containing server samples and browser WebRTC statistics, with no room key or full receiver URL.

- [ ] **Step 1: Implement argument validation tests through subprocess smoke cases**

Run invalid receiver counts and durations and assert non-zero exits with actionable messages.

- [ ] **Step 2: Implement bounded soak orchestration**

The Python script starts the test server and delegates browser creation and `getStats()` sampling to the Playwright soak spec. Output defaults to a temporary directory and redacts credentials.

- [ ] **Step 3: Run short 1- and 2-receiver smoke soaks**

Run: `python -X utf8 scripts/soak.py --receivers 1 --duration 15` and repeat with 2 receivers.

Expected: all peers connect, samples are written, no unexpected browser errors occur, and cleanup leaves no server process.

- [ ] **Step 4: Perform the final UI polish pass**

Verify sender, receiver, validation, permission, waiting, connected, copy-success, failure, and About states at 390x844, 768x1024, and desktop width. Confirm focus visibility, 44-pixel controls, no horizontal overflow, no duplicate announcements, no raw English RTC state, and no console warning/error.

- [ ] **Step 5: Run the complete verification gate**

Run:

```bash
cargo xtask verify
cargo xtask e2e
cargo xtask release
python -X utf8 scripts/smoke.py --binary target/release/webrtc-camera-share-server.exe
bun audit --registry=https://registry.npmjs.org --audit-level=low
cargo audit
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Reconcile documentation and status**

Ensure README commands match scripts, ports, variables, and release behavior. Mark repository-local hardening in `CHANGELOG.md` while leaving Tencent Cloud deployment explicitly pending.

- [ ] **Step 7: Commit Task 8**

```bash
git add scripts apps/web/e2e README.md docs/DEPLOYMENT.md CHANGELOG.md
git commit -m "test: add release soak and acceptance gates"
```

---

## Final Review Checklist

- [ ] Compare the final diff against every success criterion in the approved design.
- [ ] Confirm no public deployment, tag, remote push, or GitHub Release was created.
- [ ] Confirm the working tree is clean after the final repository-local commit.
- [ ] Record any check that could not run because a local external dependency such as Docker is unavailable.
- [ ] Prepare the separate Tencent Cloud execution checklist for use only after server access is provided.
