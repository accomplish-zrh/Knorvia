"""Chat tool for the personal library tree (MD / CSV / HTML / canvas / files)."""

from __future__ import annotations

from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from knorvia.tools.prompting import load_prompt_hints


class LibraryTool(BaseTool):
    """Read and write the user's personal library. No team spaces."""

    def get_prompt_hints(self, language: str = "en"):
        return load_prompt_hints(self.name, language=language)

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="library",
            description=(
                "Use the personal library: a single folder tree of markdown, CSV, "
                "HTML, Word (.docx), Excel (.xlsx), canvas boards, and uploaded "
                "files. list=true prints the tree. read_id returns one document. "
                "create_kind+title writes a new markdown/csv/html/word/excel/"
                "canvas/folder/text. write_id+content updates a text or Office "
                "document. There are no team documents."
            ),
            parameters=[
                ToolParameter(
                    name="list",
                    type="boolean",
                    description="If true, list the library tree (ids, kinds, titles).",
                    required=False,
                ),
                ToolParameter(
                    name="read_id",
                    type="string",
                    description="Library entry id to read.",
                    required=False,
                ),
                ToolParameter(
                    name="write_id",
                    type="string",
                    description="Library entry id to overwrite (text documents only).",
                    required=False,
                ),
                ToolParameter(
                    name="create_kind",
                    type="string",
                    description="Create a new entry: folder, markdown, csv, html, word, excel, canvas, text.",
                    required=False,
                    enum=["folder", "markdown", "csv", "html", "word", "excel", "canvas", "text"],
                ),
                ToolParameter(
                    name="title",
                    type="string",
                    description="Title for create, or rename when writing.",
                    required=False,
                ),
                ToolParameter(
                    name="parent_id",
                    type="string",
                    description="Optional folder id for create.",
                    required=False,
                ),
                ToolParameter(
                    name="content",
                    type="string",
                    description="Document body for create or write.",
                    required=False,
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.services.creative_library.store import get_creative_library_store

        store = get_creative_library_store()
        list_raw = kwargs.get("list")
        if isinstance(list_raw, str):
            list_tree = list_raw.strip().lower() in {"1", "true", "yes"}
        else:
            list_tree = bool(list_raw)
        read_id = str(kwargs.get("read_id") or "").strip()
        write_id = str(kwargs.get("write_id") or "").strip()
        create_kind = str(kwargs.get("create_kind") or "").strip()
        title = str(kwargs.get("title") or "").strip()
        parent_id = str(kwargs.get("parent_id") or "").strip() or None
        content = str(kwargs.get("content") or "")

        if list_tree or (not read_id and not write_id and not create_kind):
            tree = store.list_tree()
            return ToolResult(
                content=_render_tree(tree.get("items") or []),
                success=True,
                metadata={"library_total": tree.get("total") or 0, "jobs_created": 0},
            )
        if create_kind:
            try:
                entry = store.create_entry(
                    kind=create_kind,
                    title=title or "",
                    parent_id=parent_id,
                    content=content,
                )
            except (KeyError, ValueError) as exc:
                return ToolResult(content=str(exc), success=False)
            return ToolResult(
                content=f"Created {entry['kind']} {entry['id']} · {entry['title']}",
                success=True,
                metadata={"library_entry_id": entry["id"], "jobs_created": 0},
            )
        if write_id:
            try:
                patch: dict[str, Any] = {"content": content}
                if title:
                    patch["title"] = title
                entry = store.update_entry(write_id, patch)
            except KeyError:
                return ToolResult(content="Library entry not found.", success=False)
            except ValueError as exc:
                return ToolResult(content=str(exc), success=False)
            return ToolResult(
                content=f"Updated {entry['kind']} {entry['id']} · {entry['title']}",
                success=True,
                metadata={"library_entry_id": entry["id"], "jobs_created": 0},
            )
        entry = store.get_entry(read_id)
        if not entry:
            return ToolResult(content="Library entry not found.", success=False)
        body = entry.get("content") or ""
        if not body and entry["kind"] not in {
            "folder",
            "markdown",
            "csv",
            "html",
            "canvas",
            "text",
            "word",
            "excel",
        }:
            body = f"(binary {entry['kind']} · {entry['size_bytes']} bytes)"
        return ToolResult(
            content=f"# {entry['title']}\n\n{body}",
            success=True,
            metadata={"library_entry_id": entry["id"], "kind": entry["kind"], "jobs_created": 0},
        )


def _render_tree(items: list[dict[str, Any]], indent: int = 0) -> str:
    if not items and indent == 0:
        return "The personal library is empty. Create a markdown, CSV, HTML, or canvas entry."
    lines: list[str] = []
    if indent == 0:
        lines.append("Personal library:")
    prefix = "  " * indent
    for item in items:
        lines.append(f"{prefix}- {item.get('id')} · {item.get('kind')} · {item.get('title')}")
        children = item.get("children") or []
        if children:
            lines.append(_render_tree(children, indent + 1))
    return "\n".join(lines)
