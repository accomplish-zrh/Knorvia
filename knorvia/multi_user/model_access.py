"""Server-side model grant resolution and redacted model views.

Grants carry LLM, image- and video-generation assignments (grant v4): embedding and
search remain shared deployment infrastructure.

Two sources reach an ordinary user, and :func:`redacted_model_access` is the
one place both are resolved: ``admin`` models assigned through a grant, and
the ``personal`` owner-bound profiles the user signed in for themselves (see
:mod:`knorvia.multi_user.personal_models`). Everything downstream — the
option list, the capability gate, and selection validation — reads that one
function, so the three can never disagree about what a user may use.
"""

from __future__ import annotations

from typing import Any

from knorvia.services.config.model_catalog import ModelCatalogService
from knorvia.services.model_selection import list_llm_options

from .context import get_current_user
from .grants import load_grant
from .paths import get_admin_path_service


def admin_catalog_service() -> ModelCatalogService:
    return ModelCatalogService(path=get_admin_path_service().get_settings_file("model_catalog"))


def admin_catalog() -> dict[str, Any]:
    return admin_catalog_service().load()


def _profile_by_id(catalog: dict[str, Any], service: str, profile_id: str) -> dict[str, Any] | None:
    for profile in catalog.get("services", {}).get(service, {}).get("profiles", []) or []:
        if str(profile.get("id") or "") == profile_id:
            return profile
    return None


def _model_by_id(profile: dict[str, Any], model_id: str) -> dict[str, Any] | None:
    for model in profile.get("models", []) or []:
        if str(model.get("id") or "") == model_id:
            return model
    return None


#: Bindings whose credential is one person's own subscription login rather than
#: a billable team key. Codex stamps ``owner_bound`` onto the managed profile it
#: publishes, but a profile can also be created by hand in the settings editor —
#: a CodeBuddy profile is, and it reads the operator's own IDE-plugin session —
#: and there is nowhere for such a profile to acquire the flag. Binding is the
#: durable fact, so it decides too.
OWNER_BOUND_BINDINGS = frozenset({"openai_codex", "codebuddy"})


def is_owner_bound(profile: dict[str, Any]) -> bool:
    """Whether a profile is tied to the identity of the operator who set it up.

    OAuth providers such as Codex authenticate one individual's plan rather than
    a billable team key, so those profiles are never lent to other accounts
    through grants — each user signs in for themselves or goes without.
    """
    binding = str(profile.get("binding") or "").strip().lower()
    if binding in OWNER_BOUND_BINDINGS:
        return True
    return bool(profile.get("owner_bound"))


