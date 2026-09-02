"""HTTP handlers for workspace zip export/import."""

from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import zipfile

from fastapi import HTTPException, UploadFile
import pytest
from starlette.datastructures import Headers
from starlette.datastructures import UploadFile as StarletteUploadFile

from knorvia.api.routers import workspace_bundle as router
from knorvia.services import workspace_bundle as svc
from knorvia.services.path_service import PathService
from tests.services.test_workspace_bundle import _BundlePaths, _seed


def test_export_endpoint_returns_zip_without_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = _BundlePaths(tmp_path / "src")
    _seed(src)
    monkeypatch.setattr(svc, "get_path_service", lambda: src)

    response = asyncio.run(router.export_workspace())
    assert response.media_type == "application/zip"
    assert "knorvia-workspace.zip" in response.headers.get("content-disposition", "")
    data = response.body
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
    joined = "\n".join(names)
    assert "manifest.json" in joined
    assert "conversations/s1.json" in joined
    assert ".env" not in joined
    assert "api_keys.json" not in joined
    assert b"SECRET=nope" not in data


def test_import_endpoint_restores_counts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = _BundlePaths(tmp_path / "src")
    _seed(src)
    dest = _BundlePaths(tmp_path / "dst")
    data = svc.build_workspace_zip(src)
    monkeypatch.setattr(svc, "get_path_service", lambda: dest)

    upload = StarletteUploadFile(
        file=io.BytesIO(data),
        filename="workspace.zip",
        headers=Headers({"content-type": "application/zip"}),
    )
    counts = asyncio.run(router.import_workspace(file=upload))
    assert counts["conversations"] == 1
    assert counts["notes"] == 1
    assert counts["outlines"] == 1


def test_import_rejects_non_zip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dest = _BundlePaths(tmp_path / "dst")
    monkeypatch.setattr(svc, "get_path_service", lambda: dest)
    upload = StarletteUploadFile(
        file=io.BytesIO(b"not-a-zip"),
        filename="workspace.zip",
        headers=Headers({"content-type": "application/zip"}),
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.import_workspace(file=upload))
    assert exc.value.status_code == 400
