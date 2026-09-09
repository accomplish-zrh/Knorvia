"""REL-001 release gate: the shipped daemon reports its true version.

The daemon's ``initialize`` result carries ``server.version`` from the
Rust workspace's ``CARGO_PKG_VERSION``. The release gate pins that reported
version to the workspace manifest — a binary built from a different
manifest (stale build, wrong tag) fails here before it ships.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from knorvia.runtime.kernel_client import DaemonSession

_KERNEL_RS = Path(
    os.environ.get(
        "KNORVIA_KERNEL_RS_DIR",
        r"D:\tools\knorvia-kernel\knorvia-rs",
    )
)


def _workspace_version() -> str:
    manifest = _KERNEL_RS / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "knorvia-rs workspace version not found in Cargo.toml"
    return match.group(1)


@pytest.fixture
def daemon_home(tmp_path: Path) -> Path:
    bin_path = Path(
        os.environ.get(
            "KNORVIA_DAEMON_BIN",
            str(_KERNEL_RS / "target" / "debug" / "knorvia-daemon.exe"),
        )
    )
    if not bin_path.is_file():
        pytest.skip("knorvia-daemon binary missing")
    os.environ["KNORVIA_DAEMON_BIN"] = str(bin_path)
    home = tmp_path / "knorvia-home"
    home.mkdir()
    os.environ["KNORVIA_HOME"] = str(home)
    return home


def test_daemon_reports_the_workspace_version(daemon_home: Path) -> None:
    session = DaemonSession(daemon_home)
    try:
        version = session.server_version
        assert version, "daemon must report a version in initialize"
        assert version == _workspace_version(), (
            f"daemon reports {version!r} but the workspace manifest pins "
            f"{_workspace_version()!r} — rebuild the shipped binary"
        )
        # Knorvia, never a Codex product identity.
        assert session.server_info.get("product") == "Knorvia"
        assert "codex" not in str(
            session.server_info.get("userAgent", "")
        ).lower()
    finally:
        session.close()


def test_server_identity_is_knorvia_not_codex(daemon_home: Path) -> None:
    session = DaemonSession(daemon_home)
    try:
        assert session.server_info.get("name") == "knorvia-daemon"
        assert session.server_info.get("telemetryNamespace")
    finally:
        session.close()
