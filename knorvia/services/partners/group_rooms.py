# -*- coding: utf-8 -*-
"""Group chat rooms for partners (Hermes bot-mode group parity).

A room is a shared conversation where 2-6 named partners coordinate.
Storage lives beside the partner tree (``data/partners/_groups/<id>.json``):
members, name, and the full transcript. The engine drives turns in
round-robin order — each member sees the transcript so far, answers once,
then the next member speaks — until everyone has responded to the latest
user message or an explicit stop.

Rooms are standalone rows in the roster UI; membership changes are plain
metadata edits that never touch a partner's own config.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import logging
from pathlib import Path
import threading
import uuid

logger = logging.getLogger(__name__)

MAX_MEMBERS = 6


@dataclass
class RoomMessage:
    sender: str  # partner id or "user"
    sender_name: str
    content: str
    timestamp: float


@dataclass
class RoomMember:
    """One seat in the room. ``backend`` is a subagent kind (claude_code,
    codex, grok_build, ..., partner); ``connection`` is the KB connection
    name it consults through. Display name and persona are room-local:
    renaming here never touches the shared connection."""

    backend: str
    connection: str
    display_name: str = ""
    persona: str = ""  # identity word(s) injected into the member's prompt

    def to_dict(self) -> dict:
        return {
            "backend": self.backend,
            "connection": self.connection,
            "display_name": self.display_name,
            "persona": self.persona,
        }


def _member_from_dict(data: dict) -> RoomMember:
    return RoomMember(
        backend=str(data.get("backend", "")),
        connection=str(data.get("connection", "")),
        display_name=str(data.get("display_name", "")),
        persona=str(data.get("persona", "")),
    )


@dataclass
class Room:
    id: str
    name: str
    members: list["RoomMember"] = field(default_factory=list)
    messages: list[RoomMessage] = field(default_factory=list)
    created_at: float = 0.0
    # Hermes bot-mode: a member wrote @user and the room is waiting on the human.
    needs_you: bool = False


class GroupRoomStore:
    """JSON-file persistence for group rooms (small scale, whole-file writes)."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, room_id: str) -> Path:
        safe = "".join(c for c in room_id if c.isalnum() or c in "-_")
        return self._root / f"{safe}.json"

    def list_rooms(self) -> list[Room]:
        rooms: list[Room] = []
        with self._lock:
            for path in sorted(self._root.glob("*.json")):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    msgs = [
                        RoomMessage(**m) for m in data.get("messages", []) if isinstance(m, dict)
                    ]
                    members = [
                        _member_from_dict(m) for m in data.get("members", []) if isinstance(m, dict)
                    ]
                    rooms.append(
                        Room(
                            id=data["id"],
                            name=data.get("name", ""),
                            members=members,
                            messages=msgs,
                            created_at=float(data.get("created_at", 0)),
                            needs_you=bool(data.get("needs_you", False)),
                        )
                    )
                except Exception:  # noqa: BLE001 - skip corrupt files
                    logger.exception("skipping corrupt room file %s", path.name)
        return rooms

    def get(self, room_id: str) -> Room | None:
        for room in self.list_rooms():
            if room.id == room_id:
                return room
        return None

    def save(self, room: Room) -> None:
        payload = asdict(room)
        with self._lock:
            self._path(room.id).write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )

    def delete(self, room_id: str) -> bool:
        path = self._path(room_id)
        if path.exists():
            with self._lock:
                path.unlink()
            return True
        return False


def new_room(name: str) -> Room:
    """Rooms are born EMPTY — the user adds CLI-backed members afterwards."""
    import time

    return Room(
        id=f"grp_{uuid.uuid4().hex[:10]}",
        name=name.strip() or "Group",
        created_at=time.time(),
    )
