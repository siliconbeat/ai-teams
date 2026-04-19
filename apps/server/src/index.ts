import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import {
  parseEmployeeToServerMessage,
  parseJsonMessage,
  parseLeaderToServerMessage,
  type AgentTarget,
  type EmployeeSnapshot,
  type EmployeeToServerMessage,
  type LeaderToServerMessage,
  type ServerToEmployeeMessage,
  type ServerToLeaderMessage,
  type StateSnapshot,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskStatus,
} from "@ai-teams/shared";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timeout"]);
const DEFAULT_PORT = 3789;

export type AiTeamsServerOptions = {
  authToken: string;
  port?: number;
  host?: string;
  dataDir?: string;
  dbPath?: string;
  defaultTimeoutSec?: number;
  disconnectGraceMs?: number;
  maxLogChunksPerTask?: number;
  logger?: boolean;
};

export type AiTeamsServer = {
  app: FastifyInstance;
  buildSnapshot: () => StateSnapshot;
  close: () => Promise<void>;
};

type ServerState = {
  agentSockets: Map<string, WebSocket>;
  leaderSockets: Set<WebSocket>;
  employees: Map<string, EmployeeSnapshot>;
  tasks: Map<string, TaskRecord>;
  taskLogs: Map<string, TaskOutputChunk[]>;
  socketToEmployeeId: WeakMap<WebSocket, string>;
  taskTimeouts: Map<string, NodeJS.Timeout>;
  disconnectTimers: Map<string, NodeJS.Timeout>;
};

function nowIso() {
  return new Date().toISOString();
}

function sendJson<T>(socket: WebSocket, payload: T) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isAuthorized(authToken: string, rawUrl: string, headers: Record<string, unknown>) {
  const bearer = typeof headers.authorization === "string" ? headers.authorization : "";
  const tokenFromHeader = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : "";
  const tokenFromQuery = new URL(rawUrl, "http://localhost").searchParams.get("token") ?? "";
  return tokenFromHeader === authToken || tokenFromQuery === authToken;
}

