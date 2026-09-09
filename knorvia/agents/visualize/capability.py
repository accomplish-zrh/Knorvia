"""Visualize Capability — visualization turns on the media pack.

The domain pipeline (analysis → generate → review, plus the Manim subprocess
path) runs inside the supervised Python media worker as the
``media.visualize`` pack; the capability only validates the request params
and streams the pack outcome. The WorkerStream shim inside the media worker
translates the pipeline's stage/progress/thinking events into worker progress
notifications, and the final envelope (render_type + code) comes back as the
render result for the daemon to publish as an artifact.
"""

from __future__ import annotations

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import (
    get_capability_request_schema,
    validate_visualize_request_config,
)

# Stages exposed in the manifest (the worker streams a subset per render
# type: the text path covers analyzing/generating/reviewing; the manim path
# covers the manim stages).
_VISUALIZE_STAGES = [
    "analyzing",
    "generating",
    "reviewing",
    "concept_analysis",
    "concept_design",
    "code_generation",
    "code_retry",
    "summary",
    "render_output",
]


class VisualizeCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="visualize",
        description=(
            "Generate SVG, Chart.js, Mermaid, interactive HTML, or Manim "
            "animation/storyboard visualizations on the media pack."
        ),
        stages=_VISUALIZE_STAGES,
        tools_used=[],
        cli_aliases=["visualize", "viz"],
        request_schema=get_capability_request_schema("visualize"),
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        # Lazy import: tests patch the pack emission at its home module.
        from knorvia.runtime.kernel_client import emit_pack_on_stream

        request_config = validate_visualize_request_config(context.config_overrides)
        await emit_pack_on_stream(
            stream,
            source=self.name,
            pack_id="media.visualize",
            user_message=str(context.user_message or ""),
            extra={
                "render_mode": request_config.render_mode,
                "language": context.language,
                "history_context": str(
                    context.metadata.get("conversation_context_text", "") or ""
                ).strip(),
            },
        )


__all__ = ["VisualizeCapability"]
