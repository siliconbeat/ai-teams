# AI Teams

一个基于 `Claude CLI` 的三端协作系统：

- `apps/server`：服务端，负责员工注册、任务分发、事件汇总
- `apps/agent`：AI 员工端，负责连接服务端并执行 `claude -p`
- `apps/web`：Leader 控制端，负责监控员工并下发任务

## 当前状态

当前仓库已经具备一个可运行的 MVP：

- 控制端可以查看接入员工
- 控制端可以向单个员工或所有员工发送任务
- 员工端可以使用真实 `claude -p` 执行任务
- 员工端支持 `--resume` 复用 Claude 会话
- 服务端会把任务状态和日志实时广播到控制端
- 服务端会把员工、任务和任务日志持久化到 SQLite
- 服务端会按任务 `timeoutSec` 自动超时并取消员工端任务
- 服务端、员工端和控制端 WebSocket 已加入共享 token 鉴权
- 控制端支持独立选择 `all` 或多个员工，也支持在输入中使用 `@Alice`

## 环境要求

- Node.js `>=22`
- pnpm `>=9`

服务端使用 Node.js 内置 `node:sqlite`，在当前 Node 版本下仍可能输出 experimental warning。

## 安装

```bash
pnpm install
```

## 启动方式

开发模式使用 `tsx watch` / `vite`，适合本地开发。仓库内置的 `dev:*` 脚本会自动使用本地 token `dev-token`。

构建产物模式先执行：

```bash
pnpm build
```

然后使用 `start:*` 脚本启动。

生产或构建产物模式需要显式设置共享 token：

```bash
export AI_TEAMS_AUTH_TOKEN=replace-with-a-secret
```

### 1. 启动服务端

开发模式：

```bash
pnpm dev:server
```

构建产物模式：

```bash
AI_TEAMS_AUTH_TOKEN=replace-with-a-secret \
pnpm start:server
```

默认地址：

- HTTP: `http://localhost:3789/health`
- Swagger UI: `http://localhost:3789/docs`
- OpenAPI JSON: `http://localhost:3789/docs/json`
- WebSocket:
  - `ws://localhost:3789/ws/agent`
  - `ws://localhost:3789/ws/leader`

默认 SQLite 数据库：

- `data/ai-teams.db`

REST 发任务接口：

```bash
curl -X POST http://localhost:3789/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "atAgents": "queue",
    "prompt": "帮我分析当前项目",
    "workspace": "/Users/junhang/workspace/project",
    "webhook": "http://localhost:9000/ai-teams-webhook"
  }'
```

请求成功后立即返回：

```json
{
  "status": "accepted",
  "leaderCommandId": "...",
  "tasks": [{ "id": "...", "status": "queued" }]
}
```

`atAgents` 支持 `"queue"`、`"all"` 或 `["alice", "bob"]`。`webhook` 可选，也可以写成 `webhookUrl` 或 `{ "url": "..." }`；服务端会用 `POST` 回调 `task.started`、`task.output` 和 `task.completed` / `task.failed` / `task.cancelled` / `task.timeout` 事件。

按 Claude session id 获取会话历史：

```bash
curl http://localhost:3789/api/sessions/<SESSION_ID>/history \
  -H "Authorization: Bearer dev-token"
```

返回内容包含该 session 下的任务列表，以及可直接渲染的 `messages`：

```json
{
  "sessionId": "...",
  "tasks": [],
  "messages": [
    { "type": "task.prompt", "role": "user", "content": "..." },
    { "type": "task.output", "role": "assistant", "content": "..." },
    { "type": "task.result", "role": "assistant", "content": "..." }
  ]
}
```

可通过环境变量覆盖：

```bash
AI_TEAMS_AUTH_TOKEN=replace-with-a-secret \
DB_PATH=/tmp/ai-teams.db pnpm start:server
```

默认服务端端口是 `3789`，比 `3000` 更不容易和常见 Web 服务冲突。需要修改时可以设置：

```bash
AI_TEAMS_SERVER_PORT=4389 AI_TEAMS_AUTH_TOKEN=replace-with-a-secret pnpm start:server
```

### 2. 启动一个员工端

真实 Claude 模式：

```bash
EMPLOYEE_ID=alice \
EMPLOYEE_NAME=Alice \
DEFAULT_WORKSPACE=/Users/junhang/IdeaProjects/cfhy/agent/ai-teams \
RUNNER_MODE=claude \
pnpm dev:agent
```

已内置 Alice 员工脚本，等价于上面的长命令：

```bash
pnpm dev:agent:alice
```

构建产物模式：

```bash
EMPLOYEE_ID=alice \
EMPLOYEE_NAME=Alice \
RUNNER_MODE=claude \
AI_TEAMS_AUTH_TOKEN=replace-with-a-secret \
pnpm start:agent
```

