from __future__ import annotations

import json

import pytest

from knorvia.runtime.kernel_client import DaemonSession
from knorvia.runtime.kernel_transport import KernelClientError


def _session_with_pages(pages):
    session = object.__new__(DaemonSession)
    calls = []

    def rpc(method, params, *, timeout=None):
        calls.append((method, dict(params), timeout))
        value = pages.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    session.rpc = rpc
    return session, calls


def test_replay_consumer_retries_only_rebuild_and_validates_frozen_cursor():
    rebuilding = KernelClientError(json.dumps({"code": -32032, "message": "replay_index_building:indexedSeq=2, upperSeq=4, scannedBytes=90"}))
    session, calls = _session_with_pages([
        rebuilding,
        {"events": [{"streamId": "thr", "seq": 1}, {"streamId": "thr", "seq": 2}], "nextSeq": 2, "hasMore": True, "upperSeq": 3, "nextCursor": "opaque-2"},
        {"events": [{"streamId": "thr", "seq": 3}], "nextSeq": 3, "hasMore": False, "upperSeq": 3, "nextCursor": "opaque-3"},
    ])

    assert [event["seq"] for event in session.iter_replay_events("thr", timeout=1)] == [1, 2, 3]
    assert calls[0][1] == calls[1][1], "index rebuild retries the identical request"
    assert calls[2][1]["afterSeq"] == 2
    assert calls[2][1]["upperSeq"] == 3
    assert calls[2][1]["cursor"] == "opaque-2"


@pytest.mark.parametrize(
    "page",
    [
        {"events": [{"streamId": "other", "seq": 1}], "nextSeq": 1, "hasMore": False, "upperSeq": 1, "nextCursor": "x"},
        {"events": [], "nextSeq": 0, "hasMore": True, "upperSeq": 1, "nextCursor": "x"},
        {"events": [{"streamId": "thr", "seq": 1}], "nextSeq": 1, "hasMore": False, "upperSeq": 2, "nextCursor": "x"},
    ],
)
def test_replay_consumer_fails_closed_on_invalid_pages(page):
    session, _ = _session_with_pages([page])
    with pytest.raises(KernelClientError):
        list(session.iter_replay_events("thr", timeout=1))
