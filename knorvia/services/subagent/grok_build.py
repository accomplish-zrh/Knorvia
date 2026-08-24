"""Grok Build backend — drive the local ``grok`` CLI in headless print mode.

Uses ``grok -p <question> --output-format streaming-json``: the native
newline-delimited ACP session stream (``text``, ``thought``, ``tool_call``,
``tool_call_update``, ``end``). Mapped onto :class:`SubagentEvent` so the
sidebar shows the same live run the user would see in the Grok Build TUI.

Auth and config are inherited automatically: the spawned ``grok`` reads the
user's existing ``~/.grok`` credentials and settings, so no token is ever
handled here.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from knorvia.services.subagent.base import OnEvent, SubagentBackend
from knorvia.services.subagent.config import BackendConfig
from knorvia.services.subagent.detect_fallback import enhanced_detail
from knorvia.services.subagent.process import probe_version, stream_process_lines
from knorvia.services.subagent.types import (
    EVENT_ERROR,
    EVENT_LOG,
    EVENT_REASONING,
    EVENT_TEXT,
    EVENT_TOOL,
    EVENT_TOOL_RESULT,
    ConsultResult,
    DetectResult,
    SubagentEvent,
)

logger = logging.getLogger(__name__)

_MAX_FIELD_CHARS = 4000
_TOOL_HEADER_CHARS = 160
_PERMISSION_MODES = frozenset(
    {"default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"}
)
_TOOL_PRIMARY_ARGS = (
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
)


class GrokBuildBackend(SubagentBackend):
    kind = "grok_build"
    display_name = "Grok Build"
    cli_command = "grok"

    async def detect(self) -> DetectResult:
        ok, text = await probe_version([self.cli_command, "--version"])
        ok, detail = enhanced_detail(
            self.cli_command,
            lambda: "grok CLI not found on PATH",
            ok,
            text,
        )
        return DetectResult(
            kind=self.kind,
            display_name=self.display_name,
            available=ok,
            version=text if ok else "",
            detail=detail,
        )

    def _build_command(
        self,
        question: str,
        *,
        session_id: str | None,
        config: BackendConfig,
        images: list[str] | None = None,
    ) -> list[str]:
        prompt = question
        if images:
            listing = "\n".join(images)
            prompt = (
                f"{question}\n\n[The user attached image(s) for this question. "
                f"Read these files before answering:\n{listing}]"
            )
        cmd = [
            self.cli_command,
            "-p",
            prompt,
            "--output-format",
            "streaming-json",
        ]
        if session_id:
            cmd += ["--resume", session_id]
        mode = config.permission_mode if config.permission_mode in _PERMISSION_MODES else "default"
        cmd += ["--permission-mode", mode]
        if mode == "bypassPermissions":
            cmd.append("--always-approve")
        if config.model:
            cmd += ["--model", config.model]
        if config.effort:
            cmd += ["--reasoning-effort", config.effort]
        if config.system_prompt.strip():
            cmd += ["--rules", config.system_prompt.strip()]
        cmd += list(config.extra_args)
        return cmd

    async def consult(
        self,
        question: str,
        *,
        on_event: OnEvent,
        cwd: str | None = None,
        session_id: str | None = None,
        config: BackendConfig | None = None,
        images: list[str] | None = None,
        partner_id: str | None = None,
    ) -> ConsultResult:
        config = config or BackendConfig()
        cmd = self._build_command(question, session_id=session_id, config=config, images=images)
        result = ConsultResult(session_id=session_id)
        stream: dict[str, Any] = {
            "text": "",
            "thought": "",
            "text_idx": 0,
            "thought_idx": 0,
            "saw_text": False,
        }

        async def emit(
            kind: str, text: str, raw: dict[str, Any], meta: dict[str, Any] | None = None
        ) -> None:
            result.event_count += 1
            await on_event(SubagentEvent(kind=kind, text=text, raw=raw, meta=meta or {}))

        try:
            async for channel, line in stream_process_lines(cmd, cwd=cwd):
                if channel == "exit":
                    if line != "0" and result.success and not result.final_text:
                        result.success = False
                        result.error = f"grok exited with code {line}"
                        await emit(EVENT_ERROR, result.error, {"returncode": line})
                    continue
                if channel == "stderr":
                    if line.strip():
                        await emit(EVENT_LOG, line, {"stream": "stderr"})
                    continue
                event = _parse_json(line)
                if event is None:
                    if line.strip():
                        await emit(EVENT_LOG, line, {"stream": "stdout"})
                    continue
                await self._handle_event(event, result, stream, emit)
        except Exception as exc:  # pragma: no cover - defensive: surface, don't crash the turn
            logger.warning("grok consult failed: %s", exc, exc_info=True)
            result.success = False
            result.error = str(exc)
            await emit(EVENT_ERROR, str(exc), {})

        if not result.final_text and stream["text"]:
            result.final_text = str(stream["text"]).strip()
        return result

    async def _handle_event(
        self,
        event: dict[str, Any],
        result: ConsultResult,
        stream: dict[str, Any],
        emit: Any,
    ) -> None:
        sid = event.get("sessionId") or event.get("session_id")
        if isinstance(sid, str) and sid:
            result.session_id = sid
        etype = str(event.get("type") or "")

        if etype == "text":
            chunk = str(event.get("data") or "")
            if not chunk:
                return
            stream["text"] = str(stream["text"]) + chunk
            stream["saw_text"] = True
            await emit(
                EVENT_TEXT,
                str(stream["text"]).strip(),
                event,
                {"merge_id": f"txt:{stream['text_idx']}"},
            )
            return

        if etype == "thought":
            chunk = str(event.get("data") or "")
            if not chunk:
                return
            stream["thought"] = str(stream["thought"]) + chunk
            await emit(
                EVENT_REASONING,
                str(stream["thought"]).strip(),
                event,
                {"merge_id": f"rsn:{stream['thought_idx']}"},
            )
            return

        if etype == "tool_call":
            stream["text_idx"] = int(stream["text_idx"]) + 1
            stream["thought_idx"] = int(stream["thought_idx"]) + 1
            stream["text"] = ""
            stream["thought"] = ""
            await emit(EVENT_TOOL, _render_tool_call(event), event)
            return

        if etype == "tool_call_update":
            status = str(event.get("status") or "")
            if status in ("completed", "failed", "error"):
                await emit(EVENT_TOOL_RESULT, _render_tool_output(event), event)
            return

        if etype == "plan":
            await emit(EVENT_LOG, _compact(event.get("entries") or event), event)
            return

        if etype == "end":
            text = str(event.get("text") or event.get("result") or "").strip()
            if text:
                result.final_text = text
            if str(event.get("stopReason") or event.get("stop_reason") or "") in {
                "error",
                "refusal",
                "cancelled",
            }:
                result.success = False
            if text and not stream.get("saw_text"):
                await emit(EVENT_TEXT, text, event)
            return

        if etype == "error":
            message = str(event.get("message") or "Grok Build error")
            result.success = False
            result.error = message
            await emit(EVENT_ERROR, message, event)
            return

        if etype in {"usage", "available_commands"}:
            return

        await emit(EVENT_LOG, _compact(event), event)


def parse_grok_models(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Parse ``grok models`` human output into (default, [(slug, label), ...])."""
    default = ""
    models: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        lowered = line.lower()
        if lowered.startswith("default model:"):
            default = line.split(":", 1)[1].strip()
            continue
        if line[0] not in "*-":
            continue
        slug = line.lstrip("*- ").split()[0].strip()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        suffix = " · default" if slug == default else ""
        models.append((slug, f"{slug}{suffix}"))
    return default, models


