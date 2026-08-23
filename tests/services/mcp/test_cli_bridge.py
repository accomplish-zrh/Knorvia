"""Convert Knorvia MCP config into Claude / Codex CLI flags."""

from __future__ import annotations

from knorvia.services.mcp.cli_bridge import (
    codex_mcp_override_args,
    codex_mcp_overrides,
    collect_mcp_servers,
    to_claude_mcp_config,
    write_claude_mcp_config,
)
from knorvia.services.mcp.config import MCPConfig, MCPServerConfig


def test_claude_stdio_and_http_and_skips_oauth_without_headers():
    servers = {
        "fs": MCPServerConfig(command="npx", args=["-y", "files"], env={"TOKEN": "x"}),
        "docs": MCPServerConfig(
            url="https://mcp.example/mcp", headers={"Authorization": "Bearer a"}
        ),
        "needs_login": MCPServerConfig(url="https://oauth.example/mcp", auth="oauth"),
        "off": MCPServerConfig(command="echo", enabled=False),
    }
    payload = to_claude_mcp_config(servers)
    assert set(payload["mcpServers"]) == {"fs", "docs"}
    assert payload["mcpServers"]["fs"] == {
        "command": "npx",
        "args": ["-y", "files"],
        "env": {"TOKEN": "x"},
    }
    assert payload["mcpServers"]["docs"]["type"] == "http"
    assert payload["mcpServers"]["docs"]["url"] == "https://mcp.example/mcp"


def test_write_claude_mcp_config_round_trip(tmp_path, monkeypatch):
    from knorvia.services.mcp import cli_bridge

    monkeypatch.setattr(cli_bridge.tempfile, "gettempdir", lambda: str(tmp_path))
    servers = {"fs": MCPServerConfig(command="npx", args=["-y", "pkg"])}
    path = write_claude_mcp_config(servers)
    assert path is not None
    try:
        text = path.read_text(encoding="utf-8")
        assert '"mcpServers"' in text and '"fs"' in text
    finally:
        path.unlink(missing_ok=True)
    assert write_claude_mcp_config({}) is None


def test_codex_override_args():
    servers = {
        "fs": MCPServerConfig(command="npx", args=["-y", "pkg"]),
        "docs": MCPServerConfig(
            url="https://mcp.example/mcp", headers={"Authorization": "Bearer a"}
        ),
    }
    args, env = codex_mcp_overrides(servers)
    joined = " ".join(args)
    assert '-c mcp_servers.fs.command="npx"' in joined or 'mcp_servers.fs.command="npx"' in joined
    assert "mcp_servers.fs.args=" in joined
    assert 'mcp_servers.docs.url="https://mcp.example/mcp"' in joined
    assert 'mcp_servers.docs.env_http_headers."Authorization"=' in joined
    assert "Bearer a" not in joined
    assert list(env.values()) == ["Bearer a"]
    assert codex_mcp_override_args(servers) == args


def test_codex_overrides_fail_closed_for_query_secrets_and_quote_header_keys():
    servers = {
        "query": MCPServerConfig(url="https://mcp.example/mcp?token=secret"),
        "headers": MCPServerConfig(
            url="https://mcp.example/mcp",
            headers={'X-Key"\nmodel': "secret"},
        ),
    }
    args, env = codex_mcp_overrides(servers)
    joined = " ".join(args)
    assert "token=secret" not in joined
    assert "mcp_servers.query" not in joined
    assert "\n" not in joined
    assert "secret" not in joined
    assert list(env.values()) == ["secret"]


def test_collect_uses_only_enabled_materialized_owner_servers(monkeypatch):
    from knorvia.services.mcp import cli_bridge
    from knorvia.services.mcp.manager import MCPConnectionManager

    def fake_user(_owner):
        return MCPConfig(
            servers={
                "mine": MCPServerConfig(
                    url="https://u.example/mcp",
                    headers={"Authorization": "secret-ref"},
                ),
                "off": MCPServerConfig(url="https://off.example/mcp", enabled=False),
            }
        ), []

    monkeypatch.setattr(
        "knorvia.services.mcp.user_config.load_user_mcp_config",
        fake_user,
    )
    monkeypatch.setattr(
        MCPConnectionManager,
        "_materialize",
        staticmethod(
            lambda cfg, owner: cfg.model_copy(
                update={"headers": {"Authorization": f"materialized-for-{owner}"}}
            )
        ),
    )
    servers = collect_mcp_servers(owner_id="alice")
    assert set(servers) == {"mine"}
    assert servers["mine"].headers["Authorization"] == "materialized-for-alice"
    assert "off" not in servers
    assert collect_mcp_servers(owner_id=None) == {}
