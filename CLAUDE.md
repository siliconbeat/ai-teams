# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Teams is a three-party collaboration system where a human leader dispatches tasks to AI employee agents running `claude -p`. All communication flows through a central server over WebSocket.

- **Server** (`apps/server`) — Fastify HTTP + WebSocket server. Manages employee registration, task dispatch/queueing, timeout, persistence to SQLite via `node:sqlite`, and real-time broadcasting to leader clients. OpenAPI docs at `/docs`.
- **Agent** (`apps/agent`) — Connects to server via WebSocket, spawns `claude` CLI child processes to execute tasks. Supports `--resume` for session continuity. Generates daily Markdown activity logs and Claude Code hooks for session recording.
- **Web** (`apps/web`) — React single-page leader console for monitoring employees, viewing task output, and dispatching commands via WebSocket.
- **Shared** (`packages/shared`) — Protocol types (`EmployeeToServerMessage`, `LeaderToServerMessage`, etc.), JSON message parsing, and `@mention` resolution. All three apps depend on this package.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Build (shared must build first, others depend on it)
pnpm build

# Run all tests (builds shared first)
pnpm test

# Type checking (builds shared + server first)
pnpm typecheck

# Dev mode — starts all three services with dev-token auth
pnpm dev:all

# Individual dev services
pnpm dev:server          # Fastify on :3789, tsx watch
pnpm dev:agent:alice     # Agent with EMPLOYEE_ID=alice, RUNNER_MODE=claude
pnpm dev:web             # Vite dev server on :5173