def _parse_json(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line or line[0] not in "{[":
        return None
    try:
        parsed = json.loads(line)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _render_tool_call(event: dict[str, Any]) -> str:
    name = str(event.get("toolName") or event.get("title") or event.get("kind") or "tool")
    raw_input = event.get("rawInput")
    if not isinstance(raw_input, dict) or not raw_input:
        return name
    for key in _TOOL_PRIMARY_ARGS:
        value = raw_input.get(key)
        if isinstance(value, str) and value.strip():
            return f"{name}({_inline(value)})"
    return f"{name}({_inline(_compact(raw_input))})"


def _render_tool_output(event: dict[str, Any]) -> str:
    raw = event.get("rawOutput")
    if isinstance(raw, dict):
        for key in ("output", "content", "text", "result"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return _truncate(value)
        return _truncate(_compact(raw))
    if isinstance(raw, str) and raw.strip():
        return _truncate(raw)
    return "(empty result)"


def _inline(text: str) -> str:
    one_line = " ".join(text.split())
    if len(one_line) > _TOOL_HEADER_CHARS:
        return one_line[:_TOOL_HEADER_CHARS].rstrip() + " …"
    return one_line


def _compact(obj: Any) -> str:
    try:
        text = json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(obj)
    return _truncate(text)


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) > _MAX_FIELD_CHARS:
        return text[:_MAX_FIELD_CHARS].rstrip() + " …"
    return text


__all__ = ["GrokBuildBackend", "parse_grok_models"]
