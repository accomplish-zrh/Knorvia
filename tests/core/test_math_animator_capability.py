"""Math animator capability test: the pack route (media.manim)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from knorvia.agents.math_animator.capability import MathAnimatorCapability
from knorvia.core.context import UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from tests._harness.stream_bus import StreamBus


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


@pytest.mark.asyncio
async def test_math_animator_capability_invokes_media_manim_pack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Unit test should not require real optional dependency installation.
    monkeypatch.setattr(
        "knorvia.agents.math_animator.capability.importlib.util.find_spec",
        lambda name: object() if name == "manim" else None,
    )

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
            {
                "response": f"{pack_id} done",
                "pack": {"packId": pack_id, "status": "succeeded"},
            },
            source=source,
        )
        return {"packId": pack_id, "status": "succeeded"}

    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.emit_pack_on_stream", fake_emit
    )

    context = UnifiedContext(
        session_id="session_1",
        user_message="讲解抛物线",
        active_capability="math_animator",
        config_overrides={"output_mode": "video", "quality": "high"},
        metadata={"conversation_context_text": "previous discussion"},
        attachments=[],
    )
    capability = MathAnimatorCapability()
    events = await _collect_events(lambda bus: capability.run(context, bus))

    assert captured["pack_id"] == "media.manim"
    assert captured["source"] == "math_animator"
    assert captured["user_message"] == "讲解抛物线"
    assert captured["extra"]["config_overrides"]["output_mode"] == "video"
    assert any(
        event.type == StreamEventType.CONTENT and "media.manim" in event.content
        for event in events
    )
    result = [e for e in events if e.type == StreamEventType.RESULT]
    assert result and result[0].metadata["pack"]["packId"] == "media.manim"


@pytest.mark.asyncio
async def test_math_animator_without_manim_raises_typed() -> None:
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        "knorvia.agents.math_animator.capability.importlib.util.find_spec",
        lambda name: None,
    )
    capability = MathAnimatorCapability()
    with pytest.raises(RuntimeError, match="math-animator"):
        await capability.run(
            UnifiedContext(user_message="讲解抛物线"), StreamBus()
        )
