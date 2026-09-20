import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import WebSocket from "ws";
import {
  parseEmployeeToServerMessage,
  parseJsonMessage,
  parseLeaderToServerMessage,
  type LeaderToServerMessage,
  type ServerToLeaderMessage,
  type StateSnapshot,
} from "@ai-teams/shared";
import { daemonize, stopDaemon, getDaemonStatus } from "@ai-teams/shared/daemon";
import { createDatabaseFromEnv, initDb, hydrateState, type Database, queryTasks, getTaskById, getTaskLogsByTaskId, deleteTask, dbRowToTask, upsertSchedule, getAllSchedules, getScheduleById, deleteScheduleRow, updateScheduleFields, type ScheduleRecord, listAgentRegistrations, upsertAgentRegistration, deleteAgentRegistration, deleteEmployee } from "./db.js";
import { type RestTaskRequest, errorResponseSchema, snapshotSchema, sessionHistorySchema, restTaskRequestSchema, restTaskAcceptedSchema, taskListResponseSchema, taskRecordSchema, taskOutputResponseSchema, taskPatchSchema, parseRestTaskRequest, claudeSessionsResponseSchema, createScheduleRequestSchema, updateScheduleRequestSchema, scheduleResponseSchema, scheduleListResponseSchema, agentRegistrationListResponseSchema, createAgentRegistrationRequestSchema, agentRegistrationTokenResponseSchema, createMissionRequestSchema, missionListResponseSchema, missionDetailResponseSchema, approvalResponseRequestSchema, type CreateScheduleRequest, type UpdateScheduleRequest, type CreateMissionRequest } from "./schemas.js";
import { createDispatch, nowIso, sendJson } from "./dispatch.js";
import type { DispatchContext } from "./dispatch.js";
import { createInMemoryStateStore } from "./state-store.js";
import { createEncryptor } from "./crypto.js";
import { startScheduleJob, stopScheduleJob, type ScheduleDispatchFn } from "./scheduler.js";
import { createLeaderOrchestrator } from "./leader-orchestrator.js";

