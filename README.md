# AI Teams

基于 Claude CLI 的多 Agent 协作系统。人类 Leader 通过中心服务器向 AI 员工（Agent）分发任务，所有通信通过 WebSocket 实时传输。

## 系统架构

```
┌──────────┐   WebSocket    ┌──────────┐   WebSocket    ┌──────────┐
│  Leader   │◄─────────────►│  Server  │◄─────────────►│  Agent   │
│  (Web UI) │   /ws/leader  │ (Fastify)│   /ws/agent   │(claude -p)│
└──────────┘                └──────────┘                └──────────┘
                                │
                            REST API
                                │
                          ┌──────────┐
                          │ 外部调用方 │
                          └──────────┘
```

三个应用 + 一个共享包：

| 组件 | 职责 |
|------|------|
| `apps/server` | Fastify HTTP + WebSocket 服务器，管理员工注册、任务调度、超时、持久化 |
| `apps/agent` | 连接服务器，生成 `claude -p` 子进程执行任务 |
| `apps/web` | React 单页控制台，监控员工、查看输出、下发任务 |
| `packages/shared` | 协议类型、消息解析校验、`@mention` 解析 |

## 环境要求

- Node.js `>=22`
- pnpm `>=9`

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动 Server 和 Web（Web 使用 dev-token 登录）
pnpm dev:server
pnpm dev:web
```

然后打开 `http://localhost:5173`，使用 `dev-token` 登录，在「员工管理」里添加 Agent 并复制生成的 Agent Token，再启动 Agent：

```bash
AI_TEAMS_AGENT_TOKEN=<agent-token> EMPLOYEE_ID=alice EMPLOYEE_NAME=Alice DEFAULT_WORKSPACE=$PWD pnpm dev:agent:alice
```

开发服务地址：
- Server — `http://localhost:3789`
- Web — `http://localhost:5173`

如果需要把真实 Agent 放进 Docker 沙箱，只让 Claude Code CLI 访问一个专用 workspace，请参考 [Docker Agent 沙箱运行](docs/docker-agent-sandbox.md)。

### Docker 沙箱 Agent

可以只把 Agent 放进 Docker 容器，Server 和 Web 继续运行在宿主机。容器内 Claude Code CLI 的工作目录固定为 `/workspace`，默认映射到宿主机 `./sandbox/agent-alice`，避免直接暴露整个项目目录或用户主目录。

```bash
cp docker/agent.env.example docker/agent.env
docker compose --env-file docker/agent.env -f docker-compose.agent.yml up --build
```

首次使用真实 Claude CLI 时，进入容器完成登录或验证：

```bash
docker compose --env-file docker/agent.env -f docker-compose.agent.yml run --rm agent-alice bash
claude -p "hello"
```

## 任务调度模式

任务有三种目标模式：

| 模式 | 说明 | 会话策略 |
|------|------|----------|
| **queue** | 共享 FIFO 队列，轮询分配给空闲 Agent | 每次新建独立 Claude 会话 |
| **direct** | 指定 Agent 执行 | 使用 Agent 持久 Claude 会话（`--resume`） |
| **broadcast** | 发给所有在线 Agent | 每个 Agent 各自持久会话 |

### 任务生命周期

```
queued → dispatched → accepted → running → completed | failed | cancelled | timeout
```

- 终态（completed/failed/cancelled/timeout）不可变，后续事件被忽略
- Server 通过 `setTimeout` 自动超时控制
- Agent 断连后有 15s 宽限期，重连可恢复活跃任务

### 双槽位并行

每个 Agent 有两个任务槽，可同时运行：
- **main 槽** — direct/broadcast 任务，使用持久 Claude 会话
- **queue 槽** — queue 任务，使用独立会话

## AI Leader Mission

AI Leader Mission 用于把一个总目标交给服务端编排器，由编排器拆分普通 AI Teams 任务、派发给 Agent、等待结果、触发 Review，并在风险节点请求人工确认。

