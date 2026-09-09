"""Deep Question Capability.

Production turns invoke the ``learning.mastery`` pack on knorvia-daemon.
``QuestionPipeline`` / mimic helpers remain as a domain library (see
``knorvia/agents/question/pipeline.py``) and are not the Agent Runtime.
"""

from __future__ import annotations

from typing import Any

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import get_capability_request_schema


class DeepQuestionCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_question",
        description="Fast question generation (Template batches -> Generate).",
        stages=["ideation", "generation"],
        tools_used=["rag", "web_search", "code_execution"],
        cli_aliases=["quiz"],
        request_schema=get_capability_request_schema("deep_question"),
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        # Lazy import: tests patch the pack emission at its home module.
        from knorvia.runtime.kernel_client import emit_pack_on_stream

        overrides = dict(context.config_overrides or {})
        topic = str(
            overrides.get("topic") or context.user_message or ""
        ).strip()
        extra: dict[str, Any] = {
            "topic": topic,
            "num_questions": overrides.get("num_questions"),
            "difficulty": overrides.get("difficulty"),
            "question_types": overrides.get("question_types"),
            "mode": overrides.get("mode"),
            "enabled_tools": list(context.enabled_tools or []),
            "kb_name": (context.knowledge_bases or [None])[0]
            if context.knowledge_bases
            else None,
            "followup": context.metadata.get("question_followup_context"),
        }
        await emit_pack_on_stream(
            stream,
            source=self.name,
            pack_id="learning.mastery",
            user_message=topic,
            extra=extra,
        )


__all__ = ["DeepQuestionCapability"]
