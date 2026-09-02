"""Local workspace zip export/import HTTP API.

Mounted at ``/api/v1/workspace``. Fully local; never accepts or returns
secrets/.env/API keys (the bundle service strips those paths).
"""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from knorvia.services.workspace_bundle import (
    WorkspaceBundleError,
    build_workspace_zip,
    import_workspace_zip,
)

router = APIRouter()

_MAX_IMPORT_BYTES = 80 * 1024 * 1024  # 80 MiB


@router.get("/export")
async def export_workspace() -> Response:
    data = build_workspace_zip()
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="knorvia-workspace.zip"',
        },
    )


@router.post("/import")
async def import_workspace(file: UploadFile = File(...)) -> dict[str, int]:
    raw = await file.read(_MAX_IMPORT_BYTES + 1)
    if len(raw) > _MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="Workspace zip is too large")
    try:
        return import_workspace_zip(raw)
    except WorkspaceBundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