def redacted_model_access(user_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
    user = get_current_user()
    if user_id is None:
        user_id = user.id
    grant = load_grant(user_id)
    catalog = admin_catalog()
    result: dict[str, list[dict[str, Any]]] = {"llm": [], "imagegen": [], "videogen": []}
    for capability in ("llm", "imagegen", "videogen"):
        for item in grant.get("models", {}).get(capability, []) or []:
            profile_id = str(item.get("profile_id") or item.get("id") or "")
            profile = _profile_by_id(catalog, capability, profile_id)
            if capability == "llm" and profile is not None and is_owner_bound(profile):
                continue
            if not profile:
                result[capability].append(
                    {
                        "profile_id": profile_id,
                        "name": item.get("name") or profile_id or "Unavailable profile",
                        "source": "admin",
                        "available": False,
                    }
                )
                continue
            for model_id in item.get("model_ids") or []:
                model = _model_by_id(profile, str(model_id))
                result[capability].append(
                    {
                        "profile_id": profile_id,
                        "model_id": str(model_id),
                        "name": (model or {}).get("name") or str(model_id),
                        "model": (model or {}).get("model") or "",
                        "source": "admin",
                        "available": model is not None,
                    }
                )
    if user_id == user.id:
        # Only ever the caller's OWN personal models. An administrator
        # inspecting somebody's grants asks for that user's id, and their
        # personal sign-in is not the administrator's business — nor is it in
        # the grant editor's gift to assign.
        from .personal_models import personal_llm_rows

        result["llm"].extend(personal_llm_rows())
    return result


def allowed_imagegen_options() -> dict[str, Any]:
    """Return redacted image profiles/models usable by the current account."""
    user = get_current_user()
    catalog = admin_catalog()
    allowed = (
        None
        if user.is_admin
        else {
            (str(item.get("profile_id") or ""), str(item.get("model_id") or ""))
            for item in redacted_model_access(user.id).get("imagegen", [])
            if item.get("available")
        }
    )
    options: list[dict[str, Any]] = []
    state = catalog.get("services", {}).get("imagegen", {})
    for profile in state.get("profiles", []) or []:
        for model in profile.get("models", []) or []:
            key = (str(profile.get("id") or ""), str(model.get("id") or ""))
            if allowed is not None and key not in allowed:
                continue
            options.append(
                {
                    "profile_id": key[0],
                    "model_id": key[1],
                    "profile_name": profile.get("name") or key[0],
                    "model_name": model.get("name") or model.get("model") or key[1],
                    "model": model.get("model") or "",
                    "provider": profile.get("binding") or "openai",
                    "capabilities": model.get("capabilities") or {},
                    "defaults": {
                        name: model.get(name) or ""
                        for name in (
                            "size",
                            "quality",
                            "style",
                            "response_format",
                            "aspect_ratio",
                            "image_size",
                            "background",
                            "compression",
                        )
                    },
                    "is_active_default": (
                        key[0] == str(state.get("active_profile_id") or "")
                        and key[1] == str(state.get("active_model_id") or "")
                    ),
                }
            )
    return {
        "active": next((row for row in options if row["is_active_default"]), None),
        "options": options,
    }


def allowed_videogen_options() -> dict[str, Any]:
    """Return redacted video profiles/models usable by the current account."""
    user = get_current_user()
    catalog = admin_catalog()
    allowed = (
        None
        if user.is_admin
        else {
            (str(item.get("profile_id") or ""), str(item.get("model_id") or ""))
            for item in redacted_model_access(user.id).get("videogen", [])
            if item.get("available")
        }
    )
    state = catalog.get("services", {}).get("videogen", {})
    options: list[dict[str, Any]] = []
    for profile in state.get("profiles", []) or []:
        for model in profile.get("models", []) or []:
            key = (str(profile.get("id") or ""), str(model.get("id") or ""))
            if allowed is not None and key not in allowed:
                continue
            capabilities = dict(model.get("capabilities") or {})
            capabilities.setdefault("operations", ["text_to_video"])
            capabilities.setdefault("reference_modes", ["first", "last", "multi", "universal"])
            capabilities.setdefault("durations", [])
            capabilities.setdefault("resolutions", [])
            capabilities.setdefault("aspect_ratios", [])
            capabilities.setdefault("fps", [])
            capabilities.setdefault("audio_modes", ["none"])
            capabilities.setdefault("max_inputs", {"image": 0, "video": 0, "audio": 0, "total": 0})
            capabilities.setdefault("max_prompt_length", 20_000)
            capabilities.setdefault("max_input_bytes", 64 * 1024 * 1024)
            capabilities.setdefault(
                "parameter_schema",
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "duration": {"type": ["number", "string"]},
                        "aspect_ratio": {"type": "string"},
                        "resolution": {"type": "string"},
                        "fps": {"type": "number"},
                        "audio_mode": {"type": "string"},
                        "reference_mode": {"type": "string"},
                        "seed": {"type": "integer"},
                    },
                },
            )
            effective_adapter = str(model.get("adapter") or profile.get("adapter") or "").lower()
            is_openai_videos = effective_adapter == "openai_videos" or (
                not effective_adapter and str(profile.get("binding") or "").lower() == "openai"
            )
            if is_openai_videos:
                # DELETE removes a stored video object; it is not documented as
                # an upstream in-flight cancellation guarantee.
                capabilities["supports_cancel"] = False
            option = {
                "profile_id": key[0],
                "model_id": key[1],
                "profile_name": profile.get("name") or key[0],
                "model_name": model.get("name") or model.get("model") or key[1],
                "model": model.get("model") or "",
                "provider": profile.get("binding") or "async_task",
                "adapter": model.get("adapter") or profile.get("adapter") or "",
                "capabilities": capabilities,
                "defaults": {
                    name: model.get(name) or ""
                    for name in (
                        "duration",
                        "aspect_ratio",
                        "resolution",
                        "fps",
                        "audio_mode",
                    )
                },
                "is_active_default": (
                    key[0] == str(state.get("active_profile_id") or "")
                    and key[1] == str(state.get("active_model_id") or "")
                ),
            }
            if is_openai_videos:
                option["lifecycle"] = {
                    "status": "deprecated",
                    "shutdown_date": "2026-09-24",
                    "message": "OpenAI Videos API is scheduled to shut down on September 24, 2026.",
                }
            options.append(option)
    active = next((row for row in options if row["is_active_default"]), None)
    return {
        "active": active,
        "selected": (
            f"{active['profile_id']}:{active['model_id']}" if active is not None else None
        ),
        "options": options,
    }


def allowed_llm_options() -> dict[str, Any]:
    user = get_current_user()
    if user.is_admin:
        return list_llm_options(admin_catalog())
    options = [
        {
            "profile_id": item.get("profile_id"),
            "model_id": item.get("model_id"),
            "profile_name": item.get("name") or item.get("profile_id") or "LLM",
            "model_name": item.get("name") or item.get("model") or item.get("model_id"),
            "label": item.get("name") or item.get("model") or item.get("model_id"),
            "model": item.get("model") or "",
            "provider": "",
            "source": item.get("source") or "admin",
            "is_active_default": False,
        }
        for item in redacted_model_access(user.id).get("llm", [])
        if item.get("available")
    ]
    # Loopback runtimes are machine-local, not grant-assigned. Merge them so a
    # non-admin picker still matches what apply_llm_selection_to_catalog accepts.
    from knorvia.services.model_selection.local_models import (
        merge_local_options,
        probe_loaded_local_models,
    )

    local = [{**item, "source": "local"} for item in probe_loaded_local_models()]
    return {"active": None, "options": merge_local_options(options, local)}


def has_capability_access(capability: str, user_id: str | None = None) -> bool:
    """Whether the user has at least one usable model for ``capability``.

    Admins are never gated — they manage the catalog directly. For ordinary
    users this mirrors exactly what ``redacted_model_access`` exposes to the
    frontend, so the server-side gate and the UI lock always agree.
    """
    user = get_current_user()
    if user.is_admin:
        return True
    if user_id is None:
        user_id = user.id
    items = redacted_model_access(user_id).get(capability, []) or []
    return any(item.get("available") for item in items)


def apply_allowed_llm_selection(selection: dict[str, Any] | None) -> dict[str, Any] | None:
    """Allow only admin-granted LLM profile/model selections for ordinary users."""
    user = get_current_user()
    if user.is_admin or not selection:
        return selection
    profile_id = str(selection.get("profile_id") or "")
    model_id = str(selection.get("model_id") or "")
    from knorvia.services.model_selection.local_models import is_local_profile_id

    if is_local_profile_id(profile_id) and model_id:
        return selection
    for item in redacted_model_access(user.id).get("llm", []):
        if item.get("profile_id") == profile_id and item.get("model_id") == model_id:
            return selection
    raise PermissionError("This model is not assigned to your account.")