# Production mode (requires AI_TEAMS_AUTH_TOKEN env)
pnpm start:all
```

To run a single test file:

```bash
pnpm vitest run apps/server/src/index.test.ts
```

Tests use `vitest` with `node:sqlite` aliased via `vitest.node-sqlite.ts` for compatibility.

## Architecture & Key Concepts

### Monorepo Structure

pnpm workspace with `apps/*` and `packages/*`. `@ai-teams/shared` is a workspace dependency of all three apps. Build order matters: shared must compile before others.

### WebSocket Protocol

Three WebSocket channels, all require shared Bearer token auth:

- `/ws/agent` — Employee agents connect here. Bidirectional: server sends `task.dispatch`/`task.cancel`, agent sends registration, heartbeat, and task lifecycle events.
- `/ws/leader` — Leader console connects here. Server pushes `snapshot`, `employee.upsert`, `task.upsert`, `task.output` messages. Leader sends `command.dispatch`, `command.send`, `command.broadcast`, `task.cancel`.

### Task Dispatch Modes

Tasks have three target modes set at creation:

- **queue** — enters shared FIFO queue, round-robin dispatched to any idle agent. Each queue task gets an independent Claude session.
- **direct** — dispatched to a specific agent by ID. Uses the agent's persistent Claude session (`--resume`).
- **broadcast** — same task sent to all online agents.

### Task Lifecycle

`queued → dispatched → accepted → running → completed | failed | cancelled | timeout`

Server enforces timeout via `setTimeout`. Terminal statuses are immutable — late events are ignored.

### Agent Session Management

- Direct/broadcast tasks use the agent's persistent Claude session (`agentState.claudeSessionId`), enabling conversation continuity.
- Queue tasks get a fresh `randomUUID()` session each time.
- If `--resume` fails (session missing), the agent resets its session and retries once.
- Session state persisted to `DEFAULT_WORKSPACE/.ai-teams/agents/<EMPLOYEE_ID>/session-state.json`.

### Server Persistence

SQLite stores employees, tasks, task logs (capped at 400 chunks per task), and webhook URLs. On startup, the server hydrates in-memory state from SQLite, marking all employees offline and re-queuing unfinished tasks.

### REST API

Server exposes `POST /api/tasks` (submit task, optional webhook callback), `GET /api/snapshot`, `GET /api/sessions/:sessionId/history`, and `GET /health`. All require Bearer auth.

### Environment Variables

Key env vars: `AI_TEAMS_AUTH_TOKEN` (required for all services), `AI_TEAMS_SERVER_PORT` (default 3789), `EMPLOYEE_ID`, `EMPLOYEE_NAME`, `RUNNER_MODE` (`claude` or `fake`), `DEFAULT_WORKSPACE`, `SERVER_URL`.

## 1. 编码前先思考

**不要假设。不要掩盖困惑。明确权衡。**

在开始实现之前：
- 明确陈述你的假设。如果不确定，请提问。
- 如果存在多种理解方式，全部列出——不要默默选择一种。
- 如果有更简单的方法，说明出来。在必要时提出反对意见。
- 如果有不清楚的地方，停止。指出困惑点并提问。

## 2. 简单优先

**用最少的代码解决问题。不做任何预先假设的扩展。**

- 不要实现未被要求的功能。
- 不要为一次性代码做抽象。
- 不要添加未被要求的"灵活性"或"可配置性"。
- 不要为不可能发生的情况编写错误处理。
- 如果你写了 200 行但可以用 50 行完成，请重写。

问自己："一个资深工程师会觉得这过于复杂吗？"如果答案是是，那就简化。

## 3. 外科手术式修改

**只改必要的部分。只清理你引入的问题。**

在修改现有代码时：
- 不要"顺便优化"相邻代码、注释或格式。
- 不要重构未出问题的部分。
- 保持现有风格，即使你有不同偏好。
- 如果发现无关的死代码，可以指出——但不要删除。

当你的修改产生"遗留物"时：
- 删除因你的修改而变得未使用的导入/变量/函数。
- 不要删除已有的死代码，除非被要求。

标准：每一行改动都必须能追溯到用户的请求。

## 4. 以目标驱动执行

**定义成功标准。循环验证直到达成。**

将任务转化为可验证的目标：
- "添加校验" → "为非法输入编写测试，然后让测试通过"
- "修复 bug" → "写一个能复现问题的测试，然后让它通过"
- "重构 X" → "确保重构前后测试均通过"

对于多步骤任务，先给出简要计划：

[步骤] → 验证：[检查方式]
[步骤] → 验证：[检查方式]
[步骤] → 验证：[检查方式]

<!-- AI_TEAMS_AGENT_RULES_START -->
## AI Teams Agent Operating Rules

- Agent identity: Alice (alice).
- Default workspace: `/Users/junhang/workspace/agent/ai-teams`.
- Default managed session state: `/Users/junhang/workspace/agent/ai-teams/.ai-teams/agents/alice/session-state.json`.
- Daily memory files: `/Users/junhang/workspace/agent/ai-teams/.ai-teams/agents/alice/daily/YYYY-MM-DD.md`.
- Claude hook settings: `/Users/junhang/workspace/agent/ai-teams/.ai-teams/agents/alice/hooks/claude-hooks.settings.json`.

### Conversation Responsibility

- Treat direct `@Agent` or explicitly selected-Agent messages as this Agent's long-running default conversation.
- Keep continuity for direct Agent conversations by using the managed default session state.
- Treat queue tasks as isolated execution jobs; use their task-specific session context and avoid assuming they update the default conversation unless explicitly requested.
- When reporting back, summarize what changed, what was verified, and any remaining risks.

### Memory And State Rules

- At the start of a direct Agent conversation, read the most recent daily memory files before acting when continuity, prior decisions, or current workspace state could matter.
- Read today's memory file first, then recent previous days only as needed. Do not bulk-load all history unless the task asks for a retrospective.
- Use the daily memory files to understand what this Agent did, which tasks completed, which tools ran, and what unresolved work remains.
- Append durable observations through the AI Teams recorder and Claude hooks; avoid hand-editing generated hook records unless correcting an obvious mistake.
- Do not store secrets, tokens, private credentials, or sensitive user data in daily memory files.

### Files Managed By AI Teams

- `.ai-teams/agents/<EMPLOYEE_ID>/session-state.json` stores the default Claude session id for this Agent.
- `.ai-teams/agents/<EMPLOYEE_ID>/daily/` stores Markdown activity memory by date.
- `.ai-teams/agents/<EMPLOYEE_ID>/hooks/` stores generated Claude Code hook scripts and settings.
- These files are runtime state, not source code. Do not delete them unless explicitly asked to reset Agent memory.
<!-- AI_TEAMS_AGENT_RULES_END -->
