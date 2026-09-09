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

SCENE_TYPES = ("slide", "quiz", "discussion", "interactive")
AGENT_ROLES = ("teacher", "classmate")
QUESTION_TYPES = ("single", "multiple", "short")
WIDGET_TYPES = ("simulation", "diagram")
DIAGRAM_TYPES = ("flow", "hierarchy")
ACTION_SPEECH = "speech"
ACTION_QUIZ = "quiz_trigger"
ACTION_DISCUSSION = "discussion"

# OpenMAIC's resource discipline: keep a lesson tight — at most two
# interactive beats (quizzes count) and one discussion marker per lesson
# beyond the closing one. Enforced at outline time by the generator.
MAX_QUIZ_SCENES = 2
MAX_DISCUSSION_SCENES = 1
MAX_INTERACTIVE_SCENES = 2


@dataclass
class WidgetNode:
    """One diagram node (``parent_id`` references another node's id)."""

    id: str
    label: str
    parent_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "parent_id": self.parent_id}


@dataclass
class WidgetOutline:
    """Structured spec of an interactive widget, fixed at outline time.

    simulation — the learner drags real inputs bound to *key_variables* and
    watches a live redraw; diagram — clickable nodes highlight their path.
    """

    widget_type: str = "simulation"
    concept: str = ""
    key_variables: list[str] = field(default_factory=list)  # simulation, >= 2
    diagram_type: str = ""  # diagram: flow | hierarchy
    nodes: list[WidgetNode] = field(default_factory=list)  # diagram, >= 3

    def validate(self) -> list[str]:
        """Deterministic well-formedness problems (empty = valid)."""
        problems: list[str] = []
        if self.widget_type not in WIDGET_TYPES:
            problems.append(f"widget_type '{self.widget_type}' not in {list(WIDGET_TYPES)}")
        if not self.concept.strip():
            problems.append("concept is empty")
        if self.widget_type == "simulation" and len(self.key_variables) < 2:
            problems.append("simulation needs >= 2 key_variables")
        if self.widget_type == "diagram":
            if self.diagram_type not in DIAGRAM_TYPES:
                problems.append(
                    f"diagram_type '{self.diagram_type}' not in {list(DIAGRAM_TYPES)}"
                )
            if len(self.nodes) < 3:
                problems.append("diagram needs >= 3 nodes")
        return problems

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "widget_type": self.widget_type,
            "concept": self.concept,
        }
        if self.widget_type == "simulation":
            data["key_variables"] = list(self.key_variables)
        if self.widget_type == "diagram":
            data["diagram_type"] = self.diagram_type
            data["nodes"] = [node.to_dict() for node in self.nodes]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WidgetOutline":
        if not isinstance(data, dict):
            return cls()
        widget_type = str(data.get("widget_type") or "simulation")
        nodes = [
            WidgetNode(
                id=str(node.get("id") or f"n{index + 1}"),
                label=str(node.get("label") or ""),
                parent_id=str(node.get("parent_id") or ""),
            )
            for index, node in enumerate(data.get("nodes") or [])
            if isinstance(node, dict)
        ]
        return cls(
            widget_type=widget_type if widget_type in WIDGET_TYPES else "simulation",
            concept=str(data.get("concept") or ""),
            key_variables=[str(v) for v in (data.get("key_variables") or [])][:6],
            diagram_type=str(data.get("diagram_type") or ""),
            nodes=nodes[:12],
        )


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
    type: str  # slide | quiz | discussion | interactive
    title: str
    key_points: list[str] = field(default_factory=list)
    objective: str = ""
    minutes: int = 3
    order: int = 0
    widget: WidgetOutline | None = None  # interactive scenes only

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "key_points": list(self.key_points),
            "objective": self.objective,
            "minutes": self.minutes,
            "order": self.order,
            "widget": self.widget.to_dict() if self.widget else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SceneOutline":
        widget_data = data.get("widget")
        return cls(
            id=str(data.get("id") or ""),
            type=str(data.get("type") or "slide"),
            title=str(data.get("title") or ""),
            key_points=[str(k) for k in (data.get("key_points") or [])][:6],
            objective=str(data.get("objective") or ""),
            minutes=max(1, min(30, int(data.get("minutes") or 3))),
            order=int(data.get("order") or 0),
            widget=WidgetOutline.from_dict(widget_data)
            if isinstance(widget_data, dict)
            else None,
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
    type: str  # slide | quiz | discussion | interactive
    title: str = ""
    key_points: list[str] = field(default_factory=list)
    objective: str = ""
    actions: list[dict[str, Any]] = field(default_factory=list)
    questions: list[QuizQuestion] = field(default_factory=list)
    # Interactive scenes: the sanitized self-contained widget + narration
    # points (empty for every other scene type).
    html: str = ""
    narration: list[str] = field(default_factory=list)
    widget: WidgetOutline | None = None

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
            "html": self.html,
            "narration": list(self.narration),
            "widget": self.widget.to_dict() if self.widget else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Scene":
        stype = str(data.get("type") or "slide")
        if stype not in SCENE_TYPES:
            stype = "slide"
        widget_data = data.get("widget")
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
            html=str(data.get("html") or ""),
            narration=[str(n) for n in (data.get("narration") or [])][:8],
            widget=WidgetOutline.from_dict(widget_data)
            if isinstance(widget_data, dict)
            else None,
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
    # Teaching-style skill pack id ("" = the default, unstyled behavior).
    style_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "topic": self.topic,
            "language": self.language,
            "created_at": self.created_at,
            "version": self.version,
            "style_id": self.style_id,
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
            style_id=str(data.get("style_id") or ""),
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
    "DIAGRAM_TYPES",
    "MAX_DISCUSSION_SCENES",
    "MAX_INTERACTIVE_SCENES",
    "MAX_QUIZ_SCENES",
    "QuizQuestion",
    "SCENE_TYPES",
    "Scene",
    "SceneOutline",
    "WIDGET_TYPES",
    "WidgetNode",
    "WidgetOutline",
    "classmates",
    "make_action",
    "new_classroom_id",
    "teacher",
]
