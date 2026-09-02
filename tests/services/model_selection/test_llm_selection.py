from pathlib import Path

from knorvia.services.model_selection import (
    LLMSelection,
    apply_llm_selection_to_catalog,
    list_llm_options,
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
                        "api_version": "",
                        "extra_headers": {"x-secret": "nope"},
                        "models": [
                            {
                                "id": "m1",
                                "name": "Gemini Flash",
                                "model": "google/gemini-3-flash-preview",
                                "context_window": "1000000",
                            },
                            {
                                "id": "m2",
                                "name": "GPT Mini",
                                "model": "openai/gpt-4o-mini",
                            },
                        ],
                    },
                    {
                        "id": "p2",
                        "name": "Local",
                        "binding": "ollama",
                        "base_url": "http://localhost:11434/v1",
                        "api_key": "",
                        "api_version": "",
                        "extra_headers": {},
                        "models": [{"id": "m3", "name": "Llama", "model": "llama3.2"}],
                    },
                ],
            },
            "embedding": {"active_profile_id": None, "active_model_id": None, "profiles": []},
            "search": {"active_profile_id": None, "profiles": []},
        },
    }


def test_list_llm_options_is_redacted_and_marks_active_default(monkeypatch):
    monkeypatch.setattr(
        "knorvia.services.model_selection.llm.probe_loaded_local_models",
        lambda: [],
    )
    payload = list_llm_options(_catalog())
    assert payload["active"] == {"profile_id": "p1", "model_id": "m1"}
    assert [o["model_id"] for o in payload["options"]] == ["m1", "m2", "m3"]
    assert payload["options"][0]["is_active_default"] is True
    assert payload["options"][0]["context_window"] == 1000000
    assert "api_key" not in payload["options"][0]
    assert "base_url" not in payload["options"][0]
    assert "extra_headers" not in payload["options"][0]


def test_apply_llm_selection_to_catalog_returns_copy_with_selected_active_ids():
    selected = apply_llm_selection_to_catalog(
        _catalog(), LLMSelection(profile_id="p2", model_id="m3")
    )
    assert selected["services"]["llm"]["active_profile_id"] == "p2"
    assert selected["services"]["llm"]["active_model_id"] == "m3"


def test_apply_llm_selection_does_not_mutate_source_catalog():
    catalog = _catalog()
    apply_llm_selection_to_catalog(catalog, LLMSelection(profile_id="p2", model_id="m3"))
    assert catalog["services"]["llm"]["active_profile_id"] == "p1"
    assert catalog["services"]["llm"]["active_model_id"] == "m1"


def test_apply_llm_selection_rejects_model_not_in_profile():
    try:
        apply_llm_selection_to_catalog(_catalog(), LLMSelection(profile_id="p2", model_id="m1"))
    except ValueError as exc:
        assert "Invalid LLM selection" in str(exc)
    else:
        raise AssertionError("expected invalid selection to fail")


def test_list_llm_options_appends_probed_local_models(monkeypatch):
    monkeypatch.setattr(
        "knorvia.services.model_selection.llm.probe_loaded_local_models",
        lambda: [
            {
                "profile_id": "__local_ollama",
                "model_id": "qwen2.5",
                "profile_name": "Ollama",
                "model_name": "qwen2.5",
                "model": "qwen2.5",
                "provider": "ollama",
                "provider_label": "Ollama",
                "is_active_default": False,
            }
        ],
    )
    payload = list_llm_options(_catalog())
    assert payload["options"][-1]["profile_id"] == "__local_ollama"
    assert payload["options"][-1]["model"] == "qwen2.5"
    assert [o["model_id"] for o in payload["options"][:3]] == ["m1", "m2", "m3"]


def test_apply_uses_listed_local_option_as_active_catalog_copy(monkeypatch):
    monkeypatch.setattr(
        "knorvia.services.model_selection.llm.probe_loaded_local_models",
        lambda: [
            {
                "profile_id": "__local_lmstudio",
                "model_id": "gemma-2-9b",
                "profile_name": "LM Studio",
                "model_name": "gemma-2-9b",
                "model": "gemma-2-9b",
                "provider": "lm_studio",
                "provider_label": "LM Studio",
                "is_active_default": False,
            }
        ],
    )
    listed = list_llm_options(_catalog())
    local = next(o for o in listed["options"] if o["profile_id"] == "__local_lmstudio")
    selected = apply_llm_selection_to_catalog(
        _catalog(),
        {"profile_id": local["profile_id"], "model_id": local["model_id"]},
    )
    llm = selected["services"]["llm"]
    assert llm["active_profile_id"] == "__local_lmstudio"
    assert llm["active_model_id"] == "gemma-2-9b"


def test_shared_surfaces_pass_llm_selection_to_apply_or_activate():
    root = Path("knorvia")
    turn = (root / "services/session/turn_runtime.py").read_text(encoding="utf-8")
    partners = (root / "api/routers/partners.py").read_text(encoding="utf-8")
    memory = (root / "api/routers/memory.py").read_text(encoding="utf-8")
    plugins = (root / "api/routers/plugins_api.py").read_text(encoding="utf-8")
    assert "apply_llm_selection_to_catalog" in turn
    assert "payload[\"llm_selection\"]" in turn or 'payload["llm_selection"]' in turn
    assert "apply_llm_selection_to_catalog" in partners
    assert "merge_personal_llm_profiles" in partners
    assert "llm_selection=selection" in memory
    assert "activate_llm_selection(body.llm_selection)" in plugins
