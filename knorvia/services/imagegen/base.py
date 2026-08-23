"""Base abstraction for image-generation adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from knorvia.services.generation_http import GenerationProviderError
from knorvia.services.imagegen.config import ImagegenConfig


@dataclass(slots=True)
class ImagegenResponse:
    images: list[tuple[bytes, str]]
    provider_context_id: str | None = None
    revised_prompt: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class BaseImagegenAdapter(ABC):
    """Abstract text-to-image adapter."""

    @abstractmethod
    async def generate(
        self, prompt: str, config: ImagegenConfig, *, n: int = 1
    ) -> list[tuple[bytes, str]]:
        """Generate ``n`` images for ``prompt``.

        Returns a list of ``(image_bytes, content_type)`` — content type is
        best-effort, e.g. ``image/png``.
        """

    async def edit(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        images: list[tuple[bytes, str]],
        mask: tuple[bytes, str] | None = None,
        n: int = 1,
    ) -> list[tuple[bytes, str]]:
        raise GenerationProviderError("The selected image model does not support editing.")

    async def generate_with_metadata(
        self,
        prompt: str,
        config: ImagegenConfig,
        *,
        n: int = 1,
        parent_context_id: str | None = None,
    ) -> ImagegenResponse:
        return ImagegenResponse(images=await self.generate(prompt, config, n=n))

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
        return ImagegenResponse(
            images=await self.edit(prompt, config, images=images, mask=mask, n=n)
        )


__all__ = ["BaseImagegenAdapter", "ImagegenResponse"]
