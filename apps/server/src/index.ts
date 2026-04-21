import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import {
  parseEmployeeToServerMessage,
  parseJsonMessage,
  parseLeaderToServerMessage,
  type LeaderToServerMessage,
  type ServerToLeaderMessage,
  type StateSnapshot,
} from "@ai-teams/shared";
import { type ServerState, createDatabaseFromEnv, initDb, hydrateState, type Database, queryTasks, getTaskById, deleteTask, updateTaskFields, dbRowToTask } from "./db.js";
import { type RestTaskRequest, errorResponseSchema, snapshotSchema, sessionHistorySchema, restTaskRequestSchema, restTaskAcceptedSchema, taskListResponseSchema, taskRecordSchema, taskPatchSchema, parseRestTaskRequest } from "./schemas.js";
import { createDispatch, nowIso, sendJson } from "./dispatch.js";
import type { DispatchContext } from "./dispatch.js";

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
    taskWebhooks: new Map(),
    socketToEmployeeId: new WeakMap(),
    taskTimeouts: new Map(),
    disconnectTimers: new Map(),
    taskQueues: new Map(),
    mainTaskQueues: new Map(),
    sharedTaskQueue: [],
    sharedQueueCursor: 0,
  };

  const db = await createDatabaseFromEnv({
    AI_TEAMS_AUTH_TOKEN: options.authToken,
    DATA_DIR: options.dataDir,
    DB_PATH: options.dbPath,
    DATABASE_URL: process.env.DATABASE_URL,
  });
  await initDb(db);
  await hydrateState(db, state, defaultTimeoutSec, maxLogChunksPerTask);

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AI Teams Server API",
        description: "REST API for submitting AI Teams tasks and reading runtime state.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
    staticCSP: true,
  });

  const dispatchCtx: DispatchContext = {
    state,
    db,
    log: app.log,
    authToken: options.authToken,
    defaultTimeoutSec,
    maxLogChunksPerTask,
    disconnectGraceMs,
  };
  const { dispatchLeaderCommand, handleAgentMessage, handleLeaderMessage } = createDispatch(dispatchCtx);

  function buildSnapshot(): StateSnapshot {
    return {
      employees: [...state.employees.values()],
      tasks: [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      logs: Object.fromEntries(state.taskLogs.entries()),
    };
  }

  function buildSessionHistory(sessionId: string) {
    const extractDoneSessionId = (content: string) => {
      const match = content.match(/^\[done\]\s+session_id:\s*(\S+)/m);
      return match?.[1] ?? null;
    };
    const tasks = [...state.tasks.values()]
      .filter((task) => task.sessionId === sessionId || (state.taskLogs.get(task.id) ?? []).some((chunk) => extractDoneSessionId(chunk.content) === sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const messages = tasks.flatMap((task) => {
      const taskLogs = [...(state.taskLogs.get(task.id) ?? [])].sort((a, b) => a.seq - b.seq);
      const outputMessages = taskLogs.map((chunk) => ({
        type: "task.output" as const,
        role: "assistant" as const,
        taskId: task.id,
        stream: chunk.stream,
        seq: chunk.seq,
        content: chunk.content,
        createdAt: chunk.createdAt,
      }));
      const resultMessage =
        task.finishedAt && (task.summary || task.error)
          ? [
              {
                type: "task.result" as const,
                role: task.status === "failed" || task.status === "timeout" ? ("system" as const) : ("assistant" as const),
                taskId: task.id,
                content: task.summary || task.error || task.status,
                createdAt: task.finishedAt,
              },
            ]
          : [];
      return [
        {
          type: "task.prompt" as const,
          role: "user" as const,
          taskId: task.id,
          content: task.prompt,
          createdAt: task.createdAt,
        },
        ...outputMessages,
        ...resultMessage,
      ];
    });
    return { sessionId, tasks, messages };
  }

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/ws/") || request.url.startsWith("/docs")) {
      return;
    }
    if (!isAuthorized(options.authToken, request.url, request.headers)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        summary: "Check server health",
        response: {
          200: {
            type: "object",
            required: ["status", "timestamp", "dbPath", "employees", "leaders", "tasks"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              timestamp: { type: "string", format: "date-time" },
              dbPath: { type: "string" },
              employees: { type: "number" },
              leaders: { type: "number" },
              tasks: { type: "number" },
            },
          },
          401: errorResponseSchema,
        },
      },
    },
    async () => ({
      status: "ok",
      timestamp: nowIso(),
      dbPath,
      employees: state.employees.size,
      leaders: state.leaderSockets.size,
      tasks: state.tasks.size,
    }),
  );

  app.get(
    "/api/snapshot",
    {
      schema: {
        tags: ["tasks"],
        summary: "Get current employees, tasks, and task logs",
        response: {
          200: snapshotSchema,
          401: errorResponseSchema,
        },
      },
    },
    async () => buildSnapshot(),
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/history",
    {
      schema: {
        tags: ["sessions"],
        summary: "Get conversation history by session ID",
        description:
          "Returns task prompts, task output chunks, and terminal summaries/errors for the specified AI Teams Claude session ID.",
        params: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: sessionHistorySchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => buildSessionHistory(request.params.sessionId),
  );

  app.post<{ Body: RestTaskRequest }>(
    "/api/tasks",
    {
      schema: {
        tags: ["tasks"],
        summary: "Submit a task",
        description:
          "Submit a task to the shared queue, all agents, or one or more selected agents. Optional webhook receives task lifecycle callbacks.",
        body: restTaskRequestSchema,
        response: {
          202: restTaskAcceptedSchema,
          400: {
            type: "object",
            required: ["status", "code", "message"],
            properties: {
              status: { type: "string", enum: ["rejected"] },
              code: { type: "string" },
              message: { type: "string" },
            },
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { command, webhookUrl, cliConfig } = parseRestTaskRequest(request.body);
        const result = dispatchLeaderCommand(command, webhookUrl, cliConfig);
        if (!result.ok) {
          return reply.code(400).send({
            status: "rejected",
            code: result.code,
            message: result.message,
          });
        }
        return reply.code(202).send({
          status: "accepted",
          leaderCommandId: result.leaderCommandId,
          tasks: result.tasks,
        });
      } catch (error) {
        return reply.code(400).send({
          status: "rejected",
          code: "invalid_request",
          message: error instanceof Error ? error.message : "Invalid task request.",
        });
      }
    },
  );

  app.get<{ Querystring: { status?: string; employeeId?: string; limit?: number; offset?: number } }>(
    "/api/tasks",
    {
      schema: {
        tags: ["tasks"],
        summary: "List tasks with optional filters",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["queued", "dispatched", "accepted", "running", "completed", "failed", "cancelled", "timeout"] },
            employeeId: { type: "string" },
            limit: { type: "number", minimum: 1, maximum: 100 },
            offset: { type: "number", minimum: 0 },
          },
        },
        response: {
          200: taskListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const rows = await queryTasks(db, {
        status: request.query.status,
        employeeId: request.query.employeeId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return { tasks: rows.map((row) => dbRowToTask(row, defaultTimeoutSec)) };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    {
      schema: {
        tags: ["tasks"],
        summary: "Get a single task by ID",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        response: {
          200: taskRecordSchema,
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const row = await getTaskById(db, request.params.taskId);
      if (!row) {
        return reply.code(404).send({ error: "Task not found." });
      }
      return dbRowToTask(row, defaultTimeoutSec);
    },
  );

  app.patch<{ Params: { taskId: string }; Body: Record<string, unknown> }>(
    "/api/tasks/:taskId",
    {
      schema: {
        tags: ["tasks"],
        summary: "Update a task",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        body: taskPatchSchema,
        response: {
          200: taskRecordSchema,
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const allowed = new Set(["status", "timeoutSec", "cliConfig"]);
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request.body)) {
        if (allowed.has(key)) {
          fields[key] = value;
        }
      }
      const row = await updateTaskFields(db, request.params.taskId, fields);
      if (!row) {
        return reply.code(404).send({ error: "Task not found." });
      }
      return dbRowToTask(row, defaultTimeoutSec);
    },
  );

  app.delete<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    {
      schema: {
        tags: ["tasks"],
        summary: "Delete a task (only terminal status)",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } },
          404: errorResponseSchema,
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteTask(db, request.params.taskId);
      if (!deleted) {
        const row = await getTaskById(db, request.params.taskId);
        if (!row) {
          return reply.code(404).send({ error: "Task not found." });
        }
        return reply.code(409).send({ error: "Task is not in a terminal status." });
      }
      return { deleted: true };
    },
  );

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
        for (const leaderSocket of state.leaderSockets) {
          sendJson(leaderSocket, { type: "employee.upsert", employee });
        }
        if (employee.mainTaskId || employee.queueTaskId) {
          const timer = setTimeout(() => {
            const current = state.employees.get(employeeId);
            if (current) {
              const stillRunning = [current.mainTaskId, current.queueTaskId].filter(Boolean) as string[];
              if (stillRunning.length > 0) {
                const freshDispatch = createDispatch(dispatchCtx);
                for (const taskId of stillRunning) {
                  freshDispatch.handleAgentMessage(
                    { type: "task.failed", taskId, error: "员工连接中断且未在宽限期内恢复。" },
                    socket,
                  );
                }
              }
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
