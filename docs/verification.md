# 验证记录（2026-10-23）

环境：Windows 11、Node v24.14.0、DSH 0.2.1-rc.2（源码 checkout `D:\Work\GitHub\deepseek-harness`，运行中的 Web host 由该 checkout 启动）、pnpm 12.6.0。

## 1. 自动化测试

```sh
cd D:\Work\GitHub\dsh-workspace-mcp
pnpm typecheck     # tsc --noEmit，通过
pnpm test          # 24 passed (2 files)
pnpm build         # tsc → lib/
```

- `tests/config.spec.ts`（15 条）：声明文件两种形状（对象 / ACP 数组）、stdio 相对 cwd、绝对 cwd、stdio 默认禁用、stdioAllowlist、非法 server 名跳过、坏 URL / SSE 拒绝、args/env/headers 类型、超时与 reconnect 转发、空 `mcpServers`、坏 JSON / 缺 `mcpServers` / 非对象；以及 `resolveWorkspaceRoot` 与子 agent 判定。
- `tests/integration.spec.ts`（8 条）：用 `@deepseek-ai/dsh-agent-loop-testkit` 挂载**生产 AgentLoop** + 真实本地 Streamable HTTP MCP fixture，断言 model-visible 工具表：
  1. 工作区声明的 HTTP server → 工具 `mcp__demo__ping`，调用返回 `pong-alpha`；
  2. 没有声明文件 → 无任何 `mcp__*` 工具；
  3. 坏 JSON → Agent 正常创建、无 MCP 工具；
  4. 一条坏 entry + 一条好 entry → 只挂好的；
  5. 两个工作区复用同名 `demo` → 各自隔离、各自返回自己的值（验证 agent 作用域命名空间不串）；
  6. `watch: true` → 改文件后存活 Agent 重新挂载，工具返回新值；
  7. 子 agent 默认不挂载；
  8. `mountInSubagents: true` → 子 agent 也挂载并可调用。

## 2. 真实 headless 会话（独立进程、真实 profile、真实模型）

测试 profile：`wmcp-e2e`（从 shipped `headless` 模板创建，`dsh plugin --profile wmcp-e2e add D:\Work\GitHub\dsh-workspace-mcp` 安装本 bundle）。启动方式为从 checkout 用 tsx 跑 `apps/cli/src/bin.ts`，工作区目录作为进程 cwd（即 session header.cwd）。除显式说明外均**没有**静态 mcp-client 行（`--patch` 只放一个空 overlay），工具只可能来自本插件。

| 场景 | 命令要点 | 结果 |
|---|---|---|
| A：正常声明（HTTP fixture 4599，`pong-from-alpha`） | `run-session.ps1 -Workspace ws-alpha -Profile wmcp-e2e -Patch noop.patch.yml -Json` | `tool_call mcp__demo__ping` → `result: pong-from-alpha`，final 同值，exit 0 |
| B：坏 entry + 好 entry（fixture 4600，`pong-from-beta`） | 同上，`-Workspace ws-beta` | `mcp__demo__ping` → `pong-from-beta`；stderr 有 `skipped "mcpServers.broken-entry": "url" must be an absolute HTTP(S) URL` 与 `mounted MCP server "demo"` |
| C：坏 JSON | `-Workspace ws-bad`（日志 overlay 打开 stderr exporter） | 会话正常创建，final `SESSION_OK`；日志：`[error][workspace-mcp] ...mcp.json: invalid JSON: ...; the session continues without workspace MCP servers` |
| 无配置 | `-Workspace ws-none` | 模型确认无此工具 → final `NO_MCP`；日志仅 `no MCP declaration at ...` |
| 两工作区并行 | 两个进程同时跑 ws-alpha 与 ws-beta | A 返回 `pong-from-alpha`，B 返回 `pong-from-beta`，各自 exit 0（同名 server 不串） |
| stdio 默认禁用 | `-Workspace ws-stdio`（配置文件声明 stdio） | 会话正常，final `NO_MCP`；日志 `stdio transport is disabled by the plugin config (allowStdio: false)` |
| stdio 显式允许 | 加 `--patch stdio-verify.patch.yml`（allowStdio: true） | `tool_call mcp__stdio__ping` → `pong-stdio`；fixture 启动时写下的子进程 PID 在会话结束后已不存在，无残留进程 |
| 重启/持久化 | `dsh --profile web --dump-config` | 组合结果包含 `# == @jinngoo/dsh-workspace-mcp` 与 `- id: workspace-mcp ...`，配置来自工作区，不写 profile |

补充：headless bundle 默认不挂 log exporter，插件日志在 headless 下不可见，故验证时用一个只读 overlay（`verify/log-exporter/index.js`）把 Cordis 日志转发到 stderr；这只是验证工具，不属于插件。

## 3. Web profile 安装（交付形态）

```
plugin_manager action=install_bundle target=D:\Work\GitHub\dsh-workspace-mcp
→ application: applied
```

- `C:\Users\jinna\.dsh\profiles\web\package.json`：`dependencies` 增加 `"@jinngoo/dsh-workspace-mcp": "link:D:/Work/GitHub/dsh-workspace-mcp"`，`dsh.profile.bundles` 增加该包名。
- 运行中 host 的 live 配置目录只有一条：`include:workspace-mcp`（`Config.listConfigs name=@jinngoo/dsh-workspace-mcp`，status `schema`）。
- profile 的 `cordis.patch.yml` 未被改动。

## 4. 验收标准对照

| 验收项 | 状态 | 证据 |
|---|---|---|
| 1 测试工作区 `.dsh/mcp.json` + HTTP MCP fixture | PASS | integration `mounts an HTTP MCP server...` + headless A |
| 2 新会话出现 `mcp__demo__ping`，调用返回 pong | PASS | headless A/B、integration 1/5/8 |
| 3 无配置文件 → 无 MCP 工具、会话正常 | PASS | headless 无配置场景、integration 2 |
| 4 坏 JSON / 坏条目 → 会话正常、错误日志明确、其他 server 正常 | PASS | headless C/B、integration 3/4 |
| 5 两个工作区并行 → 隔离、不串工具 | PASS | headless 并行、integration 5 |
| 6 会话结束 → MCP 子进程退出 | PASS | stdio 场景：PID 文件记录的子进程在会话结束后不存在 |
| 7 重启后行为不变（配置来自工作区，不写 profile） | PASS | `--dump-config` 含插件行；配置文件不在 profile 中；多进程重复运行行为一致 |

## 5. 未覆盖 / 已知限制

- 子 agent 的“重复进程/连接”只在测试中通过 `mountInSubagents` 开关验证语义；未在真实多级 subagent 会话里统计进程数。
- `watch` 的 remount 以 integration 测试覆盖（真实 fs 变化 + 轮询），未在真实模型会话中演示。
- SSE 传输不支持；`${VAR}` 环境变量展开未实现（见 README §9）。
