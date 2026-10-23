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

import { isAbsolute, resolve } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/**
 * Accepted `serverName` shape. Identical to the mcp-client contract because
 * these names become model-facing tool prefixes (`mcp__<serverName>__<tool>`).
 * An invalid key is reported and skipped — never silently renamed, so a typo in
 * the workspace file cannot silently change a tool name a permission rule or a
 * session history already refers to.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Caller settings that influence how the document is translated. */
export interface WorkspaceMcpOptions {
  /** Absolute workspace root; relative stdio `cwd` values resolve against it. */
  root: string
  /** Whether stdio servers may be mounted at all (arbitrary local command execution). */
  allowStdio: boolean
  /**
   * When non-empty, a stdio `command` must exactly match one entry or live
   * below one entry (an entry ending in a path separator already lives below
   * it). Entries are compared verbatim; this is a guard rail, not a sandbox.
   */
  stdioAllowlist: readonly string[]
  /** Per-call timeout forwarded to every server unless the entry overrides it. */
  toolCallTimeoutMs?: number | undefined
}

/** One server that was skipped, with a human-readable reason. */
export interface WorkspaceMcpProblem {
  /** Server key (or `mcpServers[<index>]` for an unnamed array entry). */
  server: string
  message: string
}

/** Result of translating one declaration document. */
export interface ParsedWorkspaceMcp {
  /** Validated configs, ready to mount, in declaration order. */
  configs: McpClient.Config[]
  /** Skipped servers; the caller logs these so a broken entry is visible. */
  problems: WorkspaceMcpProblem[]
}

/** A whole-document failure: invalid JSON, wrong shape, missing `mcpServers`. */
export class WorkspaceMcpFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMcpFileError'
  }
}

/** Minimal session-header shape this plugin depends on (see `SessionHeader`). */
export interface WorkspaceMcpSessionHeader {
  readonly cwd?: string | undefined
  readonly parentSession?: unknown
  readonly origin?: 'subagent' | undefined
}

/**
 * Choose the workspace root for one session from the immutable session header.
 *
 * `header.cwd` is the directory the session was created in and never changes,
 * so an in-session `cd` cannot move the plugin to another workspace. Only a
 * session without a recorded project directory falls back to the deployment
 * default directory (and finally the host process directory).
 */
export function resolveWorkspaceRoot(cwd: string | undefined, defaultDirectory: string | undefined): string {
  const chosen = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : defaultDirectory
  return resolve(typeof chosen === 'string' && chosen.trim().length > 0 ? chosen : process.cwd())
}

