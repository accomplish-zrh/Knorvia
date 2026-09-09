"""Focused regressions; no live build or developer machine paths required."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from tools import release_manifest


def test_protocol_version_reads_both_constants(tmp_path: Path):
    source = tmp_path / "protocol" / "src" / "lib.rs"
    source.parent.mkdir(parents=True)
    source.write_text("pub const PROTOCOL_MAJOR: u32 = 2;\npub const PROTOCOL_MINOR: u32 = 7;", encoding="utf-8")
    assert release_manifest.protocol_version(tmp_path) == "2.7"
    source.write_text("pub const PROTOCOL_MAJOR: u32 = 1;", encoding="utf-8")
    with pytest.raises(RuntimeError, match="PROTOCOL_MINOR"):
        release_manifest.protocol_version(tmp_path)


def test_missing_uv_falls_through_to_python_build(tmp_path: Path, monkeypatch):
    out = tmp_path / "wheels"
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[0] == "uv":
            raise FileNotFoundError("uv unavailable")
        (out / "knorvia-1.0.0-py3-none-any.whl").write_bytes(b"fixture")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(release_manifest.subprocess, "run", run)
    assert release_manifest.build_wheel(tmp_path, out).is_file()
    assert calls[1][1:4] == ["-m", "pip", "wheel"]


def test_success_without_wheel_is_explicit_failure(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(release_manifest.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stderr=""))
    with pytest.raises(RuntimeError, match="no wheel was produced"):
        release_manifest.build_wheel(tmp_path, tmp_path / "wheels")
