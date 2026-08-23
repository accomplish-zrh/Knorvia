from __future__ import annotations

import base64
from typing import Any

import httpx

from knorvia.services.generation_http import (
    GenerationProviderError,
    join_api_path,
    raise_for_provider,
)
from knorvia.services.imagegen.base import BaseImagegenAdapter, ImagegenResponse
from knorvia.services.imagegen.config import ImagegenConfig


class GeminiInteractionsImagegenAdapter(BaseImagegenAdapter):
    """Gemini native Interactions image generation/editing adapter."""

    async def generate(
        self, prompt: str, config: ImagegenConfig, *, n: int = 1
    ) -> list[tuple[bytes, str]]:
        return (await self.generate_with_metadata(prompt, config, n=n)).images

    async def edit(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        images: list[tuple[bytes, str]],
        mask: tuple[bytes, str] | None = None,
        n: int = 1,
    ) -> list[tuple[bytes, str]]:
        return (await self.edit_with_metadata(prompt, config, images=images, mask=mask, n=n)).images

    async def generate_with_metadata(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        n: int = 1,
        parent_context_id: str | None = None,
    ) -> ImagegenResponse:
        return await self._execute(prompt, config, [], n, parent_context_id)

    async def edit_with_metadata(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        images: list[tuple[bytes, str]],
        mask: tuple[bytes, str] | None = None,
        n: int = 1,
        parent_context_id: str | None = None,
    ) -> ImagegenResponse:
        if mask is not None:
            raise GenerationProviderError(
                "Gemini Interactions does not support explicit mask inpainting."
            )
        return await self._execute(prompt, config, images, n, parent_context_id)

    async def _execute(
        self,
        prompt: str,
        config: ImagegenConfig,
        images: list[tuple[bytes, str]],
        n: int,
        parent_context_id: str | None,
    ) -> ImagegenResponse:
        url = join_api_path(config.base_url, "interactions")
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": config.api_key,
            **(config.extra_headers or {}),
        }
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        content.extend(
            {
                "type": "image",
                "mime_type": mime,
                "data": base64.b64encode(data).decode("ascii"),
            }
            for data, mime in images
        )
        response_format: dict[str, Any] = {"type": "image"}
        if config.aspect_ratio:
            response_format["aspect_ratio"] = config.aspect_ratio
        if config.image_size:
            response_format["image_size"] = config.image_size
        payload: dict[str, Any] = {
            "model": config.model,
            "input": [{"role": "user", "content": content}],
            "response_format": response_format,
        }
        if parent_context_id:
            payload["previous_interaction_id"] = parent_context_id
        outputs: list[tuple[bytes, str]] = []
        warnings: list[str] = []
        context_id = parent_context_id
        usage: dict[str, Any] = {}
        async with httpx.AsyncClient(timeout=config.request_timeout) as client:
            for _index in range(max(1, min(n, 4))):
                try:
                    response = await client.post(url, headers=headers, json=payload)
                    raise_for_provider(response, "Gemini image generation")
                    body = response.json()
                    outputs.extend(self._extract(body))
                    context_id = (
                        str(body.get("id") or body.get("interaction_id") or context_id or "")
                        or None
                    )
                    if isinstance(body.get("usage"), dict):
                        usage = body["usage"]
                except Exception as exc:
                    warnings.append(str(exc)[:400])
        if not outputs:
            raise GenerationProviderError(warnings[0] if warnings else "Gemini returned no image.")
        return ImagegenResponse(
            images=outputs, provider_context_id=context_id, usage=usage, warnings=warnings
        )

    @staticmethod
    def _extract(body: dict[str, Any]) -> list[tuple[bytes, str]]:
        results: list[tuple[bytes, str]] = []
        parts: list[Any] = []
        for output in body.get("outputs") or []:
            if isinstance(output, dict):
                parts.extend(output.get("content") or output.get("parts") or [])
        for candidate in body.get("candidates") or []:
            if isinstance(candidate, dict):
                parts.extend((candidate.get("content") or {}).get("parts") or [])
        for part in parts:
            if not isinstance(part, dict):
                continue
            inline = part.get("inline_data") or part.get("inlineData") or part
            encoded = inline.get("data") if isinstance(inline, dict) else None
            mime = (
                (inline.get("mime_type") or inline.get("mimeType") or "image/png")
                if isinstance(inline, dict)
                else "image/png"
            )
            if isinstance(encoded, str) and encoded and str(mime).startswith("image/"):
                results.append((base64.b64decode(encoded), str(mime)))
        if not results:
            raise GenerationProviderError("Gemini response contained no inline image data.")
        return results


__all__ = ["GeminiInteractionsImagegenAdapter"]
