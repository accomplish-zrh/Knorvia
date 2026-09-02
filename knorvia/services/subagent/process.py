"""Stream a child process's stdout/stderr line-by-line as it runs.

The single low-level primitive the subagent backends share: spawn a command and
yield every stdout and stderr line the moment it arrives — so a long, multi-step
agent run surfaces live in the sidebar instead of all at once at the end — then
guarantee the process is torn down when the consumer stops early or the turn is
cancelled.

There is deliberately **no timeout** on the wait: per the product contract,
Knorvia waits unconditionally for the subagent's own logic to finish; only the
subagent exiting (cleanly or with an error) ends the stream. Cancellation (the
user aborting the turn) propagates as ``CancelledError`` and the ``finally``
block terminates the child so no orphaned agent process is left behind.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
import contextlib
import logging
import os
from pathlib import Path
import signal

logger = logging.getLogger(__name__)

# (channel, text) where channel is "stdout", "stderr", or "exit" (the final
# item, whose text is the integer return code as a string).
ProcessLine = tuple[str, str]

_TERMINATE_GRACE_SECONDS = 5.0

_SAFE_ENV_KEYS = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "LOGNAME",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "SHELL",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "USERPROFILE",
        "WINDIR",
    }
)


def subagent_environment(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    """Build a minimal child environment without server/provider secrets."""

    child = {key: value for key, value in os.environ.items() if key.upper() in _SAFE_ENV_KEYS}
    child.update({str(key): str(value) for key, value in (extra or {}).items()})
    return child


def default_subagent_cwd() -> str:
    """User home — the desktop default so connecting a detected CLI needs no typed path."""
    home = Path.home()
    try:
        if home.is_dir():
            return str(home.resolve())
    except OSError:
        return ""
    return ""


def validate_subagent_cwd(cwd: str | None) -> str:
    """Resolve a local-agent cwd. Empty means the user home.

    An optional ``KNORVIA_LINKED_FOLDER_ROOTS`` allowlist still applies when
    set (self-hosted). Desktop leaves it unset so any existing directory the
    user picks is allowed — same rule as linked folders.
    """

    from knorvia.services.rag.linked_kb import assert_path_allowed

    raw = str(cwd or "").strip() or default_subagent_cwd()
    if not raw:
        raise ValueError("A working directory is required for local CLI subagents.")
    return str(assert_path_allowed(raw))


def _resolve_cmd(cmd: Sequence[str]) -> list[str]:
    """Resolve argv[0] through PATH / PATHEXT / known install fallbacks."""
    if not cmd:
        return []
    from knorvia.services.subagent.detect_fallback import resolve_cli_command

    resolved = resolve_cli_command(str(cmd[0]))
    if not resolved:
        return list(cmd)
    return [resolved, *[str(part) for part in cmd[1:]]]


async def stream_process_lines(
    cmd: Sequence[str],
    *,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> AsyncIterator[ProcessLine]:
    """Yield ``(channel, line)`` for each stdout/stderr line until the process exits.

    The final item is always ``("exit", "<returncode>")`` so callers can tell a
    clean finish from an early break. stdout and stderr are interleaved in
    arrival order via a shared queue.
    """
    full_env = subagent_environment(env)
    argv = _resolve_cmd(cmd)
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd or None,
        env=full_env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=os.name == "posix",
    )

    queue: asyncio.Queue[ProcessLine | None] = asyncio.Queue()

    async def _pump(stream: asyncio.StreamReader | None, channel: str) -> None:
        if stream is None:
            await queue.put(None)
            return
        try:
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                await queue.put((channel, raw.decode("utf-8", "replace").rstrip("\r\n")))
        except Exception:  # pragma: no cover - defensive: a broken pipe must not hang the queue
            logger.debug("subagent %s pump failed", channel, exc_info=True)
        finally:
            await queue.put(None)  # sentinel: this channel is drained

    readers = [
        asyncio.create_task(_pump(process.stdout, "stdout")),
        asyncio.create_task(_pump(process.stderr, "stderr")),
    ]
    drained = 0
    try:
        while drained < len(readers):
            item = await queue.get()
            if item is None:
                drained += 1
                continue
            yield item
        returncode = await process.wait()
        yield "exit", str(returncode)
    finally:
        for task in readers:
            task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.gather(*readers, return_exceptions=True)
        await _terminate(process)


async def _terminate(process: asyncio.subprocess.Process) -> None:
    """Best-effort teardown: terminate, wait briefly, then kill."""
    if process.returncode is not None:
        return
    await _signal_tree(process, force=False)
    try:
        await asyncio.wait_for(process.wait(), timeout=_TERMINATE_GRACE_SECONDS)
        return
    except (TimeoutError, asyncio.TimeoutError):
        pass
    except ProcessLookupError:  # pragma: no cover
        return
    await _signal_tree(process, force=True)
    with contextlib.suppress(Exception):
        await process.wait()


async def _signal_tree(process: asyncio.subprocess.Process, *, force: bool) -> None:
    if os.name == "nt":
        args = ["taskkill", "/pid", str(process.pid), "/t"]
        if force:
            args.append("/f")
        with contextlib.suppress(Exception):
            killer = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=subagent_environment(),
            )
            await asyncio.wait_for(killer.wait(), timeout=2.0)
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, sig)


async def probe_version(cmd: Sequence[str], *, timeout: float = 8.0) -> tuple[bool, str]:
    """Run a fast ``--version``-style probe; return ``(ok, stdout-or-error)``.

    Used by backend ``detect`` to answer "is this CLI installed here?" without
    the no-timeout consult semantics — a probe that hangs is a failed probe.
    """
    from knorvia.services.subagent.detect_fallback import resolve_cli_command

    if not cmd:
        return False, "not installed"
    if resolve_cli_command(str(cmd[0])) is None:
        return False, "not installed"
    argv = _resolve_cmd(cmd)
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=subagent_environment(),
        )
    except FileNotFoundError:
        return False, "not installed"
    except Exception as exc:  # pragma: no cover - defensive
        return False, str(exc)
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except (TimeoutError, asyncio.TimeoutError):
        await _terminate(process)
        return False, "probe timed out"
    text = (out or b"").decode("utf-8", "replace").strip()
    return process.returncode == 0, text


__all__ = [
    "ProcessLine",
    "probe_version",
    "stream_process_lines",
    "subagent_environment",
    "default_subagent_cwd",
    "validate_subagent_cwd",
]
