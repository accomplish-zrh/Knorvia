"""大师讲授 (master-lecture) style — systematic lecturing, sparse checkpoints."""

from __future__ import annotations

from knorvia.services.classroom.styles.base import OutlineConstraints, StyleSpec

MASTER_LECTURE = StyleSpec(
    id="master-lecture",
    title="大师讲授",
    title_en="Master Lecture",
    description="系统讲授型：以讲解页为主、测验低频点缀，命题句要点与旁白长句。",
    description_en=(
        "Systematic lecturing: slide-dominant body, sparse checkpoints, "
        "propositional key points and narration-style lines."
    ),
    prompt_text=(
        "教学风格：大师讲授。像一位沉稳的学科名家做系统讲授：\n"
        "- 正文以讲解型 slide 为主，quiz 只是低频的理解 checkpoints（约每 4-5 页一次）。\n"
        "- 每页 key_points 必须写成完整的命题句（陈述一个事实或论断，如'递归必须有终止条件，否则调用栈会溢出'），"
        "而不是标签词（如'终止条件'）。\n"
        "- 旁白式长句展开讲解，由浅入深、层层推进，结尾落到一个具体例子。\n"
        "- 禁用'太棒了''让我们开始吧'之类的口播套话与空洞的鼓励语。"
    ),
    constraints=OutlineConstraints(
        scene_count_min=4,
        scene_count_max=10,
        first_scene_type="slide",
        quiz_min=0,
        quiz_max=2,
        discussion_min=0,
        discussion_max=1,
        min_slide_ratio=0.7,
    ),
)
