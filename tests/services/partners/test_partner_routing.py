"""Partner inference router: routing config, routed turns, LLM fallback."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.core.stream import StreamEvent as SE
from knorvia.partners.bus.events import InboundMessage
from knorvia.partners.bus.queue import MessageBus
from knorvia.services.partners.manager import PartnerConfig
from knorvia.services.partners.routing import (
    ROUTING_BACKEND_CLI,
    ROUTING_BACKEND_LLM,
    RoutedTurnMeta,
    is_cli_routing,
    routing_label,
    sanitize_routing,
)
from knorvia.services.partners.routing import (
    execute_routed_turn as _execute_routed_turn,
)
from knorvia.services.partners.runtime import PartnerRunner
from knorvia.services.partners.sessions import PartnerSessionStore


def _msg(content: str = "hello", channel: str = "telegram") -> InboundMessage:
    return InboundMessage(channel=channel, sender_id="42", chat_id="42", content=content)


def _runner(partners_root, config: PartnerConfig | None = None) -> PartnerRunner:
    from knorvia.partners.config.paths import get_partner_sessions_dir

    config = config or PartnerConfig(name="Ada")
    bus = MessageBus()
    store = PartnerSessionStore(get_partner_sessions_dir("ada"))
    return PartnerRunner("ada", config, bus, store)


class TestSanitizeRouting:
    def test_defaults_to_llm_for_junk(self):
        for junk in (None, "x", [], {}, {"backend": "banana"}):
            safe = sanitize_routing(junk)
            assert safe == {"backend": ROUTING_BACKEND_LLM, "kind": "", "connection": ""}

    def test_cli_routing_with_known_kind(self, monkeypatch):
        monkeypatch.setattr("knorvia.services.partners.routing._cli_kinds", lambda: {"claude_code"})
        safe = sanitize_routing({"backend": "cli", "kind": "claude_code", "connection": "My CC"})
        assert safe == {"backend": "cli", "kind": "claude_code", "connection": "My CC"}
        assert is_cli_routing(safe)
        assert routing_label(safe) == "cli:claude_code"

    def test_cli_routing_with_unknown_kind_degrades_to_llm(self, monkeypatch):
        monkeypatch.setattr("knorvia.services.partners.routing._cli_kinds", lambda: set())
        safe = sanitize_routing({"backend": "cli", "kind": "gone_cli"})
        assert safe["backend"] == ROUTING_BACKEND_LLM
        assert not is_cli_routing(safe)

    def test_partner_config_roundtrip_sanitises(self, partners_root):
        from knorvia.services.partners.manager import PartnerManager

        mgr = PartnerManager()
        cfg = PartnerConfig(
            name="Ada", routing={"backend": "cli", "kind": "not_a_cli", "connection": ""}
        )
        mgr.save_config("ada", cfg)
        loaded = mgr.load_config("ada")
        assert loaded is not None
        assert loaded.routing["backend"] == ROUTING_BACKEND_LLM


class _FakeBackend:
    """Emits a scripted SubagentEvent stream and a canned final answer."""

    def __init__(self, *, events: list[tuple[str, str]] | None = None, final: str = "routed!"):
        self.kind = "claude_code"
        self.display_name = "Claude Code"
        self.cli_command = "claude"
        self.local_cli = True
        self._events = events or [
            ("tool", "Read(sketch.md)"),
            ("text", "routing "),
            ("text", "works"),
        ]
        self._final = final
        self.consulted: list[dict[str, Any]] = []

    async def detect(self):
        raise NotImplementedError

    async def consult(
        self,
        question,
        *,
        on_event,
        cwd=None,
        session_id=None,
        config=None,
        images=None,
        partner_id=None,
    ):
        self.consulted.append(
            {
                "question": question,
                "cwd": cwd,
                "session_id": session_id,
                "system_prompt": getattr(config, "system_prompt", ""),
                "images": list(images or []),
            }
        )
        for kind, text in self._events:
            from knorvia.services.subagent.types import SubagentEvent

            await on_event(SubagentEvent(kind=kind, text=text))
        from knorvia.services.subagent.types import ConsultResult

        return ConsultResult(final_text=self._final, session_id="cli-session-1", success=True)


@pytest.fixture
def fake_backend(monkeypatch):
    backend = _FakeBackend()

    import knorvia.services.partners.routing as routing_mod
    from knorvia.services.subagent.config import BackendConfig

    monkeypatch.setattr(routing_mod, "get_backend_or_none", lambda kind: backend)
    monkeypatch.setattr("knorvia.services.partners.routing._cli_kinds", lambda: {backend.kind})
    monkeypatch.setattr(
        "knorvia.services.subagent.config.load_subagent_settings",
        lambda: type("S", (), {"backend": lambda self, kind: BackendConfig()})(),
    )
    # process helpers: keep everything inside tmp (partners_root redirects admin root)
    monkeypatch.setattr(
        "knorvia.services.subagent.process.validate_subagent_cwd", lambda cwd: cwd or "/tmp"
    )
    monkeypatch.setattr(
        "knorvia.services.subagent.sessions.remember_session",
        lambda key, session_id, *, kind="", cwd="": None,
    )
    monkeypatch.setattr("knorvia.services.subagent.sessions.get_session", lambda key: None)
    return backend


async def _drain_routed(runner, msg, routing, meta):
    from knorvia.services.partners.workspace import ensure_partner_workspace

    ensure_partner_workspace("ada")
    events = []
    async for event in _execute_routed_turn(
        partner_id="ada",
        partner_name="Ada",
        description="",
        soul="Be terse.",
        channel=msg.channel,
        session_key=msg.session_key,
        user_message=msg.content,
        media=list(msg.media or []),
        routing=routing,
        meta=meta,
    ):
        events.append(event)
    return events


class TestRoutedTurn:
    @pytest.mark.asyncio
    async def test_routed_turn_maps_events_and_final(self, partners_root, fake_backend):
        msg = _msg("hello there")
        meta = RoutedTurnMeta()
        events = await _drain_routed(
            _runner(partners_root), msg, {"backend": "cli", "kind": "claude_code"}, meta
        )

        kinds = [event.type for event in events]
        assert StreamEventType.TOOL_CALL in kinds
        assert kinds[-1] == StreamEventType.RESULT
        final = events[-1].metadata["response"]
        assert final == "routed!"
        # The CLI events streamed through as CONTENT the runner can stream.
        contents = [event.content for event in events if event.type == StreamEventType.CONTENT]
        assert "routing " in contents and "works" in contents
        # Soul injected as the CLI system prompt; session continuity recorded.
        assert "Be terse." in fake_backend.consulted[0]["system_prompt"]
        assert fake_backend.consulted[0]["session_id"] is None
        assert meta.session_id == "cli-session-1"
        assert meta.errors == []

    @pytest.mark.asyncio
    async def test_routed_failure_yields_error_event(self, partners_root, fake_backend):
        fake_backend._final = ""
        fake_backend._events = [("error", "boom")]
        msg = _msg()
        meta = RoutedTurnMeta()
        events = await _drain_routed(
            _runner(partners_root), msg, {"backend": "cli", "kind": "claude_code"}, meta
        )
        assert events[-1].type == StreamEventType.ERROR
        assert meta.errors

    @pytest.mark.asyncio
    async def test_empty_final_falls_back_to_accumulated_text(self, partners_root, fake_backend):
        fake_backend._final = ""
        msg = _msg()
        meta = RoutedTurnMeta()
        events = await _drain_routed(
            _runner(partners_root), msg, {"backend": "cli", "kind": "claude_code"}, meta
        )
        # Streamed CONTENT still forms the answer when the backend forgot its
        # explicit final_text.
        assert events[-1].type == StreamEventType.RESULT
        assert events[-1].metadata["response"] == "routing works"


class TestRunnerRouting:
    @pytest.fixture
    def fake_orchestrator(self, monkeypatch):
        """Scripted Kernel stream (the LLM path runs on knorvia-daemon now).

        The old ChatOrchestrator double is replaced by a scripted
        ``stream_as_stream_events`` patch — the partner runner's LLM path
        consumes the daemon stream lazily from kernel_client. Tests assign
        ``fake_orchestrator.script = [...]``.
        """
        from knorvia.services.model_selection import runtime as selection_runtime

        holder = SimpleNamespace(script=[])

        async def fake_stream(content: str, **_kwargs):
            for event in list(holder.script):
                yield event

        monkeypatch.setattr(
            "knorvia.runtime.kernel_client.stream_as_stream_events", fake_stream
        )
        monkeypatch.setattr(
            selection_runtime,
            "activate_llm_selection",
            lambda selection: (None, None),
        )
        monkeypatch.setattr(selection_runtime, "reset_llm_selection", lambda token: None)
        return holder

    @pytest.mark.asyncio
    async def test_process_message_uses_routed_backend_and_persists(
        self, partners_root, fake_backend, monkeypatch
    ):
        import knorvia.services.partners.runtime as runtime_mod

        config = PartnerConfig(
            name="Ada", routing={"backend": "cli", "kind": "claude_code", "connection": ""}
        )
        runner = _runner(partners_root, config)
        # Guard against the LLM fallback being reached silently.
        monkeypatch.setattr(
            runtime_mod.PartnerRunner,
            "_execute_turn",
            raise_called,
        )

        final = await runner.process_message(_msg("say hi"))
        assert final == "routed!"
        history = runner.store.conversation_history("telegram:42")
        assert history[-1] == {"role": "assistant", "content": "routed!"}
        assert "say hi" in fake_backend.consulted[0]["question"]

        # The routed turn lands in the usage ledger as one CLI request.
        from knorvia.services.partners import usage as usage_ledger

        summary = usage_ledger.summary("ada", days=7)
        assert summary["totals"]["turns"] == 1
        assert summary["per_backend"][0]["backend"] == "cli:claude_code"

    @pytest.mark.asyncio
    async def test_routed_failure_falls_back_to_llm(
        self, partners_root, fake_backend, fake_orchestrator
    ):
        from knorvia.core.stream import StreamEvent as SE

        fake_backend._final = ""
        fake_backend._events = [("error", "boom")]
        config = PartnerConfig(
            name="Ada", routing={"backend": "cli", "kind": "claude_code", "connection": ""}
        )
        fake_orchestrator.script = [
            SE(type=StreamEventType.RESULT, source="chat", metadata={"response": "llm rescue"}),
            SE(type=StreamEventType.DONE),
        ]
        runner = _runner(partners_root, config)

        final = await runner.process_message(_msg())
        assert final == "llm rescue"
        # The router error is surfaced in-band (grok-bot router parity).
        session_record = runner.store.messages("telegram:42")[-1]
        assert session_record["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_llm_turn_records_usage_row(self, partners_root, fake_orchestrator):
        fake_orchestrator.script = [
            SE(
                type=StreamEventType.RESULT,
                source="chat",
                metadata={
                    "response": "ok",
                    "metadata": {
                        "cost_summary": {
                            "prompt_tokens": 10,
                            "completion_tokens": 5,
                            "total_tokens": 15,
                            "total_calls": 2,
                            "total_cost_usd": 0.01,
                        }
                    },
                },
            ),
            SE(type=StreamEventType.DONE),
        ]
        config = PartnerConfig(name="Ada", llm_selection={"model_id": "gpt-test"})
        runner = _runner(partners_root, config)
        await runner.process_message(_msg())

        from knorvia.services.partners import usage as usage_ledger

        summary = usage_ledger.summary("ada", days=7)
        assert summary["totals"]["turns"] == 1
        assert summary["totals"]["total_tokens"] == 15
        assert summary["totals"]["total_calls"] == 2
        assert summary["per_backend"][0]["backend"] == "llm"


async def raise_called(self, *args, **kwargs):
    raise AssertionError("LLM path should not run when routing succeeds")
