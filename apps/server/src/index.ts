import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
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
import { createDatabaseFromEnv, initDb, hydrateState, type Database, queryTasks, getTaskById, deleteTask, updateTaskFields, dbRowToTask, upsertSchedule, getAllSchedules, getScheduleById, deleteScheduleRow, updateScheduleFields, type ScheduleRecord } from "./db.js";
import { type RestTaskRequest, errorResponseSchema, snapshotSchema, sessionHistorySchema, restTaskRequestSchema, restTaskAcceptedSchema, taskListResponseSchema, taskRecordSchema, taskPatchSchema, parseRestTaskRequest, claudeSessionsResponseSchema, createScheduleRequestSchema, updateScheduleRequestSchema, scheduleResponseSchema, scheduleListResponseSchema, type CreateScheduleRequest, type UpdateScheduleRequest } from "./schemas.js";
import { createDispatch, nowIso, sendJson } from "./dispatch.js";
import type { DispatchContext } from "./dispatch.js";
import { createInMemoryStateStore } from "./state-store.js";
import { createEncryptor } from "./crypto.js";
import { startScheduleJob, stopScheduleJob, type ScheduleDispatchFn } from "./scheduler.js";

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
  logLevel?: string;
  logDir?: string;
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
  const state = createInMemoryStateStore();

  const db = await createDatabaseFromEnv({
    AI_TEAMS_AUTH_TOKEN: options.authToken,
    DATA_DIR: options.dataDir,
    DB_PATH: options.dbPath,
    DATABASE_URL: process.env.DATABASE_URL,
  });
  await initDb(db);
  await hydrateState(db, state, defaultTimeoutSec, maxLogChunksPerTask);

  const logLevel = options.logLevel || process.env.LOG_LEVEL || "info";
  const logDir = options.logDir || process.env.LOG_DIR;

  let loggerConfig: boolean | { level: string; transport?: unknown } = { level: logLevel };

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

  const app = Fastify({ logger: options.logger === false ? false : loggerConfig });
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

  const dispatchCtx: DispatchContext = {
    state,
    db,
    log: app.log,
    authToken: options.authToken,
    defaultTimeoutSec,
    maxLogChunksPerTask,
    disconnectGraceMs,
    encryptor: createEncryptor(process.env.AI_TEAMS_ENCRYPTION_KEY),
  };
  const { dispatchLeaderCommand, handleAgentMessage, handleLeaderMessage, cancelTaskById } = createDispatch(dispatchCtx);

  const scheduleDispatchFn: ScheduleDispatchFn = (message, webhookUrl, cliConfig, priority, requiredLabels) => {
    return dispatchLeaderCommand(message, webhookUrl, cliConfig, priority, requiredLabels);
  };

  async function onScheduleFire(scheduleId: string) {
    const now = new Date().toISOString();
    const job = state.scheduleJobs.get(scheduleId);
    const nextRun = job?.nextDate()?.toISO() ?? null;
    await updateScheduleFields(db, scheduleId, { lastRunAt: now, nextRunAt: nextRun });
  }

  async function loadAndStartSchedules() {
    const schedules = await getAllSchedules(db);
    for (const schedule of schedules) {
      if (schedule.enabled) {
        try {
          startScheduleJob(schedule, scheduleDispatchFn, state.scheduleJobs, onScheduleFire);
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

    const sessions = jsonlFiles.map((entry) => {
      const filePath = path.join(claudeProjectsDir, entry.name);
      const stat = fs.statSync(filePath);
      const sessionId = entry.name.replace(/\.jsonl$/, "");
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const lineCount = lines.length;

      let firstUserMessage: string | null = null;
      let latestUserMessage: string | null = null;
      for (const line of lines) {
        const msg = extractUserMessage(line);
        if (msg && !firstUserMessage) firstUserMessage = msg;
        if (msg) latestUserMessage = msg;
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

  const staticExts = new Set([".html", ".js", ".css", ".ico", ".png", ".jpg", ".svg", ".woff", ".woff2", ".ttf", ".map"]);

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
      return { schedules };
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
      return schedule;
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
          startScheduleJob(schedule, scheduleDispatchFn, state.scheduleJobs, onScheduleFire);
          schedule.nextRunAt = state.scheduleJobs.get(id)?.nextDate()?.toISO() ?? null;
        }
        await upsertSchedule(db, schedule);
        return reply.code(201).send(schedule);
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
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = await getScheduleById(db, request.params.scheduleId);
      if (!existing) return reply.code(404).send({ error: "Schedule not found." });
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
      stopScheduleJob(state.scheduleJobs, request.params.scheduleId);
      if (updated.enabled) {
        startScheduleJob(updated, scheduleDispatchFn, state.scheduleJobs, onScheduleFire);
        updated.nextRunAt = state.scheduleJobs.get(request.params.scheduleId)?.nextDate()?.toISO() ?? null;
        await updateScheduleFields(db, request.params.scheduleId, { nextRunAt: updated.nextRunAt });
      }
      return updated;
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
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
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
      return await getScheduleById(db, request.params.scheduleId);
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
        const decrypted = dispatchCtx.encryptor!.decrypt(raw.toString());
        const message = parseEmployeeToServerMessage(parseJsonMessage(decrypted));
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
        // Tasks will only stop via timeout or agent reporting back on reconnect.
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
      try {
        const decrypted = dispatchCtx.encryptor!.decrypt(raw.toString());
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
    logLevel: env.LOG_LEVEL,
    logDir: env.LOG_DIR,
  };
}

export async function startServer(options = readOptionsFromEnv()) {
  const server = await createAiTeamsServer(options);
  await server.app.listen({ port: options.port ?? DEFAULT_PORT, host: options.host ?? "0.0.0.0" });
  return server;
}

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
    const cliToken = getArgValue("--token");
    const cliPort = getArgValue("--port");
    const cliHost = getArgValue("--host");
    const cliDataDir = getArgValue("--data-dir");
    const cliDatabaseUrl = getArgValue("--database-url");
    const cliDbPath = getArgValue("--db-path");
    const cliLogLevel = getArgValue("--log-level");
    const cliLogDir = getArgValue("--log-dir");
    if (cliToken) process.env.AI_TEAMS_AUTH_TOKEN = cliToken;
    if (cliPort) process.env.AI_TEAMS_SERVER_PORT = cliPort;
    if (cliHost) process.env.HOST = cliHost;
    if (cliDataDir) process.env.DATA_DIR = cliDataDir;
    if (cliDatabaseUrl) process.env.DATABASE_URL = cliDatabaseUrl;
    if (cliDbPath) process.env.DB_PATH = cliDbPath;
    if (cliLogLevel) process.env.LOG_LEVEL = cliLogLevel;
    if (cliLogDir) process.env.LOG_DIR = cliLogDir;
  }

  const subcommand = args[0];
  if (subcommand === "start" || subcommand === "restart") {
    void (async () => {
      // For restart, stop first
      if (subcommand === "restart") {
        const status = getDaemonStatus(resolvePidFile());
        if (status.running) {
          await stopDaemon(resolvePidFile());
        }
      }

      applyCliArgsToEnv();
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
