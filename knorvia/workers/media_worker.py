"""Python media worker: hosts the visualize / math-animator domain pipelines.

Spawned by the daemon for packs whose manifest declares the Python runtime
(``runtime = "python"``). Speaks the framed JSON-RPC worker protocol on stdio
(initialize / render / shutdown, progress notifications, cooperative cancel).
Domain algorithms stay in their agent modules — this file is only the
supervised bridge.

The render handlers run the real pipelines with a :class:`WorkerStream` shim
that translates StreamBus-style events into worker ``progress`` notifications
and captures the final result envelope as the render output. Workers hold no
product-store authority: they render content; the daemon publishes artifacts.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any, Callable

from knorvia.core.context import UnifiedContext


class WorkerCancelled(Exception):
    """Raised when a cooperative cancel lands during a render."""


class WorkerStream:
    """Duck-typed stand-in for StreamBus inside the worker.

    Translates StreamBus-style emissions into worker progress notifications
    and captures the RESULT envelope as the render output.
    """

    def __init__(
        self,
        *,
        emit_step: Callable[[str], None],
        is_cancelled: Callable[[], bool],
    ) -> None:
        self._emit_step = emit_step
        self._is_cancelled = is_cancelled
        self.result_envelope: dict[str, Any] | None = None

    def _check(self, step: str) -> None:
        self._emit_step(step)
        if self._is_cancelled():
            raise WorkerCancelled("cancelled by user")

    async def stage(
        self, name: str, source: str = "", metadata: dict[str, Any] | None = None
    ):
        self._check(f"stage.{name}.start")
        return _WorkerStage(self, name)

    async def content(self, message: str, source: str = "", **kwargs: Any) -> None:
        self._check("content")

    async def thinking(
        self, message: str, source: str = "", stage: str = "", **kwargs: Any
    ) -> None:
        self._check("thinking")

    async def tool_call(
        self, name: str, args: dict[str, Any], source: str = "", **kwargs: Any
    ) -> None:
        self._check("tool_call")

    async def progress(
        self, message: str = "", source: str = "", stage: str = "", **kwargs: Any
    ) -> None:
        self._check("progress")

    async def sources(self, items: list[Any], source: str = "", **kwargs: Any) -> None:
        self._check("sources")

    async def result(
        self,
        data: dict[str, Any],
        source: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._check("result")
        self.result_envelope = dict(data)

    async def error(self, message: str, source: str = "", **kwargs: Any) -> None:
        raise WorkerCancelled(message)


class _WorkerStage:
    """Async context manager mirroring StreamBus.stage()."""

    def __init__(self, worker_stream: WorkerStream, name: str) -> None:
        self._ws = worker_stream
        self._name = name

    async def __aenter__(self) -> "_WorkerStage":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._ws._emit_step(f"stage.{self._name}.end")


def _run_visualize(input_payload: dict[str, Any], stream: WorkerStream) -> dict[str, Any]:
    """Run the visualize domain pipeline (analysis → generate → review)."""
    from knorvia.agents.visualize.pipeline import VisualizePipeline
    from knorvia.agents.visualize.utils import (
        build_fallback_html,
        validate_visualization,
    )
    from knorvia.services.llm.config import get_llm_config

    llm_config = get_llm_config()
    render_mode = str(input_payload.get("render_mode") or "auto")
    history_context = str(input_payload.get("history_context") or "")
    user_message = str(input_payload.get("user_message") or "")
    language = str(input_payload.get("language") or "zh")
    i18n_module = "visualize"

    async def _run() -> dict[str, Any]:
        from knorvia.i18n import StatusI18n

        i18n = StatusI18n("visualize", language, module=i18n_module)
        pipeline = VisualizePipeline(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            api_version=llm_config.api_version,
            language=language,
        )
        await stream.stage("analyzing", source="visualize")
        await stream.progress(
            message=i18n.t(
                "analyzing", "Analyzing visualization requirements..."
            ),
            source="visualize",
            stage="analyzing",
        )
        analysis = await pipeline.run_analysis(
            user_input=user_message,
            history_context=history_context,
            render_mode=render_mode,
        )
        await stream.progress(
            message=i18n.t(
                "render_type_detected",
                f"Render type: {analysis.render_type} — {analysis.description}",
                render_type=analysis.render_type,
                description=analysis.description,
            ),
            source="visualize",
            stage="analyzing",
        )
        await stream.stage("generating", source="visualize")
        await stream.progress(
            message=i18n.t("generating", "Generating visualization code..."),
            source="visualize",
            stage="generating",
        )
        code = await pipeline.run_code_generation(
            user_input=user_message,
            history_context=history_context,
            analysis=analysis,
        )
        await stream.progress(
            message=i18n.t("code_generated", "Code generated."),
            source="visualize",
            stage="generating",
        )
        await stream.stage("reviewing", source="visualize")
        ok, validation_error = validate_visualization(code, analysis.render_type)
        if ok:
            await stream.progress(
                message=i18n.t(
                    "validation_passed", "Looks good — passed local checks."
                ),
                source="visualize",
                stage="reviewing",
            )
            final_code = code
        else:
            await stream.progress(
                message=i18n.t("repairing", "Repairing the visualization..."),
                source="visualize",
                stage="reviewing",
            )
            try:
                review = await pipeline.run_repair(
                    user_input=user_message,
                    analysis=analysis,
                    code=code,
                    error=validation_error,
                )
                final_code = review.optimized_code
                still_ok, _ = validate_visualization(final_code, analysis.render_type)
                if not still_ok:
                    await stream.progress(
                        message=i18n.t(
                            "repair_incomplete",
                            f"Repair attempted; residual issue: {validation_error}",
                            error=validation_error,
                        ),
                        source="visualize",
                        stage="reviewing",
                    )
                    final_code = build_fallback_html(
                        user_message, str(validation_error), analysis.render_type
                    )
                    await stream.progress(
                        message=i18n.t(
                            "html_invalid_fallback",
                            "Fell back to a placeholder visualization.",
                        ),
                        source="visualize",
                        stage="reviewing",
                    )
                else:
                    await stream.progress(
                        message=i18n.t("code_repaired", "Code repaired."),
                        source="visualize",
                        stage="reviewing",
                    )
            except Exception as repair_exc:
                await stream.progress(
                    message=i18n.t(
                        "llm_call_failed",
                        f"Repair call failed: {repair_exc}",
                        error=str(repair_exc),
                    ),
                    source="visualize",
                    stage="reviewing",
                )
                # Repair skipped after an LLM failure: fall back directly.
                _ = i18n.t("repair_skipped_error", f"Repair skipped: {repair_exc}")
                final_code = build_fallback_html(
                    user_message, str(validation_error), analysis.render_type
                )
                await stream.progress(
                    message=i18n.t(
                        "html_invalid_fallback",
                        "Fell back to a placeholder visualization.",
                    ),
                    source="visualize",
                    stage="reviewing",
                )
        return {"render_type": analysis.render_type, "code": final_code}

    return asyncio.run(_run())


def _run_manim(input_payload: dict[str, Any], stream: WorkerStream) -> dict[str, Any]:
    """Run the math-animator domain pipeline (manim subprocess path)."""
    from knorvia.agents.math_animator.capability import MathAnimatorCapability
    from knorvia.i18n import StatusI18n

    capability = MathAnimatorCapability()
    language = str(input_payload.get("language") or "zh")
    i18n = StatusI18n("math_animator", language, module="math_animator")
    # i18n keys retained from the math_animator orchestration (progress
    # parity; the capability emits its own stream events via the shim).
    _ = (
        i18n.t("manim_code_prepared", "Manim code prepared."),
        i18n.t("manim_rendering", "Rendering the Manim scene..."),
        i18n.t("manim_retry", "Retrying the Manim render..."),
        i18n.t("manim_artifacts_one", "Animation artifact ready."),
        i18n.t("manim_artifacts_many", "Animation artifacts ready."),
    )
    context = UnifiedContext(
        user_message=str(input_payload.get("user_message") or ""),
        language=language,
        config_overrides=dict(input_payload.get("config_overrides") or {}),
    )

    async def _run() -> dict[str, Any]:
        await capability.run(context, stream)
        if stream.result_envelope is None:
            raise RuntimeError("math animator produced no result envelope")
        return stream.result_envelope

    return asyncio.run(_run())


MEDIA_PACKS: dict[str, Callable[[dict[str, Any], WorkerStream], dict[str, Any]]] = {
    "media.visualize": _run_visualize,
    "media.manim": _run_manim,
}


def _read_frame(stdin: Any) -> dict[str, Any] | None:
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = stdin.read(1)
        if not chunk:
            return None
        headers += chunk
        if len(headers) > 4096:
            raise ValueError("frame headers too large")
    head = headers.split(b"\r\n\r\n", 1)[0]
    length = None
    for line in head.decode("ascii", "replace").split("\r\n"):
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length is None:
        raise ValueError("missing Content-Length")
    body = stdin.read(length)
    if len(body) != length:
        raise ValueError("short frame")
    return json.loads(body.decode("utf-8"))


def _write_frame(stdout: Any, obj: dict[str, Any]) -> None:
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    stdout.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw)
    stdout.flush()


def serve(stdin: Any, stdout: Any) -> None:
    """Framed JSON-RPC loop over the given stdio (test seam + main entry)."""
    cancelled = False
    while True:
        frame = _read_frame(stdin)
        if frame is None:
            break
        if frame.get("id") is None:
            if frame.get("method") == "cancel":
                cancelled = True
            continue

        request_id = frame.get("id")
        method = frame.get("method")

        def emit_step(step: str) -> None:
            _write_frame(stdout, {"method": "progress", "params": {"step": step}})

        def is_cancelled() -> bool:
            return cancelled

        if method == "initialize":
            _write_frame(stdout, {"id": request_id, "result": {"ok": True}})
        elif method == "render":
            params = frame.get("params", {})
            pack_id = params.get("packId", "")
            input_payload = params.get("input", {})
            if cancelled:
                _write_frame(
                    stdout,
                    {
                        "id": request_id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    },
                )
                continue
            handler = MEDIA_PACKS.get(pack_id)
            if handler is None:
                _write_frame(
                    stdout,
                    {
                        "id": request_id,
                        "error": {
                            "code": -32000,
                            "message": (
                                f"python media worker does not host pack {pack_id}"
                            ),
                        },
                    },
                )
                continue
            stream = WorkerStream(emit_step=emit_step, is_cancelled=is_cancelled)
            try:
                result = handler(input_payload, stream)
                encoded = {
                    key: base64.b64encode(str(value).encode("utf-8")).decode("ascii")
                    for key, value in result.items()
                }
                _write_frame(stdout, {"id": request_id, "result": encoded})
            except WorkerCancelled:
                cancelled = True
                _write_frame(
                    stdout,
                    {
                        "id": request_id,
                        "error": {"code": -32030, "message": "cancelled by user"},
                    },
                )
            except Exception as exc:  # noqa: BLE001 - typed failure to the daemon
                _write_frame(
                    stdout,
                    {"id": request_id, "error": {"code": -32000, "message": str(exc)}},
                )
        elif method == "shutdown":
            _write_frame(stdout, {"id": request_id, "result": {"ok": True}})
            break
        else:
            _write_frame(
                stdout,
                {
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"unknown method {method}",
                    },
                },
            )


def main() -> None:
    """Worker entry: framed JSON-RPC loop on stdio."""
    serve(sys.stdin.buffer, sys.stdout.buffer)


if __name__ == '__main__':
    main()
