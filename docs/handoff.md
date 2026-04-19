# AI Teams 开发交接

## 当前目标

在当前目录下完成一个可运行的三端系统：

- `apps/server`：服务端
- `apps/agent`：AI 员工端
- `apps/web`：控制端

## 当前进度

- monorepo 已初始化完成
- 三端源码已具备 MVP 能力
- 服务端已支持员工注册、实时状态、任务下发、日志汇总
- 员工端已支持 fake runner 和真实 `claude -p`
- 员工端已支持按员工隔离的本地状态文件，以及 Claude 会话 `--resume`
- 控制端已具备员工监控、日志查看、单发/广播任务能力
- 服务端已接入 SQLite 持久化，默认数据库为 `data/ai-teams.db`
- 服务端已接入任务超时机制，超时后会给员工端发送取消并释放员工槽位
- 控制端已增加任务筛选、最近任务列表和失败任务高亮
- 根脚本已增加 `start:server`、`start:agent`、`start:web`、`start:all`
- 已验证：
  - `pnpm build` 通过
  - fake runner 端到端链路通过
  - 真实 Claude runner 端到端链路通过

## Claude CLI 会话

- 主开发会话 session id：`ea5b8c10-a033-4904-be0c-255f7fe51146`
- 当前线程已创建夜间 heartbeat automation，名称：`AI Teams Night Build`

## 核心约束

- 底层执行先使用本机 `claude` CLI。
- 先不使用 `--bare`。
- 员工端通过 `claude -p` 运行任务，并把输出实时回传给服务端。
- 服务端与员工端、控制端通过 WebSocket 交互。
- 控制端要能查看所有员工状态，并向单个或多个员工下达指令。

## MVP 范围

### 服务端

- 提供 HTTP 健康检查
- 提供 WebSocket 服务
- 管理员工连接与在线状态
- 接收控制端发送的任务指令
- 向目标员工分发任务
- 汇总并广播员工输出与任务状态

### 员工端

- 启动后向服务端注册
- 保持心跳
- 接收任务后调用 `claude -p`
- 将 stdout/stderr/状态实时回传
- 支持取消当前任务

### 控制端

- 展示员工卡片列表
- 展示在线状态、当前任务、实时日志
- 发送任务到单个员工
- 广播任务到全部员工

## 技术建议

- Monorepo：`pnpm workspace`
- 语言：TypeScript
- 服务端：Node.js + Fastify + WebSocket
- 员工端：Node.js + WebSocket + `child_process.spawn`
- 控制端：Vite + React
- 共享协议：`packages/shared`

## 实现顺序

1. 初始化 monorepo
2. 建立共享协议与类型
3. 实现服务端内存态调度
4. 实现员工端连接与假任务执行器
5. 实现控制端监控页面
6. 接入真实 `claude -p`
7. 联调和修复

## 下一步优先事项

1. 增加最小认证机制，避免任意 WebSocket 客户端冒充 Leader 或 Agent。
2. 给员工端增加更稳的 Claude 输出解析和失败重试。
3. 评估是否要把 web 静态资源直接由 server 托管，便于单服务部署。
4. 增加 SQLite 数据迁移版本号，避免后续表结构变化难以升级。
5. 增加断线恢复：Agent 重连后上报当前运行任务和最后输出序号。

## 注意事项

- 当前仓库没有现有代码，可以自由搭建。
- 优先保证可运行，不先追求复杂架构。
- 若 `claude` 调用不稳定，先保留 fake runner，后续再切真实 runner。
- 任何阶段都需要保持 `README.md` 可用于启动。
