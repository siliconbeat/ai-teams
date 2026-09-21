# 更新日志

## v0.9.1

### 修复 Claude 会话恢复

- 不再将进程启动时预生成的 UUID、初始化消息或失败输出当作可恢复会话；收到实际会话输出后才确认会话 ID。
- 缺失或冲突的恢复会话明确失败并保留诊断信息，不再反复 `--resume`、消耗模型重试预算，或静默丢弃上下文重放原任务。仅无执行证据、未恢复旧会话的新会话 ID 冲突允许换 ID 重试一次。
- 已确认的队列会话绑定原 Agent；原 Agent 离线时释放执行槽、跳过等待项，其他 Agent 可继续执行无关任务。归属未知的队列会话明确失败，不随机派给另一台机器。
- 分离 `reconnectCount` 与模型/任务 `retryCount`；重连预算耗尽后停止恢复，并保留之前的错误。
- 关闭会话持久化且已有执行输出时停止自动重放；忽略旧进程/旧尝试的迟到回调，避免影响替代任务或并行主会话。
- 补充 CLI 隔离桩、SQLite 旧数据迁移、Agent 离线与恢复回归；稳定 HTTP/WebSocket/Mission 测试等待并保留超时诊断。

### 升级与边界

- Server 与 Agent 请配套升级至 0.9.1；Web 随 Server 包发布。
- 新增 `session_employee_id`、`reconnect_count` 两列。旧数据已有 `employee_id` 时用其回填归属；原归属已丢失时不猜测。升级前请备份数据库。
- 原 Agent 长期离线时，其会话任务仍需人工处理，但不会占用其他 Agent 的执行槽。绑定的是逻辑 Agent ID，不能保证同 ID 换机器或重装后本地会话仍在。
- 已丢失的 Claude 会话不会被本补丁重建。请先核对已执行操作，再用不带旧会话 ID 的新任务提交剩余工作；“重置会话”仅重置 Agent 主会话，不清除旧任务上的会话 ID。
- 本补丁不提供 exactly-once 执行保证。SQLite 迁移已回归；PostgreSQL 实例迁移及真实 Claude 调用未在本轮实测。

## v0.6.0

### 新功能

#### AI Leader Mission 编排器

新增服务端 Mission 编排器，支持将一个总目标自动拆分为多个子任务、派发给 Agent 执行、等待结果汇总，并在风险节点请求人工确认。

- 新增 REST API：`POST /api/missions`、`GET /api/missions`、`GET /api/missions/:id`、`POST /api/missions/:id/cancel`、`POST /api/missions/:id/approvals/:approvalId/respond`
- 支持三种审批策略：`auto`（自动）、`ask_on_risky_change`（默认，风险目标需确认）、`manual_each_iteration`（每轮确认）
- 编排流程：`created → planning → dispatching → waiting_agents → reviewing → completed/failed`
- 人工确认支持 Web UI 内交互操作
- 新增数据库表：`missions`、`mission_events`、`mission_subtasks`、`mission_approvals`

#### Agent 注册审批机制

新增 Agent 注册管理流程，生产环境下 Agent 需先经 Leader 审批才能接入。

- 新增 REST API：`GET /api/agent-registry`、`POST /api/agent-registry`、`POST /api/agent-registry/:employeeId/approve`、`DELETE /api/agent-registry/:employeeId`
- 支持预注册（直接生成 Agent Token）和审批待审 Agent
- Agent Token 基于 HMAC-SHA256 验证，与 Server Token 绑定
- 配置项：`AGENT_REGISTRATION_MODE`（`approval` | `open`），默认 `approval`

#### Agent 队列管理

新增 Agent 级别的队列暂停/恢复控制。

- `POST /api/agents/:employeeId/pause-queue` — 暂停 Agent 的队列任务派发
- `POST /api/agents/:employeeId/resume-queue` — 恢复因连续失败或手动暂停的 Agent 队列
- 连续失败的 Agent 自动暂停队列，避免持续派发注定失败的任务

#### Agent 会话重置

- `POST /api/agents/:employeeId/reset-session` — 重置 Agent 的 main 槽 Claude 会话，下次 direct/broadcast 任务将启动新会话而非 resume

#### Agent Claude 会话列表

- `GET /api/employees/:employeeId/claude-sessions` — 列出 Agent 工作目录下所有 Claude Code 会话，含大小、行数、首条/最新用户消息摘要

#### 任务优先级提升

- `POST /api/tasks/:taskId/prioritize` — 将排队中的共享队列任务提升到队首

#### 任务输出查询

- `GET /api/tasks/:taskId/output` — 获取指定任务的完整输出文本

#### Docker Agent 沙箱

支持将 Agent 运行在 Docker 容器中，Server 和 Web 继续运行在宿主机。

- 新增 `Dockerfile.agent` 和 `docker-compose.agent.yml`
- 容器内工作目录固定为 `/workspace`，可映射到宿主机指定目录
- 支持 `bypassPermissions` 和 `default` 两种权限模式

#### Agent 权限模式可配置

Agent 执行任务时的 Claude 权限模式不再是硬编码的 `--dangerously-skip-permissions`，改为可配置：

- 环境变量 `CLAUDE_PERMISSION_MODE` 控制 Agent 默认权限模式
- 任务级别可通过 `cliConfig.permissionMode` 覆盖
- 启动时在输出中打印当前使用的权限模式

### 修复

#### 启动 OOM 修复

长时间运行后 `task_log` 表数据量过大导致服务启动时 Node 堆内存溢出的问题。

- 启动恢复逻辑拆分为：活跃任务全量加载 + 已结束任务限量加载（默认 200 个）
- 日志只加载已回灌任务的 ID，不再对 `task_logs` 全表做窗口查询
- 新增配置项 `MAX_HYDRATED_TASKS`（默认 200）和环境变量 `MAX_HYDRATED_TASKS`

#### 任务日志自动裁剪

写入任务日志时，内存中超过 `maxLogChunksPerTask` 的旧日志自动清理并同步删除数据库记录，避免数据库无限膨胀。

### 其他改进

- 断线恢复逻辑修复：正确区分 main 槽和 queue 槽任务的重入队行为
- Web UI 新增 Mission 面板、Agent 注册管理面板
- 数据库 schema 版本升级至 v3
- 新增 63 个测试用例覆盖全部新功能

---

## v0.5.3

（基线版本）