export async function createAiTeamsServer(options: AiTeamsServerOptions): Promise<AiTeamsServer> {
  if (!options.authToken) {
    throw new Error("AI_TEAMS_AUTH_TOKEN is required.");
  }

  const defaultTimeoutSec = options.defaultTimeoutSec ?? 1800;
  const disconnectGraceMs = options.disconnectGraceMs ?? 15000;
  const maxLogChunksPerTask = options.maxLogChunksPerTask ?? 400;
  const dataDir = options.dataDir ?? path.join(process.cwd(), "data");
  const dbPath = options.dbPath ?? path.join(dataDir, "ai-teams.db");
  let closing = false;
  const state: ServerState = {
    agentSockets: new Map(),
    leaderSockets: new Set(),
    employees: new Map(),
    tasks: new Map(),
    taskLogs: new Map(),
    socketToEmployeeId: new WeakMap(),
    taskTimeouts: new Map(),
    disconnectTimers: new Map(),
  };

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  initDb(db);
  hydrateState(db, state, defaultTimeoutSec, maxLogChunksPerTask);

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket);

  function buildSnapshot(): StateSnapshot {
    return {
      employees: [...state.employees.values()],
      tasks: [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      logs: Object.fromEntries(state.taskLogs.entries()),
    };
  }

  function broadcastToLeaders(payload: ServerToLeaderMessage) {
    for (const socket of state.leaderSockets) {
      sendJson(socket, payload);
    }
  }

  function upsertEmployee(employee: EmployeeSnapshot) {
    state.employees.set(employee.id, employee);
    persistEmployee(db, employee);
    broadcastToLeaders({ type: "employee.upsert", employee });
  }

  function upsertTask(task: TaskRecord) {
    state.tasks.set(task.id, task);
    persistTask(db, task);
    broadcastToLeaders({ type: "task.upsert", task });
  }

  function clearTaskTimeout(taskId: string) {
    const timer = state.taskTimeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      state.taskTimeouts.delete(taskId);
    }
  }

  function setEmployeeTask(employeeId: string, taskId: string | null, prompt: string | null) {
    const employee = state.employees.get(employeeId);
    if (!employee) {
      return;
    }
    employee.currentTaskId = taskId;
    employee.currentTaskPrompt = prompt;
    employee.lastSeenAt = nowIso();
    upsertEmployee(employee);
  }

  function markTaskFailed(taskId: string, error: string) {
    const task = state.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    clearTaskTimeout(taskId);
    task.status = "failed";
    task.error = error;
    task.summary = task.summary ?? error;
    task.finishedAt = nowIso();
    upsertTask(task);
    setEmployeeTask(task.employeeId, null, null);
  }

  function appendTaskLog(chunk: TaskOutputChunk) {
    const task = state.tasks.get(chunk.taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    history.push(chunk);
    if (history.length > maxLogChunksPerTask) {
      history.splice(0, history.length - maxLogChunksPerTask);
    }
    state.taskLogs.set(chunk.taskId, history);
    persistTaskLog(db, chunk, maxLogChunksPerTask);
    broadcastToLeaders({ type: "task.output", chunk });
  }

  function markTaskTimeout(task: TaskRecord) {
    const current = state.tasks.get(task.id);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return;
    }
    const socket = state.agentSockets.get(task.employeeId);
    if (socket) {
      sendJson<ServerToEmployeeMessage>(socket, { type: "task.cancel", taskId: task.id });
    }
    current.status = "timeout";
    current.finishedAt = nowIso();
    current.error = `任务超过 ${task.timeoutSec} 秒未完成，已超时。`;
    current.summary = current.error;
    upsertTask(current);
    setEmployeeTask(task.employeeId, null, null);
    clearTaskTimeout(task.id);
  }

  function dispatchTask(task: TaskRecord) {
    const employee = state.employees.get(task.employeeId);
    const socket = state.agentSockets.get(task.employeeId);

    if (!employee || employee.status !== "online" || !socket) {
      markTaskFailed(task.id, "目标员工当前离线，任务未能分发。");
      return;
    }

    if (employee.currentTaskId && employee.currentTaskId !== task.id) {
      markTaskFailed(task.id, "目标员工当前忙碌，暂不支持并发任务。");
      return;
    }

    task.status = "dispatched";
    upsertTask(task);
    setEmployeeTask(task.employeeId, task.id, task.prompt);
    clearTaskTimeout(task.id);
    state.taskTimeouts.set(task.id, setTimeout(() => markTaskTimeout(task), task.timeoutSec * 1000));

    sendJson<ServerToEmployeeMessage>(socket, {
      type: "task.dispatch",
      taskId: task.id,
      leaderCommandId: task.leaderCommandId,
      employeeId: task.employeeId,
      prompt: task.prompt,
      workspace: task.workspace,
      timeoutSec: task.timeoutSec,
    });
  }

  function createTask(employeeId: string, prompt: string, workspace?: string, timeoutSec?: number, leaderCommandId?: string) {
    const task: TaskRecord = {
      id: randomUUID(),
      leaderCommandId: leaderCommandId ?? randomUUID(),
      employeeId,
      prompt,
      workspace: workspace?.trim() || null,
      timeoutSec: timeoutSec ?? defaultTimeoutSec,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
    };

    upsertTask(task);
    dispatchTask(task);
    return task;
  }

  function resolveTargetIds(target: AgentTarget) {
    if (target === "all") {
      return [...state.employees.values()].map((employee) => employee.id);
    }
    return [...new Set(target)];
  }

  function handleRegister(message: Extract<EmployeeToServerMessage, { type: "agent.register" }>, socket: WebSocket) {
    const previous = state.employees.get(message.employeeId);
    const previousTaskId = previous?.currentTaskId ?? null;
    const activeTaskId = message.activeTaskId ?? null;

    const disconnectTimer = state.disconnectTimers.get(message.employeeId);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      state.disconnectTimers.delete(message.employeeId);
    }

    state.agentSockets.set(message.employeeId, socket);
    state.socketToEmployeeId.set(socket, message.employeeId);

    let currentTaskId: string | null = previousTaskId;
    let currentTaskPrompt: string | null = previous?.currentTaskPrompt ?? null;
    if (previousTaskId && activeTaskId !== previousTaskId) {
      markTaskFailed(previousTaskId, "员工重连时未恢复原运行任务。");
      currentTaskId = null;
      currentTaskPrompt = null;
    } else if (activeTaskId) {
      const activeTask = state.tasks.get(activeTaskId);
      if (activeTask && activeTask.employeeId === message.employeeId && !TERMINAL_STATUSES.has(activeTask.status)) {
        currentTaskId = activeTask.id;
        currentTaskPrompt = activeTask.prompt;
      }
    }

    upsertEmployee({
      id: message.employeeId,
      name: message.name,
      machineId: message.machineId,
      hostname: message.hostname,
      labels: message.labels,
      status: "online",
      maxConcurrentTasks: message.maxConcurrentTasks,
      currentTaskId,
      currentTaskPrompt,
      lastSeenAt: nowIso(),
    });
  }

  function taskBelongsToSocket(taskId: string, employeeId: string | undefined, socket: WebSocket) {
    const socketEmployeeId = state.socketToEmployeeId.get(socket);
    if (!socketEmployeeId || (employeeId && employeeId !== socketEmployeeId)) {
      return false;
    }
    const task = state.tasks.get(taskId);
    return Boolean(task && task.employeeId === socketEmployeeId);
  }

  function handleAgentMessage(message: EmployeeToServerMessage, socket: WebSocket) {
    if (message.type === "agent.register") {
      handleRegister(message, socket);
      return;
    }

    const socketEmployeeId = state.socketToEmployeeId.get(socket);
    if (!socketEmployeeId) {
      sendJson<ServerToLeaderMessage>(socket as unknown as WebSocket, {
        type: "server.error",
        code: "agent_not_registered",
        message: "Agent must register before sending task events.",
      });
      socket.close(1008, "agent_not_registered");
      return;
    }

    if (message.type === "agent.heartbeat") {
      if (message.employeeId !== socketEmployeeId) {
        socket.close(1008, "employee_mismatch");
        return;
      }
      const employee = state.employees.get(message.employeeId);
      if (employee) {
        employee.lastSeenAt = nowIso();
        employee.status = "online";
        upsertEmployee(employee);
      }
      return;
    }

    if (!taskBelongsToSocket(message.taskId, socketEmployeeId, socket)) {
      socket.close(1008, "task_owner_mismatch");
      return;
    }

    const task = state.tasks.get(message.taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }

    switch (message.type) {
      case "task.accepted":
        task.status = "accepted";
        upsertTask(task);
        break;
      case "task.started":
        task.status = "running";
        task.startedAt = task.startedAt ?? nowIso();
        upsertTask(task);
        break;
      case "task.output":
        appendTaskLog({
          taskId: message.taskId,
          employeeId: task.employeeId,
          stream: message.stream,
          seq: message.seq,
          content: message.content,
          createdAt: nowIso(),
        });
        break;
      case "task.completed":
        task.status = "completed";
        clearTaskTimeout(task.id);
        task.finishedAt = nowIso();
        task.exitCode = message.exitCode;
        task.summary = message.summary ?? "任务执行完成。";
        task.error = null;
        upsertTask(task);
        setEmployeeTask(task.employeeId, null, null);
        break;
      case "task.failed":
        markTaskFailed(message.taskId, message.error);
        break;
      case "task.cancelled":
        task.status = "cancelled";
        clearTaskTimeout(task.id);
        task.finishedAt = nowIso();
        task.summary = "任务已取消。";
        upsertTask(task);
        setEmployeeTask(task.employeeId, null, null);
        break;
    }
  }

  function handleLeaderMessage(message: LeaderToServerMessage, socket: WebSocket) {
    switch (message.type) {
      case "command.dispatch": {
        const targetIds = resolveTargetIds(message.atAgents);
        if (targetIds.length === 0) {
          sendJson<ServerToLeaderMessage>(socket, {
            type: "command.error",
            code: "no_target_agents",
            message: "没有可用的目标员工。",
          });
          return;
        }
        const leaderCommandId = randomUUID();
        for (const employeeId of targetIds) {
          createTask(employeeId, message.prompt, message.workspace, message.timeoutSec, leaderCommandId);
        }
        break;
      }
      case "command.send":
        createTask(message.employeeId, message.prompt, message.workspace, message.timeoutSec);
        break;
      case "command.broadcast":
        handleLeaderMessage(
          {
            type: "command.dispatch",
            atAgents: "all",
            prompt: message.prompt,
            workspace: message.workspace,
            timeoutSec: message.timeoutSec,
          },
          socket,
        );
        break;
      case "task.cancel": {
        const task = state.tasks.get(message.taskId);
        if (!task || TERMINAL_STATUSES.has(task.status)) {
          return;
        }
        const agentSocket = state.agentSockets.get(task.employeeId);
        if (!agentSocket) {
          markTaskFailed(task.id, "员工已离线，无法取消运行中的进程。");
          return;
        }
        sendJson<ServerToEmployeeMessage>(agentSocket, { type: "task.cancel", taskId: task.id });
        break;
      }
    }
  }

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/ws/")) {
      return;
    }
    if (!isAuthorized(options.authToken, request.url, request.headers)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    timestamp: nowIso(),
    dbPath,
    employees: state.employees.size,
    leaders: state.leaderSockets.size,
    tasks: state.tasks.size,
  }));

  app.get("/api/snapshot", async () => buildSnapshot());

  app.get("/ws/agent", { websocket: true }, (socket, request) => {
    if (!isAuthorized(options.authToken, request.url, request.headers)) {
      socket.close(1008, "unauthorized");
      return;
    }
    app.log.info("Agent connected");

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const message = parseEmployeeToServerMessage(parseJsonMessage(raw.toString()));
        handleAgentMessage(message, socket);
      } catch (error) {
        app.log.error({ error }, "Failed to parse agent message");
        socket.close(1008, "invalid_message");
      }
    });

    socket.on("close", () => {
      if (closing) {
        return;
      }
      const employeeId = state.socketToEmployeeId.get(socket);
      if (!employeeId || state.agentSockets.get(employeeId) !== socket) {
        return;
      }
      state.agentSockets.delete(employeeId);
      const employee = state.employees.get(employeeId);
      if (employee) {
        employee.status = "offline";
        employee.lastSeenAt = nowIso();
        upsertEmployee(employee);
        if (employee.currentTaskId) {
          const timer = setTimeout(() => {
            const current = state.employees.get(employeeId);
            if (current?.currentTaskId) {
              markTaskFailed(current.currentTaskId, "员工连接中断且未在宽限期内恢复。");
            }
            state.disconnectTimers.delete(employeeId);
          }, disconnectGraceMs);
          state.disconnectTimers.set(employeeId, timer);
        }
      }
      app.log.info({ employeeId }, "Agent disconnected");
    });
  });

  app.get("/ws/leader", { websocket: true }, (socket, request) => {
    if (!isAuthorized(options.authToken, request.url, request.headers)) {
      socket.close(1008, "unauthorized");
      return;
    }
    state.leaderSockets.add(socket);
    sendJson<ServerToLeaderMessage>(socket, { type: "snapshot", snapshot: buildSnapshot() });
    app.log.info("Leader connected");

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const message = parseLeaderToServerMessage(parseJsonMessage(raw.toString()));
        handleLeaderMessage(message, socket);
      } catch (error) {
        app.log.error({ error }, "Failed to parse leader message");
        sendJson<ServerToLeaderMessage>(socket, {
          type: "command.error",
          code: "invalid_message",
          message: error instanceof Error ? error.message : "Invalid leader message.",
        });
      }
    });

    socket.on("close", () => {
      state.leaderSockets.delete(socket);
      app.log.info("Leader disconnected");
    });
  });

  return {
    app,
    buildSnapshot,
    close: async () => {
      closing = true;
      for (const timer of state.taskTimeouts.values()) {
        clearTimeout(timer);
      }
      for (const timer of state.disconnectTimers.values()) {
        clearTimeout(timer);
      }
      await app.close();
      db.close();
    },
  };
}