当前实现采用持久化状态机：

```
created → planning → dispatching → waiting_agents → reviewing
        ↘ waiting_human → planning
        ↘ completed | failed | cancelled
```

默认策略是：
- 第一轮创建 `analyst` 和 `implementer` 两个队列子任务。
- 子任务完成后创建 `reviewer` 队列子任务。
- Review 完成后汇总 Mission 结果。
- 如果目标包含生产、部署、删除、迁移、数据库、权限、密钥等风险词，`ask_on_risky_change` 会先进入人工确认。
- 如果子任务失败或超时，会进入人工确认，避免继续盲目派发。

确认策略：

| 策略 | 说明 |
|------|------|
| `auto` | 自动推进，不主动请求每轮确认 |
| `ask_on_risky_change` | 默认；风险目标或失败任务需要人工确认 |
| `manual_each_iteration` | 每一轮 Leader 计划都先确认再派发 |

---

## REST API

所有接口需要 Bearer Token 认证（Header `Authorization: Bearer <token>`）。
Swagger UI 地址：`http://localhost:3789/docs`

### 健康检查

```
GET /health
```

```json
{
  "status": "ok",
  "timestamp": "2026-04-28T12:00:00.000Z",
  "dbPath": "data/ai-teams.db",
  "employees": 1,
  "leaders": 0,
  "tasks": 3
}
```

### 获取完整快照

```
GET /api/snapshot
```

返回所有员工、任务和任务日志。

### 提交任务

```
POST /api/tasks
```

**请求体：**

```json
{
  "prompt": "帮我分析当前项目的依赖关系",
  "atAgents": "queue",
  "workspace": "/path/to/project",
  "timeoutSec": 600,
  "cliConfig": {
    "model": "claude-sonnet-4-6",
    "permissionMode": "default",
    "maxTurns": 10,
    "appendSystemPrompt": "请用中文回答"
  },
  "webhook": "https://example.com/callback"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 任务提示词 |
| `atAgents` | `"queue"` \| `"all"` \| `string[]` | 否 | 目标，默认 `"queue"` |
| `workspace` | string | 否 | 工作目录 |
| `timeoutSec` | number | 否 | 超时秒数，默认 1800 |
| `cliConfig` | object | 否 | Claude CLI 配置 |
| `webhook` | string \| object | 否 | 回调 URL |

**cliConfig 支持的字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型名称 |
| `permissionMode` | string | 覆盖 Agent 默认权限模式：`bypassPermissions` 直接执行，`default` 使用 Claude 默认权限确认 |
| `maxTurns` | number | 最大对话轮次 |
| `systemPrompt` | string | 系统提示词（覆盖） |
| `appendSystemPrompt` | string | 追加系统提示词 |
| `allowedTools` | string[] | 允许的工具列表 |
| `disallowedTools` | string[] | 禁用的工具列表 |
| `extraArgs` | string[] | 额外 CLI 参数 |

**响应 `202`：**

```json
{
  "status": "accepted",
  "leaderCommandId": "uuid",
  "tasks": [{ "id": "uuid", "status": "queued", ... }]
}
```

**curl 示例：**

```bash
# 队列任务
curl -X POST http://localhost:3789/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "帮我分析当前项目", "atAgents": "queue"}'

# 指定员工
curl -X POST http://localhost:3789/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "修复登录bug", "atAgents": ["alice"]}'

# 广播所有员工
curl -X POST http://localhost:3789/api/tasks \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "各自汇报当前进度", "atAgents": "all"}'
```

### 查询任务列表

```
GET /api/tasks?status=running&employeeId=alice&limit=20&offset=0
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `status` | string | 按状态过滤 |
| `employeeId` | string | 按员工过滤 |
| `limit` | number | 每页条数（1-100） |
| `offset` | number | 偏移量 |

**响应：**

```json
{
  "tasks": [{ "id": "uuid", "status": "running", ... }]
}
```

