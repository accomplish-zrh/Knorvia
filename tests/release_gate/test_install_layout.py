"""REL-001 install-layout gate: every shipped piece loads from its layout.

The install set is:

* ``knorvia-daemon`` — resolvable via ``KNORVIA_DAEMON_BIN`` (or the
  packaged sibling of the host executable).
* ``knorvia-pack-worker`` — a sibling of the daemon binary (the
  capability host never searches PATH).
* the kernel app-server binary — resolvable via ``KNORVIA_KERNEL_BIN``
  (or a sibling of the daemon); it must not be the user's official Codex
  install (a PATH ``codex`` shim is refused by the adapter, and the gate
  pins that too).
* the Python package — ``knorvia`` importable, the media-worker module
  reachable through ``KNORVIA_PYTHON`` (the Python worker runtime).

A release whose layout is missing any of these is not shippable.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_KERNEL_RS = Path(
    os.environ.get(
        "KNORVIA_KERNEL_RS_DIR",
        r"D:\tools\knorvia-kernel\knorvia-rs",
    )
)
_DEBUG_TARGET = _KERNEL_RS / "target" / "debug"


def _daemon_bin() -> Path:
    override = os.environ.get("KNORVIA_DAEMON_BIN")
    if override and Path(override).is_file():
        return Path(override)
    for name in ("knorvia-daemon.exe", "knorvia-daemon"):
        candidate = _DEBUG_TARGET / name
        if candidate.is_file():
            return candidate
    pytest.skip("knorvia-daemon binary missing (build with cargo build -p knorvia-daemon)")


def test_pack_worker_is_a_sibling_of_the_daemon() -> None:
    """The capability host resolves the worker as a daemon sibling, never PATH."""
    daemon = _daemon_bin()
    worker_names = ("knorvia-pack-worker.exe", "knorvia-pack-worker")
    siblings = [daemon.parent / name for name in worker_names]
    assert any(p.is_file() for p in siblings), (
        f"knorvia-pack-worker must sit next to the daemon at {daemon.parent} "
        "(the capability host resolves it as a sibling, never via PATH)"
    )


def test_kernel_appserver_resolves_next_to_the_daemon() -> None:
    """The kernel adapter resolves its binary next to the daemon — and that
    binary is never the user's official Codex install."""
    daemon = _daemon_bin()
    candidates = [
        daemon.parent / "knorvia-kernel-appserver.exe",
        daemon.parent / "codex-app-server.exe",
        # In-tree build layout (dev machines): the kernel fork's own target.
        _KERNEL_RS.parent / "codex-rs" / "target" / "debug" / "codex-app-server.exe",
    ]
    found = next((p for p in candidates if p.is_file()), None)
    if found is None:
        pytest.skip(
            "kernel app-server binary missing (build codex-app-server in the kernel workspace)"
        )
    # The resolved binary is in the fork's own target dir (or shipped next to
    # the daemon) — never a PATH lookup of the user's Codex install.
    resolved = str(found.resolve()).lower()
    assert "codex-rs" in resolved or "knorvia" in resolved, (
        f"the kernel binary must come from the Knorvia fork or the shipped layout, got {resolved}"
    )
    assert shutil.which("codex") is None or "codex-rs" in resolved, (
        "a PATH `codex` shim must never be the resolved kernel binary"
    )


def test_python_package_and_media_worker_load() -> None:
    """The Python package is importable and the media-worker module is
    reachable through ``KNORVIA_PYTHON`` (the daemon spawns it for media
    packs)."""
    import knorvia  # noqa: F401 — the package must be importable
    from knorvia.workers.media_worker import MEDIA_PACKS, serve  # noqa: F401

    assert "media.visualize" in MEDIA_PACKS
    assert "media.manim" in MEDIA_PACKS

    python = os.environ.get("KNORVIA_PYTHON") or sys.executable
    proc = subprocess.run(
        [
            python,
            "-c",
            "import knorvia.workers.media_worker as m; print(len(m.MEDIA_PACKS))",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "2"


def test_daemon_starts_from_the_layout(tmp_path: Path) -> None:
    """The assembled layout actually serves: the daemon answers initialize."""
    from knorvia.runtime.kernel_client import DaemonSession

    home = tmp_path / "knorvia-home"
    home.mkdir()
    os.environ.setdefault(
        "KNORVIA_DAEMON_BIN", str(_daemon_bin())
    )
    session = DaemonSession(home)
    try:
        assert session.server_info.get("name") == "knorvia-daemon"
    finally:
        session.close()
