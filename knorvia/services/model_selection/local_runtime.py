"""Ephemeral loopback LLM profiles (Ollama :11434, LM Studio :1234).

These IDs are never written to the model catalog. They exist so a one-click
choice in the top-bar switcher can resolve a currently-loaded local model.
"""

from __future__ import annotations

from typing import Any

LOCAL_OLLAMA_PROFILE_ID = "__local_ollama__"
LOCAL_LMSTUDIO_PROFILE_ID = "__local_lmstudio__"

LOCAL_RUNTIME_PROFILES: dict[str, dict[str, str]] = {
    LOCAL_OLLAMA_PROFILE_ID: {
        "binding": "ollama",
        "name": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
    },
    LOCAL_LMSTUDIO_PROFILE_ID: {
        "binding": "lm_studio",
        "name": "LM Studio",
        "base_url": "http://127.0.0.1:1234/v1",
    },
}


def is_local_runtime_profile(profile_id: str | None) -> bool:
    return str(profile_id or "") in LOCAL_RUNTIME_PROFILES


def inject_local_runtime_selection(
    catalog: dict[str, Any],
    *,
    profile_id: str,
    model_id: str,
) -> dict[str, Any]:
    """Mutate *catalog* so *profile_id*/*model_id* resolves as the active LLM."""
    spec = LOCAL_RUNTIME_PROFILES.get(profile_id)
    if spec is None:
        raise ValueError("Invalid LLM selection: selected profile/model was not found.")
    model_id = str(model_id or "").strip()
    if not model_id:
        raise ValueError("Invalid LLM selection: profile_id and model_id are required.")

    services = catalog.setdefault("services", {})
    if not isinstance(services, dict):
        catalog["services"] = {}
        services = catalog["services"]
    llm = services.setdefault("llm", {})
    if not isinstance(llm, dict):
        services["llm"] = {}
        llm = services["llm"]
    profiles = llm.setdefault("profiles", [])
    if not isinstance(profiles, list):
        llm["profiles"] = []
        profiles = llm["profiles"]

    ephemeral = {
        "id": profile_id,
        "name": spec["name"],
        "binding": spec["binding"],
        "base_url": spec["base_url"],
        "api_key": "sk-no-key-required",
        "api_version": "",
        "extra_headers": {},
        "models": [
            {
                "id": model_id,
                "name": model_id,
                "model": model_id,
            }
        ],
    }
    replaced = False
    for index, existing in enumerate(profiles):
        if isinstance(existing, dict) and existing.get("id") == profile_id:
            profiles[index] = ephemeral
            replaced = True
            break
    if not replaced:
        profiles.append(ephemeral)
    llm["active_profile_id"] = profile_id
    llm["active_model_id"] = model_id
    return catalog


__all__ = [
    "LOCAL_LMSTUDIO_PROFILE_ID",
    "LOCAL_OLLAMA_PROFILE_ID",
    "LOCAL_RUNTIME_PROFILES",
    "inject_local_runtime_selection",
    "is_local_runtime_profile",
]
