"""Mastery Path capability — mastery-based tutoring on the Knorvia Kernel.

There is no bespoke state machine here anymore. The Kernel agent loop IS the
tutor: this capability only marks the turn as mastery mode, resolves the
active path id, and streams the turn through ``knorvia-daemon``. The mastery
tools (``mastery_status`` / ``mastery_quiz`` / ``mastery_grade`` /
``mastery_assess`` / ``mastery_build``) move to the learning pack with the
pack migration; the pure engine in :mod:`knorvia.learning` owns the hard,
per-type mastery gate and the spaced-repetition arithmetic.

Design axiom (shared with chat): the intelligence lives at the loop's exit —
the model decides what to teach and how to question — while the gate that
decides *whether the learner may advance* is a deterministic engine call.
"""

from __future__ import annotations

import re

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext

_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]")


def _sanitize_path_id(raw: str) -> str:
    """Make *raw* a safe storage key (matches ``LearningStore`` path guard)."""
    cleaned = _UNSAFE_ID_CHARS.sub("_", raw).strip("_")
    return cleaned or "default"


def resolve_mastery_path_id(context: UnifiedContext) -> str:
    """Resolve which learner-path the turn operates on.

    Prefers an explicit ``mastery_path_id`` set by the frontend (so the tutor
    and the build wizard / dashboard agree on one storage key), then a book
    reference, then the session id for an ad-hoc path built inside a chat.
    """
    explicit = str(context.metadata.get("mastery_path_id") or "").strip()
    if explicit:
        return _sanitize_path_id(explicit)
    refs = (context.metadata or {}).get("book_references", [])
    if refs:
        ref = refs[0]
        if isinstance(ref, str) and ref.strip():
            return _sanitize_path_id(ref)
        if isinstance(ref, dict):
            candidate = str(ref.get("book_id") or ref.get("id") or "").strip()
            if candidate:
                return _sanitize_path_id(candidate)
    return _sanitize_path_id(str(context.session_id or "default"))


class MasteryPathCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="mastery_path",
        description=(
            "Mastery-based tutoring: the Kernel agent loop drives an adaptive "
            "mastery path with a hard, per-type mastery gate and spaced review."
        ),
        stages=["responding"],
        tools_used=["rag", "read_source", "ask_user"],
        cli_aliases=["mastery"],
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        # Lazy import: tests patch the daemon stream at its home module.
        from knorvia.runtime.kernel_client import stream_as_stream_events

        context.metadata["mastery_mode"] = True
        context.metadata["mastery_path_id"] = resolve_mastery_path_id(context)
        emit = getattr(stream, "emit", None)
        async for event in stream_as_stream_events(str(context.user_message or "")):
            if callable(emit):
                await emit(event)


__all__ = ["MasteryPathCapability", "resolve_mastery_path_id"]
