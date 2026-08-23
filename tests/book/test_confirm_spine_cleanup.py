"""Regression tests for confirm_spine page-shell hygiene.

Re-confirming an edited spine reused page shells by chapter_id but never
refreshed title/order and never deleted shells of chapters that were
removed from the spine. An orphaned PENDING shell pins the book out of
READY forever: finalization requires ALL pages READY.
"""

from __future__ import annotations

import pytest

from knorvia.book.engine import BookEngine
from knorvia.book.models import (
    Book,
    BookStatus,
    Chapter,
    ContentType,
    Page,
    PageStatus,
    Spine,
)


class _FakeStorage:
    def __init__(self) -> None:
        self.pages: dict[str, Page] = {}
        self.saved_pages: list[Page] = []
        self.deleted: list[str] = []
        self.saved_books: list[Book] = []

    def load_book(self, book_id: str) -> Book | None:
        return self.book

    def save_book(self, book: Book) -> None:
        self.saved_books.append(book)

    def load_spine(self, book_id: str) -> Spine | None:
        return self.spine

    def save_spine(self, spine: Spine) -> None:
        self.spine = spine

    def list_pages(self, book_id: str) -> list[Page]:
        return list(self.pages.values())

    def save_page(self, page: Page) -> None:
        self.pages[page.id] = page
        self.saved_pages.append(page)

    def delete_page(self, book_id: str, page_id: str) -> None:
        self.pages.pop(page_id, None)
        self.deleted.append(page_id)

    def append_log(self, *args, **kwargs) -> None:
        return None


def _make_engine(storage: _FakeStorage) -> BookEngine:
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    return engine


def _chapter(ch_id: str, title: str, order: int) -> Chapter:
    return Chapter(
        id=ch_id,
        title=title,
        learning_objectives=[],
        content_type=ContentType.THEORY,
        order=order,
    )


def _spine(*chapters: Chapter) -> Spine:
    from knorvia.book.models import ConceptGraph

    return Spine(book_id="book-1", chapters=list(chapters), concept_graph=ConceptGraph(nodes=[]))


def _book() -> Book:
    return Book(
        id="book-1",
        title="Test Book",
        language="en",
        knowledge_bases=[],
        proposal=None,
        spine=None,
        pages=[],
        status=BookStatus.SPINE_READY,
        created_at=0.0,
        updated_at=0.0,
    )


@pytest.mark.asyncio
async def test_confirm_spine_deletes_orphan_page_shells() -> None:
    storage = _FakeStorage()
    storage.book = _book()
    storage.spine = _spine(_chapter("c-overview", "How to read", 0), _chapter("c-kept", "Kept", 1))
    # Old run had pages for a chapter that no longer exists in the spine.
    storage.pages = {
        "p-overview": Page(
            id="p-overview",
            book_id="book-1",
            chapter_id="c-overview",
            title="How to read",
            order=0,
            status=PageStatus.READY,
        ),
        "p-kept": Page(
            id="p-kept",
            book_id="book-1",
            chapter_id="c-kept",
            title="Kept",
            order=1,
            status=PageStatus.PENDING,
        ),
        "p-orphan": Page(
            id="p-orphan",
            book_id="book-1",
            chapter_id="c-gone",
            title="Removed",
            order=2,
            status=PageStatus.PENDING,
        ),
    }
    engine = _make_engine(storage)

    pages = await engine.confirm_spine(book_id="book-1", auto_compile=False)

    assert "p-orphan" in storage.deleted
    assert "p-orphan" not in storage.pages
    seen = {p.chapter_id for p in pages}
    assert "c-gone" not in seen
    assert "p-kept" in storage.pages


@pytest.mark.asyncio
async def test_confirm_spine_refreshes_reused_page_title_and_order() -> None:
    storage = _FakeStorage()
    storage.book = _book()
    storage.spine = _spine(
        _chapter("c-overview", "How to read", 0),
        _chapter("c-renamed", "New Title", 5),
    )
    storage.pages = {
        "p-overview": Page(
            id="p-overview",
            book_id="book-1",
            chapter_id="c-overview",
            title="How to read",
            order=0,
            status=PageStatus.READY,
        ),
        "p-renamed": Page(
            id="p-renamed",
            book_id="book-1",
            chapter_id="c-renamed",
            title="Old Title",
            order=2,
            status=PageStatus.PENDING,
        ),
    }
    engine = _make_engine(storage)

    await engine.confirm_spine(book_id="book-1", auto_compile=False)

    updated = storage.pages["p-renamed"]
    assert updated.title == "New Title"
    # Overview injection re-numbers existing chapters down by one (0 -> 1),
    # so the edited chapter's page should follow the chapter's order: 6.
    assert updated.order == 6