/** Whether a session is a subagent child (`origin`/`parentSession` lineage). */
export function isSubagentHeader(header: WorkspaceMcpSessionHeader): boolean {
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * Translate one workspace declaration file.
 *
 * @param text - file contents (already read by the caller).
 * @param options - workspace root and mount policy.
 * @returns validated configs plus per-server problems.
 * @throws {@link WorkspaceMcpFileError} when the document itself is unusable.
 */
export function parseWorkspaceMcpDocument(text: string, options: WorkspaceMcpOptions): ParsedWorkspaceMcp {
  // Windows editors love a UTF-8 BOM; JSON.parse rejects it as an unexpected token.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let document: unknown
  try {
    document = JSON.parse(source)
  } catch (error: unknown) {
    throw new WorkspaceMcpFileError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(document)) throw new WorkspaceMcpFileError('top level must be a JSON object')
  if (!('mcpServers' in document)) {
    throw new WorkspaceMcpFileError('missing "mcpServers" object (an empty file is not a valid declaration)')
  }
  const entries = declarationEntries(document.mcpServers)
  const configs: McpClient.Config[] = []
  const problems: WorkspaceMcpProblem[] = []
  for (const entry of entries) {
    if (!SERVER_NAME_PATTERN.test(entry.server)) {
      problems.push({
        server: entry.label,
        message: `server name ${JSON.stringify(entry.server)} must match ${SERVER_NAME_PATTERN.source}`,
      })
      continue
    }
    if (!isRecord(entry.value)) {
      problems.push({ server: entry.label, message: 'server declaration must be a JSON object' })
      continue
    }
    const config = buildClientConfig(entry.server, entry.label, entry.value, options, problems)
    if (config !== undefined) configs.push(config)
  }
  return { configs, problems }
}

/** One entry of `mcpServers`, normalized across the object and array shapes. */
interface DeclarationEntry {
  server: string
  label: string
  value: unknown
}

function declarationEntries(servers: unknown): DeclarationEntry[] {
  if (Array.isArray(servers)) {
    return servers.map((value, index) => {
      const label = `mcpServers[${index}]`
      const name = isRecord(value) && typeof value.name === 'string' ? value.name : ''
      return { server: name, label: name.length > 0 ? name : label, value }
    })
  }
  if (isRecord(servers)) {
    return Object.entries(servers).map(([server, value]) => ({ server, label: `mcpServers.${server}`, value }))
  }
  throw new WorkspaceMcpFileError('"mcpServers" must be an object or an array')
}

/** Validate one server entry; append a problem and return `undefined` when invalid. */
function buildClientConfig(
  serverName: string,
  label: string,
  raw: Record<string, unknown>,
  options: WorkspaceMcpOptions,
  problems: WorkspaceMcpProblem[],
): McpClient.Config | undefined {
  const declaredTransport = raw.type ?? raw.transport
  if (declaredTransport !== undefined && typeof declaredTransport !== 'string') {
    problems.push({ server: label, message: '"type" must be a string ("stdio" or "http")' })
    return undefined
  }
  let transport: 'stdio' | 'http'
  if (typeof declaredTransport === 'string') {
    const normalized = declaredTransport.toLowerCase()
    if (normalized === 'stdio') transport = 'stdio'
    else if (normalized === 'http' || normalized === 'streamable-http') transport = 'http'
    else {
      problems.push({
        server: label,
        message: `unsupported transport ${JSON.stringify(declaredTransport)} (expected "stdio" or "http"; SSE is not supported)`,
      })
      return undefined
    }
  } else if (typeof raw.url === 'string') transport = 'http'
  else if (typeof raw.command === 'string') transport = 'stdio'
  else {
    problems.push({ server: label, message: 'missing "command" (stdio) or "url" (http)' })
    return undefined
  }

  const optional = forwardedFields(raw, options)
  if (transport === 'stdio') {
    if (!options.allowStdio) {
      problems.push({
        server: label,
        message: 'stdio transport is disabled by the plugin config (allowStdio: false); enable it in the profile patch to allow local MCP commands',
      })
      return undefined
    }
    if (typeof raw.command !== 'string' || raw.command.length === 0) {
      problems.push({ server: label, message: '"command" must be a non-empty string' })
      return undefined
    }
    const command = raw.command
    if (!commandAllowed(command, options.stdioAllowlist)) {
      problems.push({
        server: label,
        message: `command ${JSON.stringify(command)} is not covered by the configured stdioAllowlist`,
      })
      return undefined
    }
    const args = stringArray(raw.args, label, '"args"', problems)
    if (args === undefined) return undefined
    const env = stringRecord(raw.env, label, '"env"', problems)
    if (env === undefined) return undefined
    const cwd = stdioCwd(raw.cwd, label, options.root, problems)
    if (cwd === undefined) return undefined
    const config = validateClientConfig(
      label,
      () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command,
        args,
        env,
        cwd,
        failOnStartupError: false,
        ...optional,
      }),
      problems,
    )
    if (config === undefined || config.transport !== 'stdio') return undefined
    // Re-attach the null-prototype records: mcp-client's schema returns plain
    // objects, and `__proto__`-named environment entries must stay data.
    return { ...config, env }
  }

  if (typeof raw.url !== 'string' || raw.url.length === 0) {
    problems.push({ server: label, message: '"url" must be a non-empty string' })
    return undefined
  }
  const url = raw.url
  if (!isHttpUrl(url)) {
    problems.push({ server: label, message: `"url" must be an absolute HTTP(S) URL, got ${JSON.stringify(url)}` })
    return undefined
  }
  const headers = stringRecord(raw.headers, label, '"headers"', problems)
  if (headers === undefined) return undefined
  const config = validateClientConfig(
    label,
    () => McpClient.Config({
      transport: 'streamable-http',
      serverName,
      url,
      headers,
      failOnStartupError: false,
      ...optional,
    }),
    problems,
  )
  if (config === undefined || config.transport !== 'streamable-http') return undefined
  return { ...config, headers }
}

/** Forward per-server tuning fields unchanged; mcp-client validates their shape. */
function forwardedFields(
  raw: Record<string, unknown>,
  options: WorkspaceMcpOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const toolCallTimeoutMs = raw.toolCallTimeoutMs ?? options.toolCallTimeoutMs
  if (toolCallTimeoutMs !== undefined) result.toolCallTimeoutMs = toolCallTimeoutMs
  if (raw.maxInstructionBytes !== undefined) result.maxInstructionBytes = raw.maxInstructionBytes
  if (raw.reconnect !== undefined) result.reconnect = raw.reconnect
  return result
}

/** Run mcp-client's own schema; a rejection becomes a skipped-server problem. */
function validateClientConfig(
  label: string,
  parse: () => McpClient.Config,
  problems: WorkspaceMcpProblem[],
): McpClient.Config | undefined {
  try {
    return parse()
  } catch (error: unknown) {
    problems.push({
      server: label,
      message: `invalid mcp-client config: ${error instanceof Error ? error.message : String(error)}`,
    })
    return undefined
  }
}

function commandAllowed(command: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  for (const entry of allowlist) {
    if (entry.length === 0) continue
    if (command === entry) return true
    if (!command.startsWith(entry)) continue
    if (entry.endsWith('/') || entry.endsWith('\\')) return true
    const next = command.charAt(entry.length)
    if (next === '/' || next === '\\') return true
  }
  return false
}

function stdioCwd(
  value: unknown,
  label: string,
  root: string,
  problems: WorkspaceMcpProblem[],
): string | undefined {
  if (value === undefined) return root
  if (typeof value !== 'string') {
    problems.push({ server: label, message: '"cwd" must be a string' })
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return root
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
}

function stringArray(
  value: unknown,
  label: string,
  field: string,
  problems: WorkspaceMcpProblem[],
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    problems.push({ server: label, message: `${field} must be an array of strings` })
    return undefined
  }
  return value as string[]
}

function stringRecord(
  value: unknown,
  label: string,
  field: string,
  problems: WorkspaceMcpProblem[],
): Record<string, string> | undefined {
  if (value === undefined) return Object.create(null) as Record<string, string>
  if (!isRecord(value)) {
    problems.push({ server: label, message: `${field} must be an object of strings` })
    return undefined
  }
  const result = Object.create(null) as Record<string, string>
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      problems.push({ server: label, message: `${field}.${key} must be a string` })
      return undefined
    }
    result[key] = item
  }
  return result
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
