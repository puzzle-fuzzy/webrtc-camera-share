#!/usr/bin/env python3
"""Launch a release binary and verify its production HTTP surface."""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


METRICS_TOKEN = "smoke-metrics-token-0123456789"
STARTUP_TIMEOUT_SECONDS = 20.0


class SmokeError(RuntimeError):
    """An actionable smoke-check failure."""


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: Mapping[str, str]
    body: bytes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start a camera-share binary and run release smoke checks."
    )
    parser.add_argument("--binary", required=True, type=Path)
    return parser.parse_args()


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def http_request(
    base_url: str,
    path: str,
    headers: Mapping[str, str] | None = None,
) -> HttpResult:
    request = urllib.request.Request(
        f"{base_url}{path}",
        headers={"Accept": "*/*", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            return HttpResult(
                status=response.status,
                headers={key.lower(): value for key, value in response.headers.items()},
                body=response.read(4 * 1024 * 1024),
            )
    except urllib.error.HTTPError as error:
        return HttpResult(
            status=error.code,
            headers={key.lower(): value for key, value in error.headers.items()},
            body=error.read(4 * 1024 * 1024),
        )


def expect_status(result: HttpResult, expected: int, path: str) -> None:
    if result.status != expected:
        raise SmokeError(f"{path} returned {result.status}, expected {expected}")


def json_body(result: HttpResult, path: str) -> dict[str, object]:
    try:
        value = json.loads(result.body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SmokeError(f"{path} did not return valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise SmokeError(f"{path} JSON must be an object")
    return value


def wait_until_ready(process: subprocess.Popen[str], base_url: str) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            raise SmokeError(f"server exited before readiness with code {exit_code}")
        try:
            result = http_request(base_url, "/ready")
            if result.status == 200:
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise SmokeError(f"server did not become ready within {STARTUP_TIMEOUT_SECONDS:g}s")


def first_asset_path(index: HttpResult) -> str:
    html = index.body.decode("utf-8")
    match = re.search(r'''(?:src|href)=["']([^"']*?/assets/[^"']+)["']''', html)
    if not match:
        raise SmokeError("production index did not reference a hashed asset")
    path = match.group(1)
    return path if path.startswith("/") else f"/{path}"


def assert_security_headers(result: HttpResult) -> None:
    expected = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
    }
    for name, value in expected.items():
        if result.headers.get(name) != value:
            raise SmokeError(
                f"security header {name} was {result.headers.get(name)!r}, expected {value!r}"
            )
    if not result.headers.get("x-request-id"):
        raise SmokeError("security header x-request-id is missing")
    csp = result.headers.get("content-security-policy", "")
    if "connect-src 'self';" not in csp or " ws:" in csp or " wss:" in csp:
        raise SmokeError(f"content-security-policy has an unsafe connect-src: {csp!r}")


def run_assertions(base_url: str) -> None:
    health = http_request(base_url, "/health")
    expect_status(health, 200, "/health")
    assert_security_headers(health)
    health_json = json_body(health, "/health")
    if health_json.get("ok") is not True:
        raise SmokeError("/health did not report ok=true")

    ready = http_request(base_url, "/ready")
    expect_status(ready, 200, "/ready")
    if json_body(ready, "/ready").get("web") is not True:
        raise SmokeError("/ready did not report web=true")

    index: HttpResult | None = None
    for path in ("/send", "/recv", "/about"):
        page = http_request(base_url, path)
        expect_status(page, 200, path)
        if "text/html" not in page.headers.get("content-type", ""):
            raise SmokeError(f"{path} did not return HTML")
        if b"<!doctype html" not in page.body.lower():
            raise SmokeError(f"{path} did not return the application shell")
        if path == "/send":
            index = page

    config = http_request(base_url, "/config")
    expect_status(config, 200, "/config")
    config_json = json_body(config, "/config")
    if not isinstance(config_json.get("iceServers"), list):
        raise SmokeError("/config iceServers must be an array")
    if not isinstance(config_json.get("maxReceivers"), int):
        raise SmokeError("/config maxReceivers must be an integer")

    unauthorized = http_request(base_url, "/metrics")
    expect_status(unauthorized, 401, "/metrics without token")
    if unauthorized.headers.get("www-authenticate") != "Bearer":
        raise SmokeError("protected /metrics did not advertise Bearer authentication")

    metrics = http_request(
        base_url,
        "/metrics",
        {"Authorization": f"Bearer {METRICS_TOKEN}"},
    )
    expect_status(metrics, 200, "/metrics with token")
    metrics_json = json_body(metrics, "/metrics")
    for key in ("rooms", "peers", "connections", "queuedSignalBytes"):
        if key not in metrics_json:
            raise SmokeError(f"/metrics is missing {key}")

    if index is None:
        raise SmokeError("application index was not checked")
    asset_path = first_asset_path(index)
    asset = http_request(base_url, asset_path)
    expect_status(asset, 200, asset_path)
    if asset.headers.get("cache-control") != "public, max-age=31536000, immutable":
        raise SmokeError("successful hashed assets must use immutable caching")

    missing_asset = http_request(base_url, "/assets/__smoke_missing__.js")
    expect_status(missing_asset, 404, "missing asset")
    if missing_asset.headers.get("cache-control") != "no-store":
        raise SmokeError("missing assets must use no-store caching")


def stop_process(process: subprocess.Popen[str]) -> str:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    output = process.stdout.read() if process.stdout else ""
    return output.strip()


def run_smoke(binary: Path) -> None:
    binary = binary.expanduser().resolve()
    if not binary.is_file():
        raise SmokeError(f"binary does not exist: {binary}")

    repository = Path(__file__).resolve().parents[1]
    port = reserve_port()
    base_url = f"http://127.0.0.1:{port}"
    environment = os.environ.copy()
    for name in (
        "ALLOWED_ORIGINS_JSON",
        "TURN_URLS_JSON",
        "TURN_SHARED_SECRET",
        "TURN_TTL_SECONDS",
    ):
        environment.pop(name, None)
    environment.update(
        {
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "WEB_DIST": str(repository / "apps" / "web" / "dist"),
            "ICE_SERVERS_JSON": '[{"urls":"stun:127.0.0.1:9"}]',
            "METRICS_TOKEN": METRICS_TOKEN,
            "RUST_LOG": "webrtc_camera_share_server=warn",
        }
    )
    process = subprocess.Popen(
        [str(binary)],
        cwd=repository,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        wait_until_ready(process, base_url)
        run_assertions(base_url)
    except BaseException as error:
        output = stop_process(process)
        detail = f"\nserver output:\n{output[-4000:]}" if output else ""
        if isinstance(error, SmokeError):
            raise SmokeError(f"{error}{detail}") from error
        raise
    else:
        stop_process(process)
    print(f"release smoke passed: {binary.name} at {base_url}")


def main() -> int:
    args = parse_args()
    try:
        run_smoke(args.binary)
    except SmokeError as error:
        print(f"smoke failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
