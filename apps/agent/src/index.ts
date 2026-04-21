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
  type TaskTargetMode,
} from "@ai-teams/shared";
import { CLAUDE_HOOK_SCRIPT_CONTENT } from "./claude-hook-script.js";

const SERVER_PORT = process.env.AI_TEAMS_SERVER_PORT || "3789";
const SERVER_URL = process.env.SERVER_URL || `ws://localhost:${SERVER_PORT}`;
const AUTH_TOKEN = process.env.AI_TEAMS_AUTH_TOKEN || "";
const EMPLOYEE_ID = process.env.EMPLOYEE_ID || "emp_local";
const EMPLOYEE_NAME = process.env.EMPLOYEE_NAME || "Local Agent";
const EMPLOYEE_LABELS = process.env.EMPLOYEE_LABELS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
const RECONNECT_MS = Number(process.env.RECONNECT_MS) || 5000;
const RUNNER_MODE = process.env.RUNNER_MODE || "claude";
const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || process.cwd();
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "default";
const MAX_BUFFERED_MESSAGES = Number(process.env.AGENT_BUFFER_LIMIT) || 400;
const MAX_ERROR_TAIL = 16000;
const CLAUDE_MISSING_CONVERSATION_PATTERN = /No conversation found with session ID/i;
const AGENT_RECORDS_DIR =
  process.env.AGENT_RECORDS_DIR || path.join(DEFAULT_WORKSPACE, ".ai-teams", "agents", EMPLOYEE_ID);
const STATE_FILE = process.env.AGENT_STATE_FILE || path.join(AGENT_RECORDS_DIR, "session-state.json");
const LEGACY_STATE_FILE = path.join(process.cwd(), `.agent-state.${EMPLOYEE_ID}.json`);
const DAILY_RECORDS_DIR = path.join(AGENT_RECORDS_DIR, "daily");
const HOOKS_DIR = path.join(AGENT_RECORDS_DIR, "hooks");
const CLAUDE_HOOK_SCRIPT = path.join(HOOKS_DIR, "claude-session-recorder.cjs");
const CLAUDE_HOOK_SETTINGS = path.join(HOOKS_DIR, "claude-hooks.settings.json");
const CLAUDE_HOOKS_ENABLED = process.env.CLAUDE_HOOKS_ENABLED !== "false";
const WORKSPACE_CLAUDE_MD = path.join(DEFAULT_WORKSPACE, "CLAUDE.md");
const CLAUDE_MD_SECTION_START = "<!-- AI_TEAMS_AGENT_RULES_START -->";
const CLAUDE_MD_SECTION_END = "<!-- AI_TEAMS_AGENT_RULES_END -->";

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
  targetMode: TaskTargetMode;
  claudeSessionId: string;
};

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let mainTask: ActiveTask | null = null;
let queueTask: ActiveTask | null = null;
let agentState = loadState();
let bufferedMessages: EmployeeToServerMessage[] = [];

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

function loadState(): AgentState {
  try {
    const content = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as Partial<AgentState>;
    return {
      claudeSessionId: parsed.claudeSessionId || randomUUID(),
      sessionReady: parsed.sessionReady ?? false,
    };
  } catch {
    const legacyState = loadLegacyState();
    if (legacyState) {
      persistState(legacyState);
      return legacyState;
    }
    const state = { claudeSessionId: randomUUID(), sessionReady: false };
    persistState(state);
    return state;
  }
}

function loadLegacyState(): AgentState | null {
  if (process.env.AGENT_STATE_FILE || LEGACY_STATE_FILE === STATE_FILE || !fs.existsSync(LEGACY_STATE_FILE)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, "utf8")) as Partial<AgentState>;
    return {
      claudeSessionId: parsed.claudeSessionId || randomUUID(),
      sessionReady: parsed.sessionReady ?? false,
    };
  } catch {
    return null;
  }
}

function persistState(state: AgentState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function localTimestamp() {
  return new Date().toLocaleString();
}

function localDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function appendDailyRecord(markdown: string) {
  fs.mkdirSync(DAILY_RECORDS_DIR, { recursive: true });
  const filePath = path.join(DAILY_RECORDS_DIR, `${localDateKey()}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${EMPLOYEE_NAME} Daily Activity - ${localDateKey()}\n\n`);
  }
  fs.appendFileSync(filePath, markdown);
}

