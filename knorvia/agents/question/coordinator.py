"""Compatibility adapter for legacy question-generation entry points.

The old ``AgentCoordinator`` implementation was replaced by
``QuestionPipeline``. A few API/tool modules still import the coordinator
name, so this module preserves that surface while delegating all real work
to the new pipeline.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
import inspect
import logging
from pathlib import Path
import time
from types import SimpleNamespace
from typing import Any

from knorvia.agents.question.mimic_source import parse_exam_paper_to_templates
from knorvia.agents.question.pipeline import QuestionPipeline
from knorvia.core.context import UnifiedContext
from knorvia.services.path_service import get_path_service
from knorvia.services.settings.interface_settings import get_response_language

logger = logging.getLogger(__name__)

WsCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


def _event(**kwargs: Any) -> Any:
    """Duck-typed stream event with the StreamEvent attribute + to_dict surface."""
    base: dict[str, Any] = {
        "type": "",
        "source": "",
        "stage": "",
        "content": "",
        "metadata": {},
        "session_id": "",
        "turn_id": "",
        "seq": 0,
        "timestamp": time.time(),
    }
    base.update(kwargs)
    event = SimpleNamespace(**base)

    def to_dict() -> dict[str, Any]:
        return {
            "type": event.type,
            "source": event.source,
            "stage": event.stage,
            "content": event.content,
            "metadata": event.metadata,
            "session_id": event.session_id,
            "turn_id": event.turn_id,
            "seq": event.seq,
            "timestamp": event.timestamp,
        }

    event.to_dict = to_dict  # type: ignore[method-assign]
    return event


class _CoordinatorStream:
    """Local WebSocket bridge for the legacy coordinator facade.

    Duck-typed stand-in for the legacy stream bus: the pipeline emits via the
    stage/content/thinking/progress/error surface, this class queues plain
    events and the forwarder drains them to the WebSocket callback.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._closed = False

    async def _put(self, event: dict[str, Any]) -> None:
        if not self._closed:
            await self._queue.put(event)

    async def _emit(self, etype: str, **kwargs: Any) -> None:
        await self._put({**_event(type=etype, **kwargs).to_dict()})

    async def content(self, message: str, source: str = "", stage: str = "", **_: Any) -> None:
        await self._emit("content", content=message, source=source, stage=stage)

    async def thinking(self, message: str, source: str = "", stage: str = "", **_: Any) -> None:
        await self._emit("thinking", content=message, source=source, stage=stage)

    async def progress(self, message: str = "", source: str = "", stage: str = "", **_: Any) -> None:
        await self._emit("progress", content=message, source=source, stage=stage)

    async def error(self, message: str, source: str = "", stage: str = "", **_: Any) -> None:
        await self._emit("error", content=message, source=source, stage=stage)

    async def result(self, data: dict[str, Any], source: str = "", **_: Any) -> None:
        await self._emit("result", metadata=dict(data), source=source)

    def stage(self, name: str, source: str = "", **_: Any) -> "_CoordinatorStreamStage":
        return _CoordinatorStreamStage(self, name, source)

    def subscribe(self) -> AsyncIterator[dict[str, Any]]:
        async def _iterate() -> AsyncIterator[dict[str, Any]]:
            while True:
                event = await self._queue.get()
                if event is None:
                    return
                yield event

        return _iterate()

    async def close(self) -> None:
        self._closed = True
        await self._queue.put(None)


class _CoordinatorStreamStage:
    """Async context manager emitting stage_start / stage_end markers."""

    def __init__(self, owner: _CoordinatorStream, name: str, source: str) -> None:
        self._owner = owner
        self._name = name
        self._source = source

    async def __aenter__(self) -> "_CoordinatorStreamStage":
        await self._owner._emit("stage_start", stage=self._name, source=self._source)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._owner._emit("stage_end", stage=self._name, source=self._source)


