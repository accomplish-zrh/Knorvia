# -*- coding: utf-8 -*-
"""Group chat engine: drive partner turns in a shared room.

Round-robin moderation: after a user message, each running member (in
member order) sees the transcript so far and answers once. Members see
the room transcript through their own session store — the room injects
the conversation as an inbound message whose session key is the room id,
so transcripts persist per-partner exactly like botdm sessions.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from knorvia.partners.bus.events import InboundMessage
from knorvia.services.partners.group_rooms import GroupRoomStore, Room, RoomMessage, new_room

logger = logging.getLogger(__name__)


class GroupChatEngine:
    """Coordinates multi-partner rooms on top of the partner manager."""

    def __init__(self, store: GroupRoomStore) -> None:
        self._store = store

    # ── CRUD passthrough ──────────────────────────────────────────

    def create_room(self, name: str, members: list[str]) -> Room:
        room = new_room(name, members)
        self._store.save(room)
        return room

    def rename_room(self, room_id: str, name: str) -> Room | None:
        room = self._store.get(room_id)
        if not room:
            return None
        room.name = name.strip() or room.name
        self._store.save(room)
        return room

    def set_members(self, room_id: str, members: list[str]) -> Room | None:
        unique = [m for i, m in enumerate(members) if m and m not in members[:i]]
        if not (2 <= len(unique) <= 6):
            raise ValueError("A group needs 2-6 distinct members.")
        room = self._store.get(room_id)
        if not room:
            return None
        room.members = unique
        self._store.save(room)
        return room

    def delete_room(self, room_id: str) -> bool:
        return self._store.delete(room_id)

    def get_room(self, room_id: str) -> Room | None:
        return self._store.get(room_id)

    def list_rooms(self) -> list[dict[str, Any]]:
        from knorvia.services.partners import get_partner_manager

        manager = get_partner_manager()
        rooms = []
        for room in self._store.list_rooms():
            names = {}
            for pid in room.members:
                inst = manager.get_partner(pid)
                cfg_name = ""
                if inst and getattr(inst, "config", None):
                    cfg_name = getattr(inst.config, "name", "")
                names[pid] = cfg_name or pid
            last = room.messages[-1] if room.messages else None
            rooms.append(
                {
                    "id": room.id,
                    "name": room.name,
                    "members": room.members,
                    "member_names": names,
                    "message_count": len(room.messages),
                    "last_message": (last.content[:120] if last else ""),
                    "last_timestamp": (last.timestamp if last else room.created_at),
                }
            )
        return rooms

    # ── Conversation ─────────────────────────────────────────────

    async def send_user_message(
        self,
        room_id: str,
        content: str,
        *,
        max_speakers: int | None = None,
    ) -> dict[str, Any]:
        """User speaks into the room; every member answers once in turn."""
        from knorvia.services.partners import get_partner_manager

        manager = get_partner_manager()
        room = self._store.get(room_id)
        if not room:
            raise LookupError(f"Room {room_id!r} not found")

        now = time.time()
        room.messages.append(RoomMessage("user", "user", content, now))
        speakers = [pid for pid in room.members]
        if max_speakers is not None:
            speakers = speakers[: max(1, max_speakers)]

        replies: list[dict[str, str]] = []
        for pid in speakers:
            instance = manager.get_partner(pid)
            if not instance or not instance.running or not instance.runner:
                replies.append({"partner": pid, "status": "skipped", "reply": ""})
                continue
            name = (
                getattr(getattr(instance, "config", None), "name", "") or pid
            )
            transcript = self._render_transcript(room)
            prompt = (
                f"You are in a group chat with other partners and the user. "
                f"Transcript so far:\n\n{transcript}\n\n"
                f"It is your turn to speak. Answer the latest message directly "
                f"and concisely; do not repeat what others said."
            )
            msg = InboundMessage(
                channel="group",
                sender_id="room",
                chat_id=room.id,
                content=prompt,
                metadata={"_group_room": room.id},
                session_key_override=f"group:{room.id}",
            )
            try:
                reply = await instance.runner.process_message(msg)
            except Exception as exc:  # noqa: BLE001 - one bad member must not kill the room
                logger.exception("group turn failed for %s in %s", pid, room.id)
                replies.append({"partner": pid, "status": "error", "reply": str(exc)})
                continue
            reply = (reply or "").strip()
            room.messages.append(RoomMessage(pid, name, reply, time.time()))
            replies.append({"partner": pid, "status": "ok", "reply": reply})

        self._store.save(room)
        return {
            "room_id": room.id,
            "replies": replies,
            "transcript": [
                {"sender": m.sender, "sender_name": m.sender_name, "content": m.content}
                for m in room.messages[-30:]
            ],
        }

    def _render_transcript(self, room: Room) -> str:
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
