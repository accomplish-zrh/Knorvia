"""Built-in cron service — scheduled tasks for chat and partners.

A trimmed-down take on nanobot's CronService (docs/ref/nanobot): same job
semantics (``at`` / ``every`` / ``cron`` schedules, JSON persistence, run
bookkeeping) without the multi-process file-lock/action-log machinery —
Knorvia runs one server process, so a single in-process scheduler owns
the store.

Jobs carry an *owner*: a chat session (the reply is appended to that
session) or a partner conversation (the prompt is injected into the
partner's message bus and the reply rides the original IM channel). The
executor lives in :mod:`knorvia.services.cron.executor`.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import asdict, dataclass, field
from datetime import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import stat
import time
from typing import Any, Awaitable, Callable
import uuid

logger = logging.getLogger(__name__)

# Re-check the schedule at least this often even when nothing is due —
# cheap, and it picks up externally-edited stores within a minute.
_MAX_SLEEP_SECONDS = 60.0
_MAX_RUN_HISTORY = 10
# Append-only cross-job run journal (<store stem>.runs.jsonl). Per-job
# ``run_history`` dies with the job (deleted tasks, finished one-shots);
# the journal keeps recent runs visible in the execution-history view.
MAX_RUN_LOG_ENTRIES = 500
MAX_JOBS_PER_OWNER = 20
MAX_TOTAL_JOBS = 500
MAX_NAME_LENGTH = 120
MAX_MESSAGE_LENGTH = 20_000
MAX_SESSION_ID_LENGTH = 200
MAX_CRON_EXPRESSION_LENGTH = 200
MAX_TIMEZONE_LENGTH = 100
MAX_CONCURRENT_RUNS = 4
JOB_TIMEOUT_SECONDS = 300.0
_CANCEL_GRACE_SECONDS = 2.0
_CLAIM_STALE_SECONDS = JOB_TIMEOUT_SECONDS + 60.0


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class CronSchedule:
    """When a job runs: one-shot, fixed interval, or cron expression."""

    kind: str  # "at" | "every" | "cron"
    at_ms: int | None = None  # "at": epoch ms
    every_seconds: int | None = None  # "every": interval
    expr: str | None = None  # "cron": e.g. "0 9 * * *"
    tz: str | None = None  # "cron": IANA timezone


@dataclass
class CronOwner:
    """Who scheduled the job and where its output goes."""

    kind: str  # "chat" | "partner"
    user_id: str = ""  # chat: owning user
    # Kept only so old stores remain readable.  Execution always resolves the
    # account's *current* role; a persisted privilege snapshot is untrusted.
    is_admin: bool = False
    session_id: str = ""  # chat: reply lands in this session
    language: str = "en"
    partner_id: str = ""  # partner: owning partner
    channel: str = ""  # partner: originating channel
    chat_id: str = ""  # partner: originating chat
    session_key: str = ""  # partner: conversation key
    channel_meta: dict[str, Any] = field(default_factory=dict)  # partner: thread/reply metadata

    @property
    def key(self) -> str:
        if self.kind == "partner":
            return f"partner:{self.partner_id}"
        return f"chat:{self.user_id or 'local-admin'}"


@dataclass
class CronRunRecord:
    run_at_ms: int
    status: str  # "ok" | "error" | "skipped"
    duration_ms: int = 0
    error: str | None = None


@dataclass
class CronRunLogEntry(CronRunRecord):
    """One completed run, journalled independent of the job's lifetime."""

    job_id: str = ""
    job_name: str = ""
    owner_key: str = ""


@dataclass
class CronJobState:
    next_run_at_ms: int | None = None
    last_run_at_ms: int | None = None
    last_status: str | None = None
    last_error: str | None = None
    run_history: list[CronRunRecord] = field(default_factory=list)


