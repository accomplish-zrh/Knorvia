"""Core contracts shared across runtime, tools, and capabilities."""

from .capability_protocol import BaseCapability, CapabilityManifest
from .context import Attachment, UnifiedContext
from .tool_protocol import (
    BaseTool,
    ToolAlias,
    ToolDefinition,
    ToolParameter,
    ToolPromptHints,
    ToolResult,
)
from .trace import build_trace_metadata, merge_trace_metadata, new_call_id

__all__ = [
    "new_call_id",
    "build_trace_metadata",
    "merge_trace_metadata",
    "BaseTool",
    "ToolAlias",
    "ToolDefinition",
    "ToolParameter",
    "ToolPromptHints",
    "ToolResult",
    "BaseCapability",
    "CapabilityManifest",
    "UnifiedContext",
    "Attachment",
]
