from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from typing import Any
from uuid import uuid4

from knorvia.services.path_service import get_path_service

from .embedding_endpoint import normalize_embedding_endpoint_for_display

# Fallback only — frozen at admin scope at import time. Production code should
# enter through ``get_model_catalog_service()`` so the path is resolved from the
# current user's PathService on every call.
CATALOG_PATH = get_path_service().get_settings_file("model_catalog")


def _service_shell() -> dict[str, Any]:
    return {
        "active_profile_id": None,
        "active_model_id": None,
        "profiles": [],
    }


def _search_shell() -> dict[str, Any]:
    return {
        "active_profile_id": None,
        "profiles": [],
    }


def _default_catalog() -> dict[str, Any]:
    return {
        "version": 2,
        "connections": [],
        "services": {
            "llm": _service_shell(),
            "embedding": _service_shell(),
            "search": _search_shell(),
            "tts": _service_shell(),
            "stt": _service_shell(),
            "imagegen": _service_shell(),
            "videogen": _service_shell(),
        },
    }


class ModelCatalogService:
    _instances: dict[str, "ModelCatalogService"] = {}

    def __init__(self, path: Path | None = None):
        self.path = path or CATALOG_PATH
        self._lock = threading.RLock()
        # mtime-guarded load cache (see load()): every admin settings poll and
        # every turn validation used to re-read + re-normalize the catalog and
        # could even rewrite it. Any write to the file changes mtime/size, so
        # a stale entry can never be served; callers still get a deepcopy.
        self._cache_stat: tuple[int, int] | None = None
        self._cache_catalog: dict[str, Any] | None = None

    def _stat_key(self) -> tuple[int, int] | None:
        try:
            stat = self.path.stat()
        except OSError:
            return None
        return (stat.st_mtime_ns, stat.st_size)

    @classmethod
    def get_instance(cls, path: Path | None = None) -> "ModelCatalogService":
        resolved = (path or get_path_service().get_settings_file("model_catalog")).resolve()
        key = str(resolved)
        if key not in cls._instances:
            cls._instances[key] = cls(resolved)
        return cls._instances[key]

    def load(self) -> dict[str, Any]:
        with self._lock:
            stat_key = self._stat_key()
            if (
                stat_key is not None
                and self._cache_stat == stat_key
                and self._cache_catalog is not None
            ):
                return deepcopy(self._cache_catalog)

            loaded = self._read_existing_catalog()
            if loaded:
                legacy_version = int(loaded.get("version") or 1)
                catalog = _default_catalog()
                catalog.update({k: v for k, v in loaded.items() if k != "services"})
                catalog["services"].update(loaded.get("services", {}))
                merged_defaults = catalog != loaded
                before = deepcopy(catalog)
                self._normalize(catalog)
                if merged_defaults or catalog != before:
                    if legacy_version < 2:
                        self._backup_legacy_catalog()
                    self.save(catalog)
            else:
                catalog = _default_catalog()
                self._normalize(catalog)
                self.save(catalog)

            self._cache_stat = self._stat_key()
            self._cache_catalog = deepcopy(catalog)
            return catalog

    def _read_existing_catalog(self) -> dict[str, Any]:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return {}
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def _backup_legacy_catalog(self) -> None:
        """Keep one recovery copy before the additive v1 → v2 migration."""
        if not self.path.exists():
            return
        backup = self.path.with_name(f"{self.path.stem}.v1.backup{self.path.suffix}")
        if not backup.exists():
            shutil.copy2(self.path, backup)

    def save(self, catalog: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            normalized = deepcopy(catalog)
            self._normalize(normalized)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
            )
            temp_path = Path(temp_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(normalized, handle, indent=2, ensure_ascii=False)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, self.path)
            finally:
                temp_path.unlink(missing_ok=True)
            return normalized

    def update(self, mutator: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self._lock:
            catalog = self.load()
            mutator(catalog)
            return self.save(catalog)

    def apply(self, catalog: dict[str, Any] | None = None) -> dict[str, Any]:
        current = self.save(catalog or self.load())
        return {"catalog_path": str(self.path), "services": list(current.get("services", {}))}

    def _normalize(self, catalog: dict[str, Any]) -> bool:
        if int(catalog.get("version") or 1) < 2:
            catalog["version"] = 2
        connections = catalog.setdefault("connections", [])
        if not isinstance(connections, list):
            connections = catalog["connections"] = []
        connection_by_id = {
            str(item.get("id") or ""): item
            for item in connections
            if isinstance(item, dict) and item.get("id")
        }
        services = catalog.setdefault("services", {})
        changed = False
        services.setdefault("llm", _service_shell())
        services.setdefault("embedding", _service_shell())
        services.setdefault("search", _search_shell())
        services.setdefault("tts", _service_shell())
        services.setdefault("stt", _service_shell())
        services.setdefault("imagegen", _service_shell())
        services.setdefault("videogen", _service_shell())
        for service_name in ("llm", "embedding", "search", "tts", "stt", "imagegen", "videogen"):
            service = services[service_name]
            profiles = service.setdefault("profiles", [])
            for profile in profiles:
                profile.setdefault("id", f"{service_name}-profile-{uuid4().hex[:8]}")
                profile.setdefault("name", "Untitled Profile")
                profile.setdefault("api_version", "")
                profile.setdefault("base_url", "")
                profile.setdefault("api_key", "")
                if service_name == "search":
                    profile.setdefault("provider", "brave")
                    profile.setdefault("proxy", "")
                    profile["models"] = []
                else:
                    profile.setdefault("binding", "openai")
                    profile.setdefault("extra_headers", {})
                    connection_id = str(profile.get("connection_id") or "")
                    inline_connection = {
                        "provider": str(profile.get("binding") or "openai"),
                        "base_url": str(profile.get("base_url") or ""),
                        "api_key": str(profile.get("api_key") or ""),
                        "api_version": str(profile.get("api_version") or ""),
                        "extra_headers": profile.get("extra_headers") or {},
                    }
                    if not connection_id:
                        connection_payload = inline_connection
                        if any(
                            connection_payload[key]
                            for key in ("base_url", "api_key", "api_version", "extra_headers")
                        ):
                            fingerprint = json.dumps(
                                connection_payload, ensure_ascii=False, sort_keys=True
                            ).encode("utf-8")
                            connection_id = (
                                f"connection-{hashlib.sha256(fingerprint).hexdigest()[:12]}"
                            )
                            profile["connection_id"] = connection_id
                            if connection_id not in connection_by_id:
                                connection = {
                                    "id": connection_id,
                                    "name": profile.get("name") or connection_payload["provider"],
                                    **connection_payload,
                                }
                                connections.append(connection)
                                connection_by_id[connection_id] = connection
                            changed = True
                    if service_name == "embedding":
                        models = profile.setdefault("models", [])
                        active_model_id = service.get("active_model_id")
                        active_model = next(
                            (item for item in models if item.get("id") == active_model_id),
                            models[0] if models else {},
                        )
                        before = str(profile.get("base_url") or "")
                        after = normalize_embedding_endpoint_for_display(
                            profile.get("binding"),
                            before,
                            model=active_model.get("model"),
                        )
                        if after != before:
                            profile["base_url"] = after
                            changed = True
                    else:
                        models = profile.setdefault("models", [])
                    for model in models:
                        model.setdefault("id", f"{service_name}-model-{uuid4().hex[:8]}")
                        model.setdefault("name", model.get("model") or "Untitled Model")
                        model.setdefault("model", "")
                        if service_name == "embedding":
                            # Empty default → test_runner auto-fills from the
                            # actual API response on first connection test.
                            model.setdefault("dimension", "")
                            # CSV of supported dims discovered during the last
                            # successful "Test connection" — drives the UI
                            # dropdown. Empty when the model is not in any
                            # adapter's MODELS_INFO map.
                            model.setdefault("supported_dimensions", "")
                        elif service_name == "tts":
                            # Provider/model-specific free-form voice string
                            # (e.g. "alloy", "autumn", "model:voice").
                            model.setdefault("voice", "")
                            # §Phase D4: gateway-advertised custom voice ids
                            # surfaced by GET /api/v1/voice/voices.
                            model.setdefault("custom_voices", [])
                            model.setdefault("response_format", "mp3")
                        elif service_name == "imagegen":
                            # Generation knobs; empty → provider default.
                            model.setdefault("size", "")
                            model.setdefault("quality", "")
                            model.setdefault("style", "")
                            model.setdefault("response_format", "")
                            model.setdefault("adapter", "")
                            model.setdefault("aspect_ratio", "")
                            model.setdefault("image_size", "")
                            model.setdefault("background", "")
                            model.setdefault("compression", "")
                            model.setdefault(
                                "capabilities",
                                {
                                    "operations": ["generate"],
                                    "max_inputs": 0,
                                    "max_outputs": 4,
                                    "supports_mask": False,
                                    "supports_streaming": False,
                                    "supports_context": False,
                                    "input_formats": ["image/png", "image/jpeg", "image/webp"],
                                },
                            )
                            capabilities = model.get("capabilities") or {}
                            model_name = str(model.get("model") or "").lower()
                            binding = str(profile.get("binding") or "").lower()
                            adapter = str(model.get("adapter") or "").lower()
                            if (
                                "gpt-image" in model_name
                                and binding in {"openai", "azure", "azure_openai", "custom"}
                                and capabilities.get("operations") == ["generate"]
                            ):
                                capabilities.update(
                                    {
                                        "operations": ["generate", "edit", "inpaint"],
                                        "max_inputs": 4,
                                        "supports_mask": True,
                                    }
                                )
                                model["capabilities"] = capabilities
                                changed = True
                            if binding == "gemini" and capabilities.get("operations") == [
                                "generate"
                            ]:
                                capabilities.update(
                                    {
                                        "operations": ["generate", "edit"],
                                        "max_inputs": 3,
                                        "supports_context": True,
                                    }
                                )
                                model["capabilities"] = capabilities
                                changed = True
                            if adapter == "openai_responses" and capabilities.get("operations") == [
                                "generate"
                            ]:
                                capabilities.update(
                                    {
                                        "operations": ["generate", "edit"],
                                        "max_inputs": 4,
                                        "supports_context": True,
                                    }
                                )
                                model["capabilities"] = capabilities
                                changed = True
                            if "parameters" not in capabilities:
                                if binding == "gemini":
                                    capabilities["parameters"] = ["n", "aspect_ratio", "image_size"]
                                elif adapter == "openai_responses":
                                    capabilities["parameters"] = [
                                        "n",
                                        "size",
                                        "quality",
                                        "output_format",
                                        "background",
                                        "compression",
                                    ]
                                else:
                                    capabilities["parameters"] = [
                                        "n",
                                        "size",
                                        "quality",
                                        "style",
                                        "output_format",
                                    ]
                                model["capabilities"] = capabilities
                                changed = True
                        elif service_name == "videogen":
                            model.setdefault("aspect_ratio", "")
                            model.setdefault("duration", "")
                            model.setdefault("resolution", "")
                            model.setdefault("fps", "")
                            model.setdefault("audio_mode", "")
                            model.setdefault("adapter", "")
                            model.setdefault(
                                "capabilities",
                                {
                                    "operations": ["text_to_video"],
                                    "reference_modes": [],
                                    "durations": [],
                                    "resolutions": [],
                                    "aspect_ratios": [],
                                    "fps": [],
                                    "audio_modes": ["none"],
                                    "max_inputs": {
                                        "image": 0,
                                        "video": 0,
                                        "audio": 0,
                                        "total": 0,
                                    },
                                    "max_prompt_length": 20000,
                                    "max_input_bytes": 67108864,
                                    "supports_cancel": True,
                                    "parameter_schema": {
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
                                },
                            )
            profile_ids = {profile.get("id") for profile in profiles}
            if profiles and service.get("active_profile_id") not in profile_ids:
                service["active_profile_id"] = profiles[0]["id"]
                changed = True
            if service_name in {"llm", "embedding", "tts", "stt", "imagegen", "videogen"}:
                active_profile = self.get_active_profile(catalog, service_name)
                models = (active_profile or {}).get("models") or []
                model_ids = {model.get("id") for model in models}
                if models and service.get("active_model_id") not in model_ids:
                    service["active_model_id"] = models[0]["id"]
                    changed = True
        return changed

    @staticmethod
    def get_profile_connection(
        catalog: dict[str, Any], profile: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Resolve a shared connection, falling back to legacy inline fields."""
        profile = profile or {}
        connection_id = str(profile.get("connection_id") or "")
        for item in catalog.get("connections", []) or []:
            if isinstance(item, dict) and str(item.get("id") or "") == connection_id:
                return item
        return profile

    def get_active_profile(
        self, catalog: dict[str, Any], service_name: str
    ) -> dict[str, Any] | None:
        service = catalog.get("services", {}).get(service_name, {})
        active_id = service.get("active_profile_id")
        for profile in service.get("profiles", []):
            if profile.get("id") == active_id:
                return profile
        profiles = service.get("profiles", [])
        return profiles[0] if profiles else None

    def get_active_model(self, catalog: dict[str, Any], service_name: str) -> dict[str, Any] | None:
        if service_name == "search":
            return None
        service = catalog.get("services", {}).get(service_name, {})
        active_model_id = service.get("active_model_id")
        profile = self.get_active_profile(catalog, service_name)
        if not profile:
            return None
        for model in profile.get("models", []):
            if model.get("id") == active_model_id:
                return model
        models = profile.get("models", [])
        return models[0] if models else None


def get_model_catalog_service() -> ModelCatalogService:
    try:
        from knorvia.multi_user.context import get_current_user
        from knorvia.multi_user.paths import get_admin_path_service

        if not get_current_user().is_admin:
            return ModelCatalogService.get_instance(
                get_admin_path_service().get_settings_file("model_catalog")
            )
    except Exception:
        pass
    return ModelCatalogService.get_instance(get_path_service().get_settings_file("model_catalog"))


__all__ = ["CATALOG_PATH", "ModelCatalogService", "get_model_catalog_service"]
