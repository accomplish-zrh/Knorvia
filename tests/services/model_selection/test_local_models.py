from knorvia.services.model_selection.local_models import (
    LMSTUDIO_PROFILE_ID,
    OLLAMA_PROFILE_ID,
    inject_local_selection_into_catalog,
    merge_local_options,
    probe_loaded_local_models,
)


def test_probe_is_quiet_when_servers_are_down():
    def fail(_url: str):
        raise ConnectionError("down")

    assert probe_loaded_local_models(fetch_json=fail) == []


def test_probe_reads_loaded_ollama_and_lmstudio_models():
    def fake(url: str):
        if url.endswith("/api/ps"):
            return {"models": [{"name": "qwen2.5:7b", "model": "qwen2.5:7b"}]}
        if url.endswith("/v1/models"):
            return {"data": [{"id": "gemma-3-4b"}]}
        raise AssertionError(url)

    options = probe_loaded_local_models(fetch_json=fake)
    by_profile = {item["profile_id"]: item["model"] for item in options}
    assert by_profile[OLLAMA_PROFILE_ID] == "qwen2.5:7b"
    assert by_profile[LMSTUDIO_PROFILE_ID] == "gemma-3-4b"
    assert all(item["is_active_default"] is False for item in options)


def test_merge_skips_already_configured_models():
    existing = [
        {
            "profile_id": "cfg",
            "model_id": "1",
            "model": "qwen2.5:7b",
            "provider": "ollama",
        }
    ]
    local = probe_loaded_local_models(
        fetch_json=lambda url: {"models": [{"model": "qwen2.5:7b"}]}
        if url.endswith("/api/ps")
        else {"data": []}
    )
    merged = merge_local_options(existing, local)
    assert len(merged) == 1
    assert merged[0]["profile_id"] == "cfg"


def test_inject_local_selection_does_not_require_catalog_profile():
    catalog = {"services": {"llm": {"profiles": []}}}
    out = inject_local_selection_into_catalog(catalog, OLLAMA_PROFILE_ID, "llama3.2")
    llm = out["services"]["llm"]
    assert llm["active_profile_id"] == OLLAMA_PROFILE_ID
    assert llm["active_model_id"] == "llama3.2"
    assert llm["profiles"][0]["base_url"] == "http://127.0.0.1:11434/v1"


def test_probe_prefers_lmstudio_v0_loaded_models():
    def fake(url: str):
        if url.endswith("/api/ps"):
            return {"models": []}
        if url.endswith("/api/v0/models"):
            return {
                "models": [
                    {"id": "loaded-gemma", "state": "loaded"},
                    {"id": "cold-llama", "state": "not-loaded"},
                ]
            }
        if url.endswith("/v1/models"):
            return {"data": [{"id": "should-not-use"}]}
        return None

    options = probe_loaded_local_models(fetch_json=fake)
    names = [item["model"] for item in options if item["profile_id"] == LMSTUDIO_PROFILE_ID]
    assert names == ["loaded-gemma"]
