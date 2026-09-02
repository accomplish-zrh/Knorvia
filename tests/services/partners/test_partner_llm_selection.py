"""Partner config validation uses the same catalog apply path as chat turns."""

from __future__ import annotations

from types import SimpleNamespace

from knorvia.api.routers.partners import _validate_llm_selection_payload
from knorvia.services.model_selection.local_models import OLLAMA_PROFILE_ID


def test_partner_validate_accepts_local_runtime_selection(monkeypatch):
    monkeypatch.setattr(
        "knorvia.services.config.get_model_catalog_service",
        lambda: SimpleNamespace(load=lambda: {"services": {"llm": {"profiles": []}}}),
    )
    monkeypatch.setattr(
        "knorvia.multi_user.personal_models.merge_personal_llm_profiles",
        lambda catalog: catalog,
    )
    selected = _validate_llm_selection_payload(
        {"profile_id": OLLAMA_PROFILE_ID, "model_id": "llama3.2"}
    )
    assert selected == {"profile_id": OLLAMA_PROFILE_ID, "model_id": "llama3.2"}


def test_partner_validate_accepts_catalog_selection(monkeypatch):
    catalog = {
        "services": {
            "llm": {
                "profiles": [
                    {
                        "id": "p1",
                        "models": [{"id": "m1", "model": "flash"}],
                    }
                ]
            }
        }
    }
    monkeypatch.setattr(
        "knorvia.services.config.get_model_catalog_service",
        lambda: SimpleNamespace(load=lambda: catalog),
    )
    monkeypatch.setattr(
        "knorvia.multi_user.personal_models.merge_personal_llm_profiles",
        lambda loaded: loaded,
    )
    selected = _validate_llm_selection_payload({"profile_id": "p1", "model_id": "m1"})
    assert selected == {"profile_id": "p1", "model_id": "m1"}
