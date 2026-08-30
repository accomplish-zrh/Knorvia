"""Offline file-conversion engines for the library (flyingmouse-inspired).

Resolution chain per engine (the flyingmouse-format idea, original code):
``KNORVIA_<NAME>_PATH`` env → the managed ``data/engines/<name>`` folder →
system ``PATH``. Everything degrades gracefully: an unavailable engine only
removes conversion targets, it never breaks the library.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

_ENGINES: dict[str, str] = {
    "ffmpeg": "KNORVIA_FFMPEG_PATH",
    "soffice": "KNORVIA_SOFFICE_PATH",
    "pdftoppm": "KNORVIA_PDFTOPPM_PATH",
    "tesseract": "KNORVIA_TESSERACT_PATH",
}

_PROBE_TIMEOUT_S = 10


def _managed_dir(engine: str) -> Path:
    """The managed engine folder (Real-ESRGAN download-on-demand pattern)."""
    from knorvia.multi_user.paths import get_admin_path_service

    return get_admin_path_service().workspace_root / "engines" / engine


def resolve_engine(engine: str) -> str | None:
    """Absolute path to the engine executable, or None when unavailable."""
    env_name = _ENGINES.get(engine)
    if env_name:
        override = os.environ.get(env_name, "").strip()
        if override and Path(override).exists():
            return override
    managed = _managed_dir(engine)
    if managed.is_dir():
        for candidate in sorted(managed.rglob(f"{engine}.exe")) + sorted(managed.rglob(engine)):
            if candidate.is_file():
                return str(candidate)
    found = shutil.which(engine)
    return str(found) if found else None


def capabilities() -> dict[str, Any]:
    """Probe every engine once per call (cheap, used by the UI targets view)."""
    result: dict[str, Any] = {}
    for engine in _ENGINES:
        path = resolve_engine(engine)
        version = ""
        if path and engine == "ffmpeg":
            try:
                probe = subprocess.run(
                    [path, "-version"],
                    capture_output=True,
                    text=True,
                    timeout=_PROBE_TIMEOUT_S,
                )
                first = (probe.stdout or "").splitlines()
                version = first[0].strip()[:80] if first else ""
            except (OSError, subprocess.TimeoutExpired):
                version = ""
        result[engine] = {"available": bool(path), "path": path or "", "version": version}
    return result


def ffmpeg_available() -> bool:
    return resolve_engine("ffmpeg") is not None


__all__ = ["capabilities", "ffmpeg_available", "resolve_engine"]