构建产物模式也可以直接使用：

```bash
pnpm start:agent:alice
```

假任务模式：

```bash
EMPLOYEE_ID=alice \
EMPLOYEE_NAME=Alice \
RUNNER_MODE=fake \
pnpm dev:agent
```

可选环境变量：

- `AI_TEAMS_AUTH_TOKEN`，服务端和员工端共享 token；`start:*` 模式必填
- `AI_TEAMS_SERVER_PORT`，默认 `3789`
- `SERVER_URL`，默认 `ws://localhost:3789`
- `EMPLOYEE_LABELS`，逗号分隔，例如 `frontend,react`
- `AGENT_STATE_FILE`，默认 `DEFAULT_WORKSPACE/.ai-teams/agents/<EMPLOYEE_ID>/session-state.json`
- `CLAUDE_PERMISSION_MODE`，默认 `default`；如需绕过权限需显式设置
- `DEFAULT_WORKSPACE`，默认当前目录
- `AGENT_RECORDS_DIR`，默认 `DEFAULT_WORKSPACE/.ai-teams/agents/<EMPLOYEE_ID>`，每日 Markdown 记录会写入 `daily/YYYY-MM-DD.md`
- `CLAUDE_HOOKS_ENABLED`，默认开启；设为 `false` 可关闭注入 Claude Code CLI 的会话记录 hooks

Agent 记录规则：

- 不传 `workspace` 时，Claude CLI 在 `DEFAULT_WORKSPACE` 下执行。
- 默认会话状态、每日 Markdown、Claude hook 配置都保存在 `DEFAULT_WORKSPACE/.ai-teams/agents/<EMPLOYEE_ID>/` 子目录下。
- `@Agent` 和选择具体 Agent 的任务使用该 Agent 默认 Claude session，适合作为长期会话管理。
- 非 `@` 消息进入共享任务队列，由空闲 Agent 消费执行，每个队列任务使用独立 Claude session。
- Agent 自身会记录任务开始/结束；Claude Code CLI hooks 会记录 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd 等事件。

任务超时默认由服务端控制：

- `DEFAULT_TIMEOUT_SEC`，默认 `1800`

### 3. 启动控制端

开发模式：

```bash
pnpm dev:web
```

构建产物预览：

```bash
VITE_AI_TEAMS_AUTH_TOKEN=replace-with-a-secret \
pnpm start:web
```

默认地址：

- `http://localhost:5173`

### 4. 一键启动

开发模式：

```bash
pnpm dev:all
```

这会默认启动 Alice 员工，员工配置为：

- `EMPLOYEE_ID=alice`
- `EMPLOYEE_NAME=Alice`
- `RUNNER_MODE=claude`
- `DEFAULT_WORKSPACE=/Users/junhang/IdeaProjects/cfhy/agent/ai-teams`

构建产物模式：

```bash
pnpm build
pnpm start:all
```

这会同时启动：

- 服务端
- 一个默认员工端
- 控制端

构建产物模式下需要在 shell 中提前设置 `AI_TEAMS_AUTH_TOKEN`，控制端可以通过 `VITE_AI_TEAMS_AUTH_TOKEN` 预置 token，也可以在页面中手动输入 token。

## 多员工模拟

你可以开多个终端分别启动员工端，例如：

```bash
AI_TEAMS_AUTH_TOKEN=dev-token EMPLOYEE_ID=alice EMPLOYEE_NAME=Alice RUNNER_MODE=claude pnpm --filter @ai-teams/agent dev
AI_TEAMS_AUTH_TOKEN=dev-token EMPLOYEE_ID=bob EMPLOYEE_NAME=Bob RUNNER_MODE=fake pnpm --filter @ai-teams/agent dev
AI_TEAMS_AUTH_TOKEN=dev-token EMPLOYEE_ID=carol EMPLOYEE_NAME=Carol RUNNER_MODE=claude pnpm --filter @ai-teams/agent dev
```

## 构建与测试

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 关键实现说明

- 员工端默认单任务串行执行
- 员工端执行真实 Claude 时，会使用 `stream-json` 读取流式输出
- 员工端会将 `Claude` 的会话 ID 保存到本地文件，并在后续任务中使用 `--resume`
- 服务端内存中保留实时状态，同时把员工、任务、任务日志同步写入 SQLite
- 服务端会为已分发任务设置超时计时器，超时后发送取消指令并释放员工槽位
- 服务端会在员工断线后保留短暂恢复窗口，员工重连并上报当前任务后可继续执行
- 任务进入 `completed` / `failed` / `cancelled` / `timeout` 后，迟到的输出和完成事件会被忽略
- SQLite 会维护轻量 schema version，并按任务裁剪持久化日志，默认保留最近 400 条
