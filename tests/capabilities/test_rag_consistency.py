"""Tests for RAG/KB consistency at the capability layer.

After the refactor, RAG is no longer a user-selectable tool — its availability
is derived from whether any knowledge bases are attached for the turn.
These tests pin the contract that:

* ``deep_solve`` now runs on the chat agent loop (solve loop capability), reusing
  chat's *full* tool surface unchanged: ``rag`` auto-mounts iff a KB is
  attached, and user-toggleable tools (web_search, …) appear only when the
  user enabled them — exactly as in a plain chat turn. The plugin only *adds*
  its own ``solve_*`` tools on top.
* ``deep_research`` uses the same tool-composition policy as chat
  (``compose_enabled_tools``): the user's composer toggles flow through
  to the pipeline unchanged, ``rag`` auto-mounts iff a KB is attached.
  The legacy per-source gating (``sources: ["kb", "web", "papers"]``)
  has been removed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from knorvia.agents.chat.agentic_pipeline import AgenticChatPipeline
from knorvia.core.context import UnifiedContext
from knorvia.core.stream import StreamEvent
from tests._harness.stream_bus import StreamBus


async def _drain(bus: StreamBus, task) -> list[StreamEvent]:
    await task
    await bus.close()
    return [event async for event in bus.subscribe()]


# ---------------------------------------------------------------------------
# deep_solve: rag presence is keyed on attached KB
# ---------------------------------------------------------------------------


def _solve_pipeline(monkeypatch: pytest.MonkeyPatch) -> AgenticChatPipeline:
    """A bare pipeline whose only wired surface is tool composition."""
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(read_raw=lambda *_a, **_k: ""),
    )
    monkeypatch.setattr(
        "knorvia.services.notebook.get_notebook_manager",
        lambda: SimpleNamespace(list_notebooks=lambda: []),
    )
    pipeline = AgenticChatPipeline.__new__(AgenticChatPipeline)
    pipeline._deferred_loader = None
    pipeline._exec_enabled = False
    pipeline.registry = SimpleNamespace(
        get_enabled=lambda selected: [SimpleNamespace(name=n) for n in selected]
    )
    return pipeline


def test_deep_solve_omits_rag_when_no_knowledge_base(monkeypatch: pytest.MonkeyPatch) -> None:
    # Solve reuses chat's full surface: no KB → rag absent, and a user-toggle
    # tool the user did not enable (web_search) stays absent — the plugin never
    # force-mounts. Only its own solve_* tools are added.
    pipeline = _solve_pipeline(monkeypatch)
    context = UnifiedContext(
        user_message="solve x^2 = 4",
        metadata={"solve_mode": True, "solve_session_id": "turn-1"},
        knowledge_bases=[],
    )
    tools = pipeline._compose_enabled_tools(context)
    assert "rag" not in tools
    assert "web_search" not in tools  # not toggled on → not mounted (respects user)
    assert "solve_plan" in tools


def test_deep_solve_mounts_rag_when_knowledge_base_attached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline = _solve_pipeline(monkeypatch)
    context = UnifiedContext(
        user_message="solve x^2 = 4",
        metadata={"solve_mode": True, "solve_session_id": "turn-1"},
        knowledge_bases=["my-kb"],
    )
    tools = pipeline._compose_enabled_tools(context)
    assert "rag" in tools
    assert "solve_plan" in tools


# ---------------------------------------------------------------------------
# deep_research: tool composition matches chat (no sources gating)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deep_research_forwards_enabled_tools_and_kb_unchanged() -> None:
    """Production research turns invoke ``research.knowledge`` and forward
    composer toggles plus the attached KB in the pack extra payload."""
    from knorvia.agents.research.capability import DeepResearchCapability

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
        return {"packId": pack_id, "status": "succeeded"}

    capability = DeepResearchCapability()
    bus = StreamBus()
    context = UnifiedContext(
        user_message="A topic to research",
        active_capability="deep_research",
        enabled_tools=["web_search", "paper_search"],
        knowledge_bases=["my-kb"],
        config_overrides={
            "mode": "report",
            "depth": "standard",
        },
        language="en",
    )

    with patch("knorvia.runtime.kernel_client.emit_pack_on_stream", new=fake_emit):
        await _drain(bus, capability.run(context, bus))

    assert captured["pack_id"] == "research.knowledge"
    assert captured["extra"]["enabled_tools"] == ["web_search", "paper_search"]
    assert captured["extra"]["kb_name"] == "my-kb"
    assert "enable_rag" not in captured["extra"]
    assert "sources" not in captured["extra"]
