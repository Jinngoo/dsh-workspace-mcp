# @jinngoo/dsh-workspace-mcp

**一句话**：在任意工作区里放一个 `.dsh/mcp.json`，该工作区的每个 DSH 会话自动获得其中声明的 MCP 服务器工具——不用改 profile、不用给每个项目建 profile。

工具命名沿用 DSH / Claude Code 的稳定契约：`mcp__<serverName>__<rawTool>`。

```
工作区 A/.dsh/mcp.json ─┐
                        ├─ 会话 A（cwd=A）→ agent 作用域 MCP client → mcp__demo__ping
工作区 B/.dsh/mcp.json ─┘
                        └─ 会话 B（cwd=B）→ 另一个 agent 作用域 MCP client → 互不可见
```

---

## 1. 为什么需要它

DSH 的配置层只有：profile bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`，没有"工作区级"这一层（见 `docs/architecture.zh.md`）。所以 MCP 配置过去只有两种写法：

- 写死在 profile 里：所有项目共享，与具体项目无关；
- 每个项目一个 profile：维护成本高。

本插件补上工作区层：**配置跟着仓库走**（可以提交进 git、可以 clone 后直接生效），而 profile 只装一次插件。

## 2. 它怎么工作

1. 插件是 host 平面的一行，注册 `agent/created` 监听器。
2. 每个会话创建时，用**会话原始工作目录**（`agent.session.header.cwd`，不可变）定位工作区根；只有 header 没有 cwd 时才退回 `workingDirectory.defaultDirectory`（最后退回宿主进程目录）。**不会**用会话当前目录——会话里 `cd` 到别处不应该换掉 MCP 服务器。
3. 读取 `<工作区根>/.dsh/mcp.json`，逐条校验成 `@deepseek-ai/dsh-mcp-client` 的 Config。
4. 对每条配置执行 `agent.ctx.plugin(McpClient, config)`——和 ACP 桥接完全同款（`packages/acp/acp/src/mcp.ts`）。MCP client 与工具注册都落在 **agent 作用域**：只对该会话可见，会话结束自动回收。
5. `agent/created` 的监听器是 serial 且会被等待的，所以**首轮请求就能看到工具**；同时整体挂载有超时（`startupTimeoutMs`），慢服务器只会推迟工具出现，不会卡死会话创建。

## 3. 安装

> 前提：DSH 0.2.x（`engines.dsh: ^0.2.0-rc.1`）。

方式一（推荐，npm registry）：

```bash
dsh plugin --profile <profile> add @jinngoo/dsh-workspace-mcp
```

或在 DSH 会话里用 `plugin_manager`：

```
action: install_bundle
target: @jinngoo/dsh-workspace-mcp@latest
```

方式二（GitHub 直装，`lib/` 已入库，无需构建）：

```sh
dsh plugin --profile <profile> add git+https://github.com/Jinngoo/dsh-workspace-mcp.git
```

方式三（本地开发，绝对目录）：`link:` 安装的运行时依赖与 peer 都从 checkout 自己的 `node_modules` 解析，所以先装依赖再安装:

```sh
git clone git@github.com:Jinngoo/dsh-workspace-mcp.git
cd dsh-workspace-mcp && pnpm install
dsh plugin --profile <profile> add <克隆目录的绝对路径>
```

安装后插件行由本包的 `cordis.patch.yml` 自动插入，**不需要**手改 profile 的 `cordis.patch.yml`。工作区配置文件本身也不需要 profile 做任何事。

## 4. 工作区声明文件

默认路径 `<工作区根>/.dsh/mcp.json`（可用插件的 `fileName` 改）。文件不存在 = 该工作区没有 MCP 服务器，静默跳过。

### 4.1 Claude Code 风格：对象按服务器名索引

```json
{
  "mcpServers": {
    "creator": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/tools/creator-mcp/server.js"],
      "env": { "CREATOR_HOME": "D:/tools/creator-mcp" },
      "cwd": "."
    },
    "docs": {
      "type": "http",
      "url": "http://127.0.0.1:3456/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 4.2 ACP 风格：数组 + 显式 `name`

```json
{
  "mcpServers": [
    { "name": "demo", "type": "http", "url": "http://127.0.0.1:3456/mcp" }
  ]
}
```

### 4.3 字段规则

| 字段 | 说明 |
|---|---|
| key / `name` | `serverName`，必须匹配 `^[A-Za-z0-9_-]{1,32}$`。**不合法直接报错跳过，不做静默改名**——工具名是会话历史与权限规则引用的稳定契约，悄悄改名比报错更危险。 |
| `type` | `stdio` 或 `http`（也接受 `streamable-http`）。省略时按 `command` / `url` 推断。SSE 不支持，会明确报错。 |
| `command` / `args` / `env` / `cwd` | stdio。`cwd` 相对**工作区根**解析，绝对路径原样；省略 `cwd` 即工作区根。`env` 合并到 mcp-client 清洗过的环境之上。 |
| `url` / `headers` | Streamable HTTP。URL 必须是绝对 `http(s)://`。 |
| `toolCallTimeoutMs` | 可选，覆盖插件级默认值。 |
| `maxInstructionBytes` / `reconnect` | 可选，原样转发给 mcp-client（由其 schema 校验）。 |

校验行为：

- 坏 JSON / 顶层不是对象 / 缺 `mcpServers` → 一条明确错误日志，会话照常创建（没有 MCP 工具）。
- 单个服务器条目非法（名字、传输、URL、字段类型、stdio 被禁）→ 该条**跳过并告警**，其它服务器正常挂载。
- 文件不存在 → 静默（debug 级日志）。
- 同一会话内重名由 mcp-client 自己的命名空间预留兜底；不同会话/工作区可以复用同一个 `serverName`（agent 作用域隔离）。

## 5. 插件自身配置（profile patch 行）

安装后行长这样（`cordis.patch.yml`）：

```yaml
- id: workspace-mcp
  name: '@jinngoo/dsh-workspace-mcp'
  config:
    fileName: '.dsh/mcp.json'
    watch: false
    startupTimeoutMs: 10000
    allowStdio: false
    stdioAllowlist: []
    mountInSubagents: false
```

| 键 | 默认 | 含义 |
|---|---|---|
| `fileName` | `.dsh/mcp.json` | 声明文件，相对工作区根；绝对路径也接受。 |
| `watch` | `false` | 监视声明文件；变化后为**仍存活**的会话重新挂载（先卸旧、再挂新，串行、300ms 去抖）。实现用 `fs.watchFile` 轮询（1s），因此文件不存在、`.dsh` 稍后创建、编辑器原子替换都能覆盖。 |
| `startupTimeoutMs` | `10000` | 等待「首次连接 + 工具发现」的上限。超时后会话继续，工具待服务器就绪后出现（日志有告警）。 |
| `allowStdio` | **`false`** | 是否允许 stdio 服务器。 |
| `stdioAllowlist` | `[]` | 可选护栏：非空时，`command` 必须等于某项，或位于某项之下（`C:\tools` 允许 `C:\tools\node.exe`，不允许 `C:\toolsevil.exe`）。 |
| `mountInSubagents` | **`false`** | 子 agent 是否也挂载。 |
| `toolCallTimeoutMs` | 不设（mcp-client 默认 60s） | 每次工具调用的默认超时。 |

想改这些默认值，在 profile 的 `cordis.patch.yml` 里按 `id: workspace-mcp` 覆盖即可（patch 按 id 覆盖整行 config，记得写全你要保留的键）。

## 6. 安全边界（必读）

`.dsh/mcp.json` 是**工作区文件**，可能来自 clone 下来的仓库。本插件的默认姿态：

- **stdio 默认禁止**（`allowStdio: false`）。stdio = 让工作区文件在本机执行任意命令，这是最实际的风险面。只对你信任的仓库/配置开启；开了之后还可以用 `stdioAllowlist` 收窄到固定可执行文件。
- **HTTP 默认允许**。HTTP 不能直接在本机执行命令，但仍是网络请求（SSRF）与提示注入的载体：不要盲目信任来源不明的 `.dsh/mcp.json`，尤其是 `headers` 里的凭据。插件不读取、不复用你环境里的令牌；`headers` 只来自该文件。
- 插件不绕过任何权限层：MCP 工具仍走 ToolRuntime 的正常权限/审批流程。
- 建议：把 `.dsh/mcp.json` 加入仓库前先 review；公开仓库里避免放本地路径与私有令牌。

## 7. 子 agent 行为

子 agent 的会话也继承父会话的 `cwd`。默认 **不**给子 agent 挂载（`mountInSubagents: false`），原因：

- stdio 服务器会为每个子 agent 再起一个进程，重型 MCP（浏览器、创作者工具）可能冲突或耗尽资源；
- HTTP 服务器也会为每个子 agent 新建连接与工具集；
- 子 agent 是内部临时 agent，通常不需要完整工具面。

如果委派出去的任务确实需要 MCP 工具，把 `mountInSubagents` 设为 `true` 即可（每个 agent 独立挂载，隔离正确但资源按 agent 数增长）。

## 8. 验收 / 自检

自动化测试（23 条）：

```sh
pnpm install
pnpm test        # 15 条解析单测 + 8 条 production AgentLoop + 真实 HTTP MCP fixture 集成测试
pnpm typecheck
pnpm build
```

集成测试覆盖：工作区挂载、无配置、坏 JSON、坏条目跳过、两个工作区同名 server 隔离、`watch` 热重载、子 agent 默认不挂载、`mountInSubagents: true` 挂载。

端到端（真实 headless 会话 + 运行中模型的完整证据见 [`docs/verification.md`](docs/verification.md)）：

1. 用本机 HTTP MCP fixture（只有 `ping` → `pong`）起一个 Streamable HTTP 端点；
2. 在测试工作区写 `.dsh/mcp.json`；
3. 新建会话 → 工具列表出现 `mcp__demo__ping`，调用返回 `pong`；
4. 没有配置文件 / 坏 JSON / 坏条目 → 会话正常创建，日志可见明确错误；
5. 两个工作区并行 → 工具互不串；
6. 会话结束 → MCP 子进程退出；
7. 重启 DSH → 行为不变（配置来自工作区）。

## 9. 实现说明与设计取舍

- **挂载点**：必须是 agent 作用域（`agent.ctx`），不是全局/root。agent 作用域的工具只对该 agent 可见，且随 agent 销毁自动回收；不同工作区可以复用同名 `serverName` 而不冲突。
- **根目录**：`session.header.cwd` ≠ `workingDirectory.get(session)`。前者是创建会话时的原始项目目录（不可变），后者会被会话内 `cd` 改掉。本插件只用前者。
- **首轮可见性**：`agent/created` 监听器被 AgentLoop 串行 await，所以挂载完成（或超时放行）后才开始首轮。
- **失败隔离**：任何异常都不会 reject `agent/created`；最坏情况是该会话没有 MCP 工具，但会话本身可用。
- **热更新**：`watch: true` 时只对仍存活的 agent 重挂；不使用 `fs.watch`，因为文件可能稍后才创建、编辑器会用原子替换。
- **卸载**：插件行卸载时关闭所有 watcher、卸载本插件挂载的 MCP client；agent 作用域本身也会在会话结束时回收各自 client。
- **不做的事**：不做 per-tool 权限控制（交给 ToolRuntime）、不做 MCP 提示词模板、不做 `sse` 传输、不做 `${VAR}` 环境变量展开（需要时请用插件级配置/环境变量自身机制）。

## 10. 目录结构

```
dsh-workspace-mcp/
├─ src/config.ts      # 纯解析/校验：mcp.json → mcp-client Config（无 Cordis 依赖，可单测）
├─ src/index.ts       # 插件入口：agent/created 挂载、超时、热更新、清理
├─ tests/config.spec.ts
├─ cordis.patch.yml   # bundle patch：插入 workspace-mcp 行
├─ locale/{en,zh}.json
├─ icon.svg
└─ lib/               # tsc 构建产物（安装前必须 build）
```

## 11. 故障排查

| 现象 | 检查 |
|---|---|
| 会话里没有任何 `mcp__*` 工具 | 1) `.dsh/mcp.json` 是否在工作区根（`session.header.cwd`，不是当前目录）；2) 日志 `workspace-mcp` 是否有 skipped/error；3) `type: http` 的 URL 是否可达；4) 是否用了 `sse`（不支持）。 |
| 日志说 stdio 被禁用 | profile patch 里把 `allowStdio` 设为 `true`（只对可信工作区）。 |
| 会话创建变慢 | 调小 `startupTimeoutMs`，或检查 MCP 服务器启动耗时；超时后会放行会话。 |
| 改了 `.dsh/mcp.json` 不生效 | `watch` 默认 `false`：默认只在会话创建时读取；需要热更新就开 `watch: true`，或新建会话。 |
| 子 agent 没有 MCP 工具 | 默认 `mountInSubagents: false`；需要时开启。 |
