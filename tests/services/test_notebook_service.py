"""Notebook service regression tests."""

from __future__ import annotations

import json

from knorvia.services.notebook.service import NotebookManager, RecordType


def test_add_record_accepts_enum_record_type(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("CLI test notebook")

    result = manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type=RecordType.CHAT,
        title="Sample",
        user_query="Sample",
        output="# Sample",
    )

    assert result["record"]["type"] == RecordType.CHAT

    stored = manager.get_notebook(notebook["id"])
    assert stored is not None
    assert stored["records"][0]["type"] == "chat"


def test_notebook_ids_cannot_escape_base_dir(tmp_path) -> None:
    # Regression: ids flow straight into file paths, so traversal ids like
    # "../victim" used to resolve outside the notebook store (read, write,
    # delete). They must be treated as not-found instead.
    import json as _json

    manager = NotebookManager(base_dir=str(tmp_path))

    victim = tmp_path.parent / "victim.json"
    victim.write_text(_json.dumps({"keep": True}), encoding="utf-8")
    try:
        escape_id = "../" + victim.stem

        assert manager.get_notebook(escape_id) is None
        assert manager.delete_notebook(escape_id) is False
        result = manager.add_record(
            notebook_ids=[escape_id],
            record_type="chat",
            title="Sample",
            user_query="Sample",
            output="# Sample",
        )
        assert result["added_to_notebooks"] == []
        assert victim.exists(), "traversal id must not touch files outside the store"

        for bad_id in ("..", ".", "a/b", "a\\b", "a:b", ""):
            assert manager.get_notebook(bad_id) is None
    finally:
        if victim.exists():
            victim.unlink()


def test_add_record_strips_thinking_tags_from_summary(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Sanitized notebook")

    result = manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type="chat",
        title="Sample",
        summary="<think>private reasoning</think>\nReusable summary.",
        user_query="Sample",
        output="# Sample",
    )

    assert result["record"]["summary"] == "Reusable summary."

    stored = manager.get_notebook(notebook["id"])
    assert stored is not None
    assert stored["records"][0]["summary"] == "Reusable summary."


def test_get_notebook_repairs_existing_thinking_tags_in_summary(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Legacy notebook")
    manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type="chat",
        title="Sample",
        summary="Reusable summary.",
        user_query="Sample",
        output="# Sample",
    )

    path = manager._get_notebook_file(notebook["id"])
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["records"][0]["summary"] = "<think>old reasoning</think>\nReusable summary."
    path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    repaired = manager.get_notebook(notebook["id"])
    assert repaired is not None
    assert repaired["records"][0]["summary"] == "Reusable summary."
    assert "old reasoning" not in path.read_text(encoding="utf-8")
