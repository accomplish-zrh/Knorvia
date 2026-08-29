"""Partner agent runtime — drives the chat agent loop from IM messages.

This replaces the deleted TutorBot engine. A partner has NO engine of its
own: every inbound message becomes one chat turn executed by
``ChatOrchestrator`` → ``AgenticChatPipeline`` (the exact loop the product
chat uses), run inside the partner's synthetic user scope so rag / skills /
notebook tools read the partner workspace natively.

Event → IM mapping:

* ``RESULT`` (``metadata.response``)            → the reply message
* ``CONTENT`` with ``call_kind=llm_final_response`` → terminator/ask_user
  text (the loop's RESULT is empty for an unresolved ask_user pause — the
  pending question IS the reply, and the user's next IM message simply
  starts the next turn)
* trace-only narration rounds (``call_role=narration``) → optional
  ``_progress`` messages (``send_progress`` channel flag)
* ``TOOL_CALL``                                  → optional ``_tool_hint``
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
from pathlib import Path
import re
from typing import Any, AsyncIterator, Awaitable, Callable
import uuid

from knorvia.core.context import Attachment, UnifiedContext
from knorvia.core.stream import StreamEvent, StreamEventType
from knorvia.multi_user.paths import user_context
from knorvia.partners.bus.events import InboundMessage, OutboundMessage
from knorvia.partners.bus.queue import MessageBus
from knorvia.partners.helpers import detect_image_mime
from knorvia.services.partners.commands import PartnerCommandHandler
from knorvia.services.partners.scope import partner_user
from knorvia.services.partners.sessions import PartnerSessionStore
from knorvia.services.partners.workspace import ensure_partner_workspace, read_soul

logger = logging.getLogger(__name__)

EventCallback = Callable[[StreamEvent], Awaitable[None]]

_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_MEDIA_BYTES = 10 * 1024 * 1024
_TOOL_HINT_MAX_CHARS = 120


def _format_tool_hint(tool_name: str, args: Any) -> str:
    """One-line IM rendering of a tool call: ``⚙ rag(query="…")``."""
    rendered = ""
    if isinstance(args, dict) and args:
        parts = []
        for key, value in args.items():
            if str(key).startswith("_"):
                continue
            text = str(value)
            if len(text) > 40:
                text = text[:37] + "…"
            parts.append(f"{key}={text!r}" if isinstance(value, str) else f"{key}={text}")
        rendered = ", ".join(parts)
    hint = f"⚙ {tool_name}({rendered})"
    if len(hint) > _TOOL_HINT_MAX_CHARS:
        hint = hint[: _TOOL_HINT_MAX_CHARS - 1] + "…"
    return hint


class PartnerRunner:
    """Consume a partner's inbound bus and answer with the chat agent loop."""

    def __init__(
        self,
        partner_id: str,
        config: Any,
        bus: MessageBus,
        store: PartnerSessionStore,
        save_config: Callable[[str, Any], None] | None = None,
        set_typing_hook: Callable[[str, str, bool], Awaitable[None]] | None = None,
    ) -> None:
        self.partner_id = partner_id
        self.config = config
        self.bus = bus
        self.store = store
        self.save_config = save_config
        # Channel typing indicator (grok-bot activity parity): the manager
        # injects a hook resolving the channel instance; ``None`` disables it.
        self.set_typing_hook = set_typing_hook
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()
        # In-flight turn tasks by session key — what /stop cancels.
        self._active_turns: dict[str, asyncio.Task] = {}

    def cancel_turn(self, session_key: str) -> bool:
        """Cancel the in-flight turn for *session_key*; False when idle.

        grok-bot parity: the IM ``/stop`` command and the web stop button both
        land here, on the same in-flight turn map.
        """
        task = self._active_turns.get(session_key)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    # ── inbound loop ──────────────────────────────────────────────

    async def run(self) -> None:
        """Long-running consumer: one task per message, serialised per session."""
        try:
            while True:
                msg = await self.bus.consume_inbound()
                task = asyncio.create_task(
                    self._handle_inbound(msg),
                    name=f"partner:{self.partner_id}:turn",
                )
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        except asyncio.CancelledError:
            for task in list(self._tasks):
                task.cancel()
            raise

    async def _handle_inbound(self, msg: InboundMessage) -> None:
        delivery_meta: dict[str, Any] = {}
        try:
            final = await self.process_message(msg, delivery_meta=delivery_meta)
        except asyncio.CancelledError:
            # A /stop (or web stop) cancelled the turn mid-flight: tell the
            # channel, keep the session lock released, and let the task end
            # cancelled (no half answer is persisted — process_message handled
            # that before re-raising).
            try:
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content="⏹ Reply stopped.",
                        metadata={"_progress": True},
                    )
                )
            except Exception:  # noqa: BLE001 - bus may already be closing
                pass
            raise
        except Exception as exc:
            logger.exception(
                "Partner %s failed to process message on %s", self.partner_id, msg.channel
            )
            final = f"Sorry, something went wrong while processing your message: {exc}"
        if final:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=final,
                    metadata=delivery_meta,
                )
            )

    # ── one turn ──────────────────────────────────────────────────

    def _lock_for(self, session_key: str) -> asyncio.Lock:
        lock = self._session_locks.get(session_key)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[session_key] = lock
        return lock

    async def process_message(
        self,
        msg: InboundMessage,
        *,
        on_event: EventCallback | None = None,
        delivery_meta: dict[str, Any] | None = None,
    ) -> str:
        """Run one chat turn for *msg* and return the final reply text.

        *delivery_meta*, when given, is filled with metadata the caller
        should attach to the final outbound message (e.g. ``_streamed``
        when the reply was already delivered live via stream deltas).
        """
        session_key = msg.session_key

        # /stop must act while the running turn holds the session lock —
        # dispatching it through the lock would make every stop arrive one
        # turn too late ("nothing being generated" right after generation).
        if PartnerCommandHandler.is_stop_command(msg.content):
            if self.cancel_turn(session_key):
                return "Stopped the reply that was being generated."
            return "There's nothing being generated to stop."

        async with self._lock_for(session_key):
            command = PartnerCommandHandler(
                partner_id=self.partner_id,
                config=self.config,
                store=self.store,
                save_config=self.save_config,
                cancel_turn=self.cancel_turn,
            ).dispatch(msg)
            if command is not None:
                return command.content

            task = asyncio.current_task()
            if task is not None:
                self._active_turns[session_key] = task
            typing_active = False
            try:
                await self._set_typing(msg, True)
                typing_active = True
                final, turn_events, usage_row = await self._run_turn(
                    msg, on_event=on_event, delivery_meta=delivery_meta
                )
            except asyncio.CancelledError:
                # The turn was stopped mid-flight: keep the user message on
                # record (it was received), but never persist a half answer.
                self.store.append(
                    session_key,
                    "user",
                    msg.content,
                    channel=msg.channel,
                    sender_id=msg.sender_id,
                    attachments=list((msg.metadata or {}).get("_attachment_records") or []),
                )
                raise
            finally:
                if typing_active:
                    await self._set_typing(msg, False)
                if task is not None:
                    self._active_turns.pop(session_key, None)

            self.store.append(
                session_key,
                "user",
                msg.content,
                channel=msg.channel,
                sender_id=msg.sender_id,
                attachments=list((msg.metadata or {}).get("_attachment_records") or []),
            )
            if final:
                self.store.append(
                    session_key,
                    "assistant",
                    final,
                    channel=msg.channel,
                    events=turn_events or None,
                )
            self._record_usage(usage_row)
            return final

    async def _run_turn(
        self,
        msg: InboundMessage,
        *,
        on_event: EventCallback | None = None,
        delivery_meta: dict[str, Any] | None = None,
    ) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
        """One turn: router first (when configured), then the LLM chain.

        Returns ``(final, events, usage_row)`` — *usage_row* (``None`` when
        nothing worth recording happened) feeds the partner usage ledger.
        """
        ensure_partner_workspace(self.partner_id)
        primary = getattr(self.config, "llm_selection", None) or None
        backup = getattr(self.config, "backup_llm_selection", None) or None

        # grok-bot inference-router parity: a partner may route its turns to a
        # local agent CLI. A failed routing never strands the chat — it falls
        # back to the LLM path and the error is reported in-band.
        from knorvia.services.partners.routing import is_cli_routing, sanitize_routing

        routing = sanitize_routing(getattr(self.config, "routing", None))
        if is_cli_routing(routing):
            final_text, errors, events, usage_row = await self._execute_routed_turn(
                msg, routing, on_event=on_event, delivery_meta=delivery_meta
            )
            if final_text:
                return final_text, events, usage_row
            logger.warning(
                "Partner %s routed turn via %s failed (%s); falling back to the LLM path",
                self.partner_id,
                routing.get("kind"),
                (errors[-1][:200] if errors else "no output"),
            )
            if delivery_meta is not None:
                delivery_meta.pop("_streamed", None)

        final_text, errors, events, cost_summary = await self._execute_turn(
            msg, selection=primary, on_event=on_event, delivery_meta=delivery_meta
        )
        if not final_text and errors and backup and backup != primary:
            logger.warning(
                "Partner %s turn failed on primary model (%s); retrying with backup",
                self.partner_id,
                errors[-1][:200],
            )
            if delivery_meta is not None:
                delivery_meta.pop("_streamed", None)
            final_text, errors, events, cost_summary = await self._execute_turn(
                msg, selection=backup, on_event=on_event, delivery_meta=delivery_meta
            )

        if not final_text and errors:
            final_text = f"Sorry, the turn failed: {errors[-1]}"
        usage_row = self._usage_row_for_llm(msg, selection=primary, cost_summary=cost_summary)
        return final_text, events, usage_row

    async def _execute_turn(
        self,
        msg: InboundMessage,
        *,
        selection: dict[str, str] | None,
        on_event: EventCallback | None = None,
        delivery_meta: dict[str, Any] | None = None,
    ) -> tuple[str, list[str], list[dict[str, Any]], dict[str, Any] | None]:
        """Run one chat turn with *selection* active; returns (final, errors, events, cost).

        ``events`` is the turn's trace (every StreamEvent except done/session,
        as ``to_dict()`` — the exact shape the web socket forwards live), so the
        web chat can rehydrate its collapsible "Done" activity after a refresh.
        ``cost`` is the pipeline's per-turn usage summary (``cost_summary`` from
        the RESULT event) or ``None``.

        A failed turn is ``("", [error, …], events, …)`` — the caller decides
        whether a backup model gets a second attempt. Exceptions are folded into
        the error list so the retry policy sees them too.

        When the inbound message asks for streaming (``_wants_stream``, set
        by channels whose config enables it), every loop round's text is
        published live as ``_stream_delta`` messages keyed by
        ``_stream_id = {turn_id}:{call_id}`` — narration rounds freeze into
        their own IM message when they complete, and the finish round
        becomes the reply (the final outbound is then marked ``_streamed``
        so the channel doesn't send it twice).
        """
        from knorvia.runtime.orchestrator import ChatOrchestrator
        from knorvia.services.model_selection.runtime import (
            activate_llm_selection,
            reset_llm_selection,
        )

        # Turn setup (context assembly + LLM-selection resolution) runs INSIDE
        # the try so a setup failure folds into the error list instead of
        # propagating as an opaque crash. The common one is a missing active
        # LLM model: get_llm_config() raises LLMConfigError (a plain Exception,
        # not RuntimeError), which previously escaped _execute_turn and surfaced
        # as a bare "Internal error" on the web socket — masking the real
        # message and skipping the backup-model retry. Folding it here keeps the
        # actual reason ("No active LLM model is configured…") and lets
        # _run_turn fall back to the backup selection.
        #
        # activate_llm_selection still runs BEFORE the partner scope is entered:
        # the model catalog lives in the admin workspace, and the scoped config
        # rides the same async context into the orchestrator task.
        llm_token = None
        errors: list[str] = []
        final_text = ""
        turn_events: list[dict[str, Any]] = []
        cost_summary: dict[str, Any] | None = None
        try:
            context = self._build_context(msg)
            turn_id = str(context.metadata.get("turn_id") or "")
            send_progress = self._channel_delivery_flag(msg.channel, "send_progress", default=True)
            send_tool_hints = self._channel_delivery_flag(
                msg.channel, "send_tool_hints", default=True
            )
            is_im = msg.channel != "web"
            # Streaming requires send_progress: narration rounds stream live as
            # they happen, so with progress muted we keep buffered delivery.
            wants_stream = is_im and send_progress and bool(msg.metadata.get("_wants_stream"))

            _config, llm_token = activate_llm_selection(selection)
            # Everything — rag / skills / notebooks AND memory — resolves to the
            # partner's own synthetic workspace. The partner-only memory tools
            # (partner_read / partner_memorize / partner_search, force-mounted by
            # the pipeline) own the split-memory model: partner_read folds in the
            # owner's shared L3 on top of the partner's own, partner_memorize
            # writes only the partner's own. Chat's read_memory / write_memory
            # are suppressed on partner turns, so no admin memory override is
            # needed here (and the partner can never write the owner's memory).
            with user_context(partner_user(self.partner_id, name=self.config.name)):
                orchestrator = ChatOrchestrator()
                final_text, errors, turn_events, cost_summary = await self._consume_turn_events(
                    orchestrator.handle(context),
                    msg=msg,
                    turn_id=turn_id,
                    on_event=on_event,
                    delivery_meta=delivery_meta,
                    send_progress=send_progress,
                    send_tool_hints=send_tool_hints,
                )
        except Exception as exc:
            logger.exception("Partner %s turn crashed", self.partner_id)
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            reset_llm_selection(llm_token)

        return final_text, errors, turn_events, cost_summary

    async def _execute_routed_turn(
        self,
        msg: InboundMessage,
        routing: dict[str, str],
        *,
        on_event: EventCallback | None = None,
        delivery_meta: dict[str, Any] | None = None,
    ) -> tuple[str, list[str], list[dict[str, Any]], dict[str, Any] | None]:
        """One turn through the routed CLI backend (grok-bot inference router).

        Emits the same StreamEvent shapes as the LLM path so all shared
        handling applies; returns ``(final, errors, events, usage_row)`` —
        CLI backends don't report token usage, so the ledger row records the
        request itself.
        """
        from knorvia.services.partners.routing import RoutedTurnMeta, execute_routed_turn

        turn_id = f"partner-{self.partner_id}-{uuid.uuid4().hex[:12]}"
        send_progress = self._channel_delivery_flag(msg.channel, "send_progress", default=True)
        send_tool_hints = self._channel_delivery_flag(msg.channel, "send_tool_hints", default=True)
        user_message, _persona_extra = self._effective_user_message(msg)

        meta = RoutedTurnMeta()
        events_iter = execute_routed_turn(
            partner_id=self.partner_id,
            partner_name=self.config.name,
            description=str(getattr(self.config, "description", "") or ""),
            soul=read_soul(self.partner_id),
            channel=msg.channel,
            session_key=msg.session_key,
            user_message=user_message,
            media=list(msg.media or []),
            routing=routing,
            meta=meta,
        )
        try:
            final_text, errors, turn_events, _cost = await self._consume_turn_events(
                events_iter,
                msg=msg,
                turn_id=turn_id,
                on_event=on_event,
                delivery_meta=delivery_meta,
                send_progress=send_progress,
                send_tool_hints=send_tool_hints,
            )
        except Exception as exc:  # noqa: BLE001 - routed setup failures fall back
            logger.exception("Partner %s routed turn crashed", self.partner_id)
            return "", [f"{type(exc).__name__}: {exc}"], [], None

        errors = list(errors)
        for router_error in meta.errors:
            note = f"Router error: {router_error}"
            if note not in errors:
                errors.append(note)
        # CLI backends don't report token usage; the ledger records the turn
        # request itself (grok-bot usage parity: activity, not an invoice).
        usage_row = None
        if final_text:
            usage_row = {
                "channel": msg.channel,
                "backend": f"cli:{meta.kind}",
                "model": "",
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "total_calls": 1,
                "cost_usd": 0.0,
            }
        return final_text, errors, turn_events, usage_row

    async def _consume_turn_events(
        self,
        events: AsyncIterator[StreamEvent],
        *,
        msg: InboundMessage,
        turn_id: str,
        on_event: EventCallback | None,
        delivery_meta: dict[str, Any] | None,
        send_progress: bool,
        send_tool_hints: bool,
    ) -> tuple[str, list[str], list[dict[str, Any]], dict[str, Any] | None]:
        """Shared event consumer for the LLM and routed turn paths.

        Buffers CONTENT per call, streams IM deltas live, freezes narration
        rounds, extracts the final reply + the pipeline cost summary, and
        closes any stream segment still open at the end (including after a
        crash) so channels can flush their edit buffers.
        """
        final_text = ""
        terminator_text = ""
        round_buffers: dict[str, list[str]] = {}
        streamed_rounds: dict[str, str] = {}  # call_id → accumulated streamed text
        ended_rounds: set[str] = set()
        answer_visible_parts: list[str] = []
        errors: list[str] = []
        turn_events: list[dict[str, Any]] = []
        cost_summary: dict[str, Any] | None = None
        is_im = msg.channel != "web"
        wants_stream = is_im and send_progress and bool(msg.metadata.get("_wants_stream"))

        async for event in events:
            if on_event is not None:
                await on_event(event)
            meta = event.metadata or {}

            # Capture the trace for rehydration — mirror product chat's
            # persisted ``assistant_events`` (everything but done/session).
            if event.type not in (StreamEventType.DONE, StreamEventType.SESSION):
                turn_events.append(event.to_dict())

            if event.type == StreamEventType.CONTENT:
                call_id = str(meta.get("call_id") or "")
                round_buffers.setdefault(call_id, []).append(event.content or "")
                if meta.get("call_kind") == "llm_final_response":
                    terminator_text += event.content or ""
                if wants_stream and event.content:
                    streamed_rounds[call_id] = streamed_rounds.get(call_id, "") + event.content
                    await self._publish_stream_delta(msg, turn_id, call_id, event.content)

            elif event.type == StreamEventType.TOOL_CALL:
                if is_im and send_tool_hints and event.content:
                    hint = _format_tool_hint(event.content, meta.get("args"))
                    await self._publish_hint(msg, hint, tool_hint=True)

            elif event.type == StreamEventType.PROGRESS:
                if (
                    meta.get("trace_kind") == "call_status"
                    and meta.get("call_state") == "complete"
                    and meta.get("call_role") == "narration"
                ):
                    call_id = str(meta.get("call_id") or "")
                    raw_text = "".join(round_buffers.pop(call_id, []))
                    text = raw_text.strip()
                    if meta.get("answer_visible") is True:
                        if raw_text:
                            answer_visible_parts.append(raw_text)
                        if call_id in streamed_rounds:
                            ended_rounds.add(call_id)
                            await self._publish_stream_end(msg, turn_id, call_id)
                        continue
                    if call_id in streamed_rounds:
                        # Already streamed live — freeze the segment.
                        ended_rounds.add(call_id)
                        await self._publish_stream_end(msg, turn_id, call_id)
                    elif is_im and send_progress and text:
                        await self._publish_hint(msg, text, tool_hint=False)

            elif event.type == StreamEventType.RESULT and event.source == "chat":
                final_text = str(meta.get("response") or "")
                inner = meta.get("metadata")
                if isinstance(inner, dict) and isinstance(inner.get("cost_summary"), dict):
                    cost_summary = dict(inner["cost_summary"])

            elif event.type == StreamEventType.ERROR and event.content:
                errors.append(event.content)

        if not final_text.strip():
            final_text = terminator_text.strip()
        final_text = final_text.strip()
        if answer_visible_parts and not wants_stream:
            replayed_prefix = "".join(answer_visible_parts)
            display_prefix = "\n\n".join(
                part.strip() for part in answer_visible_parts if part.strip()
            )
            # Continuation rounds return the canonical, fully joined answer in
            # RESULT so SDK and persistence consumers do not lose the prefix.
            # DSML feedback rounds return only their later finish, so prepend
            # the visible narration only when RESULT does not already contain it.
            if not final_text:
                final_text = display_prefix
            elif display_prefix and not (
                final_text.startswith(replayed_prefix)
                or final_text == display_prefix
                or final_text.startswith(f"{display_prefix}\n")
            ):
                final_text = f"{display_prefix}\n\n{final_text}"

        # Close any stream segments still open (the finish round, or partial
        # rounds after a crash) so channels can flush their edit buffers.
        for call_id in streamed_rounds:
            if call_id not in ended_rounds:
                await self._publish_stream_end(msg, turn_id, call_id)
                # The reply is "already delivered" only when the live-streamed
                # text matches what the caller is about to send.
                if (
                    delivery_meta is not None
                    and final_text
                    and streamed_rounds[call_id].strip() == final_text
                ):
                    delivery_meta["_streamed"] = True

        return final_text, errors, turn_events, cost_summary

    # ── channel activity + usage ledger ───────────────────────────

    async def _set_typing(self, msg: InboundMessage, active: bool) -> None:
        """Best-effort typing indicator on channels that support it."""
        if self.set_typing_hook is None:
            return
        if not self._channel_delivery_flag(msg.channel, "send_typing", default=True):
            return
        if not msg.chat_id:
            return
        try:
            await self.set_typing_hook(msg.channel, str(msg.chat_id), active)
        except Exception:  # noqa: BLE001 - typing is cosmetic, never fail a turn
            logger.debug(
                "Partner %s typing indicator failed on %s",
                self.partner_id,
                msg.channel,
                exc_info=True,
            )

    def _usage_row_for_llm(
        self,
        msg: InboundMessage,
        *,
        selection: dict[str, str] | None,
        cost_summary: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Ledger row for one LLM-path turn (None when nothing recorded)."""
        if not cost_summary:
            return None
        model = ""
        if isinstance(selection, dict):
            model = str(selection.get("model_id") or "")
        return {
            "channel": msg.channel,
            "backend": "llm",
            "model": model,
            "prompt_tokens": cost_summary.get("prompt_tokens", 0),
            "completion_tokens": cost_summary.get("completion_tokens", 0),
            "total_tokens": cost_summary.get("total_tokens", 0),
            "total_calls": cost_summary.get("total_calls", 0),
            "cost_usd": cost_summary.get("total_cost_usd", 0.0),
        }

    def _record_usage(self, row: dict[str, Any] | None) -> None:
        if not row:
            return
        try:
            from knorvia.services.partners import usage as usage_ledger

            usage_ledger.record(self.partner_id, row)
        except Exception:  # noqa: BLE001 - accounting never breaks a turn
            logger.debug("Partner %s usage recording failed", self.partner_id, exc_info=True)

    # ── context assembly ──────────────────────────────────────────

    def _build_context(self, msg: InboundMessage) -> UnifiedContext:
        session_key = msg.session_key
        turn_id = f"partner-{self.partner_id}-{uuid.uuid4().hex[:12]}"
        history = self.store.conversation_history(session_key)
        attachments, attachment_records = self._attachments_from_media(msg.media)
        source_manifest, source_index = self._source_manifest_from_records(
            session_key,
            fresh_records=attachment_records,
        )
        msg.metadata["_attachment_records"] = attachment_records

        # Partner-scope context blocks (soul / skills / KBs) are assembled
        # inside the partner scope so the same service locators the chat
        # turn-runtime uses resolve to the partner workspace.
        with user_context(partner_user(self.partner_id, name=self.config.name)):
            skills_manifest = self._build_skills_manifest()
            kb_names = self._list_kb_names()

        metadata: dict[str, Any] = {
            "turn_id": turn_id,
            "source": "partner",
            "partner_id": self.partner_id,
            "channel": msg.channel,
            "chat_id": msg.chat_id,
            "sender_id": msg.sender_id,
            "session_key": session_key,
            # Swaps the system prompt's product identity ("You are Knorvia")
            # for the partner's user-given identity; the Soul does the rest.
            "agent_identity": {
                "name": self.config.name,
                "description": getattr(self.config, "description", "") or "",
            },
            # NOTE: no ``wait_for_user_reply`` — an ask_user pause makes
            # the pending question the turn's reply (IM semantics).
        }
        channel_meta: dict[str, Any] = {}
        for key, value in (msg.metadata or {}).items():
            key_text = str(key)
            if key_text.startswith("_"):
                continue
            try:
                json.dumps(value)
                channel_meta[key_text] = value
            except TypeError:
                channel_meta[key_text] = str(value)
        if channel_meta:
            metadata["channel_metadata"] = channel_meta
        if source_index:
            metadata["source_index"] = source_index
        cron_job_id = str((msg.metadata or {}).get("_cron_job_id") or "").strip()
        if cron_job_id:
            metadata["cron_job_id"] = cron_job_id
        mcp_tools = getattr(self.config, "mcp_tools", None)
        if isinstance(mcp_tools, list):
            metadata["mcp_tools_filter"] = [str(name) for name in mcp_tools]

        user_message, persona_extra = self._effective_user_message(msg)
        return UnifiedContext(
            session_id=f"partner:{self.partner_id}:{session_key}",
            user_message=user_message,
            conversation_history=history,
            enabled_tools=self._resolved_enabled_tools(),
            allowed_builtin_tools=self._resolved_builtin_tools(),
            active_capability="chat",
            knowledge_bases=kb_names,
            attachments=attachments,
            language=self._language(),
            persona_context=(
                read_soul(self.partner_id).strip() + self._teammates_context() + persona_extra
            ),
            skills_manifest=skills_manifest,
            source_manifest=source_manifest,
            metadata=metadata,
        )

    def _effective_user_message(self, msg: InboundMessage) -> tuple[str, str]:
        """Resolve the message the agent actually reads + protocol framing.

        * bot-to-bot sends (``botdm``) are framed by the ``[agent]`` wake cue
          so the receiver never mistakes another partner for the user typing;
        * a "broadcast" turn is already framed by its ``[broadcast]`` prompt;
        * a user message that @mentions sibling partners surfaces them in a
          short directory block so the agent can loop them in on request;
        * every message is clamped to ``AGENT_MESSAGE_MAX_TEXT_LENGTH``.
        """
        from knorvia.services.partners.agent_identity import (
            build_agent_inbound_wake_prompt,
            build_mentioned_agents_context,
            clamp_agent_message,
        )

        raw = msg.content or ""
        persona_extra = ""

        if msg.channel == "botdm" and bool((msg.metadata or {}).get("_bot_dm")):
            meta = msg.metadata or {}
            from_name = str(meta.get("sender_name") or "") or (
                str(meta.get("sender_id") or "") or "another partner"
            )
            wake = build_agent_inbound_wake_prompt(
                from_address={"id": str(meta.get("sender_id") or ""), "name": from_name},
                text=raw,
                images=meta.get("_bot_dm_images") or None,
                priority=bool(meta.get("_bot_dm_priority")),
            )
            return clamp_agent_message(wake), persona_extra

        if msg.channel == "broadcast" and bool((msg.metadata or {}).get("_broadcast")):
            return clamp_agent_message(raw), persona_extra

        mentioned = self._mentioned_partner_addresses(raw)
        mentioned_block = build_mentioned_agents_context(mentioned)
        if mentioned_block:
            persona_extra = "\n\n" + mentioned_block
        return clamp_agent_message(raw), persona_extra

    def _mentioned_partner_addresses(self, content: str) -> list[dict[str, str]]:
        """Sibling partners the user @mentioned in *content* (by name or id)."""
        try:
            from knorvia.services.partners.manager import get_partner_manager
        except Exception:  # noqa: BLE001 - best-effort
            return []
        try:
            partners = get_partner_manager().list_partners()
        except Exception:  # noqa: BLE001 - best-effort
            return []
        tokens = {
            t.lower() for t in re.findall(r"@([\w\u4e00-\u9fff][\w\-.\u4e00-\u9fff]*)", content)
        }
        if not tokens:
            return []
        others = [p for p in partners if str(p.get("id") or "") != self.partner_id and p.get("id")]
        mentioned: list[dict[str, str]] = []
        for p in others:
            haystacks = {
                str(p.get("id") or "").lower(),
                str(p.get("name") or "").lower(),
            }
            if tokens & haystacks:
                mentioned.append(
                    {
                        "id": str(p["id"]),
                        "name": str(p.get("name") or p.get("id")),
                        "description": str(p.get("description") or "").strip()[:120],
                    }
                )
        return mentioned

    def _teammates_context(self) -> str:
        """Roster of the other partners + shared rooms for the agent's
        collaboration protocol section (grok-bot directory parity).

        Empty when this is the only partner — no protocol noise for a
        single-agent install.
        """
        try:
            from knorvia.services.partners.agent_identity import (
                render_agent_directory_system_prompt,
            )
            from knorvia.services.partners.manager import get_partner_manager

            partners = get_partner_manager().list_partners()
        except Exception:  # noqa: BLE001 - roster is best-effort context
            return ""
        others = [p for p in partners if str(p.get("id") or "") != self.partner_id and p.get("id")]
        if not others:
            return self._teammates_context_empty()
        others_addr = [
            {
                "id": str(p["id"]),
                "name": str(p.get("name") or p.get("id")),
                "description": str(p.get("description") or "").strip()[:120],
                "running": bool(p.get("running", False)),
            }
            for p in others
        ]
        groups = self._groups_for_directory()
        return render_agent_directory_system_prompt(
            others=others_addr,
            groups=groups,
            agents_root_dir=str(self._partners_root_for_prompt()),
        )

    def _teammates_context_empty(self) -> str:
        """Single-agent install: no peers means no collaboration protocol.

        (grok's empty case offers to *create* a teammate; Knorvia mirrors the
        product-chat principle of no protocol noise when nothing exists to
        coordinate with, so it stays silent — the ``send_partner_message``
        tool remains available if the user asks for it.)
        """
        return ""

    def _partners_root_for_prompt(self) -> str | None:
        try:
            from knorvia.partners.config.paths import get_data_dir

            return str(get_data_dir())
        except Exception:  # noqa: BLE001 - prompt hint is best-effort
            return None

    def _groups_for_directory(self) -> list[dict[str, Any]]:
        """Shared rooms this partner is seated in, as group addresses."""
        from knorvia.services.partners.agent_identity import AGENT_DIRECTORY_PROMPT_LIMIT

        try:
            from knorvia.services.partners.group_chat import get_group_room_engine
        except Exception:  # noqa: BLE001 - rooms are best-effort context
            return []
        try:
            rooms = get_group_room_engine().list_rooms()
        except Exception:  # noqa: BLE001 - best-effort
            return []
        groups: list[dict[str, Any]] = []
        for room in rooms:
            members = room.get("members") or []
            seated = any(str(m.get("connection") or "") == self.partner_id for m in members)
            if not seated:
                continue
            groups.append(
                {
                    "id": str(room.get("id") or ""),
                    "name": str(room.get("name") or room.get("id") or "Group"),
                    "is_group": True,
                    "members": [
                        {
                            "id": str(m.get("connection") or ""),
                            "name": str(m.get("display_name") or m.get("connection") or ""),
                        }
                        for m in members[:AGENT_DIRECTORY_PROMPT_LIMIT]
                    ],
                }
            )
        return groups

    def _resolved_enabled_tools(self) -> list[str]:
        """The partner's user-toggleable tool whitelist.

        ``None`` in config means "everything the user could toggle on in
        chat" — partners default to fully equipped; an explicit list (or
        ``[]``) is the owner's selection.
        """
        configured = getattr(self.config, "enabled_tools", None)
        if configured is None:
            from knorvia.agents._shared.tool_composition import default_optional_tools

            return default_optional_tools()
        return [str(name) for name in configured]

    def _resolved_builtin_tools(self) -> list[str] | None:
        """The partner's allowed built-in (auto-mounted) tools.

        ``None`` in config means "no gating" — every built-in mounts under its
        usual context condition, exactly like the product chat (partners
        default to fully equipped). An explicit list (or ``[]``) restricts the
        built-in surface so an owner can deny e.g. memory access to an
        IM-facing partner. Flows to ``UnifiedContext.allowed_builtin_tools``.
        """
        configured = getattr(self.config, "builtin_tools", None)
        if configured is None:
            return None
        return [str(name) for name in configured]

    def _build_skills_manifest(self) -> str:
        try:
            from knorvia.services.skill.service import (
                get_skill_service,
                render_skills_manifest,
            )

            service = get_skill_service()
            entries = service.summary_entries()
            always_block = service.load_always_for_context()
            return "\n\n".join(
                part for part in (always_block, render_skills_manifest(entries)) if part
            )
        except Exception:
            logger.warning(
                "Failed to build skills manifest for partner %s", self.partner_id, exc_info=True
            )
            return ""

    def _list_kb_names(self) -> list[str]:
        try:
            from knorvia.knowledge.manager import KnowledgeBaseManager
            from knorvia.services.path_service import get_path_service

            kb_root = get_path_service().get_knowledge_bases_root()
            if not kb_root.is_dir():
                return []
            return KnowledgeBaseManager(base_dir=str(kb_root)).list_knowledge_bases()
        except Exception:
            logger.warning("Failed to list KBs for partner %s", self.partner_id, exc_info=True)
            return []

    def _language(self) -> str:
        lang = str(getattr(self.config, "language", "") or "").strip().lower()
        return "zh" if lang.startswith("zh") else "en"

    def _channel_delivery_flag(self, channel_name: str, name: str, *, default: bool) -> bool:
        channels = getattr(self.config, "channels", None) or {}
        if not isinstance(channels, dict):
            return default
        section = channels.get(channel_name)
        if not isinstance(section, dict):
            return default
        value = section.get(name)
        if value is None:
            camel = {
                "send_progress": "sendProgress",
                "send_tool_hints": "sendToolHints",
                "send_typing": "sendTyping",
            }.get(name, name)
            value = section.get(camel)
        return value if isinstance(value, bool) else default

    @staticmethod
    def _attachment_id_for_path(path: Path) -> str:
        try:
            seed = str(path.resolve())
        except OSError:
            seed = str(path)
        return hashlib.sha1(seed.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]

    def _attachments_from_media(self, media: list[str]) -> tuple[list[Attachment], list[dict]]:
        attachments: list[Attachment] = []
        records: list[dict[str, Any]] = []
        document_records: list[dict[str, Any]] = []
        for raw_path in media or []:
            try:
                path = Path(raw_path)
                if not path.is_file():
                    continue
                size = path.stat().st_size
                if size > _MAX_MEDIA_BYTES:
                    continue
                data = path.read_bytes()
                attachment_id = self._attachment_id_for_path(path)
                mime_type = mimetypes.guess_type(path.name)[0] or ""
                mime = detect_image_mime(data)
                if mime and size <= _MAX_IMAGE_BYTES:
                    encoded = base64.b64encode(data).decode("ascii")
                    attachments.append(
                        Attachment(
                            type="image",
                            base64=encoded,
                            filename=path.name,
                            mime_type=mime,
                            id=attachment_id,
                        )
                    )
                    records.append(
                        {
                            "id": attachment_id,
                            "type": "image",
                            "filename": path.name,
                            "mime_type": mime,
                            "path": str(path),
                            "size": size,
                        }
                    )
                    continue

                document_records.append(
                    {
                        "id": attachment_id,
                        "type": "pdf" if path.suffix.lower() == ".pdf" else "file",
                        "filename": path.name,
                        "mime_type": mime_type,
                        "base64": base64.b64encode(data).decode("ascii"),
                        "path": str(path),
                        "size": size,
                    }
                )
            except OSError:
                logger.warning("Skipping unreadable media file: %s", raw_path, exc_info=True)

        if document_records:
            try:
                from knorvia.utils.document_extractor import extract_documents_from_records

                _document_texts, updated_records = extract_documents_from_records(document_records)
            except Exception:
                logger.warning(
                    "Failed to extract partner media documents for %s",
                    self.partner_id,
                    exc_info=True,
                )
                updated_records = [
                    {**record, "base64": "", "extracted_chars": 0} for record in document_records
                ]

            for record in updated_records:
                cleaned = {k: v for k, v in record.items() if k != "base64"}
                records.append(cleaned)
                if str(cleaned.get("extracted_text", "") or "").strip():
                    attachments.append(
                        Attachment(
                            type=str(cleaned.get("type") or "file"),
                            filename=str(cleaned.get("filename") or ""),
                            mime_type=str(cleaned.get("mime_type") or ""),
                            id=str(cleaned.get("id") or ""),
                            extracted_text=str(cleaned.get("extracted_text") or ""),
                        )
                    )

        return attachments, records

    def _source_manifest_from_records(
        self,
        session_key: str,
        *,
        fresh_records: list[dict[str, Any]],
    ) -> tuple[str, dict[str, str]]:
        try:
            from knorvia.services.session.source_inventory import (
                SourceEntry,
                SourceInventory,
                render_manifest,
            )
        except Exception:
            logger.warning("Failed to import source inventory helpers", exc_info=True)
            return "", {}

        inv = SourceInventory()
        turn_ordinal = 1
        historical_messages = self.store.messages(session_key, limit=200)
        for message in historical_messages:
            if message.get("role") == "user":
                turn_ordinal += 1
                for record in message.get("attachments") or []:
                    self._add_attachment_source(
                        inv,
                        record,
                        fresh=False,
                        first_seen_turn=turn_ordinal - 1,
                        source_entry_cls=SourceEntry,
                    )

        for record in fresh_records:
            self._add_attachment_source(
                inv,
                record,
                fresh=True,
                first_seen_turn=turn_ordinal,
                source_entry_cls=SourceEntry,
            )
        return render_manifest(inv)

    @staticmethod
    def _add_attachment_source(
        inv: Any,
        record: dict[str, Any],
        *,
        fresh: bool,
        first_seen_turn: int,
        source_entry_cls: Any,
    ) -> None:
        if str(record.get("type", "")).lower() == "image":
            return
        mime = str(record.get("mime_type", "") or "").lower()
        if mime.startswith("image/"):
            return
        text = str(record.get("extracted_text", "") or "")
        attachment_id = str(record.get("id", "") or "").strip()
        if not text.strip() or not attachment_id:
            return
        inv.add(
            source_entry_cls(
                sid=f"at-{attachment_id}",
                kind="attachment",
                name=str(record.get("filename") or "Untitled file"),
                full_text=text,
                fresh=fresh,
                first_seen_turn=first_seen_turn,
            )
        )

    async def _publish_hint(self, msg: InboundMessage, text: str, *, tool_hint: bool) -> None:
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=text,
                metadata={"_progress": True, "_tool_hint": tool_hint},
            )
        )

    async def _publish_stream_delta(
        self, msg: InboundMessage, turn_id: str, call_id: str, delta: str
    ) -> None:
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=delta,
                metadata={"_stream_delta": True, "_stream_id": f"{turn_id}:{call_id}"},
            )
        )

    async def _publish_stream_end(self, msg: InboundMessage, turn_id: str, call_id: str) -> None:
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="",
                metadata={"_stream_end": True, "_stream_id": f"{turn_id}:{call_id}"},
            )
        )


__all__ = ["PartnerRunner"]
