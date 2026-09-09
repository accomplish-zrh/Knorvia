"""REL-001 SBOM gate: the shipped component inventory is Knorvia-branded.

A release ships an inventory of components with pinned versions:

* the shipped binary NAMES are knorvia-branded (``knorvia-daemon``,
  ``knorvia-pack-worker``, ``knorvia-kernel-appserver``) — the kernel
  fork's in-tree ``codex-app-server.exe`` is a dev-machine fallback only,
  never the shipped name;
* the daemon's initialize identity (name/product/user agent) carries no
  Codex branding;
* the Python package's runtime dependencies include no codex-branded
  package;
* the kernel workspace pins its own crate versions (Cargo.lock present).
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


def _daemon_bin() -> Path:
    override = os.environ.get("KNORVIA_DAEMON_BIN")
    if override and Path(override).is_file():
        return Path(override)
    for name in ("knorvia-daemon.exe", "knorvia-daemon"):
        candidate = _DEBUG_TARGET / name if (_DEBUG_TARGET := _KERNEL_RS / "target" / "debug") else None
        if candidate and candidate.is_file():
            return candidate
    pytest.skip("knorvia-daemon binary missing")


def test_shipped_binary_names_are_knorvia_branded() -> None:
    """The release layout's binary names are knorvia-branded. The kernel
    fork's in-tree ``codex-app-server.exe`` is a dev fallback; a release
    must ship ``knorvia-kernel-appserver``."""
    daemon = _daemon_bin()
    assert daemon.name.startswith("knorvia-daemon"), daemon.name
    siblings = {p.name for p in daemon.parent.iterdir() if p.is_file()}
    assert any(n.startswith("knorvia-pack-worker") for n in siblings), siblings


def test_daemon_identity_carries_no_codex_branding(daemon_home_factory) -> None:
    session = daemon_home_factory()
    try:
        info = session.server_info
        blob = json_safe = " ".join(
            str(info.get(key) or "") for key in ("name", "product", "userAgent")
        ).lower()
        assert info.get("product") == "Knorvia"
        assert "codex" not in blob, blob
    finally:
        session.close()


def test_python_dependencies_include_no_codex_package() -> None:
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    deps_section = re.split(r"\[project\.optional-dependencies\]|\[dependency-groups\]", text)[0]
    codex_deps = re.findall(r"^\s*\"?([a-z0-9-]*codex[a-z0-9-]*)\"?\s*[=>~<]", deps_section, re.MULTILINE | re.IGNORECASE)
    assert not codex_deps, f"codex-branded runtime dependencies: {codex_deps}"


def test_kernel_workspace_pins_its_crate_versions() -> None:
    lock = _KERNEL_RS / "Cargo.lock"
    assert lock.is_file(), "Cargo.lock must ship with the kernel workspace"
    text = lock.read_text(encoding="utf-8")
    knorvia_crates = re.findall(r'name = "(knorvia-[a-z-]+)"', text)
    assert "knorvia-daemon" in knorvia_crates
    assert "knorvia-control" in knorvia_crates
    assert "knorvia-migration" in knorvia_crates
    # Every knorvia crate entry pins a concrete version (no wildcard).
    for name in set(knorvia_crates):
        entry = re.search(
            r'name = "' + re.escape(name) + r'"\s*\nversion = "([^"]+)"', text
        )
        assert entry and entry.group(1), f"{name} has no pinned version"


@pytest.fixture
def daemon_home_factory(tmp_path: Path):
    bin_path = Path(
        os.environ.get(
            "KNORVIA_DAEMON_BIN",
            str(_KERNEL_RS / "target" / "debug" / "knorvia-daemon.exe"),
        )
    )
    if not bin_path.is_file():
        pytest.skip("knorvia-daemon binary missing")
    os.environ["KNORVIA_DAEMON_BIN"] = str(bin_path)

    def _open() -> DaemonSession:
        home = tmp_path / f"knorvia-home-{len(list(tmp_path.iterdir()))}"
        home.mkdir()
        os.environ["KNORVIA_HOME"] = str(home)
        return DaemonSession(home)

    return _open
