"""Document-grounded Co-Writer chat with paper citations.

Left pane is the markdown editor; this module powers the right-pane chat.
Citations are extracted from the draft itself (headings, markdown links,
numbered references). Optional LLM completion uses already-configured
local providers; if none are reachable we still return the citations.
"""

from __future__ import annotations

import re
from typing import Any

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
LINK_RE = re.compile(r"\[([^\]]{1,120})\]\((https?://[^)\s]+)\)")
NUMBERED_REF_RE = re.compile(r"^\[(\d+)\]\s+(.+)$", re.MULTILINE)

_MAX_CITATIONS = 12
_DOC_CHARS = 12_000
_HISTORY_TURNS = 12


def extract_paper_citations(content: str) -> list[dict[str, Any]]:
    """Pull citations from the open draft (headings, links, [n] refs)."""
    text = content or ""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(title: str, source: str, body: str = "") -> None:
        key = f"{title}|{source}"
        if not title or key in seen or len(out) >= _MAX_CITATIONS:
            return
        seen.add(key)
        out.append(
            {
                "title": title.strip()[:180],
                "source": source,
                "content": (body or "")[:400],
            }
        )

    for match in HEADING_RE.finditer(text):
        add(match.group(2).strip(), "heading", match.group(0).strip())
    for match in LINK_RE.finditer(text):
        add(match.group(1).strip(), match.group(2).strip(), match.group(2).strip())
    for match in NUMBERED_REF_RE.finditer(text):
        add(f"[{match.group(1)}] {match.group(2).strip()[:80]}", "reference", match.group(2).strip())
    return out


def _fallback_reply(title: str, citations: list[dict[str, Any]], message: str) -> str:
    heading_bits = [
        c["title"] for c in citations if c.get("source") == "heading"
    ][:6]
    outline = " / ".join(heading_bits) if heading_bits else (title or "Untitled draft")
    asked = (message or "").strip() or "..."
    return (
        f"I read the open draft ({outline}). "
        f"About \"{asked}\": use the section list on the right as citations, "
        "then ask me to rewrite, tighten, or insert a paragraph."
    )


async def reply_about_paper(
    *,
    title: str,
    content: str,
    history: list[dict[str, Any]],
    message: str,
) -> dict[str, Any]:
    citations = extract_paper_citations(content)
    clipped = (content or "")[:_DOC_CHARS]
    system = (
        "You are Knorvia Co-Writer, a paper-writing partner. "
        "The user is editing a markdown draft in the left pane. "
        "Answer in the user's language. Cite section headings when you refer "
        "to the draft. Do not invent bibliographic entries that are not in "
        "the draft. Keep replies concise and editable."
    )
    messages: list[dict[str, str]] = []
    for item in history[-_HISTORY_TURNS:]:
        role = item.get("role")
        text = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and text:
            messages.append({"role": role, "content": text})
    prompt = (
        f"Document title: {title or 'Untitled draft'}\n\n"
        f"--- draft ---\n{clipped}\n--- end draft ---\n\n"
        f"User: {message.strip()}"
    )
    reply = ""
    try:
        from knorvia.services.llm.factory import complete

        reply = await complete(
            prompt=prompt,
            system_prompt=system,
            messages=messages or None,
        )
        reply = (reply or "").strip()
    except Exception:
        reply = ""
    if not reply:
        reply = _fallback_reply(title, citations, message)
    return {"reply": reply, "citations": citations}


__all__ = ["extract_paper_citations", "reply_about_paper"]
