"""Client for the shipped knorvia-daemon (Knorvia Protocol over stdio).

This is the production Agent Runtime adapter for Python workers (cron, partners,
CLI). It never execs a user-installed ``codex`` binary.
"""

from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, AsyncIterator, Callable, Deque, IO, Iterator

from knorvia.runtime.home import get_runtime_home
from knorvia.runtime.kernel_transport import (
    KernelClientError,
    KernelClientRecoveryRequired,
    KernelClientTimeout,
    _DEFAULT_POLL_INTERVAL_SECONDS,
    _DEFAULT_RPC_TIMEOUT_SECONDS,
    _FrameReader,
    _deadline_after,
    _frame_payload_size,
    _positive_timeout,
    _read_frame,
    _timeout_from_env,
    _write_frame,
)


class KernelApprovalRequired(KernelClientError):
    """A synchronous caller reached an approval it is not authorized to answer."""

    def __init__(self, approval: dict[str, Any]) -> None:
        self.approval = approval
        approval_id = str(approval.get("id") or approval.get("approvalId") or "")
        super().__init__(f"turn is waiting for approval {approval_id or '<unknown>'}")


_TERMINAL_TURN_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "interrupted"}
)
_DEFAULT_TURN_TIMEOUT_SECONDS = 120.0
_LEGACY_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled", "rejected"})
_INTERRUPTED_LEGACY_ERROR = "Turn interrupted before completion; retry the request."

# Retention is deliberately finite.  A client that cannot account for a live
# approval/terminal notification or a late response must recover from durable
# daemon state; it must never quietly evict that evidence.
_MAX_QUEUED_NOTIFICATIONS = 512
_MAX_QUEUED_NOTIFICATION_BYTES = 8 * 1024 * 1024
_MAX_UNRESOLVED_TIMED_OUT_REQUESTS = 128
_MAX_QUEUED_LATE_RESPONSES = 128
_MAX_QUEUED_LATE_RESPONSE_BYTES = 8 * 1024 * 1024


def resolve_daemon_bin() -> Path:
    env = os.environ.get("KNORVIA_DAEMON_BIN", "").strip()
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env))
    tools_root = Path(__file__).resolve().parents[3]  # D:\tools
    candidates.extend(
        [
            tools_root / "knorvia-kernel" / "knorvia-rs" / "target" / "debug" / "knorvia-daemon.exe",
            tools_root / "knorvia-kernel" / "knorvia-rs" / "target" / "release" / "knorvia-daemon.exe",
            Path(sys.prefix) / "Scripts" / "knorvia-daemon.exe",
        ]
    )
    which = shutil.which("knorvia-daemon")
    if which:
        candidates.append(Path(which))
    for cand in candidates:
        if cand.is_file() and "node_modules" not in str(cand).lower():
            return cand
    raise KernelClientError(
        "knorvia-daemon not found. Set KNORVIA_DAEMON_BIN. "
        "Python ChatOrchestrator is not a production Agent Runtime."
    )


