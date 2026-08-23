"""
Agents Module - Unified agent system for Knorvia.

This module provides a unified BaseAgent class and module-specific agents:
- research: Deep research agents (DecomposeAgent, ResearchAgent, etc.)
- question: Question generation agents (ReAct architecture, separate base)
- chat: ``AgenticChatPipeline`` — single-loop chat on the agentic engine
  (Deep Solve also runs here, via the solve loop capability)

Note: ``co_writer`` and ``book`` are independent top-level modules under
``knorvia/`` (e.g. ``knorvia.co_writer``, ``knorvia.book``). They
still inherit from :class:`BaseAgent` defined here but are not part of
the ``knorvia.agents`` package.

Usage:
    from knorvia.agents.base_agent import BaseAgent

    class MyAgent(BaseAgent):
        async def process(self, *args, **kwargs):
            ...
"""

from importlib import import_module

__all__ = ["BaseAgent", "ChatAgent", "SessionManager"]


def __getattr__(name: str):
    if name == "BaseAgent":
        value = import_module(f"{__name__}.base_agent").BaseAgent
    elif name in {"ChatAgent", "SessionManager"}:
        value = getattr(import_module(f"{__name__}.chat"), name)
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    globals()[name] = value
    return value
