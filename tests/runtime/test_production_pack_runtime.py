"""Production Agent Runtime paths go through knorvia-daemon packs / Protocol."""

from __future__ import annotations

import inspect
import os
from pathlib import Path
from typing import Any

import pytest

from knorvia.agents.chat.agentic_pipeline import AgenticChatPipeline
from knorvia.agents.chat.capability import ChatCapability
from knorvia.agents.question.capability import DeepQuestionCapability
from knorvia.agents.research.capability import DeepResearchCapability
from knorvia.core.context import UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from tests._harness.stream_bus import StreamBus
from knorvia.runtime.kernel_client import (
    DaemonSession,
    invoke_pack_sync,
    resolve_daemon_bin,
)


def _source(fn) -> str:
    return inspect.getsource(fn)


def test_production_run_methods_do_not_call_python_agent_loop() -> None:
    question = _source(DeepQuestionCapability.run)
    research = _source(DeepResearchCapability.run)
    chat = _source(ChatCapability.run)
    pipeline = _source(AgenticChatPipeline.run)

    assert "emit_pack_on_stream" in question
    assert "learning.mastery" in question
    assert "QuestionPipeline" not in question
    assert "run_agentic_loop" not in question

    assert "emit_pack_on_stream" in research
    assert "research.knowledge" in research
    assert "ResearchPipeline" not in research
    assert "run_agentic_loop" not in research

    assert "stream_as_stream_events" in chat
    assert "AgenticChatPipeline" not in chat
    assert "run_agentic_loop" not in chat

    assert "stream_as_stream_events" in pipeline
    assert "AgentLoop(" not in pipeline
    assert "run_agentic_loop" not in pipeline


@pytest.mark.asyncio
async def test_question_and_research_run_invoke_named_packs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_emit(stream, *, source: str, pack_id: str, user_message: str, extra=None):
        calls.append(
            {
                "source": source,
                "pack_id": pack_id,
                "user_message": user_message,
                "extra": extra or {},
            }
        )
        await stream.content(f"{pack_id} succeeded artifact=art_1 job=job_1", source=source)
        await stream.result(
            {
                "response": f"{pack_id} succeeded",
                "pack": {"packId": pack_id, "status": "succeeded"},
                "runtime": "knorvia-daemon",
            },
            source=source,
        )
        return {"packId": pack_id, "status": "succeeded"}

    monkeypatch.setattr("knorvia.runtime.kernel_client.emit_pack_on_stream", fake_emit)

    qbus = StreamBus()
    await DeepQuestionCapability().run(
        UnifiedContext(user_message="Bayes theorem", config_overrides={"num_questions": 3}),
        qbus,
    )
    await qbus.close()

    rbus = StreamBus()
    await DeepResearchCapability().run(
        UnifiedContext(
            user_message="Fourier sine",
            enabled_tools=["web_search"],
            knowledge_bases=["kb-1"],
        ),
        rbus,
    )
    await rbus.close()

    assert [c["pack_id"] for c in calls] == ["learning.mastery", "research.knowledge"]
    assert calls[0]["extra"]["num_questions"] == 3
    assert calls[1]["extra"]["kb_name"] == "kb-1"
    assert calls[1]["extra"]["enabled_tools"] == ["web_search"]


@pytest.mark.asyncio
async def test_agentic_chat_pipeline_run_uses_daemon_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_stream(content: str, **kwargs: Any):
        captured["content"] = content
        yield StreamEvent(
            type=StreamEventType.CONTENT,
            source="knorvia-daemon",
            content="daemon reply",
            metadata={"runtime": "knorvia-daemon"},
        )

    monkeypatch.setattr("knorvia.runtime.kernel_client.stream_as_stream_events", fake_stream)
    monkeypatch.setattr(
        "knorvia.agents.chat.agentic_pipeline.get_llm_config",
        lambda: type("Cfg", (), {"binding": "openai", "model": "gpt-test", "api_key": "k", "base_url": "u", "api_version": None, "extra_headers": {}, "reasoning_effort": None})(),
    )

    bus = StreamBus()
    events: list[StreamEvent] = []

    async def _consume() -> None:
        async for event in bus.subscribe():
            events.append(event)

    import asyncio

    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0)
    await AgenticChatPipeline(language="en").run(
        UnifiedContext(user_message="hello daemon"),
        bus,
    )
    await asyncio.sleep(0)
    await bus.close()
    await consumer

    assert captured["content"] == "hello daemon"
    assert any(e.content == "daemon reply" for e in events)


def test_invoke_research_and_learning_packs_against_shipped_daemon(tmp_path: Path) -> None:
    os.environ.setdefault("KNORVIA_DAEMON_BIN", str(resolve_daemon_bin()))
    if not Path(os.environ["KNORVIA_DAEMON_BIN"]).is_file():
        pytest.skip("knorvia-daemon binary missing")

    home = tmp_path / "knorvia-home"
    research = invoke_pack_sync(
        "research.knowledge",
        {
            "query": "Fourier sine",
            "corpus": [
                {"id": "d1", "title": "Fourier", "text": "The Fourier transform of a sine"},
                {"id": "d2", "title": "Unrelated", "text": "gardening tips"},
            ],
        },
        home=home,
    )
    assert research["status"] == "succeeded"
    assert research["artifactId"]
    assert research["jobId"]
    # Without provider env the pack must be honest about its mode.
    assert research["mode"] == "template"

    quiz = invoke_pack_sync(
        "learning.mastery",
        {"topic": "Bayes", "num_questions": 3},
        home=home,
    )
    assert quiz["status"] == "succeeded"
    assert quiz["artifactId"]

    with DaemonSession(home) as session:
        kinds = session.rpc("provider/list")
        assert kinds["kinds"] == [
            "openai_responses",
            "openai_compatible",
            "anthropic",
            "gemini",
            "local",
        ]
        for kind, model in [
            ("openai_responses", "gpt-5"),
            ("openai_compatible", "llama-3"),
            ("anthropic", "claude-sonnet-4"),
            ("gemini", "gemini-2.5-pro"),
            ("local", "ollama/llama3.1"),
        ]:
            reports = session.rpc("provider/negotiate", {"kind": kind, "model": model})
            assert len(reports["capabilities"]) == 8
            tx = session.rpc(
                "provider/translate",
                {
                    "kind": kind,
                    "request": {
                        "model": model,
                        "messages": [
                            {"role": "user", "text": "hi", "images": [{"mediaType": "image/png", "data": "aaa"}]}
                        ],
                        "tools": [{"name": "lookup", "description": "lookup", "parameters": {"type": "object"}}],
                        "parallelTools": True,
                        "structuredOutput": {"type": "object", "properties": {"answer": {"type": "string"}}},
                        "reasoning": True,
                        "promptCache": True,
                        "stream": True,
                    },
                },
            )
            assert tx["kind"] == kind
            assert len(tx["applied"]) == 8
            assert tx["method"] == "POST"
