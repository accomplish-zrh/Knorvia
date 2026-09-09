"""REL-001 release-manifest gate: the assembled release set the installer consumes.

The builder (``tools/release_manifest.py``) stages the shipped pieces —
knorvia-branded binaries (the kernel app-server under its shipped name),
the Python wheel, SHA256 checksums, and a version manifest. The gate runs
the assembler and verifies the layout: every component present, checksums
matching the bytes on disk, versions consistent with the sources, no
codex-branded shipped names.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

import pytest

_KERNEL_RS = Path(
    os.environ.get(
        "KNORVIA_KERNEL_RS_DIR",
        r"D:\tools\knorvia-kernel\knorvia-rs",
    )
)
_PRODUCT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_PRODUCT_ROOT / "tools"))

from release_manifest import assemble_release_set, protocol_version, workspace_version  # noqa: E402


def _product_version() -> str:
    init = _PRODUCT_ROOT / "knorvia" / "__version__.py"
    match = re.search(r'__version__\s*=\s*"([^"]+)"', init.read_text(encoding="utf-8"))
    assert match
    return match.group(1)


@pytest.fixture(scope="module")
def staged(tmp_path_factory: pytest.TempPathFactory) -> Path:
    staging = tmp_path_factory.mktemp("release-staging") / "set"
    assemble_release_set(staging)
    return staging


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_manifest_json_round_trips_and_versions_match_sources(staged: Path) -> None:
    manifest = json.loads((staged / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["versions"]["kernel"] == workspace_version(_KERNEL_RS)
    assert manifest["versions"]["product"] == _product_version()
    assert manifest["versions"]["protocol"] == protocol_version(_KERNEL_RS)
    for component in manifest["components"]:
        assert Path(component["path"]).is_file(), component["name"]


def test_checksums_match_the_bytes_on_disk(staged: Path) -> None:
    manifest = json.loads((staged / "manifest.json").read_text(encoding="utf-8"))
    sums = {}
    for line in (staged / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        sums[name] = digest
    assert set(sums) == set(manifest["checksums"])
    for name, digest in sums.items():
        on_disk = _sha256(staged / "bin" / name) if (staged / "bin" / name).is_file() else _sha256(staged / "wheel" / name)
        assert on_disk == digest, f"checksum mismatch for {name}"
        assert manifest["checksums"][name] == digest


def test_shipped_names_are_knorvia_branded(staged: Path) -> None:
    bin_names = {p.name for p in (staged / "bin").iterdir() if p.is_file()}
    assert "knorvia.exe" in bin_names
    assert "knorvia-daemon.exe" in bin_names
    assert "knorvia-pack-worker.exe" in bin_names
    assert "knorvia-kernel-appserver.exe" in bin_names
    # The fork's in-tree name never ships.
    assert "codex-app-server.exe" not in bin_names