function initDb(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (key, value)
    VALUES ('version', '1')
    ON CONFLICT(key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    );
  `);
}

function hydrateState(db: DatabaseSync, state: ServerState, defaultTimeoutSec: number, maxLogChunksPerTask: number) {
  const employeeRows = db.prepare("SELECT payload_json FROM employees").all() as Array<{ payload_json: string }>;
  for (const row of employeeRows) {
    const employee = JSON.parse(row.payload_json) as EmployeeSnapshot;
    employee.status = "offline";
    state.employees.set(employee.id, employee);
  }

  const taskRows = db.prepare("SELECT payload_json FROM tasks").all() as Array<{ payload_json: string }>;
  for (const row of taskRows) {
    const task = JSON.parse(row.payload_json) as TaskRecord;
    task.timeoutSec = task.timeoutSec ?? defaultTimeoutSec;
    state.tasks.set(task.id, task);
  }

  const logRows = db
    .prepare(
      `
        SELECT payload_json FROM (
          SELECT task_id, seq, payload_json,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY seq DESC) AS rn
          FROM task_logs
        )
        WHERE rn <= ?
        ORDER BY task_id ASC, seq ASC
      `,
    )
    .all(maxLogChunksPerTask) as Array<{ payload_json: string }>;
  for (const row of logRows) {
    const chunk = JSON.parse(row.payload_json) as TaskOutputChunk;
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    history.push(chunk);
    state.taskLogs.set(chunk.taskId, history);
  }
}

function persistEmployee(db: DatabaseSync, employee: EmployeeSnapshot) {
  db.prepare(`
    INSERT INTO employees (id, payload_json)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
  `).run(employee.id, JSON.stringify(employee));
}

function persistTask(db: DatabaseSync, task: TaskRecord) {
  db.prepare(`
    INSERT INTO tasks (id, payload_json)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
  `).run(task.id, JSON.stringify(task));
}

function persistTaskLog(db: DatabaseSync, chunk: TaskOutputChunk, maxLogChunksPerTask: number) {
  db.prepare(`
    INSERT INTO task_logs (task_id, seq, payload_json)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id, seq) DO UPDATE SET payload_json = excluded.payload_json
  `).run(chunk.taskId, chunk.seq, JSON.stringify(chunk));
  db.prepare(`
    DELETE FROM task_logs
    WHERE task_id = ?
      AND seq NOT IN (
        SELECT seq FROM task_logs
        WHERE task_id = ?
        ORDER BY seq DESC
        LIMIT ?
      )
  `).run(chunk.taskId, chunk.taskId, maxLogChunksPerTask);
}

export function readOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AiTeamsServerOptions {
  return {
    authToken: env.AI_TEAMS_AUTH_TOKEN ?? "",
    port: Number(env.PORT ?? env.AI_TEAMS_SERVER_PORT) || DEFAULT_PORT,
    host: env.HOST || "0.0.0.0",
    dataDir: env.DATA_DIR,
    dbPath: env.DB_PATH,
    defaultTimeoutSec: Number(env.DEFAULT_TIMEOUT_SEC) || 1800,
    disconnectGraceMs: Number(env.DISCONNECT_GRACE_MS) || 15000,
    maxLogChunksPerTask: Number(env.MAX_LOG_CHUNKS_PER_TASK) || 400,
  };
}

export async function startServer(options = readOptionsFromEnv()) {
  const server = await createAiTeamsServer(options);
  await server.app.listen({ port: options.port ?? DEFAULT_PORT, host: options.host ?? "0.0.0.0" });
  return server;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
