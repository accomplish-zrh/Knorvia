"""Storyboard / character / canvas-board / export methods of the video store.

Split out of store.py during the staged decomposition tracked in
scripts/architecture_guard.py; composed back by VideoStudioStore. Methods
are moved verbatim and rely on self._connect/self._lock from the core.
"""

from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
import shutil
import sqlite3
import time
from typing import Any, Callable
from uuid import uuid4
import zipfile

from .board import (
    BOARD_MAX_BYTES,
    attach_job_output,
    empty_board,
    find_board_node,
    mark_node_running,
    normalize_board,
)
from .post_production import (
    normalize_transition,
    parse_optional_seconds,
    parse_voiceover_volume,
    validate_trim_window,
)
from .store_base import (
    MAX_CHARACTERS,
    MAX_INPUT_ASSETS,
    MAX_PROJECT_BYTES,
    MAX_STORYBOARD_BYTES,
    MAX_STORYBOARD_SHOTS,
    BoardConflictError,
    StoryboardConflictError,
    _dict_row,
)

logger = logging.getLogger(__name__)


class StoryboardBoardCharactersMixin:
    def get_storyboard(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            row = db.execute(
                "SELECT revision,document_json,updated_at FROM storyboards WHERE project_id=?",
                (project_id,),
            ).fetchone()
        if not row:
            return {"version": 1, "revision": 0, "shots": [], "updated_at": None}
        document = json.loads(row["document_json"] or "{}")
        return {
            "version": 1,
            "revision": int(row["revision"]),
            "shots": list(document.get("shots") or []),
            "updated_at": row["updated_at"],
        }

    def _validate_storyboard(
        self, project_id: str, payload: dict[str, Any]
    ) -> list[dict[str, Any]]:
        shots = payload.get("shots")
        if not isinstance(shots, list) or len(shots) > MAX_STORYBOARD_SHOTS:
            raise ValueError("Storyboard has too many shots")
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        allowed = {
            "id",
            "order",
            "title",
            "prompt",
            "input_asset_ids",
            "job_id",
            "output_asset_id",
            "duration",
            "notes",
            "transition",
            "operation",
            "camera",
            "director_camera_id",
            "director_camera_json",
            "keyframe_asset_id",
            "keyframe_prompt",
            "voiceover_text",
            "voiceover_asset_id",
            "voiceover_voice",
            "voiceover_volume",
            "trim_in",
            "trim_out",
            "character_ids",
        }
        for position, raw in enumerate(shots):
            if not isinstance(raw, dict):
                raise ValueError("Storyboard shots must be objects")
            unknown = set(raw) - allowed
            if unknown:
                raise ValueError(f"Unsupported storyboard field: {sorted(unknown)[0]}")
            shot_id = str(raw.get("id") or "").strip()
            if not shot_id or len(shot_id) > 128 or shot_id in seen:
                raise ValueError("Storyboard shot ids must be unique")
            seen.add(shot_id)
            raw_input_ids = raw.get("input_asset_ids") or []
            if not isinstance(raw_input_ids, list) or len(raw_input_ids) > MAX_INPUT_ASSETS:
                raise ValueError("Storyboard has too many input assets")
            input_ids = list(dict.fromkeys(str(item) for item in raw_input_ids))
            if any(not item or len(item) > 160 for item in input_ids):
                raise ValueError("Storyboard contains an invalid asset id")
            for asset_id in [
                *input_ids,
                str(raw.get("output_asset_id") or ""),
                str(raw.get("keyframe_asset_id") or ""),
                str(raw.get("voiceover_asset_id") or ""),
            ]:
                if not asset_id:
                    continue
                asset = self.get_asset(asset_id)
                if not asset or asset["project_id"] != project_id:
                    raise ValueError("Storyboard assets must belong to the video project")
            job_id = str(raw.get("job_id") or "")
            if job_id:
                job = self.get_job(job_id)
                if not job or job["project_id"] != project_id:
                    raise ValueError("Storyboard jobs must belong to the video project")
            duration = raw.get("duration")
            if duration not in {None, ""}:
                try:
                    duration = float(duration)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Storyboard duration must be numeric") from exc
                if not math.isfinite(duration) or duration <= 0 or duration > 3600:
                    raise ValueError("Storyboard duration is out of range")
            else:
                duration = None
            try:
                trim_in = parse_optional_seconds(raw.get("trim_in"), field="trim_in")
                trim_out = parse_optional_seconds(raw.get("trim_out"), field="trim_out")
                validate_trim_window(trim_in, trim_out, duration)
                voiceover_volume = parse_voiceover_volume(raw.get("voiceover_volume"))
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
            keyframe_asset_id = str(raw.get("keyframe_asset_id") or "") or None
            if keyframe_asset_id and self.get_asset(keyframe_asset_id)["kind"] != "image":
                raise ValueError("A storyboard keyframe must be an image asset")
            voiceover_asset_id = str(raw.get("voiceover_asset_id") or "") or None
            if voiceover_asset_id and self.get_asset(voiceover_asset_id)["kind"] != "audio":
                raise ValueError("A storyboard voiceover must be an audio asset")
            raw_character_ids = raw.get("character_ids") or []
            if not isinstance(raw_character_ids, list) or len(raw_character_ids) > 10:
                raise ValueError("Storyboard character_ids must be a list of at most 10 ids")
            character_ids = list(
                dict.fromkeys(
                    str(item or "").strip() for item in raw_character_ids if str(item or "").strip()
                )
            )
            for character_id in character_ids:
                if len(character_id) > 160:
                    raise ValueError("Storyboard contains an invalid character id")
                if self.get_character(project_id, character_id) is None:
                    raise ValueError("Storyboard characters must belong to the video project")
            director_camera_id = str(raw.get("director_camera_id") or "").strip()[:128] or None
            director_camera_json = raw.get("director_camera_json")
            if director_camera_json is not None and not isinstance(director_camera_json, dict):
                raise ValueError("Storyboard director_camera_json must be an object")
            normalized_shot = {
                "id": shot_id,
                "order": int(raw.get("order", position)),
                "title": str(raw.get("title") or "")[:160],
                "prompt": str(raw.get("prompt") or "")[:20_000],
                "input_asset_ids": input_ids,
                "job_id": job_id or None,
                "output_asset_id": str(raw.get("output_asset_id") or "") or None,
                "duration": duration,
                "notes": str(raw.get("notes") or "")[:10_000],
                "transition": normalize_transition(raw.get("transition")),
                "keyframe_asset_id": keyframe_asset_id,
                "keyframe_prompt": str(raw.get("keyframe_prompt") or "")[:20_000],
                "voiceover_text": str(raw.get("voiceover_text") or "")[:20_000],
                "voiceover_asset_id": voiceover_asset_id,
                "voiceover_voice": str(raw.get("voiceover_voice") or "")[:160],
                "character_ids": character_ids,
            }
            if trim_in is not None:
                normalized_shot["trim_in"] = trim_in
            if trim_out is not None:
                normalized_shot["trim_out"] = trim_out
            if voiceover_volume is not None:
                normalized_shot["voiceover_volume"] = voiceover_volume
            # Board 鈫?strip exports keep the node's operation so the shot can
            # regenerate with the same pipeline; older shots stay without it.
            operation = str(raw.get("operation") or "").strip()[:64]
            if operation:
                normalized_shot["operation"] = operation
            # C4 camera control: free-form short motion label from
            # plan_episode / board exports ("push", "pan-left", ...).
            camera = str(raw.get("camera") or "").strip()[:64]
            if camera:
                normalized_shot["camera"] = camera
            if director_camera_id:
                normalized_shot["director_camera_id"] = director_camera_id
            if director_camera_json is not None:
                normalized_shot["director_camera_json"] = director_camera_json
            normalized.append(normalized_shot)
        encoded = json.dumps({"shots": normalized}, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_STORYBOARD_BYTES:
            raise ValueError("Storyboard exceeds the size limit")
        return normalized

    def save_storyboard(
        self, project_id: str, payload: dict[str, Any], *, expected_revision: int
    ) -> dict[str, Any]:
        # Validation reads jobs/assets. Hold the same RLock used by deletion
        # until the CAS write commits so a validated reference cannot vanish.
        with self._lock:
            shots = self._validate_storyboard(project_id, payload)
            document = json.dumps({"shots": shots}, ensure_ascii=False, separators=(",", ":"))
            now = time.time()
            with self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT revision FROM storyboards WHERE project_id=?", (project_id,)
                ).fetchone()
                current = int(row[0]) if row else 0
                if current != expected_revision:
                    raise StoryboardConflictError(expected_revision, current)
                revision = current + 1
                db.execute(
                    """INSERT INTO storyboards VALUES (?,?,?,?)
                       ON CONFLICT(project_id) DO UPDATE SET
                         revision=excluded.revision,document_json=excluded.document_json,
                         updated_at=excluded.updated_at""",
                    (project_id, revision, document, now),
                )
                db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        return {"version": 1, "revision": revision, "shots": shots, "updated_at": now}

    def patch_storyboard_job_output(self, project_id: str, job_id: str, asset_id: str) -> bool:
        for _ in range(5):
            board = self.get_storyboard(project_id)
            changed = False
            shots = []
            for shot in board["shots"]:
                item = dict(shot)
                if item.get("job_id") == job_id and item.get("output_asset_id") != asset_id:
                    item["output_asset_id"] = asset_id
                    changed = True
                shots.append(item)
            if not changed:
                return False
            try:
                self.save_storyboard(
                    project_id, {"shots": shots}, expected_revision=int(board["revision"])
                )
                return True
            except StoryboardConflictError:
                continue
        return False

    def patch_storyboard_shot_job(self, project_id: str, shot_id: str, job_id: str) -> bool:
        for _ in range(5):
            board = self.get_storyboard(project_id)
            found = False
            changed = False
            shots = []
            for shot in board["shots"]:
                item = dict(shot)
                if item.get("id") == shot_id:
                    found = True
                    if item.get("job_id") != job_id:
                        item["job_id"] = job_id
                        item["output_asset_id"] = None
                        changed = True
                shots.append(item)
            if not found:
                raise ValueError("Storyboard shot not found")
            if not changed:
                return False
            try:
                self.save_storyboard(
                    project_id, {"shots": shots}, expected_revision=int(board["revision"])
                )
                return True
            except StoryboardConflictError:
                continue
        raise StoryboardConflictError(-1, int(self.get_storyboard(project_id)["revision"]))

    def update_storyboard(
        self, project_id: str, mutator: Callable[[dict[str, Any]], Any]
    ) -> dict[str, Any]:
        """Atomically patch the newest storyboard 鈥?the strip twin of update_board.

        The mutator receives the current document (``version``/``revision``/
        ``shots``) and mutates the shots list in place. Validation and the CAS
        write then run via save_storyboard under the same re-entrant lock, so
        a concurrent strip edit can never be silently overwritten by an
        append (e.g. board 鈫?strip export) or vice versa.
        """
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            current = self.get_storyboard(project_id)
            mutator(current)
            return self.save_storyboard(
                project_id,
                {"shots": current["shots"]},
                expected_revision=int(current["revision"]),
            )

    # 鈹€鈹€ Character library (cross-shot identity consistency) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    @staticmethod
    def _character_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        data = _dict_row(row)
        if data is None:
            return None
        try:
            ids = json.loads(data.get("reference_asset_ids") or "[]")
        except (TypeError, ValueError):
            ids = []
        data["reference_asset_ids"] = (
            [str(item) for item in ids if str(item or "").strip()] if isinstance(ids, list) else []
        )
        return data

    def list_characters(self, project_id: str) -> list[dict[str, Any]]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM characters WHERE project_id=? AND deleted_at IS NULL
                   ORDER BY created_at""",
                (project_id,),
            ).fetchall()
        characters: list[dict[str, Any]] = []
        for row in rows:
            data = self._character_row(row)
            if data is not None:
                characters.append(data)
        return characters

    def get_character(self, project_id: str, character_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT * FROM characters WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (character_id, project_id),
            ).fetchone()
        return self._character_row(row)

    def create_character(
        self,
        project_id: str,
        *,
        name: str,
        description: str = "",
        reference_asset_ids: list[str] | None = None,
        voice_hint: str = "",
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        safe_name = str(name or "").strip()[:160]
        if not safe_name:
            raise ValueError("A character name is required")
        ids = self._validate_character_assets(project_id, reference_asset_ids or [])
        character_id = f"character_{uuid4().hex}"
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute(
                "SELECT COUNT(*) FROM characters WHERE project_id=? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()[0]
            if count >= MAX_CHARACTERS:
                raise ValueError("This project already has the maximum number of characters")
            db.execute(
                """INSERT INTO characters
                   (id, project_id, name, description, reference_asset_ids,
                    three_view_asset_id, voice_hint, created_at, updated_at, deleted_at)
                   VALUES (?,?,?,?,?,NULL,?,?,?,NULL)""",
                (
                    character_id,
                    project_id,
                    safe_name,
                    str(description or "").strip()[:4000],
                    json.dumps(ids),
                    str(voice_hint or "").strip()[:160],
                    now,
                    now,
                ),
            )
        return self.get_character(project_id, character_id) or {}

    def update_character(
        self,
        project_id: str,
        character_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        reference_asset_ids: list[str] | None = None,
        voice_hint: str | None = None,
    ) -> dict[str, Any] | None:
        current = self.get_character(project_id, character_id)
        if current is None:
            return None
        updates: dict[str, Any] = {"updated_at": time.time()}
        if name is not None:
            safe_name = str(name).strip()[:160]
            if not safe_name:
                raise ValueError("A character name is required")
            updates["name"] = safe_name
        if description is not None:
            updates["description"] = str(description).strip()[:4000]
        if reference_asset_ids is not None:
            updates["reference_asset_ids"] = json.dumps(
                self._validate_character_assets(project_id, reference_asset_ids)
            )
        if voice_hint is not None:
            updates["voice_hint"] = str(voice_hint).strip()[:160]
        assignments = ", ".join(f"{column}=?" for column in updates)
        with self._connect() as db:
            db.execute(
                f"UPDATE characters SET {assignments} WHERE id=? AND project_id=? AND deleted_at IS NULL",  # nosec B608 - whitelisted columns, bound args
                (*updates.values(), character_id, project_id),
            )
        return self.get_character(project_id, character_id)

    def delete_character(self, project_id: str, character_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE characters SET deleted_at=?
                   WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (time.time(), character_id, project_id),
            )
        return cursor.rowcount > 0

    def set_character_three_view(
        self, project_id: str, character_id: str, asset_id: str
    ) -> dict[str, Any] | None:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE characters SET three_view_asset_id=?, updated_at=?
                   WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (asset_id, time.time(), character_id, project_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_character(project_id, character_id)

    def _validate_character_assets(self, project_id: str, asset_ids: list[str]) -> list[str]:
        seen: list[str] = []
        for raw in asset_ids:
            asset_id = str(raw or "").strip()
            if not asset_id or asset_id in seen:
                continue
            asset = self.get_asset(asset_id)
            if asset is None or asset.get("project_id") != project_id:
                raise ValueError(f"Unknown character reference asset: {asset_id}")
            if asset.get("kind") != "image":
                raise ValueError("Character references must be image assets")
            seen.append(asset_id)
            if len(seen) >= MAX_INPUT_ASSETS:
                break
        return seen

    # 鈹€鈹€ Canvas board (projects/{id}/board.json + CAS revision) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    def board_path(self, project_id: str) -> Path:
        return self.projects_root / project_id / "board.json"

    def get_board(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            return self._read_board_file(project_id)

    def _read_board_file(self, project_id: str) -> dict[str, Any]:
        path = self.board_path(project_id)
        if not path.exists():
            return empty_board()
        for candidate in (path, path.with_suffix(".json.bak")):
            if not candidate.exists():
                continue
            try:
                return normalize_board(json.loads(candidate.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        raise ValueError("The board document is corrupt.")

    def _atomic_board_write(self, path: Path, encoded: str) -> None:
        if path.exists():
            try:
                json.loads(path.read_text(encoding="utf-8"))
                shutil.copyfile(path, path.with_suffix(".json.bak"))
            except (OSError, json.JSONDecodeError):
                pass
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _write_board_locked(
        self, project_id: str, document: dict[str, Any], *, current_revision: int
    ) -> dict[str, Any]:
        cleaned = normalize_board(document)
        cleaned["revision"] = current_revision + 1
        encoded = json.dumps(cleaned, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > BOARD_MAX_BYTES:
            raise ValueError("Board document is too large")
        self._atomic_board_write(self.board_path(project_id), encoded)
        with self._connect() as db:
            db.execute(
                "UPDATE projects SET updated_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), project_id),
            )
        return cleaned

    def save_board(
        self,
        project_id: str,
        document: dict[str, Any],
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if expected_revision is None and isinstance(document.get("revision"), int):
            expected_revision = int(document["revision"])
        with self._lock:
            current = self._read_board_file(project_id)
            current_revision = int(current.get("revision") or 0)
            if expected_revision is None and current_revision == 0:
                # First write on an empty board needs no optimistic lock.
                expected_revision = 0
            if expected_revision != current_revision:
                raise BoardConflictError(expected_revision, current_revision)
            return self._write_board_locked(project_id, document, current_revision=current_revision)

    def update_board(
        self, project_id: str, mutator: Callable[[dict[str, Any]], Any]
    ) -> dict[str, Any]:
        """Atomically patch the newest board without replacing unrelated edits."""
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            current = self._read_board_file(project_id)
            revision = int(current.get("revision") or 0)
            mutator(current)
            return self._write_board_locked(project_id, current, current_revision=revision)

    def patch_board_node_job(self, project_id: str, node_id: str, job_id: str) -> bool:
        """Point a generate node at its job and mark it running (conflict-safe)."""
        for _ in range(5):
            board = self.get_board(project_id)
            node = find_board_node(board, node_id)
            if not node:
                raise ValueError("Board node not found")
            if node.get("kind") != "generate":
                raise ValueError("Only a generate node can receive a video job")
            if node.get("jobId") == job_id and node.get("status") == "running":
                return False

            def mutator(document: dict[str, Any]) -> None:
                mark_node_running(document, node_id, job_id=job_id)

            try:
                self.update_board(project_id, mutator)
                return True
            except BoardConflictError:
                continue
        raise BoardConflictError(-1, int(self.get_board(project_id)["revision"]))

    def patch_board_job_output(
        self,
        project_id: str,
        job_id: str,
        *,
        status: str,
        asset_id: str | None = None,
        duration: float | None = None,
    ) -> bool:
        """Bind a finished job's output back onto its generate node."""
        for _ in range(5):
            board = self.get_board(project_id)
            if not any(node.get("jobId") == job_id for node in board.get("nodes") or []):
                return False
            changed = False

            def mutator(document: dict[str, Any]) -> None:
                nonlocal changed
                changed = (
                    attach_job_output(
                        document,
                        job_id=job_id,
                        status=status,
                        asset_id=asset_id,
                        duration=duration,
                    )
                    or changed
                )

            try:
                self.update_board(project_id, mutator)
                return changed
            except BoardConflictError:
                continue
        return False

    def export_project(self, project_id: str) -> Path:
        # Keep the project metadata and owned media stable until the archive is
        # complete. Asset/project deletion takes the same re-entrant lock, so an
        # export can never observe a half-deleted snapshot.
        with self._lock:
            project = self.get_project(project_id)
            if not project:
                raise KeyError(project_id)
            with self._connect() as db:
                assets = [
                    dict(row)
                    for row in db.execute(
                        """SELECT * FROM assets WHERE project_id=? AND deleted_at IS NULL
                           ORDER BY created_at DESC""",
                        (project_id,),
                    ).fetchall()
                ]
                job_ids = [
                    str(row[0])
                    for row in db.execute(
                        "SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC",
                        (project_id,),
                    ).fetchall()
                ]
            if len(assets) > 10_000:
                raise ValueError("Video project has too many assets to export")
            total = sum(int(asset["size_bytes"]) for asset in assets)
            if total > MAX_PROJECT_BYTES:
                raise ValueError("Video project export exceeds the size limit")
            if len(job_ids) > 10_000:
                raise ValueError("Video project has too many jobs to export")
            # Bulk-load every job with its relations in one pass instead of
            # reopening the store once per job (10k jobs meant 10k+ connects).
            with self._connect() as db:
                placeholders = ",".join("?" * len(job_ids))
                rows = db.execute(
                    f"SELECT * FROM jobs WHERE id IN ({placeholders})",  # nosec B608 - placeholder string only
                    job_ids,
                ).fetchall()
                shaped = self._assemble_jobs(db, rows)
            by_id = {str(job["id"]): job for job in shaped}
            jobs = [by_id[job_id] for job_id in job_ids if job_id in by_id]
            manifest = {
                "version": 1,
                "project": project,
                "director_desk": self.get_director_desk(project_id)["director_desk"],
                "storyboard": self.get_storyboard(project_id),
                "board": self._read_board_file(project_id),
                "jobs": jobs,
                "assets": [
                    {key: value for key, value in asset.items() if key != "relative_path"}
                    for asset in assets
                ],
            }
            # Keep response files outside the project tree so a delete request
            # arriving after this snapshot is built cannot remove a FileResponse
            # before Starlette opens it. The response background task unlinks it.
            export_root = self.exports_root
            # A unique target prevents a second export from replacing the file
            # between FileResponse construction and the first response read.
            target = export_root / f"{project_id}-{uuid4().hex}.zip"
            temporary = export_root / f".{uuid4().hex}.tmp"
            try:
                with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr(
                        "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2)
                    )
                    for asset in assets:
                        source = self.asset_path(asset["id"])
                        archive.write(source, f"assets/{source.name}")
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return target
