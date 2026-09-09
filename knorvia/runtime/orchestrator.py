"""Removed production Agent Runtime.

``ChatOrchestrator`` is gone. Thread/Turn/Item belong to ``knorvia-daemon``.
Python callers must use :mod:`knorvia.runtime.kernel_client`.
"""

from __future__ import annotations

from knorvia.runtime.kernel_client import (
    DaemonSession,
    start_turn_async,
    start_turn_sync,
    stream_legacy_events,
)

__all__ = [
    "DaemonSession",
    "start_turn_async",
    "start_turn_sync",
    "stream_legacy_events",
]


def __getattr__(name: str):
    if name == "ChatOrchestrator":
        raise ImportError(
            "ChatOrchestrator was removed from the production path. "
            "Use knorvia.runtime.kernel_client / knorvia-daemon."
        )
    raise AttributeError(name)
