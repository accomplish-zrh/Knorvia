"""Agent identity + channel-collaboration protocol (grok-bot alignment).

A direct port of the agent-messaging / agent-profile / settings-file layer from
the ``b-nnett/grok-bot-0.18-reconstructed`` reconstruction, adapted to
Knorvia's partner model (`send_partner_message` instead of ``SendToAgent``,
per-partner workspaces under ``data/partners/<id>/``).

Semantics preserved from the reference:

* every agent (partner) is a sibling folder under the partners root, and its
  `profile.json` / `settings.json` are the canonical *file-based discovery*
  surface an agent can read for fuller detail;
* messaging between partners is ASYNCHRONOUS — send, don't wait or poll — and
  a reply arrives later on a fresh turn flagged with a wake cue;
* the receiver is woken with ``[agent]`` (*or ``[admin broadcast]``), never
  mistaking another assistant for the user typing;
* fan-out to several teammates or a group is a real side effect and must be
  justified, never reflexive;
* the roster shown to an agent is capped (``AGENT_DIRECTORY_PROMPT_LIMIT``).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
import tempfile
from typing import Any, TypedDict

logger = logging.getLogger(__name__)

# ── wire/behaviour constants ────────────────────────────────────────────

AGENT_INBOUND_WAKE_CUE = "[agent]"
ADMIN_BROADCAST_WAKE_CUE = "[broadcast]"

#: The partner-to-partner tool name (Knorvia's spelling of grok's SendToAgent).
SEND_TO_PARTNER_TOOL_NAME = "send_partner_message"

#: Max length of a single agent-to-agent message (grok's clamp).
AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000

#: Max number of teammates/group entries rendered into the directory prompt.
AGENT_DIRECTORY_PROMPT_LIMIT = 40


class AgentAddress(TypedDict, total=False):
    """An addressable partner (or group) an agent may message."""

    id: str
    name: str
    description: str
    is_group: bool
    # Whether this partner is currently started; a stopped partner can't
    # receive a message, so flagging it lets an agent avoid dead sends.
    running: bool


class AgentGroupAddress(AgentAddress):
    """A shared-room target; ``members`` lists the seated addresses."""

    members: list[AgentAddress]


def clamp_agent_message(text: str) -> str:
    """Clamp *text* to the agent-message length cap."""
    return (text or "")[:AGENT_MESSAGE_MAX_TEXT_LENGTH]


def _clamp_line(text: str, max_len: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= max_len else text[: max_len - 1] + "…"


def describe_address(address: AgentAddress) -> str:
    """One directory line for an address, grok ``describeAddress`` style.

    ``- name (id: id[, stopped]) — one-line description``; groups carry a
    ``(group)`` tag and a stopped partner is flagged so the agent won't waste
    a send.
    """
    description = (
        f" — {_clamp_line(str(address.get('description') or ''), 120)}"
        if str(address.get("description") or "").strip()
        else ""
    )
    state = ", stopped" if address.get("running") is False else ""
    group_tag = " (group)" if address.get("is_group") else ""
    return (
        f"- {address.get('name') or address.get('id')} "
        f"(id: {address.get('id')}{state}){group_tag}{description}"
    )


def build_mentioned_agents_context(mentioned: list[AgentAddress]) -> str | None:
    """Context block injected when the user @mentions specific partners."""
    if not mentioned:
        return None
    lines = [
        "[Partners mentioned in this message — you can reach any of them "
        f"with {SEND_TO_PARTNER_TOOL_NAME} using their id:"
    ]
    for address in mentioned:
        lines.append(describe_address(address))
    lines.append("]")
    return "\n".join(lines)


def render_agent_directory_system_prompt(
    *,
    others: list[AgentAddress] | None = None,
    groups: list[AgentGroupAddress] | None = None,
    agents_root_dir: str | None = None,
) -> str:
    """The teammate-directory protocol block an agent sees alongside its soul.

    Only emitted when there is at least one peer or group; a single-agent
    install gets no protocol noise. ``others``/``groups`` are capped at
    ``AGENT_DIRECTORY_PROMPT_LIMIT`` entries.
    """
    others = list(others or [])
    groups = list(groups or [])
    if not others and not groups:
        return ""  # a single-agent install gets no protocol noise

    lines = [
        "## Teammates",
        "You are not alone — you run alongside other named partners this user "
        "has. Each is its own assistant with its own chat, persona, and memory; "
        "you can message any of them by id or post to a shared room, and they "
        "can message you back.",
        f"Messaging is ASYNCHRONOUS, like texting: call "
        f"{SEND_TO_PARTNER_TOOL_NAME} with a target id and your message and it "
        f'is delivered and returns right away (an acknowledgement like "sent '
        f'to <name>"). The target can be a single partner OR a group you '
        f"belong to — messaging a group posts into that shared room so every "
        f"member sees it. You do NOT get a reply back in this turn and you must "
        f"not wait or poll for one — send it, then carry on or end your turn. A "
        f"reply arrives LATER as its own message that wakes you on a fresh turn "
        f"(the cue {AGENT_INBOUND_WAKE_CUE}).",
        "Use this with judgment — it is a real side effect that wakes another "
        "partner (or a whole group), so treat it like sending on the user's "
        "behalf. Message a teammate or post to a group only when it genuinely "
        "helps the user's goal, not reflexively because one was mentioned, and "
        "don't spam a group. Treat what the user tells you as private: never "
        "relay their unfiltered words verbatim; if relaying is warranted, "
        "paraphrase the actionable substance but never their venting or tone.",
        "Messaging ONE clearly relevant teammate can be normal work under "
        "that judgment. Fanning out to several teammates or a group is "
        "different — it wakes everyone and buries the user under messages they "
        "never asked for. Fan out only when the user explicitly told you to "
        "contact those partners; otherwise propose it first and wait for a yes.",
        f'Recognise the user asking for it ("@ that partner", "tell my other '
        f'agent…", "ask the group") as a cue to use '
        f"{SEND_TO_PARTNER_TOOL_NAME}.",
    ]
    if agents_root_dir:
        lines.append(
            f"Discovering partners is file-based: every partner (you included) "
            f"is a sibling folder under {agents_root_dir}. Read "
            f"<partnerId>/profile.json (name, description, title) for any "
            f"partner to see the full, fresh detail the list below doesn't show."
        )
    lines.append(
        "Managing partners: use create_partner to spin up a new teammate "
        "(then message it), and update_partner to refine an existing one's "
        "name or description safely — it merges your change and can never "
        "clear or break their profile. You have no tool to delete a partner; "
        "you can create and refine teammates but never destroy one. The "
        "owner can delete a partner themselves from the Partners page."
    )
    if others:
        lines.append("Partners you can message right now:")
        for address in others[:AGENT_DIRECTORY_PROMPT_LIMIT]:
            lines.append(describe_address(address))
        if len(others) > AGENT_DIRECTORY_PROMPT_LIMIT:
            lines.append("…and more (read the partner folders above for the full roster).")
    if groups:
        lines.append("Group chats you're in (post to one by its id to reach all members):")
        for group in groups[:AGENT_DIRECTORY_PROMPT_LIMIT]:
            member_names = ", ".join(
                str(m.get("name") or m.get("id")) for m in group.get("members", [])
            )
            with_clause = f" — with {member_names}" if member_names else ""
            lines.append(
                f"- {group.get('name') or group.get('id')} (id: {group.get('id')}){with_clause}"
            )
        lines.append(
            "This conversation is your private 1:1 thread with your user — no "
            "one else is here. Don't assume a group member can see this chat."
        )
    return "\n\n".join(lines)


def build_agent_inbound_wake_prompt(
    *,
    from_address: AgentAddress,
    text: str,
    images: list[str] | None = None,
    priority: bool = False,
) -> str:
    """The frame a receiver sees when another partner messages it.

    Keeps the receiving agent from mistaking an assistant for the user typing,
    and tells it how to reply (asynchronously via the tool) and when to stay
    silent (a pure FYI needs no acknowledgement).
    """
    images = list(images or [])
    name = from_address.get("name") or from_address.get("id") or "another partner"
    lines = [
        f"{AGENT_INBOUND_WAKE_CUE} A message just arrived from another of your "
        f"user's partners: {name} (id: {from_address.get('id')}).",
        (
            "This is a PRIORITY instruction from another assistant — not the "
            "user typing here. It interrupted your previous non-user work. Drop "
            "conflicting in-flight work and follow it now."
            if priority
            else "This is another assistant reaching out — not the user typing "
            "here. It arrived asynchronously."
        ),
        "",
        f"{name}: {clamp_agent_message(text)}",
    ]
    if images:
        lines.append("")
        lines.append(f"{name} attached {len(images)} image(s) to this message:")
        for url in images:
            lines.append(f"- {url}")
    lines.append("")
    lines.append(
        f"If it needs a reply or an action, handle it: reply to {name} with "
        f"{SEND_TO_PARTNER_TOOL_NAME} (their id: {from_address.get('id')}), "
        f"which reaches them on a later turn — not a live back-and-forth. If it "
        f"is just an FYI with nothing for you to do, it is fine to stay silent."
    )
    return "\n".join(lines)


def build_admin_broadcast_wake_prompt(message: str) -> str:
    """The frame an agent sees when the user broadcasts to every partner."""
    return "\n".join(
        [
            f"{ADMIN_BROADCAST_WAKE_CUE} A direct message from your user — the "
            "owner who runs you — broadcast to their partners.",
            "This is the user speaking to you (and, separately, to their other "
            "partners), not another partner. Treat it as a directive or "
            "announcement from the person you work for.",
            "",
            f"The user says: {clamp_agent_message(message)}",
            "",
            "Act on it as makes sense for you, then reply to the user so they "
            "know you received it and what you did. Keep your reply concise.",
        ]
    )


# ── agent profile (data/partners/<id>/profile.json) ─────────────────────

PROFILE_FILENAME = "profile.json"


class SandAgentProfile(TypedDict, total=False):
    """grok ``profile.json`` schema (name/description/title/avatar*)."""

    name: str
    description: str
    title: str
    avatar_shape: str  # grok: avatarShape
    avatar_color: str  # grok: avatarColor


def profile_path(agent_dir: Path | str) -> Path:
    return Path(agent_dir) / PROFILE_FILENAME


def _parse_json_file(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:  # noqa: BLE001 - best-effort file read
        return {}


def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with open(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        Path(tmp).replace(path)
    finally:
        if Path(tmp).exists():
            Path(tmp).unlink(missing_ok=True)


def read_profile(agent_dir: Path | str) -> SandAgentProfile:
    raw = _parse_json_file(profile_path(agent_dir))
    return {
        "name": str(raw.get("name") or ""),
        "description": str(raw.get("description") or ""),
        "title": str(raw.get("title") or "").strip(),
        "avatar_shape": str(raw.get("avatarShape") or raw.get("avatar_shape") or "").strip(),
        "avatar_color": str(raw.get("avatarColor") or raw.get("avatar_color") or "").strip(),
    }


def write_profile(agent_dir: Path | str, profile: SandAgentProfile) -> None:
    _atomic_write(
        profile_path(agent_dir),
        {
            "name": str(profile.get("name") or ""),
            "description": str(profile.get("description") or ""),
            "title": str(profile.get("title") or "").strip(),
            "avatarShape": str(profile.get("avatar_shape") or "").strip(),
            "avatarColor": str(profile.get("avatar_color") or "").strip(),
        },
    )


# ── agent settings (data/partners/<id>/settings.json) ────────────────────

SETTINGS_FILENAME = "settings.json"

DEFAULT_NOTIFY_ON_AGENT_UPDATES = True
DEFAULT_HIDDEN_FROM_SIDEBAR = False

#: Knorvia's on-disk (snake_case) spelling of the grok settings.json keys.
NOTIFY_ON_AGENT_UPDATES_KEY = "notify_on_agent_updates"
HIDDEN_FROM_SIDEBAR_KEY = "hidden_from_sidebar"


def settings_path(agent_dir: Path | str) -> Path:
    return Path(agent_dir) / SETTINGS_FILENAME


def read_settings(agent_dir: Path | str) -> dict[str, Any]:
    raw = _parse_json_file(settings_path(agent_dir))
    notify = raw.get(NOTIFY_ON_AGENT_UPDATES_KEY, raw.get("notifyOnAgentUpdates"))
    hidden = raw.get(HIDDEN_FROM_SIDEBAR_KEY, raw.get("hiddenFromSidebar"))
    return {
        NOTIFY_ON_AGENT_UPDATES_KEY: (
            bool(notify) if isinstance(notify, bool) else DEFAULT_NOTIFY_ON_AGENT_UPDATES
        ),
        HIDDEN_FROM_SIDEBAR_KEY: (
            bool(hidden) if isinstance(hidden, bool) else DEFAULT_HIDDEN_FROM_SIDEBAR
        ),
    }


def write_settings(
    agent_dir: Path | str,
    update: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge *update* into the on-disk settings and return the new full set."""
    current = read_settings(agent_dir)
    camel = {
        "notifyOnAgentUpdates": NOTIFY_ON_AGENT_UPDATES_KEY,
        "hiddenFromSidebar": HIDDEN_FROM_SIDEBAR_KEY,
        NOTIFY_ON_AGENT_UPDATES_KEY: NOTIFY_ON_AGENT_UPDATES_KEY,
        HIDDEN_FROM_SIDEBAR_KEY: HIDDEN_FROM_SIDEBAR_KEY,
    }
    for key, value in (update or {}).items():
        current[camel.get(key, key)] = (
            value if isinstance(value, bool) else current.get(camel.get(key, key))
        )
    _atomic_write(settings_path(agent_dir), current)
    return current


__all__ = [
    "ADMIN_BROADCAST_WAKE_CUE",
    "AGENT_DIRECTORY_PROMPT_LIMIT",
    "AGENT_INBOUND_WAKE_CUE",
    "AGENT_MESSAGE_MAX_TEXT_LENGTH",
    "AgentAddress",
    "AgentGroupAddress",
    "DEFAULT_HIDDEN_FROM_SIDEBAR",
    "DEFAULT_NOTIFY_ON_AGENT_UPDATES",
    "HIDDEN_FROM_SIDEBAR_KEY",
    "NOTIFY_ON_AGENT_UPDATES_KEY",
    "PROFILE_FILENAME",
    "SEND_TO_PARTNER_TOOL_NAME",
    "SETTINGS_FILENAME",
    "SandAgentProfile",
    "build_admin_broadcast_wake_prompt",
    "build_agent_inbound_wake_prompt",
    "build_mentioned_agents_context",
    "clamp_agent_message",
    "describe_address",
    "profile_path",
    "read_profile",
    "read_settings",
    "render_agent_directory_system_prompt",
    "settings_path",
    "write_profile",
    "write_settings",
]
