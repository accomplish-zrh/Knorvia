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


def _windows_shim_names(cli_command: str) -> list[str]:
    """Windows npm/global shims: bare name, .cmd, .exe, .ps1 (CreateProcess needs one)."""
    if os.name != "nt":
        return [cli_command]
    names = [cli_command]
    for suffix in (".cmd", ".exe", ".ps1", ".bat"):
        names.append(f"{cli_command}{suffix}")
    return names


def _candidate_paths(cli_command: str) -> list[Path]:
    """Documented per-user install locations for the known agent CLIs."""
    home = Path.home()
    appdata = os.environ.get("LOCALAPPDATA", "")
    appdata_roaming = os.environ.get("APPDATA", "")
    npm = Path(appdata_roaming) / "npm" if appdata_roaming else None

    def npm_shims(name: str) -> list[Path]:
        if npm is None:
            return []
        return [npm / shim for shim in _windows_shim_names(name)]

    def bin_shims(root: Path, name: str) -> list[Path]:
        if os.name == "nt":
            return [root / shim for shim in _windows_shim_names(name)]
        return [root / name]

    candidates: dict[str, list[Path]] = {
        "claude": bin_shims(home / ".local" / "bin", "claude"),
        "codex": [
            *npm_shims("codex"),
            *bin_shims(home / ".codex" / "bin", "codex"),
        ],
        "gemini": npm_shims("gemini"),
        "grok": bin_shims(home / ".grok" / "bin", "grok"),
        "kimi": bin_shims(home / ".kimi" / "bin", "kimi"),
        "opencode": [
            *(bin_shims(Path(appdata) / "opencode" / "bin", "opencode") if appdata else []),
            *bin_shims(home / ".opencode" / "bin", "opencode"),
        ],
        "mimo": npm_shims("mimo"),
    }
    return list(candidates.get(cli_command, []))


def find_cli_fallback(cli_command: str) -> str | None:
    """Absolute path to the CLI from its documented install location, or None."""
    for candidate in _candidate_paths(cli_command):
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def resolve_cli_command(cli_command: str) -> str | None:
    """Resolve a CLI name to something ``CreateProcess`` / exec can launch.

    On Windows, bare names like ``codex`` often only exist as ``codex.cmd``
    npm shims. ``asyncio.create_subprocess_exec('codex', …)`` does not apply
    ``PATHEXT``, so detection and consult both fail unless we resolve first.
    """
    name = str(cli_command or "").strip()
    if not name:
        return None
    # Absolute / relative path the caller already resolved.
    path = Path(name)
    if path.is_file():
        return str(path)
    import shutil

    found = shutil.which(name)
    if found:
        return found
    return find_cli_fallback(name)


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
