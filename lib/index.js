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
import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import z from '@deepseek-ai/schemastery';
import { WorkspaceMcpFileError, isSubagentHeader, parseWorkspaceMcpDocument, resolveWorkspaceRoot, } from './config.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-mcp';
export const Config = z.object({
    fileName: z.string().default('.dsh/mcp.json'),
    watch: z.boolean().default(false),
    startupTimeoutMs: z.number().step(1).min(1).default(10_000),
    allowStdio: z.boolean().default(false),
    stdioAllowlist: z.array(String).default([]),
    mountInSubagents: z.boolean().default(false),
    toolCallTimeoutMs: z.number().step(1).min(1),
});
/** Loose bound on `watchFile`'s filesystem polling. */
const WATCH_INTERVAL_MS = 1_000;
/** Debounce for bursty editor saves. */
const RELOAD_DEBOUNCE_MS = 300;
/**
 * Register the workspace-level MCP row.
 *
 * Everything is installed through `ctx.effect` / `ctx.on`, so unloading the
 * plugin row removes the listener, closes watchers, and unmounts the MCP
 * clients this plugin started; Agent-scoped clients otherwise unwind with
 * their Agent automatically.
 */
export function apply(ctx, config) {
    const logger = ctx.logger('workspace-mcp');
    const agentStates = new Map();
    const rootWatches = new Map();
    let disposed = false;
    const fileFor = (root) => resolve(root, config.fileName);
    const optionsFor = (root) => ({
        root,
        allowStdio: config.allowStdio,
        stdioAllowlist: config.stdioAllowlist,
        toolCallTimeoutMs: config.toolCallTimeoutMs,
    });
    const enqueue = (state, task) => {
        state.queue = state.queue
            .then(async () => {
            if (state.disposed || disposed)
                return;
            await task();
        })
            .catch((error) => {
            logger.warn(`workspace ${state.root}: workspace MCP task failed: ${String(error)}`);
        });
        return state.queue;
    };
    const disposeFibers = async (state) => {
        state.generation += 1;
        const fibers = state.fibers.splice(0);
        for (const fiber of fibers) {
            try {
                await fiber.dispose();
            }
            catch (error) {
                logger.warn(`workspace ${state.root}: could not dispose an MCP client: ${String(error)}`);
            }
        }
    };
    const mountConfigs = async (state, configs) => {
        const generation = ++state.generation;
        const mounts = configs.map(async (clientConfig) => {
            let fiber;
            try {
                fiber = state.agent.ctx.plugin(McpClient, clientConfig);
            }
            catch (error) {
                logger.warn(`${state.file}: cannot mount MCP server "${clientConfig.serverName}": ${String(error)}`);
                return;
            }
            try {
                await fiber;
            }
            catch (error) {
                logger.warn(`${state.file}: MCP server "${clientConfig.serverName}" failed to start: ${String(error)}`);
                return;
            }
            if (state.disposed || disposed || generation !== state.generation) {
                try {
                    await fiber.dispose();
                }
                catch (error) {
                    logger.warn(`${state.file}: could not dispose a stale MCP client: ${String(error)}`);
                }
                return;
            }
            state.fibers.push(fiber);
            logger.info(`workspace ${state.root}: mounted MCP server "${clientConfig.serverName}" (${clientConfig.transport})`);
        });
        const all = Promise.all(mounts);
        let timer;
        const timeout = new Promise((settle) => {
            timer = setTimeout(() => {
                logger.warn(`${state.file}: MCP startup still pending after ${config.startupTimeoutMs}ms; the session continues and the tools appear once the servers settle`);
                settle();
            }, config.startupTimeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([all, timeout]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        // The mounts keep settling after a timeout; each branch catches locally, so
        // this is only a guard against an unexpected rejection escaping.
        void all.catch((error) => logger.warn(`${state.file}: MCP mount failed: ${String(error)}`));
    };
    const loadAndMount = async (state) => {
        if (state.disposed || disposed)
            return;
        let text;
        try {
            text = await readFile(state.file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug(`workspace ${state.root}: no MCP declaration at ${state.file}`);
                return;
            }
            logger.error(`workspace ${state.root}: cannot read ${state.file}: ${String(error)}`);
            return;
        }
        if (state.disposed || disposed)
            return;
        let parsed;
        try {
            parsed = parseWorkspaceMcpDocument(text, state.options);
        }
        catch (error) {
            if (error instanceof WorkspaceMcpFileError)
                logger.error(`${state.file}: ${error.message}; the session continues without workspace MCP servers`);
            else
                logger.error(`${state.file}: unexpected declaration error: ${String(error)}`);
            return;
        }
        for (const problem of parsed.problems)
            logger.warn(`${state.file}: skipped "${problem.server}": ${problem.message}`);
        if (parsed.configs.length === 0)
            return;
        await mountConfigs(state, parsed.configs);
    };
    const addToWatch = (root, agent) => {
        let watch = rootWatches.get(root);
        if (watch === undefined) {
            const file = fileFor(root);
            watch = { root, file, agents: new Set(), timer: undefined };
            const registered = watch;
            // Polling instead of fs.watch: the file may not exist yet, `.dsh` may be
            // created later, and editors replace files atomically — watchFile handles
            // create/change/delete uniformly on every platform.
            watchFile(file, { interval: WATCH_INTERVAL_MS, persistent: false }, () => scheduleReload(registered));
            rootWatches.set(root, watch);
            logger.debug(`workspace ${root}: watching ${file} for MCP changes`);
        }
        watch.agents.add(agent);
    };
    const removeFromWatch = (root, agent) => {
        const watch = rootWatches.get(root);
        if (watch === undefined)
            return;
        watch.agents.delete(agent);
        if (watch.agents.size > 0)
            return;
        if (watch.timer !== undefined) {
            clearTimeout(watch.timer);
            watch.timer = undefined;
        }
        unwatchFile(watch.file);
        rootWatches.delete(root);
    };
    const scheduleReload = (watch) => {
        if (disposed)
            return;
        if (watch.timer !== undefined)
            clearTimeout(watch.timer);
        watch.timer = setTimeout(() => {
            watch.timer = undefined;
            void reloadRoot(watch);
        }, RELOAD_DEBOUNCE_MS);
        watch.timer.unref?.();
    };
    const reloadRoot = async (watch) => {
        if (disposed)
            return;
        logger.info(`workspace ${watch.root}: MCP declaration changed, remounting live sessions`);
        for (const agent of [...watch.agents]) {
            const state = agentStates.get(agent);
            if (state === undefined || state.disposed)
                continue;
            await enqueue(state, async () => {
                await disposeFibers(state);
                await loadAndMount(state);
            });
        }
    };
    const onAgentCreated = async (agent, signal) => {
        if (disposed)
            return;
        const header = agent.session.header;
        if (isSubagentHeader(header) && !config.mountInSubagents) {
            logger.debug(`session ${String(agent.session.id)}: subagent without workspace MCP (mountInSubagents: false)`);
            return;
        }
        if (signal?.aborted === true)
            return;
        const workingDirectory = ctx.get('workingDirectory');
        const root = resolveWorkspaceRoot(header.cwd, workingDirectory?.defaultDirectory);
        const state = {
            agent,
            root,
            file: fileFor(root),
            options: optionsFor(root),
            fibers: [],
            generation: 0,
            disposed: false,
            queue: Promise.resolve(),
        };
        agentStates.set(agent, state);
        agent.ctx.effect(() => () => {
            state.disposed = true;
            state.generation += 1;
            agentStates.delete(agent);
            removeFromWatch(state.root, agent);
        }, 'workspace-mcp.agent');
        if (config.watch)
            addToWatch(root, agent);
        await enqueue(state, () => loadAndMount(state));
    };
    // Serial and awaited by the Agent lifecycle: the first turn sees the tools.
    // Nothing is allowed to reject this listener and fail session creation.
    ctx.on('agent/created', async ({ agent, signal }) => {
        try {
            await onAgentCreated(agent, signal);
        }
        catch (error) {
            logger.error(`failed to attach workspace MCP servers: ${String(error)}`);
        }
    });
    ctx.effect(() => () => {
        disposed = true;
        for (const watch of rootWatches.values()) {
            if (watch.timer !== undefined)
                clearTimeout(watch.timer);
            unwatchFile(watch.file);
        }
        rootWatches.clear();
        const detach = [...agentStates.values()];
        agentStates.clear();
        return Promise.all(detach.map(async (state) => {
            state.disposed = true;
            state.generation += 1;
            const fibers = state.fibers.splice(0);
            for (const fiber of fibers) {
                try {
                    await fiber.dispose();
                }
                catch (error) {
                    logger.warn(`workspace ${state.root}: could not dispose an MCP client on unload: ${String(error)}`);
                }
            }
        })).then(() => { });
    }, 'workspace-mcp.lifecycle');
}
