from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.services.session.sqlite_store import SQLiteSessionStore
from knorvia.services.session.turn_runtime import TurnRuntimeManager


async def _noop_async(*_args, **_kwargs):
    return None


def _fake_skill_service() -> SimpleNamespace:
    return SimpleNamespace(
        summary_entries=lambda: [],
        load_always_for_context=lambda: "",
        load_for_context=lambda _skills: "",
        list_skills=lambda: [],
    )


def _fake_persona_service() -> SimpleNamespace:
    # Non-empty render so the resolved persona is recorded in the snapshot.
    return SimpleNamespace(
        load_for_context=lambda name: (
            f"## Active Persona\n### Persona: {name}\n\nbody" if name else ""
        )
    )


def _patch_kernel_turn(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict[str, object],
    items: list[tuple[str, str, dict[str, Any] | None]],
) -> None:
    """Script the Kernel turn for the WS turn runtime.

    Replaces the old ChatOrchestrator double: the production turn runtime
    calls ``start_turn_async`` and projects the daemon result through
    ``iter_legacy_events``. *items* are (kind, text, metadata) tuples; each
    becomes a daemon item whose payload metadata flows into the event.
    """
    captured["kernel_calls"] = []

    async def fake_start_turn(content: str, **_kwargs):
        captured["kernel_calls"].append(content)
        return {
            "thread": {"id": "thr_test"},
            "turn": {
                "turn": {"id": "turn_test", "status": "completed"},
                # No item seq: the runtime assigns its own event sequence —
                # scripted seqs would collide with the runtime's session event.
                "items": [
                    {
                        "kind": kind,
                        "payload": {
                            "text": text,
                            **({"metadata": meta} if meta else {}),
                        },
                        "turnId": "turn_test",
                    }
                    for kind, text, meta in items
                ],
            },
        }

    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.start_turn_async", fake_start_turn
    )


def _model_catalog() -> dict:
    return {
        "version": 1,
        "services": {
            "llm": {
                "active_profile_id": "p-default",
                "active_model_id": "m-default",
                "profiles": [
                    {
                        "id": "p-default",
                        "name": "Default",
                        "binding": "openai",
                        "base_url": "https://api.openai.com/v1",
                        "api_key": "sk-test",
                        "models": [
                            {
                                "id": "m-default",
                                "name": "Default",
                                "model": "gpt-4o-mini",
                            }
                        ],
                    },
                    {
                        "id": "p-alt",
                        "name": "Alt",
                        "binding": "openrouter",
                        "base_url": "https://openrouter.ai/api/v1",
                        "api_key": "sk-alt",
                        "models": [
                            {
                                "id": "m-alt",
                                "name": "Alt Model",
                                "model": "anthropic/claude-sonnet-4",
                            }
                        ],
                    },
                ],
            }
        },
    }


