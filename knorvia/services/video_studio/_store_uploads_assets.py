"""Upload, asset-storage and cleanup methods of the video studio store.

Split out of store.py during the staged decomposition tracked in
scripts/architecture_guard.py; composed back by VideoStudioStore. Methods
are moved verbatim and rely on self._connect/self._lock from the core.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import time
from typing import Any, Sequence
from uuid import uuid4

from .store_base import (
    MAX_ACTIVE_UPLOADS,
    MAX_OUTPUT_BYTES,
    MAX_PROJECT_BYTES,
    MIME_EXTENSIONS,
    MIME_LIMITS,
    SUBTITLE_MIME_TYPE,
    UPLOAD_CHUNK_BYTES,
    UPLOAD_TTL_SECONDS,
    _dict_row,
    _encode_subtitle_document,
    _safe_filename,
    _sha256_file,
    _sniff_mime,
    _validate_image,
)

logger = logging.getLogger(__name__)


class UploadsAssetsMixin:
    def cleanup_expired_uploads(self) -> int:
        cutoff = time.time() - UPLOAD_TTL_SECONDS
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT id,temp_path FROM uploads WHERE created_at<?", (cutoff,)
            ).fetchall()
            for row in rows:
                db.execute("DELETE FROM uploads WHERE id=?", (row["id"],))
        for row in rows:
            path = Path(row["temp_path"]).resolve()
            if path.parent == self.uploads_root:
                path.unlink(missing_ok=True)
        return len(rows)

    def create_upload(
        self, project_id: str, filename: str, mime_type: str, size: int, sha256: str
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if mime_type not in MIME_LIMITS:
            raise ValueError("Unsupported media type")
        if size <= 0 or size > MIME_LIMITS[mime_type]:
            raise ValueError("Upload exceeds the limit for this media type")
        digest = str(sha256 or "").lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("A valid SHA-256 checksum is required")
        self.cleanup_expired_uploads()
        self.cleanup_deleted_files()
        upload_id = f"video_upload_{uuid4().hex}"
        target = (self.uploads_root / f"{upload_id}.part").resolve()
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count, active_bytes = db.execute(
                "SELECT COUNT(*),COALESCE(SUM(expected_size),0) FROM uploads"
            ).fetchone()
            stored = int(
                db.execute(
                    "SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE project_id=? AND deleted_at IS NULL",
                    (project_id,),
                ).fetchone()[0]
            )
            if (
                int(count) >= MAX_ACTIVE_UPLOADS
                # Late-bound through the facade module so tests can
                # monkeypatch knorvia.services.video_studio.store
                # .MAX_ACTIVE_UPLOAD_BYTES (the historical seam).
                or int(active_bytes) + size > _quota_limit()
            ):
                raise ValueError("Too many active video uploads")
            if stored + size > MAX_PROJECT_BYTES:
                raise ValueError("Video project storage quota exceeded")
            with target.open("xb") as handle:
                handle.truncate(size)
            db.execute(
                "INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)",
                (
                    upload_id,
                    project_id,
                    _safe_filename(filename, mime_type),
                    mime_type,
                    size,
                    digest,
                    str(target),
                    now,
                ),
            )
        return {
            "id": upload_id,
            "part_size": UPLOAD_CHUNK_BYTES,
            "expires_at": now + UPLOAD_TTL_SECONDS,
        }

    def upload_record(self, upload_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            return _dict_row(
                db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            )

    def abort_upload(self, upload_id: str) -> bool:
        """Release an incomplete upload and its reserved quota immediately."""

        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT temp_path FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                return False
            db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
        path = Path(row["temp_path"]).resolve()
        if path.parent == self.uploads_root:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # The DB row is already gone, so an OS-level file lock must not
                # turn an idempotent abort into an API failure. Startup GC will
                # retry removal of orphaned .part files.
                logger.warning("Could not remove aborted video upload %s", path)
        return True

    def write_upload_part(self, upload_id: str, index: int, data: bytes) -> None:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record or float(record["created_at"]) < time.time() - UPLOAD_TTL_SECONDS:
                raise KeyError(upload_id)
            size = int(record["expected_size"])
            count = (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            if index < 0 or index >= count:
                raise ValueError("Invalid upload chunk index")
            expected = min(UPLOAD_CHUNK_BYTES, size - index * UPLOAD_CHUNK_BYTES)
            if len(data) != expected:
                raise ValueError("Upload chunk size does not match")
            target = Path(record["temp_path"]).resolve()
            if target.parent != self.uploads_root:
                raise ValueError("Unsafe upload path")
            with target.open("r+b") as handle:
                handle.seek(index * UPLOAD_CHUNK_BYTES)
                handle.write(data)
                handle.flush()
            with self._connect() as db:
                db.execute(
                    """INSERT INTO upload_parts VALUES (?,?,?)
                       ON CONFLICT(upload_id,part_index) DO UPDATE SET size_bytes=excluded.size_bytes""",
                    (upload_id, index, len(data)),
                )

    def complete_upload(self, upload_id: str) -> dict[str, Any]:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record:
                raise KeyError(upload_id)
            size = int(record["expected_size"])
            expected_parts = (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            with self._connect() as db:
                parts = db.execute(
                    "SELECT part_index FROM upload_parts WHERE upload_id=? ORDER BY part_index",
                    (upload_id,),
                ).fetchall()
            if [int(row[0]) for row in parts] != list(range(expected_parts)):
                raise ValueError("Upload is incomplete")
            source = Path(record["temp_path"]).resolve()
            if source.parent != self.uploads_root or source.stat().st_size != size:
                raise ValueError("Upload size does not match")
            if _sha256_file(source) != record["expected_sha256"]:
                raise ValueError("Upload checksum does not match")
            with source.open("rb") as handle:
                sniffed = _sniff_mime(handle.read(4096))
            if sniffed != record["mime_type"]:
                raise ValueError("Uploaded file type does not match")
            width = height = None
            if sniffed.startswith("image/"):
                width, height = _validate_image(source, sniffed)
            asset = self._adopt_asset(
                record["project_id"],
                source,
                sniffed,
                filename=record["filename"],
                kind=sniffed.split("/", 1)[0],
                width=width,
                height=height,
                sha256=record["expected_sha256"],
            )
            with self._connect() as db:
                db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
            return asset

    def _adopt_asset(
        self,
        project_id: str,
        source: Path,
        mime_type: str,
        *,
        filename: str,
        kind: str,
        width: int | None = None,
        height: int | None = None,
        duration: float | None = None,
        sha256: str | None = None,
        origin: str = "uploaded",
    ) -> dict[str, Any]:
        source = source.resolve()
        if source.parent != self.uploads_root:
            raise ValueError("Unsafe media staging path")
        size = source.stat().st_size
        limit = MAX_OUTPUT_BYTES if origin == "generated" else MIME_LIMITS.get(mime_type, 0)
        if not limit or size <= 0 or size > limit:
            raise ValueError("Media exceeds the storage limit")
        asset_id = f"video_asset_{uuid4().hex}"
        relative = (
            Path("projects") / project_id / "assets" / f"{asset_id}{MIME_EXTENSIONS[mime_type]}"
        )
        target = (self.root / relative).resolve()
        expected_parent = (self.projects_root / project_id / "assets").resolve()
        if target.parent != expected_parent or expected_parent.parent.parent != self.projects_root:
            raise ValueError("Unsafe asset path")
        now = time.time()
        try:
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if not db.execute(
                    "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
                ).fetchone():
                    raise KeyError(project_id)
                stored = int(
                    db.execute(
                        """SELECT COALESCE(SUM(size_bytes),0) FROM assets
                           WHERE project_id=? AND deleted_at IS NULL""",
                        (project_id,),
                    ).fetchone()[0]
                )
                if stored + size > MAX_PROJECT_BYTES:
                    raise ValueError("Video project storage quota exceeded")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, target)
                db.execute(
                    """INSERT INTO assets
                       (id,project_id,kind,origin,mime_type,filename,size_bytes,sha256,relative_path,
                        width,height,duration,created_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        asset_id,
                        project_id,
                        kind,
                        origin,
                        mime_type,
                        _safe_filename(filename, mime_type),
                        size,
                        sha256 or _sha256_file(target),
                        relative.as_posix(),
                        width,
                        height,
                        duration,
                        now,
                    ),
                )
                db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_asset(asset_id) or {}

    def save_output_bytes(
        self, project_id: str, data: bytes, mime_type: str, filename: str = "result.mp4"
    ) -> dict[str, Any]:
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("Video output exceeds the storage limit")
        if _sniff_mime(data[:4096]) != mime_type or not mime_type.startswith("video/"):
            raise ValueError("Provider returned an invalid video file")
        temporary = (self.uploads_root / f"output_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind="video",
                origin="generated",
            )
        finally:
            temporary.unlink(missing_ok=True)

    def save_generated_audio(
        self,
        project_id: str,
        data: bytes,
        mime_type: str,
        filename: str = "voiceover.mp3",
        *,
        duration: float | None = None,
    ) -> dict[str, Any]:
        """Adopt synthesized speech (or any generated audio) as a project asset."""
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("Audio output exceeds the storage limit")
        if _sniff_mime(data[:4096]) != mime_type or not mime_type.startswith("audio/"):
            raise ValueError("Provider returned an invalid audio file")
        temporary = (self.uploads_root / f"audio_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind="audio",
                origin="generated",
                duration=duration,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def save_subtitle_document(
        self,
        project_id: str,
        content: str,
        filename: str = "subtitles.srt",
        *,
        origin: str = "generated",
    ) -> dict[str, Any]:
        """Adopt an SRT document (subtitle editor save, from_asr byproduct)."""
        data = _encode_subtitle_document(content)
        temporary = (self.uploads_root / f"subtitle_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                SUBTITLE_MIME_TYPE,
                filename=filename or "subtitles.srt",
                kind="subtitle",
                origin=origin,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def replace_subtitle_document(self, asset_id: str, content: str) -> dict[str, Any]:
        """Overwrite an existing subtitle asset's SRT in place (editor saves).

        Keeping the asset id stable means a composition that references the
        document picks up the edited text on the next run without any re-wiring.
        """
        asset = self.get_asset(asset_id)
        if not asset or asset["kind"] != "subtitle":
            raise ValueError("Asset is not a subtitle document")
        if asset.get("deleted_at"):
            raise ValueError("Asset is not a subtitle document")
        data = _encode_subtitle_document(content)
        temporary = (self.uploads_root / f"subtitle_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            target = self.asset_path(asset_id)
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                stored = int(
                    db.execute(
                        """SELECT COALESCE(SUM(size_bytes),0) FROM assets
                           WHERE project_id=? AND deleted_at IS NULL""",
                        (asset["project_id"],),
                    ).fetchone()[0]
                )
                if stored - int(asset["size_bytes"]) + len(data) > MAX_PROJECT_BYTES:
                    raise ValueError("Video project storage quota exceeded")
                os.replace(temporary, target)
                db.execute(
                    "UPDATE assets SET size_bytes=?, sha256=? WHERE id=? AND deleted_at IS NULL",
                    (len(data), hashlib.sha256(data).hexdigest(), asset_id),
                )
                now = time.time()
                db.execute(
                    "UPDATE projects SET updated_at=? WHERE id=?", (now, asset["project_id"])
                )
        finally:
            temporary.unlink(missing_ok=True)
        return self.get_asset(asset_id) or {}

    def import_asset_bytes(
        self, project_id: str, data: bytes, mime_type: str, filename: str
    ) -> dict[str, Any]:
        """Import a trusted caller's bytes without accepting a filesystem path."""
        limit = MIME_LIMITS.get(mime_type)
        if not limit or not data or len(data) > limit:
            raise ValueError("Media exceeds the upload limit")
        if _sniff_mime(data[:4096]) != mime_type:
            raise ValueError("Imported file type does not match")
        temporary = (self.uploads_root / f"import_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        width = height = None
        try:
            if mime_type.startswith("image/"):
                width, height = _validate_image(temporary, mime_type)
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind=mime_type.split("/", 1)[0],
                width=width,
                height=height,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def adopt_output_file(
        self, project_id: str, source: Path, mime_type: str, filename: str = "result.mp4"
    ) -> dict[str, Any]:
        source = source.resolve()
        if source.parent != self.uploads_root:
            raise ValueError("Unsafe media staging path")
        with source.open("rb") as handle:
            actual = _sniff_mime(handle.read(4096))
        if actual != mime_type or not actual.startswith("video/"):
            raise ValueError("Provider returned an invalid video file")
        try:
            return self._adopt_asset(
                project_id,
                source,
                mime_type,
                filename=filename,
                kind="video",
                origin="generated",
            )
        finally:
            source.unlink(missing_ok=True)

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE id=? AND deleted_at IS NULL", (asset_id,)
            ).fetchone()
        return _dict_row(row)

    def get_assets_by_ids(self, asset_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
        """Bulk-load non-deleted assets by id in one query.

        Missing (or soft-deleted) ids are simply absent from the result —
        callers that need presence checks keep their per-item semantics.
        """
        ids = [str(item) for item in dict.fromkeys(asset_ids) if item]
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM assets WHERE id IN ({placeholders}) AND deleted_at IS NULL",  # nosec B608 - placeholder string only
                ids,
            ).fetchall()
        return {str(row["id"]): dict(row) for row in rows}

    def asset_path(self, asset_id: str) -> Path:
        asset = self.get_asset(asset_id)
        if not asset:
            raise KeyError(asset_id)
        path = (self.root / asset["relative_path"]).resolve()
        if self.root not in path.parents:
            raise ValueError("Unsafe asset path")
        return path

    def list_assets(
        self,
        project_id: str,
        *,
        kind: str = "",
        limit: int = 50,
        before: float | None = None,
    ) -> list[dict[str, Any]]:
        clauses = ["project_id=?", "deleted_at IS NULL"]
        args: list[Any] = [project_id]
        if kind:
            clauses.append("kind=?")
            args.append(kind)
        if before is not None:
            clauses.append("created_at<?")
            args.append(float(before))
        args.append(max(1, min(int(limit), 100)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM assets WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",  # nosec B608 - hardcoded clauses, bound args
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_asset(self, asset_id: str) -> bool:
        target: Path | None = None
        with self._lock, self._connect() as db:
            used = db.execute(
                """SELECT 1 FROM job_inputs WHERE asset_id=?
                   UNION ALL SELECT 1 FROM job_outputs WHERE asset_id=? LIMIT 1""",
                (asset_id, asset_id),
            ).fetchone()
            if used:
                raise ValueError("This asset is referenced by a video job")
            asset = db.execute(
                """SELECT project_id,relative_path FROM assets
                   WHERE id=? AND deleted_at IS NULL""",
                (asset_id,),
            ).fetchone()
            # 搂Phase D3: the project's BGM slot points at this asset 鈥?deleting
            # it would silently strip the music bed from every later compose.
            if asset:
                slot = db.execute(
                    """SELECT 1 FROM projects
                       WHERE id=? AND deleted_at IS NULL AND bgm_asset_id=?""",
                    (asset["project_id"], asset_id),
                ).fetchone()
                if slot:
                    raise ValueError(
                        "This asset is the project's background music; clear the BGM slot first"
                    )
            board = (
                db.execute(
                    "SELECT document_json FROM storyboards WHERE project_id=?", (asset[0],)
                ).fetchone()
                if asset
                else None
            )
            if board:
                document = json.loads(board[0] or "{}")
                for shot in document.get("shots") or []:
                    if (
                        asset_id == shot.get("output_asset_id")
                        or asset_id == shot.get("keyframe_asset_id")
                        or asset_id == shot.get("voiceover_asset_id")
                        or asset_id in (shot.get("input_asset_ids") or [])
                    ):
                        raise ValueError("This asset is referenced by the storyboard")
            if asset:
                target = (self.root / asset["relative_path"]).resolve()
                expected_parent = (self.projects_root / asset["project_id"] / "assets").resolve()
                if (
                    target.parent != expected_parent
                    or expected_parent.parent.parent != self.projects_root
                ):
                    raise ValueError("Unsafe asset path")
            cursor = db.execute(
                "UPDATE assets SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), asset_id),
            )
        if cursor.rowcount and target is not None:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                logger.info("Deferred cleanup of deleted video asset %s", target)
        return cursor.rowcount > 0

    def cleanup_deleted_files(self) -> int:
        """Best-effort retry for Windows file locks after logical deletion."""
        with self._lock, self._connect() as db:
            assets = db.execute(
                """SELECT project_id,relative_path FROM assets
                   WHERE deleted_at IS NOT NULL"""
            ).fetchall()
            projects = db.execute("SELECT id FROM projects WHERE deleted_at IS NOT NULL").fetchall()
            active_uploads = {
                str(Path(row[0]).resolve())
                for row in db.execute("SELECT temp_path FROM uploads").fetchall()
            }
        removed = 0
        for asset in assets:
            target = (self.root / asset["relative_path"]).resolve()
            expected_parent = (self.projects_root / asset["project_id"] / "assets").resolve()
            if (
                target.parent != expected_parent
                or expected_parent.parent.parent != self.projects_root
            ):
                continue
            try:
                existed = target.exists()
                target.unlink(missing_ok=True)
                removed += int(existed)
            except OSError:
                continue
        for project in projects:
            target = (self.projects_root / project["id"]).resolve()
            if target.parent != self.projects_root:
                continue
            try:
                existed = target.exists()
                if existed:
                    shutil.rmtree(target)
                removed += int(existed)
            except OSError:
                continue
        for target in self.uploads_root.glob("video_upload_*.part"):
            resolved = target.resolve()
            if resolved.parent != self.uploads_root or str(resolved) in active_uploads:
                continue
            try:
                resolved.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
        stale_export_cutoff = time.time() - UPLOAD_TTL_SECONDS
        for target in self.exports_root.iterdir():
            if (
                not target.is_file()
                or target.suffix not in {".zip", ".tmp"}
                or target.stat().st_mtime >= stale_export_cutoff
            ):
                continue
            try:
                target.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
        return removed


def _quota_limit() -> int:
    """Current MAX_ACTIVE_UPLOAD_BYTES, read lazily for testability."""
    from . import store as _store_facade

    return _store_facade.MAX_ACTIVE_UPLOAD_BYTES
