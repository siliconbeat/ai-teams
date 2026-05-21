import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  type EmployeeToServerMessage,
  type ServerToEmployeeMessage,
  type TaskTargetMode,
} from "@ai-teams/shared";
import { daemonize, stopDaemon, getDaemonStatus } from "@ai-teams/shared/daemon";
import {
  EMPLOYEE_ID,
  MAX_ERROR_TAIL,
  RUNNER_MODE,
  reinitializeConfig,
  type ActiveTask,
  type AgentState,
} from "./config.js";
import { loadState, persistState, resetClaudeSession } from "./state.js";
import { recordTaskStart, recordTaskFinish } from "./records.js";
import { runClaudeTask, runFakeTask } from "./runner.js";
import {
  connect as connectionConnect,
  send as connectionSend,
  type ConnectionState,
} from "./connection.js";
import { runSetup, loadConfigFile } from "./setup.js";

declare const PKG_VERSION: string;
const version: string = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "dev";

let mainTask: ActiveTask | null = null;
let queueTask: ActiveTask | null = null;
let agentState = loadState();
let consecutiveQueueFailures = 0;
const MAX_CONSECUTIVE_QUEUE_FAILURES = 5;

const connState: ConnectionState = {
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  bufferedMessages: [],
};

function findActiveTask(taskId: string): ActiveTask | null {
  if (mainTask?.taskId === taskId) return mainTask;
  if (queueTask?.taskId === taskId) return queueTask;
  return null;
}

function slotForTargetMode(mode: TaskTargetMode): { get: () => ActiveTask | null; set: (t: ActiveTask | null) => void } {
  if (mode === "queue") {
    return { get: () => queueTask, set: (t) => { queueTask = t; } };
  }
  return { get: () => mainTask, set: (t) => { mainTask = t; } };
}

function send(payload: EmployeeToServerMessage) {
  connectionSend(connState, payload);
}

function emitOutput(taskId: string, stream: "stdout" | "stderr", content: string, delta = false) {
  const task = findActiveTask(taskId);
  if (!task || !content) return;
  task.seq += 1;
  send({
    type: "task.output",
    taskId,
    stream,
    seq: task.seq,
    content,
    ...(delta ? { delta: true } : {}),
  });
}

function emitStderr(taskId: string, content: string) {
  const task = findActiveTask(taskId);
  if (!task || !content) return;
  task.stderrTail = `${task.stderrTail}${content}`.slice(-MAX_ERROR_TAIL);
  emitOutput(taskId, "stderr", content);
}

function requestTask() {
  send({ type: "agent.request_task", employeeId: EMPLOYEE_ID });
}

function finishTask(taskId: string, status: "completed" | "failed" | "cancelled", payload?: string | number) {
  const current = findActiveTask(taskId);
  if (!current) return;
  const slot = slotForTargetMode(current.targetMode);
  slot.set(null);
  recordTaskFinish(current, status, payload);

  if (status === "completed") {
    if (current.targetMode === "queue") {
      consecutiveQueueFailures = 0;
    } else {
      agentState.sessionReady = true;
      persistState(agentState);
    }
    send({
      type: "task.completed",
      taskId,
      exitCode: typeof payload === "number" ? payload : 0,
      summary: current.summary.join("").trim().slice(0, 8000) || "Claude 已完成任务。",
      ...current.resultMetrics,
    });
    if (current.targetMode === "queue") requestTask();
    return;
  }

  if (status === "cancelled") {
    send({ type: "task.cancelled", taskId });
    if (current.targetMode === "queue") requestTask();
    return;
  }

  send({
    type: "task.failed",
    taskId,
    error: typeof payload === "string" ? payload : "任务执行失败。",
  });
  if (current.targetMode === "queue") {
    consecutiveQueueFailures += 1;
    if (consecutiveQueueFailures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      console.log(`[agent:${EMPLOYEE_ID}] 连续 ${consecutiveQueueFailures} 次队列任务失败，暂停接受新的队列任务。等待手动恢复。`);
      return;
    }
    requestTask();
  }
}

const runnerDeps = {
  findActiveTask,
  emitOutput,
  emitStderr,
  finishTask,
  send,
  getAgentState: () => agentState,
  setAgentState: (state: AgentState) => { agentState = state; },
};

