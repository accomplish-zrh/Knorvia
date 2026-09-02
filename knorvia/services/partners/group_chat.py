# -*- coding: utf-8 -*-
"""Group chat engine: Hermes bot-mode rooms.

After a user message the room runs up to three serial rounds. @mentioned
members speak (everyone, when nobody is named). Each member replies
briefly or passes; a fully silent round settles the room. Members may
@Name a teammate into the next round or @user to raise a needs-you flag.
Hard caps: 10 spoken replies per send, 3 rounds.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from knorvia.services.partners.group_rooms import (
    GroupRoomStore,
    Room,
    RoomMember,
    RoomMessage,
    new_room,
)

logger = logging.getLogger(__name__)

GROUP_TRANSCRIPT_MAX = 200
MEMBER_TURN_TIMEOUT_SECONDS = 300
MAX_ROUNDS = 3
MAX_MESSAGES_PER_SEND = 10

_PASS_REPLIES = frozenset(
    {
        "",
        "pass",
        "pass.",
        "[silent]",
        "silent",
        "过",
        "跳过",
    }
)
_USER_MENTION = re.compile(r"(?<![\w])@user\b", re.IGNORECASE)
_AT_TOKEN = re.compile(r"@([\w\-\u4e00-\u9fff]+)")


def is_pass_reply(text: str) -> bool:
    """True when the member declined to speak this beat (Hermes pass / SILENT)."""
    stripped = (text or "").strip()
    if not stripped:
        return True
    low = stripped.lower()
    if low in _PASS_REPLIES or low in {"[silent]", "silent"}:
        return True
    return stripped in {"[SILENT]", "SILENT"}


def is_silence_token(text: str) -> bool:
    """IM-gateway silence: suppress outbound delivery of this exact reply."""
    return (text or "").strip() in {"[SILENT]", "SILENT", "[silent]"}


def mentions_user(text: str) -> bool:
    return bool(_USER_MENTION.search(text or ""))

_room_locks: dict[str, asyncio.Lock] = {}


def _lock_for(room_id: str) -> asyncio.Lock:
    lock = _room_locks.get(room_id)
    if lock is None:
        lock = _room_locks[room_id] = asyncio.Lock()
    return lock


class GroupChatEngine:
    """Coordinates multi-partner rooms on top of the partner manager."""

    def __init__(self, store: GroupRoomStore) -> None:
        self._store = store

    # ── CRUD passthrough ──────────────────────────────────────────

    def create_room(self, name: str) -> Room:
        room = new_room(name)
        self._store.save(room)
        return room

    def rename_room(self, room_id: str, name: str) -> Room | None:
        room = self._store.get(room_id)
        if not room:
            return None
        room.name = name.strip() or room.name
        self._store.save(room)
        return room

    def add_member(
        self,
        room_id: str,
        *,
        backend: str,
        connection: str,
        display_name: str = "",
        persona: str = "",
    ) -> Room | None:
        """Seat one CLI-backed agent in the room (max 6 seats)."""
        from knorvia.services.subagent import get_backend, list_backend_kinds

        if backend not in list_backend_kinds():
            raise ValueError(f"Unknown agent backend {backend!r}.")
        if get_backend(backend) is None:
            raise ValueError(f"Unknown agent backend {backend!r}.")
        room = self._store.get(room_id)
        if not room:
            return None
        if len(room.members) >= 6:
            raise ValueError("A room holds at most 6 members.")
        if any(m.connection == connection for m in room.members):
            raise ValueError(f"{connection!r} is already in this room.")
        room.members.append(
            RoomMember(
                backend=backend,
                connection=connection,
                display_name=display_name.strip(),
                persona=persona.strip(),
            )
        )
        self._store.save(room)
        return room

    def remove_member(self, room_id: str, connection: str) -> Room | None:
        room = self._store.get(room_id)
        if not room:
            return None
        before = len(room.members)
        room.members = [m for m in room.members if m.connection != connection]
        if len(room.members) == before:
            return None
        self._store.save(room)
        return room

    def update_member(
        self,
        room_id: str,
        connection: str,
        *,
        display_name: str | None = None,
        persona: str | None = None,
    ) -> Room | None:
        """Room-local rename / identity word — the connection is untouched."""
        room = self._store.get(room_id)
        if not room:
            return None
        member = next((m for m in room.members if m.connection == connection), None)
        if not member:
            return None
        if display_name is not None:
            member.display_name = display_name.strip()
        if persona is not None:
            member.persona = persona.strip()
        self._store.save(room)
        return room

    def delete_room(self, room_id: str) -> bool:
        return self._store.delete(room_id)

    def get_room(self, room_id: str) -> Room | None:
        return self._store.get(room_id)

    def list_rooms(self) -> list[dict[str, Any]]:
        rooms = []
        for room in self._store.list_rooms():
            last = room.messages[-1] if room.messages else None
            rooms.append(
                {
                    "id": room.id,
                    "name": room.name,
                    "members": [m.to_dict() for m in room.members],
                    "message_count": len(room.messages),
                    "last_message": (last.content[:120] if last else ""),
                    "last_timestamp": (last.timestamp if last else room.created_at),
                    "needs_you": bool(room.needs_you),
                }
            )
        return rooms

    # ── Conversation ─────────────────────────────────────────────

    def _resolve_mentions(self, room: "Room", content: str) -> list["RoomMember"] | None:
        """Members explicitly @addressed in *content*, or None for all.

        Matches @display_name and @connection (case-insensitive). @user is
        reserved for human escalation and never selects a member. Unknown
        @names are ignored — a typo falls back to the full round instead of
        swallowing the message.
        """
        tokens = {
            t.lower()
            for t in _AT_TOKEN.findall(content or "")
            if t.lower() not in {"user", "human"}
        }
        if not tokens:
            return None

        named: list[RoomMember] = []
        for member in room.members:
            haystacks = {
                member.connection.lower(),
                member.display_name.strip().lower(),
            }
            if tokens & haystacks:
                named.append(member)
        return named or None

    def _member_prompt(
        self,
        room: Room,
        member: RoomMember,
        *,
        addressed: bool,
        round_index: int,
    ) -> str:
        name = member.display_name or member.connection
        persona_line = (
            f"Your identity in this room: {member.persona}. " if member.persona else ""
        )
        teammates = ", ".join(
            (m.display_name or m.connection)
            for m in room.members
            if m.connection != member.connection
        )
        roster = f"Teammates: {teammates}. " if teammates else ""
        turn = (
            "You were @addressed by name. Respond to the point raised. "
            if addressed
            else "It is your turn. Speak only if you have something new; otherwise pass. "
        )
        return (
            f"You are {name}, one of several named bots in a group room with the user. "
            f"{persona_line}{roster}"
            f"Round {round_index + 1} of {MAX_ROUNDS}. "
            f"Transcript so far:\n\n{self._render_transcript(room)}\n\n"
            f"{turn}"
            "Reply in one short beat, or pass with a single line PASS (or [SILENT]). "
            "@Name pulls that teammate into the next round. "
            "@user escalates a real judgment call to the human. "
            "Do not recap the whole room. Do not greet."
        )

    async def send_user_message(
        self,
        room_id: str,
        content: str,
        *,
        max_speakers: int | None = None,
    ) -> dict[str, Any]:
        """User speaks; members take up to three serial rounds (Hermes bot-mode)."""
        async with _lock_for(room_id):
            return await self._send_user_message_locked(room_id, content, max_speakers=max_speakers)

    async def _send_user_message_locked(
        self,
        room_id: str,
        content: str,
        *,
        max_speakers: int | None = None,
    ) -> dict[str, Any]:
        room = self._store.get(room_id)
        if not room:
            raise LookupError(f"Room {room_id!r} not found")
        if not room.members:
            raise ValueError("This room has no members yet — add a CLI-backed member first.")

        now = time.time()
        room.messages.append(RoomMessage("user", "user", content, now))
        room.needs_you = False
        mentioned = self._resolve_mentions(room, content)
        speakers: list[RoomMember] = list(mentioned) if mentioned is not None else list(room.members)
        if max_speakers is not None:
            speakers = speakers[: max(1, max_speakers)]

        replies: list[dict[str, Any]] = []
        failed: set[str] = set()
        spoken = 0
        rounds_run = 0
        settled = "complete"

        for round_index in range(MAX_ROUNDS):
            if spoken >= MAX_MESSAGES_PER_SEND:
                settled = "cap"
                break
            round_spoke = False
            pull_ins: list[RoomMember] = []
            for member in list(speakers):
                if spoken >= MAX_MESSAGES_PER_SEND:
                    settled = "cap"
                    break
                if member.connection in failed:
                    continue
                name = member.display_name or member.connection
                addressed = mentioned is not None and any(
                    m.connection == member.connection for m in mentioned
                )
                prompt = self._member_prompt(
                    room, member, addressed=addressed, round_index=round_index
                )
                try:
                    reply = await asyncio.wait_for(
                        self._consult_member(room, member, prompt),
                        timeout=MEMBER_TURN_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "group turn timed out for %s in %s", member.connection, room.id
                    )
                    failed.add(member.connection)
                    replies.append(
                        {
                            "member": name,
                            "status": "timeout",
                            "reply": "",
                            "round": round_index + 1,
                        }
                    )
                    continue
                except Exception as exc:  # noqa: BLE001 - one bad member must not kill the room
                    logger.exception(
                        "group turn failed for %s in %s", member.connection, room.id
                    )
                    failed.add(member.connection)
                    replies.append(
                        {
                            "member": name,
                            "status": "error",
                            "reply": str(exc),
                            "round": round_index + 1,
                        }
                    )
                    continue
                reply = (reply or "").strip()
                if is_pass_reply(reply):
                    replies.append(
                        {
                            "member": name,
                            "status": "pass",
                            "reply": "",
                            "round": round_index + 1,
                        }
                    )
                    continue
                room.messages.append(RoomMessage(member.connection, name, reply, time.time()))
                spoken += 1
                round_spoke = True
                if mentions_user(reply):
                    room.needs_you = True
                pulled = self._resolve_mentions(room, reply)
                if pulled:
                    seated = {m.connection for m in speakers}
                    for extra in pulled:
                        if extra.connection not in seated:
                            pull_ins.append(extra)
                            seated.add(extra.connection)
                replies.append(
                    {
                        "member": name,
                        "status": "ok",
                        "reply": reply,
                        "round": round_index + 1,
                    }
                )
            rounds_run = round_index + 1
            if not round_spoke:
                settled = "silent"
                break
            if pull_ins:
                speakers = list(speakers) + pull_ins
                mentioned = (mentioned or []) + pull_ins

        if len(room.messages) > GROUP_TRANSCRIPT_MAX:
            room.messages = room.messages[-GROUP_TRANSCRIPT_MAX:]
        self._store.save(room)
        return {
            "room_id": room.id,
            "replies": replies,
            "rounds": rounds_run,
            "settled": settled,
            "needs_you": room.needs_you,
            "transcript": [
                {
                    "sender": m.sender,
                    "sender_name": m.sender_name,
                    "content": m.content,
                    "timestamp": m.timestamp,
                }
                for m in room.messages[-30:]
            ],
        }

    async def _consult_member(self, room: "Room", member: "RoomMember", prompt: str) -> str:
        """One member's turn through its real subagent backend.

        Session anchoring: the cross-turn registry key is
        ``room:<room_id>::<connection>`` — reopening this room resumes
        exactly that CLI session; different rooms never share history.
        """
        from knorvia.services.subagent import get_backend, load_subagent_settings

        backend = get_backend(member.backend)
        if backend is None:
            raise ValueError(f"Unknown agent backend {member.backend!r}.")
        config = load_subagent_settings().backend(member.backend)

        from knorvia.services.subagent.sessions import get_session, remember_session, session_key

        anchor_key = session_key(f"room:{room.id}", member.connection)
        resume_id = get_session(anchor_key)

        def _on_event(_event) -> None:  # noqa: ANN001 - events unused in rooms
            return None

        result = await backend.consult(
            prompt,
            on_event=_on_event,
            cwd=None,
            session_id=resume_id,
            config=config,
        )
        if result.session_id:
            remember_session(anchor_key, result.session_id, kind=member.backend)
        return (result.final_text or "").strip()

    def _render_transcript(self, room: "Room") -> str:
        lines = []
        for m in room.messages[-20:]:
            who = "user" if m.sender == "user" else f"{m.sender_name} ({m.sender})"
            lines.append(f"{who}: {m.content}")
        return "\n".join(lines)


_store_instance: GroupRoomStore | None = None


def get_group_room_engine():
    global _store_instance
    from knorvia.partners.config.paths import get_data_dir

    if _store_instance is None:
        _store_instance = GroupRoomStore(get_data_dir() / "_groups")
    return GroupChatEngine(_store_instance)
