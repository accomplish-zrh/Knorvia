from __future__ import annotations

import base64
from typing import Any

import httpx

from knorvia.services.generation_http import (
    GenerationProviderError,
    build_auth_headers,
    join_api_path,
    raise_for_provider,
)
from knorvia.services.imagegen.base import BaseImagegenAdapter, ImagegenResponse
from knorvia.services.imagegen.config import ImagegenConfig


def _data_url(content: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"


class OpenAIResponsesImagegenAdapter(BaseImagegenAdapter):
    """OpenAI Responses API image-generation tool with multi-turn continuity."""

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
        return await self._execute(
            prompt, config, images=[], n=n, parent_context_id=parent_context_id
        )

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
                "The Responses image tool does not accept an explicit mask; use the Images adapter for inpainting."
            )
        return await self._execute(
            prompt, config, images=images, n=n, parent_context_id=parent_context_id
        )

    async def _execute(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        images: list[tuple[bytes, str]],
        n: int,
        parent_context_id: str | None,
    ) -> ImagegenResponse:
        url = join_api_path(config.base_url, "responses")
        headers = {
            "Content-Type": "application/json",
            **build_auth_headers(config.auth_style, config.api_key),
            **(config.extra_headers or {}),
        }
        outputs: list[tuple[bytes, str]] = []
        warnings: list[str] = []
        context_id = parent_context_id
        previous_context_id = parent_context_id
        revised_prompt: str | None = None
        usage: dict[str, Any] = {}
        async with httpx.AsyncClient(timeout=config.request_timeout) as client:
            for _index in range(max(1, min(n, 4))):
                content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
                content.extend(
                    {"type": "input_image", "image_url": _data_url(data, mime)}
                    for data, mime in images
                )
                tool: dict[str, Any] = {"type": "image_generation"}
                for source, target in (
                    (config.size, "size"),
                    (config.quality, "quality"),
                    (config.response_format, "output_format"),
                    (config.background, "background"),
                ):
                    if source:
                        tool[target] = source
                if config.compression is not None:
                    tool["output_compression"] = config.compression
                payload: dict[str, Any] = {
                    "model": config.model,
                    "input": [{"role": "user", "content": content}],
                    "tools": [tool],
                    "tool_choice": {"type": "image_generation"},
                }
                if previous_context_id:
                    payload["previous_response_id"] = previous_context_id
                try:
                    response = await client.post(url, headers=headers, json=payload)
                    raise_for_provider(response, "Responses image generation")
                    body = response.json()
                    image, item_prompt = self._extract(body, config.response_format)
                    outputs.append(image)
                    context_id = str(body.get("id") or context_id or "") or None
                    revised_prompt = item_prompt or revised_prompt
                    if isinstance(body.get("usage"), dict):
                        usage = body["usage"]
                except Exception as exc:
                    warnings.append(str(exc)[:400])
        if not outputs:
            raise GenerationProviderError(
                warnings[0] if warnings else "Responses API returned no image."
            )
        return ImagegenResponse(
            images=outputs,
            provider_context_id=context_id,
            revised_prompt=revised_prompt,
            usage=usage,
            warnings=warnings,
        )

    @staticmethod
    def _extract(body: dict[str, Any], output_format: str) -> tuple[tuple[bytes, str], str | None]:
        for item in body.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "image_generation_call":
                continue
            encoded = item.get("result")
            if isinstance(encoded, str) and encoded:
                fmt = (output_format or "png").replace("jpg", "jpeg")
                return (base64.b64decode(encoded), f"image/{fmt}"), item.get("revised_prompt")
        raise GenerationProviderError("Responses API returned no image generation result.")


__all__ = ["OpenAIResponsesImagegenAdapter"]
