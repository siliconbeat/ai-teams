import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  parseJsonMessage,
  parseServerToEmployeeMessage,
  type EmployeeToServerMessage,
  type ServerToEmployeeMessage,
} from "@ai-teams/shared";

const SERVER_PORT = process.env.AI_TEAMS_SERVER_PORT || "3789";
const SERVER_URL = process.env.SERVER_URL || `ws://localhost:${SERVER_PORT}`;
const AUTH_TOKEN = process.env.AI_TEAMS_AUTH_TOKEN || "";
const EMPLOYEE_ID = process.env.EMPLOYEE_ID || "emp_local";
const EMPLOYEE_NAME = process.env.EMPLOYEE_NAME || "Local Agent";
const EMPLOYEE_LABELS = process.env.EMPLOYEE_LABELS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
const RECONNECT_MS = Number(process.env.RECONNECT_MS) || 5000;
const RUNNER_MODE = process.env.RUNNER_MODE || "claude";
const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || process.cwd();
const STATE_FILE = process.env.AGENT_STATE_FILE || path.join(process.cwd(), `.agent-state.${EMPLOYEE_ID}.json`);
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "default";
const MAX_BUFFERED_MESSAGES = Number(process.env.AGENT_BUFFER_LIMIT) || 400;
const MAX_ERROR_TAIL = 16000;
const CLAUDE_MISSING_CONVERSATION_PATTERN = /No conversation found with session ID/i;

type AgentState = {
  claudeSessionId: string;
  sessionReady: boolean;
};

type ActiveTask = {
  taskId: string;
  seq: number;
  child: ChildProcess | null;
  summary: string[];
  cancelRequested: boolean;
  sawStreamText: boolean;
  stderrTail: string;
  retriedWithFreshSession: boolean;
};

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let activeTask: ActiveTask | null = null;
let agentState = loadState();
let bufferedMessages: EmployeeToServerMessage[] = [];

function loadState(): AgentState {
  try {
    const content = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as Partial<AgentState>;
    return {
      claudeSessionId: parsed.claudeSessionId || randomUUID(),
      sessionReady: parsed.sessionReady ?? false,
    };
  } catch {
    const state = { claudeSessionId: randomUUID(), sessionReady: false };
    persistState(state);
    return state;
  }
}

function persistState(state: AgentState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isTaskMessage(payload: EmployeeToServerMessage) {
  return payload.type.startsWith("task.");
}

function send(payload: EmployeeToServerMessage) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return;
  }
  if (isTaskMessage(payload)) {
    bufferedMessages.push(payload);
    if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
      bufferedMessages = bufferedMessages.slice(-MAX_BUFFERED_MESSAGES);
    }
  }
}

function emitOutput(taskId: string, stream: "stdout" | "stderr", content: string) {
  if (!activeTask || activeTask.taskId !== taskId || !content) {
    return;
  }
  activeTask.seq += 1;
  send({
    type: "task.output",
    taskId,
    stream,
    seq: activeTask.seq,
    content,
  });
}

function emitStderr(taskId: string, content: string) {
  if (!activeTask || activeTask.taskId !== taskId || !content) {
    return;
  }
  activeTask.stderrTail = `${activeTask.stderrTail}${content}`.slice(-MAX_ERROR_TAIL);
  emitOutput(taskId, "stderr", content);
}

function registerAgent() {
  send({
    type: "agent.register",
    employeeId: EMPLOYEE_ID,
    name: EMPLOYEE_NAME,
    machineId: EMPLOYEE_ID,
    hostname: os.hostname(),
    labels: EMPLOYEE_LABELS,
    maxConcurrentTasks: 1,
    activeTaskId: activeTask?.taskId ?? null,
    lastOutputSeq: activeTask?.seq ?? 0,
  });
}

function flushBufferedMessages() {
  if (!socket || socket.readyState !== WebSocket.OPEN || bufferedMessages.length === 0) {
    return;
  }
  const messages = bufferedMessages;
  bufferedMessages = [];
  for (const message of messages) {
    socket.send(JSON.stringify(message));
  }
}

function startHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    send({ type: "agent.heartbeat", employeeId: EMPLOYEE_ID });
  }, 10000);
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function handleClaudeJsonLine(taskId: string, line: string) {
  if (!line.trim()) {
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    emitOutput(taskId, "stdout", `${line}\n`);
    return;
  }

  if (parsed.type === "stream_event") {
    const event = parsed.event;
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      activeTask && (activeTask.sawStreamText = true);
      activeTask?.summary.push(event.delta.text);
      emitOutput(taskId, "stdout", event.delta.text);
    }
    return;
  }

  if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
    if (activeTask?.sawStreamText) {
      return;
    }
    for (const block of parsed.message.content) {
      if (block.type === "text" && block.text) {
        activeTask?.summary.push(block.text);
        emitOutput(taskId, "stdout", `${block.text}\n`);
      }
      if (block.type === "tool_use" && block.name) {
        emitOutput(taskId, "stdout", `[tool] ${block.name}\n`);
      }
    }
    return;
  }

  if (parsed.type === "result" && typeof parsed.result === "string") {
    if (activeTask?.sawStreamText) {
      return;
    }
    activeTask?.summary.push(parsed.result);
  }
}

function buildClaudeArgs(prompt: string) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    CLAUDE_PERMISSION_MODE,
  ];

  if (agentState.sessionReady) {
    args.push("--resume", agentState.claudeSessionId);
  } else {
    args.push("--session-id", agentState.claudeSessionId);
  }

  args.push(prompt);
  return args;
}

function resetClaudeSession() {
  agentState = { claudeSessionId: randomUUID(), sessionReady: false };
  persistState(agentState);
}

