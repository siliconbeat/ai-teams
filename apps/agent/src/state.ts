import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  STATE_FILE,
  LEGACY_STATE_FILE,
  type AgentState,
} from "./config.js";

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
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function resetClaudeSession(): AgentState {
  const state = { claudeSessionId: randomUUID(), sessionReady: false };
  persistState(state);
  return state;
}
