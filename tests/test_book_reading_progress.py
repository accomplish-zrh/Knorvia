# -*- coding: utf-8 -*-
"""Book progress e2e test (store-level, no LLM)."""
import os
import tempfile

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="book_prog_"))

from knorvia.book.engine import get_book_engine  # noqa: E402


def test_visit_bookmark_completion(tmp_path):
    engine = get_book_engine()
    # Directly exercise progress storage without a full book build.
    book_id = "bk_test_progress"

    async def drive():
        await engine.mark_page_visited(book_id, "pg_001")
        await engine.mark_page_visited(book_id, "pg_002")
        state = await engine.toggle_page_bookmark(book_id, "pg_001")
        assert state.bookmarked_page_ids == ["pg_001"]
        # Idempotent visit.
        await engine.mark_page_visited(book_id, "pg_001")
        report = engine.completion_report(book_id)
        assert report["visited"] == 2
        assert report["bookmarks"] == 1
        # Unbookmark path.
        state2 = await engine.toggle_page_bookmark(book_id, "pg_001")
        assert state2.bookmarked_page_ids == []
        # current_page_id follows the latest visit.
        assert engine.load_progress(book_id).current_page_id == "pg_001"
