# -*- coding: utf-8 -*-
"""Packaged-app CLI detection: probe the well-known per-user install paths.

The desktop app inherits Explorer's PATH, which covers CLIs installed
while the user session was already running... mostly. Some installers
update only the registry (HKCU\\Environment) without broadcasting
WM_SETTINGCHANGE, so a long-lived Explorer never sees the new entry and
the packaged app — launched from that stale Explorer — reports "not
installed" until reboot. Detect now falls back to checking each backend's
documented default install locations directly before giving up.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable


def _candidate_paths(cli_command: str) -> list[Path]:
    """Documented per-user install locations for the known agent CLIs."""
    home = Path.home()
    appdata = os.environ.get("LOCALAPPDATA", "")
    appdata_roaming = os.environ.get("APPDATA", "")
    ext = ".exe" if os.name == "nt" else ""
    candidates: dict[str, list[Path]] = {
        "claude": [home / ".local" / "bin" / f"claude{ext}"],
        "codex": [
            Path(appdata_roaming) / "npm" / f"codex{ext}" if appdata_roaming else None,
            home / ".codex" / "bin" / f"codex{ext}",
        ],
        "gemini": [
            Path(appdata_roaming) / "npm" / f"gemini{ext}" if appdata_roaming else None,
        ],
        "grok": [home / ".grok" / "bin" / f"grok{ext}"],
        "kimi": [home / ".kimi" / "bin" / f"kimi{ext}"],
        "opencode": [
            Path(appdata) / "opencode" / "bin" / f"opencode{ext}" if appdata else None,
            home / ".opencode" / "bin" / f"opencode{ext}",
        ],
        "mimo": [
            Path(appdata_roaming) / "npm" / f"mimo{ext}" if appdata_roaming else None,
        ],
    }
    return [p for p in candidates.get(cli_command, []) if p]


def find_cli_fallback(cli_command: str) -> str | None:
    """Absolute path to the CLI from its documented install location, or None."""
    for candidate in _candidate_paths(cli_command):
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def enhanced_detail(
    cli_command: str, base_detail_fn: Callable[[], str], ok: bool, text: str
) -> tuple[bool, str]:
    """Post-process a detect result: upgrade a PATH miss into an absolute-path hit.

    Returns (available, detail). When the fallback finds the binary it also
    returns its full path as the detail so the UI can show where it lives.
    """
    if ok:
        return True, text
    fallback = find_cli_fallback(cli_command)
    if fallback:
        return (
            True,
            fallback,
        )
    return (
        False,
        base_detail_fn()
        or (
            f"{cli_command} CLI not found on PATH. Install it, then restart "
            f"Knorvia so it picks up the updated PATH."
        ),
    )