function formatPromptForRecord(prompt: string) {
  return prompt.trim().replace(/\n/g, "\n  ");
}

function recordTaskStart(task: ActiveTask, prompt: string, workspace: string | null) {
  appendDailyRecord(
    [
      `## ${localTimestamp()} Task Started`,
      `- Agent: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`,
      `- Task ID: ${task.taskId}`,
      `- Target mode: ${task.targetMode}`,
      `- Claude session: ${task.claudeSessionId}`,
      `- Workspace: ${workspace || DEFAULT_WORKSPACE}`,
      `- Prompt:`,
      `  ${formatPromptForRecord(prompt)}`,
      "",
    ].join("\n"),
  );
}

function recordTaskFinish(task: ActiveTask, status: "completed" | "failed" | "cancelled", detail?: string | number) {
  appendDailyRecord(
    [
      `## ${localTimestamp()} Task ${status}`,
      `- Agent: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`,
      `- Task ID: ${task.taskId}`,
      `- Target mode: ${task.targetMode}`,
      `- Claude session: ${task.claudeSessionId}`,
      typeof detail === "undefined" ? "" : `- Detail: ${String(detail).replace(/\n/g, " ")}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function ensureWorkspaceClaudeMd() {
  fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  const section = buildWorkspaceClaudeSection();
  const current = fs.existsSync(WORKSPACE_CLAUDE_MD) ? fs.readFileSync(WORKSPACE_CLAUDE_MD, "utf8") : "";
  const startIndex = current.indexOf(CLAUDE_MD_SECTION_START);
  const endIndex = current.indexOf(CLAUDE_MD_SECTION_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const next = `${current.slice(0, startIndex).trimEnd()}\n\n${section}\n\n${current
      .slice(endIndex + CLAUDE_MD_SECTION_END.length)
      .trimStart()}`;
    fs.writeFileSync(WORKSPACE_CLAUDE_MD, next.trimEnd() + "\n");
    return;
  }

  const next = current.trim()
    ? `${current.trimEnd()}\n\n${section}\n`
    : `${section}\n`;
  fs.writeFileSync(WORKSPACE_CLAUDE_MD, next);
}

function buildWorkspaceClaudeSection() {
  return [
    CLAUDE_MD_SECTION_START,
    "## AI Teams Agent Operating Rules",
    "",
    `- Agent identity: ${EMPLOYEE_NAME} (${EMPLOYEE_ID}).`,
    `- Default workspace: \`${DEFAULT_WORKSPACE}\`.`,
    `- Default managed session state: \`${STATE_FILE}\`.`,
    `- Daily memory files: \`${path.join(DAILY_RECORDS_DIR, "YYYY-MM-DD.md")}\`.`,
    `- Claude hook settings: \`${CLAUDE_HOOK_SETTINGS}\`.`,
    "",
    "### Conversation Responsibility",
    "",
    "- Treat direct `@Agent` or explicitly selected-Agent messages as this Agent's long-running default conversation.",
    "- Keep continuity for direct Agent conversations by using the managed default session state.",
    "- Treat queue tasks as isolated execution jobs; use their task-specific session context and avoid assuming they update the default conversation unless explicitly requested.",
    "- When reporting back, summarize what changed, what was verified, and any remaining risks.",
    "",
    "### Memory And State Rules",
    "",
    "- At the start of a direct Agent conversation, read the most recent daily memory files before acting when continuity, prior decisions, or current workspace state could matter.",
    "- Read today's memory file first, then recent previous days only as needed. Do not bulk-load all history unless the task asks for a retrospective.",
    "- Use the daily memory files to understand what this Agent did, which tasks completed, which tools ran, and what unresolved work remains.",
    "- Append durable observations through the AI Teams recorder and Claude hooks; avoid hand-editing generated hook records unless correcting an obvious mistake.",
    "- Do not store secrets, tokens, private credentials, or sensitive user data in daily memory files.",
    "",
    "### Files Managed By AI Teams",
    "",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/session-state.json` stores the default Claude session id for this Agent.",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/daily/` stores Markdown activity memory by date.",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/hooks/` stores generated Claude Code hook scripts and settings.",
    "- These files are runtime state, not source code. Do not delete them unless explicitly asked to reset Agent memory.",
    CLAUDE_MD_SECTION_END,
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureClaudeHookFiles() {
  if (!CLAUDE_HOOKS_ENABLED) {
    return;
  }
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_HOOK_SCRIPT, CLAUDE_HOOK_SCRIPT_CONTENT);
  fs.chmodSync(CLAUDE_HOOK_SCRIPT, 0o755);
  fs.writeFileSync(CLAUDE_HOOK_SETTINGS, JSON.stringify(buildClaudeHookSettings(), null, 2));
}

function buildHookCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(CLAUDE_HOOK_SCRIPT)}`;
}

function buildClaudeHookSettings() {
  const hook = {
    type: "command",
    command: buildHookCommand(),
    timeout: 10,
  };
  return {
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [hook] }],
      UserPromptSubmit: [{ matcher: "*", hooks: [hook] }],
      PostToolUse: [{ matcher: "*", hooks: [hook] }],
      Stop: [{ matcher: "*", hooks: [hook] }],
      StopFailure: [{ matcher: "*", hooks: [hook] }],
      SessionEnd: [{ matcher: "*", hooks: [hook] }],
      PostCompact: [{ matcher: "*", hooks: [hook] }],
    },
  };
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
  const task = findActiveTask(taskId);
  if (!task || !content) {
    return;
  }
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
  if (!task || !content) {
    return;
  }
  task.stderrTail = `${task.stderrTail}${content}`.slice(-MAX_ERROR_TAIL);
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
    activeMainTaskId: mainTask?.taskId ?? null,
    activeQueueTaskId: queueTask?.taskId ?? null,
    lastOutputSeq: Math.max(mainTask?.seq ?? 0, queueTask?.seq ?? 0),
  });
}

function requestTask() {
  send({ type: "agent.request_task", employeeId: EMPLOYEE_ID });
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
      const task = findActiveTask(taskId);
      if (task) {
        task.sawStreamText = true;
        task.summary.push(event.delta.text);
      }
      emitOutput(taskId, "stdout", event.delta.text);
    }
    return;
  }

  if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
    const task = findActiveTask(taskId);
    if (task?.sawStreamText) {
      return;
    }
    for (const block of parsed.message.content) {
      if (block.type === "text" && block.text) {
        task?.summary.push(block.text);
        emitOutput(taskId, "stdout", `${block.text}\n`);
      }
      if (block.type === "tool_use" && block.name) {
        emitOutput(taskId, "stdout", `[tool] ${block.name}\n`);
      }
    }
    return;
  }

  if (parsed.type === "result" && typeof parsed.result === "string") {
    const task = findActiveTask(taskId);
    if (task?.sawStreamText) {
      emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed));
      return;
    }
    task?.summary.push(parsed.result);
    emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed));
  }
}

function formatClaudeDoneNode(node: Record<string, unknown>) {
  const lines = ["\n[done] Claude result"];
  for (const key of ["subtype", "session_id", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd"]) {
    const value = node[key];
    if (value !== undefined && value !== null) {
      lines.push(`[done] ${key}: ${String(value)}`);
    }
  }
  const usage = node.usage;
  if (usage && typeof usage === "object") {
    lines.push(`[done] usage: ${JSON.stringify(usage)}`);
  }
  const result = typeof node.result === "string" ? node.result.trim() : "";
  if (result) {
    lines.push(`[done] result: ${result}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildClaudeArgs(prompt: string, task: ActiveTask) {
  ensureWorkspaceClaudeMd();
  ensureClaudeHookFiles();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    CLAUDE_PERMISSION_MODE,
  ];

  if (CLAUDE_HOOKS_ENABLED) {
    args.push("--settings", CLAUDE_HOOK_SETTINGS);
  }

  if (task.targetMode === "queue") {
    args.push("--session-id", task.claudeSessionId);
  } else if (agentState.sessionReady) {
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
  const task = findActiveTask(taskId);
  return (
    exitCode !== 0 &&
    task !== null &&
    task.targetMode !== "queue" &&
    !task.cancelRequested &&
    !task.retriedWithFreshSession &&
    CLAUDE_MISSING_CONVERSATION_PATTERN.test(task.stderrTail)
  );
}

function finishTask(taskId: string, status: "completed" | "failed" | "cancelled", payload?: string | number) {
  const current = findActiveTask(taskId);
  if (!current) {
    return;
  }
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
    });
    if (current.targetMode === "queue") {
      requestTask();
    }
    return;
  }

  if (status === "cancelled") {
    send({ type: "task.cancelled", taskId });
    if (current.targetMode === "queue") {
      requestTask();
    }
    return;
  }

  send({
    type: "task.failed",
    taskId,
    error: typeof payload === "string" ? payload : "任务执行失败。",
  });
  if (current.targetMode === "queue") {
    requestTask();
  }
}

