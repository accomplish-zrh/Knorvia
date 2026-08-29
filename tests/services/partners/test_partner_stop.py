"""Partner /stop: real turn cancellation (grok-bot activity parity)."""

from __future__ import annotations

import asyncio

import pytest

from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.partners.bus.events import InboundMessage
from knorvia.partners.bus.queue import MessageBus
from knorvia.services.partners.commands import PartnerCommandHandler
from knorvia.services.partners.manager import PartnerConfig
from knorvia.services.partners.runtime import PartnerRunner
from knorvia.services.partners.sessions import PartnerSessionStore


def _msg(content: str = "hello", channel: str = "telegram") -> InboundMessage:
    return InboundMessage(channel=channel, sender_id="42", chat_id="42", content=content)


class _SlowOrchestrator:
    """A turn that hangs until cancelled, then reports it was interrupted."""

    finished_cleanly = True

    def __init__(self) -> None:
        pass

    async def handle(self, context):
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            type(self).finished_cleanly = False
            raise
        yield StreamEvent(
            type=StreamEventType.RESULT,
            source="chat",
            metadata={"response": "too late"},
        )
        yield StreamEvent(type=StreamEventType.DONE)


@pytest.fixture
def slow_orchestrator(monkeypatch):
    import knorvia.runtime.orchestrator as orch_mod
    from knorvia.services.model_selection import runtime as selection_runtime

    _SlowOrchestrator.finished_cleanly = True
    monkeypatch.setattr(orch_mod, "ChatOrchestrator", _SlowOrchestrator)
    monkeypatch.setattr(selection_runtime, "activate_llm_selection", lambda selection: (None, None))
    monkeypatch.setattr(selection_runtime, "reset_llm_selection", lambda token: None)
    return _SlowOrchestrator


def _runner(partners_root) -> PartnerRunner:
    from knorvia.partners.config.paths import get_partner_sessions_dir

    bus = MessageBus()
    store = PartnerSessionStore(get_partner_sessions_dir("ada"))
    return PartnerRunner("ada", PartnerConfig(name="Ada"), bus, store)


class TestStop:
    def test_is_stop_command(self):
        assert PartnerCommandHandler.is_stop_command("/stop")
        assert PartnerCommandHandler.is_stop_command("  /STOP ")
        assert PartnerCommandHandler.is_stop_command("/stop@Ada")
        assert PartnerCommandHandler.is_stop_command("/stop extra")
        assert not PartnerCommandHandler.is_stop_command("/stops")
        assert not PartnerCommandHandler.is_stop_command("stop")

    @pytest.mark.asyncio
    async def test_stop_cancels_the_in_flight_turn(self, partners_root, slow_orchestrator):
        runner = _runner(partners_root)

        async def _turn():
            return await runner.process_message(_msg("write me a novel"))

        turn_task = asyncio.create_task(_turn())
        await asyncio.sleep(0.05)  # let the turn acquire the lock and start

        assert runner.cancel_turn("telegram:42") is True
        result = await asyncio.wait_for(runner.process_message(_msg("/stop")), timeout=2.0)
        assert "Stopped" in result
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(turn_task, timeout=2.0)
        assert slow_orchestrator.finished_cleanly is False

        # The user message was kept; no half answer was persisted.
        records = runner.store.messages("telegram:42")
        assert [r["role"] for r in records] == ["user"]

        # A second stop has nothing to cancel.
        result = await runner.process_message(_msg("/stop"))
        assert "nothing" in result

    @pytest.mark.asyncio
    async def test_typing_brackets_the_turn(self, partners_root, slow_orchestrator, monkeypatch):
        typing_log: list[tuple[str, bool]] = []
        from knorvia.partners.config.paths import get_partner_sessions_dir

        bus = MessageBus()
        store = PartnerSessionStore(get_partner_sessions_dir("ada"))
        runner = PartnerRunner(
            "ada",
            PartnerConfig(name="Ada"),
            bus,
            store,
            set_typing_hook=lambda channel, chat_id, active: (
                typing_log.append((chat_id, bool(active))) or asyncio.sleep(0)
            ),
        )
        monkeypatch.setattr(runner, "_run_turn", _hang_then_reply)
        task = asyncio.create_task(runner.process_message(_msg()))
        await asyncio.sleep(0.02)
        runner.cancel_turn("telegram:42")
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2.0)
        # Typing was shown and cleared even though the turn was cancelled.
        assert typing_log == [("42", True), ("42", False)]


async def _hang_then_reply(msg, *, on_event=None, delivery_meta=None):
    await asyncio.sleep(30)
    return "", [], None
