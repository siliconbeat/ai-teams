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
import { getClaudeVersion } from "./claude-version.js";

declare const PKG_VERSION: string;
const version: string = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "dev";

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
      // Preserve completion/failure acknowledgements over lossy output history.
      const output = state.bufferedMessages.findIndex(m => m.type === "task.output");
      state.bufferedMessages.splice(output >= 0 ? output : 0, 1);
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

let reconnectAttempt = 0;
const RECONNECT_MAX_MS = 60000;

export function scheduleReconnect(state: ConnectionState, connectFn: () => void) {
  if (state.reconnectTimer) {
    return;
  }
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX_MS);
  const jitter = delay * (0.5 + Math.random() * 0.5);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectFn();
  }, jitter);
}

export function resetReconnectAttempt() {
  reconnectAttempt = 0;
}

export function registerAgent(
  state: ConnectionState,
  mainTask: ActiveTask | null,
  queueTask: ActiveTask | null,
) {
  send(state, {
    type: "agent.register",
    employeeId: EMPLOYEE_ID,
    agentToken: AGENT_TOKEN,
    name: EMPLOYEE_NAME,
    machineId: EMPLOYEE_ID,
    hostname: os.hostname(),
    labels: EMPLOYEE_LABELS,
    version: version,
    claudeVersion: getClaudeVersion(),
    permissionMode: CLAUDE_PERMISSION_MODE,
    activeMainTaskId: mainTask?.taskId ?? null,
    activeQueueTaskId: queueTask?.taskId ?? null,
    pendingTaskIds: state.bufferedMessages.flatMap(m => m.type === "task.completed" || m.type === "task.failed" || m.type === "task.cancelled" ? [m.taskId] : []),
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
  if (!AGENT_TOKEN) {
    console.error("[agent] AI_TEAMS_AGENT_TOKEN is required. 请先在 Web 端添加 Agent 并复制 Agent Token。");
    process.exit(1);
  }

  state.socket = new WebSocket(buildAgentWsUrl());

  state.socket.on("open", () => {
    console.log(`[agent:${EMPLOYEE_ID}] connected to ${SERVER_URL}`);
    registerAgent(state, getMainTask(), getQueueTask());
  });

  state.socket.on("message", (raw: Buffer) => {
    try {
      const decrypted = decrypt(raw.toString());
      const message = parseServerToEmployeeMessage(parseJsonMessage(decrypted));
      if (message.type === "agent.registered") {
        resetReconnectAttempt();
        flushBufferedMessages(state);
        requestTask(state);
        startHeartbeat(state);
      }
      onMessage(message);
    } catch (error) {
      console.error(`[agent:${EMPLOYEE_ID}] invalid server message`, error);
    }
  });

  state.socket.on("close", (code, reason) => {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    if (code === 1008) {
      console.error(`[agent:${EMPLOYEE_ID}] 认证失败：Token 无效或服务器拒绝连接。${reason ? ` (${reason})` : ""}`);
      console.error(`[agent:${EMPLOYEE_ID}] 请检查 Agent Token 与员工 ID 是否和 Web 端注册记录一致。`);
      process.exit(1);
    }
    console.log(`[agent:${EMPLOYEE_ID}] disconnected, reconnecting in ${RECONNECT_MS}ms...`);
    scheduleReconnect(state, () => connect(state, getMainTask, getQueueTask, onMessage));
  });

  state.socket.on("error", (error) => {
    console.error(`[agent:${EMPLOYEE_ID}] websocket error`, (error as Error).message);
  });
}
