import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  STATE_FILE,
  LEGACY_STATE_FILE,
  type AgentState,
} from "./config.js";

export let stateStorageHealthy = true;

export function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or failed before create */ }
  }
}

export function loadState(): AgentState {
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

export function persistState(state: AgentState) {
  try {
    atomicWriteJson(STATE_FILE, state);
    stateStorageHealthy = true;
    return true;
  } catch (error) {
    stateStorageHealthy = false;
    console.error(`[agent] Session state persistence failed; new tasks paused: ${String(error)}`);
    return false;
  }
}

export function resetClaudeSession(): AgentState {
  const state = { claudeSessionId: randomUUID(), sessionReady: false };
  if (!persistState(state)) throw new Error("Cannot safely persist a new Claude session.");
  return state;
}
