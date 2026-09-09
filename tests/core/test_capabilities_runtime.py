"""Runtime tests for built-in capabilities under the unified framework."""

from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace
from typing import Any

import pytest

from knorvia.agents.chat.capability import ChatCapability
from knorvia.agents.question.capability import DeepQuestionCapability
from knorvia.agents.research.capability import DeepResearchCapability
from knorvia.agents.visualize.capability import VisualizeCapability
import knorvia.agents.visualize.pipeline as visualize_pipeline
from knorvia.capabilities.solve.capability import DeepSolveCapability
from knorvia.core.context import Attachment, UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from tests._harness.stream_bus import StreamBus
from knorvia.runtime.bootstrap.builtin_capabilities import BUILTIN_CAPABILITY_CLASSES


def _install_module(
    monkeypatch: pytest.MonkeyPatch, fullname: str, **attrs: Any
) -> types.ModuleType:
    parts = fullname.split(".")
    for idx in range(1, len(parts)):
        pkg_name = ".".join(parts[:idx])
        if pkg_name not in sys.modules:
            pkg = types.ModuleType(pkg_name)
            pkg.__path__ = []  # type: ignore[attr-defined]
            monkeypatch.setitem(sys.modules, pkg_name, pkg)
            if idx > 1:
                parent = sys.modules[".".join(parts[: idx - 1])]
                # monkeypatch (not raw setattr) so the parent package's
                # attribute is restored on teardown and never leaks a fake
                # submodule into later tests.
                monkeypatch.setattr(parent, parts[idx - 1], pkg, raising=False)

    module = types.ModuleType(fullname)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, fullname, module)
    if len(parts) > 1:
        parent = sys.modules[".".join(parts[:-1])]
        monkeypatch.setattr(parent, parts[-1], module, raising=False)
    return module


async def _collect_events(run_coro) -> list[StreamEvent]:
    bus = StreamBus()
    events: list[StreamEvent] = []

    async def _consume() -> None:
        async for event in bus.subscribe():
            events.append(event)

    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0)
    await run_coro(bus)
    await asyncio.sleep(0)
    await bus.close()
    await consumer
    return events


def test_builtin_capability_registry_covers_documented_capabilities() -> None:
    assert set(BUILTIN_CAPABILITY_CLASSES) == {
        "chat",
        "deep_solve",
        "deep_question",
        "deep_research",
        "math_animator",
        "visualize",
        "mastery_path",
    }


@pytest.mark.asyncio
async def test_chat_capability_streams_daemon_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_stream(content: str, **kwargs: Any):
        captured["content"] = content
        captured["kwargs"] = kwargs
        yield StreamEvent(
            type=StreamEventType.CONTENT,
            source="knorvia-daemon",
            content="assistant output",
            metadata={"runtime": "knorvia-daemon"},
        )
        yield StreamEvent(
            type=StreamEventType.DONE,
            source="knorvia-daemon",
            metadata={"status": "completed", "runtime": "knorvia-daemon"},
        )

    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.stream_as_stream_events",
        fake_stream,
    )

    context = UnifiedContext(
        user_message="analyze triangle",
        enabled_tools=["rag", "web_search", "geogebra_analysis"],
        knowledge_bases=["demo-kb"],
        language="en",
        attachments=[Attachment(type="image", base64="ZmFrZQ==", filename="img.png")],
    )

    capability = ChatCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert captured["content"] == "analyze triangle"
    assert any(
        event.type == StreamEventType.CONTENT and "assistant output" in event.content
        for event in events
    )
    assert any(event.metadata.get("runtime") == "knorvia-daemon" for event in events)


