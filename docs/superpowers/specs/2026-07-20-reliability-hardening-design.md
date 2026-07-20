# WebRTC Camera Share Reliability Hardening Design

## Status

Approved in conversation on 2026-07-20. This document covers repository-local work. Public deployment to Tencent Cloud is a final, separate phase that starts only after the user provides server access.

## Objective

Raise the existing WebRTC camera-sharing MVP from a locally validated application to a release-ready, reproducible, and diagnosable self-hosted service without expanding the product into an account platform, recording service, chat product, or SFU-based broadcast system.

The work must preserve the current product model:

- one sender and one to eight receivers per room;
- in-memory rooms with no account or database dependency;
- direct WebRTC media and WebSocket-only signaling;
- access credentials in the URL fragment rather than HTTP requests;
- a Rust/Axum server with an embedded React/Vite frontend;
- a fixed native shadcn/ui dark theme.

## Success Criteria

The repository-local phase is complete when all of the following are true:

1. A sender can copy the receiver link both before and during an active session.
2. Sender and receiver pages present localized, actionable states for browser support, secure-context requirements, media readiness, signaling, WebRTC recovery, and failure.
3. Validation errors are announced once, route titles are distinct, empty media regions are explained, and existing keyboard, focus, responsive, and touch-target behavior remains intact.
4. Browser-facing WebSocket connections are same-origin by default, explicitly configured cross-origin origins are supported, and non-browser clients without an Origin header remain supported.
5. Metrics can be protected by a bearer token without removing the existing JSON response format.
6. Active WebSockets receive a service-restart close signal during graceful shutdown.
7. Unit, integration, browser end-to-end, dependency-audit, release-build, and smoke-test commands are reproducible locally and in CI.
8. The repository contains production-ready configuration examples, deployment documentation, release automation, and a repeatable load and soak harness.
9. No public cloud, DNS, certificate, TURN, or GitHub Release mutation occurs during the repository-local phase.

## Architecture

### Frontend boundaries

`useSender` and `useReceiver` remain the lifecycle orchestrators. They continue to own browser resources and React state, but reusable policy and presentation logic moves into small pure modules:

- browser capability and secure-context checks;
- localized RTC and WebSocket status mapping;
- typed status severity and recovery guidance;
- session generation and rotation;
- media-stage empty and waiting-state presentation.

This is an incremental extraction rather than a state-machine rewrite. PeerConnection ownership, generation guards, cancellation, ICE candidate queues, recovery timers, and bitrate balancing stay in the existing hooks unless a focused extraction directly improves testability.

The status model has explicit `info`, `success`, and `error` tones. Hooks expose a structured status and a `hasMedia` signal. Pages render field-validation errors only beside their fields; the connection-status region renders lifecycle and runtime status without repeating the validation message.

### Backend boundaries

The existing `Config`, `AppState`, and Axum router remain the main composition points.

Configuration gains:

- `ALLOWED_ORIGINS_JSON`: an optional JSON array of trusted HTTP or HTTPS origins;
- `METRICS_TOKEN`: an optional bearer token of at least 16 characters.

WebSocket origin policy is evaluated before an upgrade:

- a missing Origin header is accepted for test and non-browser clients;
- `Origin: null` is rejected;
- when `ALLOWED_ORIGINS_JSON` is present, the origin must exactly match a configured normalized origin;
- otherwise, the origin authority must match the request Host and the scheme must be HTTP or HTTPS.

Metrics keep the existing JSON shape. When `METRICS_TOKEN` is configured, `/metrics` requires `Authorization: Bearer <token>` and returns `401` with `WWW-Authenticate: Bearer` for missing or incorrect credentials. When it is not configured, existing local behavior remains compatible. Production templates always configure a token and prevent uncredentialed proxy access.

`AppState` gains a shutdown notification source. The main process triggers it before Axum graceful shutdown begins. Each authenticated WebSocket listens for that notification, sends a service-restart close frame, leaves its room, releases queue accounting, and allows the process to drain deterministically.

## User Experience

### Sender

- “复制接收链接” remains enabled while sending because the validated session is immutable during a run.
- “生成新会话” is available only while stopped and replaces both the room ID and access code with new high-entropy values.
- Before requesting camera access, the application verifies WebSocket, RTCPeerConnection, mediaDevices, getUserMedia, crypto, and secure-context support.
- Plain HTTP is accepted only on localhost and loopback development hosts. Other insecure origins show an HTTPS requirement without opening a permission prompt.
- The video stage explains the idle, permission, preparation, live-preview, and unavailable states.

### Receiver

- The video stage distinguishes waiting for the sender, negotiating, receiving media, autoplay blocking, temporary disconnection, and recovery failure.
- Raw browser states such as `connecting`, `disconnected`, and `failed` are never shown directly to users.
- The receiver does not request camera or microphone permission.

### Shared accessibility and copy rules

- Each route has a unique document title.
- Field errors retain `role="alert"` and are not copied into the connection live region.
- Informational lifecycle updates use a polite status region; runtime failures use an alert.
- Controls retain visible focus, semantic labels, 44-pixel touch targets, and mobile single-column actions.
- Error messages state what happened and what the user can do next.
- The documentation explains that URL fragments do not reach the HTTP server but can remain in local browser history, and that generating a new session rotates the credential.

## Security and Privacy

