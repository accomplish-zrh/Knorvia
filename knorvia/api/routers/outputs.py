"""Request-scoped delivery of generated output artifacts."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, JSONResponse, Response

from knorvia.api.routers.auth import require_auth
from knorvia.multi_user.context import get_current_user_or_none
from knorvia.multi_user.paths import get_path_service_for_scope
from knorvia.services.auth import TokenPayload
from knorvia.services.path_service import PathService
from knorvia.services.univer_container import (
    ContainerError,
    open_univer,
    read_unit_bytes,
    unit_media_type,
)

router = APIRouter()


def _request_path_service() -> PathService:
    """Resolve the workspace installed by ``require_auth`` without fallback.

    The general-purpose ``get_path_service()`` retains a compatibility fallback
    to the local admin workspace for non-request callers.  A download endpoint
    must fail closed instead: otherwise an authentication/context regression
    could expose an administrator artifact to an ordinary request.
    """
    user = get_current_user_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Output not found")
    return get_path_service_for_scope(user.scope)


def _resolve_output(path_service: PathService, relative_path: str) -> Path:
    output_path = path_service.resolve_public_output_path(relative_path)
    if output_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Output not found")
    return output_path


def _container_path(path_service: PathService, relative_path: str) -> Path:
    path = _resolve_output(path_service, relative_path)
    if path.suffix.lower() != ".univer":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Not a .univer container",
        )
    return path


@router.get("/{output_path:path}/container")
async def read_container_unit(
    output_path: str,
    unit: str | None = Query(
        default=None,
        description="Unit id to extract. Omit to return the container manifest JSON.",
    ),
    _auth: TokenPayload | None = Depends(require_auth),
) -> Response:
    """Unpack proxy for ``.univer`` multi-unit containers.

    * ``GET .../file.univer/container`` → ``manifest.json`` as JSON
    * ``GET .../file.univer/container?unit=<id>`` → that unit's native Office bytes
    """
    path = _container_path(_request_path_service(), output_path)
    try:
        if not unit:
            return JSONResponse(open_univer(path))
        payload, entry = read_unit_bytes(path, unit)
    except ContainerError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    unit_type = str(entry.get("type") or "sheet")
    filename = Path(str(entry.get("file") or f"{unit}.bin")).name
    disposition = f"inline; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=payload,
        media_type=unit_media_type(unit_type),
        headers={"Content-Disposition": disposition},
    )


@router.api_route("/{output_path:path}", methods=["GET", "HEAD"])
async def read_output(
    output_path: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> FileResponse:
    """Serve one allowlisted artifact from the authenticated user's workspace."""
    path = _resolve_output(_request_path_service(), output_path)
    return FileResponse(path)
