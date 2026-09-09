"""Private framed-stdio transport used by :mod:`kernel_client`.

This module deliberately owns only wire framing, finite-deadline waiting, and
the errors that describe those local transport boundaries.  Session routing and
the compatibility facades stay in ``kernel_client``.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import select
import subprocess
import time
from typing import Any


_MAX_FRAME_HEADER_BYTES = 4096
_MAX_FRAME_BODY_BYTES = 8 * 1024 * 1024
_DEFAULT_RPC_TIMEOUT_SECONDS = 15.0
_DEFAULT_POLL_INTERVAL_SECONDS = 0.05


class KernelClientError(RuntimeError):
    """A local Knorvia Protocol transport or session failure."""


class KernelClientTimeout(KernelClientError):
    """The local daemon pipe did not produce a complete frame in time."""

    def __init__(
        self,
        message: str,
        *,
        method: str | None = None,
        request_id: str | None = None,
    ) -> None:
        self.method = method
        self.request_id = request_id
        self.uncertain = request_id is not None
        self.recovery_required = False
        super().__init__(message)


class KernelClientRecoveryRequired(KernelClientError):
    """Protocol state could not be retained safely by this local session.

    The daemon is not declared stopped: a request might already have been
    accepted remotely.  Callers must reconnect and use durable state reads
    before deciding how to proceed, rather than replaying a mutating request.
    """

    def __init__(
        self,
        message: str,
        *,
        method: str | None = None,
        request_id: str | None = None,
    ) -> None:
        self.method = method
        self.request_id = request_id
        self.uncertain = True
        self.recovery_required = True
        super().__init__(message)


def _positive_timeout(value: Any, fallback: float) -> float:
    """Parse a timeout without ever turning a missing value into infinity."""

    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) and parsed > 0 else fallback


def _timeout_from_env(name: str, fallback: float) -> float:
    return _positive_timeout(os.environ.get(name), fallback)


def _deadline_after(timeout: float) -> float:
    return time.monotonic() + _positive_timeout(timeout, _DEFAULT_RPC_TIMEOUT_SECONDS)


def _json_bytes(obj: dict[str, Any]) -> bytes:
    try:
        return json.dumps(obj, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise KernelClientError(f"cannot encode daemon JSON frame: {exc}") from exc


def _frame_payload_size(obj: dict[str, Any]) -> int:
    """Return the exact JSON payload byte count used by ``_write_frame``."""

    return len(_json_bytes(obj))


class _FrameReader:
    """Deadline-aware Content-Length reader for one daemon stdout pipe.

    Windows anonymous pipes cannot be passed to ``select``.  ``PeekNamedPipe``
    lets us wait in small bounded increments there; Unix uses ``select``.  This
    keeps every blocked read tied to the daemon process and avoids a helper
    thread that could outlive a timed-out request forever.
    """

    def __init__(self, stdout: Any, process: subprocess.Popen[bytes] | None = None) -> None:
        self._stdout = stdout
        self._process = process
        self._buffer = bytearray()
        try:
            self._fd: int | None = int(stdout.fileno())
        except (AttributeError, OSError, ValueError):
            self._fd = None

    def read_frame(self, deadline: float) -> dict[str, Any]:
        while True:
            marker = self._buffer.find(b"\r\n\r\n")
            if marker >= 0:
                if marker > _MAX_FRAME_HEADER_BYTES:
                    raise KernelClientError("daemon frame headers too large")
                length = self._content_length(bytes(self._buffer[:marker]))
                body_start = marker + 4
                body_end = body_start + length
                if len(self._buffer) >= body_end:
                    body = bytes(self._buffer[body_start:body_end])
                    del self._buffer[:body_end]
                    try:
                        decoded = json.loads(body.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise KernelClientError(f"invalid daemon JSON frame: {exc}") from exc
                    if not isinstance(decoded, dict):
                        raise KernelClientError(f"daemon frame is not an object: {decoded!r}")
                    return decoded
            elif len(self._buffer) > _MAX_FRAME_HEADER_BYTES:
                raise KernelClientError("daemon frame headers too large")

            self._fill(deadline)

    @staticmethod
    def _content_length(headers: bytes) -> int:
        try:
            lines = headers.decode("ascii").split("\r\n")
        except UnicodeDecodeError as exc:
            raise KernelClientError("daemon frame headers are not ASCII") from exc
        values = [
            line.split(":", 1)[1].strip()
            for line in lines
            if ":" in line and line.split(":", 1)[0].strip().lower() == "content-length"
        ]
        if len(values) != 1:
            raise KernelClientError("daemon frame needs exactly one Content-Length")
        try:
            length = int(values[0])
        except ValueError as exc:
            raise KernelClientError("invalid daemon Content-Length") from exc
        if length < 0 or length > _MAX_FRAME_BODY_BYTES:
            raise KernelClientError("daemon frame body too large")
        return length

    def _fill(self, deadline: float) -> None:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise KernelClientTimeout("timed out waiting for daemon frame")
            if self._process is not None and self._process.poll() is not None:
                raise KernelClientError(
                    f"daemon exited while waiting for a frame (code {self._process.returncode})"
                )

            if self._fd is None:
                # BytesIO-like objects used by small unit tests return
                # immediately. A production Popen pipe always has a file
                # descriptor and takes one of the deadline-aware paths below.
                chunk = self._read_once(65536)
            elif os.name == "nt":
                available = self._windows_available_bytes(self._fd)
                if available is None:
                    raise KernelClientError("daemon stdout pipe closed")
                if available == 0:
                    time.sleep(min(_DEFAULT_POLL_INTERVAL_SECONDS, remaining))
                    continue
                chunk = self._read_once(min(max(available, 1), 65536))
            else:
                try:
                    ready, _, _ = select.select(
                        [self._stdout], [], [], min(_DEFAULT_POLL_INTERVAL_SECONDS, remaining)
                    )
                except (OSError, ValueError) as exc:
                    raise KernelClientError(f"cannot wait for daemon stdout: {exc}") from exc
                if not ready:
                    continue
                chunk = self._read_once(65536)

            if not chunk:
                raise KernelClientError("daemon closed during frame read")
            self._buffer.extend(chunk)
            return

    def _read_once(self, size: int) -> bytes:
        read1 = getattr(self._stdout, "read1", None)
        data = read1(size) if callable(read1) else self._stdout.read(size)
        return bytes(data or b"")

    @staticmethod
    def _windows_available_bytes(fd: int) -> int | None:
        # Importing msvcrt on non-Windows would fail, so keep it strictly in
        # this Windows-only method.
        import msvcrt
        from ctypes import wintypes

        available = wintypes.DWORD(0)
        handle = wintypes.HANDLE(msvcrt.get_osfhandle(fd))
        ok = ctypes.windll.kernel32.PeekNamedPipe(  # type: ignore[attr-defined]
            handle,
            None,
            0,
            None,
            ctypes.byref(available),
            None,
        )
        if not ok:
            return None
        return int(available.value)


def _read_frame(stdout: Any, *, timeout: float = _DEFAULT_RPC_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Read one frame for tests and one-shot callers with a finite deadline."""

    return _FrameReader(stdout).read_frame(_deadline_after(timeout))


def _write_frame(stdin: Any, obj: dict[str, Any]) -> None:
    raw = _json_bytes(obj)
    stdin.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw)
    stdin.flush()
