"""Partner session reactions (grok-bot parity): sidecar toggle + merge."""

from __future__ import annotations

import pytest

from knorvia.services.partners.sessions import PartnerSessionStore


@pytest.fixture
def store(tmp_path) -> PartnerSessionStore:
    return PartnerSessionStore(tmp_path / "sessions")


def _seed(store: PartnerSessionStore) -> tuple[str, str, str]:
    """One user + two assistant messages; returns (session, first_id, second_id)."""
    store.append("telegram:42", "user", "hi")
    store.append("telegram:42", "assistant", "first answer")
    store.append("telegram:42", "assistant", "second answer")
    records = store.messages("telegram:42")
    return "telegram:42", records[0]["message_id"], records[1]["message_id"]


class TestReactions:
    def test_append_stamps_message_ids(self, store: PartnerSessionStore):
        store.append("telegram:42", "user", "hi")
        records = store.messages("telegram:42")
        assert records[0]["message_id"]

    def test_toggle_adds_and_removes(self, store: PartnerSessionStore):
        session, message_id, _ = _seed(store)
        first = store.toggle_reaction(session, message_id, "👍")
        assert first == [{"emoji": "👍", "by": "me"}]
        again = store.toggle_reaction(session, message_id, "👍")
        assert again == []

    def test_unknown_message_returns_none(self, store: PartnerSessionStore):
        session, _, _ = _seed(store)
        assert store.toggle_reaction(session, "ghost", "👍") is None
        assert store.toggle_reaction(session, "", "") is None

    def test_attach_reactions_merges_into_messages(self, store: PartnerSessionStore):
        session, first_id, _ = _seed(store)
        store.toggle_reaction(session, first_id, "🚀")
        merged = store.attach_reactions(session, store.messages(session))
        assert merged[0]["reactions"] == [{"emoji": "🚀", "by": "me"}]
        assert "reactions" not in merged[1]

    def test_attach_without_reactions_is_unchanged(self, store: PartnerSessionStore):
        session, _, _ = _seed(store)
        records = store.messages(session)
        assert store.attach_reactions(session, records) == records

    def test_delete_session_cleans_reactions(self, store: PartnerSessionStore):
        session, message_id, _ = _seed(store)
        store.toggle_reaction(session, message_id, "👍")
        assert store.delete_session(session) is True
        assert store.reactions_for_session(session) == {}

    def test_archived_rename_keeps_reactions_on_old_stem(self, store: PartnerSessionStore):
        session, message_id, _ = _seed(store)
        store.toggle_reaction(session, message_id, "👍")
        archived = store.archive(session)
        assert archived is not None
        # The archived file (renamed stem) keeps its reactions; the fresh key
        # starts clean — the sidecar is keyed by the same stem the file has.
        assert store.reactions_for_session(archived["session_key"]) != {}
