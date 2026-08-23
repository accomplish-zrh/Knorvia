from __future__ import annotations

import pytest

from knorvia.services.creative_library.canvas import add_canvas_node, empty_library_canvas
from knorvia.services.creative_library.store import CreativeLibraryStore
from knorvia.tools.library_tool import LibraryTool


@pytest.mark.asyncio
async def test_library_tool_lists_reads_and_writes(tmp_path, monkeypatch) -> None:
    store = CreativeLibraryStore(tmp_path)
    monkeypatch.setattr(
        "knorvia.services.creative_library.store.get_creative_library_store",
        lambda: store,
    )
    tool = LibraryTool()
    created = await tool.execute(create_kind="markdown", title="Spec", content="draft v1")
    assert created.success, created.content
    entry_id = created.metadata["library_entry_id"]
    listed = await tool.execute(list=True)
    assert listed.success
    assert listed.content.startswith("Personal library:")
    assert entry_id in listed.content
    read = await tool.execute(read_id=entry_id)
    assert "draft v1" in read.content
    written = await tool.execute(write_id=entry_id, content="draft v2")
    assert written.success
    assert store.get_entry(entry_id)["content"] == "draft v2"


@pytest.mark.asyncio
async def test_library_tool_creates_reads_and_writes_word_and_excel(tmp_path, monkeypatch) -> None:
    store = CreativeLibraryStore(tmp_path)
    monkeypatch.setattr(
        "knorvia.services.creative_library.store.get_creative_library_store",
        lambda: store,
    )
    tool = LibraryTool()
    word = await tool.execute(create_kind="word", title="Memo", content="agent-word-v1")
    excel = await tool.execute(create_kind="excel", title="Sheet", content="agent-excel-v1")
    assert word.success, word.content
    assert excel.success, excel.content
    word_id = word.metadata["library_entry_id"]
    excel_id = excel.metadata["library_entry_id"]
    listed = await tool.execute(list=True)
    assert listed.content.startswith("Personal library:")
    assert "word" in listed.content
    assert "excel" in listed.content
    assert "team space" not in listed.content.lower()
    read_word = await tool.execute(read_id=word_id)
    read_excel = await tool.execute(read_id=excel_id)
    assert "agent-word-v1" in read_word.content
    assert "agent-excel-v1" in read_excel.content
    await tool.execute(write_id=word_id, content="agent-word-v2")
    await tool.execute(write_id=excel_id, content="agent-excel-v2")
    assert store.get_entry(word_id)["content"] == "agent-word-v2"
    assert store.get_entry(excel_id)["content"] == "agent-excel-v2"
    from knorvia.services.creative_library.office import extract_library_office

    word_bytes = store.entry_bytes(word_id)
    excel_bytes = store.entry_bytes(excel_id)
    assert word_bytes is not None and excel_bytes is not None
    assert extract_library_office("word", word_bytes[0]) == "agent-word-v2"
    assert extract_library_office("excel", excel_bytes[0]) == "agent-excel-v2"


def test_library_canvas_add_node_roundtrip() -> None:
    document = add_canvas_node(empty_library_canvas(), title="Card", text="hello")
    assert len(document["nodes"]) == 1
    assert document["nodes"][0]["text"] == "hello"
    assert document["revision"] == 1
