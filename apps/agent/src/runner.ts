import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { EmployeeToServerMessage } from "@ai-teams/shared";
import { isPermanentModelFailure } from "@ai-teams/shared";
import {
  EMPLOYEE_ID,
  EMPLOYEE_NAME,
  DEFAULT_WORKSPACE,
  AGENT_RECORDS_DIR,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_HOOKS_ENABLED,
  CLAUDE_HOOK_SETTINGS,
  CLAUDE_MISSING_CONVERSATION_PATTERN,
  CLAUDE_SESSION_BUSY_PATTERN,
  MODEL_TRANSIENT_ERROR_PATTERN,
  MAX_ERROR_TAIL,
  type ActiveTask,
  type AgentState,
} from "./config.js";
import { ensureWorkspaceClaudeMd, ensureClaudeHookFiles } from "./records.js";
import { resetClaudeSession } from "./state.js";
import { getClaudeVersion } from "./claude-version.js";

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
  emitOutput: (taskId: string, stream: "stdout" | "stderr", content: string, delta?: boolean) => void;
  emitStderr: (taskId: string, content: string) => void;
  finishTask: (
    taskId: string,
    status: "completed" | "failed" | "cancelled",
    payload?: string | number | { error: string; recoverable?: boolean; cooldownMs?: number; retryAfterMs?: number },
  ) => void;
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
          if (!task.resumingSession) task.summary.push(delta.text);
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

  if (parsed.type === "result" && parsed.is_error === true) {
    const task = findActiveTask(taskId);
    if (task) {
      task.cliResultError = true;
      task.stderrTail = `${task.stderrTail}\n${typeof parsed.result === "string" ? parsed.result : ""}\n${Array.isArray(parsed.errors) ? parsed.errors.join("\n") : ""}`.slice(-MAX_ERROR_TAIL);
    }
  }
  if (parsed.type === "result" && typeof parsed.result === "string") {
    const task = findActiveTask(taskId);
    if (task?.sawStreamText && !task.resumingSession) {
      // Text already streamed — only emit metrics, skip duplicate result text
      emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed, true));
      extractMetrics(taskId, parsed, findActiveTask);
      return;
    }
    if (task?.resumingSession && task.summary.length === 0) {
      task.summary.push(parsed.result);
    } else if (!task?.sawStreamText) {
      task?.summary.push(parsed.result);
    }
    emitOutput(taskId, "stdout", formatClaudeDoneNode(parsed, !task?.resumingSession && !!task?.sawStreamText));
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

export function resolveClaudePermissionMode(task: ActiveTask) {
  return task.cliConfig?.permissionMode || CLAUDE_PERMISSION_MODE || "bypassPermissions";
}

function appendPermissionModeArgs(args: string[], permissionMode: string) {
  if (permissionMode === "bypassPermissions" || permissionMode === "dangerously-skip-permissions") {
    args.push("--dangerously-skip-permissions");
    return;
  }
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
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
    "--include-partial-messages",
    "--verbose",
  ];
  appendPermissionModeArgs(args, resolveClaudePermissionMode(task));

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

  if (task.resumingSession) {
    args.push("--resume", task.claudeSessionId);
  } else if (task.targetMode === "queue") {
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
  const isMissingConversation = task ? CLAUDE_MISSING_CONVERSATION_PATTERN.test(task.stderrTail) : false;
  const isSessionBusy = task ? CLAUDE_SESSION_BUSY_PATTERN.test(task.stderrTail) : false;
  return (
    exitCode !== 0 &&
    task !== null &&
    !task.cancelRequested &&
    !task.retriedWithFreshSession &&
    (isSessionBusy || (!task.resumingSession && task.targetMode !== "queue" && isMissingConversation))
  );
}

export function classifyModelTransientFailure(
  taskId: string,
  exitCode: number | null,
  findActiveTask: RunnerDeps["findActiveTask"],
): { error: string; recoverable: true; cooldownMs: number; retryAfterMs?: number } | null {
  const task = findActiveTask(taskId);
  if (!task || task.cancelRequested || exitCode === 0) {
    return null;
  }
  const tail = task.stderrTail.slice(-MAX_ERROR_TAIL);
  if (isPermanentModelFailure(tail) || !MODEL_TRANSIENT_ERROR_PATTERN.test(tail)) {
    return null;
  }

  const retryAfterMatch = tail.match(/retry(?:-|\s*)after[:\s]+(\d+)\s*(ms|s|sec|seconds|m|min|minutes)?/i);
  let retryAfterMs: number | undefined;
  if (retryAfterMatch) {
    const value = Number(retryAfterMatch[1]);
    const unit = retryAfterMatch[2]?.toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      retryAfterMs = unit === "ms"
        ? value
        : unit?.startsWith("m")
        ? value * 60_000
        : value * 1000;
    }
  }

  const defaultCooldownMs = 60_000;
  const cooldownMs = Math.max(5_000, Math.min(retryAfterMs ?? defaultCooldownMs, 10 * 60_000));
  const lastLine = tail.trim().split("\n").slice(-1)[0]?.trim();
  return {
    error: lastLine
      ? `模型接口暂时不可用，稍后重试：${lastLine}`
      : `模型接口暂时不可用，Claude CLI 退出码 ${exitCode ?? "unknown"}。`,
    recoverable: true,
    cooldownMs,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function runFakeTask(taskId: string, prompt: string, deps: RunnerDeps) {
  const { findActiveTask, send, emitOutput, finishTask } = deps;
  const task = findActiveTask(taskId);
  send({ type: "task.started", taskId, attempt: task?.attempt, pid: process.pid, sessionId: task?.claudeSessionId ?? null, claudeVersion: getClaudeVersion({ refresh: true }) });
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
  const permissionMode = resolveClaudePermissionMode(currentTask);
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
  const generation = currentTask.generation;
  currentTask.child = child;
  send({ type: "task.started", taskId, attempt: currentTask.attempt, pid: child.pid ?? 0, sessionId: currentTask.claudeSessionId, claudeVersion: getClaudeVersion({ refresh: true }) });
  emitOutput(taskId, "stdout", `[agent] permission_mode: ${permissionMode}\n`);

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
    if (task && task.generation !== generation) {
      return;
    }
    if (task?.cancelRequested) {
      finishTask(taskId, "cancelled");
      return;
    }
    if (code === 0 && !task?.cliResultError) {
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
      fresh.cliResultError = false;
      fresh.sawStreamText = false;
      fresh.child = null;
      const newState = resetClaudeSession();
      setAgentState(newState);
      fresh.claudeSessionId = newState.claudeSessionId;
      emitOutput(taskId, "stdout", "\n[agent] Claude session is unavailable or already in use. Starting a new session and retrying this task.\n");
      runClaudeTask(taskId, prompt, workspace, deps);
      return;
    }
    finishTask(taskId, "failed", classifyModelTransientFailure(taskId, task?.cliResultError ? 1 : code, findActiveTask) ?? `Claude CLI 退出码 ${code ?? "unknown"}：${findActiveTask(taskId)?.stderrTail.slice(-1000) ?? ""}`);
  });
}
