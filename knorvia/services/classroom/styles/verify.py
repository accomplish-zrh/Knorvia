"""Deterministic outline validator + repairer (OpenMAIC outline discipline).

``check_outline`` is a pure function returning human-readable violations;
``repair`` fixes what is deterministically fixable — delete/downgrade only
(never invents scenes): over-budget quiz/discussion degrade to slide keeping
title/key_points, surplus tail scenes are truncated, and the first scene is
swapped into the required type. Both are style-agnostic: they only see an
``OutlineConstraints``.
"""

from __future__ import annotations

from knorvia.services.classroom.models import (
    MAX_INTERACTIVE_SCENES,
    SCENE_TYPES,
    SceneOutline,
)
from knorvia.services.classroom.styles.base import OutlineConstraints

_FALLBACK_TYPE = "slide"


def check_outline(
    outlines: list[SceneOutline], constraints: OutlineConstraints
) -> list[str]:
    """Return diagnostics for every violated hard constraint (empty = pass)."""
    diagnostics: list[str] = []
    total = len(outlines)
    if not constraints.scene_count_min <= total <= constraints.scene_count_max:
        diagnostics.append(
            f"scene_count={total} outside [{constraints.scene_count_min}, "
            f"{constraints.scene_count_max}]"
        )

    allowed = set(constraints.allowed_types)
    quiz_seen = 0
    discussion_seen = 0
    interactive_seen = 0
    slide_seen = 0
    for outline in outlines:
        if outline.type not in allowed:
            diagnostics.append(
                f"scene {outline.order + 1} ('{outline.title or outline.id}') "
                f"has type '{outline.type}' outside allowed set "
                f"[{', '.join(sorted(allowed))}]"
            )
        if outline.type == "quiz":
            quiz_seen += 1
        elif outline.type == "discussion":
            discussion_seen += 1
        elif outline.type == "slide":
            slide_seen += 1
        elif outline.type == "interactive":
            interactive_seen += 1
            if outline.widget is None:
                diagnostics.append(
                    f"scene {outline.order + 1} ('{outline.title or outline.id}') "
                    "is interactive but has no widget outline"
                )
            else:
                problems = outline.widget.validate()
                if problems:
                    diagnostics.append(
                        f"scene {outline.order + 1} ('{outline.title or outline.id}') "
                        f"has an invalid widget: {'; '.join(problems)}"
                    )
    if interactive_seen > MAX_INTERACTIVE_SCENES:
        diagnostics.append(
            f"interactive count {interactive_seen} above maximum "
            f"{MAX_INTERACTIVE_SCENES}"
        )
    if quiz_seen < constraints.quiz_min:
        diagnostics.append(
            f"quiz count {quiz_seen} below minimum {constraints.quiz_min}"
        )
    if quiz_seen > constraints.quiz_max:
        diagnostics.append(
            f"quiz count {quiz_seen} above maximum {constraints.quiz_max}"
        )
    if discussion_seen < constraints.discussion_min:
        diagnostics.append(
            f"discussion count {discussion_seen} below minimum "
            f"{constraints.discussion_min}"
        )
    if discussion_seen > constraints.discussion_max:
        diagnostics.append(
            f"discussion count {discussion_seen} above maximum "
            f"{constraints.discussion_max}"
        )

    if constraints.first_scene_type and outlines:
        first = outlines[0].type
        if first != constraints.first_scene_type:
            diagnostics.append(
                f"first scene must be '{constraints.first_scene_type}', got '{first}'"
            )

    forbidden = set(constraints.no_consecutive_types)
    if forbidden:
        for prev, curr in zip(outlines, outlines[1:]):
            if prev.type in forbidden and prev.type == curr.type:
                diagnostics.append(
                    f"forbidden consecutive '{curr.type}' scenes at positions "
                    f"{prev.order + 1}-{curr.order + 1}"
                )

    if constraints.min_slide_ratio > 0 and total:
        ratio = slide_seen / total
        if ratio < constraints.min_slide_ratio:
            diagnostics.append(
                f"slide ratio {ratio:.2f} below required {constraints.min_slide_ratio:.2f}"
            )
    return diagnostics


def repair(
    outlines: list[SceneOutline], constraints: OutlineConstraints
) -> list[SceneOutline]:
    """Deterministically fix what is fixable; delete/downgrade only.

    Returns new SceneOutline objects (the input list is never mutated).
    Lower-bound violations (e.g. too few scenes) cannot be repaired by
    deletion and are left for the caller to accept.
    """
    allowed = set(constraints.allowed_types)
    fallback = _FALLBACK_TYPE if _FALLBACK_TYPE in allowed else ""
    repaired: list[SceneOutline] = []

    # 1. Degrade disallowed and over-budget quiz/discussion/interactive
    #    types to slide.
    quiz_seen = 0
    discussion_seen = 0
    interactive_seen = 0
    for outline in outlines:
        clone = SceneOutline.from_dict(outline.to_dict())
        if clone.type not in allowed:
            clone.type = fallback or clone.type
        if clone.type == "quiz":
            quiz_seen += 1
            if quiz_seen > constraints.quiz_max:
                clone.type = fallback or clone.type
        elif clone.type == "discussion":
            discussion_seen += 1
            if discussion_seen > constraints.discussion_max:
                clone.type = fallback or clone.type
        elif clone.type == "interactive":
            interactive_seen += 1
            if interactive_seen > MAX_INTERACTIVE_SCENES:
                clone.type = fallback or clone.type
        repaired.append(clone)

    # 2. Truncate the tail beyond the scene-count ceiling.
    if len(repaired) > constraints.scene_count_max:
        repaired = repaired[: constraints.scene_count_max]

    # 3. Guarantee the required opening type via a swap (no scene invented).
    if (
        constraints.first_scene_type
        and repaired
        and repaired[0].type != constraints.first_scene_type
    ):
        for index, outline in enumerate(repaired[1:], start=1):
            if outline.type == constraints.first_scene_type:
                repaired[0], repaired[index] = repaired[index], repaired[0]
                break

    # 4. Break forbidden consecutive runs by degrading the later twin.
    forbidden = set(constraints.no_consecutive_types)
    if forbidden and fallback:
        for index in range(1, len(repaired)):
            prev = repaired[index - 1]
            curr = repaired[index]
            if curr.type in forbidden and curr.type == prev.type:
                curr.type = fallback

    for order, outline in enumerate(repaired):
        outline.order = order
    return repaired


def describe_constraints(constraints: OutlineConstraints) -> str:
    """Chinese one-line summary injected next to the style's prompt text."""
    parts = [f"场景数 {constraints.scene_count_min}-{constraints.scene_count_max}"]
    if constraints.first_scene_type:
        parts.append(f"首场必须是 {constraints.first_scene_type}")
    parts.append(f"quiz 数量 {constraints.quiz_min}-{constraints.quiz_max}")
    parts.append(
        f"discussion 数量 {constraints.discussion_min}-{constraints.discussion_max}"
    )
    if set(constraints.allowed_types) != set(SCENE_TYPES):
        parts.append("场景类型仅限 " + "/".join(constraints.allowed_types))
    if constraints.no_consecutive_types:
        parts.append(
            "这些类型不得连续出现：" + "/".join(constraints.no_consecutive_types)
        )
    if constraints.min_slide_ratio > 0:
        parts.append(f"slide 占比 ≥ {constraints.min_slide_ratio:.0%}")
    return "；".join(parts) + "。"


__all__ = ["check_outline", "describe_constraints", "repair"]