class DaemonSession:
    """A finite-deadline Knorvia Protocol session over one daemon process.

    The daemon sends JSON-RPC responses and live notifications over the same
    stdout pipe.  Calls are intentionally serialized per session, but every
    non-response frame is retained so an approval or terminal event can never
    be accidentally consumed while waiting for an unrelated control response.
    """

    def __init__(
        self,
        home: Path | None = None,
        *,
        rpc_timeout: float | None = None,
    ) -> None:
        self.bin = resolve_daemon_bin()
        self.home = Path(home) if home is not None else get_runtime_home()
        self.home.mkdir(parents=True, exist_ok=True)
        self._io_lock = threading.RLock()
        self._notifications: Deque[dict[str, Any]] = deque()
        self._notification_bytes = 0
        self._responses: dict[str, dict[str, Any]] = {}
        self._late_response_bytes = 0
        self._late_response_sizes: dict[str, int] = {}
        self._timed_out_requests: dict[str, str] = {}
        self._max_notification_count = _MAX_QUEUED_NOTIFICATIONS
        self._max_notification_bytes = _MAX_QUEUED_NOTIFICATION_BYTES
        self._max_timed_out_request_count = _MAX_UNRESOLVED_TIMED_OUT_REQUESTS
        self._max_late_response_count = _MAX_QUEUED_LATE_RESPONSES
        self._max_late_response_bytes = _MAX_QUEUED_LATE_RESPONSE_BYTES
        self._recovery_required = False
        self._recovery_reason: str | None = None
        self._closed = False
        self._rpc_timeout = _positive_timeout(
            rpc_timeout,
            _timeout_from_env(
                "KNORVIA_DAEMON_RPC_TIMEOUT_SECS", _DEFAULT_RPC_TIMEOUT_SECONDS
            ),
        )
        env = os.environ.copy()
        env["KNORVIA_HOME"] = str(self.home)
        env.pop("CODEX_HOME", None)
        # Daemon logs go to stderr, never to the protocol stdout. Route them to
        # a diagnostics file when requested; otherwise they are captured so the
        # pipe cannot block the daemon.
        self._stderr_file = None
        stderr_path = os.environ.get("KNORVIA_DAEMON_STDERR_FILE", "").strip()
        if stderr_path:
            Path(stderr_path).parent.mkdir(parents=True, exist_ok=True)
            self._stderr_file = open(stderr_path, "a", encoding="utf-8")
            stderr: int | IO[str] = self._stderr_file
        else:
            stderr = subprocess.DEVNULL
        self.proc = subprocess.Popen(
            [str(self.bin), "--home", str(self.home)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=env,
            cwd=str(self.home),
        )
        assert self.proc.stdin and self.proc.stdout
        self._reader = _FrameReader(self.proc.stdout, self.proc)
        self._n = 0
        self.server_info: dict[str, Any] = {}
        try:
            result = self.rpc(
                "initialize",
                {
                    "protocol": {"major": 1, "minor": 0},
                    "client": {
                        "name": "knorvia_python_worker",
                        "version": "1.1.0-dev",
                        "platform": sys.platform,
                    },
                    "capabilities": ["thread", "workspace", "artifact", "job", "approval"],
                },
            )
            server = result.get("server") or {}
            if server.get("name") != "knorvia-daemon":
                raise KernelClientError(f"unexpected server identity: {result!r}")
            self.server_info = server
            _write_frame(self.proc.stdin, {"jsonrpc": "2.0", "method": "initialized"})
        except BaseException:
            # An initialize failure must not leave a daemon/App Server pair
            # behind. There is no reader helper thread to orphan here.
            self.close()
            raise

    @property
    def server_version(self) -> str:
        """The daemon's own version, as reported in the initialize result."""
        return str((self.server_info or {}).get("version") or "")

    def rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        """Make one bounded JSON-RPC call and retain interleaved events.

        A response timeout leaves the daemon alive, because a mutating request
        may already have been accepted. The raised exception is explicitly
        uncertain and can be resolved later with
        :meth:`resolve_timed_out_request`; this method never retries it.
        """

        with self._io_lock:
            self._ensure_open_locked()
            assert self.proc.stdin
            self._n += 1
            request_id = f"py-{self._n}"
            deadline = _deadline_after(
                _positive_timeout(timeout, self._rpc_timeout)
            )
            try:
                _write_frame(
                    self.proc.stdin,
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params or {},
                    },
                )
                while True:
                    cached = self._pop_late_response_locked(request_id)
                    if cached is not None:
                        return self._response_result(method, cached)
                    msg = self._reader.read_frame(deadline)
                    if msg.get("id") == request_id:
                        return self._response_result(method, msg)
                    self._route_message_locked(msg)
            except KernelClientTimeout as exc:
                self._remember_timed_out_request_locked(request_id, method)
                raise KernelClientTimeout(
                    f"{method} did not receive a daemon response within the local deadline; "
                    "the daemon may have accepted it, so do not retry automatically",
                    method=method,
                    request_id=request_id,
                ) from exc
            except (BrokenPipeError, OSError) as exc:
                self._abort_locked()
                raise KernelClientError(f"daemon pipe failed during {method}: {exc}") from exc

    def drain_notifications(self, *, method: str | None = None) -> list[dict[str, Any]]:
        """Return queued notifications, optionally retaining other methods."""

        with self._io_lock:
            drained: list[dict[str, Any]] = []
            remaining: Deque[dict[str, Any]] = deque()
            remaining_bytes = 0
            while self._notifications:
                notification = self._notifications.popleft()
                if method is None or notification.get("method") == method:
                    drained.append(notification)
                else:
                    remaining.append(notification)
                    remaining_bytes += _frame_payload_size(notification)
            self._notifications = remaining
            self._notification_bytes = remaining_bytes
            return drained

    def iter_replay_events(
        self,
        stream_id: str,
        *,
        activity: bool = False,
        page_limit: int = 500,
        max_bytes: int = 1024 * 1024,
        timeout: float = 30.0,
    ) -> Iterator[dict[str, Any]]:
        """Yield a validated frozen replay without building one giant response.

        A cold or repaired sidecar is rebuilt by the daemon in bounded slices.
        That read-only response is safe to retry at the same cursor; every other
        protocol error is surfaced unchanged.
        """

        if not isinstance(stream_id, str) or not stream_id:
            raise KernelClientError("replay stream_id must be a non-empty string")
        if not isinstance(page_limit, int) or not 1 <= page_limit <= 500:
            raise KernelClientError("replay page_limit must be between 1 and 500")
        if not isinstance(max_bytes, int) or not 512 <= max_bytes <= 6 * 1024 * 1024:
            raise KernelClientError("replay max_bytes must be between 512 and 6291456")
        deadline = time.monotonic() + _positive_timeout(timeout, 30.0)
        method = "activity/list" if activity else "event/replay"
        after_seq = 0
        upper_seq: int | None = None
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {
                "streamId": stream_id,
                "afterSeq": after_seq,
                "limit": page_limit,
                "maxBytes": max_bytes,
            }
            if upper_seq is not None:
                params["upperSeq"] = upper_seq
                params["cursor"] = cursor
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise KernelClientTimeout(
                    f"{method} did not finish its frozen replay within {timeout:g}s"
                )
            try:
                page = self.rpc(method, params, timeout=remaining)
            except KernelClientError as exc:
                if "replay_index_building:" not in str(exc):
                    raise
                if time.monotonic() >= deadline:
                    raise KernelClientTimeout(
                        f"{method} index rebuild did not finish within {timeout:g}s"
                    ) from exc
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
                continue
            if not isinstance(page, dict) or not isinstance(page.get("events"), list):
                raise KernelClientError(f"invalid {method} page: missing events")
            page_upper = page.get("upperSeq")
            next_seq = page.get("nextSeq")
            has_more = page.get("hasMore")
            next_cursor = page.get("nextCursor")
            if (
                not isinstance(page_upper, int)
                or isinstance(page_upper, bool)
                or not isinstance(next_seq, int)
                or isinstance(next_seq, bool)
                or not isinstance(has_more, bool)
                or not isinstance(next_cursor, str)
                or not next_cursor
            ):
                raise KernelClientError(f"invalid {method} paging metadata")
            if upper_seq is None:
                upper_seq = page_upper
            elif page_upper != upper_seq:
                raise KernelClientError(f"{method} changed its frozen upperSeq")
            expected = after_seq + 1
            for event in page["events"]:
                if (
                    not isinstance(event, dict)
                    or event.get("streamId") != stream_id
                    or event.get("seq") != expected
                ):
                    raise KernelClientError(
                        f"{method} returned a foreign or non-contiguous event"
                    )
                expected += 1
                yield event
            delivered_seq = expected - 1
            if next_seq != delivered_seq or has_more != (next_seq < upper_seq):
                raise KernelClientError(f"invalid {method} cursor progression")
            if has_more and next_seq == after_seq:
                raise KernelClientError(f"{method} did not advance an unfinished page")
            after_seq = next_seq
            if not has_more:
                return
            cursor = next_cursor

    def wait_for_notification(
        self,
        *,
        method: str | None = None,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
        timeout: float = _DEFAULT_RPC_TIMEOUT_SECONDS,
    ) -> dict[str, Any] | None:
        """Wait a finite interval for one matching notification.

        An ordinary notification timeout is not a broken session, so this
        method returns ``None``. Pipe closure and malformed protocol frames
        remain typed errors.
        """

        deadline = _deadline_after(timeout)
        with self._io_lock:
            self._ensure_open_locked()
            found = self._pop_notification_locked(method, predicate)
            if found is not None:
                return found
            while True:
                try:
                    msg = self._reader.read_frame(deadline)
                except KernelClientTimeout:
                    return None
                self._route_message_locked(msg)
                found = self._pop_notification_locked(method, predicate)
                if found is not None:
                    return found

    def resolve_timed_out_request(
        self,
        request_id: str,
        *,
        timeout: float = _DEFAULT_RPC_TIMEOUT_SECONDS,
    ) -> Any | None:
        """Resolve an explicitly uncertain timed-out request without replaying it.

        ``None`` means its response has still not arrived within this finite
        wait; the request remains recoverable through this method or through
        the protocol's durable state reads. This is particularly important for
        a timed-out ``turn/start`` whose remote acceptance cannot be guessed.
        """

        deadline = _deadline_after(timeout)
        with self._io_lock:
            self._ensure_open_locked()
            method = self._timed_out_requests.get(request_id)
            if method is None:
                raise KernelClientError(f"no unresolved timed-out request {request_id}")
            while True:
                response = self._pop_late_response_locked(request_id)
                if response is not None:
                    self._timed_out_requests.pop(request_id, None)
                    return self._response_result(method, response)
                try:
                    msg = self._reader.read_frame(deadline)
                except KernelClientTimeout:
                    return None
                self._route_message_locked(msg)

    def wait_for_approval(
        self,
        turn_id: str,
        *,
        thread_id: str | None = None,
        timeout: float = _DEFAULT_TURN_TIMEOUT_SECONDS,
        poll_interval: float = _DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> dict[str, Any] | None:
        """Wait for a pending approval using both live events and turn/read.

        ``approval/list`` is deliberately not guessed here: the control plane
        exposes the authoritative current-turn ``pendingApprovals`` snapshot.
        The snapshot also covers an approval event emitted just before this
        caller began waiting.
        """

        deadline = _deadline_after(timeout)
        interval = _positive_timeout(poll_interval, _DEFAULT_POLL_INTERVAL_SECONDS)
        while True:
            with self._io_lock:
                self._ensure_open_locked()
                notification = self._pop_notification_locked(
                    "approval/request",
                    lambda item: self._approval_matches(
                        self._approval_from_notification(item), turn_id, thread_id
                    ),
                )
            if notification is not None:
                approval = self._approval_from_notification(notification)
                if approval is not None:
                    return approval

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            state = self.rpc(
                "turn/read",
                {"id": turn_id},
                timeout=min(self._rpc_timeout, remaining),
            )
            approval = self._pending_approval_from_state(state, turn_id, thread_id)
            if approval is not None:
                return approval
            if self._turn_is_terminal(state):
                return None

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.wait_for_notification(
                method=None,
                predicate=lambda item: self._event_or_approval_for_turn(
                    item, turn_id, thread_id
                ),
                timeout=min(interval, remaining),
            )

    def wait_for_turn(
        self,
        turn_id: str,
        *,
        timeout: float = _DEFAULT_TURN_TIMEOUT_SECONDS,
        poll_interval: float = _DEFAULT_POLL_INTERVAL_SECONDS,
        on_approval: Callable[[dict[str, Any]], str] | None = None,
    ) -> dict[str, Any]:
        """Return the authoritative terminal current-turn snapshot.

        Callers without authority to decide an approval get a typed
        ``KernelApprovalRequired`` rather than a fabricated successful result.
        An approval callback may return only ``allow`` or ``deny``.
        """

        deadline = _deadline_after(timeout)
        interval = _positive_timeout(poll_interval, _DEFAULT_POLL_INTERVAL_SECONDS)
        answered: set[str] = set()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise KernelClientTimeout(
                    f"turn {turn_id} did not reach a terminal state within the local deadline"
                )
            state = self.rpc(
                "turn/read",
                {"id": turn_id},
                timeout=min(self._rpc_timeout, remaining),
            )
            if self._turn_is_terminal(state):
                return state

            pending = self._pending_approvals_from_state(state, turn_id, None)
            for approval in pending:
                approval_id = str(approval.get("id") or approval.get("approvalId") or "")
                if not approval_id or approval_id in answered:
                    continue
                if on_approval is None:
                    raise KernelApprovalRequired(approval)
                decision = str(on_approval(approval)).strip().lower()
                if decision not in {"allow", "deny"}:
                    raise KernelClientError(
                        f"approval callback returned unsupported decision {decision!r}"
                    )
                self.rpc(
                    "approval/respond",
                    {"id": approval_id, "decision": decision},
                    timeout=min(self._rpc_timeout, max(deadline - time.monotonic(), 0.001)),
                )
                answered.add(approval_id)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise KernelClientTimeout(
                    f"turn {turn_id} did not reach a terminal state within the local deadline"
                )
            self.wait_for_notification(
                method=None,
                predicate=lambda item: self._event_or_approval_for_turn(
                    item, turn_id, None
                ),
                timeout=min(interval, remaining),
            )

    @staticmethod
    def _response_result(method: str, msg: dict[str, Any]) -> Any:
        if msg.get("error"):
            raise KernelClientError(json.dumps(msg["error"], ensure_ascii=False))
        if "result" not in msg:
            raise KernelClientError(f"bad result for {method}: {msg!r}")
        return msg["result"]

    def _route_message_locked(self, msg: dict[str, Any]) -> None:
        if isinstance(msg.get("method"), str) and "id" not in msg:
            self._queue_notification_locked(msg)
            return
        if "id" in msg:
            response_id = str(msg.get("id"))
            if response_id not in self._timed_out_requests:
                self._raise_recovery_required_locked(
                    "received an unknown daemon response that cannot be safely retained; "
                    "reconnect and query durable state before retrying work",
                    request_id=response_id,
                )
            if response_id in self._responses:
                self._raise_recovery_required_locked(
                    "received a duplicate daemon response for an unresolved request; "
                    "reconnect and query durable state before retrying work",
                    method=self._timed_out_requests.get(response_id),
                    request_id=response_id,
                )
            size = _frame_payload_size(msg)
            if (
                len(self._responses) >= self._max_late_response_count
                or self._late_response_bytes + size > self._max_late_response_bytes
            ):
                self._raise_recovery_required_locked(
                    "late daemon response backlog reached its retention limit; "
                    "the remote request remains uncertain, so reconnect and query durable state",
                    method=self._timed_out_requests.get(response_id),
                    request_id=response_id,
                )
            self._responses[response_id] = msg
            self._late_response_sizes[response_id] = size
            self._late_response_bytes += size
            return
        raise KernelClientError(f"unrecognized daemon protocol frame: {msg!r}")

    def _queue_notification_locked(self, msg: dict[str, Any]) -> None:
        size = _frame_payload_size(msg)
        if (
            len(self._notifications) >= self._max_notification_count
            or self._notification_bytes + size > self._max_notification_bytes
        ):
            self._raise_recovery_required_locked(
                "daemon notification backlog reached its retention limit; "
                "an approval or terminal event could not be retained, so reconnect and query "
                "durable state before retrying work"
            )
        self._notifications.append(msg)
        self._notification_bytes += size

    def _remember_timed_out_request_locked(self, request_id: str, method: str) -> None:
        if len(self._timed_out_requests) >= self._max_timed_out_request_count:
            self._raise_recovery_required_locked(
                "unresolved timed-out request limit reached; this request may have been accepted "
                "remotely, so reconnect and query durable state instead of retrying it",
                method=method,
                request_id=request_id,
            )
        self._timed_out_requests[request_id] = method

    def _pop_late_response_locked(self, request_id: str) -> dict[str, Any] | None:
        response = self._responses.pop(request_id, None)
        if response is None:
            return None
        size = self._late_response_sizes.pop(request_id, _frame_payload_size(response))
        self._late_response_bytes = max(0, self._late_response_bytes - size)
        return response

    def _raise_recovery_required_locked(
        self,
        message: str,
        *,
        method: str | None = None,
        request_id: str | None = None,
    ) -> None:
        if not self._recovery_required:
            self._recovery_required = True
            self._recovery_reason = message
        raise KernelClientRecoveryRequired(
            self._recovery_reason or message,
            method=method,
            request_id=request_id,
        )

    def _pop_notification_locked(
        self,
        method: str | None,
        predicate: Callable[[dict[str, Any]], bool] | None,
    ) -> dict[str, Any] | None:
        found: dict[str, Any] | None = None
        remaining: Deque[dict[str, Any]] = deque()
        remaining_bytes = 0
        while self._notifications:
            notification = self._notifications.popleft()
            matches_method = method is None or notification.get("method") == method
            matches_predicate = predicate is None or predicate(notification)
            if found is None and matches_method and matches_predicate:
                found = notification
            else:
                remaining.append(notification)
                remaining_bytes += _frame_payload_size(notification)
        self._notifications = remaining
        self._notification_bytes = remaining_bytes
        return found

    @staticmethod
    def _approval_from_notification(notification: dict[str, Any]) -> dict[str, Any] | None:
        params = notification.get("params")
        if notification.get("method") != "approval/request" or not isinstance(params, dict):
            return None
        approval = dict(params)
        if not approval.get("id") and approval.get("approvalId"):
            approval["id"] = approval["approvalId"]
        return approval

    @staticmethod
    def _approval_matches(
        approval: dict[str, Any] | None,
        turn_id: str,
        thread_id: str | None,
    ) -> bool:
        if approval is None or str(approval.get("turnId") or "") != turn_id:
            return False
        return thread_id is None or str(approval.get("threadId") or "") == thread_id

    @classmethod
    def _pending_approvals_from_state(
        cls,
        state: Any,
        turn_id: str,
        thread_id: str | None,
    ) -> list[dict[str, Any]]:
        if not isinstance(state, dict):
            return []
        raw_pending = state.get("pendingApprovals")
        if not isinstance(raw_pending, list):
            return []
        approvals: list[dict[str, Any]] = []
        for raw in raw_pending:
            if not isinstance(raw, dict):
                continue
            approval = dict(raw)
            if not approval.get("id") and approval.get("approvalId"):
                approval["id"] = approval["approvalId"]
            if cls._approval_matches(approval, turn_id, thread_id):
                approvals.append(approval)
        return approvals

    @classmethod
    def _pending_approval_from_state(
        cls,
        state: Any,
        turn_id: str,
        thread_id: str | None,
    ) -> dict[str, Any] | None:
        approvals = cls._pending_approvals_from_state(state, turn_id, thread_id)
        return approvals[0] if approvals else None

    @staticmethod
    def _turn_is_terminal(state: Any) -> bool:
        return isinstance(state, dict) and str(state.get("status") or "") in _TERMINAL_TURN_STATUSES

    @staticmethod
    def _event_or_approval_for_turn(
        notification: dict[str, Any],
        turn_id: str,
        thread_id: str | None,
    ) -> bool:
        params = notification.get("params")
        if not isinstance(params, dict):
            return False
        if str(params.get("turnId") or "") != turn_id:
            return False
        if thread_id is not None and str(params.get("threadId") or "") != thread_id:
            return False
        return notification.get("method") in {"turn/event", "approval/request"}

    def _ensure_open_locked(self) -> None:
        if self._recovery_required:
            raise KernelClientRecoveryRequired(
                self._recovery_reason
                or "daemon session needs recovery before more protocol frames are consumed",
            )
        if self._closed:
            raise KernelClientError("daemon session is closed")
        if self.proc.poll() is not None:
            code = self.proc.returncode
            self._close_locked()
            raise KernelClientError(f"daemon exited (code {code})")

    def _abort_locked(self) -> None:
        self._close_locked()

    def close(self) -> None:
        with self._io_lock:
            self._close_locked()

    def _close_locked(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=1.5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                if pipe is not None:
                    pipe.close()
            except OSError:
                pass
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except OSError:
                pass

    def __enter__(self) -> DaemonSession:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def start_turn_sync(
    content: str,
    *,
    home: Path | None = None,
    workspace_title: str = "CLI",
    turn_timeout: float | None = None,
) -> dict[str, Any]:
    """Run a read-only turn to a real terminal snapshot.

    ``turn/start`` is intentionally only an acknowledgement in the async
    daemon. This legacy synchronous facade retains its established result
    shape, but it never returns that transient ``running`` acknowledgement as
    though it were the final model outcome.
    """

    timeout = _positive_timeout(
        turn_timeout,
        _timeout_from_env(
            "KNORVIA_PYTHON_TURN_TIMEOUT_SECS", _DEFAULT_TURN_TIMEOUT_SECONDS
        ),
    )
    with DaemonSession(home) as session:
        ws = session.rpc("workspace/create", {"title": workspace_title, "idempotencyKey": "py-default-ws"})
        thread = session.rpc("thread/start", {"workspaceId": ws["id"], "title": content[:80] or "turn"})
        started = session.rpc(
            "turn/start",
            {"threadId": thread["id"], "input": content, "tools": {"readOnly": True}},
        )
        started_turn = started.get("turn") if isinstance(started, dict) else None
        turn_id = str((started_turn or {}).get("id") or "")
        if not turn_id:
            raise KernelClientError(f"turn/start did not return a turn id: {started!r}")
        terminal = session.wait_for_turn(turn_id, timeout=timeout)
        pending = terminal.get("pendingApprovals")
        pending_id = None
        if isinstance(pending, list) and pending and isinstance(pending[0], dict):
            pending_id = pending[0].get("id") or pending[0].get("approvalId")
        return {
            "workspace": ws,
            "thread": thread,
            "turn": {
                "turn": terminal,
                "items": list(terminal.get("items") or []),
                "pendingApprovalId": pending_id,
            },
        }


async def start_turn_async(content: str, **kwargs: Any) -> dict[str, Any]:
    import asyncio

    return await asyncio.to_thread(start_turn_sync, content, **kwargs)


def invoke_pack_sync(
    pack_id: str,
    input_payload: dict[str, Any],
    *,
    home: Path | None = None,
    workspace_title: str = "Packs",
) -> dict[str, Any]:
    with DaemonSession(home) as session:
        ws = session.rpc(
            "workspace/create",
            {"title": workspace_title, "idempotencyKey": f"pack-ws-{pack_id}"},
        )
        return session.rpc(
            "capability/invoke",
            {
                "packId": pack_id,
                "workspaceId": ws["id"],
                "input": input_payload,
            },
        )


async def invoke_pack_async(pack_id: str, input_payload: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    import asyncio

    return await asyncio.to_thread(invoke_pack_sync, pack_id, input_payload, **kwargs)


async def emit_pack_on_stream(stream: Any, *, source: str, pack_id: str, user_message: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = {
        "query": user_message,
        "topic": user_message,
        "text": user_message,
        "body": user_message,
        "prompt": user_message,
        "spec": user_message,
        "action": user_message,
        "name": user_message[:80] or pack_id,
    }
    if extra:
        payload.update({key: value for key, value in extra.items() if value is not None})
    outcome = await invoke_pack_async(pack_id, payload)
    text = (
        f"{pack_id} {outcome.get('status')} "
        f"artifact={outcome.get('artifactId')} job={outcome.get('jobId')}"
    )
    content_fn = getattr(stream, "content", None)
    if callable(content_fn):
        await content_fn(text, source=source)
    result_fn = getattr(stream, "result", None)
    if callable(result_fn):
        await result_fn(
            {"response": text, "pack": outcome, "runtime": "knorvia-daemon"},
            source=source,
        )
    return outcome


def iter_legacy_events(result: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Temporary NewProtocol → leftover StreamEvent-shaped dicts for partners/cron.

    The projection also yields a terminal ``result`` event carrying the turn's
    final agentMessage text (``metadata.response``) so legacy consumers — the
    partner runner's final-text extraction, cron reminders — get the answer
    the Kernel produced without a Python-side RESULT emitter.
    """
    thread = result.get("thread") or {}
    turn = (result.get("turn") or {}).get("turn") or {}
    items = (result.get("turn") or {}).get("items") or []
    status = str(turn.get("status") or "failed")
    # The legacy StreamEvent consumers cannot render `interrupted`, but that
    # must never become a completed turn. Project it (and any unknown remote
    # terminal state) to a compatible failure while retaining the authoritative
    # remote status in metadata for recovery/debugging.
    legacy_status = status if status in _LEGACY_TERMINAL_STATUSES else "failed"
    status_metadata = (
        {"remoteStatus": status} if legacy_status != status else {}
    )
    final_text = ""
    terminal_error: dict[str, Any] | None = None
    for item in items:
        payload = item.get("payload") or {}
        # Forward the item's own call metadata (call ids / kinds) so trace
        # rehydration keeps the attribution the web UI renders.
        metadata: dict[str, Any] = {"kind": item.get("kind"), "runtime": "knorvia-daemon"}
        item_meta = payload.get("metadata")
        if isinstance(item_meta, dict):
            metadata.update(item_meta)
        if item.get("kind") == "error":
            metadata.update(
                {
                    "turn_terminal": True,
                    "status": legacy_status,
                    **status_metadata,
                }
            )
        if item.get("kind") == "agentMessage":
            text = str(payload.get("text") or "")
            if text.strip():
                final_text = text
        if item.get("kind") == "error" and isinstance(payload, dict):
            terminal_error = payload
        yield {
            "type": (
                "session"
                if item.get("kind") == "userMessage"
                else "error"
                if item.get("kind") == "error"
                else "content"
            ),
            "source": "knorvia-daemon",
            "stage": "",
            "content": str(payload.get("text") or ""),
            "metadata": metadata,
            "session_id": thread.get("id"),
            "turn_id": item.get("turnId") or turn.get("id"),
            "seq": item.get("seq"),
        }
    if status == "interrupted" and terminal_error is None:
        yield {
            "type": "error",
            "source": "knorvia-daemon",
            "stage": "",
            "content": _INTERRUPTED_LEGACY_ERROR,
            "metadata": {
                "kind": "error",
                "runtime": "knorvia-daemon",
                "turn_terminal": True,
                "status": legacy_status,
                **status_metadata,
            },
            "session_id": thread.get("id"),
            "turn_id": turn.get("id"),
        }
    if final_text and legacy_status == "completed":
        yield {
            "type": "result",
            "source": "knorvia-daemon",
            "stage": "",
            "content": "",
            "metadata": {
                "response": final_text,
                "completed": True,
                "runtime": "knorvia-daemon",
            },
            "session_id": thread.get("id"),
            "turn_id": turn.get("id"),
        }
    yield {
        "type": "done",
        "source": "knorvia-daemon",
        "stage": "",
        "content": "",
        "metadata": {
            "status": legacy_status,
            "runtime": "knorvia-daemon",
            **status_metadata,
            **({"error": terminal_error} if terminal_error else {}),
        },
        "session_id": thread.get("id"),
        "turn_id": turn.get("id"),
    }


async def stream_legacy_events(content: str, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
    result = await start_turn_async(content, **kwargs)
    for event in iter_legacy_events(result):
        yield event


async def stream_as_stream_events(content: str, **kwargs: Any) -> AsyncIterator[Any]:
    from knorvia.core.stream import StreamEvent, StreamEventType

    async for raw in stream_legacy_events(content, **kwargs):
        yield StreamEvent(
            type=StreamEventType(str(raw.get("type") or "content")),
            source=str(raw.get("source") or "knorvia-daemon"),
            content=str(raw.get("content") or ""),
            metadata=dict(raw.get("metadata") or {}),
            session_id=str(raw.get("session_id") or ""),
            turn_id=str(raw.get("turn_id") or ""),
            seq=int(raw.get("seq") or 0),
        )
