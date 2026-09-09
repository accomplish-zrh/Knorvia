"""Math animator capability — Manim animation turns on the media pack.

The domain pipeline (concept analysis → design → code generation → retry →
summary → render, with the Manim subprocess) runs inside the supervised
Python media worker as the ``media.manim`` pack; the capability checks the
optional dependency and streams the pack outcome.
"""

from __future__ import annotations

import importlib.util

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import get_capability_request_schema


class MathAnimatorCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="math_animator",
        description="Generate math animations or storyboard images with Manim.",
        stages=[
            "concept_analysis",
            "concept_design",
            "code_generation",
            "code_retry",
            "summary",
            "render_output",
        ],
        tools_used=[],
        cli_aliases=["animate"],
        request_schema=get_capability_request_schema("math_animator"),
        config_defaults={
            "output_mode": "video",
            "quality": "medium",
            "style_hint": "",
        },
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        # Lazy import: tests patch the pack emission at its home module.
        from knorvia.runtime.kernel_client import emit_pack_on_stream

        if importlib.util.find_spec("manim") is None:
            raise RuntimeError(
                "math_animator requires optional dependencies. "
                "Install with `pip install 'knorvia[math-animator]'` "
                "or `pip install -r requirements/math-animator.txt`."
            )
        await emit_pack_on_stream(
            stream,
            source=self.name,
            pack_id="media.manim",
            user_message=str(context.user_message or ""),
            extra={
                "language": context.language,
                "config_overrides": dict(context.config_overrides or {}),
            },
        )


__all__ = ["MathAnimatorCapability"]
