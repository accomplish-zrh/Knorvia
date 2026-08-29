# -*- coding: utf-8 -*-
"""Partner management tools (grok-bot CreateAgent / UpdateAgent parity).

A running partner can spin up a new teammate (``create_partner``) and refine
an existing one's name / description (``update_partner``), mirroring how the
reference lets an agent manage its roster. There is deliberately *no* delete
tool: an agent can create and refine teammates but never destroy one — the
owner deletes a partner from the Partners page.

Identifier choice, workspace + soul provisioning, and atomic persist all live
in the partner manager; these tools are thin, side-effect-free-to-fail
wrappers over it. The caller's identity arrives server-side in the call kwargs
(the pipeline augments ``_sender_partner_id``), never as a model parameter.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult

logger = logging.getLogger(__name__)


def _sender_partner_id(kwargs: dict[str, Any], self: Any) -> str:
    return str(kwargs.get("_sender_partner_id") or getattr(self, "_sender_partner_id", "") or "")


class CreatePartnerTool(BaseTool):
    """Create a new partner (a fresh teammate assistant)."""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="create_partner",
            description=(
                "Create a NEW partner — a fresh teammate assistant for this "
                "owner — with a name and an optional persona / description. "
                "Returns the new partner's id so you can immediately message "
                "it with send_partner_message. Use this to spin up a focused "
                "specialist for a job. You have no tool to delete a partner, "
                "so only create one when it is genuinely useful; the owner "
                "can delete a partner themselves from the Partners page."
            ),
            parameters=[
                ToolParameter(
                    name="name",
                    type="string",
                    description="A short, human-readable name for the new partner.",
                    required=True,
                ),
                ToolParameter(
                    name="description",
                    type="string",
                    description="The new partner's persona / instructions: "
                    "what it is for and how it should behave. "
                    "Optional but strongly recommended.",
                    required=False,
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.services.partners import get_partner_manager, slugify_partner_id
        from knorvia.services.partners.manager import PartnerConfig

        name = str(kwargs.get("name") or "").strip()
        description = str(kwargs.get("description") or "").strip()
        if not name:
            return ToolResult(
                content=json.dumps({"error": "A non-empty name is required."}),
                success=False,
            )

        manager = get_partner_manager()
        partner_id = slugify_partner_id(name)
        if manager.partner_exists(partner_id):
            return ToolResult(
                content=json.dumps(
                    {
                        "error": f"A partner with id {partner_id!r} already exists "
                        f"(name {name!r} maps to it). Pick a different name.",
                    }
                ),
                success=False,
            )

        # A brand-new teammate inherits the creator's model selection so it can
        # actually respond right away (grok partners always carry a model).
        config = PartnerConfig(name=name, description=description, language="")
        creator = manager.get_partner(_sender_partner_id(kwargs, self))
        if creator and creator.config:
            config.llm_selection = creator.config.llm_selection
            config.backup_llm_selection = creator.config.backup_llm_selection

        # New partner => auto_start defaults to True; start it so it is
        # immediately messageable (matching "message it right away").
        manager.save_config(partner_id, config)
        try:
            await manager.start_partner(partner_id, config)
        except Exception:  # noqa: BLE001 - surface as a warning, not a hard fail
            logger.exception("create_partner: failed to start %s", partner_id)

        return ToolResult(
            content=json.dumps(
                {
                    "created": partner_id,
                    "name": name,
                    "id": partner_id,
                    "message": (
                        f'Created partner "{name}" (id: {partner_id}). Message it '
                        "with send_partner_message using that id."
                    ),
                },
                ensure_ascii=False,
            ),
            success=True,
            metadata={"partner_created": {"id": partner_id}},
        )


class UpdatePartnerTool(BaseTool):
    """Edit an existing partner's name and/or description (safe merge)."""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="update_partner",
            description=(
                "Edit an existing partner's profile: its name and/or "
                "description. Only the fields you provide are changed; the "
                "rest are left exactly as they were, and there is no way to "
                "clear or delete a partner through this tool. Use it to "
                "refine a teammate you (or the owner) created."
            ),
            parameters=[
                ToolParameter(
                    name="partner_id",
                    type="string",
                    description="Id of the partner to update.",
                    required=True,
                ),
                ToolParameter(
                    name="name",
                    type="string",
                    description="A new name for the partner. Omit to leave unchanged.",
                    required=False,
                ),
                ToolParameter(
                    name="description",
                    type="string",
                    description="A new persona/description for the partner. "
                    "Omit to leave it unchanged.",
                    required=False,
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.services.partners import get_partner_manager

        partner_id = str(kwargs.get("partner_id") or "").strip()
        name = str(kwargs.get("name") or "").strip()
        description = str(kwargs.get("description") or "").strip()
        if not partner_id:
            return ToolResult(
                content=json.dumps({"error": "partner_id is required."}),
                success=False,
            )
        if not name and not description:
            return ToolResult(
                content=json.dumps(
                    {
                        "error": "Nothing to update: provide a new name and/or description.",
                    }
                ),
                success=False,
            )

        manager = get_partner_manager()
        config = manager.load_config(partner_id)
        if config is None:
            return ToolResult(
                content=json.dumps({"error": f"No partner found with id {partner_id!r}."}),
                success=False,
            )

        from dataclasses import replace

        patch: dict[str, Any] = {}
        if name:
            patch["name"] = name
        if description:
            patch["description"] = description
        updated = replace(config, **patch)
        manager.save_config(partner_id, updated)
        instance = manager.get_partner(partner_id)
        if instance:
            instance.config = updated

        return ToolResult(
            content=json.dumps(
                {
                    "updated": partner_id,
                    "name": updated.name,
                    "id": partner_id,
                },
                ensure_ascii=False,
            ),
            success=True,
            metadata={"partner_updated": {"id": partner_id}},
        )


__all__ = ["CreatePartnerTool", "UpdatePartnerTool"]
