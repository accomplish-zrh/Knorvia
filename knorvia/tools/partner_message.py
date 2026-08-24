# -*- coding: utf-8 -*-
"""Partner-to-partner messaging tool (Hermes bot-mode parity).

A running partner can DM another partner: the message is injected into the
target's inbound queue as a normal channel turn, so it lands in the
target's own session history, runs one agent turn there, and the final
reply is returned to the sender as the tool result. Delivery is
per-invocation (same semantics Hermes documents for bot_mode): the target
processes when its runtime is free; a stopped partner returns a typed
error instead of silently dropping.
"""
from __future__ import annotations

import json
import logging
from typing import Any
import uuid

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult

logger = logging.getLogger(__name__)

# One DM round-trip ceiling. Consults can legitimately think for minutes,
# but an unbounded wait would pin the sending partner's tool call.
DM_TIMEOUT_SECONDS = 600


class PartnerMessageTool(BaseTool):
    """Send a direct message to another partner and wait for its reply."""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="send_partner_message",
            description=(
                "Send a direct message to ANOTHER partner (a different named "
                "agent) and wait for its reply. Use it to delegate a question "
                "to the specialist who owns that domain, or to coordinate — "
                "for example asking the research partner to gather sources "
                "before you write. Address the recipient by id; use "
                "list_partners first when unsure who exists. The reply you "
                "receive is the other partner's own words."
            ),
            parameters=[
                ToolParameter(name="partner_id", type="string",
                              description="Id of the partner to message.", required=True),
                ToolParameter(name="message", type="string",
                              description="The message body. Be self-contained: "
                                          "the recipient does not see your conversation.",
                              required=True),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.partners.bus.events import InboundMessage
        from knorvia.services.partners import get_partner_manager

        target_id = str(kwargs.get("partner_id") or "").strip()
        message = str(kwargs.get("message") or "").strip()
        if not target_id or not message:
            return ToolResult(
                content=json.dumps({"error": "Both partner_id and message are required."}),
                success=False,
            )

        manager = get_partner_manager()
        own_id = str(getattr(self, "_sender_partner_id", "") or "")
        if own_id and target_id == own_id:
            return ToolResult(
                content=json.dumps({"error": "You cannot message yourself."}),
                success=False,
            )
        known_ids = [p.get("id") for p in manager.list_partners()]
        if target_id not in known_ids:
            return ToolResult(
                content=json.dumps({
                    "error": f"No partner with id {target_id!r}.",
                    "known_partners": known_ids,
                }),
                success=False,
            )

        target = manager.get_partner(target_id)
        if not target:
            return ToolResult(
                content=json.dumps({"error": f"No partner with id {target_id!r}."}),
                success=False,
            )
        if not target.running or not target.runner:
            return ToolResult(
                content=json.dumps({
                    "error": f"Partner {target_id!r} exists but is not running.",
                    "hint": "Ask the owner to start it from the Partners page.",
                }),
                success=False,
            )

        # A dedicated session key keeps bot-to-bot threads separate from the
        # target's human conversations — exactly Hermes' canonical-chat split.
        sender_name = str(getattr(self, "_sender_name", "") or "another-partner")
        session_key = f"botdm:{own_id or 'unknown'}:{uuid.uuid4().hex[:8]}"
        inbound = InboundMessage(
            channel="botdm",
            sender_id=own_id or "unknown-partner",
            chat_id=session_key,
            content=message,
            metadata={
                "sender_name": sender_name,
                "_bot_dm": True,
            },
            session_key_override=session_key,
        )
        delivery_meta: dict[str, Any] = {"_streamed": True}
        try:
            final = await asyncio_wait_for(
                target.runner.process_message(inbound, delivery_meta=delivery_meta),
                timeout=DM_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return ToolResult(
                content=json.dumps({
                    "error": f"{target_id!r} did not reply within {DM_TIMEOUT_SECONDS}s.",
                    "hint": "The message was delivered; check back later or retry.",
                }),
                success=False,
            )
        except Exception as exc:  # noqa: BLE001 - tool boundary
            logger.exception("partner DM to %s failed", target_id)
            return ToolResult(
                content=json.dumps({"error": f"Delivery failed: {exc}"}),
                success=False,
            )

        reply = (final or "").strip() or "(empty reply)"
        return ToolResult(
            content=json.dumps({
                "from": target_id,
                "reply": reply[:8000],
                "truncated": len(reply) > 8000,
                "session_key": session_key,
            }, ensure_ascii=False),
            metadata={"partner_dm": {"to": target_id, "session_key": session_key}},
        )


async def asyncio_wait_for(coro, *, timeout: float):
    import asyncio

    return await asyncio.wait_for(coro, timeout=timeout)
