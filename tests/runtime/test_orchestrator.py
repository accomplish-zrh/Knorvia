"""Tests for ChatOrchestrator routing and lifecycle."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.core.stream_bus import StreamBus
from knorvia.runtime.orchestrator import ChatOrchestrator


@pytest.fixture(autouse=True)
def _patch_event_bus():
    """Prevent EventBus background processor from running during tests."""
    mock_bus = MagicMock()
    mock_bus.publish = AsyncMock()
    with patch("knorvia.runtime.orchestrator.get_event_bus", return_value=mock_bus):
        yield
    from knorvia.events.event_bus import EventBus

    EventBus.reset()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _EchoCapability(BaseCapability):
    """Minimal capability that echoes the user message."""

    manifest = CapabilityManifest(
        name="echo",
        description="Echoes back user message.",
        stages=["responding"],
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        await stream.content(context.user_message, source=self.name)


class _FailingCapability(BaseCapability):
    """Capability that raises."""

    manifest = CapabilityManifest(name="fail", description="Always fails.")

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        raise RuntimeError("intentional failure")


class _SlowCapability(BaseCapability):
    """Streams slowly and honours cancellation."""

    manifest = CapabilityManifest(name="slow", description="Slow streamer.")

    def __init__(self) -> None:
        self.cancelled = False

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        try:
            for _ in range(1000):
                await stream.content("tick", source=self.name)
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class _StubbornCapability(BaseCapability):
    """Swallows cancellation and keeps working until released."""

    manifest = CapabilityManifest(name="stubborn", description="Refuses cancellation.")

    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        release = self.release
        try:
            await release.wait()
        except asyncio.CancelledError:
            # Deliberately swallow the cancel and keep working.
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass


def _make_orchestrator(
    capabilities: dict[str, BaseCapability] | None = None,
) -> ChatOrchestrator:
    """Build an orchestrator with fake registries."""
    cap_reg = MagicMock()
    cap_map = capabilities or {}
    cap_reg.get = lambda name: cap_map.get(name)
    cap_reg.list_capabilities = lambda: list(cap_map.keys())

    tool_reg = MagicMock()
    tool_reg.list_tools = MagicMock(return_value=[])
    tool_reg.build_openai_schemas = MagicMock(return_value=[])

    orch = ChatOrchestrator.__new__(ChatOrchestrator)
    orch._cap_registry = cap_reg
    orch._tool_registry = tool_reg
    return orch


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


class TestOrchestratorRouting:
    @pytest.mark.asyncio
    async def test_routes_to_active_capability(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(
            user_message="ping",
            active_capability="echo",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        types = [e.type for e in events]
        assert StreamEventType.SESSION in types
        assert StreamEventType.CONTENT in types
        assert StreamEventType.DONE in types

        content_events = [e for e in events if e.type == StreamEventType.CONTENT]
        assert content_events[0].content == "ping"

    @pytest.mark.asyncio
    async def test_defaults_to_chat_capability(self) -> None:
        chat_cap = _EchoCapability()
        chat_cap.manifest = CapabilityManifest(
            name="chat", description="Default chat.", stages=["responding"]
        )
        orch = _make_orchestrator({"chat": chat_cap})

        ctx = UnifiedContext(user_message="hello")
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        content_events = [e for e in events if e.type == StreamEventType.CONTENT]
        assert len(content_events) == 1
        assert content_events[0].content == "hello"

    @pytest.mark.asyncio
    async def test_unknown_capability_yields_error(self) -> None:
        orch = _make_orchestrator({})

        ctx = UnifiedContext(
            user_message="hi",
            active_capability="nonexistent",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        error_events = [e for e in events if e.type == StreamEventType.ERROR]
        assert len(error_events) == 1
        assert "Unknown capability" in error_events[0].content
        assert error_events[0].metadata == {
            "turn_terminal": True,
            "status": "failed",
        }
        done_events = [e for e in events if e.type == StreamEventType.DONE]
        assert len(done_events) == 1
        assert done_events[0].metadata["status"] == "failed"


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestOrchestratorErrorHandling:
    @pytest.mark.asyncio
    async def test_capability_exception_yields_error_event(self) -> None:
        fail_cap = _FailingCapability()
        orch = _make_orchestrator({"fail": fail_cap})

        ctx = UnifiedContext(
            user_message="boom",
            active_capability="fail",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        error_events = [e for e in events if e.type == StreamEventType.ERROR]
        assert len(error_events) == 1
        assert "intentional failure" in error_events[0].content
        assert error_events[0].metadata == {
            "turn_terminal": True,
            "status": "failed",
        }

        done_events = [e for e in events if e.type == StreamEventType.DONE]
        assert len(done_events) == 1
        assert done_events[0].metadata["status"] == "failed"


# ---------------------------------------------------------------------------
# Session ID management
# ---------------------------------------------------------------------------


class TestOrchestratorSessionId:
    @pytest.mark.asyncio
    async def test_assigns_session_id_if_missing(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(user_message="test", active_capability="echo")
        assert ctx.session_id == ""

        async for _ in orch.handle(ctx):
            pass

        assert ctx.session_id != ""

    @pytest.mark.asyncio
    async def test_preserves_existing_session_id(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(
            session_id="my-session",
            user_message="test",
            active_capability="echo",
        )
        async for _ in orch.handle(ctx):
            pass

        assert ctx.session_id == "my-session"


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


class TestOrchestratorCancellation:
    @pytest.mark.asyncio
    async def test_closing_the_stream_cancels_the_capability(self) -> None:
        """cancel_turn closes the consumer stream; the capability task must
        receive CancelledError instead of running on as an orphan."""
        cap = _SlowCapability()
        orch = _make_orchestrator({"slow": cap})

        ctx = UnifiedContext(user_message="hi", active_capability="slow")
        gen = orch.handle(ctx)
        await gen.__anext__()  # SESSION event
        await gen.__anext__()  # first CONTENT event — capability is running

        await gen.aclose()

        assert cap.cancelled, "the capability task was left running after aclose()"

    @pytest.mark.asyncio
    async def test_a_cancel_resistant_capability_does_not_hang_the_caller(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A capability that swallows CancelledError must not block the caller:
        the orchestrator's grace wait is hard-bounded (asyncio.wait, not
        wait_for, which would await the stubborn task indefinitely)."""
        monkeypatch.setattr("knorvia.runtime.orchestrator._CANCEL_GRACE_S", 0.2)
        cap = _StubbornCapability()
        orch = _make_orchestrator({"stubborn": cap})

        ctx = UnifiedContext(user_message="hi", active_capability="stubborn")
        gen = orch.handle(ctx)
        await gen.__anext__()  # SESSION event

        start = time.monotonic()
        await gen.aclose()
        elapsed = time.monotonic() - start

        assert elapsed < 2.0, f"aclose() hung on a cancel-resistant capability ({elapsed:.2f}s)"

        # Let the deliberately-detached task finish so the loop can close cleanly.
        cap.release.set()
        await asyncio.sleep(0.05)


# ---------------------------------------------------------------------------
# List helpers
# ---------------------------------------------------------------------------


class TestOrchestratorHelpers:
    def test_list_tools(self) -> None:
        orch = _make_orchestrator()
        assert orch.list_tools() == []

    def test_list_capabilities(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})
        assert orch.list_capabilities() == ["echo"]

    def test_get_tool_schemas(self) -> None:
        orch = _make_orchestrator()
        schemas = orch.get_tool_schemas()
        assert isinstance(schemas, list)
