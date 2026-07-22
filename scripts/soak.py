#!/usr/bin/env python3
"""Run a bounded local WebRTC soak and persist redacted JSON samples."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


MIN_DURATION_SECONDS = 5
MAX_DURATION_SECONDS = 24 * 60 * 60


class SoakError(RuntimeError):
    """An actionable soak orchestration failure."""


def duration_seconds(value: str) -> int:
    try:
        duration = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("duration must be an integer number of seconds") from error
    if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
        raise argparse.ArgumentTypeError(
            f"duration must be between {MIN_DURATION_SECONDS} and {MAX_DURATION_SECONDS} seconds"
        )
    return duration


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local fake-camera soak with 1, 2, 4, or 8 receivers."
    )
    parser.add_argument("--receivers", type=int, choices=(1, 2, 4, 8), required=True)
    parser.add_argument("--duration", type=duration_seconds, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        help="Output directory; defaults to a new temporary directory.",
    )
    return parser.parse_args()


def run_checked(command: list[str], repository: Path) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    result = subprocess.run(command, cwd=repository)
    if result.returncode:
        raise SoakError(f"command exited with {result.returncode}: {' '.join(command)}")


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_until_ready(process: subprocess.Popen[str], base_url: str) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SoakError(f"test server exited before readiness with code {process.returncode}")
        try:
            with urllib.request.urlopen(f"{base_url}/ready", timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise SoakError("test server did not become ready within 20 seconds")


def debug_binary(repository: Path) -> Path:
    target = Path(os.environ.get("CARGO_TARGET_DIR", repository / "target"))
    if not target.is_absolute():
        target = repository / target
    suffix = ".exe" if os.name == "nt" else ""
    return target / "debug" / f"webrtc-camera-share-server{suffix}"


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


def validate_summary(path: Path, receivers: int) -> None:
    if not path.is_file():
        raise SoakError(f"Playwright did not create the summary: {path}")
    try:
        summary = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SoakError(f"soak summary is not valid JSON: {error}") from error
    if summary.get("receivers") != receivers:
        raise SoakError("soak summary receiver count does not match the request")
    samples = summary.get("samples")
    if not isinstance(samples, list) or not samples:
        raise SoakError("soak summary does not contain samples")

    serialized = json.dumps(summary, ensure_ascii=False)
    for forbidden in ("receiverUrl", "shareUrl", '"room"', '"key"', "#room="):
        if forbidden in serialized:
            raise SoakError(f"soak summary contains forbidden credential material: {forbidden}")


def run_soak(receivers: int, duration: int, output: Path | None) -> Path:
    repository = Path(__file__).resolve().parents[1]
    output = (
        output.expanduser().resolve()
        if output
        else Path(tempfile.mkdtemp(prefix="webrtc-camera-share-soak-"))
    )
    try:
        output.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise SoakError(f"cannot create the output directory {output}: {error}") from error
    summary = output / "summary.json"
    if summary.exists():
        raise SoakError(f"refusing to overwrite an existing summary: {summary}")

    run_checked(["bun", "run", "--cwd", "apps/web", "build"], repository)
    run_checked(
        ["cargo", "build", "--package", "webrtc-camera-share-server"],
        repository,
    )

    binary = debug_binary(repository)
    if not binary.is_file():
        raise SoakError(f"debug server binary is missing after build: {binary}")

    port = reserve_port()
    base_url = f"http://127.0.0.1:{port}"
    metrics_token = secrets.token_urlsafe(32)
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
            "METRICS_TOKEN": metrics_token,
            "RUST_LOG": "webrtc_camera_share_server=warn",
        }
    )
    server = subprocess.Popen(
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
        wait_until_ready(server, base_url)
        playwright_environment = environment.copy()
        playwright_environment.update(
            {
                "E2E_BASE_URL": base_url,
                "SOAK_RECEIVERS": str(receivers),
                "SOAK_DURATION_SECONDS": str(duration),
                "SOAK_OUTPUT_FILE": str(summary),
                "SOAK_METRICS_TOKEN": metrics_token,
            }
        )
        command = [
            "bun",
            "run",
            "--cwd",
            "apps/web",
            "test:e2e",
            "--",
            "e2e/soak.spec.ts",
        ]
        print(f"$ {' '.join(command)}", flush=True)
        result = subprocess.run(command, cwd=repository, env=playwright_environment)
        if result.returncode:
            raise SoakError(f"Playwright soak exited with {result.returncode}")
        validate_summary(summary, receivers)
    except BaseException as error:
        output_log = stop_process(server)
        detail = f"\nserver output:\n{output_log[-4000:]}" if output_log else ""
        if isinstance(error, SoakError):
            raise SoakError(f"{error}{detail}") from error
        raise
    else:
        stop_process(server)

    print(f"soak passed; redacted summary: {summary}")
    return summary


def main() -> int:
    args = parse_args()
    try:
        run_soak(args.receivers, args.duration, args.output)
    except SoakError as error:
        print(f"soak failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
