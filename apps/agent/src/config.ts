import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { TaskTargetMode, TaskCliConfig } from "@ai-teams/shared";
import { loadConfigFile, type AgentConfig } from "./setup.js";

export let fileConfig: AgentConfig | null = loadConfigFile();

export let SERVER_PORT = process.env.AI_TEAMS_SERVER_PORT || "3789";
export let SERVER_URL = process.env.SERVER_URL || fileConfig?.serverUrl || `ws://localhost:${SERVER_PORT}`;
export let AUTH_TOKEN = process.env.AI_TEAMS_AUTH_TOKEN || fileConfig?.authToken || "";
export let EMPLOYEE_ID = process.env.EMPLOYEE_ID || fileConfig?.employeeId || "emp_local";
export let EMPLOYEE_NAME = process.env.EMPLOYEE_NAME || fileConfig?.employeeName || "Local Agent";
export let EMPLOYEE_LABELS = process.env.EMPLOYEE_LABELS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
const _rawWeight = Number(process.env.EMPLOYEE_WEIGHT || fileConfig?.weight);
export let EMPLOYEE_WEIGHT = Math.max(1, _rawWeight || 1);
if ((process.env.EMPLOYEE_WEIGHT || fileConfig?.weight) && (!_rawWeight || _rawWeight < 1)) {
  console.warn(`[agent] 无效的 EMPLOYEE_WEIGHT="${process.env.EMPLOYEE_WEIGHT || fileConfig?.weight}"，已重置为 1`);
}
export let RECONNECT_MS = Number(process.env.RECONNECT_MS) || 5000;
export let RUNNER_MODE = process.env.RUNNER_MODE || fileConfig?.runnerMode || "claude";
export let DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || fileConfig?.workspace || process.cwd();
export let MAX_BUFFERED_MESSAGES = Number(process.env.AGENT_BUFFER_LIMIT) || 400;
export const MAX_ERROR_TAIL = 16000;
export const CLAUDE_MISSING_CONVERSATION_PATTERN = /No conversation found with session ID|Session ID .+ is already in use/i;
export let AGENT_RECORDS_DIR =
  process.env.AGENT_RECORDS_DIR || path.join(DEFAULT_WORKSPACE, ".ai-teams", "agents", EMPLOYEE_ID);
export let STATE_FILE = process.env.AGENT_STATE_FILE || path.join(AGENT_RECORDS_DIR, "session-state.json");
export let LEGACY_STATE_FILE = path.join(process.cwd(), `.agent-state.${EMPLOYEE_ID}.json`);
export let DAILY_RECORDS_DIR = path.join(AGENT_RECORDS_DIR, "daily");
export let HOOKS_DIR = path.join(AGENT_RECORDS_DIR, "hooks");
export let CLAUDE_HOOK_SCRIPT = path.join(HOOKS_DIR, "claude-session-recorder.cjs");
export let CLAUDE_HOOK_SETTINGS = path.join(HOOKS_DIR, "claude-hooks.settings.json");
export let CLAUDE_HOOKS_ENABLED = process.env.CLAUDE_HOOKS_ENABLED !== "false";
export let WORKSPACE_CLAUDE_MD = path.join(DEFAULT_WORKSPACE, "CLAUDE.md");
export const CLAUDE_MD_SECTION_START = "<!-- AI_TEAMS_AGENT_RULES_START -->";
export const CLAUDE_MD_SECTION_END = "<!-- AI_TEAMS_AGENT_RULES_END -->";

export function reinitializeConfig(): void {
  fileConfig = loadConfigFile();
  SERVER_PORT = process.env.AI_TEAMS_SERVER_PORT || "3789";
  SERVER_URL = process.env.SERVER_URL || fileConfig?.serverUrl || `ws://localhost:${SERVER_PORT}`;
  AUTH_TOKEN = process.env.AI_TEAMS_AUTH_TOKEN || fileConfig?.authToken || "";
  EMPLOYEE_ID = process.env.EMPLOYEE_ID || fileConfig?.employeeId || "emp_local";
  EMPLOYEE_NAME = process.env.EMPLOYEE_NAME || fileConfig?.employeeName || "Local Agent";
  EMPLOYEE_LABELS = process.env.EMPLOYEE_LABELS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  const _rw = Number(process.env.EMPLOYEE_WEIGHT);
  EMPLOYEE_WEIGHT = Math.max(1, _rw || 1);
  RECONNECT_MS = Number(process.env.RECONNECT_MS) || 5000;
  RUNNER_MODE = process.env.RUNNER_MODE || fileConfig?.runnerMode || "claude";
  DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || fileConfig?.workspace || process.cwd();
  MAX_BUFFERED_MESSAGES = Number(process.env.AGENT_BUFFER_LIMIT) || 400;
  AGENT_RECORDS_DIR =
    process.env.AGENT_RECORDS_DIR || path.join(DEFAULT_WORKSPACE, ".ai-teams", "agents", EMPLOYEE_ID);
  STATE_FILE = process.env.AGENT_STATE_FILE || path.join(AGENT_RECORDS_DIR, "session-state.json");
  LEGACY_STATE_FILE = path.join(process.cwd(), `.agent-state.${EMPLOYEE_ID}.json`);
  DAILY_RECORDS_DIR = path.join(AGENT_RECORDS_DIR, "daily");
  HOOKS_DIR = path.join(AGENT_RECORDS_DIR, "hooks");
  CLAUDE_HOOK_SCRIPT = path.join(HOOKS_DIR, "claude-session-recorder.cjs");
  CLAUDE_HOOK_SETTINGS = path.join(HOOKS_DIR, "claude-hooks.settings.json");
  CLAUDE_HOOKS_ENABLED = process.env.CLAUDE_HOOKS_ENABLED !== "false";
  WORKSPACE_CLAUDE_MD = path.join(DEFAULT_WORKSPACE, "CLAUDE.md");
}

export type AgentState = {
  claudeSessionId: string;
  sessionReady: boolean;
};

export type ActiveTask = {
  taskId: string;
  seq: number;
  child: ChildProcess | null;
  summary: string[];
  cancelRequested: boolean;
  sawStreamText: boolean;
  lastToolBlock: boolean;
  stderrTail: string;
  retriedWithFreshSession: boolean;
  resumingSession: boolean;
  generation: number;
  targetMode: TaskTargetMode;
  claudeSessionId: string;
  cliConfig: TaskCliConfig | null;
  resultMetrics: {
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    totalCostUsd?: number;
    usageInputTokens?: number;
    usageOutputTokens?: number;
    usageCacheReadTokens?: number;
    usageCacheCreationTokens?: number;
  };
};
