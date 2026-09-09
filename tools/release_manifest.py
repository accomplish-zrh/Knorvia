"""Assemble the Knorvia release set into a staging directory.

REL-001's release-manifest builder: copy the shipped binaries (daemon,
pack-worker, kernel app-server under its knorvia-branded name), the Python
package wheel, and write SHA256 checksums plus a ``manifest.json`` with
every component's pinned version. The installer consumes exactly this
layout; the release gate (``tests/release_gate``) verifies it.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_KERNEL_RS = Path(r"D:\tools\knorvia-kernel\knorvia-rs")
DEFAULT_PRODUCT_ROOT = Path(r"D:\tools\Knorvia")

_SHIPPED_BINARIES = ("knorvia", "knorvia-daemon", "knorvia-pack-worker")
_KERNEL_APPSERVER_NAME = "knorvia-kernel-appserver.exe"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def workspace_version(kernel_rs: Path) -> str:
    text = (kernel_rs / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise RuntimeError("knorvia-rs workspace version not found in Cargo.toml")
    return match.group(1)


def product_version(product_root: Path) -> str:
    init = product_root / "knorvia" / "__version__.py"
    match = re.search(r'__version__\s*=\s*"([^"]+)"', init.read_text(encoding="utf-8"))
    if not match:
        raise RuntimeError("product version not found in knorvia/__version__.py")
    return match.group(1)


def assemble_release_set(
    staging: Path,
    *,
    kernel_rs: Path = DEFAULT_KERNEL_RS,
    product_root: Path = DEFAULT_PRODUCT_ROOT,
    target: str = "debug",
) -> dict:
    """Copy the shipped pieces into *staging* and write checksums + manifest.

    Returns the manifest dict. Every shipped binary is knorvia-branded; the
    kernel fork's in-tree ``codex-app-server.exe`` is renamed to
    ``knorvia-kernel-appserver.exe`` (the adapter resolves that name first).
    """
    target_dir = kernel_rs / "target" / target
    staging = Path(staging)
    staging.mkdir(parents=True, exist_ok=True)
    bin_dir = staging / "bin"
    bin_dir.mkdir(exist_ok=True)

    manifest: dict = {
        "components": [],
        "checksums": {},
    }

    for name in _SHIPPED_BINARIES:
        src = target_dir / f"{name}.exe"
        if not src.is_file():
            src = target_dir / name
        if not src.is_file():
            raise RuntimeError(f"missing shipped binary: {name} (build with cargo build)")
        dest = bin_dir / src.name
        shutil.copy2(src, dest)
        manifest["checksums"][dest.name] = sha256(dest)
        manifest["components"].append(
            {"name": name, "path": str(dest), "source": str(src)}
        )

    kernel_src = kernel_rs.parent / "codex-rs" / "target" / target / "codex-app-server.exe"
    if not kernel_src.is_file():
        raise RuntimeError(
            "missing the kernel app-server binary (build codex-app-server in the kernel workspace)"
        )
    kernel_dest = bin_dir / _KERNEL_APPSERVER_NAME
    shutil.copy2(kernel_src, kernel_dest)
    manifest["checksums"][kernel_dest.name] = sha256(kernel_dest)
    manifest["components"].append(
        {"name": "knorvia-kernel-appserver", "path": str(kernel_dest), "source": str(kernel_src)}
    )

    wheel = build_wheel(product_root, staging / "wheel")
    manifest["checksums"][wheel.name] = sha256(wheel)
    manifest["components"].append(
        {"name": "knorvia (python wheel)", "path": str(wheel)}
    )

    manifest["runtime"] = {
        # The interpreter the daemon uses to spawn the Python media worker.
        "mediaWorkerPython": sys.executable,
    }
    manifest["versions"] = {
        "kernel": workspace_version(kernel_rs),
        "product": product_version(product_root),
        "protocol": protocol_version(kernel_rs),
    }
    (staging / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    (staging / "SHA256SUMS.txt").write_text(
        "\n".join(f"{digest}  {name}" for name, digest in manifest["checksums"].items())
        + "\n",
        encoding="utf-8",
    )
    return manifest


def protocol_version(kernel_rs: Path) -> str:
    lib = kernel_rs / "protocol" / "src" / "lib.rs"
    text = lib.read_text(encoding="utf-8")
    parts = []
    for name in ("PROTOCOL_MAJOR", "PROTOCOL_MINOR"):
        match = re.search(rf'\b{name}:\s*u32\s*=\s*(\d+)\s*;', text)
        if not match:
            raise RuntimeError(f"protocol version constant missing: {name}")
        parts.append(match.group(1))
    return ".".join(parts)


def build_wheel(product_root: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    last_error = "no wheel was produced"
    # uv-managed venvs ship no pip; prefer uv when present, then pip, then
    # python -m build.
    for cmd in (
        ["uv", "build", "--wheel", "--out-dir", str(out_dir), str(product_root)],
        [sys.executable, "-m", "pip", "wheel", ".", "--no-deps", "-w", str(out_dir)],
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(out_dir)],
    ):
        try:
            proc = subprocess.run(
                cmd, cwd=str(product_root), capture_output=True, text=True, timeout=600
            )
        except FileNotFoundError:
            last_error = f"build tool not found: {cmd[0]}"
            continue
        if proc.returncode == 0:
            wheels = sorted(out_dir.glob("knorvia-*.whl"))
            if wheels:
                return wheels[-1]
            continue
        last_error = proc.stderr[-800:]
    raise RuntimeError(f"wheel build failed: {last_error}")


__all__ = ["assemble_release_set", "sha256"]