### 查询单个任务

```
GET /api/tasks/:taskId
```

### 取消/终止任务

```
POST /api/tasks/:taskId/cancel
```

完整取消流程：
1. 排队中的任务 — 从队列移除，标记 `cancelled`
2. 运行中的任务 — 通知 Agent 终止 claude 子进程
3. Agent 离线 — 标记任务 `failed`

**响应 `200`：** 返回当前任务记录

**错误响应：**
- `404` — 任务不存在
- `409` — 任务已处于终态

```bash
curl -X POST http://localhost:3789/api/tasks/TASK_ID/cancel \
  -H "Authorization: Bearer dev-token"
```

### 更新任务

```
PATCH /api/tasks/:taskId
```

```json
{
  "status": "cancelled",
  "timeoutSec": 3600,
  "cliConfig": { "maxTurns": 5 }
}
```

> 注意：`PATCH` 直接更新数据库字段，不会通知 Agent 终止进程。如需完整取消流程请使用 `POST /api/tasks/:taskId/cancel`。

### 删除任务

```
DELETE /api/tasks/:taskId
```

仅限终态任务（completed/failed/cancelled/timeout）。

### 优先执行排队任务

```
POST /api/tasks/:taskId/prioritize
```

将排队中的共享队列任务提升到队列最前面（优先级设为最高值）。仅对 `status=queued` 且 `targetMode=queue` 的任务有效。

```bash
curl -X POST http://localhost:3789/api/tasks/TASK_ID/prioritize \
  -H "Authorization: Bearer dev-token"
```

### 获取任务输出

```
GET /api/tasks/:taskId/output
```

返回指定任务的所有输出块按顺序拼接后的完整文本。

```json
{
  "taskId": "uuid",
  "output": "完整的任务输出文本..."
}
```

```bash
curl http://localhost:3789/api/tasks/TASK_ID/output \
  -H "Authorization: Bearer dev-token"
```

### 获取会话历史

```
GET /api/sessions/:sessionId/history
```

返回该 Claude 会话下的所有任务提示词、输出和摘要，可直接渲染为对话。

```json
{
  "sessionId": "...",
  "tasks": [],
  "messages": [
    { "type": "task.prompt", "role": "user", "taskId": "...", "content": "..." },
    { "type": "task.output", "role": "assistant", "taskId": "...", "content": "..." },
    { "type": "task.result", "role": "assistant", "taskId": "...", "content": "..." }
  ]
}
```

### Webhook 回调

提交任务时可指定 `webhook` URL，Server 会 POST 以下事件：

| 事件 | 触发时机 |
|------|----------|
| `task.started` | Agent 开始执行 |
| `task.output` | 每条流式输出 |
| `task.completed` | 任务成功完成 |
| `task.failed` | 任务失败 |
| `task.cancelled` | 任务取消 |
| `task.timeout` | 任务超时 |

每个回调包含 `x-ai-teams-signature` Header（HMAC-SHA256 签名），可用共享 Token 验证。

### AI Leader Mission API

---

## Agent 管理接口

### Agent 注册列表

```
GET /api/agent-registry
```

返回所有已注册和待审批的 Agent。

```json
{
  "agents": [
    {
      "employeeId": "alice",
      "name": "Alice",
      "status": "approved",
      "labels": ["backend", "rust"],
      "createdAt": "...",
      "approvedAt": "..."
    }
  ]
}
```

### 预注册 Agent 并生成 Token

```
POST /api/agent-registry
```

预先审批一个 Agent 并为其生成认证 Token。适用于生产环境批量部署 Agent 的场景。

```json
{
  "employeeId": "alice",
  "name": "Alice Agent",
  "labels": ["backend"],
  "token": "optional-custom-token-at-least-8-chars"
}
```

**响应 `201`：**

```json
{
  "agent": { "employeeId": "alice", "status": "approved", ... },
  "agentToken": "generated-or-custom-token"
}
```