@pytest.mark.asyncio
async def test_turn_runtime_replays_events_and_materializes_messages(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, object] = {}
    publish_order: list[str] = []
    original_publish = runtime._publish_live_event

    async def publish_with_status_capture(execution, event):
        publish_order.append(
            event.type.value if hasattr(event.type, "value") else str(event.type)
        )
        if str(getattr(event.type, "value", event.type)) == "done":
            persisted_turn = await store.get_turn(execution.turn_id)
            captured["turn_status_when_done_published"] = (persisted_turn or {}).get("status")
        return await original_publish(execution, event)

    monkeypatch.setattr(runtime, "_publish_live_event", publish_with_status_capture)

    async def title_after_done(*_args, **_kwargs):
        captured["title_started_after_done"] = "done" in publish_order

    monkeypatch.setattr(runtime, "_maybe_generate_session_title", title_after_done)

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **kwargs):
            on_event = kwargs.get("on_event")
            if on_event is not None:
                await on_event(
                    StreamEvent(
                        type=StreamEventType.PROGRESS,
                        source="context",
                        stage="summarizing",
                        content="summarize context",
                    )
                )
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    monkeypatch.setattr("knorvia.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    _patch_kernel_turn(
        monkeypatch,
        captured,
        items=[("agentMessage", "Hello Frank", {"call_kind": "llm_final_response"})],
    )
    monkeypatch.setattr(
        "knorvia.book.context.build_book_context",
        lambda *_args, **_kwargs: SimpleNamespace(
            text="## Page: Signal Basics\nA selected page.",
            references=[{"book_id": "book-1", "page_ids": ["page-1"]}],
            warnings=[],
        ),
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=lambda: "",
            emit=_noop_async,
        ),
    )
    monkeypatch.setattr(
        "knorvia.services.skill.get_skill_service",
        _fake_skill_service,
    )
    monkeypatch.setattr(
        "knorvia.services.persona.get_persona_service",
        _fake_persona_service,
    )

    session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "hello, i'm frank",
            "session_id": None,
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "persona": "socratic",
            "memory_references": ["summary"],
            "book_references": [{"book_id": "book-1", "page_ids": ["page-1"]}],
            "mastery_path_id": "path-1",
            "config": {},
        }
    )

    events = []
    async for event in runtime.subscribe_turn(turn["id"], after_seq=0):
        events.append(event)

    # session_meta may arrive after `done` from the title generator —
    # filter it out so the timing race doesn't flake the assertion.
    # The Kernel stream projects session → content → result → done (the
    # result event carries the turn's final agentMessage text).
    assert [e["type"] for e in events if e["type"] != "session_meta"] == [
        "session",
        "content",
        "result",
        "done",
    ]
    # The WS turn hands the raw user message to the Kernel.
    assert captured["kernel_calls"] == ["hello, i'm frank"]
    done_event = next(e for e in events if e["type"] == "done")
    assert done_event["metadata"]["status"] == "completed"
    assert captured["turn_status_when_done_published"] == "completed"
    assert captured["title_started_after_done"] is True

    detail = await store.get_session_with_messages(session["id"])
    assert detail is not None
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    # DONE carries the persisted row ids so the frontend can reconcile its
    # optimistic negative ids in place instead of refetching the session.
    user_row, assistant_row = detail["messages"]
    assert done_event["metadata"]["user_message_id"] == user_row["id"]
    assert done_event["metadata"]["assistant_message_id"] == assistant_row["id"]
    assert detail["messages"][0]["metadata"]["request_snapshot"]["persona"] == "socratic"
    assert detail["messages"][0]["metadata"]["request_snapshot"]["memoryReferences"] == ["summary"]
    assert detail["messages"][0]["metadata"]["request_snapshot"]["bookReferences"] == [
        {"book_id": "book-1", "page_ids": ["page-1"]}
    ]
    assert detail["messages"][0]["metadata"]["request_snapshot"]["masteryPathId"] == "path-1"
    # The Kernel turn receives the raw user message; book sources ride the
    # request snapshot (bookReferences) and the chat capability's read_source
    # path — the plain WS turn does not inline a source manifest.
    assert detail["messages"][1]["content"] == "Hello Frank"
    assert detail["preferences"] == {
        "capability": "chat",
        "tools": [],
        "knowledge_bases": [],
        "language": "en",
        # Explicit persona in the payload is persisted as a session-level
        # preference (survives reloads; later turns fall back to it).
        "persona": "socratic",
        "mastery_path_id": "path-1",
    }

    persisted_turn = await store.get_turn(turn["id"])
    assert persisted_turn is not None
    assert persisted_turn["status"] == "completed"


@pytest.mark.asyncio
async def test_turn_runtime_persists_llm_selection_in_turn_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, object] = {}

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **kwargs):
            captured["builder_llm_config"] = kwargs["llm_config"]
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    _patch_kernel_turn(
        monkeypatch,
        captured,
        items=[("agentMessage", "Alt reply", {"call_kind": "llm_final_response"})],
    )

    def fake_activate(selection):
        captured["activated_selection"] = selection
        return SimpleNamespace(
            model="anthropic/claude-sonnet-4", provider_name="openrouter"
        ), object()

    monkeypatch.setattr(
        "knorvia.services.config.get_model_catalog_service",
        lambda: SimpleNamespace(load=_model_catalog),
    )
    monkeypatch.setattr(
        "knorvia.services.model_selection.runtime.activate_llm_selection",
        fake_activate,
    )
    monkeypatch.setattr(
        "knorvia.services.model_selection.runtime.reset_llm_selection",
        lambda _token: captured.setdefault("reset_called", True),
    )
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=lambda: "",
            emit=_noop_async,
        ),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    selection = {"profile_id": "p-alt", "model_id": "m-alt"}
    session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "use the alt model",
            "session_id": None,
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "config": {},
            "llm_selection": selection,
        }
    )

    async for _event in runtime.subscribe_turn(turn["id"], after_seq=0):
        pass

    detail = await store.get_session_with_messages(session["id"])
    assert detail is not None
    assert detail["preferences"]["llm_selection"] == selection
    assert detail["messages"][0]["metadata"]["request_snapshot"]["llmSelection"] == selection
    assert captured["activated_selection"] == selection
    assert captured["builder_llm_config"].model == "anthropic/claude-sonnet-4"
    assert captured["reset_called"] is True
    # The Kernel turn receives the raw user message.
    assert captured["kernel_calls"] == ["use the alt model"]


