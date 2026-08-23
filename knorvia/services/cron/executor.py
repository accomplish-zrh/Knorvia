"""Run a due cron job for its owner (chat session or partner conversation)."""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any
import uuid

from knorvia.services.cron.service import CronJob

logger = logging.getLogger(__name__)


async def execute_job(job: CronJob) -> tuple[str, str | None]:
    """Returns ``(status, error)`` — status is ok/error/skipped."""
    if job.owner.kind == "partner":
        return await _execute_partner_job(job)
    return await _execute_chat_job(job)


def _reminder_prompt(job: CronJob) -> str:
    return (
        "The scheduled time has arrived. Deliver this reminder to the user now, "
        "as a brief and natural message in their language. Speak directly to them; "
        "do not narrate scheduler status or mention internal job ids.\n\n"
        f"Reminder: {job.message}"
    )


def _notification_text(text: str, *, limit: int = 240) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


async def _maybe_send_desktop_notification(job: CronJob, text: str) -> None:
    """Best-effort local desktop notification for interactive reminders.

    Knorvia still persists/delivers through its normal chat or partner
    channel. This is only a convenience for local macOS runs; failures are
    deliberately non-fatal because launchd/headless servers often cannot
    show notifications.
    """
    if sys.platform != "darwin":
        return
    if not text.strip():
        return
    if job.owner.kind == "partner" and (job.owner.channel or "web") != "web":
        return

    title = f"Knorvia: {job.name or 'Reminder'}"
    body = _notification_text(text)
    try:
        proc = await asyncio.create_subprocess_exec(
            "osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 1 of argv) with title (item 2 of argv)",
            "-e",
            "end run",
            body,
            title,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode:
            logger.debug("macOS notification failed: %s", stderr.decode(errors="ignore"))
    except Exception:
        logger.debug("macOS notification failed", exc_info=True)


async def _execute_partner_job(job: CronJob) -> tuple[str, str | None]:
    """Run the partner turn and publish the reply through the original channel."""
    from knorvia.partners.bus.events import InboundMessage
    from knorvia.services.partners import get_partner_manager

    instance = get_partner_manager().get_partner(job.owner.partner_id)
    if not instance or not instance.running or not instance.runner:
        return "skipped", "partner not running"

    metadata = dict(job.owner.channel_meta or {})
    metadata["_cron_job_id"] = job.id
    msg = InboundMessage(
        channel=job.owner.channel or "web",
        sender_id="cron",
        chat_id=job.owner.chat_id or "cron",
        content=_reminder_prompt(job),
        metadata=metadata,
        session_key_override=job.owner.session_key or None,
    )
    delivery_meta: dict[str, Any] = dict(job.owner.channel_meta or {})
    try:
        final = await instance.runner.process_message(msg, delivery_meta=delivery_meta)
    except Exception as exc:
        logger.exception("Partner cron job %s failed", job.id)
        return "error", f"{type(exc).__name__}: {exc}"

    final = final.strip()
    if not final:
        return "error", "turn produced no answer"

    if not delivery_meta.get("_streamed"):
        from knorvia.partners.bus.events import OutboundMessage

        delivery_meta["_cron_job_id"] = job.id
        await instance.runner.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=final,
                metadata=delivery_meta,
            )
        )
    await _maybe_send_desktop_notification(job, final)
    return "ok", None


async def _execute_chat_job(job: CronJob) -> tuple[str, str | None]:
    """Run one chat turn in the owner's scope and append the exchange to the
    originating session, so the result is waiting in their chat history."""
    from knorvia.core.context import UnifiedContext
    from knorvia.core.stream import StreamEventType
    from knorvia.multi_user.paths import user_context
    from knorvia.runtime.orchestrator import ChatOrchestrator
    from knorvia.services.session import get_sqlite_session_store

    user, account_error = _resolve_chat_owner(job.owner.user_id)
    if user is None:
        # Never trust CronOwner.is_admin here: older stores contain this
        # privilege snapshot and the account may since have been demoted,
        # disabled, or deleted.
        return "error", account_error or "owner account is unavailable"

    prompt = _reminder_prompt(job)
    with user_context(user):
        store = get_sqlite_session_store()
        session = await store.get_session(job.owner.session_id)
        if session is None:
            return "error", "session no longer exists"

        history = await store.get_messages_for_context(job.owner.session_id)
        context = UnifiedContext(
            session_id=job.owner.session_id,
            user_message=prompt,
            conversation_history=[
                {"role": m.get("role"), "content": m.get("content")}
                for m in history
                if m.get("role") in {"user", "assistant"} and m.get("content")
            ],
            active_capability="chat",
            language=job.owner.language or "en",
            metadata={
                "turn_id": f"cron-{job.id}-{uuid.uuid4().hex[:8]}",
                "source": "cron",
                "cron_job_id": job.id,
            },
        )

        final_text = ""
        errors: list[str] = []
        async for event in ChatOrchestrator().handle(context):
            meta: dict[str, Any] = event.metadata or {}
            if event.type == StreamEventType.RESULT and event.source == "chat":
                final_text = str(meta.get("response") or "")
            elif event.type == StreamEventType.ERROR and event.content:
                errors.append(event.content)

        if not final_text.strip():
            return "error", (errors[-1] if errors else "turn produced no answer")

        await store.add_message(
            session_id=job.owner.session_id,
            role="user",
            content=prompt,
            capability="chat",
            metadata={"cron_job_id": job.id},
        )
        await store.add_message(
            session_id=job.owner.session_id,
            role="assistant",
            content=final_text,
            capability="chat",
            metadata={"cron_job_id": job.id},
        )
        await _maybe_send_desktop_notification(job, final_text)
    return "ok", None


def _resolve_chat_owner(user_id: str):
    """Resolve a cron owner against the live account store, fail-closed."""
    from knorvia.multi_user.models import LOCAL_ADMIN_ID, CurrentUser
    from knorvia.multi_user.paths import local_admin_user, scope_for_user
    from knorvia.services.auth import AUTH_ENABLED, list_users

    if not AUTH_ENABLED:
        if user_id not in {"", LOCAL_ADMIN_ID}:
            return None, "owner account is unavailable"
        return local_admin_user(), None

    record = next((item for item in list_users() if str(item.get("id") or "") == user_id), None)
    if record is None or bool(record.get("disabled", False)):
        return None, "owner account is disabled or no longer exists"
    role = str(record.get("role") or "user")
    if role not in {"admin", "user"}:
        return None, "owner account has an invalid role"
    username = str(record.get("username") or "")
    if not username:
        return None, "owner account is unavailable"
    is_admin = role == "admin"
    return (
        CurrentUser(
            id=user_id,
            username=username,
            role=role,
            scope=scope_for_user(user_id, is_admin=is_admin),
        ),
        None,
    )


__all__ = ["execute_job"]
