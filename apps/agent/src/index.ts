import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  type EmployeeToServerMessage,
  type ServerToEmployeeMessage,
  type TaskTargetMode,
} from "@ai-teams/shared";
import {
  EMPLOYEE_ID,
  MAX_ERROR_TAIL,
  RUNNER_MODE,
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

let mainTask: ActiveTask | null = null;
let queueTask: ActiveTask | null = null;
let agentState = loadState();

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

function emitOutput(taskId: string, stream: "stdout" | "stderr", content: string) {
  const task = findActiveTask(taskId);
  if (!task || !content) return;
  task.seq += 1;
  send({
    type: "task.output",
    taskId,
    stream,
    seq: task.seq,
    content,
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
    if (current.targetMode !== "queue") {
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
  if (current.targetMode === "queue") requestTask();
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

  for (const task of [mainTask, queueTask]) {
    if (!task) continue;
    task.cancelRequested = true;
    task.child?.kill("SIGTERM");
    send({ type: "task.cancelled", taskId: task.taskId });
  }

  setTimeout(() => {
    for (const task of [mainTask, queueTask]) {
      task?.child?.kill("SIGKILL");
    }
  }, 2000);

  if (connState.reconnectTimer) clearTimeout(connState.reconnectTimer);
  if (connState.heartbeatTimer) clearInterval(connState.heartbeatTimer);

  if (connState.socket && connState.socket.readyState === WebSocket.OPEN) {
    connState.socket.close(1000, "agent shutting down");
  }

  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const isCli = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ai-teams-agent — AI Teams 员工代理

用法: ai-teams-agent [选项]

选项:
  --server <url>        服务器地址
  --token <token>       认证 Token
  --id <id>             员工 ID
  --name <name>         员工名称
  --workspace <dir>     工作目录
  --runner <mode>       Runner 模式 (claude/fake)
  --config              重新运行配置向导
  -h, --help            显示帮助
`);
    process.exit(0);
  }

  if (args.includes("--config")) {
    void runSetup(loadConfigFile()).then(() => {
      console.log("  \u2713 重新配置完成，请重新启动 agent。");
      process.exit(0);
    });
  } else {
    void (async () => {
      const fileConfig = loadConfigFile();
      const hasEnvConfig = process.env.AI_TEAMS_AUTH_TOKEN || process.env.SERVER_URL;
      if (!fileConfig && !hasEnvConfig) {
        console.log("\n  \u26A0 未找到配置文件且未设置环境变量，启动配置向导...\n");
        await runSetup(null);
      }

      // Apply CLI arg overrides
      function getArgValue(name: string): string | undefined {
        const idx = args.indexOf(name);
        if (idx === -1) return undefined;
        return args[idx + 1];
      }
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

      // Config is read at module level via config.ts, but CLI args
      // set env vars which take priority. We need to reconnect with
      // fresh config by re-importing the values. Since config.ts reads
      // env vars (which we just set), and the module was already loaded,
      // we rely on env var overrides being read from process.env directly
      // in config.ts — which they are.
      console.log(`  \u2713 正在连接服务器...`);
      connect();
    })();
  }
}
