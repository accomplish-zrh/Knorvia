"""Retry helpers for transient LLM HTTP failures (502 / timeout)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
from typing import TypeVar

logger = logging.getLogger(__name__)

TRANSIENT_STATUS_CODES = frozenset({408, 409, 429, 500, 502, 503, 504})
MAX_EXTRA_RETRIES = 2

T = TypeVar("T")


def _status_code(exc: BaseException) -> int | None:
    for attr in ("status_code", "status", "http_status"):
        raw = getattr(exc, attr, None)
        if raw is None:
            continue
        try:
            code = int(raw)
        except (TypeError, ValueError):
            continue
        if code > 0:
            return code
    response = getattr(exc, "response", None)
    raw = getattr(response, "status_code", None) if response is not None else None
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def is_transient_llm_error(exc: BaseException) -> bool:
    """Return whether *exc* is a 502 / timeout (or close cousin) worth retrying."""
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return True
    name = type(exc).__name__.lower()
    if "timeout" in name:
        return True
    status = _status_code(exc)
    if status in TRANSIENT_STATUS_CODES:
        return True
    blob = str(exc).lower()
    if "502" in blob or "bad gateway" in blob:
        return True
    if "timed out" in blob or "timeout" in blob or "deadline exceeded" in blob:
        return True
    return False


async def retry_transient(
    factory: Callable[[], Awaitable[T]],
    *,
    extra_retries: int = MAX_EXTRA_RETRIES,
    label: str = "llm",
) -> T:
    """Run *factory* up to ``1 + extra_retries`` times on 502/timeout."""
    last_error: BaseException | None = None
    attempts = extra_retries + 1
    for attempt in range(attempts):
        try:
            return await factory()
        except Exception as exc:
            last_error = exc
            if attempt >= extra_retries or not is_transient_llm_error(exc):
                raise
            logger.warning(
                "%s transient failure (attempt %d/%d): %s",
                label,
                attempt + 1,
                attempts,
                exc,
            )
            await asyncio.sleep(0.15 * (attempt + 1))
    assert last_error is not None
    raise last_error


__all__ = [
    "MAX_EXTRA_RETRIES",
    "TRANSIENT_STATUS_CODES",
    "is_transient_llm_error",
    "retry_transient",
]
