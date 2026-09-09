"""动手实验 (hands-on) style — mechanism-driven with a quiz after every arc."""

from __future__ import annotations

from knorvia.services.classroom.styles.base import OutlineConstraints, StyleSpec

HANDS_ON = StyleSpec(
    id="hands-on",
    title="动手实验",
    title_en="Hands-on Lab",
    description="围绕可操作机制展开，每个知识弧后一次小测验，学完即练。",
    description_en=(
        "Built around one operable mechanism; a short quiz after every "
        "knowledge arc, practice as you go."
    ),
    prompt_text=(
        "教学风格：动手实验。面向含'机制/变量/过程'的主题，像带实验课一样组织：\n"
        "- 讲解围绕一个可操作的核心机制展开：先说清变量与过程，再给出改变变量后的预期结果。\n"
        "- 每讲完一个知识弧，立即安排一次 quiz 让学习者动手验证；discussion 至多一次，用于复盘易错点。\n"
        "- key_points 写成可操作、可检验的陈述（'调整 X 会如何影响 Y'），不写空泛的形容词。\n"
        "- 场景之间要有明确的动手节奏：讲一步 → 练一步。"
    ),
    constraints=OutlineConstraints(
        scene_count_min=5,
        scene_count_max=12,
        allowed_types=("slide", "quiz", "discussion", "interactive"),
        first_scene_type="slide",
        quiz_min=1,
        quiz_max=3,
        discussion_min=0,
        discussion_max=1,
        no_consecutive_types=("interactive",),
    ),
)
