/**
 * In-process integration tests for the workspace-mcp row.
 *
 * These mount the production Agent loop (through dsh-agent-loop-testkit) and a
 * real Streamable HTTP MCP fixture, then assert what the model would see in
 * each Agent's tool registry. They cover the behaviors that a one-shot live
 * session cannot show: two workspaces in one host, watch-driven remounts,
 * subagent gating, and broken-file isolation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as WorkspaceMcp from '../src/index.js'

const PING = 'mcp__demo__ping'

interface Fixture {
  url: string
  close: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  // Reverse creation order: Agents and their MCP clients die before the fixture.
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Best-effort teardown; a failed cleanup must not mask the assertion.
    }
  }
})

/** A local Streamable HTTP MCP server exposing only `ping`. */
async function startFixture(reply: string): Promise<Fixture> {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'integration-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool('ping', { description: `Replies ${reply}.`, inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: reply }],
    }))
    return mcp
  })
  const handle = toNodeHandler(handler)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
    },
  }
}

async function makeWorkspace(contents: string | undefined, name = 'workspace'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `wmcp-${name}-`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (contents !== undefined) {
    await mkdir(join(root, '.dsh'), { recursive: true })
    await writeFile(join(root, '.dsh', 'mcp.json'), contents)
  }
  return root
}

async function workspaceWith(servers: Record<string, unknown>): Promise<string> {
  return makeWorkspace(JSON.stringify({ mcpServers: servers }))
}

async function setup(plugin: Partial<WorkspaceMcp.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(WorkspaceMcp, WorkspaceMcp.Config({
    allowStdio: false,
    watch: false,
    startupTimeoutMs: 5_000,
    ...plugin,
  }))
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness }
}

function toolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

async function ping(ctx: Context, agent: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    agent,
    name: PING,
    arguments: {},
    callId: 'integration-call' as never,
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(`ping failed: ${JSON.stringify(result.error)}`)
  const value = result.value as { content?: Array<{ type: string; text?: string }> }
  return value.content?.find(block => block.type === 'text')?.text ?? ''
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      // The tool is briefly unregistered during a remount; keep polling.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for condition')
}

describe('workspace-mcp', () => {
  it('mounts an HTTP MCP server declared by the session workspace', async () => {
    const fixture = await startFixture('pong-alpha')
    cleanups.push(fixture.close)
    const root = await workspaceWith({ demo: { type: 'http', url: fixture.url } })
    const { ctx, harness } = await setup()

    const agent = await harness.create(SessionId('mount-alpha'), {}, { cwd: root })

    expect(toolNames(ctx, agent)).toContain(PING)
    await expect(ping(ctx, agent)).resolves.toBe('pong-alpha')
  })

  it('adds no MCP tools when the workspace has no declaration file', async () => {
    const root = await makeWorkspace(undefined, 'empty')
    const { ctx, harness } = await setup()

    const agent = await harness.create(SessionId('no-mcp'), {}, { cwd: root })

    expect(toolNames(ctx, agent).filter(name => name.startsWith('mcp__'))).toEqual([])
  })

  it('keeps the session working when the declaration file is invalid JSON', async () => {
    const root = await makeWorkspace('{ "mcpServers": {', 'broken-json')
    const { ctx, harness } = await setup()

    const agent = await harness.create(SessionId('broken-json'), {}, { cwd: root })

    expect(agent.session.header.cwd).toBe(root)
    expect(toolNames(ctx, agent).filter(name => name.startsWith('mcp__'))).toEqual([])
  })

  it('skips one invalid server entry while mounting the valid ones', async () => {
    const fixture = await startFixture('pong-mixed')
    cleanups.push(fixture.close)
    const root = await workspaceWith({
      demo: { type: 'http', url: fixture.url },
      broken: { type: 'http', url: 'not-a-url' },
      disabled: { type: 'stdio', command: 'node' },
    })
    const { ctx, harness } = await setup()

    const agent = await harness.create(SessionId('mixed'), {}, { cwd: root })

    expect(toolNames(ctx, agent)).toContain(PING)
    await expect(ping(ctx, agent)).resolves.toBe('pong-mixed')
  })

  it('isolates two workspaces that reuse the same server name', async () => {
    const alpha = await startFixture('pong-alpha')
    cleanups.push(alpha.close)
    const beta = await startFixture('pong-beta')
    cleanups.push(beta.close)
    const alphaRoot = await workspaceWith({ demo: { type: 'http', url: alpha.url } })
    const betaRoot = await workspaceWith({ demo: { type: 'http', url: beta.url } })
    const { ctx, harness } = await setup()

    const alphaAgent = await harness.create(SessionId('ws-alpha'), {}, { cwd: alphaRoot })
    const betaAgent = await harness.create(SessionId('ws-beta'), {}, { cwd: betaRoot })

    expect(toolNames(ctx, alphaAgent)).toContain(PING)
    expect(toolNames(ctx, betaAgent)).toContain(PING)
    await expect(ping(ctx, alphaAgent)).resolves.toBe('pong-alpha')
    await expect(ping(ctx, betaAgent)).resolves.toBe('pong-beta')
  })

  it('remounts a live Agent when watch is enabled and the file changes', async () => {
    const alpha = await startFixture('pong-alpha')
    cleanups.push(alpha.close)
    const beta = await startFixture('pong-beta')
    cleanups.push(beta.close)
    const root = await workspaceWith({ demo: { type: 'http', url: alpha.url } })
    const { ctx, harness } = await setup({ watch: true })

    const agent = await harness.create(SessionId('watched'), {}, { cwd: root })
    await expect(ping(ctx, agent)).resolves.toBe('pong-alpha')

    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { demo: { type: 'http', url: beta.url } } }))

    await waitFor(async () => (await ping(ctx, agent)) === 'pong-beta')
    expect(toolNames(ctx, agent)).toContain(PING)
  })

  it('does not mount workspace servers for subagents by default', async () => {
    const fixture = await startFixture('pong-root')
    cleanups.push(fixture.close)
    const root = await workspaceWith({ demo: { type: 'http', url: fixture.url } })
    const { ctx, harness } = await setup()

    const parent = await harness.create(SessionId('subagent-parent'), {}, { cwd: root })
    const child = await ctx.agents.create({
      sessionId: SessionId('subagent-child'),
      parentAgent: parent,
      meta: { cwd: root, origin: 'subagent', parentSession: parent.session.id },
    })
    cleanups.push(() => child.dispose())

    expect(toolNames(ctx, parent)).toContain(PING)
    expect(toolNames(ctx, child.agent).filter(name => name.startsWith('mcp__'))).toEqual([])
  })

  it('mounts workspace servers for subagents when mountInSubagents is enabled', async () => {
    const fixture = await startFixture('pong-child')
    cleanups.push(fixture.close)
    const root = await workspaceWith({ demo: { type: 'http', url: fixture.url } })
    const { ctx, harness } = await setup({ mountInSubagents: true })

    const parent = await harness.create(SessionId('subagent-parent-on'), {}, { cwd: root })
    const child = await ctx.agents.create({
      sessionId: SessionId('subagent-child-on'),
      parentAgent: parent,
      meta: { cwd: root, origin: 'subagent', parentSession: parent.session.id },
    })
    cleanups.push(() => child.dispose())

    expect(toolNames(ctx, child.agent)).toContain(PING)
    await expect(ping(ctx, child.agent)).resolves.toBe('pong-child')
  })
})
