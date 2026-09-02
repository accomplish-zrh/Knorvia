from __future__ import annotations

import asyncio

from knorvia.services.llm.transient import (
    MAX_EXTRA_RETRIES,
    is_transient_llm_error,
    retry_transient,
)


class _HttpError(Exception):
    def __init__(self, status_code: int, message: str = "") -> None:
        super().__init__(message or str(status_code))
        self.status_code = status_code


def test_detects_502_and_timeout() -> None:
    assert is_transient_llm_error(_HttpError(502, "Bad Gateway")) is True
    assert is_transient_llm_error(TimeoutError("timed out")) is True
    assert is_transient_llm_error(_HttpError(400, "bad request")) is False
    assert is_transient_llm_error(ValueError("content filter")) is False


def test_retries_twice_then_succeeds() -> None:
    calls = {"n": 0}

    async def factory() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise _HttpError(502, "Bad Gateway")
        return "ok"

    assert asyncio.run(retry_transient(factory)) == "ok"
    assert calls["n"] == 3
    assert MAX_EXTRA_RETRIES == 2


def test_gives_up_after_two_extra_attempts() -> None:
    async def factory() -> str:
        raise _HttpError(502, "Bad Gateway")

    try:
        asyncio.run(retry_transient(factory))
    except _HttpError:
        return
    raise AssertionError("expected retries to exhaust")
