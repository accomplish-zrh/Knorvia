"""Classroom LLM prompt templates.

Adapted from OpenMAIC (MIT, © 2026 THU-MAIC, github.com/THU-MAIC/OpenMAIC):
the three-stage generation shape (outlines → scenes → actions), the director
routing rules (unanswered-student-question escalates to the teacher, role
diversity, no concept repetition), and the student-persona archetypes. The
text is rewritten for Knorvia's structured-card scenes.
"""

from __future__ import annotations

import json
from typing import Any

from knorvia.services.prompt.language import append_language_directive


def outlines_prompt(
    topic: str, minutes: int, language: str, grounding: str = ""
) -> tuple[str, str]:
    """Stage 1 — topic → SceneOutline list (reviewable intermediate)."""
    system = append_language_directive(
        "You are a curriculum designer who turns one topic into a tight, interactive micro-lesson.",
        language,
    )
    grounding_block = ""
    if grounding.strip():
        grounding_block = f"""
Grounding material retrieved from the learner's knowledge base — base the
lesson on THIS material (facts, terms, and scope come from it; do not
invent conflicting content). If it is thin, cover the topic generally:

<kb_grounding>
{grounding[:6000]}
</kb_grounding>
"""
    user = f"""Design a micro-lesson (about {minutes} minutes) on the topic below.
{grounding_block}
Return ONLY a JSON object (no markdown fences):
{{
  "title": "lesson title",
  "outlines": [
    {{
      "id": "s1",
      "type": "slide" | "quiz" | "discussion",
      "title": "scene title",
      "key_points": ["3-5 key points this scene teaches"],
      "objective": "what the learner can do after this scene",
      "minutes": 3
    }}
  ]
}}

Rules (from the OpenMAIC classroom discipline):
- 4 to 7 scenes total. Open with a slide, close with a slide that summarizes.
- At most {2} quiz scenes and at most {1} discussion scene in the whole lesson.
- A quiz outline must say in "objective" what the quiz checks.
- A discussion outline's "objective" is the seed question for the class debate.
- Progress from foundations to application; no scene repeats another's points.

Topic: {topic}
"""
    return system, user


def scene_prompt(
    outline: dict[str, Any],
    agent_list_json: str,
    lesson_title: str,
    language: str,
) -> tuple[str, str]:
    """Stage 2 — one outline → scene content + action timeline.

    Merges OpenMAIC's scene-content and scene-actions stages: the model sees
    the agent roster and must interleave speech actions with the scene's
    interactive elements, using the structured-output protocol
    (speech lines are actions; the card content is data, not prose).
    """
    system = append_language_directive(
        "You write one scene of a multi-agent micro-lesson. The teacher "
        "explains; classmates interject briefly, in character. Output strict "
        "JSON only.",
        language,
    )
    user = f"""Lesson: {lesson_title}
Scene outline:
{json.dumps(outline, ensure_ascii=False, indent=2)}

Classroom members (id | role | name | persona):
{agent_list_json}

Return ONLY a JSON object:
{{
  "title": "scene title",
  "key_points": ["3-5 rendered key points"],
  "objective": "scene objective",
  "questions": [ // ONLY when the outline type is "quiz"
    {{
      "id": "q1",
      "type": "single" | "multiple" | "short",
      "question": "...",
      "options": ["...", "..."],      // single/multiple only, 4 options
      "answer": "0",                  // option index, or comma-separated indexes for multiple, or a reference answer for short
      "analysis": "why the answer is right, 1-2 sentences",
      "points": 1
    }}
  ],
  "actions": [
    // 3-7 actions in speaking order. Speech lines are what the members SAY.
    {{"type": "speech", "agent_id": "<member id>", "text": "..."}},
    // ONLY for quiz scenes: hand the floor to the exercise.
    {{"type": "quiz_trigger"}},
    // ONLY for the discussion scene: open the debate with the seed question.
    {{"type": "discussion", "prompt": "..."}}
  ]
}}

Rules:
- The FIRST action is always the teacher's speech; classmates get at most one
  short interjection each (much shorter than the teacher's lines).
- Speech must teach the key points in order — never narrate the JSON itself,
  never say "on this slide".
- Quiz questions test exactly the outline's objective; exactly 3-4 questions.
- The last action of a discussion scene is its discussion trigger.
"""
    return system, user