function startTask(message: Extract<ServerToEmployeeMessage, { type: "task.dispatch" }>) {
  if (message.targetMode === "queue" && consecutiveQueueFailures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
    send({
      type: "task.failed",
      taskId: message.taskId,
      error: `Agent 连续 ${consecutiveQueueFailures} 次队列任务失败，暂停接受新队列任务，等待手动恢复。`,
    });
    return;
  }

  const slot = slotForTargetMode(message.targetMode);
  if (slot.get()) {
    send({
      type: "task.failed",
      taskId: message.taskId,
      error: `员工当前忙碌，${message.targetMode === "queue" ? "队列" : "主"}任务槽正在执行任务 ${slot.get()!.taskId}。`,
    });
    return;
  }

  const task: ActiveTask = {
    taskId: message.taskId,
    seq: 0,
    child: null,
    summary: [],
    cancelRequested: false,
    sawStreamText: false,
    stderrTail: "",
    retriedWithFreshSession: false,
    generation: 0,
    targetMode: message.targetMode,
    claudeSessionId: message.targetMode === "queue" ? randomUUID() : agentState.claudeSessionId,
    cliConfig: message.cliConfig ?? null,
    resultMetrics: {},
  };
  slot.set(task);

  send({ type: "task.accepted", taskId: message.taskId });
  recordTaskStart(task, message.prompt, message.workspace);

  if (RUNNER_MODE === "fake") {
    runFakeTask(message.taskId, message.prompt, runnerDeps);
    return;
  }

  runClaudeTask(message.taskId, message.prompt, message.workspace, runnerDeps);
}

function cancelTask(taskId: string) {
  const task = findActiveTask(taskId);
  if (!task) return;
  task.cancelRequested = true;
  if (task.child) {
    const gen = task.generation;
    task.child.kill("SIGTERM");
    setTimeout(() => {
      const t = findActiveTask(taskId);
      if (t && t.generation === gen && t.child) t.child.kill("SIGKILL");
    }, 3000);
  } else {
    finishTask(taskId, "cancelled");
  }
}

function handleServerMessage(message: ServerToEmployeeMessage) {
  if (message.type === "task.dispatch") {
    startTask(message);
    return;
  }
  if (message.type === "agent.registered") {
    const serverCount = message.consecutiveQueueFailures;
    if (serverCount > consecutiveQueueFailures) {
      consecutiveQueueFailures = serverCount;
      if (consecutiveQueueFailures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
        console.log(`[agent:${EMPLOYEE_ID}] 从服务器同步连续失败计数 ${consecutiveQueueFailures}，暂停接受队列任务。`);
      }
    }
    return;
  }
  if (message.type === "queue.resume") {
    consecutiveQueueFailures = 0;
    console.log(`[agent:${EMPLOYEE_ID}] 队列任务已恢复，重新开始接受任务。`);
    requestTask();
    return;
  }
  if (message.type === "session.reset") {
    agentState = resetClaudeSession();
    console.log(`[agent:${EMPLOYEE_ID}] 会话已重置，新 session: ${agentState.claudeSessionId}`);
    send({ type: "session.reset.ack", employeeId: EMPLOYEE_ID });
    return;
  }
  cancelTask(message.taskId);
}

export function connect() {
  connectionConnect(connState, () => mainTask, () => queueTask, handleServerMessage);
}

