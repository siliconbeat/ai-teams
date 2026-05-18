import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { TaskTargetMode, TaskCliConfig } from "@ai-teams/shared";
import { loadConfigFile, type AgentConfig } from "./setup.js";

const fileConfig: AgentConfig | null = loadConfigFile();

export const SERVER_PORT = process.env.AI_TEAMS_SERVER_PORT || "3789";
export const SERVER_URL = process.env.SERVER_URL || fileConfig?.serverUrl || `ws://localhost:${SERVER_PORT}`;
export const AUTH_TOKEN = process.env.AI_TEAMS_AUTH_TOKEN || fileConfig?.authToken || "";
export const EMPLOYEE_ID = process.env.EMPLOYEE_ID || fileConfig?.employeeId || "emp_local";
export const EMPLOYEE_NAME = process.env.EMPLOYEE_NAME || fileConfig?.employeeName || "Local Agent";
export const EMPLOYEE_LABELS = process.env.EMPLOYEE_LABELS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
export const RECONNECT_MS = Number(process.env.RECONNECT_MS) || 5000;
export const RUNNER_MODE = process.env.RUNNER_MODE || fileConfig?.runnerMode || "claude";
export const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || fileConfig?.workspace || process.cwd();
export const MAX_BUFFERED_MESSAGES = Number(process.env.AGENT_BUFFER_LIMIT) || 400;
export const MAX_ERROR_TAIL = 16000;
export const CLAUDE_MISSING_CONVERSATION_PATTERN = /No conversation found with session ID|Session ID .+ is already in use/i;
export const AGENT_RECORDS_DIR =
  process.env.AGENT_RECORDS_DIR || path.join(DEFAULT_WORKSPACE, ".ai-teams", "agents", EMPLOYEE_ID);
export const STATE_FILE = process.env.AGENT_STATE_FILE || path.join(AGENT_RECORDS_DIR, "session-state.json");
export const LEGACY_STATE_FILE = path.join(process.cwd(), `.agent-state.${EMPLOYEE_ID}.json`);
export const DAILY_RECORDS_DIR = path.join(AGENT_RECORDS_DIR, "daily");
export const HOOKS_DIR = path.join(AGENT_RECORDS_DIR, "hooks");
export const CLAUDE_HOOK_SCRIPT = path.join(HOOKS_DIR, "claude-session-recorder.cjs");
export const CLAUDE_HOOK_SETTINGS = path.join(HOOKS_DIR, "claude-hooks.settings.json");
export const CLAUDE_HOOKS_ENABLED = process.env.CLAUDE_HOOKS_ENABLED !== "false";
export const WORKSPACE_CLAUDE_MD = path.join(DEFAULT_WORKSPACE, "CLAUDE.md");
export const CLAUDE_MD_SECTION_START = "<!-- AI_TEAMS_AGENT_RULES_START -->";
export const CLAUDE_MD_SECTION_END = "<!-- AI_TEAMS_AGENT_RULES_END -->";

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
  stderrTail: string;
  retriedWithFreshSession: boolean;
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
