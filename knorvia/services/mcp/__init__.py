"""MCP integration: deployment-global server registry + deferred tool adapters."""

from knorvia.services.mcp.cli_bridge import (
    collect_mcp_servers,
    to_claude_mcp_config,
)
from knorvia.services.mcp.config import (
    MCPConfig,
    MCPServerConfig,
    load_mcp_config,
    mcp_config_path,
    save_mcp_config,
)
from knorvia.services.mcp.manager import (
    MCPConnectionManager,
    MCPToolAdapter,
    get_mcp_manager,
    wrapped_tool_name,
)
from knorvia.services.mcp.network import validate_mcp_url
from knorvia.services.mcp.session_state import load_loaded_tools, record_loaded_tools

__all__ = [
    "MCPConfig",
    "MCPConnectionManager",
    "MCPServerConfig",
    "MCPToolAdapter",
    "collect_mcp_servers",
    "get_mcp_manager",
    "load_loaded_tools",
    "load_mcp_config",
    "mcp_config_path",
    "record_loaded_tools",
    "save_mcp_config",
    "to_claude_mcp_config",
    "validate_mcp_url",
    "wrapped_tool_name",
]