let shuttingDown = false;

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent:${EMPLOYEE_ID}] received ${signal}, shutting down...`);

  const children: Array<NonNullable<ActiveTask["child"]>> = [];
  for (const task of [mainTask, queueTask]) {
    if (!task) continue;
    task.cancelRequested = true;
    if (task.child) children.push(task.child);
    task.child?.kill("SIGTERM");
    send({ type: "task.cancelled", taskId: task.taskId });
  }
  mainTask = null;
  queueTask = null;

  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
  }, 2000);

  if (connState.reconnectTimer) clearTimeout(connState.reconnectTimer);
  if (connState.heartbeatTimer) clearInterval(connState.heartbeatTimer);

  if (connState.socket && connState.socket.readyState === WebSocket.OPEN) {
    connState.socket.close(1000, "agent shutting down");
  }

  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const isCli = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ai-teams-agent — AI Teams 员工代理

用法: ai-teams-agent <command> [选项]

命令:
  start [选项]          后台启动守护进程
  stop                  停止守护进程
  restart [选项]        重启守护进程
  status                查看运行状态

选项:
  --server <url>        服务器地址
  --token <token>       认证 Token
  --id <id>             员工 ID
  --name <name>         员工名称
  --workspace <dir>     工作目录
  --runner <mode>       Runner 模式 (claude/fake)
  --weight <number>     队列任务分配权重 (默认 1)
  --config              重新运行配置向导
  -v, --version         显示版本号
  -h, --help            显示帮助

不带命令直接运行时为前台模式。
`);
    process.exit(0);
  }

  function getArgValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  // Resolve paths based on workspace and employee ID
  function resolveWorkspace(): string {
    return getArgValue("--workspace") || process.env.DEFAULT_WORKSPACE || process.cwd();
  }
  function resolveAgentDir(): string {
    const ws = resolveWorkspace();
    const id = getArgValue("--id") || process.env.EMPLOYEE_ID || "emp_local";
    return path.join(ws, ".ai-teams", "agents", id);
  }
  function resolvePidFile(): string {
    return path.join(resolveAgentDir(), "agent.pid");
  }
  function resolveLogDir(): string {
    return path.join(resolveAgentDir(), "logs");
  }

  function applyCliArgsToEnv(): void {
    const cliServer = getArgValue("--server");
    const cliToken = getArgValue("--token");
    const cliId = getArgValue("--id");
    const cliName = getArgValue("--name");
    const cliWorkspace = getArgValue("--workspace");
    const cliRunner = getArgValue("--runner");
    if (cliServer) process.env.SERVER_URL = cliServer;
    if (cliToken) process.env.AI_TEAMS_AUTH_TOKEN = cliToken;
    if (cliId) process.env.EMPLOYEE_ID = cliId;
    if (cliName) process.env.EMPLOYEE_NAME = cliName;
    if (cliWorkspace) process.env.DEFAULT_WORKSPACE = cliWorkspace;
    if (cliRunner) process.env.RUNNER_MODE = cliRunner;
    const cliWeight = getArgValue("--weight");
    if (cliWeight) process.env.EMPLOYEE_WEIGHT = cliWeight;
  }

  if (args.includes("--config")) {
    void runSetup(loadConfigFile()).then(() => {
      console.log("  ✓ 重新配置完成，请重新启动 agent。");
      process.exit(0);
    });
  } else {
    const subcommand = args[0];

    if (subcommand === "start" || subcommand === "restart") {
      applyCliArgsToEnv();

      if (!process.env.__AI_TEAMS_DAEMON_WATCHDOG && !process.env.__AI_TEAMS_DAEMON_WORKER) {
        if (subcommand === "restart") {
          const pidFile = resolvePidFile();
          const status = getDaemonStatus(pidFile);
          if (status.running) {
            void stopDaemon(pidFile);
          }
        } else {
          const status = getDaemonStatus(resolvePidFile());
          if (status.running) {
            console.log(`Already running (PID ${status.pid}).`);
            process.exit(0);
          }
        }
      }

      // Ensure config exists
      const fileConfig = loadConfigFile();
      const hasEnvConfig = process.env.AI_TEAMS_AUTH_TOKEN || process.env.SERVER_URL;
      if (!fileConfig && !hasEnvConfig) {
        console.log("\n  ⚠ 未找到配置文件且未设置环境变量，请先运行 --config 配置。\n");
        process.exit(1);
      }

      void (async () => {
        await daemonize({
          name: "ai-teams-agent",
          pidFile: resolvePidFile(),
          logFile: path.join(resolveLogDir(), "agent.log"),
          run: async () => {
            console.log("  ✓ 正在连接服务器...");
            connect();
            return new Promise<void>(() => {}); // keep worker alive
          },
        });
      })();
    } else if (subcommand === "stop") {
      void stopDaemon(resolvePidFile());
    } else if (subcommand === "status") {
      const status = getDaemonStatus(resolvePidFile());
      if (status.running) {
        console.log(`ai-teams-agent is running (PID ${status.pid})`);
        console.log(`Log: ${path.join(resolveLogDir(), "agent.log")}`);
      } else {
        console.log("ai-teams-agent is not running.");
      }
    } else if (subcommand === "update") {
      const { execSync } = await import("node:child_process");
      try {
        execSync("npm install -g @csdwd/ai-teams-agent@latest", { stdio: "inherit" });
        const ver = execSync("ai-teams-agent --version").toString().trim();
        console.log(`\n  ✓ 已更新到 ${ver}`);
        const status = getDaemonStatus(resolvePidFile());
        if (status.running) {
          console.log("  提示: 运行 ai-teams-agent restart 以应用更新。");
        }
      } catch {
        process.exit(1);
      }
    } else {
      // No sub-command — foreground mode (existing behavior)
      void (async () => {
        const fileConfig = loadConfigFile();
        const hasEnvConfig = process.env.AI_TEAMS_AUTH_TOKEN || process.env.SERVER_URL;
        if (!fileConfig && !hasEnvConfig) {
          console.log("\n  ⚠ 未找到配置文件且未设置环境变量，启动配置向导...\n");
          await runSetup(null);
        }

        applyCliArgsToEnv();
        reinitializeConfig();
        console.log("  ✓ 正在连接服务器...");
        connect();
      })();
    }
  }
}