function shouldRetryWithFreshClaudeSession(taskId: string, exitCode: number | null) {
  return (
    exitCode !== 0 &&
    activeTask?.taskId === taskId &&
    !activeTask.cancelRequested &&
    !activeTask.retriedWithFreshSession &&
    CLAUDE_MISSING_CONVERSATION_PATTERN.test(activeTask.stderrTail)
  );
}

function finishTask(taskId: string, status: "completed" | "failed" | "cancelled", payload?: string | number) {
  const current = activeTask;
  activeTask = null;
  if (!current || current.taskId !== taskId) {
    return;
  }

  if (status === "completed") {
    agentState.sessionReady = true;
    persistState(agentState);
    send({
      type: "task.completed",
      taskId,
      exitCode: typeof payload === "number" ? payload : 0,
      summary: current.summary.join("").trim().slice(0, 8000) || "Claude 已完成任务。",
    });
    return;
  }

  if (status === "cancelled") {
    send({ type: "task.cancelled", taskId });
    return;
  }

  send({
    type: "task.failed",
    taskId,
    error: typeof payload === "string" ? payload : "任务执行失败。",
  });
}

function runFakeTask(taskId: string, prompt: string) {
  send({ type: "task.started", taskId, pid: process.pid });
  const steps = [
    `收到任务：${prompt}\n`,
    "分析任务上下文...\n",
    "执行模拟步骤 1/3...\n",
    "执行模拟步骤 2/3...\n",
    "执行模拟步骤 3/3...\n",
  ];
  let index = 0;
  const timer = setInterval(() => {
    if (!activeTask || activeTask.taskId !== taskId) {
      clearInterval(timer);
      return;
    }
    if (index >= steps.length) {
      clearInterval(timer);
      finishTask(taskId, "completed", 0);
      return;
    }
    const chunk = steps[index];
    activeTask.summary.push(chunk);
    emitOutput(taskId, "stdout", chunk);
    index += 1;
  }, 800);
}

function runClaudeTask(taskId: string, prompt: string, workspace: string | null) {
  const args = buildClaudeArgs(prompt);
  const child = spawn("claude", args, {
    cwd: workspace || DEFAULT_WORKSPACE,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!activeTask || activeTask.taskId !== taskId) {
    child.kill("SIGTERM");
    return;
  }

  activeTask.child = child;
  send({ type: "task.started", taskId, pid: child.pid ?? 0 });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  stdoutReader.on("line", (line) => {
    handleClaudeJsonLine(taskId, line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    emitStderr(taskId, chunk.toString());
  });

  child.on("error", (error) => {
    finishTask(taskId, "failed", error.message);
  });

  child.on("close", (code) => {
    if (!activeTask && code === null) {
      return;
    }
    if (activeTask?.cancelRequested) {
      finishTask(taskId, "cancelled");
      return;
    }
    if (code === 0) {
      finishTask(taskId, "completed", 0);
      return;
    }
    if (shouldRetryWithFreshClaudeSession(taskId, code)) {
      const current = activeTask;
      if (!current) {
        return;
      }
      current.retriedWithFreshSession = true;
      current.stderrTail = "";
      current.sawStreamText = false;
      current.child = null;
      resetClaudeSession();
      emitOutput(taskId, "stdout", "\n[agent] Claude resume session was missing. Starting a new session and retrying this task.\n");
      runClaudeTask(taskId, prompt, workspace);
      return;
    }
    finishTask(taskId, "failed", `Claude CLI 退出码 ${code ?? "unknown"}`);
  });
}

function startTask(message: Extract<ServerToEmployeeMessage, { type: "task.dispatch" }>) {
  if (activeTask) {
    send({
      type: "task.failed",
      taskId: message.taskId,
      error: `员工当前忙碌，正在执行任务 ${activeTask.taskId}。`,
    });
    return;
  }

  activeTask = {
    taskId: message.taskId,
    seq: 0,
    child: null,
    summary: [],
    cancelRequested: false,
    sawStreamText: false,
    stderrTail: "",
    retriedWithFreshSession: false,
  };

  send({ type: "task.accepted", taskId: message.taskId });

  if (RUNNER_MODE === "fake") {
    runFakeTask(message.taskId, message.prompt);
    return;
  }

  runClaudeTask(message.taskId, message.prompt, message.workspace);
}

function cancelTask(taskId: string) {
  if (!activeTask || activeTask.taskId !== taskId) {
    return;
  }
  activeTask.cancelRequested = true;
  if (activeTask.child) {
    activeTask.child.kill("SIGTERM");
    setTimeout(() => {
      activeTask?.child?.kill("SIGKILL");
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

function buildAgentWsUrl() {
  const url = new URL("/ws/agent", SERVER_URL);
  url.searchParams.set("token", AUTH_TOKEN);
  return url.toString();
}

export function connect() {
  if (!AUTH_TOKEN) {
    console.error("[agent] AI_TEAMS_AUTH_TOKEN is required.");
    process.exit(1);
  }

  socket = new WebSocket(buildAgentWsUrl());

  socket.on("open", () => {
    console.log(`[agent:${EMPLOYEE_ID}] connected to ${SERVER_URL}`);
    registerAgent();
    flushBufferedMessages();
    startHeartbeat();
  });

  socket.on("message", (raw: Buffer) => {
    try {
      const message = parseServerToEmployeeMessage(parseJsonMessage(raw.toString()));
      handleServerMessage(message);
    } catch (error) {
      console.error(`[agent:${EMPLOYEE_ID}] invalid server message`, error);
      socket?.close();
    }
  });

  socket.on("close", () => {
    console.log(`[agent:${EMPLOYEE_ID}] disconnected`);
    scheduleReconnect();
  });

  socket.on("error", (error) => {
    console.error(`[agent:${EMPLOYEE_ID}] websocket error`, error);
  });
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  connect();
}
