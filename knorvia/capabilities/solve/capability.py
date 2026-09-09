"""Deep Solve capability — problem solving on the Knorvia Kernel.

There is no bespoke pipeline. The Kernel agent loop IS the solver: this
capability marks the turn as solve mode (metadata retained for the future
Kernel-side solve-tool pack), resolves a session id, and streams the turn
through ``knorvia-daemon``. The solve loop capability
(:class:`knorvia.capabilities.solve.loop.SolveLoopCapability`) remains the
home of the solver playbook + session state for the pack migration.

Design axiom (shared with chat / mastery): the intelligence lives at the
loop's exit — the model plans and solves — while the deterministic spine
(commit to a plan, don't skip steps, bounded replan) is engine state owned by
the Kernel turn, not by a Python loop.
"""

from __future__ import annotations

import logging
import re

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import get_capability_request_schema
from knorvia.services.config.capabilities_settings import get_solve_params

logger = logging.getLogger(__name__)

_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]")


def _sanitize(raw: str) -> str:
    cleaned = _UNSAFE_ID_CHARS.sub("_", raw).strip("_")
    return cleaned or "default"


def resolve_solve_session_id(context: UnifiedContext) -> str:
    """Resolve the in-memory session key for this solve turn.

    A solve turn is one-shot, so the turn id (falling back to the session /
    message id) is enough to scope the plan + replan budget; concurrent turns
    get distinct keys and never race.
    """
    raw = str(
        context.metadata.get("turn_id")
        or context.session_id
        or context.metadata.get("message_id")
        or "default"
    )
    return _sanitize(raw)


class DeepSolveCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_solve",
        description="Multi-step problem solving on the Knorvia Kernel.",
        stages=["responding"],
        tools_used=["rag", "code_execution", "geogebra_analysis", "reason"],
        cli_aliases=["solve"],
        request_schema=get_capability_request_schema("deep_solve"),
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        # Lazy import: tests monkeypatch the daemon stream at its home module.
        from knorvia.runtime.kernel_client import stream_as_stream_events

        context.metadata["solve_mode"] = True
        context.metadata["solve_session_id"] = resolve_solve_session_id(context)
        try:
            params = get_solve_params()
        except Exception as exc:  # pragma: no cover - defensive config read
            logger.warning("Failed to load solve params, using defaults: %s", exc)
            params = {}
        # Solve tuning params ride the turn metadata for the Kernel-side
        # solve-tool pack; the turn itself runs on the daemon now.
        context.metadata["solve_max_replans"] = int(params.get("max_replans", 2))
        emit = getattr(stream, "emit", None)
        async for event in stream_as_stream_events(str(context.user_message or "")):
            if callable(emit):
                await emit(event)


__all__ = ["DeepSolveCapability", "resolve_solve_session_id"]
