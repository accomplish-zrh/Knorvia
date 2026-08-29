"""Truncation continuation: length-finish gets one stitched follow-up."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from knorvia.core.agentic import loop as agentic_loop
from knorvia.core.agentic.loop import LabelProtocol


class FakeStream:
    def __init__(self) -> None:
        self.chunks: list[str] = []

    async def content(self, text: str, **_: Any) -> None:
        self.chunks.append(text)

    async def progress(self, *a: Any, **k: Any) -> None:
        return None


class FakeHost:
    def __init__(self) -> None:
        self.finals: list[str] = []

    def build_iteration_trace_meta(self, iteration: int):
        return {}, {}

    def assistant_message_with_tool_calls(self, *_a, **_k):  # pragma: no cover
        raise NotImplementedError

    async def guard_context_window(self, messages):  # noqa: ARG002
        return None

    async def dispatch_tools(self, **kwargs):  # noqa: ARG002
        raise NotImplementedError

    async def resolve_pause(self, outcome):  # noqa: ARG002
        return False

    async def emit_terminator(self, payload):  # noqa: ARG002
        return None

    async def force_finalize(self, *, messages, start_iteration):  # noqa: ARG002
        return "", False, 0

    async def emit_final(self, text: str, final_meta) -> None:
        self.finals.append(text)


def _protocol() -> LabelProtocol:
    return LabelProtocol(
        allowed=("FINISH",),
        terminal=frozenset({"FINISH"}),
        intermediate=frozenset(),
        final=frozenset({"FINISH"}),
        tool_label=None,
    )


@pytest.mark.asyncio
async def test_length_finish_triggers_one_continuation(monkeypatch: pytest.MonkeyPatch) -> None:
    """First step ends mid-sentence (length); second completes the reply."""
    steps = [
        SimpleNamespace(
            label="FINISH",
            text="The mitochondria is the powerhouse",
            tool_calls=[],
            finish_reason="length",
        ),
        SimpleNamespace(label="FINISH", text=" of the cell.", tool_calls=[], finish_reason="stop"),
    ]
    calls = {"n": 0}

    async def fake_step(**kwargs):  # noqa: ANN001, ANN003
        step = steps[calls["n"]]
        calls["n"] += 1
        return step

    monkeypatch.setattr(agentic_loop, "run_labeled_step", fake_step)
    host = FakeHost()
    outcome = await agentic_loop.run_agentic_loop(
        initial_messages=[{"role": "user", "content": "q"}],
        protocol=_protocol(),
        client=object(),
        model="m",
        completion_kwargs={},
        binding=None,
        tool_schemas=None,
        stream=FakeStream(),
        source="test",
        stage="test",
        max_iterations=3,
        host=host,
    )
    assert calls["n"] == 2
    assert outcome.final_text == "The mitochondria is the powerhouse of the cell."
    assert outcome.completed is True


@pytest.mark.asyncio
async def test_stop_finish_skips_continuation(monkeypatch: pytest.MonkeyPatch) -> None:
    steps = [
        SimpleNamespace(
            label="FINISH", text="Complete answer.", tool_calls=[], finish_reason="stop"
        ),
    ]
    calls = {"n": 0}

    async def fake_step(**kwargs):  # noqa: ANN001, ANN003
        step = steps[calls["n"]]
        calls["n"] += 1
        return step

    monkeypatch.setattr(agentic_loop, "run_labeled_step", fake_step)
    outcome = await agentic_loop.run_agentic_loop(
        initial_messages=[{"role": "user", "content": "q"}],
        protocol=_protocol(),
        client=object(),
        model="m",
        completion_kwargs={},
        binding=None,
        tool_schemas=None,
        stream=FakeStream(),
        source="test",
        stage="test",
        max_iterations=3,
        host=FakeHost(),
    )
    assert calls["n"] == 1
    assert outcome.final_text == "Complete answer."


@pytest.mark.asyncio
async def test_continuation_failure_keeps_partial_text(monkeypatch: pytest.MonkeyPatch) -> None:
    steps = [
        SimpleNamespace(
            label="FINISH", text="Partial answer", tool_calls=[], finish_reason="length"
        ),
    ]

    async def fake_step(**kwargs):  # noqa: ANN001, ANN003
        if steps:
            return steps.pop(0)
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(agentic_loop, "run_labeled_step", fake_step)
    outcome = await agentic_loop.run_agentic_loop(
        initial_messages=[{"role": "user", "content": "q"}],
        protocol=_protocol(),
        client=object(),
        model="m",
        completion_kwargs={},
        binding=None,
        tool_schemas=None,
        stream=FakeStream(),
        source="test",
        stage="test",
        max_iterations=3,
        host=FakeHost(),
    )
    assert outcome.final_text == "Partial answer"
    assert outcome.completed is True