DEFAULT_AGENTS: list[dict[str, str]] = [
    {
        "id": "teacher",
        "role": "teacher",
        "name_zh": "林老师",
        "name_en": "Professor Lin",
        "persona_zh": "沉稳亲和的主讲老师,讲解由浅入深,爱用具体例子收尾。",
        "persona_en": "A calm, warm lecturer who builds from basics and closes with a concrete example.",
        "color": "#2563eb",
    },
    {
        "id": "curious",
        "role": "classmate",
        "name_zh": "小问",
        "name_en": "Curio",
        "persona_zh": "好奇宝宝:总在关键处追问一句'为什么'或'如果…会怎样'。",
        "persona_en": "The curious one: always asks one probing 'why' or 'what if' at the crucial point.",
        "color": "#f59e0b",
    },
    {
        "id": "notetaker",
        "role": "classmate",
        "name_zh": "小结",
        "name_en": "Digest",
        "persona_zh": "笔记员:用一两句话把刚讲的内容压缩成要点或口诀。",
        "persona_en": "The notetaker: compresses what was just taught into one or two crisp takeaways.",
        "color": "#10b981",
    },
    {
        "id": "skeptic",
        "role": "classmate",
        "name_zh": "较真",
        "name_en": "Probe",
        "persona_zh": "思考者:低频但高质量,质疑边界条件、指出常见误区。",
        "persona_en": "The skeptic: speaks rarely but sharply — edge cases, common misconceptions.",
        "color": "#ef4444",
    },
]


def default_agent_profiles(language: str) -> list[dict[str, Any]]:
    """Built-in roster (OpenMAIC's default-agent registry, adapted)."""
    zh = language.startswith("zh")
    agents: list[dict[str, Any]] = []
    for spec in DEFAULT_AGENTS:
        agents.append(
            {
                "id": spec["id"],
                "role": spec["role"],
                "name": spec["name_zh"] if zh else spec["name_en"],
                "persona": spec["persona_zh"] if zh else spec["persona_en"],
                "color": spec["color"],
                "priority": 10 if spec["role"] == "teacher" else 5,
            }
        )
    return agents


def director_prompt(
    agent_list_json: str,
    summaries_json: str,
    turn_count: int,
    pending_question: str,
    language: str,
) -> tuple[str, str]:
    """Stateless discussion router (OpenMAIC director-graph parity).

    Picks exactly one next speaker per call; the client loops. Distilled
    rules: an unresolved student question always goes to the teacher; no
    same speaker twice in a row; agents build on — never repeat — what was
    said; the teacher may hand the floor back to the user; the debate ends
    when the seed question is settled.
    """
    system = append_language_directive(
        "You are the director of a classroom debate. Choose WHO speaks next. "
        "Reply with a single line of JSON and nothing else.",
        language,
    )
    user = f"""Members:
{agent_list_json}

Who has spoken so far (summary + turn):
{summaries_json}

Debate turn count: {turn_count}
Pending unresolved learner question: {pending_question or "(none)"}

Return exactly one of:
{{"next_agent": "<member id>"}}
{{"next_agent": "USER"}}   // only when a member asked the learner a direct question
{{"next_agent": "END"}}    // when the seed question has been answered and summarized

Rules:
1. If the learner's question is still unresolved, the TEACHER must speak next.
2. Never pick the member who spoke last.
3. Classmates must ADD something (a doubt, an example, a summary) — never
   restate another member's point.
4. Keep debates short: prefer END once the teacher has answered and one
   classmate has summarized.
"""
    return system, user


def classmate_speech_prompt(
    profile: dict[str, Any],
    scene_context: str,
    transcript_json: str,
    quiz_results_json: str,
    user_message: str,
    language: str,
) -> tuple[str, str]:
    """One classmate/teacher turn in a live discussion (OpenMAIC agent-system).

    User-turn-first discipline: the learner's latest message outranks
    continuing the debate; answer it directly in the first sentence.
    """
    system = append_language_directive(
        "You are one member of a classroom debate, speaking IN CHARACTER. "
        "Reply with your spoken line only — no stage directions, no name "
        "prefix, no JSON.",
        language,
    )
    user = f"""Your identity: {json.dumps(profile, ensure_ascii=False)}
What this scene is about: {scene_context}
Transcript so far:
{transcript_json}
Recent quiz results of the learner (address mistakes if relevant):
{quiz_results_json or "(none)"}

Responding to the learner's turn: {user_message or "(continue the debate)"}

Rules:
- If the learner said something, your FIRST sentence answers them directly.
- Stay far shorter than the teacher's lecture lines; classmates are students.
- If you need the learner to clarify something vague, ask exactly one
  concrete question.
"""
    return system, user


__all__ = [
    "DEFAULT_AGENTS",
    "classmate_speech_prompt",
    "default_agent_profiles",
    "director_prompt",
    "outlines_prompt",
    "scene_prompt",
]
