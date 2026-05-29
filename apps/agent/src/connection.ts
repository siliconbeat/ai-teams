import { execSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import {
  isEncryptedEnvelope,
  parseEncryptionKey,
  parseJsonMessage,
  parseServerToEmployeeMessage,
  type EmployeeToServerMessage,
  type ServerToEmployeeMessage,
} from "@ai-teams/shared";
import {
  AUTH_TOKEN,
  AGENT_TOKEN,
  EMPLOYEE_ID,
  EMPLOYEE_NAME,
  EMPLOYEE_LABELS,
  EMPLOYEE_WEIGHT,
  CLAUDE_PERMISSION_MODE,
  RECONNECT_MS,
  SERVER_URL,
  MAX_BUFFERED_MESSAGES,
  type ActiveTask,
} from "./config.js";

declare const PKG_VERSION: string;
const version: string = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "dev";

let cachedClaudeVersion: string | undefined;
function getClaudeVersion(): string | undefined {
  if (cachedClaudeVersion !== undefined) return cachedClaudeVersion || undefined;
  try {
    const raw = execSync("claude --version 2>/dev/null", { timeout: 5000, encoding: "utf8" }).trim();
    cachedClaudeVersion = raw.split(/\s/)[0] || raw;
  } catch {
    cachedClaudeVersion = "";
  }
  return cachedClaudeVersion || undefined;
}

// ---------------------------------------------------------------------------
// Encryption helper
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const encryptionKeyHex = process.env.AI_TEAMS_ENCRYPTION_KEY;
const encryptionKey = encryptionKeyHex ? parseEncryptionKey(encryptionKeyHex) : null;

function encrypt(plainText: string): string {
  if (!encryptionKey) return plainText;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    encrypted: true,
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  });
}

function decrypt(raw: string): string {
  if (!encryptionKey) return raw;
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedEnvelope(parsed)) return raw;
  const iv = Buffer.from(parsed.iv, "base64");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

export type ConnectionState = {
  socket: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  bufferedMessages: EmployeeToServerMessage[];
};

export function buildAgentWsUrl() {
  const url = new URL("/ws/agent", SERVER_URL);
  url.searchParams.set("token", AUTH_TOKEN);
  if (AGENT_TOKEN) {
    url.searchParams.set("agentToken", AGENT_TOKEN);
  }
  return url.toString();
}

function isTaskMessage(payload: EmployeeToServerMessage) {
  return payload.type.startsWith("task.");
}

export function send(state: ConnectionState, payload: EmployeeToServerMessage) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(encrypt(JSON.stringify(payload)));
    return;
  }
  if (isTaskMessage(payload)) {
    state.bufferedMessages.push(payload);
    if (state.bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
      state.bufferedMessages = state.bufferedMessages.slice(-MAX_BUFFERED_MESSAGES);
    }
  }
}

export function flushBufferedMessages(state: ConnectionState) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.bufferedMessages.length === 0) {
    return;
  }
  const messages = state.bufferedMessages;
  state.bufferedMessages = [];
  for (const message of messages) {
    state.socket.send(encrypt(JSON.stringify(message)));
  }
}

export function startHeartbeat(state: ConnectionState) {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
  }
  state.heartbeatTimer = setInterval(() => {
    send(state, { type: "agent.heartbeat", employeeId: EMPLOYEE_ID });
  }, 10000);
}

export function scheduleReconnect(state: ConnectionState, connectFn: () => void) {
  if (state.reconnectTimer) {
    return;
  }
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectFn();
  }, RECONNECT_MS);
}

export function registerAgent(
  state: ConnectionState,
  mainTask: ActiveTask | null,
  queueTask: ActiveTask | null,
) {
  send(state, {
    type: "agent.register",
    employeeId: EMPLOYEE_ID,
    name: EMPLOYEE_NAME,
    machineId: EMPLOYEE_ID,
    hostname: os.hostname(),
    labels: EMPLOYEE_LABELS,
    version: version,
    claudeVersion: getClaudeVersion(),
    permissionMode: CLAUDE_PERMISSION_MODE,
    activeMainTaskId: mainTask?.taskId ?? null,
    activeQueueTaskId: queueTask?.taskId ?? null,
    lastOutputSeq: Math.max(mainTask?.seq ?? 0, queueTask?.seq ?? 0),
    weight: EMPLOYEE_WEIGHT,
  });
}

export function requestTask(state: ConnectionState) {
  send(state, { type: "agent.request_task", employeeId: EMPLOYEE_ID });
}

export function connect(
  state: ConnectionState,
  getMainTask: () => ActiveTask | null,
  getQueueTask: () => ActiveTask | null,
  onMessage: (message: ServerToEmployeeMessage) => void,
) {
  if (!AUTH_TOKEN) {
    console.error("[agent] AI_TEAMS_AUTH_TOKEN is required.");
    process.exit(1);
  }

  state.socket = new WebSocket(buildAgentWsUrl());

  state.socket.on("open", () => {
    console.log(`[agent:${EMPLOYEE_ID}] connected to ${SERVER_URL}`);
    registerAgent(state, getMainTask(), getQueueTask());
    flushBufferedMessages(state);
    requestTask(state);
    startHeartbeat(state);
  });

  state.socket.on("message", (raw: Buffer) => {
    try {
      const decrypted = decrypt(raw.toString());
      const message = parseServerToEmployeeMessage(parseJsonMessage(decrypted));
      onMessage(message);
    } catch (error) {
      console.error(`[agent:${EMPLOYEE_ID}] invalid server message`, error);
    }
  });

  state.socket.on("close", (code, reason) => {
    if (code === 1008) {
      console.error(`[agent:${EMPLOYEE_ID}] 认证失败：Token 无效或服务器拒绝连接。${reason ? ` (${reason})` : ""}`);
      console.error(`[agent:${EMPLOYEE_ID}] 请检查 AI_TEAMS_AUTH_TOKEN 配置后重新启动。`);
      process.exit(1);
    }
    console.log(`[agent:${EMPLOYEE_ID}] disconnected, reconnecting in ${RECONNECT_MS}ms...`);
    scheduleReconnect(state, () => connect(state, getMainTask, getQueueTask, onMessage));
  });

  state.socket.on("error", (error) => {
    console.error(`[agent:${EMPLOYEE_ID}] websocket error`, (error as Error).message);
  });
}
