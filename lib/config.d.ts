/**
 * Parse a workspace MCP declaration file (`.dsh/mcp.json`, or any configured
 * file name) into validated `@deepseek-ai/dsh-mcp-client` configs.
 *
 * This module deliberately has no Cordis, filesystem, or logging dependency:
 * the caller reads the file and logs the returned problems, so every rule here
 * is directly unit-testable. Whole-document failures throw
 * {@link WorkspaceMcpFileError}; one bad server never fails the others — it is
 * reported in {@link ParsedWorkspaceMcp.problems} and skipped.
 *
 * Accepted document shapes (both are common in the MCP ecosystem):
 *
 * ```jsonc
 * // Claude Code / Cursor style — object keyed by server name
 * { "mcpServers": { "docs": { "type": "http", "url": "http://127.0.0.1:3456/mcp" } } }
 *
 * // ACP style — array with an explicit name field
 * { "mcpServers": [ { "name": "docs", "type": "http", "url": "http://127.0.0.1:3456/mcp" } ] }
 * ```
 *
 * @module @jinngoo/dsh-workspace-mcp/config
 */
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
/**
 * Accepted `serverName` shape. Identical to the mcp-client contract because
 * these names become model-facing tool prefixes (`mcp__<serverName>__<tool>`).
 * An invalid key is reported and skipped — never silently renamed, so a typo in
 * the workspace file cannot silently change a tool name a permission rule or a
 * session history already refers to.
 */
export declare const SERVER_NAME_PATTERN: RegExp;
/** Caller settings that influence how the document is translated. */
export interface WorkspaceMcpOptions {
    /** Absolute workspace root; relative stdio `cwd` values resolve against it. */
    root: string;
    /** Whether stdio servers may be mounted at all (arbitrary local command execution). */
    allowStdio: boolean;
    /**
     * When non-empty, a stdio `command` must exactly match one entry or live
     * below one entry (an entry ending in a path separator already lives below
     * it). Entries are compared verbatim; this is a guard rail, not a sandbox.
     */
    stdioAllowlist: readonly string[];
    /** Per-call timeout forwarded to every server unless the entry overrides it. */
    toolCallTimeoutMs?: number | undefined;
}
/** One server that was skipped, with a human-readable reason. */
export interface WorkspaceMcpProblem {
    /** Server key (or `mcpServers[<index>]` for an unnamed array entry). */
    server: string;
    message: string;
}
/** Result of translating one declaration document. */
export interface ParsedWorkspaceMcp {
    /** Validated configs, ready to mount, in declaration order. */
    configs: McpClient.Config[];
    /** Skipped servers; the caller logs these so a broken entry is visible. */
    problems: WorkspaceMcpProblem[];
}
/** A whole-document failure: invalid JSON, wrong shape, missing `mcpServers`. */
export declare class WorkspaceMcpFileError extends Error {
    constructor(message: string);
}
/** Minimal session-header shape this plugin depends on (see `SessionHeader`). */
export interface WorkspaceMcpSessionHeader {
    readonly cwd?: string | undefined;
    readonly parentSession?: unknown;
    readonly origin?: 'subagent' | undefined;
}
/**
 * Choose the workspace root for one session from the immutable session header.
 *
 * `header.cwd` is the directory the session was created in and never changes,
 * so an in-session `cd` cannot move the plugin to another workspace. Only a
 * session without a recorded project directory falls back to the deployment
 * default directory (and finally the host process directory).
 */
export declare function resolveWorkspaceRoot(cwd: string | undefined, defaultDirectory: string | undefined): string;
/** Whether a session is a subagent child (`origin`/`parentSession` lineage). */
export declare function isSubagentHeader(header: WorkspaceMcpSessionHeader): boolean;
/**
 * Translate one workspace declaration file.
 *
 * @param text - file contents (already read by the caller).
 * @param options - workspace root and mount policy.
 * @returns validated configs plus per-server problems.
 * @throws {@link WorkspaceMcpFileError} when the document itself is unusable.
 */
export declare function parseWorkspaceMcpDocument(text: string, options: WorkspaceMcpOptions): ParsedWorkspaceMcp;
