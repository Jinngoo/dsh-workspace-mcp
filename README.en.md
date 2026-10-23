# @jinngoo/dsh-workspace-mcp

**In one line**: put a `.dsh/mcp.json` in any workspace and every DSH session in that workspace gets the declared MCP servers as session-scoped tools — no profile edits and no per-project profiles.

Tools keep the stable DSH / Claude Code naming contract: `mcp__<serverName>__<rawTool>`.

## How it works

On every `agent/created`, the plugin resolves the **immutable** session project directory (`agent.session.header.cwd`, never the session's current directory), reads `<workspace>/.dsh/mcp.json`, validates each entry into an `@deepseek-ai/dsh-mcp-client` config, and mounts each server with `agent.ctx.plugin(McpClient, config)` — the same call the ACP bridge uses. The MCP client and its tools live in the **Agent scope**: visible only to that session and reclaimed with it. The listener is serial and awaited by the Agent lifecycle, so the first turn already sees the tools; the whole mount is raced against `startupTimeoutMs` so a slow server cannot block session creation.

## Install

```
plugin_manager  action: install_bundle  target: D:\Work\GitHub\dsh-workspace-mcp
# or
dsh plugin --profile web add D:\Work\GitHub\dsh-workspace-mcp
```

The bundle's `cordis.patch.yml` inserts the row; the profile patch file needs no hand edits.

## Workspace declaration (`.dsh/mcp.json`)

```json
{
  "mcpServers": {
    "creator": { "type": "stdio", "command": "node", "args": ["D:/tools/creator-mcp/server.js"], "cwd": "." },
    "docs": { "type": "http", "url": "http://127.0.0.1:3456/mcp", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

An ACP-style array with explicit `name` is accepted too. `serverName` must match `^[A-Za-z0-9_-]{1,32}$`; an invalid name is reported and skipped, never silently renamed. `cwd` is resolved against the workspace root. A missing file means "no workspace MCP servers" and is silent. A broken file is logged and the session still starts; a broken entry is logged and skipped while the other servers mount.

## Plugin config

| key | default | meaning |
|---|---|---|
| `fileName` | `.dsh/mcp.json` | declaration path relative to the workspace root |
| `watch` | `false` | remount live sessions when the file changes (polling, 300 ms debounce) |
| `startupTimeoutMs` | `10000` | cap on initial connect + discovery; the session continues after it |
| `allowStdio` | **`false`** | allow stdio servers (a workspace file would run arbitrary local commands) |
| `stdioAllowlist` | `[]` | optional guard rail for stdio commands |
| `mountInSubagents` | **`false`** | also mount for subagent children |
| `toolCallTimeoutMs` | unset | default per-call MCP timeout |

## Security boundary

`.dsh/mcp.json` is a workspace file that may arrive with a cloned repository, so stdio is opt-in by default and HTTP should still be reviewed as untrusted input (SSRF, injected prompt text, credentials in `headers`). MCP tools go through the normal ToolRuntime permission flow — this plugin never bypasses it.

See the Chinese README (`README.md`) for the full design notes, verification checklist, and troubleshooting.