function scheduleToResponse(s: ScheduleRecord) {
  return {
    id: s.id,
    name: s.name,
    cron: s.cronExpr,
    enabled: s.enabled,
    targetMode: s.targetMode,
    targetAgents: s.targetAgents,
    prompt: s.prompt,
    workspace: s.workspace,
    timeoutSec: s.timeoutSec,
    priority: s.priority,
    requiredLabels: s.requiredLabels,
    lastRunAt: s.lastRunAt,
    nextRunAt: s.nextRunAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function agentRegistrationToResponse(registration: {
  employeeId: string;
  name: string;
  machineId: string | null;
  hostname: string | null;
  labels: string[];
  status: "pending" | "approved";
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
}) {
  return {
    employeeId: registration.employeeId,
    name: registration.name,
    machineId: registration.machineId,
    hostname: registration.hostname,
    labels: registration.labels,
    status: registration.status,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
    approvedAt: registration.approvedAt,
    lastSeenAt: registration.lastSeenAt,
  };
}

const DEFAULT_PORT = 3789;

export type AiTeamsServerOptions = {
  authToken: string;
  port?: number;
  host?: string;
  dataDir?: string;
  dbPath?: string;
  defaultTimeoutSec?: number;
  disconnectGraceMs?: number;
  runningDisconnectGraceMs?: number;
  logger?: boolean;
  logLevel?: string;
  logDir?: string;
  maxLogChunksPerTask?: number;
  maxHydratedTasks?: number;
  maxRuntimeTasks?: number;
  agentRegistrationMode?: "open" | "approval";
  missionPollMs?: number;
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

function nextDateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && typeof (value as { toISO?: unknown }).toISO === "function") {
    return ((value as { toISO(): string | null }).toISO()) ?? null;
  }
  return null;
}

function generateAgentToken() {
  return randomBytes(24).toString("base64url");
}

function hashAgentToken(serverToken: string, agentToken: string) {
  return createHmac("sha256", serverToken).update(agentToken).digest("hex");
}

export async function createAiTeamsServer(options: AiTeamsServerOptions): Promise<AiTeamsServer> {
  if (!options.authToken) {
    throw new Error("AI_TEAMS_AUTH_TOKEN is required.");
  }

  const defaultTimeoutSec = options.defaultTimeoutSec ?? 1800;
  const disconnectGraceMs = options.disconnectGraceMs ?? 15000;
  const runningDisconnectGraceMs = options.runningDisconnectGraceMs ?? Math.max(disconnectGraceMs, 120_000);
  const maxLogChunksPerTask = options.maxLogChunksPerTask ?? 400;
  const maxHydratedTasks = options.maxHydratedTasks ?? 200;
  const maxRuntimeTasks = options.maxRuntimeTasks ?? 500;
  const dataDir = options.dataDir ?? path.join(process.cwd(), "data");
  const dbPath = options.dbPath ?? path.join(dataDir, "ai-teams.db");
  let closing = false;
  const state = createInMemoryStateStore();

  const db = await createDatabaseFromEnv({
    AI_TEAMS_AUTH_TOKEN: options.authToken,
    DATA_DIR: dataDir,
    DB_PATH: dbPath,
    DATABASE_URL: process.env.DATABASE_URL,
  });
  await initDb(db);
  await hydrateState(db, state, defaultTimeoutSec, maxLogChunksPerTask, maxHydratedTasks);
  let taskDataGeneration = (await db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'task_data_generation'"))?.value ?? "";

  const logLevel = options.logLevel || process.env.LOG_LEVEL || "info";
  const logDir = options.logDir || process.env.LOG_DIR;

  let loggerConfig: FastifyServerOptions["logger"] = { level: logLevel };

  if (logDir && options.logger !== false) {
    fs.mkdirSync(logDir, { recursive: true });
    loggerConfig = {
      level: logLevel,
      transport: {
        targets: [
          { target: "pino/file", options: { destination: 1 }, level: logLevel },
          { target: "pino/file", options: { destination: path.join(logDir, "server.log") }, level: logLevel },
        ],
      },
    };
  }

  const app = Fastify({ logger: options.logger === false ? false : loggerConfig, bodyLimit: 1048576 }) as FastifyInstance;
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

  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((_, reply) => {
      reply.sendFile("index.html");
    });
    app.log.info({ webDir }, "Web UI enabled");
  }

  const encryptor = createEncryptor(process.env.AI_TEAMS_ENCRYPTION_KEY);
  const dispatchCtx: DispatchContext = {
    state,
    db,
    log: app.log,
    authToken: options.authToken,
    defaultTimeoutSec,
    disconnectGraceMs,
    runningDisconnectGraceMs,
    encryptor,
    maxLogChunksPerTask,
    maxRuntimeTasks,
    hashAgentToken: (token) => hashAgentToken(options.authToken, token),
  };
  const { dispatchLeaderCommand, handleAgentMessage, handleLeaderMessage, cancelTaskById, patchTaskById, prioritizeTask, startDisconnectRecovery, resumeAgentQueue, pauseAgentQueue, resetAgentSession, drainTaskWrites, finishTaskCleanup, resumeAfterTaskCleanup, cleanup: dispatchCleanup } = createDispatch(dispatchCtx);
  const missionOrchestrator = createLeaderOrchestrator({
    db,
    state,
    dispatchMissionTask: dispatchLeaderCommand,
    log: app.log,
    pollMs: options.missionPollMs,
  });
  missionOrchestrator.start();

  const scheduleDispatchFn: ScheduleDispatchFn = (message, webhookUrl, cliConfig, priority, requiredLabels) => {
    return dispatchLeaderCommand(message, webhookUrl, cliConfig, priority, requiredLabels);
  };

  async function onScheduleFire(scheduleId: string) {
    const now = new Date().toISOString();
    const job = state.scheduleJobs.get(scheduleId);
    const nextRun = nextDateToIso(job?.nextDate());
    await updateScheduleFields(db, scheduleId, { lastRunAt: now, nextRunAt: nextRun });
  }

  async function loadAndStartSchedules() {
    const schedules = await getAllSchedules(db);
    for (const schedule of schedules) {
      if (schedule.enabled) {
        try {
          startScheduleJob(schedule, scheduleDispatchFn, state.scheduleJobs, onScheduleFire, (id, err) => {
            app.log.error({ scheduleId: id, err }, "Scheduled task failed");
          });
        } catch (err) {
          app.log.error({ scheduleId: schedule.id, cronExpr: schedule.cronExpr, err }, "Failed to start schedule");
        }
      }
    }
    app.log.info({ count: schedules.filter((s) => s.enabled).length }, "Schedules loaded");
  }

  await loadAndStartSchedules();

  function buildSnapshot(): StateSnapshot {
    return {
      employees: [...state.employees.values()],
      tasks: [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      logs: {},
      taskDataGeneration,
      serverVersion: typeof PKG_VERSION !== "undefined" ? PKG_VERSION : undefined,
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

  function extractUserMessage(line: string): string | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "human" || obj.role === "user" || obj.message?.role === "user") {
        const content = obj.message?.content ?? obj.content;
        if (typeof content === "string") return content.slice(0, 200);
        if (Array.isArray(content)) {
          const text = content.filter((c: Record<string, unknown>) => typeof c.text === "string").map((c: { text: string }) => c.text).join("\n");
          return text.slice(0, 200) || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildClaudeSessions(employeeId: string) {
    const employee = state.employees.get(employeeId);
    const workspace = [...state.tasks.values()]
      .filter((t) => t.employeeId === employeeId && t.workspace)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.workspace ?? null;

    if (!workspace) {
      return { employeeId, workspace: null, activeSessionId: null, sessions: [] };
    }

    const encodedPath = workspace.replace(/\//g, "-");
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects", encodedPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
    } catch {
      return { employeeId, workspace, activeSessionId: null, sessions: [] };
    }

    const jsonlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .sort((a, b) => b.name.localeCompare(a.name));

    const MAX_JSONL_SIZE = 5 * 1024 * 1024;
    const sessions = jsonlFiles.map((entry) => {
      const filePath = path.join(claudeProjectsDir, entry.name);
      const stat = fs.statSync(filePath);
      const sessionId = entry.name.replace(/\.jsonl$/, "");

      let firstUserMessage: string | null = null;
      let latestUserMessage: string | null = null;
      let lineCount = 0;

      if (stat.size <= MAX_JSONL_SIZE) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter(Boolean);
        lineCount = lines.length;
        for (const line of lines) {
          const msg = extractUserMessage(line);
          if (msg && !firstUserMessage) firstUserMessage = msg;
          if (msg) latestUserMessage = msg;
        }
      }

      return { id: sessionId, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), lineCount, firstUserMessage, latestUserMessage };
    });

    let activeSessionId: string | null = null;
    const agentStatePath = path.join(workspace, ".ai-teams", "agents", employeeId, "session-state.json");
    try {
      const raw = fs.readFileSync(agentStatePath, "utf8");
      activeSessionId = JSON.parse(raw).claudeSessionId ?? null;
    } catch { /* ignore */ }

    return { employeeId, workspace, activeSessionId, sessions };
  }

  function validateScheduleTargetConfig(
    input: { targetMode?: "queue" | "direct" | "broadcast"; targetAgents?: string[] },
    existing?: ScheduleRecord,
  ) {
    const targetMode = input.targetMode ?? existing?.targetMode ?? "queue";
    const targetAgents = input.targetAgents ?? existing?.targetAgents ?? [];
    if (targetMode === "direct" && targetAgents.length === 0) {
      return "Direct schedules must select at least one target agent.";
    }
    return null;
  }

  const staticExts = new Set([".html", ".js", ".css", ".ico", ".png", ".jpg", ".svg", ".woff", ".woff2", ".ttf", ".map"]);
  const activeMutations = new Set<string>();
  app.addHook("onResponse", async (request) => { activeMutations.delete(request.id); });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/ws/") || request.url.startsWith("/docs")) {
      return;
    }
    const ext = path.extname(request.url.split("?")[0]);
    if (request.url === "/" || staticExts.has(ext)) {
      return;
    }
    if (!isAuthorized(options.authToken, request.url, request.headers)) {
      app.log.warn({ url: request.url, ip: request.ip }, "Unauthorized request");
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (request.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (state.clearingTasks) return reply.code(503).send({ error: "正在清空任务，请稍后重试。" });
      activeMutations.add(request.id);
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
        summary: "Get current employees and tasks (logs not included, use WebSocket task.output or GET /api/sessions/:sessionId/history)",
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

  app.get<{ Params: { employeeId: string } }>(
    "/api/employees/:employeeId/claude-sessions",
    {
      schema: {
        tags: ["employees"],
        summary: "List local Claude Code sessions for an agent's workspace",
        params: {
          type: "object",
          required: ["employeeId"],
          properties: { employeeId: { type: "string", minLength: 1 } },
        },
        response: {
          200: claudeSessionsResponseSchema,
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const employee = state.employees.get(request.params.employeeId);
      if (!employee) {
        return reply.code(404).send({ error: "Employee not found." });
      }
      return buildClaudeSessions(request.params.employeeId);
    },
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
        const { command, webhookUrl, cliConfig, priority, requiredLabels } = parseRestTaskRequest(request.body);
        const result = dispatchLeaderCommand(command, webhookUrl, cliConfig, priority, requiredLabels);
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

  app.delete<{ Body: { confirm: "clear-all-tasks" } }>(
    "/api/tasks",
    {
      schema: {
        tags: ["tasks"],
        summary: "Clear all tasks, output, webhooks and Mission history",
        body: {
          type: "object", required: ["confirm"], additionalProperties: false,
          properties: { confirm: { type: "string", enum: ["clear-all-tasks"] } },
        },
      },
    },
    async (request, reply) => {
      // Acquire before the first await, including when two requests passed preHandler together.
      if (state.clearingTasks) return reply.code(503).send({ error: "正在清空任务，请稍后重试。" });
      state.clearingTasks = true;
      try {
        while ([...activeMutations].some((id) => id !== request.id)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await missionOrchestrator.drain();
        await drainTaskWrites();
        const enabledSchedules = (await getAllSchedules(db)).filter((schedule) => schedule.enabled).length;
        const deleted = await db.clearTaskData();
        taskDataGeneration = deleted.generation;
        const cancellation = finishTaskCleanup();
        const snapshot = buildSnapshot();
        for (const socket of state.leaderSockets) {
          sendJson<ServerToLeaderMessage>(socket, { type: "tasks.cleared", snapshot }, dispatchCtx.encryptor);
        }
        app.log.info({ deleted, ...cancellation }, "All task data cleared");
        return { deleted: { tasks: deleted.tasks, missions: deleted.missions }, ...cancellation, enabledSchedules };
      } finally {
        state.clearingTasks = false;
        await resumeAfterTaskCleanup();
      }
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

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/output",
    {
      schema: {
        tags: ["tasks"],
        summary: "Get task output chunks",
        description: "Returns ordered task output chunks for the specified task ID.",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        response: {
          200: taskOutputResponseSchema,
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
      const chunks = await getTaskLogsByTaskId(db, request.params.taskId);
      const output = chunks.map((c) => c.content).join("");
      return { taskId: request.params.taskId, output };
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
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = patchTaskById(request.params.taskId, request.body);
      if (!result.ok) {
        const code = result.code === "not_found" ? 404 : 409;
        return reply.code(code).send({ error: result.message });
      }
      return result.task;
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/cancel",
    {
      schema: {
        tags: ["tasks"],
        summary: "Cancel a task",
        description: "Cancel a queued or running task. For running tasks, notifies the agent to terminate the claude process.",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        response: {
          200: taskRecordSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = cancelTaskById(request.params.taskId);
      if (!result.ok) {
        const code = result.code === "not_found" ? 404 : 409;
        return reply.code(code).send({ error: result.message });
      }
      return result.task;
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/prioritize",
    {
      schema: {
        tags: ["tasks"],
        summary: "Prioritize a queued task",
        description: "Move a queued task to the front of the shared queue by bumping its priority to the highest value. Only applies to tasks with status=queued and targetMode=queue.",
        params: {
          type: "object",
          required: ["taskId"],
          properties: { taskId: { type: "string", minLength: 1 } },
        },
        response: {
          200: taskRecordSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = prioritizeTask(request.params.taskId);
      if (!result.ok) {
        const code = result.code === "not_found" ? 404 : 409;
        return reply.code(code).send({ error: result.message });
      }
      return result.task;
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

  // ── Mission Routes ────────────────────────────────────────────────────

  app.get(
    "/api/missions",
    {
      schema: {
        tags: ["missions"],
        summary: "List AI Leader missions",
        response: { 200: missionListResponseSchema, 401: errorResponseSchema },
      },
    },
    async () => {
      const missions = await missionOrchestrator.list();
      return { missions };
    },
  );

  app.post<{ Body: CreateMissionRequest }>(
    "/api/missions",
    {
      schema: {
        tags: ["missions"],
        summary: "Create an AI Leader mission",
        description:
          "Creates a durable Mission. The AI Leader Orchestrator decomposes it into normal AI Teams tasks, waits for results, asks for human approval when required, and completes or fails the Mission.",
        body: createMissionRequestSchema,
        response: { 201: missionDetailResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const mission = await missionOrchestrator.create(request.body);
        const detail = await missionOrchestrator.detail(mission.id);
        return reply.code(201).send(detail);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid mission request." });
      }
    },
  );

  app.get<{ Params: { missionId: string } }>(
    "/api/missions/:missionId",
    {
      schema: {
        tags: ["missions"],
        summary: "Get an AI Leader mission with events, subtasks, and approvals",
        params: { type: "object", required: ["missionId"], properties: { missionId: { type: "string", minLength: 1 } } },
        response: { 200: missionDetailResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const detail = await missionOrchestrator.detail(request.params.missionId);
      if (!detail) return reply.code(404).send({ error: "Mission not found." });
      return detail;
    },
  );

  app.post<{ Params: { missionId: string } }>(
    "/api/missions/:missionId/cancel",
    {
      schema: {
        tags: ["missions"],
        summary: "Cancel an AI Leader mission",
        params: { type: "object", required: ["missionId"], properties: { missionId: { type: "string", minLength: 1 } } },
        response: { 200: missionDetailResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const mission = await missionOrchestrator.cancel(request.params.missionId);
      if (!mission) return reply.code(404).send({ error: "Mission not found." });
      const detail = await missionOrchestrator.detail(mission.id);
      return detail;
    },
  );

  app.post<{ Params: { missionId: string; approvalId: string }; Body: { approved: boolean; response?: string } }>(
    "/api/missions/:missionId/approvals/:approvalId/respond",
    {
      schema: {
        tags: ["missions"],
        summary: "Approve or reject a Mission human-in-the-loop request",
        params: {
          type: "object",
          required: ["missionId", "approvalId"],
          properties: {
            missionId: { type: "string", minLength: 1 },
            approvalId: { type: "string", minLength: 1 },
          },
        },
        body: approvalResponseRequestSchema,
        response: { 200: missionDetailResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const approval = await missionOrchestrator.respondToApproval(
        request.params.approvalId,
        request.body.approved,
        request.body.response ?? null,
      );
      if (!approval || approval.missionId !== request.params.missionId) {
        return reply.code(404).send({ error: "Approval not found." });
      }
      const detail = await missionOrchestrator.detail(request.params.missionId);
      if (!detail) return reply.code(404).send({ error: "Mission not found." });
      return detail;
    },
  );

  // ── Agent Routes ─────────────────────────────────────────────────────

  app.get(
    "/api/agent-registry",
    {
      schema: {
        tags: ["agents"],
        summary: "List registered and pending agents",
        response: { 200: agentRegistrationListResponseSchema, 401: errorResponseSchema },
      },
    },
    async () => {
      const agents = await listAgentRegistrations(db);
      return { agents: agents.map(agentRegistrationToResponse) };
    },
  );

  app.post<{ Body: { employeeId: string; name?: string; labels?: string[]; token?: string } }>(
    "/api/agent-registry",
    {
      schema: {
        tags: ["agents"],
        summary: "Pre-approve an agent and generate its token",
        body: createAgentRegistrationRequestSchema,
        response: { 201: agentRegistrationTokenResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const agentToken = request.body.token?.trim() || generateAgentToken();
      const now = nowIso();
      await upsertAgentRegistration(db, {
        employeeId: request.body.employeeId,
        name: request.body.name?.trim() || request.body.employeeId,
        labels: request.body.labels ?? [],
        tokenHash: hashAgentToken(options.authToken, agentToken),
        status: "approved",
        approvedAt: now,
      });
      const agent = await listAgentRegistrations(db).then((items) => items.find((item) => item.employeeId === request.body.employeeId));
      return reply.code(201).send({ agent: agentRegistrationToResponse(agent!), agentToken });
    },
  );

  app.post<{ Params: { employeeId: string }; Body: { token?: string } }>(
    "/api/agent-registry/:employeeId/approve",
    {
      schema: {
        tags: ["agents"],
        summary: "Approve a pending agent and generate its token",
        params: { type: "object", required: ["employeeId"], properties: { employeeId: { type: "string", minLength: 1 } } },
        body: { type: "object", properties: { token: { type: "string", minLength: 8 } } },
        response: { 200: agentRegistrationTokenResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = (await listAgentRegistrations(db)).find((item) => item.employeeId === request.params.employeeId);
      if (!existing) return reply.code(404).send({ error: "Agent registration not found." });
      const agentToken = request.body?.token?.trim() || generateAgentToken();
      const now = nowIso();
      await upsertAgentRegistration(db, {
        employeeId: existing.employeeId,
        name: existing.name,
        machineId: existing.machineId,
        hostname: existing.hostname,
        labels: existing.labels,
        tokenHash: hashAgentToken(options.authToken, agentToken),
        status: "approved",
        approvedAt: now,
        lastSeenAt: existing.lastSeenAt,
      });
      const agent = (await listAgentRegistrations(db)).find((item) => item.employeeId === request.params.employeeId);
      return { agent: agentRegistrationToResponse(agent!), agentToken };
    },
  );

  app.delete<{ Params: { employeeId: string } }>(
    "/api/agent-registry/:employeeId",
    {
      schema: {
        tags: ["agents"],
        summary: "Delete an agent registration and disconnect the agent",
        params: { type: "object", required: ["employeeId"], properties: { employeeId: { type: "string", minLength: 1 } } },
        response: {
          200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } },
          404: errorResponseSchema,
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const employee = state.employees.get(request.params.employeeId);
      if (employee?.mainTaskId || employee?.queueTaskId) {
        return reply.code(409).send({ error: "Agent has active tasks and cannot be deleted." });
      }
      const deleted = await deleteAgentRegistration(db, request.params.employeeId);
      if (!deleted) return reply.code(404).send({ error: "Agent registration not found." });
      const socket = state.agentSockets.get(request.params.employeeId);
      if (socket) socket.close(1008, "agent_deleted");
      state.agentSockets.delete(request.params.employeeId);
      state.employees.delete(request.params.employeeId);
      await deleteEmployee(db, request.params.employeeId);
      for (const leaderSocket of state.leaderSockets) {
        sendJson<ServerToLeaderMessage>(leaderSocket, { type: "employee.delete", employeeId: request.params.employeeId }, dispatchCtx.encryptor);
      }
      return { deleted: true };
    },
  );

  app.post<{ Params: { employeeId: string } }>(
    "/api/agents/:employeeId/resume-queue",
    {
      schema: {
        tags: ["agents"],
        summary: "Resume an agent's queue dispatch after consecutive failures",
        params: {
          type: "object",
          required: ["employeeId"],
          properties: { employeeId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = resumeAgentQueue(request.params.employeeId);
      if (!result.ok) {
        return reply.code(404).send({ error: result.message });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { employeeId: string } }>(
    "/api/agents/:employeeId/pause-queue",
    {
      schema: {
        tags: ["agents"],
        summary: "Pause an agent's queue dispatch",
        params: {
          type: "object",
          required: ["employeeId"],
          properties: { employeeId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = pauseAgentQueue(request.params.employeeId);
      if (!result.ok) {
        return reply.code(404).send({ error: result.message });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { employeeId: string } }>(
    "/api/agents/:employeeId/reset-session",
    {
      schema: {
        tags: ["agents"],
        summary: "Reset an agent's main task Claude session",
        params: {
          type: "object",
          required: ["employeeId"],
          properties: { employeeId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          404: errorResponseSchema,
          409: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = resetAgentSession(request.params.employeeId);
      if (!result.ok) {
        const code = result.message.includes("不在线") ? 404 : 409;
        return reply.code(code).send({ error: result.message });
      }
      return { ok: true };
    },
  );

  // ── Schedule Routes ───────────────────────────────────────────────────

  app.get(
    "/api/schedules",
    {
      schema: {
        tags: ["schedules"],
        summary: "List all schedules",
        response: { 200: scheduleListResponseSchema, 401: errorResponseSchema },
      },
    },
    async () => {
      const schedules = await getAllSchedules(db);
      return { schedules: schedules.map(scheduleToResponse) };
    },
  );

  app.get<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Get a schedule by ID",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const schedule = await getScheduleById(db, request.params.scheduleId);
      if (!schedule) return reply.code(404).send({ error: "Schedule not found." });
      return scheduleToResponse(schedule);
    },
  );

  app.post<{ Body: CreateScheduleRequest }>(
    "/api/schedules",
    {
      schema: {
        tags: ["schedules"],
        summary: "Create a schedule",
        body: createScheduleRequestSchema,
        response: { 201: scheduleResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const targetError = validateScheduleTargetConfig(body);
      if (targetError) {
        return reply.code(400).send({ error: targetError });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const schedule: ScheduleRecord = {
        id,
        name: body.name,
        cronExpr: body.cron,
        enabled: body.enabled ?? true,
        targetMode: body.targetMode ?? "queue",
        targetAgents: body.targetAgents ?? [],
        prompt: body.prompt,
        workspace: body.workspace ?? null,
        timeoutSec: body.timeoutSec ?? null,
        priority: body.priority ?? 0,
        requiredLabels: body.requiredLabels ?? null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        if (schedule.enabled) {
          startScheduleJob(schedule, scheduleDispatchFn, state.scheduleJobs, onScheduleFire, (scheduleId, error) => {
            app.log.error({ scheduleId, error }, "Scheduled task failed");
          });
          schedule.nextRunAt = nextDateToIso(state.scheduleJobs.get(id)?.nextDate());
        }
        await upsertSchedule(db, schedule);
        return reply.code(201).send(scheduleToResponse(schedule));
      } catch (err) {
        stopScheduleJob(state.scheduleJobs, id);
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid schedule." });
      }
    },
  );

  app.patch<{ Params: { scheduleId: string }; Body: UpdateScheduleRequest }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Update a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        body: updateScheduleRequestSchema,
        response: { 200: scheduleResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = await getScheduleById(db, request.params.scheduleId);
      if (!existing) return reply.code(404).send({ error: "Schedule not found." });
      const targetError = validateScheduleTargetConfig(request.body, existing);
      if (targetError) {
        return reply.code(400).send({ error: targetError });
      }
      const fields: Record<string, unknown> = {};
      if (request.body.name !== undefined) fields.name = request.body.name;
      if (request.body.cron !== undefined) fields.cronExpr = request.body.cron;
      if (request.body.enabled !== undefined) fields.enabled = request.body.enabled;
      if (request.body.targetMode !== undefined) fields.targetMode = request.body.targetMode;
      if (request.body.targetAgents !== undefined) fields.targetAgents = request.body.targetAgents;
      if (request.body.prompt !== undefined) fields.prompt = request.body.prompt;
      if (request.body.workspace !== undefined) fields.workspace = request.body.workspace;
      if (request.body.timeoutSec !== undefined) fields.timeoutSec = request.body.timeoutSec;
      if (request.body.priority !== undefined) fields.priority = request.body.priority;
      if (request.body.requiredLabels !== undefined) fields.requiredLabels = request.body.requiredLabels;
      const updated = await updateScheduleFields(db, request.params.scheduleId, fields);
      if (!updated) return reply.code(404).send({ error: "Schedule not found." });
      try {
        stopScheduleJob(state.scheduleJobs, request.params.scheduleId);
        if (updated.enabled) {
          startScheduleJob(updated, scheduleDispatchFn, state.scheduleJobs, onScheduleFire, (scheduleId, error) => {
            app.log.error({ scheduleId, error }, "Scheduled task failed");
          });
          updated.nextRunAt = nextDateToIso(state.scheduleJobs.get(request.params.scheduleId)?.nextDate());
          await updateScheduleFields(db, request.params.scheduleId, { nextRunAt: updated.nextRunAt });
        }
        return scheduleToResponse(updated);
      } catch (err) {
        stopScheduleJob(state.scheduleJobs, request.params.scheduleId);
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid schedule." });
      }
    },
  );

  app.delete<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Delete a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: {
          200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } },
          404: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      stopScheduleJob(state.scheduleJobs, request.params.scheduleId);
      const deleted = await deleteScheduleRow(db, request.params.scheduleId);
      if (!deleted) return reply.code(404).send({ error: "Schedule not found." });
      return { deleted: true };
    },
  );

  app.post<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId/trigger",
    {
      schema: {
        tags: ["schedules"],
        summary: "Manually trigger a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: { 200: scheduleResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const schedule = await getScheduleById(db, request.params.scheduleId);
      if (!schedule) return reply.code(404).send({ error: "Schedule not found." });
      const atAgents = schedule.targetMode === "queue"
        ? ("queue" as const)
        : schedule.targetMode === "broadcast"
        ? ("all" as const)
        : schedule.targetAgents;
      const result = dispatchLeaderCommand(
        { type: "command.dispatch", atAgents, prompt: schedule.prompt, workspace: schedule.workspace ?? undefined, timeoutSec: schedule.timeoutSec ?? undefined },
        null, undefined, schedule.priority, schedule.requiredLabels,
      );
      if (!result.ok) return reply.code(400).send({ error: result.message });
      await onScheduleFire(request.params.scheduleId);
      const updated = await getScheduleById(db, request.params.scheduleId);
      if (!updated) return reply.code(404).send({ error: "Schedule not found." });
      return scheduleToResponse(updated);
    },
  );

  app.get("/ws/agent", { websocket: true }, (socket) => {
    app.log.info("Agent connected");

    let messageQueue = Promise.resolve();
    socket.on("message", (raw: WebSocket.RawData) => {
      messageQueue = messageQueue
        .then(async () => {
          const decrypted = encryptor.decrypt(raw.toString());
          const message = parseEmployeeToServerMessage(parseJsonMessage(decrypted));
          await handleAgentMessage(message, socket);
        })
        .catch((error) => {
          app.log.error({ error }, "Failed to parse agent message");
          socket.close(1008, "invalid_message");
        });
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
      state.socketToEmployeeId.delete(socket);
      const heartbeatTimer = state.heartbeatTimers.get(employeeId);
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        state.heartbeatTimers.delete(employeeId);
      }
      const employee = state.employees.get(employeeId);
      if (employee) {
        employee.status = "offline";
        employee.lastSeenAt = nowIso();
        for (const leaderSocket of state.leaderSockets) {
          sendJson(leaderSocket, { type: "employee.upsert", employee }, dispatchCtx.encryptor);
        }
        // Don't fail tasks on disconnect — agent may still be running locally.
        // Start a grace period; if agent doesn't reconnect, tasks are re-queued.
        startDisconnectRecovery(employeeId);
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
    sendJson<ServerToLeaderMessage>(socket, { type: "snapshot", snapshot: buildSnapshot() }, dispatchCtx.encryptor);
    app.log.info("Leader connected");

    socket.on("message", (raw: WebSocket.RawData) => {
      const text = raw.toString();
      if (!text) return; // heartbeat ping
      try {
        const decrypted = encryptor.decrypt(text);
        const message = parseLeaderToServerMessage(parseJsonMessage(decrypted));
        handleLeaderMessage(message, socket);
      } catch (error) {
        app.log.error({ error }, "Failed to parse leader message");
        sendJson<ServerToLeaderMessage>(socket, {
          type: "command.error",
          code: "invalid_message",
          message: error instanceof Error ? error.message : "Invalid leader message.",
        }, dispatchCtx.encryptor);
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
      for (const job of state.scheduleJobs.values()) {
        job.stop();
      }
      for (const timer of state.taskTimeouts.values()) {
        clearTimeout(timer);
      }
      for (const timer of state.disconnectTimers.values()) {
        clearTimeout(timer);
      }
      for (const timer of state.heartbeatTimers.values()) {
        clearTimeout(timer);
      }
      missionOrchestrator.stop();
      dispatchCleanup();
      await app.close();
      await drainTaskWrites();
      await db.close();
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
    runningDisconnectGraceMs: Number(env.RUNNING_DISCONNECT_GRACE_MS) || undefined,
    logLevel: env.LOG_LEVEL,
    logDir: env.LOG_DIR,
    maxLogChunksPerTask: Number(env.MAX_LOG_CHUNKS_PER_TASK) || 400,
    maxHydratedTasks: Number(env.MAX_HYDRATED_TASKS) || 200,
    maxRuntimeTasks: Number(env.MAX_RUNTIME_TASKS) || 500,
    agentRegistrationMode: env.AGENT_REGISTRATION_MODE === "open" ? "open" : "approval",
    missionPollMs: Number(env.MISSION_POLL_MS) || undefined,
  };
}

export async function startServer(options = readOptionsFromEnv()) {
  const server = await createAiTeamsServer(options);
  await server.app.listen({ port: options.port ?? DEFAULT_PORT, host: options.host ?? "0.0.0.0" });
  return server;
}

declare const PKG_VERSION: string;

const isCli = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  function getArgValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(PKG_VERSION);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ai-teams-server — AI Teams 中央服务器

用法: ai-teams-server <command> [选项]

命令:
  start [选项]          后台启动守护进程
  stop                  停止守护进程
  restart [选项]        重启守护进程
  status                查看运行状态

选项:
  --token <token>       认证 Token (必填，或设 AI_TEAMS_AUTH_TOKEN)
  --port <port>         服务端口 (默认 3789)
  --host <host>         绑定地址 (默认 0.0.0.0)
  --data-dir <dir>      数据目录
  --database-url <url>  PostgreSQL 连接字符串 (设置后使用 PostgreSQL 而非 SQLite)
  --db-path <path>      数据库路径
  --log-level <level>   日志级别 trace/debug/info/warn/error (默认 info)
  --log-dir <dir>       日志文件目录 (不设则仅输出到 stdout)
  -v, --version         显示版本号
  -h, --help            显示帮助

不带命令直接运行时为前台模式。
`);
    process.exit(0);
  }

  // Config persistence
  const SERVER_CONFIG_DIR = path.join(os.homedir(), ".ai-teams");
  const SERVER_CONFIG_FILE = path.join(SERVER_CONFIG_DIR, "server-config.json");
  type ServerConfig = {
    authToken?: string;
    port?: string;
    host?: string;
    dataDir?: string;
    databaseUrl?: string;
    dbPath?: string;
    logLevel?: string;
    logDir?: string;
  };
  function loadServerConfig(): ServerConfig | null {
    try { return JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, "utf8")); } catch { return null; }
  }
  function saveServerConfig(config: ServerConfig) {
    fs.mkdirSync(SERVER_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  }

  // Resolve paths
  function resolveDataDir(): string {
    return getArgValue("--data-dir") || process.env.DATA_DIR || path.join(process.cwd(), "data");
  }
  function resolvePidFile(): string {
    return path.join(resolveDataDir(), ".ai-teams-server.pid");
  }
  function resolveLogDir(): string {
    return getArgValue("--log-dir") || process.env.LOG_DIR || path.join(resolveDataDir(), "logs");
  }

  function applyCliArgsToEnv(): void {
    const saved = loadServerConfig() ?? {};
    const cliToken = getArgValue("--token");
    const cliPort = getArgValue("--port");
    const cliHost = getArgValue("--host");
    const cliDataDir = getArgValue("--data-dir");
    const cliDatabaseUrl = getArgValue("--database-url");
    const cliDbPath = getArgValue("--db-path");
    const cliLogLevel = getArgValue("--log-level");
    const cliLogDir = getArgValue("--log-dir");

    // CLI args override saved config, saved config overrides env
    const token = cliToken || process.env.AI_TEAMS_AUTH_TOKEN || saved.authToken;
    const port = cliPort || process.env.AI_TEAMS_SERVER_PORT || saved.port;
    const host = cliHost || process.env.HOST || saved.host;
    const dataDir = cliDataDir || process.env.DATA_DIR || saved.dataDir;
    const databaseUrl = cliDatabaseUrl || process.env.DATABASE_URL || saved.databaseUrl;
    const dbPath = cliDbPath || process.env.DB_PATH || saved.dbPath;
    const logLevel = cliLogLevel || process.env.LOG_LEVEL || saved.logLevel;
    const logDir = cliLogDir || process.env.LOG_DIR || saved.logDir;

    if (token) process.env.AI_TEAMS_AUTH_TOKEN = token;
    if (port) process.env.AI_TEAMS_SERVER_PORT = port;
    if (host) process.env.HOST = host;
    if (dataDir) process.env.DATA_DIR = dataDir;
    if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
    if (dbPath) process.env.DB_PATH = dbPath;
    if (logLevel) process.env.LOG_LEVEL = logLevel;
    if (logDir) process.env.LOG_DIR = logDir;

    // Save if any new CLI args were provided
    const newConfig: ServerConfig = { authToken: token, port, host, dataDir, databaseUrl, dbPath, logLevel, logDir };
    if (cliToken || cliPort || cliHost || cliDataDir || cliDatabaseUrl || cliDbPath || cliLogLevel || cliLogDir || !loadServerConfig()) {
      saveServerConfig(newConfig);
    }
  }

  const subcommand = args[0];
  if (subcommand === "start" || subcommand === "restart") {
    void (async () => {
      applyCliArgsToEnv();

      if (!process.env.__AI_TEAMS_DAEMON_WATCHDOG && !process.env.__AI_TEAMS_DAEMON_WORKER) {
        // Only the launcher process should stop/check existing daemon
        if (subcommand === "restart") {
          const status = getDaemonStatus(resolvePidFile());
          if (status.running) {
            await stopDaemon(resolvePidFile());
          }
        } else {
          const status = getDaemonStatus(resolvePidFile());
          if (status.running) {
            console.log(`Already running (PID ${status.pid}).`);
            process.exit(0);
          }
        }
      }

      if (!process.env.AI_TEAMS_AUTH_TOKEN) {
        console.error("错误: 需要认证 Token。使用 --token <token> 或设置 AI_TEAMS_AUTH_TOKEN 环境变量。");
        process.exit(1);
      }
      // Ensure log-dir is set for daemon mode
      if (!process.env.LOG_DIR) {
        process.env.LOG_DIR = resolveLogDir();
      }

      await daemonize({
        name: "ai-teams-server",
        pidFile: resolvePidFile(),
        logFile: path.join(resolveLogDir(), "server.log"),
        run: async () => {
          await startServer(readOptionsFromEnv());
        },
      });
    })();
  } else if (subcommand === "stop") {
    void (async () => {
      await stopDaemon(resolvePidFile());
    })();
  } else if (subcommand === "status") {
    const status = getDaemonStatus(resolvePidFile());
    if (status.running) {
      console.log(`ai-teams-server is running (PID ${status.pid})`);
      console.log(`Log: ${path.join(resolveLogDir(), "server.log")}`);
    } else {
      console.log("ai-teams-server is not running.");
    }
  } else if (subcommand === "update") {
    const { execSync } = await import("node:child_process");
    try {
      execSync("npm install -g @csdwd/ai-teams-server@latest", { stdio: "inherit" });
      const ver = execSync("ai-teams-server --version").toString().trim();
      console.log(`\n  ✓ 已更新到 ${ver}`);
      const status = getDaemonStatus(resolvePidFile());
      if (status.running) {
        console.log("  提示: 运行 ai-teams-server restart 以应用更新。");
      }
    } catch {
      process.exit(1);
    }
  } else {
    // No sub-command — foreground mode (existing behavior)
    applyCliArgsToEnv();
    const options = readOptionsFromEnv();
    if (!options.authToken) {
      console.error("错误: 需要认证 Token。使用 --token <token> 或设置 AI_TEAMS_AUTH_TOKEN 环境变量。");
      process.exit(1);
    }
    startServer(options).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
