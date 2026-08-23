"""Export Knorvia MCP servers into Claude Code / Codex CLI flags.

The chat agent already loads ``mcp.json`` plus the account's user-MCP
file. Connected CLI subagents (Claude Code, Codex) spawn as separate
processes and otherwise need those servers configured again. This module
is the shared conversion: same enabled servers, CLI-native config.
"""

from __future__ import annotations

import contextlib
import csv
import hashlib
import json
import logging
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
from typing import Any
from urllib.parse import urlsplit

from knorvia.services.mcp.config import MCPServerConfig

logger = logging.getLogger(__name__)


def collect_mcp_servers(*, owner_id: str | None = None) -> dict[str, MCPServerConfig]:
    """Materialize only MCP servers owned by this account.

    Deployment servers are intentionally absent: their per-tool grant is
    enforced inside Knorvia and cannot be delegated wholesale to another CLI.
    """

    servers: dict[str, MCPServerConfig] = {}
    if not owner_id:
        return servers
    try:
        from knorvia.services.mcp.manager import MCPConnectionManager
        from knorvia.services.mcp.user_config import load_user_mcp_config

        user_cfg, _rejected = load_user_mcp_config(owner_id)
        for name, cfg in user_cfg.servers.items():
            if not cfg.enabled:
                continue
            try:
                servers[name] = MCPConnectionManager._materialize(cfg, owner_id)
            except Exception:
                logger.warning("Could not materialize user MCP server %s", name, exc_info=True)
    except Exception:
        logger.debug("Could not load user MCP config for %s", owner_id, exc_info=True)
    return servers


def _skip_oauth_without_headers(cfg: MCPServerConfig) -> bool:
    return cfg.auth == "oauth" and not cfg.headers


def to_claude_mcp_config(servers: dict[str, MCPServerConfig]) -> dict[str, Any]:
    """Claude Code ``--mcp-config`` JSON: ``{"mcpServers": {...}}``."""
    payload: dict[str, Any] = {}
    for name, cfg in servers.items():
        if not cfg.enabled or _skip_oauth_without_headers(cfg):
            continue
        entry: dict[str, Any] = {}
        kind = cfg.resolved_type()
        if kind == "stdio":
            if not cfg.command:
                continue
            entry["command"] = cfg.command
            if cfg.args:
                entry["args"] = list(cfg.args)
            if cfg.env:
                entry["env"] = dict(cfg.env)
        elif kind == "sse":
            if not cfg.url:
                continue
            entry["type"] = "sse"
            entry["url"] = cfg.url
            if cfg.headers:
                entry["headers"] = dict(cfg.headers)
        else:
            if not cfg.url:
                continue
            entry["type"] = "http"
            entry["url"] = cfg.url
            if cfg.headers:
                entry["headers"] = dict(cfg.headers)
        payload[name] = entry
    return {"mcpServers": payload}


def write_claude_mcp_config(servers: dict[str, MCPServerConfig]) -> Path | None:
    """Write a temp Claude MCP file. Caller must unlink it after the CLI exits."""
    payload = to_claude_mcp_config(servers)
    if not payload["mcpServers"]:
        return None
    root = Path(tempfile.gettempdir()) / "knorvia-mcp"
    root.mkdir(parents=True, exist_ok=True)
    _restrict_private_path(root, directory=True)
    _cleanup_stale_configs(root)
    handle, raw = tempfile.mkstemp(prefix="knorvia-mcp-", suffix=".json", dir=root)
    path = Path(raw)
    try:
        _restrict_private_path(path, directory=False)
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    except Exception:
        with contextlib.suppress(OSError):
            os.close(handle)
        path.unlink(missing_ok=True)
        raise
    return path


def _restrict_private_path(path: Path, *, directory: bool) -> None:
    """Restrict secret-bearing temp paths to the current OS account."""

    os.chmod(path, stat.S_IRWXU if directory else stat.S_IRUSR | stat.S_IWUSR)
    if os.name != "nt":
        return
    try:
        # Resolve via SystemRoot instead of PATH so a hostile PATH entry cannot
        # shadow these system tools while they are granting file ACLs.
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        identity = subprocess.run(
            [str(system32 / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        row = next(csv.reader(identity.stdout.splitlines()))
        sid = row[1].strip() if len(row) > 1 else ""
        if not sid.startswith("S-"):
            raise ValueError("could not resolve current Windows SID")
        result = subprocess.run(
            [str(system32 / "icacls.exe"), str(path), "/inheritance:r", "/grant:r", f"*{sid}:(F)"],
            check=False,
            capture_output=True,
            timeout=5,
        )
        if result.returncode:
            raise OSError(f"icacls exited with status {result.returncode}")
    except Exception as exc:
        raise OSError(f"could not secure temporary MCP credentials: {exc}") from exc


def _cleanup_stale_configs(root: Path, *, max_age_s: float = 24 * 60 * 60) -> None:
    cutoff = time.time() - max_age_s
    for path in root.glob("knorvia-mcp-*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue


def _toml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_array(values: list[str]) -> str:
    return "[" + ", ".join(_toml_str(item) for item in values) + "]"


def _credential_env_name(server: str, field: str) -> str:
    digest = hashlib.sha256(f"{server}\0{field}".encode()).hexdigest()[:16].upper()
    return f"KNORVIA_MCP_{digest}"


def codex_mcp_overrides(
    servers: dict[str, MCPServerConfig],
) -> tuple[list[str], dict[str, str]]:
    """Return safe Codex config flags and an explicit credential environment."""

    args: list[str] = []
    env: dict[str, str] = {}
    for name, cfg in servers.items():
        if not cfg.enabled or _skip_oauth_without_headers(cfg):
            continue
        prefix = f"mcp_servers.{name}"
        kind = cfg.resolved_type()
        if kind == "stdio":
            # User-owned configs reject stdio. Keep a safe converter for tests
            # and future admin-only uses, but never put env values in argv.
            if not cfg.command or cfg.env:
                continue
            args += ["-c", f"{prefix}.command={_toml_str(cfg.command)}"]
            if cfg.args:
                args += ["-c", f"{prefix}.args={_toml_array(list(cfg.args))}"]
        else:
            # Query credentials cannot be represented by Codex without putting
            # the materialized URL in the process list, so fail closed.
            if not cfg.url or urlsplit(cfg.url).query:
                continue
            args += ["-c", f"{prefix}.url={_toml_str(cfg.url)}"]
            for key, value in cfg.headers.items():
                env_name = _credential_env_name(name, key)
                env[env_name] = value
                args += [
                    "-c",
                    f"{prefix}.env_http_headers.{_toml_str(key)}={_toml_str(env_name)}",
                ]
    return args, env


def codex_mcp_override_args(servers: dict[str, MCPServerConfig]) -> list[str]:
    """Compatibility wrapper returning only the non-secret argv portion."""

    return codex_mcp_overrides(servers)[0]


def current_mcp_owner_id() -> str | None:
    try:
        from knorvia.multi_user.context import get_current_user_or_none

        user = get_current_user_or_none()
    except Exception:
        return None
    return user.id if user is not None else None


__all__ = [
    "codex_mcp_override_args",
    "codex_mcp_overrides",
    "collect_mcp_servers",
    "current_mcp_owner_id",
    "to_claude_mcp_config",
    "write_claude_mcp_config",
]
