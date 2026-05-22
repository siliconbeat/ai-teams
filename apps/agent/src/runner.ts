import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { EmployeeToServerMessage } from "@ai-teams/shared";
import {
  EMPLOYEE_ID,
  EMPLOYEE_NAME,
  DEFAULT_WORKSPACE,
  AGENT_RECORDS_DIR,
  CLAUDE_HOOKS_ENABLED,
  CLAUDE_HOOK_SETTINGS,
  CLAUDE_MISSING_CONVERSATION_PATTERN,
  MAX_ERROR_TAIL,
  type ActiveTask,
  type AgentState,
} from "./config.js";
import { ensureWorkspaceClaudeMd, ensureClaudeHookFiles } from "./records.js";
import { resetClaudeSession } from "./state.js";

function resolveWorkspace(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) {
    return DEFAULT_WORKSPACE;
  }
  let resolved = raw.trim();
  // ~ → home directory
  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  // Relative path → under DEFAULT_WORKSPACE
  if (!path.isAbsolute(resolved)) {
    resolved = path.join(DEFAULT_WORKSPACE, resolved);
  }
  // Auto-create if not exists
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export interface RunnerDeps {
  findActiveTask: (taskId: string) => ActiveTask | null;
  emitOutput: (taskId: string, stream: "stdout" | "stderr", content: string) => void;
  emitStderr: (taskId: string, content: string) => void;
  finishTask: (taskId: string, status: "completed" | "failed" | "cancelled", payload?: string | number) => void;
  send: (payload: EmployeeToServerMessage) => void;
  getAgentState: () => AgentState;
  setAgentState: (state: AgentState) => void;
}

export function handleClaudeJsonLine(
  taskId: string,
  line: string,
  findActiveTask: RunnerDeps["findActiveTask"],
  emitOutput: RunnerDeps["emitOutput"],
) {
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
    if (!event) return;

    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && delta.text) {
        const task = findActiveTask(taskId);
        if (task) {
          task.sawStreamText = true;
          task.summary.push(delta.text);
        }
        emitOutput(taskId, "stdout", delta.text, true);
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        emitOutput(taskId, "stdout", delta.thinking, true);
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        emitOutput(taskId, "stdout", delta.partial_json, true);
      }
    } else if (event.type === "content_block_start" && event.content_block) {
      const block = event.content_block;
      const task = findActiveTask(taskId);
      if (block.type === "tool_use" && block.name) {
        if (task) task.lastToolBlock = true;
        emitOutput(taskId, "stdout", `\n[tool] ${block.name}(`);
      } else if (block.type === "thinking") {
        emitOutput(taskId, "stdout", "\n[thinking] ");
      }
    } else if (event.type === "content_block_stop") {
      const task = findActiveTask(taskId);
      if (task?.lastToolBlock) {
        emitOutput(taskId, "stdout", ")\n");
        task.lastToolBlock = false;
      }
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
      } else if (block.type === "thinking" && block.thinking) {
        emitOutput(taskId, "stdout", `[thinking] ${block.thinking}\n`);
      } else if (block.type === "tool_use" && block.name) {
        emitOutput(taskId, "stdout", `[tool] ${block.name}(${block.input ? JSON.stringify(block.input) : ""})\n`);
      }
    }
    return;
  }

  if (parsed.type === "result" && typeof parsed.result === "string") {
    const task = findActiveTask(taskId);
    if (task?.sawStreamText) {
      // Text already streamed — only emit metrics, skip duplicate result text
      emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed, true));
      extractMetrics(taskId, parsed, findActiveTask);
      return;
    }
    task?.summary.push(parsed.result);
    emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed, false));
    extractMetrics(taskId, parsed, findActiveTask);
  }
}

