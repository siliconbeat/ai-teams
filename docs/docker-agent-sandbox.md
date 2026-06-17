# Docker Agent 沙箱运行

这个方案只把 **Agent** 放进 Docker 容器。Server 和 Web 可以继续跑在宿主机，Agent 通过 WebSocket 连接宿主机的 Server。

容器内 Claude Code CLI 的默认工作目录是 `/workspace`，它对应宿主机上的 `./sandbox/agent-alice` 或你在 `AI_TEAMS_AGENT_WORKSPACE` 里指定的目录。不要把宿主机的 `/`、`$HOME`、SSH key、Docker socket 或生产密钥目录挂进容器。

## 系统要求

- Docker Desktop
- Node.js `>=22` 和 pnpm `>=9`，用于启动宿主机 Server/Web
- Server 监听 `3789`
- 容器内可执行 `claude`

## 1. 启动 Server 和 Web

开发模式：

```bash
pnpm dev:server
pnpm dev:web
```

开发模式 Server 使用 `dev-token`。Agent 仍需要先在 Web「员工管理」里添加或批准，并复制生成的 Agent Token。

生产模式需要显式设置共享 Token：

```bash
export AI_TEAMS_AUTH_TOKEN=your-secret-token
pnpm build
pnpm start:server
pnpm start:web
```

如果生产模式启用了 `AGENT_REGISTRATION_MODE=approval`，需要先在 Web 的「员工管理」里添加或批准 Agent，然后复制该 Agent 的 Token。

## 2. 准备 Agent 环境变量

```bash
cp docker/agent.env.example docker/agent.env
```

开发模式最少保留：

```env
AI_TEAMS_AGENT_TOKEN=从员工管理复制的-agent-token
SERVER_URL=ws://host.docker.internal:3789
EMPLOYEE_ID=alice
EMPLOYEE_NAME=Alice
RUNNER_MODE=claude
CLAUDE_PERMISSION_MODE=bypassPermissions
AI_TEAMS_AGENT_WORKSPACE=./sandbox/agent-alice
```

## 3. 构建并启动 Agent 容器

```bash
docker compose --env-file docker/agent.env -f docker-compose.agent.yml up --build
```

后台运行：

```bash
docker compose --env-file docker/agent.env -f docker-compose.agent.yml up --build -d
```

查看日志：

```bash
docker compose -f docker-compose.agent.yml logs -f agent-alice
```

停止：

```bash
docker compose -f docker-compose.agent.yml down
```

## 4. 初始化 Claude Code 登录态

镜像默认安装 `@anthropic-ai/claude-code`。首次使用时进入容器完成登录或验证：

```bash
docker compose --env-file docker/agent.env -f docker-compose.agent.yml run --rm agent-alice bash
```

容器内执行：

```bash
claude --version
claude -p "hello"
```

登录态保存在 Docker volume `ai-teams-agent-alice-claude`，不会写入项目仓库。

## 5. 权限模式

推荐生产沙箱配置：

```env
CLAUDE_PERMISSION_MODE=bypassPermissions
```

这个模式不会卡在 Claude Code 权限确认，但前提是容器只挂载低风险 workspace。

更严格的模式：

```env
CLAUDE_PERMISSION_MODE=default
```

这个模式会按 Claude Code 默认权限策略运行，可能需要人工确认，因此不适合无人值守任务。

## 6. Linux 宿主机说明

macOS Docker Desktop 可以直接使用：

```env
SERVER_URL=ws://host.docker.internal:3789
```

如果 Linux 环境无法解析 `host.docker.internal`，在 `docker-compose.agent.yml` 的 `agent-alice` 服务下加入：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

或者把 Server 也放进同一个 compose 网络后，改用服务名连接。

## 7. 沙箱边界

这个 Docker 配置提供的是文件系统和进程级隔离，不是完整安全边界。为了降低风险：

- 每个 Agent 使用独立 workspace
- 不挂载宿主机敏感目录
- 不挂载 `/var/run/docker.sock`
- 不把生产密钥写入 workspace
- 需要更强隔离时，为每个 Agent 使用独立 VM 或独立低权限宿主机用户
