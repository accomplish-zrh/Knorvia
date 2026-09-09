"""Chat capability — production turns run on knorvia-daemon."""

from __future__ import annotations

from knorvia.core.capability_protocol import BaseCapability, CapabilityManifest
from knorvia.core.context import UnifiedContext
from knorvia.runtime.request_contracts import get_capability_request_schema


class ChatCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="chat",
        description=(
            "Chat turns are executed by knorvia-daemon (Knorvia Protocol), "
            "not the legacy Python agent loop."
        ),
        stages=["responding"],
        tools_used=("web_search", "rag", "read_memory"),
        cli_aliases=["chat"],
        request_schema=get_capability_request_schema("chat"),
    )

    async def run(self, context: UnifiedContext, stream: object) -> None:
        from knorvia.runtime.kernel_client import stream_as_stream_events

        async for event in stream_as_stream_events(str(context.user_message or "")):
            emit = getattr(stream, "emit", None)
            if callable(emit):
                await emit(event)
