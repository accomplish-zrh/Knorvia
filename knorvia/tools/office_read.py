"""``office_read`` — deferred inspection tool (never mutates).

Actions: ``overview`` | ``range`` | ``find`` | ``features`` | ``diff`` |
``history``. Reads are the mandatory basis for any mutation: the service
enforces revision CAS server-side, but the agent workflow requires a fresh
overview/range before each batch.
"""

from __future__ import annotations

import json
from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from knorvia.tools.office_artifact import build_office_service, tool_error_result


class OfficeReadTool(BaseTool):
    deferred = True  # progressive disclosure via load_tools

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="office_read",
            description=(
                "Inspect an Office artifact without changing it: overview "
                "(sheets/features/allowed operations), cell range read "
                "(value + formula + cached value + style id + merges), find "
                "text, feature summary, semantic diff between revisions, or "
                "revision history. Read before every apply batch."
            ),
            parameters=[
                ToolParameter(
                    name="action",
                    type="string",
                    enum=["overview", "range", "find", "features", "diff", "history"],
                    description="Inspection kind.",
                ),
                ToolParameter(name="draft_id", type="string", description="Draft id."),
                ToolParameter(name="artifact_id", type="string", description="Artifact id inside the draft."),
                ToolParameter(name="sheet", type="string", description="range/find: worksheet name."),
                ToolParameter(name="range", type="string", description="range: A1 or A1:C4."),
                ToolParameter(name="query", type="string", description="find: case-insensitive substring."),
                ToolParameter(name="scope", type="string", description="find: limit search to a range."),
                ToolParameter(name="max_hits", type="integer", description="find: cap (default 50)."),
                ToolParameter(name="from_revision", type="integer", description="diff: base revision."),
                ToolParameter(name="to_revision", type="integer", description="diff: optional target revision."),
                ToolParameter(name="revision", type="integer", description="overview/range: read a specific revision."),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        service = build_office_service(kwargs)
        if service is None:
            return ToolResult(content="office tools need a turn workspace.", success=False)
        action = str(kwargs.get("action") or "").strip().lower()
        draft_id = str(kwargs.get("draft_id") or kwargs.get("_office_draft_id") or "").strip()
        artifact_id = str(kwargs.get("artifact_id") or "").strip()
        revision_raw = kwargs.get("revision")
        revision = int(revision_raw) if revision_raw is not None else None
        try:
            if action == "overview":
                payload = service.overview(draft_id, artifact_id, revision)
            elif action == "range":
                payload = service.read_range(
                    draft_id,
                    artifact_id,
                    str(kwargs.get("sheet") or "") or None,
                    str(kwargs.get("range") or "") or None,
                    revision,
                )
            elif action == "find":
                payload = service.find(
                    draft_id,
                    artifact_id,
                    str(kwargs.get("query") or ""),
                    sheet=str(kwargs.get("sheet") or "") or None,
                    scope=str(kwargs.get("scope") or "") or None,
                    max_hits=int(kwargs.get("max_hits") or 50),
                )
            elif action == "features":
                payload = {"features": service.features(
                    draft_id, artifact_id, str(kwargs.get("sheet") or "") or None
                )}
            elif action == "diff":
                payload = service.diff_between(
                    draft_id,
                    artifact_id,
                    from_revision=int(kwargs.get("from_revision") or 0),
                    to_revision=kwargs.get("to_revision"),
                )
            elif action == "history":
                payload = service.history(draft_id, artifact_id)
            else:
                return ToolResult(
                    content="Invalid action. Valid: overview, range, find, features, diff, history.",
                    success=False,
                )
            body = json.dumps(payload, ensure_ascii=False, default=str)
            return ToolResult(content=body[:12000], success=True, metadata={"office_read": payload})
        except Exception as exc:  # noqa: BLE001
            return tool_error_result(exc)
