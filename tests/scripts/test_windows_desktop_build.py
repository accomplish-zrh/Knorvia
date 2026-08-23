"""Contracts for the self-contained Windows desktop build."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build_windows_desktop.ps1"


def test_desktop_runtime_installs_app_extra_from_the_local_wheel() -> None:
    script = BUILD_SCRIPT.read_text(encoding="utf-8")

    assert '$WheelWithApp = "$($Wheel.FullName)[app]"' in script
    assert "--upgrade $WheelWithApp" in script
    assert "--upgrade $Wheel.FullName" not in script
    assert '--upgrade "knorvia[app]"' not in script
