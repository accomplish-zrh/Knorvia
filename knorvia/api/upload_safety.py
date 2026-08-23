"""Shared validation boundary for untrusted knowledge-base uploads."""

from __future__ import annotations

import os
from pathlib import Path
import re

from fastapi import HTTPException, UploadFile

from knorvia.utils.document_validator import DocumentValidator
from knorvia.utils.error_utils import format_exception_message

BYTES_PER_GB = 1024**3
BYTES_PER_MB = 1024**2
_BAD_PATH_CHARS = re.compile(r'[\\:*?"<>|\x00-\x1f]')


def format_bytes_human_readable(size_bytes: int) -> str:
    if size_bytes >= BYTES_PER_GB:
        return f"{size_bytes / BYTES_PER_GB:.1f} GB"
    if size_bytes >= BYTES_PER_MB:
        return f"{size_bytes / BYTES_PER_MB:.1f} MB"
    return f"{size_bytes} bytes"


def sanitize_path_segment(segment: str) -> str:
    cleaned = _BAD_PATH_CHARS.sub("", segment).strip().strip(".")
    return cleaned[:128]


def sanitize_rel_subdir(rel_path: str | None) -> str:
    """Return a safe POSIX relative directory and reject traversal."""

    if not rel_path:
        return ""
    parts: list[str] = []
    for raw_segment in str(rel_path).replace("\\", "/").split("/"):
        segment = raw_segment.strip()
        if segment in ("", "."):
            continue
        if segment == "..":
            raise HTTPException(status_code=400, detail="Invalid folder path")
        safe = sanitize_path_segment(segment)
        if safe:
            parts.append(safe)
    return "/".join(parts)


def safe_join_raw(raw_dir: Path, rel_path: str) -> Path:
    target = (raw_dir / rel_path).resolve()
    try:
        target.relative_to(raw_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Access denied") from exc
    return target


def get_upload_file_size(file: UploadFile) -> int | None:
    """Best-effort byte size detection without consuming the stream."""

    try:
        current_position = file.file.tell()
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(current_position)
        return size
    except Exception:
        return None


def validate_upload_batch(
    files: list[UploadFile],
    allowed_extensions: set[str] | None = None,
    rel_paths: list[str] | None = None,
) -> list[dict[str, int | str | None]]:
    """Validate all metadata before mutating KB state or writing files."""

    validated: list[dict[str, int | str | None]] = []
    seen_names: set[str] = set()
    for index, file in enumerate(files):
        original_filename = file.filename or "upload"
        size_bytes = get_upload_file_size(file)
        try:
            sanitized_filename = DocumentValidator.validate_upload_safety(
                original_filename,
                size_bytes,
                allowed_extensions=allowed_extensions,
            )
        except Exception as exc:
            message = (
                f"Validation failed for file '{original_filename}': {format_exception_message(exc)}"
            )
            raise HTTPException(status_code=400, detail=message) from exc

        relative = (
            rel_paths[index].replace("\\", "/")
            if rel_paths and index < len(rel_paths) and rel_paths[index]
            else ""
        )
        subdir = sanitize_rel_subdir(relative.rsplit("/", 1)[0]) if "/" in relative else ""
        duplicate_key = f"{subdir}/{sanitized_filename}" if subdir else sanitized_filename
        if duplicate_key in seen_names:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Duplicate filename after sanitization: '{duplicate_key}'. "
                    "Rename one of the files and try again."
                ),
            )
        seen_names.add(duplicate_key)
        validated.append(
            {
                "original_filename": original_filename,
                "sanitized_filename": sanitized_filename,
                "path": duplicate_key,
                "size_bytes": size_bytes,
            }
        )
    return validated
