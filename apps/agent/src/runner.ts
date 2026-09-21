import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EmployeeToServerMessage } from "@ai-teams/shared";
import { isPermanentModelFailure, isClaudeSessionFailure } from "@ai-teams/shared";
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
import { signalTaskProcess } from "./process-tree.js";

export const MAX_SUMMARY_CHARS = 8000;
export const MAX_CLI_LINE_BYTES = 1024 * 1024;
function appendSummary(task: ActiveTask | null, text: string) {
  if (!task || typeof text !== "string") return;
  const remaining = MAX_SUMMARY_CHARS - task.summary.reduce((size, part) => size + part.length, 0);
  if (remaining > 0) task.summary.push(text.slice(0, remaining));
}

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
  /** Injectable subprocess for offline integration tests; production uses spawn. */
  spawnClaude?: typeof spawn;
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

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  if (parsed.type === "result") {
    const task = findActiveTask(taskId);
    if (task) task.cliResultSuccess = parsed.subtype === "success" && parsed.is_error === false;
  }

  if (parsed.type === "stream_event") {
    const active = findActiveTask(taskId);
    if (active) active.hasExecutionEvidence = true;
    const event = parsed.event;
    if (!event) return;

    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        const task = findActiveTask(taskId);
        if (task) {
          task.sawStreamText = true;
          if (!task.resumingSession) appendSummary(task, delta.text);
        }
        emitOutput(taskId, "stdout", delta.text, true);
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        emitOutput(taskId, "stdout", delta.thinking, true);
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
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
    if (task) task.hasExecutionEvidence = true;
    if (task?.sawStreamText) {
      return;
    }
    for (const block of parsed.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        appendSummary(task, block.text);
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
      appendSummary(task, parsed.result);
    } else if (!task?.sawStreamText) {
      appendSummary(task, parsed.result);
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
    const reserved = /^(?:--(?:help|version|output-format|input-format|print|resume|continue|session-id|fork-session|replay-user-messages|include-partial-messages|verbose)|-[phvrc])(?:=|$)/;
    if (cfg.extraArgs.some(arg => reserved.test(arg) || arg === "--")) {
      throw new Error("extraArgs cannot override the managed Claude execution protocol or session.");
    }
    args.push(...cfg.extraArgs);
  }

  if (CLAUDE_HOOKS_ENABLED) {
    args.push("--settings", CLAUDE_HOOK_SETTINGS);
  }

  if (task.resumingSession) {
    task.usedResume = true;
    args.push("--resume", task.claudeSessionId);
  } else if (task.targetMode === "queue") {
    args.push("--session-id", task.claudeSessionId);
  } else if (agentState.sessionReady) {
    task.usedResume = true;
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
    // Never discard the history of a resumed conversation or replay work that
    // may already have run. Only a fresh session-id collision is safe to retry.
    !task.resumingSession && !task.usedResume && !task.hasExecutionEvidence &&
    !isMissingConversation && isSessionBusy
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
  if (isClaudeSessionFailure(tail) || isPermanentModelFailure(tail) || !MODEL_TRANSIENT_ERROR_PATTERN.test(tail)) {
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
  send({ type: "task.started", taskId, attempt: task?.attempt, pid: process.pid, sessionId: task?.claudeSessionId ?? null, claudeVersion: getClaudeVersion() });
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
    appendSummary(current, chunk);
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
  const child = (deps.spawnClaude ?? spawn)("claude", args, {
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
    detached: process.platform !== "win32",
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
  currentTask.processGroup = !deps.spawnClaude && process.platform !== "win32";
  // A generated UUID / spawned process is not evidence of a saved transcript.
  send({ type: "task.started", taskId, attempt: currentTask.attempt, pid: child.pid ?? 0, sessionId: null, claudeVersion: getClaudeVersion() });
  emitOutput(taskId, "stdout", `[agent] permission_mode: ${permissionMode}\n`);

  const onLine = (line: string) => {
    const active = findActiveTask(taskId);
    if (active !== currentTask || active.generation !== generation || active.cancelRequested) return;
    try {
      const node = JSON.parse(line);
      // init carries an allocated ID even when startup/API access later fails.
      // Streamed execution must retain its session too: a tool may run before
      // the final assistant/result node. If the transcript is lost, fail closed.
      if (node && !active.sessionConfirmed && typeof node.session_id === "string" &&
          (node.type === "stream_event" || node.type === "assistant" || (node.type === "result" && !node.is_error && node.subtype === "success")) &&
          !active.cliConfig?.extraArgs?.includes("--no-session-persistence") &&
          !/^(?:1|true)$/i.test(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY ?? "")) {
        active.sessionConfirmed = true;
        active.claudeSessionId = node.session_id;
        send({ type: "task.started", taskId, attempt: active.attempt, pid: child.pid ?? 0, sessionId: node.session_id });
      }
    } catch { /* Non-JSON stdout is handled by the normal output parser below. */ }
    try { handleClaudeJsonLine(taskId, line, findActiveTask, emitOutput); }
    catch (error) {
      active.protocolError = `Invalid Claude output: ${String(error)}`;
      signalTaskProcess(child, !!active.processGroup, "SIGKILL");
    }
  };
  // Bound an unterminated JSON line before a readline-style buffer can grow.
  let pendingLine = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    if (findActiveTask(taskId) !== currentTask || currentTask.generation !== generation || currentTask.protocolError) return;
    const data = Buffer.concat([pendingLine, Buffer.from(chunk)]);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start);
      const length = (end < 0 ? data.length : end) - start;
      if (length > MAX_CLI_LINE_BYTES) {
        pendingLine = Buffer.alloc(0);
        currentTask.protocolError = "Claude output line exceeded 1 MiB.";
        signalTaskProcess(child, !!currentTask.processGroup, "SIGKILL");
        return;
      }
      if (end < 0) break;
      onLine(data.subarray(start, end).toString("utf8"));
      start = end + 1;
    }
    pendingLine = Buffer.from(data.subarray(start));
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (findActiveTask(taskId) !== currentTask || currentTask.generation !== generation) return;
    emitStderr(taskId, chunk.toString());
  });

  child.on("error", (error) => {
    if (findActiveTask(taskId) !== currentTask || currentTask.generation !== generation) return;
    if (currentTask.cancelRequested) { emitStderr(taskId, error.message); return; }
    finishTask(taskId, "failed", error.message);
  });

  child.on("close", (code) => {
    const task = findActiveTask(taskId);
    if (task !== currentTask || task.generation !== generation) {
      return;
    }
    if (task?.cancelRequested) {
      // cancelTask owns settlement after the entire execution domain is stopped.
      return;
    }
    if (pendingLine.length) { onLine(pendingLine.toString("utf8")); pendingLine = Buffer.alloc(0); }
    if (task.protocolError) { finishTask(taskId, "failed", task.protocolError); return; }
    if (code === 0 && task.cliResultSuccess && !task.cliResultError) {
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
      fresh.cliResultSuccess = false;
      fresh.sawStreamText = false;
      fresh.child = null;
      fresh.sessionConfirmed = false;
      fresh.usedResume = false;
      fresh.hasExecutionEvidence = false;
      if (fresh.targetMode === "queue") {
        fresh.claudeSessionId = randomUUID();
      } else {
        const newState = resetClaudeSession();
        setAgentState(newState);
        fresh.claudeSessionId = newState.claudeSessionId;
      }
      emitOutput(taskId, "stdout", "\n[agent] Claude session is unavailable or already in use. Starting a new session and retrying this task.\n");
      try { runClaudeTask(taskId, prompt, workspace, deps); }
      catch (error) { finishTask(taskId, "failed", String(error)); }
      return;
    }
    if (isClaudeSessionFailure(task.stderrTail)) {
      finishTask(taskId, "failed", `[session_unavailable] Claude 会话无法恢复：${task.stderrTail.slice(-1000)}\n会话 ${task.claudeSessionId}；工作目录 ${resolvedWorkspace}。已停止自动重试，请在原 Agent 检查会话文件；确认已执行操作后，显式重置会话并重新提交剩余工作，不要直接重放原任务。`);
      return;
    }
    const persistenceDisabled = task.cliConfig?.extraArgs?.includes("--no-session-persistence") ||
      /^(?:1|true)$/i.test(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY ?? "");
    if (task.hasExecutionEvidence && !task.sessionConfirmed &&
        (persistenceDisabled || (!task.resumingSession && !task.usedResume))) {
      finishTask(taskId, "failed", `[session_unavailable] 任务已有执行输出，但未确认可恢复会话，已停止自动重放。请核对已执行操作和会话持久化配置，再提交剩余工作。CLI 错误：${task.stderrTail.slice(-1000)}`);
      return;
    }
    finishTask(taskId, "failed", classifyModelTransientFailure(taskId, task.cliResultError ? 1 : code, findActiveTask) ?? `Claude CLI 退出码 ${code ?? "unknown"}，未收到有效成功 result：${task.stderrTail.slice(-1000)}`);
  });
}
