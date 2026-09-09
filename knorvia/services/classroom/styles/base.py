"""Style primitives — the constraint contract and the style spec shape."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class OutlineConstraints:
    """Machine-checkable outline contract for one teaching style."""

    scene_count_min: int = 0
    scene_count_max: int = 99
    allowed_types: tuple[str, ...] = ("slide", "quiz", "discussion")
    first_scene_type: str = ""
    quiz_min: int = 0
    quiz_max: int = 2
    discussion_min: int = 0
    discussion_max: int = 1
    # Types that may not appear twice in a row (e.g. ["interactive"]).
    no_consecutive_types: tuple[str, ...] = field(default_factory=tuple)
    # Optional floor for slide share of the lesson (0 disables the check).
    min_slide_ratio: float = 0.0


@dataclass(frozen=True)
class StyleSpec:
    """One teaching style: pedagogy text + an enforceable outline contract."""

    id: str
    title: str  # Chinese display title (the /styles endpoint contract).
    title_en: str
    description: str
    description_en: str
    prompt_text: str  # Chinese pedagogy directive for the outline prompt.
    constraints: OutlineConstraints


__all__ = ["OutlineConstraints", "StyleSpec"]
