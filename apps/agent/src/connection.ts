import os from "node:os";
import WebSocket from "ws";
import {
  parseJsonMessage,
  parseServerToEmployeeMessage,
  type EmployeeToServerMessage,
  type ServerToEmployeeMessage,
} from "@ai-teams/shared";
import {
  AUTH_TOKEN,
  EMPLOYEE_ID,
  EMPLOYEE_NAME,
  EMPLOYEE_LABELS,
  RECONNECT_MS,
  SERVER_URL,
  MAX_BUFFERED_MESSAGES,
  type ActiveTask,
} from "./config.js";

export type ConnectionState = {
  socket: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  bufferedMessages: EmployeeToServerMessage[];
};

export function buildAgentWsUrl() {
  const url = new URL("/ws/agent", SERVER_URL);
  url.searchParams.set("token", AUTH_TOKEN);
  return url.toString();
}

function isTaskMessage(payload: EmployeeToServerMessage) {
  return payload.type.startsWith("task.");
}

export function send(state: ConnectionState, payload: EmployeeToServerMessage) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
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
    state.socket.send(JSON.stringify(message));
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
    activeMainTaskId: mainTask?.taskId ?? null,
    activeQueueTaskId: queueTask?.taskId ?? null,
    lastOutputSeq: Math.max(mainTask?.seq ?? 0, queueTask?.seq ?? 0),
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
      const message = parseServerToEmployeeMessage(parseJsonMessage(raw.toString()));
      onMessage(message);
    } catch (error) {
      console.error(`[agent:${EMPLOYEE_ID}] invalid server message`, error);
    }
  });

  state.socket.on("close", () => {
    console.log(`[agent:${EMPLOYEE_ID}] disconnected, reconnecting in ${RECONNECT_MS}ms...`);
    scheduleReconnect(state, () => connect(state, getMainTask, getQueueTask, onMessage));
  });

  state.socket.on("error", (error) => {
    console.error(`[agent:${EMPLOYEE_ID}] websocket error`, (error as Error).message);
  });
}
