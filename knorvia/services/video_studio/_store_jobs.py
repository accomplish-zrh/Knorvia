"""Job lifecycle + event-sourcing methods of the video studio store.

Split out of store.py during the staged decomposition tracked in
scripts/architecture_guard.py; composed back by VideoStudioStore. Methods
are moved verbatim and rely on self._connect/self._lock from the core.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any
from uuid import uuid4

from .board import (
    find_board_node,
)
from .store_base import (
    ACTIVE_STATUSES,
    INPUT_ROLES,
    MAX_INPUT_ASSETS,
    MAX_PENDING_JOBS,
    RETRYABLE_STATUSES,
    TERMINAL_STATUSES,
    VideoStudioQueueFullError,
    VideoStudioRetryConflictError,
)

logger = logging.getLogger(__name__)


class JobsMixin:
    @staticmethod
    def _request_hash(payload: dict[str, Any]) -> str:
        public = {
            key: payload.get(key)
            for key in (
                "project_id",
                "operation",
                "profile_id",
                "model_id",
                "prompt",
                "input_asset_ids",
                "inputs",
                "parameters",
                "retry_of_job_id",
                "storyboard_shot_id",
                "board_node_id",
            )
        }
        return hashlib.sha256(
            json.dumps(public, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()

    @staticmethod
    def _input_specs(payload: dict[str, Any]) -> list[dict[str, str]]:
        """Normalize ``inputs[]`` / ``input_asset_ids`` into [{asset_id, role}]."""
        raw_specs = payload.get("inputs")
        raw_ids = payload.get("input_asset_ids") or []
        if raw_specs is not None and not isinstance(raw_specs, list):
            raise ValueError("Video inputs must be a list")
        if not isinstance(raw_ids, list):
            raise ValueError("Video input asset ids must be a list")
        if raw_specs and raw_ids:
            raise ValueError("Pass either input_asset_ids or inputs, not both")
        specs: list[dict[str, str]] = []
        for item in raw_specs or []:
            if not isinstance(item, dict):
                raise ValueError("Video inputs must be objects with asset_id and role")
            asset_id = str(item.get("asset_id") or "")
            role = str(item.get("role") or "reference")
            specs.append({"asset_id": asset_id, "role": role})
        if not specs:
            specs = [{"asset_id": str(item), "role": "reference"} for item in raw_ids]
        deduped: list[dict[str, str]] = []
        seen: set[str] = set()
        for spec in specs:
            if spec["asset_id"] in seen:
                continue
            seen.add(spec["asset_id"])
            deduped.append(spec)
        return deduped

    def create_job(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        operation = str(payload.get("operation") or "")
        operation = operation.replace("-", "_")
        if operation not in {
            "text_to_video",
            "image_to_video",
            "video_to_video",
            "extend",
            "remix",
            "edit",
            "compose",
        }:
            raise ValueError("Invalid video operation")
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt or len(prompt) > 20_000:
            raise ValueError("A valid video prompt is required")
        owner = str(payload.get("owner_user_id") or "")
        revision = str(payload.get("config_revision") or "")
        request_id = str(payload.get("client_request_id") or "").strip()
        if not owner or not revision or not request_id or len(request_id) > 128:
            raise ValueError(
                "A valid owner, authorization snapshot and client request id are required"
            )
        inputs = self._input_specs(payload)
        if len(inputs) > MAX_INPUT_ASSETS:
            raise ValueError("Too many input assets")
        if any(not spec["asset_id"] or len(spec["asset_id"]) > 160 for spec in inputs):
            raise ValueError("Invalid video input asset id")
        if any(spec["role"] not in INPUT_ROLES for spec in inputs):
            raise ValueError("Invalid video input role")
        input_asset_ids = [spec["asset_id"] for spec in inputs]
        for asset_id in input_asset_ids:
            asset = self.get_asset(asset_id)
            if not asset or asset["project_id"] != project_id:
                raise ValueError("Input assets must belong to the video project")
        retry_of = payload.get("retry_of_job_id")
        if retry_of:
            related = self.get_job(str(retry_of))
            if not related or related["project_id"] != project_id:
                raise ValueError("Retry job must belong to the same video project")
            if related["status"] not in RETRYABLE_STATUSES:
                raise VideoStudioRetryConflictError(
                    "Only failed, cancelled, or interrupted video jobs can be retried"
                )
        params = dict(payload.get("parameters") or {})
        request_payload = {
            **payload,
            "project_id": project_id,
            "input_asset_ids": input_asset_ids,
            "inputs": inputs,
            "parameters": params,
        }
        fingerprint = self._request_hash(request_payload)
        job_id, now = f"video_job_{uuid4().hex}", time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
            ).fetchone():
                raise KeyError(project_id)
            for asset_id in input_asset_ids:
                asset_row = db.execute(
                    """SELECT project_id FROM assets
                       WHERE id=? AND deleted_at IS NULL""",
                    (asset_id,),
                ).fetchone()
                if not asset_row or asset_row["project_id"] != project_id:
                    raise ValueError("Input assets must belong to the video project")
            if retry_of:
                retry_row = db.execute(
                    "SELECT project_id,status FROM jobs WHERE id=?", (str(retry_of),)
                ).fetchone()
                if not retry_row or retry_row["project_id"] != project_id:
                    raise ValueError("Retry job must belong to the same video project")
                if retry_row["status"] not in RETRYABLE_STATUSES:
                    raise VideoStudioRetryConflictError(
                        "Only failed, cancelled, or interrupted video jobs can be retried"
                    )
            shot_id = str(payload.get("storyboard_shot_id") or "")
            if shot_id:
                board_row = db.execute(
                    "SELECT document_json FROM storyboards WHERE project_id=?", (project_id,)
                ).fetchone()
                board = json.loads(board_row[0] or "{}") if board_row else {}
                if not any(shot.get("id") == shot_id for shot in board.get("shots") or []):
                    raise ValueError("Storyboard shot not found")
            node_id = str(payload.get("board_node_id") or "")
            if node_id:
                node = find_board_node(self.get_board(project_id), node_id)
                if not node or node.get("kind") != "generate":
                    raise ValueError("Board generate node not found")
            existing = db.execute(
                "SELECT id,request_hash FROM jobs WHERE owner_user_id=? AND client_request_id=?",
                (owner, request_id),
            ).fetchone()
            if existing:
                if existing["request_hash"] != fingerprint:
                    raise ValueError("client_request_id was already used for a different request")
                return self.get_job(str(existing["id"])) or {}
            pending = int(
                db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','submitting','running')"
                ).fetchone()[0]
            )
            if pending >= MAX_PENDING_JOBS:
                raise VideoStudioQueueFullError("Video Studio already has too many active jobs")
            db.execute(
                """INSERT INTO jobs
                   (id,project_id,retry_of_job_id,storyboard_shot_id,board_node_id,client_request_id,request_hash,operation,status,
                    profile_id,model_id,prompt,parameters_json,owner_user_id,config_revision,
                    provider_task_id,progress,stage,error_code,error_message,created_at,started_at,finished_at)
                   VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,NULL,0,'queued',NULL,NULL,?,NULL,NULL)""",
                (
                    job_id,
                    project_id,
                    retry_of,
                    payload.get("storyboard_shot_id"),
                    node_id or None,
                    request_id,
                    fingerprint,
                    operation,
                    str(payload.get("profile_id") or ""),
                    str(payload.get("model_id") or ""),
                    prompt,
                    json.dumps(params, ensure_ascii=False),
                    owner,
                    revision,
                    now,
                ),
            )
            for position, spec in enumerate(inputs):
                db.execute(
                    "INSERT INTO job_inputs (job_id,asset_id,position,role) VALUES (?,?,?,?)",
                    (job_id, spec["asset_id"], position, spec["role"]),
                )
        self.add_event(job_id, "job.queued", {"status": "queued", "progress": 0})
        return self.get_job(job_id) or {}

    def _job_inputs(self, db: Any, job_id: str) -> list[dict[str, str]]:
        return [
            {"asset_id": str(row[0]), "role": str(row[1] or "reference")}
            for row in db.execute(
                "SELECT asset_id, role FROM job_inputs WHERE job_id=? ORDER BY position",
                (job_id,),
            ).fetchall()
        ]

    def _assemble_jobs(self, db: Any, rows: list[Any]) -> list[dict[str, Any]]:
        """Shape raw ``jobs`` rows with their relations, loading in bulk.

        One connection, one query per relation table instead of three queries
        per job — listing a full page used to reopen the database N+1 times.
        Input/output ordering matches the per-job queries exactly.
        """
        if not rows:
            return []
        ids = [str(row["id"]) for row in rows]
        placeholders = ",".join("?" * len(ids))
        inputs_by_job: dict[str, list[dict[str, str]]] = {job_id: [] for job_id in ids}
        for asset_id, role, job_id in db.execute(
            f"SELECT asset_id, role, job_id FROM job_inputs WHERE job_id IN ({placeholders}) ORDER BY position",  # nosec B608 - placeholder string only
            ids,
        ):
            inputs_by_job[str(job_id)].append(
                {"asset_id": str(asset_id), "role": str(role or "reference")}
            )
        outputs_by_job: dict[str, list[str]] = {job_id: [] for job_id in ids}
        for asset_id, job_id in db.execute(
            f"SELECT asset_id, job_id FROM job_outputs WHERE job_id IN ({placeholders}) ORDER BY position",  # nosec B608 - placeholder string only
            ids,
        ):
            outputs_by_job[str(job_id)].append(str(asset_id))
        results = []
        for row in rows:
            result = dict(row)
            job_id = str(result["id"])
            result["parameters"] = json.loads(result.pop("parameters_json") or "{}")
            result["input_asset_ids"] = [item["asset_id"] for item in inputs_by_job[job_id]]
            result["inputs"] = inputs_by_job[job_id]
            result["output_asset_ids"] = outputs_by_job[job_id]
            result["error"] = (
                {
                    "code": str(result.get("error_code") or ""),
                    "message": str(result.get("error_message") or ""),
                }
                if result.get("error_code") or result.get("error_message")
                else None
            )
            result.pop("request_hash", None)
            result.pop("config_revision", None)
            result.pop("owner_user_id", None)
            result.pop("provider_task_id", None)
            results.append(result)
        return results

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            return self._assemble_jobs(db, [row])[0]

    def _internal_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            inputs = self._job_inputs(db, job_id)
        result = dict(row)
        result["parameters"] = json.loads(result.pop("parameters_json") or "{}")
        result["input_asset_ids"] = [item["asset_id"] for item in inputs]
        result["inputs"] = inputs
        return result

    def list_jobs(
        self,
        project_id: str,
        *,
        status: str = "",
        operation: str = "",
        limit: int = 50,
        before: float | None = None,
    ) -> list[dict[str, Any]]:
        clauses, args = ["project_id=?"], [project_id]
        if status:
            clauses.append("status=?")
            args.append(status)
        if operation:
            clauses.append("operation=?")
            args.append(operation)
        if before is not None:
            clauses.append("created_at<?")
            args.append(float(before))
        args.append(max(1, min(int(limit), 100)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM jobs WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",  # nosec B608 - hardcoded clauses, bound args
                args,
            ).fetchall()
            return self._assemble_jobs(db, rows)

    def list_shot_jobs(self, project_id: str, shot_id: str) -> list[dict[str, Any]]:
        """Every job ever bound to one storyboard shot, newest first (搂Phase C5).

        Retry and reroll jobs inherit ``storyboard_shot_id``, so the variant
        history of a shot is exactly this column's history 鈥?no extra linkage
        table is needed. ``id DESC`` breaks ties deterministically when jobs
        share a timestamp.
        """
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM jobs
                   WHERE project_id=? AND storyboard_shot_id=?
                   ORDER BY created_at DESC, id DESC""",
                (project_id, shot_id),
            ).fetchall()
            return self._assemble_jobs(db, rows)

    def resumable_job_ids(self) -> list[str]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id FROM jobs
                   WHERE status='queued' OR (status IN ('submitting','running') AND provider_task_id IS NOT NULL)
                   ORDER BY created_at"""
            ).fetchall()
        return [str(row[0]) for row in rows]

    def claim_submission(self, job_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status='submitting',stage='submitting',started_at=COALESCE(started_at,?)
                   WHERE id=? AND status='queued'""",
                (time.time(), job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id, "job.submitting", {"status": "submitting", "stage": "submitting"}
            )
        return cursor.rowcount > 0

    def record_provider_task(self, job_id: str, provider_task_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET provider_task_id=?,status='running',stage='rendering',progress=MAX(progress,0.01)
                   WHERE id=? AND status='submitting'""",
                (provider_task_id, job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id,
                "job.running",
                {"status": "running", "stage": "rendering", "progress": 0.01},
            )
        return cursor.rowcount > 0

    def update_progress(self, job_id: str, progress: float, stage: str, message: str = "") -> bool:
        value = max(0.0, min(float(progress), 0.99))
        stage_value = str(stage or "rendering")[:80]
        with self._lock, self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET progress=MAX(progress,?),stage=?
                   WHERE id=? AND status='running' AND (progress<? OR stage<>?)""",
                (value, stage_value, job_id, value, stage_value),
            )
        if cursor.rowcount:
            current = self._internal_job(job_id) or {}
            self.add_event(
                job_id,
                "job.progress",
                {
                    "status": "running",
                    "progress": float(current.get("progress") or value),
                    "stage": str(current.get("stage") or stage_value),
                    "message": message[:500],
                },
            )
        return cursor.rowcount > 0

    def cancel_active_job(self, job_id: str) -> str | None:
        """Atomically cancel an active job and return its previous status."""

        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            previous = str(row["status"]) if row and row["status"] in ACTIVE_STATUSES else ""
            if not previous:
                return None
            cursor = db.execute(
                """UPDATE jobs SET status='cancelled',stage='cancelled',finished_at=?
                   WHERE id=? AND status=?""",
                (now, job_id, previous),
            )
            if not cursor.rowcount:
                return None
            seq = int(
                db.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
                ).fetchone()[0]
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    seq,
                    "job.cancelled",
                    json.dumps(
                        {
                            "status": "cancelled",
                            "progress": 0.0,
                            "stage": "cancelled",
                            "message": "",
                        }
                    ),
                    now,
                ),
            )
        return previous

    def transition_terminal(
        self, job_id: str, status: str, *, error_code: str = "", error_message: str = ""
    ) -> bool:
        if status not in TERMINAL_STATUSES:
            raise ValueError("Invalid terminal status")
        progress = 1.0 if status == "succeeded" else 0.0
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status=?,stage=?,progress=CASE WHEN ?='succeeded' THEN 1 ELSE progress END,
                   error_code=NULLIF(?,''),error_message=NULLIF(?,''),finished_at=?
                   WHERE id=? AND status IN ('queued','submitting','running')""",
                (status, status, status, error_code, error_message[:1000], time.time(), job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id,
                f"job.{status}",
                {
                    "status": status,
                    "progress": progress,
                    "stage": status,
                    "message": error_message[:500],
                },
            )
        return cursor.rowcount > 0

    def complete_job_with_output(self, job_id: str, asset_id: str) -> bool:
        """Atomically publish an output and move a running job to succeeded.

        The storyboard patch is part of the same transaction when the shot is
        still linked to this job. A concurrent cancellation wins cleanly and
        leaves the caller free to remove the unreferenced output asset.
        """
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT j.project_id,j.storyboard_shot_id,a.project_id AS asset_project
                   FROM jobs j JOIN assets a ON a.id=? AND a.deleted_at IS NULL
                   WHERE j.id=?""",
                (asset_id, job_id),
            ).fetchone()
            if not row or row["project_id"] != row["asset_project"]:
                raise ValueError("Video output must belong to the job project")
            cursor = db.execute(
                """UPDATE jobs SET status='succeeded',stage='succeeded',progress=1,
                   error_code=NULL,error_message=NULL,finished_at=?
                   WHERE id=? AND status='running'""",
                (now, job_id),
            )
            if not cursor.rowcount:
                return False
            db.execute(
                "INSERT INTO job_outputs(job_id,asset_id,position) VALUES (?,?,0)",
                (job_id, asset_id),
            )

            shot_id = str(row["storyboard_shot_id"] or "")
            if shot_id:
                board = db.execute(
                    "SELECT revision,document_json FROM storyboards WHERE project_id=?",
                    (row["project_id"],),
                ).fetchone()
                if board:
                    document = json.loads(board["document_json"] or "{}")
                    changed = False
                    shots: list[dict[str, Any]] = []
                    for raw_shot in document.get("shots") or []:
                        shot = dict(raw_shot)
                        if shot.get("id") == shot_id and shot.get("job_id") == job_id:
                            shot["output_asset_id"] = asset_id
                            changed = True
                        shots.append(shot)
                    if changed:
                        db.execute(
                            """UPDATE storyboards SET revision=revision+1,document_json=?,updated_at=?
                               WHERE project_id=? AND revision=?""",
                            (
                                json.dumps({"shots": shots}, ensure_ascii=False),
                                now,
                                row["project_id"],
                                int(board["revision"]),
                            ),
                        )

            next_seq = int(
                db.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
                ).fetchone()[0]
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    next_seq,
                    "job.output",
                    json.dumps({"asset_id": asset_id, "position": 0}),
                    now,
                ),
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    next_seq + 1,
                    "job.succeeded",
                    json.dumps(
                        {
                            "status": "succeeded",
                            "progress": 1.0,
                            "stage": "succeeded",
                            "message": "",
                        }
                    ),
                    now,
                ),
            )
        return True

    def add_job_output(self, job_id: str, asset_id: str, position: int = 0) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO job_outputs VALUES (?,?,?)", (job_id, asset_id, position)
            )
        self.add_event(job_id, "job.output", {"asset_id": asset_id, "position": position})

    def add_event(self, job_id: str, event_type: str, payload: dict[str, Any]) -> int:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
            ).fetchone()
            seq = int(row[0])
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (job_id, seq, event_type, json.dumps(payload, ensure_ascii=False), time.time()),
            )
        return seq

    def events_after(self, job_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq",
                (job_id, max(0, int(after_seq))),
            ).fetchall()
        events = []
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            events.append(
                {
                    "job_id": job_id,
                    "seq": int(row["seq"]),
                    "type": row["type"],
                    "created_at": row["created_at"],
                    **payload,
                }
            )
        return events
