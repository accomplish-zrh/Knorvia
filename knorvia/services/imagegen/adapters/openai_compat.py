"""OpenAI-compatible image-generation adapter.

Covers OpenAI DALL·E / gpt-image, Volcengine Ark Seedream and any gateway that
exposes ``POST {base}/images/generations``. Handles both response shapes —
``data[].b64_json`` (preferred: bytes inline) and ``data[].url`` (downloaded) —
so the caller always receives raw bytes and never has to deal with expiring
provider URLs.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from knorvia.services.generation_http import (
    GenerationProviderError,
    build_auth_headers,
    join_api_path,
    raise_for_provider,
)
from knorvia.services.imagegen.base import BaseImagegenAdapter
from knorvia.services.imagegen.config import ImagegenConfig

logger = logging.getLogger(__name__)


class OpenAICompatImagegenAdapter(BaseImagegenAdapter):
    """POST ``{base}/images/generations`` with a JSON body, returning image bytes."""

    async def generate(
        self, prompt: str, config: ImagegenConfig, *, n: int = 1
    ) -> list[tuple[bytes, str]]:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for image generation.")
        url = join_api_path(config.base_url, "images/generations")
        headers = {
            "Content-Type": "application/json",
            **build_auth_headers(config.auth_style, config.api_key),
            **(config.extra_headers or {}),
        }
        payload: dict[str, Any] = {"model": config.model, "prompt": prompt, "n": max(1, n)}
        if config.size:
            payload["size"] = config.size
        if config.quality:
            payload["quality"] = config.quality
        if config.style:
            payload["style"] = config.style
        if config.response_format:
            if config.response_format in {"png", "jpeg", "jpg", "webp"}:
                payload["output_format"] = config.response_format.replace("jpg", "jpeg")
            else:
                payload["response_format"] = config.response_format

        logger.debug(
            "imagegen url=%s model=%s n=%d size=%s", url, config.model, max(1, n), config.size
        )
        try:
            async with httpx.AsyncClient(timeout=config.request_timeout) as client:
                resp = await client.post(url, headers=headers, json=payload)
                raise_for_provider(resp, "Image generation")
                images = [
                    await self._materialize(client, item) for item in self._extract_items(resp)
                ]
        except httpx.HTTPError as exc:
            raise GenerationProviderError(f"Image generation request error: {exc}") from exc
        if not images:
            raise GenerationProviderError("Image provider returned no images.")
        return images

    async def edit(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        images: list[tuple[bytes, str]],
        mask: tuple[bytes, str] | None = None,
        n: int = 1,
    ) -> list[tuple[bytes, str]]:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for image editing.")
        if not images:
            raise GenerationProviderError("Image editing requires at least one input image.")
        url = join_api_path(config.base_url, "images/edits")
        headers = {
            **build_auth_headers(config.auth_style, config.api_key),
            **(config.extra_headers or {}),
        }
        data: dict[str, str] = {
            "model": config.model,
            "prompt": prompt,
            "n": str(max(1, n)),
        }
        for key in ("size", "quality"):
            value = getattr(config, key)
            if value:
                data[key] = value
        if config.response_format:
            if config.response_format in {"png", "jpeg", "jpg", "webp"}:
                data["output_format"] = config.response_format.replace("jpg", "jpeg")
            else:
                data["response_format"] = config.response_format
        files: list[tuple[str, tuple[str, bytes, str]]] = [
            ("image", (f"input-{index}.png", content, mime))
            for index, (content, mime) in enumerate(images)
        ]
        if mask is not None:
            files.append(("mask", ("mask.png", mask[0], mask[1])))
        try:
            async with httpx.AsyncClient(timeout=config.request_timeout) as client:
                resp = await client.post(url, headers=headers, data=data, files=files)
                raise_for_provider(resp, "Image editing")
                outputs = [
                    await self._materialize(client, item) for item in self._extract_items(resp)
                ]
        except httpx.HTTPError as exc:
            raise GenerationProviderError(f"Image editing request error: {exc}") from exc
        if not outputs:
            raise GenerationProviderError("Image provider returned no edited images.")
        return outputs

    @staticmethod
    def _extract_items(resp: httpx.Response) -> list[dict[str, Any]]:
        data = resp.json()
        if isinstance(data, dict):
            items = data.get("data")
            if isinstance(items, list) and items:
                return [item for item in items if isinstance(item, dict)]
        raise GenerationProviderError("Image response had no `data` array.")

    async def _materialize(
        self, client: httpx.AsyncClient, item: dict[str, Any]
    ) -> tuple[bytes, str]:
        b64 = item.get("b64_json")
        if isinstance(b64, str) and b64:
            content = base64.b64decode(b64)
            if content.startswith(b"\xff\xd8\xff"):
                return content, "image/jpeg"
            if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
                return content, "image/webp"
            return content, "image/png"
        src = item.get("url")
        if isinstance(src, str) and src:
            await self._validate_download_url(src)
            resp = await client.get(src)
            raise_for_provider(resp, "Image download")
            content_type = resp.headers.get("content-type") or "image/png"
            if not content_type.startswith("image/"):
                content_type = "image/png"
            if len(resp.content) > 50 * 1024 * 1024:
                raise GenerationProviderError("Generated image exceeded the 50 MB download limit.")
            return resp.content, content_type
        raise GenerationProviderError("Image item had neither `b64_json` nor `url`.")

    @staticmethod
    async def _validate_download_url(src: str) -> None:
        parsed = urlparse(src)
        if parsed.scheme != "https" or not parsed.hostname:
            raise GenerationProviderError("Image download URL must use HTTPS.")
        try:
            rows = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, parsed.port or 443)
            addresses = {row[4][0] for row in rows}
        except OSError as exc:
            raise GenerationProviderError("Image download host could not be resolved.") from exc
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global:
                raise GenerationProviderError("Image download URL resolved to a private address.")


__all__ = ["OpenAICompatImagegenAdapter"]
