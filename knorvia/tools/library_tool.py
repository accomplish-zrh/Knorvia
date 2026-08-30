"""Chat tool for the personal library tree (MD / CSV / HTML / canvas / files)."""

from __future__ import annotations

from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from knorvia.tools.prompting import load_prompt_hints

#: Agent-friendly shorthand → library mime (agents type "png", not "image/png").
_TARGET_ALIASES: dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "m4a": "audio/mp4",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "txt": "text/plain",
}


def _normalize_target(target: str) -> str:
    value = str(target or "").strip().lower().lstrip(".")
    return _TARGET_ALIASES.get(value, value)


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
                "document. convert_id (+target) converts an uploaded image/audio/"
                "video/pdf file offline into a new library entry — omit target to "
                "list the valid targets first. There are no team documents."
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
                    name="convert_id",
                    type="string",
                    description=(
                        "Library entry id of an uploaded image/audio/video/pdf file "
                        "to convert offline into a new library entry."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="target",
                    type="string",
                    description=(
                        "Conversion target for convert_id: png | jpg | webp | mp3 | "
                        "wav | ogg | m4a | mp4 | webm | txt. Omit to list valid "
                        "targets for that file."
                    ),
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

    async def _convert(
        self,
        store: Any,
        convert_id: str,
        target: str,
        title: str,
    ) -> ToolResult:
        """Offline conversion of one uploaded library file (agent-invokable).

        Without a target this reports the valid targets (capability
        discovery, so the agent can self-correct instead of guessing);
        with a target the result lands as a NEW library entry.
        """
        from knorvia.services.converters.service import (
            convert_image,
            convert_media,
            pdf_text,
            render_pdf_page_png,
            targets_for,
        )

        entry: dict[str, Any] | None = store.get_asset(convert_id)
        source_kind = "asset"
        if entry is None:
            entry = store.get_entry(convert_id)
            source_kind = "entry"
        if not entry:
            return ToolResult(content="Library entry not found.", success=False)
        mime = str(entry.get("mime") or "")
        if mime == "application/pdf" or entry.get("kind") == "pdf":
            mime = "application/pdf"
        payload = store.asset_bytes(convert_id)
        if mime.startswith("text/") or entry.get("kind") in {"markdown", "csv", "html", "text"}:
            return ToolResult(
                content="That entry is already a text document; no conversion needed.",
                success=False,
            )
        data: bytes | None = None
        if payload:
            data, file_mime = payload
        elif source_kind == "entry":
            # File-backed entries (pdf / office / file) keep their bytes in
            # the store's files/ tree, reached through entry_file_bytes.
            data_file = store.entry_file_bytes(convert_id)
            if data_file:
                data, file_mime = data_file
        if not data:
            return ToolResult(content="Library file bytes not found.", success=False)
        mime = mime or file_mime
        parent_id = entry.get("parent_id")
        source_title = str(entry.get("title") or "converted")

        def targets_line() -> str:
            valid = targets_for(mime)
            if mime == "application/pdf":
                valid = valid + [
                    {"mime": "text/plain", "ext": ".txt"},
                    {"mime": "image/png", "ext": ".png"},
                ]
            names = ", ".join(
                sorted(
                    alias
                    for alias, mime_value in _TARGET_ALIASES.items()
                    if mime_value in {v["mime"] for v in valid}
                )
            )
            return names or "no offline conversion available for this file"

        if not target:
            return ToolResult(
                content=f"Valid conversion targets for this file: {targets_line()}",
                success=True,
            )
        valid_mimes = {v["mime"] for v in targets_for(mime)}
        if mime == "application/pdf":
            valid_mimes |= {"text/plain", "image/png"}
        if target not in valid_mimes:
            return ToolResult(
                content=(
                    f"Cannot convert this file to '{target}'. Valid targets: {targets_line()}"
                ),
                success=False,
            )

        try:
            if mime == "application/pdf" and target == "text/plain":
                text = pdf_text(data)
                if not text.strip():
                    return ToolResult(
                        content="No extractable text (likely a scanned PDF).",
                        success=False,
                    )
                created = store.create_entry(
                    kind="text",
                    title=title or f"{source_title} (text)",
                    parent_id=parent_id,
                    content=text[:200000],
                    mime="text/plain",
                )
                new_kind = "text"
            elif mime == "application/pdf" and target == "image/png":
                converted = render_pdf_page_png(data)
                created = store.create_media_asset(
                    converted,
                    "image/png",
                    title=title or f"{source_title} (page 1)",
                    source="converted",
                    note=f"Converted from {mime}",
                )
                new_kind = "image"
            elif target in {"image/png", "image/jpeg", "image/webp"}:
                converted = convert_image(data, target)
                created = store.create_media_asset(
                    converted,
                    target,
                    title=title or f"{source_title} ({target.split('/')[1]})",
                    source="converted",
                    note=f"Converted from {mime}",
                )
                new_kind = "image"
            else:
                converted, target = convert_media(data, mime, target)
                created = store.create_media_asset(
                    converted,
                    target,
                    title=title or f"{source_title} ({target.split('/')[1]})",
                    source="converted",
                    note=f"Converted from {mime}",
                )
                new_kind = "audio" if target.startswith("audio/") else "video"
        except RuntimeError as exc:
            return ToolResult(content=str(exc), success=False)
        except Exception as exc:  # noqa: BLE001 - report, don't crash the turn
            return ToolResult(
                content=f"Conversion failed: {type(exc).__name__}: {exc}", success=False
            )
        return ToolResult(
            content=(
                f"Converted to a new library entry {created['id']} · {new_kind} · "
                f"{created.get('title')}"
            ),
            success=True,
            metadata={"library_entry_id": created["id"], "jobs_created": 0},
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
        convert_id = str(kwargs.get("convert_id") or "").strip()
        target = _normalize_target(str(kwargs.get("target") or ""))
        create_kind = str(kwargs.get("create_kind") or "").strip()
        title = str(kwargs.get("title") or "").strip()
        parent_id = str(kwargs.get("parent_id") or "").strip() or None
        content = str(kwargs.get("content") or "")

        if convert_id:
            return await self._convert(store, convert_id, target, title)
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
