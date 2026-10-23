import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SERVER_NAME_PATTERN,
  WorkspaceMcpFileError,
  isSubagentHeader,
  parseWorkspaceMcpDocument,
  resolveWorkspaceRoot,
  type WorkspaceMcpOptions,
} from '../src/config.js'

const root = resolve('virtual-workspace')

function parse(
  servers: unknown,
  overrides: Partial<WorkspaceMcpOptions> = {},
) {
  const text = JSON.stringify({ mcpServers: servers })
  return parseWorkspaceMcpDocument(text, { root, allowStdio: false, stdioAllowlist: [], ...overrides })
}

describe('parseWorkspaceMcpDocument', () => {
  it('translates a Claude Code style HTTP server', () => {
    const result = parse({
      docs: {
        type: 'http',
        url: 'http://127.0.0.1:3456/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    })
    expect(result.problems).toEqual([])
    expect(result.configs).toHaveLength(1)
    const config = result.configs[0]!
    expect(config.transport).toBe('streamable-http')
    expect(config.serverName).toBe('docs')
    expect(config.failOnStartupError).toBe(false)
    if (config.transport !== 'streamable-http') throw new Error('expected HTTP config')
    expect(config.url).toBe('http://127.0.0.1:3456/mcp')
    expect(config.headers).toEqual({ Authorization: 'Bearer token' })
    expect(Object.getPrototypeOf(config.headers)).toBeNull()
  })

  it('accepts the ACP array shape with explicit names', () => {
    const result = parse([
      { name: 'demo', url: 'http://localhost:1234/mcp' },
      { name: 'not-used-but-invalid' },
    ])
    expect(result.configs.map(config => config.serverName)).toEqual(['demo'])
    expect(result.problems.map(problem => problem.server)).toEqual(['not-used-but-invalid'])
  })

  it('resolves a relative stdio cwd against the workspace root and keeps env data', () => {
    const result = parse(
      {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          cwd: 'tools',
          env: { NODE_ENV: 'test' },
        },
      },
      { allowStdio: true },
    )
    expect(result.problems).toEqual([])
    const config = result.configs[0]!
    expect(config.transport).toBe('stdio')
    if (config.transport !== 'stdio') throw new Error('expected stdio config')
    expect(config.command).toBe('node')
    expect(config.args).toEqual(['server.js'])
    expect(config.cwd).toBe(resolve(root, 'tools'))
    expect(config.env).toEqual({ NODE_ENV: 'test' })
    expect(Object.getPrototypeOf(config.env)).toBeNull()
  })

  it('defaults stdio cwd to the workspace root and keeps absolute cwd values', () => {
    const absolute = resolve('/opt/tools')
    const result = parse(
      {
        a: { type: 'stdio', command: 'node' },
        b: { type: 'stdio', command: 'node', cwd: absolute },
      },
      { allowStdio: true },
    )
    expect(result.configs).toHaveLength(2)
    const [a, b] = result.configs
    if (a?.transport !== 'stdio' || b?.transport !== 'stdio') throw new Error('expected stdio configs')
    expect(a.cwd).toBe(root)
    expect(b.cwd).toBe(absolute)
  })

  it('rejects stdio servers unless the plugin explicitly allows them', () => {
    const result = parse({ local: { type: 'stdio', command: 'node' } })
    expect(result.configs).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]!.message).toContain('allowStdio')
  })

  it('enforces an optional stdio command allowlist', () => {
    const allowed = parse(
      { local: { type: 'stdio', command: 'C:\\tools\\node.exe', args: ['server.js'] } },
      { allowStdio: true, stdioAllowlist: ['C:\\tools'] },
    )
    expect(allowed.problems).toEqual([])
    expect(allowed.configs).toHaveLength(1)

    const denied = parse(
      { local: { type: 'stdio', command: 'C:\\toolsevil.exe' } },
      { allowStdio: true, stdioAllowlist: ['C:\\tools'] },
    )
    expect(denied.configs).toEqual([])
    expect(denied.problems[0]!.message).toContain('stdioAllowlist')
  })

  it('skips an invalid server name without touching the valid entries', () => {
    const result = parse({
      'bad name!': { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      good_name: { type: 'http', url: 'http://127.0.0.1:2/mcp' },
    })
    expect(result.problems.map(problem => problem.server)).toEqual(['mcpServers.bad name!'])
    expect(result.configs.map(config => config.serverName)).toEqual(['good_name'])
    expect(SERVER_NAME_PATTERN.test('good_name')).toBe(true)
  })

  it('rejects a malformed HTTP URL and an unsupported transport', () => {
    const result = parse({
      badUrl: { type: 'http', url: 'not-a-url' },
      sse: { type: 'sse', url: 'http://127.0.0.1:3/mcp' },
    })
    expect(result.configs).toEqual([])
    expect(result.problems).toHaveLength(2)
    expect(result.problems[0]!.message).toContain('HTTP(S)')
    expect(result.problems[1]!.message).toContain('SSE')
  })

  it('rejects non-string args, env, and headers', () => {
    const result = parse(
      {
        args: { type: 'stdio', command: 'node', args: [1, 2] },
        env: { type: 'stdio', command: 'node', env: { A: 1 } },
        headers: { type: 'http', url: 'http://127.0.0.1:4/mcp', headers: { A: 1 } },
      },
      { allowStdio: true },
    )
    expect(result.configs).toEqual([])
    expect(result.problems).toHaveLength(3)
  })

  it('forwards tool-call timeouts, with plugin default overridable per entry', () => {
    const result = parse(
      {
        inherited: { type: 'http', url: 'http://127.0.0.1:5/mcp' },
        overridden: { type: 'http', url: 'http://127.0.0.1:6/mcp', toolCallTimeoutMs: 42 },
        reconnect: { type: 'http', url: 'http://127.0.0.1:7/mcp', reconnect: { maxAttempts: 3 } },
      },
      { toolCallTimeoutMs: 1234 },
    )
    expect(result.configs).toHaveLength(3)
    expect(result.configs[0]!.toolCallTimeoutMs).toBe(1234)
    expect(result.configs[1]!.toolCallTimeoutMs).toBe(42)
    expect(result.configs[2]!.reconnect?.maxAttempts).toBe(3)
  })

  it('accepts an empty mcpServers object as "no servers"', () => {
    const result = parse({})
    expect(result.configs).toEqual([])
    expect(result.problems).toEqual([])
  })

  it('tolerates a UTF-8 BOM and whitespace around the document', () => {
    const text = `\uFEFF${JSON.stringify({ mcpServers: { demo: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } })}`
    const result = parseWorkspaceMcpDocument(text, { root, allowStdio: false, stdioAllowlist: [] })
    expect(result.configs.map(config => config.serverName)).toEqual(['demo'])
  })

  it('throws for invalid JSON, a non-object document, and a missing mcpServers', () => {
    const options: WorkspaceMcpOptions = { root, allowStdio: false, stdioAllowlist: [] }
    expect(() => parseWorkspaceMcpDocument('{', options)).toThrow(WorkspaceMcpFileError)
    expect(() => parseWorkspaceMcpDocument('[]', options)).toThrow(/top level must be a JSON object/)
    expect(() => parseWorkspaceMcpDocument('{}', options)).toThrow(/missing "mcpServers"/)
    expect(() => parseWorkspaceMcpDocument(JSON.stringify({ mcpServers: 42 }), options)).toThrow(
      /must be an object or an array/,
    )
  })
})

describe('resolveWorkspaceRoot', () => {
  it('prefers the immutable session header cwd', () => {
    expect(resolveWorkspaceRoot('D:\\work\\alpha', 'D:\\fallback')).toBe(resolve('D:\\work\\alpha'))
  })

  it('falls back to the deployment default directory, then the process directory', () => {
    expect(resolveWorkspaceRoot(undefined, 'D:\\fallback')).toBe(resolve('D:\\fallback'))
    expect(resolveWorkspaceRoot('', undefined)).toBe(resolve(process.cwd()))
  })
})

describe('isSubagentHeader', () => {
  it('detects subagent lineage from origin or parentSession', () => {
    expect(isSubagentHeader({ origin: 'subagent' })).toBe(true)
    expect(isSubagentHeader({ parentSession: 'parent' })).toBe(true)
    expect(isSubagentHeader({ cwd: 'D:\\work' })).toBe(false)
    expect(isSubagentHeader({})).toBe(false)
  })
})
