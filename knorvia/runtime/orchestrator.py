"""
Chat Orchestrator
=================

Unified entry point that routes user messages to the appropriate capability.
All consumers (CLI, WebSocket, SDK) call the orchestrator.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator
import uuid

from knorvia.core.context import UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.core.stream_bus import StreamBus, register_bus, unregister_bus
from knorvia.events.event_bus import Event, EventType, get_event_bus
from knorvia.runtime.registry.capability_registry import get_capability_registry
from knorvia.runtime.registry.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)

#: How long the orchestrator waits for a capability to honour cancellation
#: before giving up and returning control to the cancelling caller.
_CANCEL_GRACE_S = 5.0


class ChatOrchestrator:
    """
    Routes a ``UnifiedContext`` to the correct capability, manages
    the ``StreamBus`` lifecycle, and publishes completion events.
    """

    def __init__(self) -> None:
        self._cap_registry = get_capability_registry()
        self._tool_registry = get_tool_registry()

    async def handle(self, context: UnifiedContext) -> AsyncIterator[StreamEvent]:
        """
        Execute a single user turn and yield streaming events.

        If ``context.active_capability`` is set, the corresponding capability
        handles the turn. Otherwise, the default ``chat`` capability is used.
        """
        if not context.session_id:
            context.session_id = str(uuid.uuid4())

        cap_name = context.active_capability or "chat"
        capability = self._cap_registry.get(cap_name)

        if capability is None:
            bus = StreamBus()
            await bus.error(
                f"Unknown capability: {cap_name}. "
                f"Available: {self._cap_registry.list_capabilities()}",
                source="orchestrator",
                metadata={"turn_terminal": True, "status": "failed"},
            )
            await bus.emit(
                StreamEvent(
                    type=StreamEventType.DONE,
                    source="orchestrator",
                    metadata={"status": "failed"},
                )
            )
            await bus.close()
            async for event in bus.subscribe():
                yield event
            return

        yield StreamEvent(
            type=StreamEventType.SESSION,
            source="orchestrator",
            metadata={
                "session_id": context.session_id,
                "turn_id": str(context.metadata.get("turn_id", "")),
            },
        )

        bus = StreamBus()
        _turn_id = str(context.metadata.get("turn_id") or "")
        if _turn_id:
            register_bus(_turn_id, bus)

        async def _run() -> None:
            status = "completed"
            try:
                await capability.run(context, bus)
            except asyncio.CancelledError:
                # Cancellation is expected when the consumer disconnects: record
                # it so the terminal DONE event (still emitted below) carries the
                # right status for any late subscriber, then re-raise.
                status = "cancelled"
                raise
            except Exception as exc:
                status = "failed"
                logger.error("Capability %s failed: %s", cap_name, exc, exc_info=True)
                await bus.error(
                    str(exc),
                    source=cap_name,
                    metadata={"turn_terminal": True, "status": status},
                )
            finally:
                await bus.emit(
                    StreamEvent(
                        type=StreamEventType.DONE,
                        source=cap_name,
                        metadata={"status": status},
                    )
                )
                await bus.close()
                if _turn_id:
                    unregister_bus(_turn_id)

        stream = bus.subscribe()
        task = asyncio.create_task(_run())

        try:
            async for event in stream:
                yield event
        finally:
            # When the consumer stops iterating (cancel_turn / disconnect), the
            # async-generator is closed here with GeneratorExit and the line
            # below is never reached — without an explicit cancel the capability
            # keeps running as an orphan: LLM calls and tool side effects
            # continue, and its events pile up in the bus history. Cancel the
            # task so cancellation actually propagates into the capability.
            # `asyncio.wait` (not `wait_for`) bounds the wait hard: wait_for
            # cancels and then *awaits* the task, so a capability that swallows
            # CancelledError would hold the canceller indefinitely. If the
            # capability still resists, we log it and return — it runs
            # detached, same as before this guard, but the caller is never
            # blocked by it.
            if not task.done():
                task.cancel()
                _done, pending = await asyncio.wait({task}, timeout=_CANCEL_GRACE_S)
                if pending:
                    logger.warning(
                        "Capability %s ignored cancellation within %ss; "
                        "leaving it detached (orphan turn)",
                        cap_name,
                        _CANCEL_GRACE_S,
                    )

        await self._publish_completion(context, cap_name)

    async def _publish_completion(self, context: UnifiedContext, cap_name: str) -> None:
        """Publish CAPABILITY_COMPLETE to the global EventBus."""
        try:
            bus = get_event_bus()
            await bus.publish(
                Event(
                    type=EventType.CAPABILITY_COMPLETE,
                    task_id=str(context.metadata.get("turn_id") or context.session_id),
                    user_input=context.user_message,
                    agent_output="",
                    metadata={
                        "capability": cap_name,
                        "session_id": context.session_id,
                        "turn_id": str(context.metadata.get("turn_id", "")),
                    },
                )
            )
        except Exception:
            logger.debug("EventBus publish failed (may not be running)", exc_info=True)

    def list_tools(self) -> list[str]:
        return self._tool_registry.list_tools()

    def list_capabilities(self) -> list[str]:
        return self._cap_registry.list_capabilities()

    def get_capability_manifests(self) -> list[dict[str, Any]]:
        return self._cap_registry.get_manifests()

    def get_tool_schemas(self, names: list[str] | None = None) -> list[dict[str, Any]]:
        return self._tool_registry.build_openai_schemas(names)
