from knorvia.services.model_selection import apply_llm_selection_to_catalog
from knorvia.services.model_selection.llm import LLMSelection
from knorvia.services.model_selection.local_models import (
    LMSTUDIO_PROFILE_ID,
    OLLAMA_PROFILE_ID,
    merge_local_options,
    probe_loaded_local_models,
)


def _catalog():
    return {
        "version": 1,
        "services": {
            "llm": {
                "active_profile_id": "p1",
                "active_model_id": "m1",
                "profiles": [
                    {
                        "id": "p1",
                        "name": "OpenRouter",
                        "binding": "openrouter",
                        "base_url": "https://openrouter.ai/api/v1",
                        "api_key": "secret",
                        "models": [{"id": "m1", "name": "Flash", "model": "flash"}],
                    }
                ],
            }
        },
    }


def test_local_ollama_selection_is_ephemeral_and_does_not_store_in_source():
    source = _catalog()
    selected = apply_llm_selection_to_catalog(
        source,
        LLMSelection(profile_id=OLLAMA_PROFILE_ID, model_id="llama3.2"),
    )
    llm = selected["services"]["llm"]
    assert llm["active_profile_id"] == OLLAMA_PROFILE_ID
    assert llm["active_model_id"] == "llama3.2"
    local = next(p for p in llm["profiles"] if p["id"] == OLLAMA_PROFILE_ID)
    assert local["base_url"] == "http://127.0.0.1:11434/v1"
    assert local["binding"] == "ollama"
    assert all(p["id"] != OLLAMA_PROFILE_ID for p in source["services"]["llm"]["profiles"])


def test_local_lmstudio_selection_uses_port_1234():
    selected = apply_llm_selection_to_catalog(
        _catalog(),
        LLMSelection(profile_id=LMSTUDIO_PROFILE_ID, model_id="gemma-2-9b"),
    )
    local = next(
        p for p in selected["services"]["llm"]["profiles"] if p["id"] == LMSTUDIO_PROFILE_ID
    )
    assert local["base_url"] == "http://127.0.0.1:1234/v1"
    assert local["binding"] == "lm_studio"


def test_probe_is_quiet_when_ports_closed():
    def closed(_url: str):
        return None

    assert probe_loaded_local_models(fetch_json=closed) == []


def test_merge_skips_already_configured_models():
    configured = [{"provider": "ollama", "model": "llama3.2", "model_name": "llama3.2"}]
    local = [
        {
            "profile_id": OLLAMA_PROFILE_ID,
            "model_id": "llama3.2",
            "provider": "ollama",
            "model": "llama3.2",
            "model_name": "llama3.2",
        }
    ]
    merged = merge_local_options(configured, local)
    assert len(merged) == 1
