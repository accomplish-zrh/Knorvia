"""Probe locally running Ollama / LM Studio for already-loaded models.

Results are ephemeral catalog options for the existing chat top-bar switcher.
This module never downloads, pulls, or writes settings — a down server is
silent (empty list).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import logging
from typing import Any
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

OLLAMA_PROFILE_ID = "__local_ollama"
LMSTUDIO_PROFILE_ID = "__local_lmstudio"

LOCAL_PROFILE_SPECS: dict[str, dict[str, str]] = {
    OLLAMA_PROFILE_ID: {
        "binding": "ollama",
        "name": "Ollama",
        "provider_label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
    },
    LMSTUDIO_PROFILE_ID: {
        "binding": "lm_studio",
        "name": "LM Studio",
        "provider_label": "LM Studio",
        "base_url": "http://127.0.0.1:1234/v1",
    },
}

_PROBE_TIMEOUT_SEC = 0.4


def is_local_profile_id(profile_id: str | None) -> bool:
    return str(profile_id or "").strip() in LOCAL_PROFILE_SPECS


def _fetch_json(url: str) -> Any:
    try:
        req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT_SEC) as resp:
            raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        logger.debug("Local model probe quiet-fail %s: %s", url, exc)
        return None
    except Exception as exc:  # noqa: BLE001 — must stay silent if the host is down
        logger.debug("Local model probe quiet-fail %s: %s", url, exc)
        return None


def _model_names_from_ollama(payload: Any) -> list[str]:
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        return []
    names: list[str] = []
    for item in models:
        if not isinstance(item, dict):
            continue
        name = str(item.get("model") or item.get("name") or "").strip()
        if name:
            names.append(name)
    return names


def _is_loaded_lmstudio_row(item: dict[str, Any]) -> bool:
    if item.get("loaded") is False:
        return False
    raw = str(item.get("state") or "").lower().strip()
    if not raw:
        return True
    if "unload" in raw or raw.startswith("not-") or raw == "not-loaded":
        return False
    return raw in {"loaded", "idle", "loading"}


def _model_names_from_openai(payload: Any) -> list[str]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    names: list[str] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or item.get("name") or "").strip()
        if name:
            names.append(name)
    return names


def _model_names_from_lmstudio(payload: Any) -> list[str]:
    """Prefer LM Studio /api/v0/models (has loaded state); else OpenAI /v1/models."""
    if not isinstance(payload, dict):
        return _model_names_from_openai(payload)
    rows = payload.get("models")
    if isinstance(rows, list):
        names: list[str] = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            if not _is_loaded_lmstudio_row(item):
                continue
            name = str(item.get("id") or item.get("name") or item.get("model") or "").strip()
            if name:
                names.append(name)
        return names
    return _model_names_from_openai(payload)


def probe_loaded_local_models(
    *,
    fetch_json=None,
) -> list[dict[str, Any]]:
    """Return redacted LLM-option dicts for models currently loaded locally."""
    getter = fetch_json or _fetch_json

    def _safe(url: str) -> Any:
        try:
            return getter(url)
        except Exception as exc:  # noqa: BLE001 — quiet if the host is down
            logger.debug("Local model probe quiet-fail %s: %s", url, exc)
            return None

    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    with ThreadPoolExecutor(max_workers=3) as pool:
        ollama_f = pool.submit(_safe, "http://127.0.0.1:11434/api/ps")
        lmstudio_v0_f = pool.submit(_safe, "http://127.0.0.1:1234/api/v0/models")
        lmstudio_v1_f = pool.submit(_safe, "http://127.0.0.1:1234/v1/models")
        ollama = ollama_f.result()
        lmstudio_v0 = lmstudio_v0_f.result()
        lmstudio_v1 = lmstudio_v1_f.result()
    lmstudio_payload = lmstudio_v0 if lmstudio_v0 is not None else lmstudio_v1
    for name in _model_names_from_ollama(ollama):
        key = (OLLAMA_PROFILE_ID, name)
        if key in seen:
            continue
        seen.add(key)
        spec = LOCAL_PROFILE_SPECS[OLLAMA_PROFILE_ID]
        found.append(
            {
                "profile_id": OLLAMA_PROFILE_ID,
                "model_id": name,
                "profile_name": spec["name"],
                "model_name": name,
                "model": name,
                "provider": spec["binding"],
                "provider_label": spec["provider_label"],
                "is_active_default": False,
            }
        )

    lmstudio = lmstudio_payload
    for name in _model_names_from_lmstudio(lmstudio):
        key = (LMSTUDIO_PROFILE_ID, name)
        if key in seen:
            continue
        seen.add(key)
        spec = LOCAL_PROFILE_SPECS[LMSTUDIO_PROFILE_ID]
        found.append(
            {
                "profile_id": LMSTUDIO_PROFILE_ID,
                "model_id": name,
                "profile_name": spec["name"],
                "model_name": name,
                "model": name,
                "provider": spec["binding"],
                "provider_label": spec["provider_label"],
                "is_active_default": False,
            }
        )

    return found


def inject_local_selection_into_catalog(
    catalog: dict[str, Any],
    profile_id: str,
    model_id: str,
) -> dict[str, Any]:
    """Install an ephemeral local profile/model as the active LLM in *catalog*."""
    spec = LOCAL_PROFILE_SPECS.get(profile_id)
    if spec is None:
        raise ValueError("Invalid LLM selection: selected profile/model was not found.")
    model_id = str(model_id or "").strip()
    if not model_id:
        raise ValueError("Invalid LLM selection: profile_id and model_id are required.")

    services = catalog.setdefault("services", {})
    if not isinstance(services, dict):
        services = {}
        catalog["services"] = services
    llm = services.setdefault("llm", {})
    if not isinstance(llm, dict):
        llm = {}
        services["llm"] = llm
    profiles = llm.setdefault("profiles", [])
    if not isinstance(profiles, list):
        profiles = []
        llm["profiles"] = profiles

    profile = {
        "id": profile_id,
        "name": spec["name"],
        "binding": spec["binding"],
        "base_url": spec["base_url"],
        "api_key": "sk-no-key-required",
        "models": [
            {
                "id": model_id,
                "name": model_id,
                "model": model_id,
            }
        ],
    }
    profiles.append(profile)
    llm["active_profile_id"] = profile_id
    llm["active_model_id"] = model_id
    return catalog


def merge_local_options(
    options: list[dict[str, Any]],
    local_options: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Append probed local models, skipping ones already in the configured catalog."""
    existing = {
        (
            str(item.get("provider") or ""),
            str(item.get("model") or item.get("model_name") or ""),
        )
        for item in options
        if isinstance(item, dict)
    }
    merged = list(options)
    for item in local_options:
        key = (
            str(item.get("provider") or ""),
            str(item.get("model") or item.get("model_name") or ""),
        )
        if key in existing:
            continue
        existing.add(key)
        merged.append(item)
    return merged


__all__ = [
    "LMSTUDIO_PROFILE_ID",
    "LOCAL_PROFILE_SPECS",
    "OLLAMA_PROFILE_ID",
    "inject_local_selection_into_catalog",
    "is_local_profile_id",
    "merge_local_options",
    "probe_loaded_local_models",
]
