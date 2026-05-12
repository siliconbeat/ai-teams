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

# 开发模式（内置 dev-token 认证）
pnpm dev:all
```

`dev:all` 会同时启动：
- Server — `http://localhost:3789`
- Agent (alice) — 连接 Server，RUNNER_MODE=claude
- Web — `http://localhost:5173`

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
| `permissionMode` | string | 权限模式 |
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

---

## 启动方式

### 开发模式

```bash
pnpm dev:server          # Server on :3789
pnpm dev:agent:alice     # Agent with EMPLOYEE_ID=alice
pnpm dev:web             # Web on :5173
pnpm dev:all             # 全部启动
```

开发模式自动使用 `dev-token`。

### 生产模式

```bash
export AI_TEAMS_AUTH_TOKEN=your-secret-token
pnpm build
pnpm start:all
```

### 多员工

```bash
AI_TEAMS_AUTH_TOKEN=dev-token EMPLOYEE_ID=alice EMPLOYEE_NAME=Alice RUNNER_MODE=claude pnpm --filter @ai-teams/agent dev
AI_TEAMS_AUTH_TOKEN=dev-token EMPLOYEE_ID=bob EMPLOYEE_NAME=Bob RUNNER_MODE=fake pnpm --filter @ai-teams/agent dev
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_TEAMS_AUTH_TOKEN` | — | 共享认证 Token（生产必填） |
| `AI_TEAMS_SERVER_PORT` | `3789` | 服务端口 |
| `SERVER_URL` | `ws://localhost:3789` | Agent 连接地址 |
| `EMPLOYEE_ID` | `emp_local` | 员工 ID |
| `EMPLOYEE_NAME` | `Local Agent` | 员工名称 |
| `EMPLOYEE_LABELS` | — | 逗号分隔标签 |
| `RUNNER_MODE` | `claude` | `claude` 或 `fake`（测试用） |
| `DEFAULT_WORKSPACE` | 当前目录 | 默认工作目录 |
| `DEFAULT_TIMEOUT_SEC` | `1800` | 任务超时秒数 |
| `DISCONNECT_GRACE_MS` | `15000` | 断线恢复宽限期 |
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
AI_TEAMS_AUTH_TOKEN=your-secret \
ai-teams-server
```

**切换规则：** `DATABASE_URL` 有值时使用 PostgreSQL，否则使用 SQLite。两者表结构一致，Server 启动时自动建表。

---

## 日志

Server 使用 Pino 结构化 JSON 日志，默认输出到 stdout。

### 输出到文件

```bash
# 同时输出到 stdout 和文件
ai-teams-server --token xxx --log-dir ./logs

# 环境变量方式
LOG_DIR=./logs AI_TEAMS_AUTH_TOKEN=xxx ai-teams-server
```

日志文件：`$LOG_DIR/server.log`

### 调整日志级别

```bash
ai-teams-server --token xxx --log-level debug

# 或环境变量
LOG_LEVEL=debug AI_TEAMS_AUTH_TOKEN=xxx ai-teams-server
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
