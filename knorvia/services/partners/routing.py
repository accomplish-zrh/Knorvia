"""Per-partner inference router — grok-bot parity.

grok-bot 0.18 routes each agent's turns to one of several inference backends
(Cursor / Claude Code / Codex / OpenRouter) from a Router setting, keeps the
per-agent transcript coherent across backends, surfaces router failures as
transcript messages, and serialises turns per agent. Knorvia partners mirror
that: a partner's ``routing`` config picks who answers its turns —

* ``{"backend": "llm"}`` (default) — the product chat pipeline with the
  partner's ``llm_selection`` (unchanged behaviour);
* ``{"backend": "cli", "kind": "claude_code" | "codex" | "gemini" | …,
  "connection": "<subagent connection KB name>"}`` — the turn is driven
  through the matching local agent CLI via the subagent backend registry,
  with the partner's Soul injected as the CLI system prompt and session
  continuity kept per (partner, channel session, backend).

Router failures never strand a chat: the runner falls back to the LLM path
and the error is reported in-band. The turn is emitted as the same
StreamEvent shapes the product chat pipeline produces, so the runner's
existing handling — IM stream deltas, tool hints, trace capture, RESULT
extraction — works unchanged over a routed turn.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
from typing import Any, AsyncIterator

from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.services.subagent.types import (
    EVENT_ERROR,
    EVENT_TEXT,
    EVENT_TOOL,
    SubagentEvent,
)

logger = logging.getLogger(__name__)

ROUTING_BACKEND_LLM = "llm"
ROUTING_BACKEND_CLI = "cli"

#: Keep web-chat rehydration sane: cap the CLI's log/noise events we persist.
_MAX_LOG_EVENTS = 80


@dataclass
class RoutedTurnMeta:
    """Bookkeeping a routed turn reports back to the runner."""

    backend: str = ROUTING_BACKEND_LLM
    kind: str = ""
    connection: str = ""
    session_id: str = ""
    errors: list[str] = field(default_factory=list)


def _cli_kinds() -> set[str]:
    """Kinds the router may drive (local agent CLIs; not the partner backend)."""
    try:
        from knorvia.services.subagent import (
            PARTNER_BACKEND_KIND,
            get_backend,
            list_backend_kinds,
        )

        return {
            kind
            for kind in list_backend_kinds()
            if kind != PARTNER_BACKEND_KIND and getattr(get_backend(kind), "local_cli", True)
        }
    except Exception:  # noqa: BLE001 - registry is optional at import time
        return set()


def sanitize_routing(value: Any) -> dict[str, str]:
    """Coerce an arbitrary payload into the stored routing shape.

    Unknown shapes degrade to the default LLM backend; a ``cli`` routing with
    an unknown kind degrades too — a partner must never silently lose its
    backend after a registry change, it must visibly fall back to the LLM.
    """
    default = {"backend": ROUTING_BACKEND_LLM, "kind": "", "connection": ""}
    if not isinstance(value, dict):
        return default
    backend = str(value.get("backend") or ROUTING_BACKEND_LLM).strip().lower()
    if backend != ROUTING_BACKEND_CLI:
        return default
    kind = str(value.get("kind") or "").strip()
    connection = str(value.get("connection") or "").strip()
    if kind not in _cli_kinds():
        return default
    return {"backend": ROUTING_BACKEND_CLI, "kind": kind, "connection": connection}


def is_cli_routing(routing: Any) -> bool:
    return isinstance(routing, dict) and (str(routing.get("backend") or "") == ROUTING_BACKEND_CLI)


def routing_label(routing: Any) -> str:
    """Human name for /status and the UI (e.g. ``cli:claude_code``)."""
    safe = sanitize_routing(routing)
    if safe["backend"] == ROUTING_BACKEND_CLI:
        return f"cli:{safe['kind']}"
    return "llm"


async def router_backend_status() -> list[dict[str, Any]]:
    """Detection snapshot for the Router UI (grok-bot's provider table)."""
    try:
        from knorvia.services.subagent import detect_all

        detections = await detect_all()
    except Exception:  # noqa: BLE001 - best-effort probe
        return []
    return [detection.to_dict() for detection in detections]


def _connection_cwd(connection: str, kind: str) -> str:
    """The cwd recorded on the named subagent connection KB (empty if unset)."""
    if not connection:
        return ""
    try:
        from knorvia.knowledge.kb_types import SUBAGENT_KB_TYPE
        from knorvia.multi_user.knowledge_access import admin_kb_manager

        meta = admin_kb_manager().get_metadata(connection)
    except Exception:  # noqa: BLE001 - resolved lazily at turn time
        return ""
    if not isinstance(meta, dict) or meta.get("type") != SUBAGENT_KB_TYPE:
        return ""
    if str(meta.get("agent_kind") or "") != kind:
        return ""
    return str(meta.get("cwd") or "")


def _system_prompt(partner_name: str, description: str, soul: str, channel: str) -> str:
    """The partner persona injected into the routed CLI (grok-bot parity).

    The CLI keeps its own tools and harness; this prompt tells it WHO it is on
    this channel — the Soul does the character work, the wrapper adds the
    messaging-surface rules.
    """
    parts = [
        f"You are '{partner_name}', a persistent agent answering over the "
        f"'{channel}' messaging surface. You keep memory of this conversation "
        "across turns; each new user message continues it.",
        "Answer in the user's language. Be direct and self-contained: your "
        "reply is delivered as chat messages, so do not ask clarifying "
        "questions you can resolve yourself and never address a 'user above "
        "you' — the chat user IS your counterpart.",
    ]
    if description.strip():
        parts.append(f"Role: {description.strip()}")
    if soul.strip():
        parts.append(f"Your soul (personality and standing orders):\n{soul.strip()}")
    return "\n\n".join(parts)


def _registry_key(partner_id: str, session_key: str, connection: str, kind: str) -> str:
    """Subagent-session continuity key: one live CLI session per triple."""
    from knorvia.services.subagent.sessions import session_key as registry_key

    return registry_key(f"partner:{partner_id}:{session_key}", f"{connection or '-'}::{kind}")


def _clone_config_with_prompt(config: Any, system_prompt: str) -> Any:
    clone = type(config)()
    for field_name in getattr(config, "__dataclass_fields__", {}):
        setattr(clone, field_name, getattr(config, field_name))
    clone.system_prompt = system_prompt
    return clone


def _map_subagent_event(event: SubagentEvent, call_id: str) -> StreamEvent | None:
    """SubagentEvent → the StreamEvent the runner already understands."""
    text = str(event.text or "")
    if not text:
        return None
    if event.kind == EVENT_TEXT:
        return StreamEvent(
            type=StreamEventType.CONTENT,
            source="chat",
            content=text,
            metadata={"call_id": call_id, "trace_kind": "routed_delta"},
        )
    if event.kind == EVENT_TOOL:
        return StreamEvent(
            type=StreamEventType.TOOL_CALL,
            source="chat",
            content=text,
            metadata={"call_id": call_id, "args": {}},
        )
    if event.kind == EVENT_ERROR:
        return StreamEvent(
            type=StreamEventType.ERROR,
            source="cli",
            content=text,
            metadata={"call_id": call_id},
        )
    # reasoning / tool_result / log: trace-only progress. The runner publishes
    # neither (its PROGRESS handler only freezes narration rounds) but captures
    # them into the persisted turn trace for web rehydration.
    return StreamEvent(
        type=StreamEventType.PROGRESS,
        source="cli",
        stage="routed",
        content=text,
        metadata={"call_id": call_id, "trace_kind": "cli_log", "subagent_kind": event.kind},
    )


async def execute_routed_turn(
    *,
    partner_id: str,
    partner_name: str,
    description: str,
    soul: str,
    channel: str,
    session_key: str,
    user_message: str,
    media: list[str] | None = None,
    routing: dict[str, str] | None = None,
    meta: RoutedTurnMeta,
) -> AsyncIterator[StreamEvent]:
    """Run one partner turn through the routed CLI backend, as StreamEvents.

    *meta* is mutated in place with the backend actually used, the CLI session
    id, and any router errors, so the runner can log usage and decide the
    LLM fallback.
    """
    from knorvia.services.subagent.types import EVENT_ERROR as _E

    safe = sanitize_routing(routing)
    kind = safe["kind"]
    connection = safe["connection"]
    meta.backend = ROUTING_BACKEND_CLI
    meta.kind = kind
    meta.connection = connection

    call_id = "routed"
    log_emitted = 0
    accumulated: list[str] = []
    outcome: dict[str, Any] = {}

    try:
        backend = get_backend_or_none(kind)
        if backend is None:
            raise RuntimeError(f"Unknown routing backend: {kind!r}")

        from knorvia.services.subagent.config import load_subagent_settings
        from knorvia.services.subagent.process import (
            default_subagent_cwd,
            validate_subagent_cwd,
        )
        from knorvia.services.subagent.sessions import get_session, remember_session

        settings = load_subagent_settings()
        backend_config = settings.backend(kind)
        if not backend_config.enabled:
            raise RuntimeError(f"Routing backend {kind!r} is disabled in subagent settings.")
        backend_config = _clone_config_with_prompt(
            backend_config,
            _system_prompt(partner_name, description, soul, channel),
        )

        cwd = validate_subagent_cwd(_connection_cwd(connection, kind) or default_subagent_cwd())
        registry_key = _registry_key(partner_id, session_key, connection, kind)
        prior_session = get_session(registry_key)

        # Image attachments ride along only when the backend opts in — same
        # rule as the chat consult tool.
        image_paths = [str(path) for path in media or [] if path]
        if image_paths and not backend_config.forward_images:
            image_paths = []

        queue: asyncio.Queue[StreamEvent] = asyncio.Queue()

        async def on_event(event: SubagentEvent) -> None:
            nonlocal log_emitted
            if event.kind not in (EVENT_TEXT, EVENT_TOOL, _E) and not str(event.text or "").strip():
                return
            if event.kind not in (EVENT_TEXT, EVENT_TOOL, _E):
                log_emitted += 1
                if log_emitted > _MAX_LOG_EVENTS:
                    return
            mapped = _map_subagent_event(event, call_id)
            if mapped is not None:
                queue.put_nowait(mapped)

        async def _run() -> None:
            try:
                outcome["result"] = await backend.consult(
                    user_message,
                    on_event=on_event,
                    cwd=cwd,
                    session_id=prior_session,
                    config=backend_config,
                    images=image_paths or None,
                )
            except Exception as exc:  # noqa: BLE001 - surfaced as a router error
                outcome["error"] = exc
            finally:
                queue.put_nowait(_SENTINEL)

        task = asyncio.create_task(_run())
        try:
            while True:
                event = await queue.get()
                if event is _SENTINEL:
                    break
                if event.type == StreamEventType.CONTENT:
                    accumulated.append(event.content or "")
                yield event

            error: Exception | None = outcome.get("error")
            if error is not None:
                raise error
            result = outcome.get("result")
            if result is None:
                raise RuntimeError(f"Routing backend {kind!r} returned no result.")

            if getattr(result, "session_id", ""):
                meta.session_id = str(result.session_id)
                remember_session(registry_key, meta.session_id, kind=kind, cwd=cwd)
            if not getattr(result, "success", True):
                meta.errors.append(str(getattr(result, "error", "") or "backend reported failure"))

            final_text = (str(getattr(result, "final_text", "") or "") or "").strip() or (
                "".join(accumulated).strip()
            )
            if not final_text:
                raise RuntimeError(f"Routing backend {kind!r} returned no answer.")

            yield StreamEvent(
                type=StreamEventType.RESULT,
                source="chat",
                metadata={
                    "response": final_text,
                    "completed": True,
                    "engine": f"routed:{kind}",
                    "call_id": call_id,
                },
            )
        finally:
            if not task.done():
                task.cancel()
    except Exception as exc:
        meta.errors.append(f"{type(exc).__name__}: {exc}")
        logger.warning(
            "Partner %s routed turn via %s failed: %s", partner_id, kind, exc, exc_info=True
        )
        yield StreamEvent(
            type=StreamEventType.ERROR,
            source="router",
            content=str(exc),
            metadata={"call_id": call_id, "turn_terminal": True, "status": "failed"},
        )


def get_backend_or_none(kind: str):
    from knorvia.services.subagent import get_backend

    return get_backend(kind)


_SENTINEL = object()

__all__ = [
    "ROUTING_BACKEND_LLM",
    "ROUTING_BACKEND_CLI",
    "RoutedTurnMeta",
    "sanitize_routing",
    "is_cli_routing",
    "routing_label",
    "router_backend_status",
    "execute_routed_turn",
]