@pytest.mark.asyncio
async def test_turn_runtime_session_persona_persists_falls_back_and_clears(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Persona is a session preference: explicit key persists (incl. ""),
    absent key falls back to the stored preference."""
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **_kwargs):
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    monkeypatch.setattr("knorvia.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    _patch_kernel_turn(
        monkeypatch,
        {},
        items=[("agentMessage", "ok", {"call_kind": "llm_final_response"})],
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(read_l3_concat=lambda: "", emit=_noop_async),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    async def run_turn(session_id, extra):
        session, turn = await runtime.start_turn(
            {
                "type": "start_turn",
                "content": "hi",
                "session_id": session_id,
                "capability": None,
                "tools": [],
                "knowledge_bases": [],
                "attachments": [],
                "language": "en",
                "config": {},
                **extra,
            }
        )
        async for _event in runtime.subscribe_turn(turn["id"], after_seq=0):
            pass
        return session

    # Turn 1 — explicit persona: applied to the turn AND persisted.
    session = await run_turn(None, {"persona": "socratic"})
    detail = await store.get_session_with_messages(session["id"])
    assert detail["preferences"]["persona"] == "socratic"
    assert detail["messages"][0]["metadata"]["request_snapshot"]["persona"] == "socratic"

    # Turn 2 — persona key ABSENT: falls back to the stored preference, so
    # the persona keeps applying to follow-up questions in the session.
    await run_turn(session["id"], {})
    detail = await store.get_session_with_messages(session["id"])
    assert detail["preferences"]["persona"] == "socratic"
    assert detail["messages"][2]["metadata"]["request_snapshot"]["persona"] == "socratic"

    # Turn 3 — explicit "" (Default): clears the stored preference and the
    # turn runs without a persona.
    await run_turn(session["id"], {"persona": ""})
    detail = await store.get_session_with_messages(session["id"])
    assert detail["preferences"]["persona"] == ""
    assert "persona" not in detail["messages"][4]["metadata"]["request_snapshot"]


@pytest.mark.asyncio
async def test_turn_runtime_rejects_invalid_llm_selection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    monkeypatch.setattr(
        "knorvia.services.config.get_model_catalog_service",
        lambda: SimpleNamespace(load=_model_catalog),
    )

    with pytest.raises(RuntimeError, match="Invalid LLM selection"):
        await runtime.start_turn(
            {
                "type": "start_turn",
                "content": "bad model",
                "session_id": None,
                "capability": None,
                "tools": [],
                "knowledge_bases": [],
                "attachments": [],
                "language": "en",
                "config": {},
                "llm_selection": {"profile_id": "p-alt", "model_id": "m-default"},
            }
        )


@pytest.mark.asyncio
async def test_turn_runtime_allows_model_switching_within_same_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    activated: list[dict] = []
    metadata_seen: list[dict] = []

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **_kwargs):
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    # The scripted Kernel reply reflects the model the turn ran with: the
    # selection activation sets the current model before the kernel call.
    current_model = {"value": "gpt-4o-mini"}

    async def fake_start_turn(content: str, **_kwargs):
        return {
            "thread": {"id": "thr_test"},
            "turn": {
                "turn": {"id": "turn_test", "status": "completed"},
                "items": [
                    {
                        "kind": "agentMessage",
                        "payload": {
                            "text": f"Reply from {current_model['value']}",
                            "metadata": {"call_kind": "llm_final_response"},
                        },
                        "turnId": "turn_test",
                    }
                ],
            },
        }

    def fake_activate(selection):
        activated.append(dict(selection or {}))
        is_alt = (selection or {}).get("profile_id") == "p-alt"
        current_model["value"] = (
            "anthropic/claude-sonnet-4" if is_alt else "gpt-4o-mini"
        )
        return (
            SimpleNamespace(
                model=current_model["value"],
                provider_name="openrouter" if is_alt else "openai",
            ),
            object(),
        )

    monkeypatch.setattr(
        "knorvia.services.config.get_model_catalog_service",
        lambda: SimpleNamespace(load=_model_catalog),
    )
    monkeypatch.setattr(
        "knorvia.services.model_selection.runtime.activate_llm_selection",
        fake_activate,
    )
    monkeypatch.setattr(
        "knorvia.services.model_selection.runtime.reset_llm_selection",
        lambda _token: None,
    )
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr(
        "knorvia.runtime.kernel_client.start_turn_async", fake_start_turn
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=lambda: "",
            emit=_noop_async,
        ),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    first_selection = {"profile_id": "p-default", "model_id": "m-default"}
    second_selection = {"profile_id": "p-alt", "model_id": "m-alt"}

    session, first_turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "first model",
            "session_id": None,
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "config": {},
            "llm_selection": first_selection,
        }
    )
    async for _event in runtime.subscribe_turn(first_turn["id"], after_seq=0):
        pass

    same_session, second_turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "second model",
            "session_id": session["id"],
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "config": {},
            "llm_selection": second_selection,
        }
    )
    async for _event in runtime.subscribe_turn(second_turn["id"], after_seq=0):
        pass

    detail = await store.get_session_with_messages(session["id"])
    assert same_session["id"] == session["id"]
    assert detail is not None
    assert detail["preferences"]["llm_selection"] == second_selection
    assert activated == [first_selection, second_selection]
    # Each turn's reply reflects the model that turn ran with.
    assistant_messages = [
        message for message in detail["messages"] if message["role"] == "assistant"
    ]
    assert assistant_messages[0]["content"] == "Reply from gpt-4o-mini"
    assert assistant_messages[1]["content"] == "Reply from anthropic/claude-sonnet-4"
    user_messages = [message for message in detail["messages"] if message["role"] == "user"]
    assert user_messages[0]["metadata"]["request_snapshot"]["llmSelection"] == first_selection
    assert user_messages[1]["metadata"]["request_snapshot"]["llmSelection"] == second_selection


@pytest.mark.asyncio
async def test_regenerate_reuses_snapshot_or_override_llm_selection(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    captured_payloads: list[dict] = []

    class CapturingRuntime(TurnRuntimeManager):
        async def start_turn(self, payload: dict):
            captured_payloads.append(payload)
            return {"id": payload["session_id"]}, {"id": "turn-test"}

    runtime = CapturingRuntime(store)
    session = await store.create_session(session_id="session-with-snapshot")
    await store.update_session_preferences(
        session["id"],
        {"llm_selection": {"profile_id": "p-default", "model_id": "m-default"}},
    )
    await store.add_message(
        session_id=session["id"],
        role="user",
        content="again",
        capability="chat",
        metadata={
            "request_snapshot": {
                "content": "again",
                "llmSelection": {"profile_id": "p-alt", "model_id": "m-alt"},
            }
        },
    )

    await runtime.regenerate_last_turn(session["id"])
    assert captured_payloads[-1]["llm_selection"] == {
        "profile_id": "p-alt",
        "model_id": "m-alt",
    }

    await runtime.regenerate_last_turn(
        session["id"],
        overrides={"llm_selection": {"profile_id": "p-default", "model_id": "m-default"}},
    )
    assert captured_payloads[-1]["llm_selection"] == {
        "profile_id": "p-default",
        "model_id": "m-default",
    }


@pytest.mark.asyncio
async def test_turn_runtime_bootstraps_question_followup_context_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, object] = {}

    class FakeContextBuilder:
        def __init__(self, session_store, *_args, **_kwargs) -> None:
            self.store = session_store

        async def build(self, **kwargs):
            messages = await self.store.get_messages_for_context(kwargs["session_id"])
            captured["history_messages"] = messages
            return SimpleNamespace(
                conversation_history=[
                    {"role": item["role"], "content": item["content"]} for item in messages
                ],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    _patch_kernel_turn(
        monkeypatch,
        captured,
        items=[
            (
                "agentMessage",
                "Let's discuss this question.",
                {"call_kind": "llm_final_response"},
            )
        ],
    )
    monkeypatch.setattr("knorvia.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=lambda: "",
            emit=_noop_async,
        ),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "Why is my answer wrong?",
            "session_id": None,
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "config": {
                "followup_question_context": {
                    "parent_quiz_session_id": "quiz_session_1",
                    "question_id": "q_2",
                    "question_type": "choice",
                    "difficulty": "hard",
                    "concentration": "win-rate comparison",
                    "question": "Which criterion best describes density?",
                    "options": {
                        "A": "Coverage",
                        "B": "Informative value",
                        "C": "Relevant content without redundancy",
                        "D": "Credibility",
                    },
                    "user_answer": "B",
                    "correct_answer": "C",
                    "explanation": "Density focuses on including relevant content without redundancy.",
                    "knowledge_context": "Density measures whether content is relevant and non-redundant.",
                }
            },
        }
    )

    events = []
    async for event in runtime.subscribe_turn(turn["id"], after_seq=0):
        events.append(event)

    # session_meta may arrive after `done` from the title generator —
    # filter it out so the timing race doesn't flake the assertion.
    assert [e["type"] for e in events if e["type"] != "session_meta"] == [
        "session",
        "content",
        "result",
        "done",
    ]
    detail = await store.get_session_with_messages(session["id"])
    assert detail is not None
    assert [message["role"] for message in detail["messages"]] == ["system", "user", "assistant"]
    assert "Question Follow-up Context" in detail["messages"][0]["content"]
    assert "Which criterion best describes density?" in detail["messages"][0]["content"]
    assert "User answer: B" in detail["messages"][0]["content"]
    # The follow-up context rides the persisted request snapshot; the Kernel
    # turn receives the raw user message.
    snapshot = detail["messages"][1]["metadata"]["request_snapshot"]
    assert "followup_question_context" not in (snapshot.get("config") or {})
    assert captured["kernel_calls"] == ["Why is my answer wrong?"]


@pytest.mark.asyncio
async def test_turn_runtime_rejects_deep_research_without_explicit_config(
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)

    with pytest.raises(RuntimeError, match="Invalid deep research config"):
        await runtime.start_turn(
            {
                "type": "start_turn",
                "content": "research transformers",
                "session_id": None,
                "capability": "deep_research",
                "tools": ["rag"],
                "knowledge_bases": ["research-kb"],
                "attachments": [],
                "language": "en",
                "config": {},
            }
        )


@pytest.mark.asyncio
async def test_turn_runtime_persists_deep_research_session_preference(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **_kwargs):
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    _patch_kernel_turn(
        monkeypatch,
        {},
        items=[
            (
                "agentMessage",
                "Research report ready.",
                {"call_kind": "llm_final_response"},
            )
        ],
    )
    monkeypatch.setattr("knorvia.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=lambda: "",
            emit=_noop_async,
        ),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "research transformers",
            "session_id": None,
            "capability": "deep_research",
            "tools": ["rag", "web_search"],
            "knowledge_bases": ["research-kb"],
            "attachments": [],
            "language": "en",
            "config": {
                "mode": "report",
                "depth": "standard",
            },
        }
    )

    events = []
    async for event in runtime.subscribe_turn(turn["id"], after_seq=0):
        events.append(event)

    # session_meta may arrive after `done` from the title generator —
    # filter it out so the timing race doesn't flake the assertion.
    assert [e["type"] for e in events if e["type"] != "session_meta"] == [
        "session",
        "content",
        "result",
        "done",
    ]
    detail = await store.get_session_with_messages(session["id"])
    assert detail is not None
    assert detail["preferences"]["capability"] == "deep_research"
    assert detail["preferences"]["tools"] == ["rag", "web_search"]


@pytest.mark.asyncio
async def test_turn_runtime_injects_memory_and_refreshes_after_completion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, object] = {}

    class FakeContextBuilder:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def build(self, **_kwargs):
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="Recent chat summary",
                token_count=0,
                budget=0,
            )

    _patch_kernel_turn(
        monkeypatch,
        captured,
        items=[("agentMessage", "Stored reply", {"call_kind": "llm_final_response"})],
    )

    emit_calls: list[object] = []
    memory_reads: list[str] = []

    async def fake_emit(event):
        emit_calls.append(event)
        return None

    def fake_read_l3_concat():
        memory_reads.append("l3")
        return "## Memory\n## Preferences\n- Prefer concise answers."

    monkeypatch.setattr("knorvia.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "knorvia.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr(
        "knorvia.services.memory.get_memory_store",
        lambda: SimpleNamespace(
            read_l3_concat=fake_read_l3_concat,
            emit=fake_emit,
        ),
    )
    monkeypatch.setattr("knorvia.services.skill.get_skill_service", _fake_skill_service)
    monkeypatch.setattr("knorvia.services.persona.get_persona_service", _fake_persona_service)

    _session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "hello, i'm frank",
            "session_id": None,
            "capability": None,
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "memory_references": ["preferences"],
            "language": "en",
            "config": {},
        }
    )

    async for _event in runtime.subscribe_turn(turn["id"], after_seq=0):
        pass

    # The turn reads the memory L3 for context; the refresh is the
    # write_memory tool's job (Kernel/pack side), not a post-turn hook here.
    assert memory_reads == ["l3"]
    assert captured["kernel_calls"] == ["hello, i'm frank"]
