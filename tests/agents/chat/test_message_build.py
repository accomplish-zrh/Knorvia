"""The compressed-history summary must reach the final LLM messages safely.

Regression test: legacy context may still contain a leading ``role: "system"``
summary.  The agentic pipeline must keep its content without granting historical
or model-generated text application-instruction priority.
"""

from __future__ import annotations

from knorvia.agents.chat.agentic_pipeline import AgenticChatPipeline
from knorvia.core.context import UnifiedContext


def test_summary_system_message_reaches_messages_as_untrusted_history() -> None:
    pipeline = AgenticChatPipeline(language="en")
    context = UnifiedContext(
        session_id="s1",
        user_message="next question",
        conversation_history=[
            {"role": "system", "content": "earlier turns summary"},
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
        ],
    )

    messages = pipeline._build_loop_messages(
        context=context,
        enabled_tools=[],
    )

    # The summary rides directly after the main system prompt, before history,
    # but is explicitly demoted to untrusted user-priority data.
    assert messages[1]["role"] == "user"
    assert "untrusted historical data" in str(messages[1]["content"])
    assert "earlier turns summary" in str(messages[1]["content"])
    assert messages[2] == {"role": "user", "content": "old question"}
    # Exactly one summary injection — no duplicates elsewhere.
    summary_count = sum(
        1
        for m in messages[1:]
        if m["role"] == "user" and "earlier turns summary" in str(m["content"])
    )
    assert summary_count == 1


def test_empty_system_entries_still_filtered() -> None:
    pipeline = AgenticChatPipeline(language="en")
    context = UnifiedContext(
        session_id="s1",
        user_message="q",
        conversation_history=[
            {"role": "system", "content": "   "},
            {"role": "user", "content": "old question"},
        ],
    )

    messages = pipeline._build_loop_messages(
        context=context,
        enabled_tools=[],
    )

    assert messages[1] == {"role": "user", "content": "old question"}