@pytest.mark.asyncio
async def test_deep_solve_capability_streams_kernel_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deep_solve capability marks the turn ``solve_mode``, resolves a
    session id, and streams the daemon turn (the Kernel agent loop is the
    solver). The solve loop capability remains the home of the playbook +
    session state for the pack migration."""
    captured: dict[str, Any] = {}

    async def fake_stream(content: str, **kwargs: Any):
        captured["content"] = content
        yield StreamEvent(
            type=StreamEventType.CONTENT,
            source="knorvia-daemon",
            content="kernel solution",
            metadata={"runtime": "knorvia-daemon"},
        )
        yield StreamEvent(
            type=StreamEventType.DONE,
            source="knorvia-daemon",
            metadata={"status": "completed", "runtime": "knorvia-daemon"},
        )

    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.stream_as_stream_events",
        fake_stream,
    )

    context = UnifiedContext(
        user_message="solve x^2=4",
        language="en",
        metadata={"turn_id": "turn-xyz"},
    )
    assert DeepSolveCapability is not None
    from knorvia.capabilities.solve.capability import (
        resolve_solve_session_id,
    )

    assert resolve_solve_session_id(context) == "turn-xyz"
    capability = DeepSolveCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert context.metadata.get("solve_mode") is True
    assert context.metadata.get("solve_session_id") == "turn-xyz"
    assert any(
        event.type == StreamEventType.CONTENT and "kernel solution" in event.content
        for event in events
    )
    assert any(
        event.metadata.get("runtime") == "knorvia-daemon" for event in events
    )


# Legacy tests for the AgentCoordinator-based custom + mimic paths were
# removed when those code paths were deleted in the Phase A → C quiz
# refactor. New-pipeline coverage lives in
# ``tests/agents/question/test_pipeline.py`` (plan parsing, payload
# normalization, templates_override / mimic flow, structured emission,
# tool wiring, history loader, etc.).


@pytest.mark.asyncio
async def test_deep_question_capability_invokes_learning_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_emit(stream, *, source: str, pack_id: str, user_message: str, extra=None):
        captured.update(
            {
                "source": source,
                "pack_id": pack_id,
                "user_message": user_message,
                "extra": extra or {},
            }
        )
        await stream.content(f"{pack_id} succeeded", source=source)
        await stream.result(
            {"response": f"{pack_id} succeeded", "pack": {"packId": pack_id, "status": "succeeded"}},
            source=source,
        )
        return {"packId": pack_id, "status": "succeeded"}

    monkeypatch.setattr("knorvia.runtime.kernel_client.emit_pack_on_stream", fake_emit)

    context = UnifiedContext(
        user_message="Why was my answer wrong?",
        language="en",
        metadata={
            "conversation_context_text": "User previously asked for a simpler explanation.",
            "question_followup_context": {
                "question_id": "q_3",
                "question": "What does density mean in win-rate comparison?",
            },
        },
    )
    capability = DeepQuestionCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert captured["pack_id"] == "learning.mastery"
    assert captured["source"] == "deep_question"
    assert captured["user_message"] == "Why was my answer wrong?"
    assert captured["extra"]["followup"]["question_id"] == "q_3"
    assert any(
        event.type == StreamEventType.CONTENT and "learning.mastery" in event.content
        for event in events
    )
    result_event = next(event for event in events if event.type == StreamEventType.RESULT)
    assert result_event.metadata["pack"]["packId"] == "learning.mastery"


@pytest.mark.asyncio
async def test_deep_research_capability_invokes_research_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_emit(stream, *, source: str, pack_id: str, user_message: str, extra=None):
        captured.update(
            {
                "source": source,
                "pack_id": pack_id,
                "user_message": user_message,
                "extra": extra or {},
            }
        )
        await stream.content(f"{pack_id} succeeded", source=source)
        await stream.result(
            {"response": f"{pack_id} succeeded", "pack": {"packId": pack_id, "status": "succeeded"}},
            source=source,
        )
        return {"packId": pack_id, "status": "succeeded"}

    monkeypatch.setattr("knorvia.runtime.kernel_client.emit_pack_on_stream", fake_emit)

    context = UnifiedContext(
        user_message="agent-native tutoring",
        enabled_tools=["rag", "web_search", "paper_search"],
        knowledge_bases=["research-kb"],
        attachments=[Attachment(type="image", base64="ZmFrZQ==", filename="brief.png")],
        config_overrides={
            "mode": "report",
            "depth": "standard",
            "confirmed_outline": [
                {"title": "Background", "overview": "Why this topic matters"},
                {"title": "Approaches", "overview": "How to do it"},
            ],
        },
        language="en",
    )
    capability = DeepResearchCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert captured["pack_id"] == "research.knowledge"
    assert captured["source"] == "deep_research"
    assert captured["user_message"] == "agent-native tutoring"
    assert captured["extra"]["kb_name"] == "research-kb"
    assert captured["extra"]["enabled_tools"] == ["rag", "web_search", "paper_search"]
    assert captured["extra"]["confirmed_outline"][0]["title"] == "Background"
    assert any(
        event.type == StreamEventType.CONTENT and "research.knowledge" in event.content
        for event in events
    )


@pytest.mark.asyncio
async def test_visualize_capability_invokes_media_visualize_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The visualize capability forwards render params to the media pack."""
    captured: dict[str, Any] = {}

    async def fake_emit(stream, *, source: str, pack_id: str, user_message: str, extra=None):
        captured.update(
            {
                "source": source,
                "pack_id": pack_id,
                "user_message": user_message,
                "extra": extra or {},
            }
        )
        await stream.content("media.visualize succeeded", source=source)
        await stream.result(
            {
                "response": "media.visualize done",
                "render_type": "svg",
                "pack": {"packId": pack_id, "status": "succeeded"},
            },
            source=source,
        )
        return {"packId": pack_id, "status": "succeeded"}

    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.emit_pack_on_stream", fake_emit
    )

    context = UnifiedContext(
        user_message="make a figure",
        active_capability="visualize",
        config_overrides={"render_mode": "svg"},
        language="en",
        metadata={"conversation_context_text": "prior exchange"},
    )

    capability = VisualizeCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert captured["pack_id"] == "media.visualize"
    assert captured["source"] == "visualize"
    assert captured["user_message"] == "make a figure"
    assert captured["extra"]["render_mode"] == "svg"
    assert captured["extra"]["language"] == "en"
    assert any(
        event.type == StreamEventType.CONTENT and "media.visualize" in event.content
        for event in events
    )
    result_event = next(event for event in events if event.type == StreamEventType.RESULT)
    assert result_event.metadata["render_type"] == "svg"
