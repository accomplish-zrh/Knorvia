"""Teaching-style skill packs (OpenMAIC parity).

A style is two halves, mirroring OpenMAIC's "SKILL.md text + machine-checkable
outline constraints" split: ``prompt_text`` is the pedagogy directive injected
into the outline prompt, ``constraints`` is the deterministic contract the
generated outline must satisfy (checked by ``styles.verify``).
"""

from __future__ import annotations

from knorvia.services.classroom.styles.base import OutlineConstraints, StyleSpec
from knorvia.services.classroom.styles.brief_overview import BRIEF_OVERVIEW
from knorvia.services.classroom.styles.hands_on import HANDS_ON
from knorvia.services.classroom.styles.master_lecture import MASTER_LECTURE

STYLES: dict[str, StyleSpec] = {
    style.id: style for style in (MASTER_LECTURE, HANDS_ON, BRIEF_OVERVIEW)
}


def get_style(style_id: str) -> StyleSpec | None:
    return STYLES.get(str(style_id or "").strip())


def list_styles() -> list[StyleSpec]:
    return list(STYLES.values())


__all__ = [
    "BRIEF_OVERVIEW",
    "HANDS_ON",
    "MASTER_LECTURE",
    "OutlineConstraints",
    "STYLES",
    "StyleSpec",
    "get_style",
    "list_styles",
]