@dataclass
class CronJob:
    id: str
    name: str
    message: str
    schedule: CronSchedule
    owner: CronOwner
    enabled: bool = True
    delete_after_run: bool = False
    created_at_ms: int = 0
    state: CronJobState = field(default_factory=CronJobState)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CronJob":
        state = dict(data.get("state") or {})
        state["run_history"] = [CronRunRecord(**record) for record in state.get("run_history", [])]
        return cls(
            id=str(data["id"]),
            name=str(data.get("name") or ""),
            message=str(data.get("message") or ""),
            schedule=CronSchedule(**(data.get("schedule") or {"kind": "every"})),
            owner=CronOwner(**(data.get("owner") or {"kind": "chat"})),
            enabled=bool(data.get("enabled", True)),
            delete_after_run=bool(data.get("delete_after_run", False)),
            created_at_ms=int(data.get("created_at_ms", 0)),
            state=CronJobState(**state),
        )


def compute_next_run(schedule: CronSchedule, now_ms: int) -> int | None:
    """Next due time in epoch ms, or ``None`` for never/expired."""
    if schedule.kind == "at":
        if schedule.at_ms and schedule.at_ms > now_ms:
            return schedule.at_ms
        return None

    if schedule.kind == "every":
        if not schedule.every_seconds or schedule.every_seconds <= 0:
            return None
        return now_ms + schedule.every_seconds * 1000

    if schedule.kind == "cron" and schedule.expr:
        try:
            from zoneinfo import ZoneInfo

            from croniter import croniter

            tz = ZoneInfo(schedule.tz) if schedule.tz else datetime.now().astimezone().tzinfo
            base = datetime.fromtimestamp(now_ms / 1000, tz=tz)
            next_dt = croniter(schedule.expr, base).get_next(datetime)
            return int(next_dt.timestamp() * 1000)
        except ImportError:
            raise ValueError(
                "cron expressions need the 'croniter' package — "
                "use an 'every' or 'at' schedule instead"
            ) from None
        except Exception as exc:
            raise ValueError(f"invalid cron expression {schedule.expr!r}: {exc}") from None

    return None


def validate_schedule(schedule: CronSchedule) -> None:
    """Reject schedules that could never run (raises ValueError)."""
    if schedule.kind == "at":
        if not schedule.at_ms:
            raise ValueError("'at' schedules need a time")
        if schedule.at_ms <= _now_ms():
            raise ValueError("'at' time is in the past")
        return
    if schedule.kind == "every":
        if not schedule.every_seconds or schedule.every_seconds < 30:
            raise ValueError("'every' interval must be at least 30 seconds")
        return
    if schedule.kind == "cron":
        if len(schedule.expr or "") > MAX_CRON_EXPRESSION_LENGTH:
            raise ValueError(
                f"cron expression must be at most {MAX_CRON_EXPRESSION_LENGTH} characters"
            )
        if len(schedule.tz or "") > MAX_TIMEZONE_LENGTH:
            raise ValueError(f"timezone must be at most {MAX_TIMEZONE_LENGTH} characters")
        if schedule.tz:
            try:
                from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

                ZoneInfo(schedule.tz)
            except ZoneInfoNotFoundError:
                raise ValueError(
                    f"unknown timezone {schedule.tz!r} — on Windows, install the "
                    "'tzdata' package to enable IANA time zones"
                ) from None
            except Exception:
                raise ValueError(f"unknown timezone {schedule.tz!r}") from None
        # Raises ValueError on bad/unsupported expressions.
        if compute_next_run(schedule, _now_ms()) is None:
            raise ValueError(f"cron expression {schedule.expr!r} never fires")
        return
    raise ValueError(f"unknown schedule kind {schedule.kind!r}")