将返回的 `agentToken` 配置到 Agent 进程的 `AI_TEAMS_AGENT_TOKEN` 环境变量即可。

```bash
curl -X POST http://localhost:3789/api/agent-registry \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"employeeId": "alice", "name": "Alice"}'
```

### 审批待审 Agent

```
POST /api/agent-registry/:employeeId/approve
```

审批一个待审状态的 Agent，并生成其专属 Token。

```json
{ "token": "optional-custom-token" }
```

**响应 `200`：** 返回 `{ agent, agentToken }`。

### 删除 Agent 注册

```
DELETE /api/agent-registry/:employeeId
```

删除 Agent 注册记录并断开其连接。如果 Agent 有活跃任务则拒绝删除（`409`）。

### 暂停 Agent 队列

```
POST /api/agents/:employeeId/pause-queue
```

暂停 Agent 的共享队列任务派发。Agent 已在运行的任务不受影响，但不再接收新的队列任务。适用于 Agent 需要维护或排错的场景。

```bash
curl -X POST http://localhost:3789/api/agents/alice/pause-queue \
  -H "Authorization: Bearer dev-token"
```

### 恢复 Agent 队列

```
POST /api/agents/:employeeId/resume-queue
```

恢复之前因连续失败被暂停的 Agent 队列派发。也用于手动恢复被暂停的 Agent。

```bash
curl -X POST http://localhost:3789/api/agents/alice/resume-queue \
  -H "Authorization: Bearer dev-token"
```

### 重置 Agent 会话

```
POST /api/agents/:employeeId/reset-session
```

重置 Agent 的 main 槽 Claude 会话。下一次 direct/broadcast 任务将启动新的 Claude 会话，而非 `--resume` 旧会话。适用于会话上下文过长或出错需要清理的场景。

```bash
curl -X POST http://localhost:3789/api/agents/alice/reset-session \
  -H "Authorization: Bearer dev-token"
```

### 查看 Agent 的 Claude 会话列表

```
GET /api/employees/:employeeId/claude-sessions
```

列出指定 Agent 工作目录下的所有 Claude Code 会话文件（`.jsonl`），包括会话大小、修改时间、行数，以及首条和最新用户消息摘要。

```json
{
  "employeeId": "alice",
  "workspace": "/path/to/project",
  "activeSessionId": "current-session-uuid",
  "sessions": [
    {
      "id": "session-uuid",
      "sizeBytes": 12345,
      "modifiedAt": "...",
      "lineCount": 42,
      "firstUserMessage": "帮我分析项目依赖...",
      "latestUserMessage": "继续完成剩余模块..."
    }
  ]
}
```

---

## 定时任务（Schedule）

### 查看所有定时任务

```
GET /api/schedules
```

### 创建定时任务

```
POST /api/schedules
```

```json
{
  "name": "每日构建检查",
  "cron": "0 9 * * 1-5",
  "prompt": "运行 pnpm build 并报告结果",
  "targetMode": "queue",
  "workspace": "/path/to/project",
  "enabled": true,
  "priority": 0,
  "requiredLabels": ["backend"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 任务名称 |
| `cron` | string | 是 | Cron 表达式（5 位） |
| `prompt` | string | 是 | 任务提示词 |
| `targetMode` | `"queue"` \| `"direct"` \| `"broadcast"` | 否 | 默认 `queue` |
| `targetAgents` | string[] | 否 | direct 模式指定目标 Agent |
| `workspace` | string | 否 | 工作目录 |
| `timeoutSec` | number | 否 | 超时秒数 |
| `priority` | number | 否 | 优先级 0-3 |
| `requiredLabels` | string[] | 否 | Agent 标签过滤 |
| `enabled` | boolean | 否 | 默认 `true` |

### 更新定时任务

```
PATCH /api/schedules/:scheduleId
```

请求体同创建，所有字段可选。

### 删除定时任务

```
DELETE /api/schedules/:scheduleId
```

### 手动触发定时任务

```
POST /api/schedules/:scheduleId/trigger
```

立即执行一次定时任务，不影响原有调度计划。

```bash
# 创建工作日每天 9 点执行的定时任务
curl -X POST http://localhost:3789/api/schedules \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日构建检查",
    "cron": "0 9 * * 1-5",
    "prompt": "运行 pnpm build 并报告结果",
    "targetMode": "queue"
  }'