export function formatClaudeDoneNode(node: Record<string, unknown>, skipResult = false) {
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
  if (!skipResult) {
    const result = typeof node.result === "string" ? node.result.trim() : "";
    if (result) {
      lines.push(`[done] result: ${result}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function extractMetrics(
  taskId: string,
  node: Record<string, unknown>,
  findActiveTask: RunnerDeps["findActiveTask"],
) {
  const task = findActiveTask(taskId);
  if (!task) return;
  if (typeof node.duration_ms === "number") task.resultMetrics.durationMs = node.duration_ms;
  if (typeof node.duration_api_ms === "number") task.resultMetrics.durationApiMs = node.duration_api_ms;
  if (typeof node.num_turns === "number") task.resultMetrics.numTurns = node.num_turns;
  if (typeof node.total_cost_usd === "number") task.resultMetrics.totalCostUsd = node.total_cost_usd;
  const usage = node.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.input_tokens === "number") task.resultMetrics.usageInputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") task.resultMetrics.usageOutputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") task.resultMetrics.usageCacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") task.resultMetrics.usageCacheCreationTokens = u.cache_creation_input_tokens;
  }
}

export function buildClaudeArgs(prompt: string, task: ActiveTask, agentState: AgentState) {
  ensureWorkspaceClaudeMd();
  ensureClaudeHookFiles();
  const cfg = task.cliConfig;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (cfg?.model) {
    args.push("--model", cfg.model);
  }
  if (cfg?.maxTurns) {
    args.push("--max-turns", String(cfg.maxTurns));
  }
  if (cfg?.systemPrompt) {
    args.push("--system-prompt", cfg.systemPrompt);
  }
  if (cfg?.appendSystemPrompt) {
    args.push("--append-system-prompt", cfg.appendSystemPrompt);
  }
  if (cfg?.allowedTools && cfg.allowedTools.length > 0) {
    for (const tool of cfg.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (cfg?.disallowedTools && cfg.disallowedTools.length > 0) {
    for (const tool of cfg.disallowedTools) {
      args.push("--disallowedTools", tool);
    }
  }
  if (cfg?.extraArgs) {
    args.push(...cfg.extraArgs);
  }

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

export function shouldRetryWithFreshClaudeSession(
  taskId: string,
  exitCode: number | null,
  findActiveTask: RunnerDeps["findActiveTask"],
) {
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

export function runFakeTask(taskId: string, prompt: string, deps: RunnerDeps) {
  const { findActiveTask, send, emitOutput, finishTask } = deps;
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

export function runClaudeTask(taskId: string, prompt: string, workspace: string | null, deps: RunnerDeps) {
  const {
    findActiveTask,
    send,
    emitOutput,
    emitStderr,
    finishTask,
    getAgentState,
    setAgentState,
  } = deps;

  const currentTask = findActiveTask(taskId);
  if (!currentTask) {
    return;
  }

  const agentState = getAgentState();
  const args = buildClaudeArgs(prompt, currentTask, agentState);
  const resolvedWorkspace = resolveWorkspace(workspace);
  const child = spawn("claude", args, {
    cwd: resolvedWorkspace,
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
      AI_TEAMS_TASK_WORKSPACE: resolvedWorkspace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const taskStillActive = findActiveTask(taskId);
  if (!taskStillActive) {
    child.kill("SIGTERM");
    return;
  }
  if (taskStillActive.cancelRequested) {
    child.kill("SIGTERM");
    return;
  }

  currentTask.generation += 1;
  currentTask.child = child;
  send({ type: "task.started", taskId, pid: child.pid ?? 0, sessionId: currentTask.claudeSessionId });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  stdoutReader.on("line", (line) => {
    handleClaudeJsonLine(taskId, line, findActiveTask, emitOutput);
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
    if (shouldRetryWithFreshClaudeSession(taskId, code, findActiveTask)) {
      const fresh = findActiveTask(taskId);
      if (!fresh) return;
      if (fresh.cancelRequested) {
        finishTask(taskId, "cancelled");
        return;
      }
      fresh.retriedWithFreshSession = true;
      fresh.stderrTail = "";
      fresh.sawStreamText = false;
      fresh.child = null;
      const newState = resetClaudeSession();
      setAgentState(newState);
      fresh.claudeSessionId = newState.claudeSessionId;
      emitOutput(taskId, "stdout", "\n[agent] Claude resume session was missing. Starting a new session and retrying this task.\n");
      runClaudeTask(taskId, prompt, workspace, deps);
      return;
    }
    finishTask(taskId, "failed", `Claude CLI 退出码 ${code ?? "unknown"}`);
  });
}
