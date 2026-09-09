"""Server-authorized source resolution for the Office artifact runtime.

The model never names local paths, session ids or user ids. It only sees
opaque refs (``attachment:<id>``, ``library:<entry-id>``,
``workspace:<rel-ref>``, ``generated:new``); this module is the only place
that turns them into bytes — and every byte stream passes a strict ZIP /
OOXML safety screening before it can become a draft artifact.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import io
from pathlib import Path
from typing import Any
import zipfile

from knorvia.services.office_artifacts.contracts import (
    OFFICE_SUFFIXES,
    SourceRef,
    SourceResolutionError,
    SourceVerificationError,
    parse_source_ref,
)

OFFICE_MIME_SUFFIXES: dict[str, tuple[str, ...]] = {
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
    ),
    ".xlsm": (
        "application/vnd.ms-excel.sheet.macroEnabled.12",
        "application/octet-stream",
    ),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/octet-stream",
    ),
    ".pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/octet-stream",
    ),
}

OOXML_MAGIC = b"PK\x03\x04"

MAX_ZIP_ENTRIES = 512
MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 200


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class ResolvedSource:
    """Bytes plus provenance for one resolved office source."""

    kind: str
    origin_ref: str
    filename: str
    mime: str
    base_hash: str
    data: bytes | None  # None only for generated:new
    library_entry_id: str = ""
    workspace_relative: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class SourceContext:
    """Everything the resolver needs, injected server-side per turn/request."""

    session_id: str = ""
    attachment_manifest: list[dict[str, str]] = field(default_factory=list)
    path_service: Any | None = None
    attachment_store: Any | None = None
    library_store: Any | None = None

    def attachment_by_id(self, attachment_id: str) -> dict[str, str] | None:
        wanted = str(attachment_id or "").strip()
        for item in self.attachment_manifest:
            if str(item.get("id") or "") == wanted:
                return item
        return None


def screen_zip_bytes(data: bytes, *, filename: str = "") -> None:
    """Fail closed on anything that is not a safe, plain OOXML ZIP package."""
    if not data.startswith(OOXML_MAGIC):
        raise SourceVerificationError(
            f"{filename or 'source'} is not an OOXML package (missing ZIP signature)"
        )
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as bundle:
            infos = bundle.infolist()
            if not infos or len(infos) > MAX_ZIP_ENTRIES:
                raise SourceVerificationError(
                    f"{filename or 'source'} has an unacceptable entry count"
                )
            names: set[str] = set()
            total = 0
            for info in infos:
                name = info.filename
                normalised = name.replace("\\", "/")
                if (
                    not normalised
                    or normalised.startswith("/")
                    or ".." in Path(normalised).parts
                    or ":" in normalised
                ):
                    raise SourceVerificationError(
                        f"unsafe ZIP entry name {name!r} in {filename or 'source'}"
                    )
                if name in names:
                    raise SourceVerificationError(
                        f"duplicate ZIP entry {name!r} in {filename or 'source'}"
                    )
                names.add(name)
                if info.flag_bits & 0x1:
                    raise SourceVerificationError(
                        f"encrypted ZIP entry {name!r} is not supported"
                    )
                if info.file_size > MAX_ZIP_ENTRY_BYTES:
                    raise SourceVerificationError(f"ZIP entry {name!r} is too large")
                total += info.file_size
                if total > MAX_ZIP_TOTAL_BYTES:
                    raise SourceVerificationError(
                        f"{filename or 'source'} decompresses beyond the size limit"
                    )
                if info.compress_size and info.file_size / max(info.compress_size, 1) > MAX_ZIP_COMPRESSION_RATIO:
                    raise SourceVerificationError(
                        f"ZIP entry {name!r} has an abnormal compression ratio"
                    )
                if normalised.lower().endswith(".xml") or normalised.lower().endswith(".rels"):
                    try:
                        head = bundle.open(name, "r").read(65536)
                    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
                        raise SourceVerificationError(
                            f"ZIP entry {name!r} could not be read"
                        ) from exc
                    if b"<!ENTITY" in head or b"<!DOCTYPE" in head:
                        raise SourceVerificationError(
                            f"ZIP entry {name!r} declares DTD entities, which are refused"
                        )
    except zipfile.BadZipFile as exc:
        raise SourceVerificationError(f"{filename or 'source'} is a corrupt ZIP") from exc


def _suffix_of(filename: str) -> str:
    return Path(filename).suffix.lower()


def _require_office_suffix(filename: str) -> str:
    suffix = _suffix_of(filename)
    if suffix not in OFFICE_SUFFIXES:
        raise SourceVerificationError(
            f"unsupported file type {filename!r}; allowed: {', '.join(OFFICE_SUFFIXES)}"
        )
    return suffix


def _mime_allowed(suffix: str, mime: str) -> bool:
    allowed = OFFICE_MIME_SUFFIXES.get(suffix, ())
    return (str(mime or "").lower() in allowed) or not str(mime or "").strip()


def resolve_source(ref: SourceRef | str, context: SourceContext) -> ResolvedSource:
    """Turn an opaque ref into authorized bytes (or a generated placeholder)."""
    parsed = ref if isinstance(ref, SourceRef) else parse_source_ref(ref)

    if parsed.kind == "generated":
        return ResolvedSource(
            kind="generated",
            origin_ref="generated:new",
            filename="",
            mime="",
            base_hash="",
            data=None,
        )

    if parsed.kind == "attachment":
        manifest_item = context.attachment_by_id(parsed.opaque_id)
        if manifest_item is None:
            raise SourceResolutionError(
                f"attachment {parsed.opaque_id!r} is not part of this conversation"
            )
        filename = str(manifest_item.get("filename") or "").strip()
        suffix = _require_office_suffix(filename)
        mime = str(manifest_item.get("mime") or "")
        if not _mime_allowed(suffix, mime):
            raise SourceVerificationError(
                f"attachment {filename!r} has unexpected MIME {mime!r} for {suffix}"
            )
        store = context.attachment_store
        if store is None:
            from knorvia.services.storage.attachment_store import get_attachment_store

            store = get_attachment_store()
        target = store.resolve_path(
            session_id=context.session_id,
            attachment_id=parsed.opaque_id,
            filename=filename,
        )
        if target is None or not Path(target).is_file():
            raise SourceResolutionError(
                f"attachment {filename!r} could not be located in this session"
            )
        data = Path(target).read_bytes()
        screen_zip_bytes(data, filename=filename)
        return ResolvedSource(
            kind="attachment",
            origin_ref=parsed.as_string,
            filename=filename,
            mime=mime,
            base_hash=sha256_hex(data),
            data=data,
            meta={"manifest_item": dict(manifest_item)},
        )

    if parsed.kind == "library":
        store = context.library_store
        if store is None:
            from knorvia.services.creative_library.store import get_creative_library_store

            store = get_creative_library_store()
        entry = store.get_entry(parsed.opaque_id, include_content=False)
        if not entry:
            raise SourceResolutionError(
                f"library entry {parsed.opaque_id!r} does not exist for this user"
            )
        filename = str(
            entry.get("title") or entry.get("name") or entry.get("filename") or "library.xlsx"
        ).strip()
        kind = str(entry.get("kind") or "").strip().lower()
        kind_suffix = {"excel": ".xlsx", "word": ".docx", "ppt": ".pptx"}.get(kind, "")
        if not _suffix_of(filename):
            filename = (filename or "library") + (kind_suffix or ".xlsx")
        suffix = _require_office_suffix(filename)
        payload = store.entry_bytes(parsed.opaque_id)
        if not payload:
            raise SourceResolutionError(
                f"library entry {parsed.opaque_id!r} has no stored bytes"
            )
        data, mime = payload[0], str(payload[1] or "")
        screen_zip_bytes(data, filename=filename)
        return ResolvedSource(
            kind="library",
            origin_ref=parsed.as_string,
            filename=filename,
            mime=mime,
            base_hash=sha256_hex(data),
            data=data,
            library_entry_id=parsed.opaque_id,
            meta={"entry": {k: entry.get(k) for k in ("title", "kind", "mime", "updated_at")}},
        )

    # workspace:<relative-ref under the current user's public outputs root>
    resolved = resolve_workspace_target(context, parsed.as_string)
    filename = Path(resolved).name
    suffix = _require_office_suffix(filename)
    data = Path(resolved).read_bytes()
    screen_zip_bytes(data, filename=filename)
    return ResolvedSource(
        kind="workspace",
        origin_ref=parsed.as_string,
        filename=filename,
        mime="",
        base_hash=sha256_hex(data),
        data=data,
        workspace_relative=Path(resolved).name,
        meta={"absolute_path": str(resolved)},
    )


def resolve_workspace_target(context: SourceContext, origin_ref: str) -> Path:
    """The exact file behind a ``workspace:`` source ref.

    Resolution goes through the path service, which authorizes the candidate
    and returns its canonical path. Callers must not rebuild the path from a
    root of their own: the source can sit in a nested directory under a
    different root than the draft's workspace.
    """
    raw = str(origin_ref or "").strip()
    if raw.startswith("workspace:"):
        raw = raw[len("workspace:") :]
    if raw.startswith("/api/outputs/"):
        raw = raw[len("/api/outputs/") :]
    if not raw:
        raise SourceResolutionError("workspace source ref names no file")
    service = context.path_service
    if service is None:
        from knorvia.services.path_service import get_path_service

        service = get_path_service()
    resolved = service.resolve_public_output_path(raw)
    if resolved is None or not Path(resolved).is_file():
        raise SourceResolutionError(
            f"workspace file {raw!r} is not an allowed output of this user"
        )
    return Path(resolved)
