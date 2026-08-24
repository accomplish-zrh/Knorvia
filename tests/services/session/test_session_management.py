"""Session management: pinned / archived flags, FTS search, export.

Covers the first-tier sidebar upgrade end to end through the store API
(the HTTP layer is a thin pass-through verified by smoke tests).
"""

from __future__ import annotations

import pytest

from knorvia.services.session.sqlite_store import SQLiteSessionStore


@pytest.fixture()
def store(tmp_path):
    return SQLiteSessionStore(tmp_path / "history")


async def _seed(store: SQLiteSessionStore, text: str = "sourdough starter recipe") -> str:
    sess = await store.ensure_session()
    sid = sess["id"]
    await store.add_message(sid, "user", f"How do I use my {text}?")
    await store.add_message(sid, "assistant", "Feed it daily and bake tomorrow.")
    return sid


@pytest.mark.asyncio
async def test_new_sessions_start_unpinned_and_active(store: SQLiteSessionStore) -> None:
    sid = await _seed(store)
    got = await store.get_session(sid)
    assert got["pinned"] == 0
    assert got["archived_at"] is None
    sessions = await store.list_sessions()
    assert any(s["id"] == sid for s in sessions)


@pytest.mark.asyncio
async def test_pin_flips_flag_and_sorts_first(store: SQLiteSessionStore) -> None:
    old_sid = await _seed(store, "older chat about pasta")
    pinned_sid = await _seed(store, "newer chat about bread")

    # Both sessions get fresh updated_at; pinning must dominate recency.
    await store.update_session_title(old_sid, "Pasta")
    assert await store.set_session_pinned(pinned_sid, True)

    got = await store.get_session(pinned_sid)
    assert got["pinned"] == 1

    sessions = await store.list_sessions(limit=10)
    assert sessions[0]["id"] == pinned_sid, "pinned session must sort first"
    assert all(s.get("pinned") in (0, 1, None) for s in sessions)


@pytest.mark.asyncio
async def test_archive_hides_from_default_but_keeps_via_flag(
    store: SQLiteSessionStore,
) -> None:
    sid = await _seed(store)

    assert await store.set_session_archived(sid, True)
    got = await store.get_session(sid)
    assert got["archived_at"] is not None
    # Archived session must still appear with include_archived=True...
    sessions_all = await store.list_sessions(include_archived=True)
    assert any(s["id"] == sid for s in sessions_all)
    # ...and be hidden from the default list.
    sessions_default = await store.list_sessions()
    assert not any(s["id"] == sid for s in sessions_default)

    # Unarchive restores it.
    assert await store.set_session_archived(sid, False)
    got = await store.get_session(sid)
    assert got["archived_at"] is None
    sessions_default = await store.list_sessions()
    assert any(s["id"] == sid for s in sessions_default)


@pytest.mark.asyncio
async def test_search_finds_message_content_with_snippet(
    store: SQLiteSessionStore,
) -> None:
    sid = await _seed(store, "unique-quantum-fox topic")
    hits = await store.search_sessions("quantum-fox")
    assert len(hits) == 1
    hit = hits[0]
    assert hit["session_id"] == sid
    assert hit["match_in"] == "message"
    assert "quantum" in (hit["snippet"] or "").lower()


@pytest.mark.asyncio
async def test_search_falls_back_to_title_match(store: SQLiteSessionStore) -> None:
    sid = await _seed(store)
    await store.update_session_title(sid, "Zephyr Baking Notes")
    # A token that appears only in the title, not the messages.
    hits = await store.search_sessions("Zephyr")
    assert len(hits) == 1
    assert hits[0]["match_in"] == "title"


@pytest.mark.asyncio
async def test_search_includes_archived_sessions(store: SQLiteSessionStore) -> None:
    sid = await _seed(store, "hidden-gem conversation")
    await store.set_session_archived(sid, True)
    hits = await store.search_sessions("hidden-gem")
    assert len(hits) == 1


@pytest.mark.asyncio
async def test_search_is_quoted_so_fts_syntax_is_literal(
    store: SQLiteSessionStore,
) -> None:
    await _seed(store)
    # FTS5 operators would raise OperationalError if passed through raw.
    hits = await store.search_sessions('bread OR (bake AND "ferment")')
    assert isinstance(hits, list)


@pytest.mark.asyncio
async def test_export_returns_full_transcript(store: SQLiteSessionStore) -> None:
    sid = await _seed(store)
    data = await store.export_session(sid)
    assert data is not None
    assert data["session"]["title"]
    roles = [m["role"] for m in data["messages"]]
    assert roles == ["user", "assistant"]
    assert "sourdough" in data["messages"][0]["content"]


@pytest.mark.asyncio
async def test_export_missing_session_returns_none(store: SQLiteSessionStore) -> None:
    assert await store.export_session("nope-does-not-exist") is None