class CronService:
    """Single-process job store + scheduler."""

    def __init__(
        self,
        store_path: Path,
        on_job: Callable[[CronJob], Awaitable[tuple[str, str | None]]] | None = None,
    ) -> None:
        """``on_job`` returns ``(status, error)`` with status ok/error/skipped."""
        self.store_path = store_path
        self.on_job = on_job
        self._jobs: dict[str, CronJob] = {}
        self._loaded = False
        self._timer_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._running = False
        self._active_job_ids: set[str] = set()
        self._run_slots = asyncio.Semaphore(MAX_CONCURRENT_RUNS)
        self._claims_dir = self.store_path.with_name(f"{self.store_path.stem}.claims")
        self._run_log_path = self.store_path.with_name(f"{self.store_path.stem}.runs.jsonl")
        self._run_log_lines: int | None = None  # seeded on first append

    # ── persistence ───────────────────────────────────────────────

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self.store_path.exists():
            return
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
            for raw in data.get("jobs", []):
                job = CronJob.from_dict(raw)
                self._jobs[job.id] = job
        except Exception:
            # Preserve the corrupt store for recovery; an empty in-memory
            # view would otherwise overwrite it on the next save.
            backup = self.store_path.with_suffix(f".corrupt-{int(time.time())}")
            try:
                self.store_path.rename(backup)
            except OSError:
                pass
            logger.exception("Corrupt cron store moved to %s", backup)

    def _save(self) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "jobs": [asdict(job) for job in self._jobs.values()]}
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.store_path)

    # ── job management ────────────────────────────────────────────

    def add_job(
        self,
        *,
        name: str,
        message: str,
        schedule: CronSchedule,
        owner: CronOwner,
        delete_after_run: bool | None = None,
    ) -> CronJob:
        self._load()
        validate_schedule(schedule)
        cleaned_name, cleaned_message = self._validate_content(name, message)
        if len(self._jobs) >= MAX_TOTAL_JOBS:
            raise ValueError(f"scheduled task limit reached ({MAX_TOTAL_JOBS})")
        owner_count = sum(1 for job in self._jobs.values() if job.owner.key == owner.key)
        if owner_count >= MAX_JOBS_PER_OWNER:
            raise ValueError(f"scheduled task limit reached for this owner ({MAX_JOBS_PER_OWNER})")
        if len(owner.session_id) > MAX_SESSION_ID_LENGTH:
            raise ValueError(f"session_id must be at most {MAX_SESSION_ID_LENGTH} characters")
        job = CronJob(
            id=uuid.uuid4().hex[:10],
            name=cleaned_name or cleaned_message[:48],
            message=cleaned_message,
            schedule=schedule,
            owner=owner,
            # One-shot jobs clean up after themselves unless told otherwise.
            delete_after_run=(
                delete_after_run if delete_after_run is not None else schedule.kind == "at"
            ),
            created_at_ms=_now_ms(),
        )
        job.state.next_run_at_ms = compute_next_run(schedule, _now_ms())
        self._jobs[job.id] = job
        self._save()
        self._wake.set()
        return job

    @staticmethod
    def _validate_content(name: str, message: str) -> tuple[str, str]:
        cleaned_name = name.strip()
        cleaned_message = message.strip()
        if not cleaned_message:
            raise ValueError("message is required")
        if len(cleaned_name) > MAX_NAME_LENGTH:
            raise ValueError(f"name must be at most {MAX_NAME_LENGTH} characters")
        if len(cleaned_message) > MAX_MESSAGE_LENGTH:
            raise ValueError(f"message must be at most {MAX_MESSAGE_LENGTH} characters")
        return cleaned_name, cleaned_message

    def list_jobs(self, owner_key: str | None = None) -> list[CronJob]:
        self._load()
        jobs = list(self._jobs.values())
        if owner_key is not None:
            jobs = [job for job in jobs if job.owner.key == owner_key]
        return sorted(jobs, key=lambda job: job.state.next_run_at_ms or 0)

    def get_job(self, job_id: str) -> CronJob | None:
        self._load()
        return self._jobs.get(job_id)

    def set_enabled(
        self, job_id: str, enabled: bool, *, owner_key: str | None = None
    ) -> CronJob | None:
        self._load()
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if owner_key is not None and job.owner.key != owner_key:
            return None
        job.enabled = bool(enabled)
        if job.enabled and job.state.next_run_at_ms is None:
            job.state.next_run_at_ms = compute_next_run(job.schedule, _now_ms())
        self._save()
        self._wake.set()
        return job

    def update_job(
        self,
        job_id: str,
        *,
        name: str | None = None,
        message: str | None = None,
        session_id: str | None = None,
        schedule: CronSchedule | None = None,
        owner_key: str | None = None,
    ) -> CronJob | None:
        self._load()
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if owner_key is not None and job.owner.key != owner_key:
            return None
        if name is not None:
            cleaned_name = name.strip()
            if len(cleaned_name) > MAX_NAME_LENGTH:
                raise ValueError(f"name must be at most {MAX_NAME_LENGTH} characters")
            job.name = cleaned_name or job.name
        if message is not None:
            _ignored_name, cleaned_message = self._validate_content("", message)
            job.message = cleaned_message
        if session_id is not None and job.owner.kind == "chat":
            if len(session_id.strip()) > MAX_SESSION_ID_LENGTH:
                raise ValueError(f"session_id must be at most {MAX_SESSION_ID_LENGTH} characters")
            job.owner.session_id = session_id.strip()
        if schedule is not None:
            validate_schedule(schedule)
            job.schedule = schedule
            job.state.next_run_at_ms = compute_next_run(schedule, _now_ms())
        self._save()
        self._wake.set()
        return job

    def run_now(self, job_id: str, *, owner_key: str | None = None) -> CronJob | None:
        """Queue the job to run on the next scheduler tick."""
        self._load()
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if owner_key is not None and job.owner.key != owner_key:
            return None
        job.enabled = True
        job.state.next_run_at_ms = _now_ms()
        self._save()
        self._wake.set()
        return job

    def cancel_job(self, job_id: str, *, owner_key: str | None = None) -> bool:
        """Remove a job; ``owner_key`` scopes the cancel to its owner."""
        self._load()
        job = self._jobs.get(job_id)
        if job is None:
            return False
        if owner_key is not None and job.owner.key != owner_key:
            return False
        del self._jobs[job_id]
        self._save()
        self._wake.set()
        return True

    def remove_owner_jobs(self, owner_key: str) -> int:
        """Drop every job belonging to *owner_key* (e.g. a destroyed partner)."""
        self._load()
        doomed = [job_id for job_id, job in self._jobs.items() if job.owner.key == owner_key]
        for job_id in doomed:
            del self._jobs[job_id]
        if doomed:
            self._save()
            self._wake.set()
        return len(doomed)

    # ── run journal ───────────────────────────────────────────────
    # Best-effort and never fatal: bookkeeping on the job itself is the
    # source of truth, the journal only feeds the history view.

    def _append_run_log(self, entry: CronRunLogEntry) -> None:
        try:
            self._run_log_path.parent.mkdir(parents=True, exist_ok=True)
            with self._run_log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
        except OSError:
            logger.warning("Could not append cron run log", exc_info=True)
            return
        # Line count tracked in memory (seeded once from disk, reset on trim):
        # recounting the whole file after every append was O(journal) I/O.
        if self._run_log_lines is None:
            try:
                with self._run_log_path.open(encoding="utf-8") as handle:
                    self._run_log_lines = sum(1 for _ in handle)
            except OSError:
                self._run_log_lines = 0
        else:
            self._run_log_lines += 1
        if self._run_log_lines > MAX_RUN_LOG_ENTRIES:
            self._trim_run_log()
            self._run_log_lines = MAX_RUN_LOG_ENTRIES

    def _trim_run_log(self) -> None:
        try:
            lines = self._run_log_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        keep = [line for line in lines[-MAX_RUN_LOG_ENTRIES:] if line.strip()]
        tmp = self._run_log_path.with_suffix(".tmp")
        try:
            tmp.write_text("\n".join(keep) + "\n", encoding="utf-8")
            tmp.replace(self._run_log_path)
        except OSError:
            logger.warning("Could not trim cron run log", exc_info=True)

    def list_runs(
        self, owner_key: str | None = None, *, limit: int = MAX_RUN_LOG_ENTRIES
    ) -> list[CronRunLogEntry]:
        """Recent runs across all jobs, newest first (owner-filterable).

        Reads are tolerant of a torn final line — a crash mid-append must
        not take the history view down.
        """
        capped = max(1, min(int(limit), MAX_RUN_LOG_ENTRIES))
        try:
            lines = self._run_log_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        entries: list[CronRunLogEntry] = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
                entries.append(
                    CronRunLogEntry(
                        job_id=str(raw.get("job_id") or ""),
                        job_name=str(raw.get("job_name") or ""),
                        owner_key=str(raw.get("owner_key") or ""),
                        run_at_ms=int(raw.get("run_at_ms") or 0),
                        status=str(raw.get("status") or "error"),
                        duration_ms=int(raw.get("duration_ms") or 0),
                        error=raw.get("error"),
                    )
                )
            except (ValueError, TypeError, AttributeError):
                continue
        if owner_key is not None:
            entries = [entry for entry in entries if entry.owner_key == owner_key]
        entries.sort(key=lambda entry: entry.run_at_ms, reverse=True)
        return entries[:capped]

    # ── scheduler ─────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            return
        self._load()
        # Re-arm interval/cron jobs whose due time passed while the server
        # was down: run once now (next_run in the past stays "due"); expired
        # one-shots are dropped.
        now = _now_ms()
        changed = False
        for job in list(self._jobs.values()):
            if job.schedule.kind == "at" and (job.schedule.at_ms or 0) <= now:
                del self._jobs[job.id]
                changed = True
        if changed:
            self._save()
        self._running = True
        self._timer_task = asyncio.create_task(self._loop(), name="cron:scheduler")
        logger.info("Cron service started (%d jobs)", len(self._jobs))

    async def stop(self) -> None:
        self._running = False
        if self._timer_task:
            self._timer_task.cancel()
            try:
                await self._timer_task
            except asyncio.CancelledError:
                pass
            self._timer_task = None

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Cron tick failed")
            sleep_s = self._seconds_until_next_due()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=sleep_s)
            except asyncio.TimeoutError:
                pass

    def _seconds_until_next_due(self) -> float:
        due_times = [
            job.state.next_run_at_ms
            for job in self._jobs.values()
            if job.enabled and job.state.next_run_at_ms
        ]
        if not due_times:
            return _MAX_SLEEP_SECONDS
        delta_s = (min(due_times) - _now_ms()) / 1000
        return max(0.05, min(delta_s, _MAX_SLEEP_SECONDS))

    async def _tick(self) -> None:
        now = _now_ms()
        due: list[CronJob] = []
        for job in list(self._jobs.values()):
            if not job.enabled or not job.state.next_run_at_ms:
                continue
            if job.state.next_run_at_ms > now:
                continue
            if job.id in self._active_job_ids:
                continue
            self._active_job_ids.add(job.id)
            due.append(job)
        if due:
            await asyncio.gather(*(self._run_job_bounded(job) for job in due))

    async def _run_job_bounded(self, job: CronJob) -> None:
        try:
            async with self._run_slots:
                await self._run_job(job)
        finally:
            self._active_job_ids.discard(job.id)

    async def _run_job(self, job: CronJob) -> None:
        expected_next = job.state.next_run_at_ms
        claim = self._try_claim(job.id)
        if claim is None:
            return
        try:
            if not self._still_due_in_store(job.id, expected_next):
                self._refresh_from_store(job.id)
                return
            await self._run_claimed_job(job)
        finally:
            with contextlib.suppress(OSError):
                claim.unlink()

    async def _run_claimed_job(self, job: CronJob) -> None:
        started = _now_ms()
        status, error = "skipped", None
        if self.on_job is not None:
            task = asyncio.create_task(self.on_job(job), name=f"cron:job:{job.id}")
            try:
                done, pending = await asyncio.wait({task}, timeout=JOB_TIMEOUT_SECONDS)
                if pending:
                    task.cancel()
                    done, pending = await asyncio.wait({task}, timeout=_CANCEL_GRACE_SECONDS)
                    if pending:
                        logger.warning("Cron job %s ignored cancellation and was detached", job.id)
                        task.add_done_callback(_consume_task_result)
                    else:
                        _consume_task_result(task)
                    status, error = "error", f"timed out after {JOB_TIMEOUT_SECONDS:g} seconds"
                else:
                    status, error = task.result()
            except asyncio.CancelledError:
                if task.done() and not task.cancelled():
                    status, error = task.result()
                else:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await asyncio.wait_for(task, timeout=_CANCEL_GRACE_SECONDS)
                    raise
            except Exception as exc:
                status, error = "error", f"{type(exc).__name__}: {exc}"
                logger.exception("Cron job %s (%s) crashed", job.id, job.name)

        job.state.last_run_at_ms = started
        job.state.last_status = status
        job.state.last_error = error
        job.state.run_history.append(
            CronRunRecord(
                run_at_ms=started,
                status=status,
                duration_ms=_now_ms() - started,
                error=error,
            )
        )
        job.state.run_history = job.state.run_history[-_MAX_RUN_HISTORY:]

        self._append_run_log(
            CronRunLogEntry(
                job_id=job.id,
                job_name=job.name,
                owner_key=job.owner.key,
                run_at_ms=started,
                status=status,
                duration_ms=_now_ms() - started,
                error=error,
            )
        )

        if job.delete_after_run or job.schedule.kind == "at":
            self._jobs.pop(job.id, None)
        else:
            job.state.next_run_at_ms = compute_next_run(job.schedule, _now_ms())
            if job.state.next_run_at_ms is None:
                self._jobs.pop(job.id, None)
        self._save()

    def _claim_path(self, job_id: str) -> Path:
        digest = hashlib.sha256(job_id.encode("utf-8", errors="replace")).hexdigest()
        return self._claims_dir / f"{digest}.claim"

    def _try_claim(self, job_id: str) -> Path | None:
        self._claims_dir.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self._claims_dir, stat.S_IRWXU)
        path = self._claim_path(job_id)
        for attempt in range(2):
            try:
                fd = os.open(
                    path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, stat.S_IRUSR | stat.S_IWUSR
                )
                with os.fdopen(fd, "w", encoding="ascii") as handle:
                    handle.write(f"{os.getpid()} {_now_ms()}\n")
                return path
            except FileExistsError:
                if attempt or not self._claim_is_stale(path):
                    return None
                with contextlib.suppress(OSError):
                    path.unlink()
        return None

    @staticmethod
    def _claim_is_stale(path: Path) -> bool:
        try:
            return time.time() - path.stat().st_mtime > _CLAIM_STALE_SECONDS
        except OSError:
            return False

    def _read_persisted_job(self, job_id: str) -> CronJob | None:
        try:
            payload = json.loads(self.store_path.read_text(encoding="utf-8"))
            for raw in payload.get("jobs", []):
                if str(raw.get("id")) == job_id:
                    return CronJob.from_dict(raw)
        except (OSError, ValueError, TypeError, KeyError):
            logger.warning("Could not verify cron claim for %s", job_id, exc_info=True)
        return None

    def _still_due_in_store(self, job_id: str, expected_next: int | None) -> bool:
        persisted = self._read_persisted_job(job_id)
        return bool(
            persisted
            and persisted.enabled
            and persisted.state.next_run_at_ms == expected_next
            and persisted.state.next_run_at_ms
            and persisted.state.next_run_at_ms <= _now_ms()
        )

    def _refresh_from_store(self, job_id: str) -> None:
        persisted = self._read_persisted_job(job_id)
        if persisted is None:
            self._jobs.pop(job_id, None)
        else:
            self._jobs[job_id] = persisted


def _consume_task_result(task: asyncio.Task[Any]) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        task.result()


_service: CronService | None = None


def get_cron_service() -> CronService:
    """Process-wide cron service, anchored at the admin workspace."""
    global _service
    if _service is None:
        from knorvia.multi_user.paths import get_admin_path_service
        from knorvia.services.cron.executor import execute_job

        store = get_admin_path_service().workspace_root / "cron" / "jobs.json"
        _service = CronService(store_path=store, on_job=execute_job)
    return _service


__all__ = [
    "CronJob",
    "CronOwner",
    "CronRunLogEntry",
    "CronRunRecord",
    "CronSchedule",
    "CronService",
    "JOB_TIMEOUT_SECONDS",
    "MAX_JOBS_PER_OWNER",
    "MAX_NAME_LENGTH",
    "MAX_MESSAGE_LENGTH",
    "MAX_RUN_LOG_ENTRIES",
    "MAX_SESSION_ID_LENGTH",
    "MAX_TOTAL_JOBS",
    "compute_next_run",
    "get_cron_service",
    "validate_schedule",
]