# 手动触发一次
curl -X POST http://localhost:3789/api/schedules/SCHEDULE_ID/trigger \
  -H "Authorization: Bearer dev-token"
```

---

## AI Leader Mission API

#### 创建 Mission

```
POST /api/missions
```

```json
{
  "objective": "完成生产稳定性优化，保持旧版接口兼容，并完成测试",
  "workspace": "/path/to/project",
  "approvalPolicy": "ask_on_risky_change",
  "maxIterations": 6,
  "maxTasks": 20,
  "timeoutSec": 1800,
  "autoStart": true
}
```

#### 查询 Mission

```
GET /api/missions
GET /api/missions/:missionId
```

详情返回 `mission`、`events`、`subtasks`、`approvals`。`subtasks` 关联的是现有 `TaskRecord`，因此旧任务接口仍可继续查询、取消和查看输出。

#### 人工确认

```
POST /api/missions/:missionId/approvals/:approvalId/respond
```

```json
{
  "approved": true,
  "response": "允许继续，但不要执行生产部署"
}
```

#### 取消 Mission

```
POST /api/missions/:missionId/cancel
```

---

## 启动方式

### 开发模式

```bash
pnpm dev:server          # Server on :3789
pnpm dev:agent:alice     # Agent with EMPLOYEE_ID=alice
pnpm dev:web             # Web on :5173
pnpm dev:all             # 全部启动；Agent 仍需要预先在 Web 端生成并匹配 Agent Token
```

开发模式自动使用 `dev-token`。

### 生产模式

```bash
export AI_TEAMS_AUTH_TOKEN=your-secret-token
pnpm build
pnpm start:server
pnpm start:web

# 先在 Web「员工管理」生成并复制对应 Agent Token
AI_TEAMS_AGENT_TOKEN=<agent-token> pnpm start:agent:alice
```

生产模式默认启用 Agent 审批。先在 Web「员工管理」里添加或批准 Agent，复制生成的 Agent Token，再在对应 Agent 进程配置 `AI_TEAMS_AGENT_TOKEN` 后启动。

### 多员工

```bash
AI_TEAMS_AGENT_TOKEN=<alice-agent-token> EMPLOYEE_ID=alice EMPLOYEE_NAME=Alice RUNNER_MODE=claude pnpm --filter @csdwd/ai-teams-agent dev
AI_TEAMS_AGENT_TOKEN=<bob-agent-token> EMPLOYEE_ID=bob EMPLOYEE_NAME=Bob RUNNER_MODE=fake pnpm --filter @csdwd/ai-teams-agent dev
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_TEAMS_AUTH_TOKEN` | — | Server/Web/API 共享认证 Token（生产必填，不配置到 Agent） |
| `AI_TEAMS_AGENT_TOKEN` | — | Agent 独立 Token。先在 Web「员工管理」生成，再配置到对应 Agent |
| `AGENT_REGISTRATION_MODE` | `approval` | Agent 注册模式：`approval` 需要 Web 批准，`open` 用于本地开发 |
| `AI_TEAMS_SERVER_PORT` | `3789` | 服务端口 |
| `SERVER_URL` | `ws://localhost:3789` | Agent 连接地址 |
| `EMPLOYEE_ID` | `emp_local` | 员工 ID |
| `EMPLOYEE_NAME` | `Local Agent` | 员工名称 |
| `EMPLOYEE_LABELS` | — | 逗号分隔标签 |
| `RUNNER_MODE` | `claude` | `claude` 或 `fake`（测试用） |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | Agent 默认 Claude 权限模式；直接执行任务建议保持 `bypassPermissions`，需要更严格确认时设为 `default` |
| `DEFAULT_WORKSPACE` | 当前目录 | 默认工作目录 |
| `DEFAULT_TIMEOUT_SEC` | `1800` | 任务超时秒数 |
| `DISCONNECT_GRACE_MS` | `15000` | 断线恢复宽限期 |
| `MAX_LOG_CHUNKS_PER_TASK` | `400` | 每个任务保留的输出日志块上限 |
| `MAX_HYDRATED_TASKS` | `200` | 启动时加载的已结束任务上限（防止 OOM） |
| `MISSION_POLL_MS` | `500` | AI Leader Mission 编排器轮询间隔 |
| `DATABASE_URL` | — | PostgreSQL 连接串（见下方说明） |
| `DB_PATH` | `data/ai-teams.db` | SQLite 数据库路径（不设 `DATABASE_URL` 时使用） |
| `LOG_LEVEL` | `info` | 日志级别：`trace` / `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | — | 日志文件目录（不设则仅输出到 stdout） |

---

## 数据库

默认使用 **SQLite**（`data/ai-teams.db`），开箱即用，无需额外配置。

### 使用 PostgreSQL

设置 `DATABASE_URL` 环境变量即可切换到 PostgreSQL：

```bash
# 标准连接串格式
export DATABASE_URL="postgresql://user:password@localhost:5432/ai_teams"