The current high-entropy defaults, SHA-256 access-code digest, constant-time comparison, authentication throttling, connection limits, message-size limits, byte-bounded queues, TURN credential rate limiting, request IDs, and security headers remain in place.

The Content Security Policy changes from scheme-wide WebSocket access to same-origin connections. Cross-origin browser signaling is enabled only through the explicit origin allowlist and a matching deployment CSP decision.

Production documentation treats the following as mandatory:

- HTTPS termination;
- an explicit metrics token;
- a random TURN shared secret;
- proxy header overwrite before `TRUST_PROXY=true`;
- restricted coturn relay ranges, quotas, and bandwidth;
- secrets supplied through environment or secret storage rather than committed files.

No implementation logs access codes, full receiver URLs, TURN shared secrets, or bearer tokens.

## Testing Strategy

### Test-driven changes

Every behavior change begins with a failing focused test. The implementation is the smallest change that makes that test pass, followed by the relevant local suite before the next behavior is started.

### Frontend unit tests

Bun tests cover:

- browser capability and secure-context decisions;
- localized RTC state mapping;
- status severity and recovery copy;
- session generation and rotation;
- runtime configuration success, timeout, invalid data, and degraded fallback reporting.

Coverage reporting must include all authored frontend modules rather than only files imported by the existing two test files. CI records coverage and enforces an initial threshold that reflects the real baseline, then raises it as hook behavior becomes testable.

### Rust unit and integration tests

Tests cover:

- origin normalization and same-origin comparison;
- rejected `null` and cross-origin browser upgrades;
- configured additional origins;
- metrics bearer success and failure;
- configuration validation for origins and token length;
- graceful WebSocket shutdown and room cleanup;
- all existing signaling, capacity, authentication, rate, and queue behavior.

### Browser end-to-end tests

Playwright runs against the real Rust server and production frontend build. Chromium uses a fake camera and automatic media permission only inside the test process.

Required scenarios are:

1. validation error semantics and single announcement;
2. distinct route titles and responsive layout;
3. start sender, keep copy enabled, and copy a fragment-based receiver URL;
4. one sender and one receiver completing a real PeerConnection and rendering remote media;
5. no unexpected console error or CSP violation.

Firefox and WebKit run the non-camera UI and signaling-safe scenarios. The fake-media WebRTC scenario is required on Chromium and can be expanded after it is stable.

### Load and soak tests

A repository script starts one sender and 1, 2, 4, or 8 receivers, samples server health and metrics, records process memory and CPU, and stores browser `getStats()` summaries. It supports a short smoke duration and an explicit long-soak duration. Long soak is a manual release gate rather than a default CI job.

## CI and Release Automation

GitHub Actions pins supported Bun and Rust versions and runs:

- the canonical `cargo xtask verify` gate;
- Bun and RustSec dependency audits;
- browser installation and Playwright E2E;
- an embedded release build;
- a launch-and-probe smoke test for health, readiness, pages, configuration, protected metrics, cache headers, and missing assets.

Dependabot monitors Cargo, Bun/npm, and GitHub Actions dependencies.

Tags matching `v*` build embedded Windows and Linux binaries. The workflow creates SHA-256 checksums, preserves licenses and release notes, uploads artifacts, and creates a draft GitHub Release. Publishing the draft remains a deliberate user action.

The repository gains `CHANGELOG.md`, `SECURITY.md`, and `CONTRIBUTING.md`. Version metadata remains consistent across the root package and Rust server; the private frontend package is not independently released.

## Deployment Assets

The repository-local phase adds:

- `.env.example` with safe non-secret defaults and required production placeholders;
- a multi-stage Dockerfile for the embedded binary;
- a Compose example wiring the app, coturn, and health checks;
- Caddy and coturn example configuration;
- a production runbook covering HTTPS, firewall ports, secrets, metrics, alerts, backup expectations, upgrades, rollback, and incident diagnosis;
- a smoke-test command suitable for local, CI, and Tencent Cloud use.

The examples do not contain real domain names, IP addresses, tokens, or shared secrets. They fail clearly when required production values are missing.

## Implementation Order

1. Fix the active-session copy flow and add regression coverage.
2. Add structured, localized status and media-stage behavior.
3. Add browser capability checks, session rotation, unique titles, and accessibility cleanup.
4. Add frontend unit and Playwright E2E coverage.
5. Add same-origin WebSocket policy, metrics authentication, CSP tightening, and graceful shutdown.
6. Add CI, dependency automation, and release smoke tests.
7. Add deployment examples, operations documentation, and load/soak tooling.
8. Run the complete local verification and browser quality pass.
9. After server access is supplied, deploy to Tencent Cloud, configure DNS/HTTPS/TURN/monitoring, run public-network and long-soak validation, and document the verified production state.

## Compatibility and Migration

- Existing sender and receiver URLs remain valid.
- Existing WebSocket query parameters and signaling payloads remain valid.
- Non-browser WebSocket clients remain valid without an Origin header.
- `/metrics` keeps its current JSON schema.
- Deployments that do not set the new variables retain local behavior, but the production examples opt into origin and metrics protection.
- No database migration or persisted state migration exists because rooms remain in memory.

## Explicit Non-Goals

This work does not add accounts, persistent rooms, recording, audio, chat, analytics tracking, media forwarding, an SFU, native applications, or automatic mutation of public cloud resources before credentials are provided.
