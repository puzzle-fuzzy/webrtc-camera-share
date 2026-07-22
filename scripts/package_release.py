#!/usr/bin/env python3
"""Create a cross-platform release archive and SHA-256 sidecar."""

from __future__ import annotations

import argparse
import hashlib
import tarfile
import zipfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    repository = Path(__file__).resolve().parents[1]
    binary = args.binary.resolve()
    output = args.output.resolve()
    if not binary.is_file():
        raise SystemExit(f"release binary does not exist: {binary}")

    inputs = [
        (binary, binary.name),
        (repository / "README.md", "README.md"),
        (repository / "CHANGELOG.md", "CHANGELOG.md"),
        (repository / "LICENSE", "LICENSE"),
    ]
    missing = [str(path) for path, _ in inputs if not path.is_file()]
    if missing:
        raise SystemExit(f"release inputs are missing: {', '.join(missing)}")

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    if output.name.endswith(".tar.gz"):
        with tarfile.open(output, "w:gz") as archive:
            for path, name in inputs:
                archive.add(path, arcname=name)
    elif output.suffix == ".zip":
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path, name in inputs:
                archive.write(path, arcname=name)
    else:
        raise SystemExit("release output must end in .zip or .tar.gz")

    checksum = output.with_name(f"{output.name}.sha256")
    checksum.write_text(f"{sha256(output)}  {output.name}\n", encoding="utf-8")
    print(f"created {output}")
    print(f"created {checksum}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