class AgentCoordinator:
    """Legacy facade backed by :class:`QuestionPipeline`.

    New code should prefer ``DeepQuestionCapability`` or ``QuestionPipeline``
    directly. This class exists so older WebSocket routes and the
    ``tools.question.exam_mimic`` helper keep importing and running.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        api_version: str | None = None,
        kb_name: str | None = None,
        language: str | None = None,
        output_dir: str | None = None,
        enabled_tools: list[str] | None = None,
        enable_idea_rag: bool | None = None,
    ) -> None:
        # The new pipeline reads provider settings from the shared config
        # service. Keep these attributes only for compatibility/debugging.
        self.api_key = api_key
        self.base_url = base_url
        self.api_version = api_version
        self.kb_name = (kb_name or "").strip() or None
        self.enable_idea_rag = True if enable_idea_rag is None else bool(enable_idea_rag)
        self.language = language or get_response_language(default="en")
        self.output_dir = output_dir
        self.enabled_tools = list(enabled_tools or [])
        self._ws_callback: WsCallback | None = None

    def set_ws_callback(self, callback: WsCallback | None) -> None:
        self._ws_callback = callback

    async def generate_from_topic(
        self,
        *,
        user_topic: str,
        num_questions: int = 1,
        difficulty: str = "",
        question_types: list[str] | None = None,
        per_type_counts: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        """Generate a quiz from a topic using the new pipeline."""

        context = self._build_context(user_message=user_topic)
        pipeline = self._build_pipeline()
        stream = self._new_stream_bus()
        result = await self._run_with_forwarding(
            stream,
            pipeline.run(
                context=context,
                user_message=user_topic,
                num_questions=max(1, int(num_questions or 1)),
                difficulty=difficulty,
                question_types=question_types or [],
                per_type_counts=per_type_counts or {},
                stream=stream,
            ),
        )
        return self._legacy_summary(result)

    async def generate_from_exam(
        self,
        *,
        exam_paper_path: str,
        max_questions: int = 10,
        paper_mode: str = "upload",
    ) -> dict[str, Any]:
        """Generate mimic questions from an uploaded PDF or parsed paper dir."""

        paper_path = str(exam_paper_path or "").strip()
        if not paper_path:
            return {"success": False, "error": "exam_paper_path is required."}

        try:
            await self._emit_callback(
                {
                    "type": "status",
                    "stage": "parsing",
                    "content": "Extracting question templates from exam paper...",
                }
            )
            output_dir = self._resolve_output_dir()
            templates, trace = await parse_exam_paper_to_templates(
                paper_path,
                max_questions=max(1, int(max_questions or 1)),
                paper_mode=paper_mode,
                output_dir=output_dir,
            )
            if not templates:
                return {
                    "success": False,
                    "error": "No questions could be extracted from the exam paper.",
                    "template_count": 0,
                    "results": [],
                    "trace": trace,
                }

            context = self._build_context(user_message="Mimic this exam paper")
            pipeline = self._build_pipeline()
            stream = self._new_stream_bus()
            result = await self._run_with_forwarding(
                stream,
                pipeline.run(
                    context=context,
                    user_message=context.user_message,
                    num_questions=len(templates),
                    templates_override=templates,
                    stream=stream,
                ),
            )
            summary = self._legacy_summary(result)
            summary["trace"] = trace
            return summary
        except Exception as exc:
            logger.exception("Legacy AgentCoordinator.generate_from_exam failed: %s", exc)
            return {"success": False, "error": str(exc), "results": []}

    def _build_context(self, *, user_message: str) -> UnifiedContext:
        kb_name = self._active_kb_name()
        return UnifiedContext(
            session_id=self._session_id(),
            user_message=user_message,
            enabled_tools=self.enabled_tools,
            active_capability="deep_question",
            knowledge_bases=[kb_name] if kb_name else [],
            language=self.language,
        )

    def _build_pipeline(self) -> QuestionPipeline:
        return QuestionPipeline(
            language=self.language,
            kb_name=self._active_kb_name(),
            enabled_tools=self.enabled_tools,
        )

    def _active_kb_name(self) -> str | None:
        return self.kb_name if self.enable_idea_rag else None

    def _new_stream_bus(self) -> Any:
        return _CoordinatorStream()

    async def _run_with_forwarding(
        self,
        stream: Any,
        pipeline_call: Awaitable[dict[str, Any]],
    ) -> dict[str, Any]:
        """Run a pipeline coroutine and forward its stream events if possible."""

        forwarder = asyncio.create_task(self._forward_stream(stream))
        try:
            return await pipeline_call
        finally:
            await stream.close()
            try:
                await forwarder
            except Exception:
                logger.debug("Question stream forwarding task failed", exc_info=True)

    async def _forward_stream(self, stream: Any) -> None:
        async for event in stream.subscribe():
            await self._emit_callback(self._event_payload(event))

    @staticmethod
    def _event_payload(event: Any) -> dict[str, Any]:
        payload = event.to_dict()
        if event.type == "result":
            payload.setdefault("content", event.metadata.get("response", ""))
        return payload

    async def _emit_callback(self, payload: dict[str, Any]) -> None:
        if self._ws_callback is None:
            return
        maybe_awaitable = self._ws_callback(payload)
        if inspect.isawaitable(maybe_awaitable):
            await maybe_awaitable

    def _resolve_output_dir(self) -> Path:
        if self.output_dir:
            return Path(self.output_dir)
        return get_path_service().get_question_dir() / "mimic_papers"

    def _session_id(self) -> str:
        if self.output_dir:
            return Path(self.output_dir).name or "legacy-question"
        return "legacy-question"

    @staticmethod
    def _legacy_summary(result: dict[str, Any]) -> dict[str, Any]:
        summary = dict(result.get("summary") or {})
        if not summary:
            summary["success"] = False
            summary["results"] = []
        summary.setdefault("response", result.get("response", ""))
        summary.setdefault("mode", result.get("mode", "custom"))
        if "metadata" in result:
            summary.setdefault("metadata", result["metadata"])
        summary.setdefault("results", [])
        for item in summary["results"]:
            if isinstance(item, dict) and "success" not in item:
                metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
                item["success"] = not bool(metadata.get("error"))
        summary.setdefault("requested", summary.get("template_count", 0))
        summary.setdefault("completed", 0)
        summary.setdefault("failed", 0)
        summary.setdefault("success", bool(summary.get("completed")))
        return summary


__all__ = ["AgentCoordinator"]
