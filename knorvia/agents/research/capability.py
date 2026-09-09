"""Deep Research capability — production path is knorvia-daemon Pack.

The Python ``ResearchPipeline`` remains in-tree as a domain library. Live
turns invoke the ``research.knowledge`` pack on knorvia-daemon instead of
``run_agentic_loop``.
"""

from __future__ import annotations

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import get_capability_request_schema


class DeepResearchCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_research",
        description="Deep research via knorvia-daemon research.knowledge pack.",
        stages=["researching"],
        tools_used=["rag", "web_search", "paper_search"],
        cli_aliases=["research"],
        request_schema=get_capability_request_schema("deep_research"),
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        from knorvia.runtime.kernel_client import emit_pack_on_stream

        overrides = dict(context.config_overrides or {})
        query = str(overrides.get("topic") or context.user_message or "").strip()
        extra = {
            "query": query,
            "kb_name": (context.knowledge_bases or [None])[0]
            if context.knowledge_bases
            else None,
            "enabled_tools": list(context.enabled_tools or []),
            "corpus": overrides.get("corpus"),
            "confirmed_outline": overrides.get("confirmed_outline"),
            "depth": overrides.get("depth"),
            "mode": overrides.get("mode"),
        }
        await emit_pack_on_stream(
            stream,
            source=self.name,
            pack_id="research.knowledge",
            user_message=query,
            extra=extra,
        )
