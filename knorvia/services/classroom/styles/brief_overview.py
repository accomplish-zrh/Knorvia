"""讲义速览 (brief-overview) style — few dense handout cards + a closing quiz."""

from __future__ import annotations

from knorvia.services.classroom.styles.base import OutlineConstraints, StyleSpec

BRIEF_OVERVIEW = StyleSpec(
    id="brief-overview",
    title="讲义速览",
    title_en="Brief Overview",
    description="3-5 页高密度讲义卡片，一页讲透一层，最后以测验收尾。",
    description_en=(
        "3-5 dense handout-style cards, one layer per card, closed by a quiz."
    ),
    prompt_text=(
        "教学风格：讲义速览。像一份高密度讲义式微课：\n"
        "- 总页数少：3-5 页内容卡片，每页信息量大但结构清晰（定义 → 要点 → 一个例子）。\n"
        "- 不设讨论环节的铺陈与寒暄，直入主题；每页 objective 一句话说清这页解决什么。\n"
        "- key_points 为压缩过的干货句，宁精勿多。\n"
        "- 最后以一页 quiz 收尾，检验整份讲义的掌握度。"
    ),
    constraints=OutlineConstraints(
        scene_count_min=3,
        scene_count_max=6,
        first_scene_type="slide",
        quiz_min=1,
        quiz_max=2,
        discussion_min=0,
        discussion_max=1,
    ),
)