# 带完整参数
export DATABASE_URL="postgresql://user:password@db.example.com:5432/ai_teams?sslmode=require"
```

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/ai_teams" \
AI_TEAMS_AUTH_TOKEN=<server-auth-token> \
ai-teams-server
```

**切换规则：** `DATABASE_URL` 有值时使用 PostgreSQL，否则使用 SQLite。两者表结构一致，Server 启动时自动建表。

---

## 日志

Server 使用 Pino 结构化 JSON 日志，默认输出到 stdout。

### 输出到文件

```bash
# 同时输出到 stdout 和文件
ai-teams-server --token <server-auth-token> --log-dir ./logs

# 环境变量方式
LOG_DIR=./logs AI_TEAMS_AUTH_TOKEN=<server-auth-token> ai-teams-server
```

日志文件：`$LOG_DIR/server.log`

### 调整日志级别

```bash
ai-teams-server --token <server-auth-token> --log-level debug

# 或环境变量
LOG_LEVEL=debug AI_TEAMS_AUTH_TOKEN=<server-auth-token> ai-teams-server
```

### 查看日志

```bash
# 直接查看 JSON 日志
tail -f logs/server.log

# 格式化输出（需安装 pino-pretty）
tail -f logs/server.log | npx pino-pretty
```

### 日志覆盖的事件

| 事件 | 级别 | 说明 |
|------|------|------|
| 任务创建/分发/接受/开始/完成/取消 | `info` | 任务全生命周期 |
| 任务失败 | `warn` | 含错误原因 |
| 任务超时 | `warn` | 含超时秒数 |
| 认证失败 | `warn` | 含请求 URL 和 IP |
| 数据库写入失败 | `error` | 持久化异常 |
| Webhook 投递失败 | `warn` | 含重试次数 |
| HTTP 请求 | `info` | Fastify 自动记录（方法、路径、状态码、耗时） |

---

## API 文档

Server 启动后可访问 Swagger UI：

```
http://localhost:3789/docs
```

OpenAPI JSON：

```
http://localhost:3789/docs/json
```

---

## 构建与测试

```bash
pnpm build       # 构建（shared 必须先编译）
pnpm test        # 运行所有测试
pnpm typecheck   # 类型检查
```

运行单个测试文件：

```bash
pnpm vitest run apps/server/src/index.test.ts
```
