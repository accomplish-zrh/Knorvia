# -*- coding: utf-8 -*-
"""Partner-to-partner messaging tool (grok-bot SendToAgent parity).

A running partner can DM another partner. Delivery is ASYNCHRONOUS, exactly
like grok-bot 0.18's agent messaging: calling ``send_partner_message``
injects the message into the target's inbound queue and returns an
acknowledgement right away ("sent to <name>") — the sender does NOT wait or
poll for the answer. The target processes it on a fresh turn of its own, and
the reply is delivered back to the sender later as a new bot-to-bot message
that wakes it with the ``[agent]`` cue (see
``build_agent_inbound_wake_prompt``).

The caller's identity arrives server-side in the call kwargs (the pipeline
augments ``_sender_partner_id`` / ``_sender_name``); it is never a model
parameter. A stopped partner returns a typed error instead of silently
dropping.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
import uuid

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult

logger = logging.getLogger(__name__)

_MAX_ATTACH_COUNT = 4


def _attachment_urls(kwargs: dict[str, Any]) -> list[str]:
    """Normalise the optional ``images`` arg to a flat list of URLs.

    Accepts a single URL string, a list of URL strings, or a list of
    ``{"url": ...}`` objects — the shapes a model might reasonably emit.
    Unknown/unusable entries are dropped, and empty files are rejected.
    """
    raw = kwargs.get("images", None)
    urls: list[str] = []
    if isinstance(raw, str):
        candidates = [raw]
    elif isinstance(raw, list):
        candidates = raw
    else:
        return urls
    for item in candidates:
        if isinstance(item, str):
            url = item
        elif isinstance(item, dict):
            u = item.get("url")
            url = u if isinstance(u, str) else ""
        else:
            url = ""
        url = (url or "").strip()
        if not url:
            continue
        scheme = url.split(":", 1)[0].lower() if ":" in url else ""
        if scheme in ("file", "https", "http"):
            urls.append(url)
        if len(urls) >= _MAX_ATTACH_COUNT:
            break
    return urls


class PartnerMessageTool(BaseTool):
    """Send an asynchronous direct message to another partner."""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="send_partner_message",
            description=(
                "Send a direct message to ANOTHER partner (a different named "
                "agent) and keep working. Delivery is ASYNCHRONOUS: this "
                'returns right away with an acknowledgement like "sent to '
                '<name>" once the message is delivered to their inbox; you do '
                "not get their reply in this turn, and you must not wait or "
                "poll for one. Their reply arrives LATER as its own message "
                "that wakes you on a fresh turn. Use it to delegate a question "
                "to the specialist who owns that domain, or to coordinate — "
                "for example asking the research partner to gather sources "
                "before you write. Address the recipient by id; use "
                "list_partners first when unsure who exists. To attach image(s) "
                "they need — a screenshot, chart, or photo — pass images: "
                '[{"url": "https://..."}] (file:// or https://). Pass '
                "priority=true for a STOP / supersede / time-critical 1:1 "
                "instruction that should be treated as urgent."
            ),
            parameters=[
                ToolParameter(
                    name="partner_id",
                    type="string",
                    description="Id of the partner to message.",
                    required=True,
                ),
                ToolParameter(
                    name="message",
                    type="string",
                    description="The message body. Be self-contained: "
                    "the recipient does not see your conversation.",
                    required=True,
                ),
                ToolParameter(
                    name="priority",
                    type="boolean",
                    description="Explicitly flag the message as a "
                    "PRIORITY instruction (true). Default is "
                    "false (a normal asynchronous note).",
                    default=False,
                ),
                ToolParameter(
                    name="images",
                    type="array",
                    description="Optional image attachment(s) the recipient needs — "
                    'list of {"url": "file:// or https://"}. Optional.',
                    items={
                        "type": "object",
                        "properties": {
                            "url": {
                                "type": "string",
                                "description": "file:// or https:// URL of the image.",
                            },
                            "alt": {
                                "type": "string",
                                "description": "Optional short caption.",
                            },
                        },
                        "required": ["url"],
                    },
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.partners.bus.events import InboundMessage
        from knorvia.services.partners import get_partner_manager

        target_id = str(kwargs.get("partner_id") or "").strip()
        message = str(kwargs.get("message") or "").strip()
        priority = bool(kwargs.get("priority", False))
        images = _attachment_urls(kwargs)
        if not target_id or not message:
            return ToolResult(
                content=json.dumps({"error": "Both partner_id and message are required."}),
                success=False,
            )

        manager = get_partner_manager()
        own_id = str(
            kwargs.get("_sender_partner_id") or getattr(self, "_sender_partner_id", "") or ""
        )
        if own_id and target_id == own_id:
            return ToolResult(
                content=json.dumps({"error": "You cannot message yourself."}),
                success=False,
            )

        partners = manager.list_partners()
        known_ids = [p.get("id") for p in partners]
        if target_id not in known_ids:
            return ToolResult(
                content=json.dumps(
                    {
                        "error": f"No partner with id {target_id!r}.",
                        "known_partners": known_ids,
                    }
                ),
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
                content=json.dumps(
                    {
                        "error": f"Partner {target_id!r} exists but is not running.",
                        "hint": "Ask the owner to start it from the Partners page.",
                    }
                ),
                success=False,
            )

        target_name = (
            next(
                (str(p.get("name") or "").strip() for p in partners if p.get("id") == target_id),
                "",
            )
            or target_id
        )
        sender_name = (
            str(kwargs.get("_sender_name") or getattr(self, "_sender_name", "") or "")
            or "another-partner"
        )

        # A dedicated session key keeps bot-to-bot threads separate from the
        # target's human conversations — exactly grok's canonical-chat split.
        session_key = f"botdm:{own_id or 'unknown'}:{uuid.uuid4().hex[:8]}"
        metadata: dict[str, Any] = {
            "sender_name": sender_name,
            "_bot_dm": True,
        }
        if priority:
            metadata["_bot_dm_priority"] = True
        if images:
            metadata["_bot_dm_images"] = images
        inbound = InboundMessage(
            channel="botdm",
            sender_id=own_id or "unknown-partner",
            chat_id=session_key,
            content=message,
            metadata=metadata,
            session_key_override=session_key,
        )

        async def _deliver() -> None:
            try:
                reply = (await target.runner.process_message(inbound) or "").strip()
            except Exception as exc:  # noqa: BLE001 - tool boundary
                logger.exception("partner DM to %s failed", target_id)
                reply = f"(delivery failed: {exc})"
            _reply_as_wake(
                manager=manager,
                own_id=own_id,
                from_target_id=target_id,
                target_name=target_name,
                reply=reply or "(no reply)",
            )

        asyncio.create_task(_deliver(), name=f"partner:dm:{own_id or '?'}->{target_id}")
        return ToolResult(
            content=json.dumps(
                {
                    "sent_to": target_id,
                    "status": "sent",
                    "ack": (
                        f"Sent to {target_name}. Delivery is asynchronous — their "
                        "reply will reach you as a new message on a later turn."
                    ),
                },
                ensure_ascii=False,
            ),
            success=True,
            metadata={"partner_dm": {"to": target_id, "session_key": session_key}},
        )


def _reply_as_wake(
    *,
    manager: Any,
    own_id: str,
    from_target_id: str,
    target_name: str,
    reply: str,
) -> asyncio.Task | None:
    """Fan *reply* back to the sender as a wake on a fresh turn.

    The reply re-enters the sender's own channel-agnostic bus (channel
    ``botdm``) so its runner — which is free, sender and target are different
    processes on that bus — picks it up and runs a normal turn framed by the
    ``[agent]`` inbound-wake prompt. Returns the scheduled task or ``None``
    when there is no running sender partner to wake.
    """
    from knorvia.partners.bus.events import InboundMessage

    if not own_id:
        return None
    sender = manager.get_partner(own_id)
    if not sender or not sender.runner:
        logger.warning("Partner DM reply: sender %r not running; dropping wake", own_id)
        return None

    wake_key = f"botdm:{own_id}:{uuid.uuid4().hex[:8]}"
    return asyncio.create_task(
        sender.runner.bus.publish_inbound(
            InboundMessage(
                channel="botdm",
                sender_id=str(from_target_id or "partner"),
                chat_id=wake_key,
                content=reply,
                metadata={"sender_name": target_name, "_bot_dm": True},
                session_key_override=wake_key,
            )
        )
    )


__all__ = ["PartnerMessageTool"]
