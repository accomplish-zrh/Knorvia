"""Classroom document model — an OpenMAIC-inspired interactive lesson.

The three-stage shape (outlines → scenes → actions) and the agent-profile
registry are adapted from OpenMAIC (MIT, © 2026 THU-MAIC,
github.com/THU-MAIC/OpenMAIC), simplified to Knorvia's structured-card
surfaces: a scene is a titled key-point card, a quiz, or a discussion
marker — not a full slide editor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any
import uuid

SCENE_TYPES = ("slide", "quiz", "discussion")
AGENT_ROLES = ("teacher", "classmate")
QUESTION_TYPES = ("single", "multiple", "short")
ACTION_SPEECH = "speech"
ACTION_QUIZ = "quiz_trigger"
ACTION_DISCUSSION = "discussion"

# OpenMAIC's resource discipline: keep a lesson tight — at most two
# interactive beats (quizzes count) and one discussion marker per lesson
# beyond the closing one. Enforced at outline time by the generator.
MAX_QUIZ_SCENES = 2
MAX_DISCUSSION_SCENES = 1


@dataclass
class AgentProfile:
    """One classroom member: role-scoped persona + allowed actions."""

    id: str
    name: str
    role: str  # teacher | classmate
    persona: str = ""
    color: str = "#3b82f6"
    # Role-scoped capability (OpenMAIC parity): classmates may not drive the
    # lesson forward, only speak.
    allowed_actions: list[str] = field(default_factory=lambda: [ACTION_SPEECH])
    priority: int = 5

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "persona": self.persona,
            "color": self.color,
            "allowed_actions": list(self.allowed_actions),
            "priority": self.priority,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentProfile":
        return cls(
            id=str(data.get("id") or ""),
            name=str(data.get("name") or ""),
            role=str(data.get("role") or "classmate"),
            persona=str(data.get("persona") or ""),
            color=str(data.get("color") or "#3b82f6"),
            allowed_actions=[str(a) for a in (data.get("allowed_actions") or [ACTION_SPEECH])],
            priority=int(data.get("priority") or 5),
        )


@dataclass
class SceneOutline:
    """The reviewable intermediate product (generated before scenes)."""

    id: str
    type: str  # slide | quiz | discussion
    title: str
    key_points: list[str] = field(default_factory=list)
    objective: str = ""
    minutes: int = 3
    order: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "key_points": list(self.key_points),
            "objective": self.objective,
            "minutes": self.minutes,
            "order": self.order,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SceneOutline":
        return cls(
            id=str(data.get("id") or ""),
            type=str(data.get("type") or "slide"),
            title=str(data.get("title") or ""),
            key_points=[str(k) for k in (data.get("key_points") or [])][:6],
            objective=str(data.get("objective") or ""),
            minutes=max(1, min(30, int(data.get("minutes") or 3))),
            order=int(data.get("order") or 0),
        )


@dataclass
class QuizQuestion:
    id: str
    type: str  # single | multiple | short
    question: str
    options: list[str] = field(default_factory=list)
    answer: str = ""  # option index ("0") / comma indexes / reference answer
    analysis: str = ""
    points: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "question": self.question,
            "options": list(self.options),
            "answer": self.answer,
            "analysis": self.analysis,
            "points": self.points,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "QuizQuestion":
        qtype = str(data.get("type") or "single")
        if qtype not in QUESTION_TYPES:
            qtype = "single"
        return cls(
            id=str(data.get("id") or ""),
            type=qtype,
            question=str(data.get("question") or ""),
            options=[str(o) for o in (data.get("options") or [])][:6],
            answer=str(data.get("answer") or ""),
            analysis=str(data.get("analysis") or ""),
            points=max(1, min(10, int(data.get("points") or 1))),
        )


def make_action(kind: str, **params: Any) -> dict[str, Any]:
    """One timeline action: ``{type, …params}`` (OpenMAIC action parity)."""
    action = {"type": kind}
    action.update(params)
    return action


@dataclass
class Scene:
    id: str
    order: int
    type: str  # slide | quiz | discussion
    title: str = ""
    key_points: list[str] = field(default_factory=list)
    objective: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    questions: list[QuizQuestion] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "order": self.order,
            "type": self.type,
            "title": self.title,
            "key_points": list(self.key_points),
            "objective": self.objective,
            "actions": list(self.actions),
            "questions": [q.to_dict() for q in self.questions],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Scene":
        stype = str(data.get("type") or "slide")
        if stype not in SCENE_TYPES:
            stype = "slide"
        return cls(
            id=str(data.get("id") or ""),
            order=int(data.get("order") or 0),
            type=stype,
            title=str(data.get("title") or ""),
            key_points=[str(k) for k in (data.get("key_points") or [])][:6],
            objective=str(data.get("objective") or ""),
            actions=[a for a in (data.get("actions") or []) if isinstance(a, dict)],
            questions=[
                QuizQuestion.from_dict(q)
                for q in (data.get("questions") or [])
                if isinstance(q, dict)
            ],
        )


@dataclass
class ClassroomDocument:
    id: str
    title: str
    topic: str
    language: str = "zh"
    created_at: float = 0.0
    agent_profiles: list[AgentProfile] = field(default_factory=list)
    outlines: list[SceneOutline] = field(default_factory=list)
    scenes: list[Scene] = field(default_factory=list)
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "topic": self.topic,
            "language": self.language,
            "created_at": self.created_at,
            "version": self.version,
            "agent_profiles": [a.to_dict() for a in self.agent_profiles],
            "outlines": [o.to_dict() for o in self.outlines],
            "scenes": [s.to_dict() for s in self.scenes],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ClassroomDocument":
        return cls(
            id=str(data.get("id") or ""),
            title=str(data.get("title") or ""),
            topic=str(data.get("topic") or ""),
            language=str(data.get("language") or "zh"),
            created_at=float(data.get("created_at") or 0.0),
            version=int(data.get("version") or 1),
            agent_profiles=[
                AgentProfile.from_dict(a)
                for a in (data.get("agent_profiles") or [])
                if isinstance(a, dict)
            ],
            outlines=[
                SceneOutline.from_dict(o)
                for o in (data.get("outlines") or [])
                if isinstance(o, dict)
            ],
            scenes=[Scene.from_dict(s) for s in (data.get("scenes") or []) if isinstance(s, dict)],
        )


def new_classroom_id(topic: str) -> str:
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", topic.lower()).strip("-")[:32]
    return f"{slug or 'lesson'}-{uuid.uuid4().hex[:8]}"


def teacher(doc: ClassroomDocument) -> AgentProfile | None:
    for profile in doc.agent_profiles:
        if profile.role == "teacher":
            return profile
    return doc.agent_profiles[0] if doc.agent_profiles else None


def classmates(doc: ClassroomDocument) -> list[AgentProfile]:
    return [p for p in doc.agent_profiles if p.role == "classmate"]


__all__ = [
    "ACTION_DISCUSSION",
    "ACTION_QUIZ",
    "ACTION_SPEECH",
    "AGENT_ROLES",
    "AgentProfile",
    "ClassroomDocument",
    "MAX_DISCUSSION_SCENES",
    "MAX_QUIZ_SCENES",
    "QuizQuestion",
    "SCENE_TYPES",
    "Scene",
    "SceneOutline",
    "classmates",
    "make_action",
    "new_classroom_id",
    "teacher",
]
