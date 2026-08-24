"""QuestionBankOrganizeTool: list + organize actions against the notebook."""

from __future__ import annotations

import json
import os
import tempfile

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="qb_tool_"))

import pytest  # noqa: E402

from knorvia.capabilities.mastery.tools import (  # noqa: E402
    QuestionBankOrganizeTool,
)
from knorvia.services.session import get_sqlite_session_store  # noqa: E402


def _payload(result):
    """ToolResult -> dict: prefer metadata[question_bank], fall back to content."""
    meta = getattr(result, "metadata", None) or {}
    if "question_bank" in meta:
        return {"question_bank": meta["question_bank"], "success": result.success}
    return json.loads(result.content)

def _tool() -> QuestionBankOrganizeTool:
    return QuestionBankOrganizeTool()


@pytest.mark.asyncio
async def test_organize_creates_category_and_files_entries():
    store = get_sqlite_session_store()
    session = await store.ensure_session()
    sid = session["id"]
    entry = await store.upsert_notebook_entries(
        sid,
        [
            {
                "question_id": "q1",
                "question": "What is 2+2?",
                "question_type": "choice",
                "options": {"a": "3", "b": "4"},
                "correct_answer": "b",
                "explanation": "",
                "difficulty": "easy",
                "user_answer": "a",
                "is_correct": False,
            }
        ],
    )
    assert entry == 1
    listing = await store.list_notebook_entries(limit=10)
    target_id = listing["items"][0]["id"]

    result = await _tool().execute(
        action="organize",
        category="错题本",
        entry_ids=[str(target_id)],
    )
    # ToolResult contract varies; inspect the dict form.
    assert _payload(result)["question_bank"]["category"] == "错题本"
    assert _payload(result)["question_bank"]["filed"] == 1


@pytest.mark.asyncio
async def test_list_returns_entries():
    result = await _tool().execute(action="list", only_wrong=True, limit=5)
    entries = _payload(result)["question_bank"]["entries"]
    assert isinstance(entries, list)


@pytest.mark.asyncio
async def test_unknown_action_fails_gracefully():
    result = await _tool().execute(action="explode")
    assert result.success is False
    assert _payload(result)["question_bank"].get("error")
