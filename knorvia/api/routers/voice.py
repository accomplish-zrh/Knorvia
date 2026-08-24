"""Voice endpoints — text-to-speech and speech-to-text.

These are thin HTTP surfaces over :mod:`knorvia.services.voice`. Config comes
from the admin-managed model catalog (``services.tts`` / ``services.stt``), so
voice is shared infrastructure like embedding/search — any authenticated user
may call it; it is not gated by per-user LLM grants.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from knorvia.services.voice import (
    PREVIEW_SAMPLE_TEXT,
    VoiceProviderError,
    list_voices,
    synthesize_speech,
    transcribe_audio,
)
from knorvia.services.voice.base import parse_pcm_content_type, pcm16_to_wav

logger = logging.getLogger(__name__)

router = APIRouter()

# Guard against pathological uploads (the providers cap well below this anyway).
_MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB, matching OpenAI's limit.


class TTSRequest(BaseModel):
    """Text-to-speech request body."""

    text: str = Field(..., min_length=1)
    voice: str | None = None
    format: str | None = None


@router.get("/voices")
def get_voices() -> dict[str, Any]:
    """§Phase D4: enumerate the active TTS provider's selectable voices.

    A pure configuration read (provider whitelist + gateway ``custom_voices``)
    — zero provider calls, so this stays a free action under the paid-task
    discipline.
    """
    try:
        return list_voices()
    except ValueError as exc:  # missing/invalid configuration
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


class VoicePreviewRequest(BaseModel):
    """§Phase D4: audition one voice with the fixed sample sentence.

    Preview synthesis hits the provider, so it is one paid task per request:
    each call carries its own ``confirmed_cost`` flag.
    """

    voice: str = Field(..., min_length=1, max_length=160)
    confirmed_cost: bool = False


@router.post("/preview")
async def preview_voice(payload: VoicePreviewRequest) -> Response:
    """§Phase D4: synthesize the fixed sample sentence in ``voice``.

    Paid discipline mirrors the video-studio endpoints: an unconfirmed request
    is rejected with 409 before any provider lookup, and every confirmed
    request is exactly one provider call.
    """
    if payload.confirmed_cost is not True:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Voice preview requires explicit cost confirmation.",
        )
    try:
        audio, content_type = await synthesize_speech(PREVIEW_SAMPLE_TEXT, voice=payload.voice)
    except ValueError as exc:  # missing/invalid configuration
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("Voice preview provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    pcm_info = parse_pcm_content_type(content_type)
    if pcm_info:
        sample_rate, channels = pcm_info
        audio = pcm16_to_wav(audio, sample_rate=sample_rate, channels=channels)
        content_type = "audio/wav"
    return Response(
        content=audio,
        media_type=content_type,
        # Audition clips are deterministic per voice+text; the browser may
        # cache the sample between picks to avoid repeat provider spend.
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.post("/tts")
async def text_to_speech(payload: TTSRequest) -> Response:
    """Synthesize ``text`` to audio using the active TTS provider."""
    try:
        audio, content_type = await synthesize_speech(
            payload.text,
            voice=payload.voice,
            response_format=payload.format,
        )
    except ValueError as exc:  # missing/invalid configuration
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("TTS provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    pcm_info = parse_pcm_content_type(content_type)
    if pcm_info:
        sample_rate, channels = pcm_info
        audio = pcm16_to_wav(audio, sample_rate=sample_rate, channels=channels)
        content_type = "audio/wav"
    return Response(
        content=audio,
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> dict[str, str]:
    """Transcribe an uploaded audio clip using the active STT provider."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty audio upload.")
    if len(audio) > _MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Audio exceeds the 25 MB limit.",
        )
    try:
        text = await transcribe_audio(
            audio,
            filename=file.filename or "audio.webm",
            content_type=file.content_type or "application/octet-stream",
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("STT provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return {"text": text}
