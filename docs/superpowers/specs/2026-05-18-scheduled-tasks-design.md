# Scheduled Tasks Design

## Context

Server 需要支持定时任务，按 cron 表达式自动向 agent 或队列派发任务。配置持久化到 DB，支持 REST API 管理，server 重启后自动恢复。

## Architecture

复用现有 `dispatchLeaderCommand` 派发机制，新增 `schedules` 表和 cron 调度层。

```
REST API (CRUD) → schedules DB table → CronJob (内存)
                                              ↓ 触发
                                    dispatchLeaderCommand()
                                              ↓
                                    现有任务派发流程（queue/direct/broadcast）
```

## Database

新增 `schedules` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 名称 |
| cron_expr | TEXT | cron 表达式（5 字段） |
| enabled | INTEGER | 0=禁用, 1=启用 |
| target_mode | TEXT | "queue" / "direct" / "broadcast" |
| target_agents | TEXT | JSON 数组，direct 模式的 agent ID 列表 |
| prompt | TEXT | 任务 prompt |
| workspace | TEXT | 可选，工作目录 |
| timeout_sec | INTEGER | 可选，超时秒数 |
| priority | INTEGER | 0-3 |
| required_labels | TEXT | JSON 数组 |
| last_run_at | TEXT | 上次执行时间 ISO |
| next_run_at | TEXT | 下次执行时间 ISO |
| created_at | TEXT | 创建时间 ISO |
| updated_at | TEXT | 更新时间 ISO |

`initDb` 中建表，`hydrateState` 之后加载 schedules 并注册 cron jobs。

## Cron Scheduling

- 使用 `cron` npm 包的 `CronJob`
- 内存 Map `<string, CronJob>` 存活跃的 cron 实例（`scheduleJobs` in state-store）
- 触发时构造 `command.dispatch` 消息，调用 `dispatchLeaderCommand`
- 触发后更新 `last_run_at` 和 `next_run_at` 到 DB

### 启动恢复

Server 启动时（`createAiTeamsServer`），从 DB 查询所有 `enabled=1` 的 schedules，为每个创建 `CronJob` 并启动。

## REST API

所有接口需要 Bearer auth。

### POST /api/schedules

创建定时任务。

```json
{
  "name": "每日站会报告",
  "cron": "0 9 * * 1-5",
  "enabled": true,
  "targetMode": "queue",
  "targetAgents": [],
  "prompt": "生成本周工作总结",
  "workspace": "/path/to/project",
  "timeoutSec": 600,
  "priority": 0,
  "requiredLabels": []
}
```

Response `201`: `{ id, name, cron, enabled, targetMode, ..., nextRunAt }`

### GET /api/schedules

列表，返回数组。

### GET /api/schedules/:id

单个详情。

### PATCH /api/schedules/:id

更新任意字段。若修改 `cron` 或 `enabled`，停止旧 job、创建新 job。

```json
{ "enabled": false }
```

### DELETE /api/schedules/:id

删除并停止 cron job。

### POST /api/schedules/:id/trigger

手动立即触发一次（不改变 cron 调度）。

## Implementation

新增文件：
- `apps/server/src/scheduler.ts` — CronJob 管理：create/start/stop/trigger
- `apps/server/src/schemas.ts` — 新增 schedule 相关 schema

修改文件：
- `apps/server/src/db.ts` — 新增 schedules 表 CRUD
- `apps/server/src/state-store.ts` — 新增 `scheduleJobs` Map
- `apps/server/src/index.ts` — 注册路由，启动时加载 schedules
- `apps/server/package.json` — 新增 `cron` 依赖

## Verification

1. `POST /api/schedules` 创建一个每分钟执行的 schedule
2. 等待触发，检查 `GET /api/tasks` 是否产生了新任务
3. `PATCH /api/schedules/:id` `{ "enabled": false }` 确认不再触发
4. `POST /api/schedules/:id/trigger` 手动触发确认立即产生任务
5. 重启 server，确认 enabled schedules 自动恢复