function runFakeTask(taskId: string, prompt: string) {
  const task = findActiveTask(taskId);
  send({ type: "task.started", taskId, pid: process.pid, sessionId: task?.claudeSessionId ?? null });
  const steps = [
    `收到任务：${prompt}\n`,
    "分析任务上下文...\n",
    "执行模拟步骤 1/3...\n",
    "执行模拟步骤 2/3...\n",
    "执行模拟步骤 3/3...\n",
  ];
  let index = 0;
  const timer = setInterval(() => {
    const current = findActiveTask(taskId);
    if (!current) {
      clearInterval(timer);
      return;
    }
    if (index >= steps.length) {
      clearInterval(timer);
      finishTask(taskId, "completed", 0);
      return;
    }
    const chunk = steps[index];
    current.summary.push(chunk);
    emitOutput(taskId, "stdout", chunk);
    index += 1;
  }, 800);
}

function runClaudeTask(taskId: string, prompt: string, workspace: string | null) {
  const currentTask = findActiveTask(taskId);
  if (!currentTask) {
    return;
  }
  const args = buildClaudeArgs(prompt, currentTask);
  const child = spawn("claude", args, {
    cwd: workspace || DEFAULT_WORKSPACE,
    env: {
      ...process.env,
      AI_TEAMS_AGENT_ID: EMPLOYEE_ID,
      AI_TEAMS_AGENT_NAME: EMPLOYEE_NAME,
      AI_TEAMS_RECORD_DIR: AGENT_RECORDS_DIR,
      AI_TEAMS_DEFAULT_WORKSPACE: DEFAULT_WORKSPACE,
      AI_TEAMS_DEFAULT_SESSION_ID: agentState.claudeSessionId,
      AI_TEAMS_TASK_ID: currentTask.taskId,
      AI_TEAMS_TASK_TARGET_MODE: currentTask.targetMode,
      AI_TEAMS_TASK_SESSION_ID: currentTask.claudeSessionId,
      AI_TEAMS_TASK_PROMPT: prompt,
      AI_TEAMS_TASK_WORKSPACE: workspace || DEFAULT_WORKSPACE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const taskStillActive = findActiveTask(taskId);
  if (!taskStillActive) {
    child.kill("SIGTERM");
    return;
  }

  currentTask.child = child;
  send({ type: "task.started", taskId, pid: child.pid ?? 0, sessionId: currentTask.claudeSessionId });

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
    const task = findActiveTask(taskId);
    if (!task && code === null) {
      return;
    }
    if (task?.cancelRequested) {
      finishTask(taskId, "cancelled");
      return;
    }
    if (code === 0) {
      finishTask(taskId, "completed", 0);
      return;
    }
    if (shouldRetryWithFreshClaudeSession(taskId, code)) {
      if (!task) {
        return;
      }
      task.retriedWithFreshSession = true;
      task.stderrTail = "";
      task.sawStreamText = false;
      task.child = null;
      resetClaudeSession();
      task.claudeSessionId = agentState.claudeSessionId;
      emitOutput(taskId, "stdout", "\n[agent] Claude resume session was missing. Starting a new session and retrying this task.\n");
      runClaudeTask(taskId, prompt, workspace);
      return;
    }
    finishTask(taskId, "failed", `Claude CLI 退出码 ${code ?? "unknown"}`);
  });
}

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
    targetMode: message.targetMode,
    claudeSessionId: message.targetMode === "queue" ? randomUUID() : agentState.claudeSessionId,
  };
  slot.set(task);

  send({ type: "task.accepted", taskId: message.taskId });
  recordTaskStart(task, message.prompt, message.workspace);

  if (RUNNER_MODE === "fake") {
    runFakeTask(message.taskId, message.prompt);
    return;
  }

  runClaudeTask(message.taskId, message.prompt, message.workspace);
}

function cancelTask(taskId: string) {
  const task = findActiveTask(taskId);
  if (!task) {
    return;
  }
  task.cancelRequested = true;
  if (task.child) {
    task.child.kill("SIGTERM");
    setTimeout(() => {
      const t = findActiveTask(taskId);
      t?.child?.kill("SIGKILL");
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
    requestTask();
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
