# npm 打包发布 + Agent TUI 配置

## 目标

将 Server 和 Agent 打包为独立的全局 npm 包，用户可通过 `npm install -g` 安装并直接使用。Agent 提供基于 readline 的 TUI 配置向导。

## 包结构

```
@csdwd/ai-teams-server  →  ai-teams-server 命令
@csdwd/ai-teams-agent   →  ai-teams-agent 命令
@ai-teams/shared        →  内部依赖（npm 发布）
```

## 使用体验

```bash
npm install -g @csdwd/ai-teams-server
npm install -g @csdwd/ai-teams-agent

ai-teams-server --port 3789 --token my-secret
ai-teams-agent           # 无配置时启动向导
ai-teams-agent --config  # 强制重新配置
```

## 改动清单

### 1. shared 包发布准备

- `packages/shared/package.json`：移除 `private: true`

### 2. Server 包改造 (`@csdwd/ai-teams-server`)

- 移除 `private: true`
- 添加 `bin: { "ai-teams-server": "./dist/index.js" }`
- 添加 `files: ["dist"]`
- 入口文件顶部加 `#!/usr/bin/env node`
- 添加 CLI 参数解析（port、token、host、data-dir）
- `@ai-teams/shared` 依赖保持 `workspace:*`，pnpm publish 自动替换

### 3. Agent 包改造 (`@csdwd/ai-teams-agent`)

- 移除 `private: true`
- 添加 `bin: { "ai-teams-agent": "./dist/index.js" }`
- 添加 `files: ["dist"]`
- 入口文件顶部加 `#!/usr/bin/env node`

### 4. Agent TUI 配置模块

新增 `apps/agent/src/setup.ts`：

- 使用 `node:readline/promises` 实现
- 交互式收集：服务器地址、Token、员工 ID、员工名称、工作目录、Runner 模式
- 保存到 `~/.ai-teams/config.json`
- 配置文件优先级：CLI 参数 > 环境变量 > 配置文件 > 默认值

### 5. Agent config.ts 改造

- 新增 `loadConfigFile()` 函数，读取 `~/.ai-teams/config.json`
- 各配置项来源优先级：环境变量 > 配置文件 > 默认值

## Agent TUI 流程

```
$ ai-teams-agent

⚠ 未找到配置文件，启动配置向导...

  AI Teams Agent 配置
  ───────────────────

  服务器地址 [ws://localhost:3789]: _
  认证 Token: _
  员工 ID [emp_local]: _
  员工名称 [Local Agent]: _
  工作目录 [/current/path]: _
  Runner 模式 (claude/fake) [claude]: _

  ✓ 配置已保存到 ~/.ai-teams/config.json
  ✓ 正在连接服务器...
```

## 配置文件格式

`~/.ai-teams/config.json`:

```json
{
  "serverUrl": "ws://localhost:3789",
  "authToken": "my-secret",
  "employeeId": "alice",
  "employeeName": "Alice",
  "workspace": "/path/to/project",
  "runnerMode": "claude"
}
```

## 发布流程

```bash
# 1. 构建
pnpm build

# 2. 逐包发布（从 shared 开始）
cd packages/shared && npm publish --access public
cd apps/server && npm publish --access public
cd apps/agent && npm publish --access public
```
