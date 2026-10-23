/**
 * Workspace-level MCP configuration as one host-plane DSH row.
 *
 * DSH's configuration layers are profile bundles → profile `cordis.patch.yml`
 * → `$DSH_HOME/cordis.patch.yml` → `--patch`; none of them is scoped to a
 * workspace. This row fills that gap: on every `agent/created` it reads
 * `<session workspace root>/.dsh/mcp.json` and mounts each declared server as
 * an **Agent-scoped** `@deepseek-ai/dsh-mcp-client` instance, exactly like the
 * ACP bridge does. Tools therefore appear in that session only, named
 * `mcp__<serverName>__<tool>`, and are reclaimed with the Agent scope.
 *
 * Load-bearing choices (see README for the long form):
 *
 * 1. The workspace root is the immutable `session.header.cwd`, never the
 *    session's current directory — an in-session `cd` must not swap MCP servers.
 * 2. `agent/created` listeners are serial and awaited before the first turn, so
 *    the first model request already sees the tools. A slow server must not
 *    hold the session hostage: the whole mount is raced against
 *    `startupTimeoutMs`, after which the session continues and the mount keeps
 *    settling in the background.
 * 3. One broken entry is skipped with a log line; a broken file is logged and
 *    the session still starts. Nothing from this plugin is allowed to reject
 *    `agent/created`.
 * 4. stdio means arbitrary local command execution from a file that may arrive
 *    with a cloned repository, so it is opt-in (`allowStdio`, default false).
 *    HTTP-only workspaces work with zero configuration.
 * 5. Subagents inherit the parent's `cwd`; by default they do **not** remount
 *    the workspace's servers (`mountInSubagents: false`) to avoid a process or
 *    connection per delegated agent. Set it to true when delegated tasks need
 *    the same tools.
 *
 * @module @jinngoo/dsh-workspace-mcp
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "workspace-mcp";
/** Plugin configuration; also shown in the profile's loader config schema. */
export interface Config {
    /** Declaration file path, relative to the workspace root (absolute also accepted). */
    fileName: string;
    /** Watch the declaration file and remount live Agents after a change. */
    watch: boolean;
    /** Upper bound on waiting for initial connection + tool discovery per session. */
    startupTimeoutMs: number;
    /** Allow stdio servers (arbitrary local command execution). Default: false. */
    allowStdio: boolean;
    /** Optional guard rail for stdio commands; empty means any command once stdio is allowed. */
    stdioAllowlist: string[];
    /** Mount the workspace's servers for subagent children too. Default: false. */
    mountInSubagents: boolean;
    /** Default per-call MCP timeout forwarded to every server. */
    toolCallTimeoutMs?: number;
}
export declare const Config: z<Config>;
/**
 * Register the workspace-level MCP row.
 *
 * Everything is installed through `ctx.effect` / `ctx.on`, so unloading the
 * plugin row removes the listener, closes watchers, and unmounts the MCP
 * clients this plugin started; Agent-scoped clients otherwise unwind with
 * their Agent automatically.
 */
export declare function apply(ctx: Context, config: Config): void;
