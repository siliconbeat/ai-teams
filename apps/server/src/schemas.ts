import { parseLeaderToServerMessage, type LeaderToServerMessage } from "@ai-teams/shared";

export type RestTaskRequest = {
  atAgents?: unknown;
  prompt?: unknown;
  workspace?: unknown;
  timeoutSec?: unknown;
  cliConfig?: unknown;
  webhook?: unknown;
  webHook?: unknown;
  webhookUrl?: unknown;
  sessionId?: unknown;
};

export type WebhookEventType =
  | "task.started"
  | "task.output"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.timeout"
  | "queue.updated";

export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
  },
} as const;

const taskStatusSchema = {
  type: "string",
  enum: ["queued", "dispatched", "accepted", "running", "completed", "failed", "cancelled", "timeout"],
} as const;

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] } as const;
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

const taskCliConfigSchema = {
  type: "object",
  properties: {
    model: { type: "string" },
    permissionMode: { type: "string" },
    maxTurns: { type: "number" },
    systemPrompt: { type: "string" },
    appendSystemPrompt: { type: "string" },
    allowedTools: { type: "array", items: { type: "string" } },
    disallowedTools: { type: "array", items: { type: "string" } },
    extraArgs: { type: "array", items: { type: "string" } },
  },
} as const;

export const taskRecordSchema = {
  type: "object",
  required: [
    "id",
    "leaderCommandId",
    "employeeId",
    "sessionId",
    "targetMode",
    "prompt",
    "workspace",
    "timeoutSec",
    "cliConfig",
    "priority",
    "requiredLabels",
    "status",
    "createdAt",
    "startedAt",
    "finishedAt",
    "exitCode",
    "summary",
    "error",
    "durationMs",
    "durationApiMs",
    "numTurns",
    "totalCostUsd",
    "usageInputTokens",
    "usageOutputTokens",
    "usageCacheReadTokens",
    "usageCacheCreationTokens",
  ],
  properties: {
    id: { type: "string" },
    leaderCommandId: { type: "string" },
    employeeId: nullableString,
    sessionId: nullableString,
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"] },
    prompt: { type: "string" },
    workspace: nullableString,
    timeoutSec: { type: "number" },
    cliConfig: { anyOf: [taskCliConfigSchema, { type: "null" }] },
    priority: { type: "integer", minimum: 0, maximum: 3 },
    requiredLabels: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    status: taskStatusSchema,
    createdAt: { type: "string", format: "date-time" },
    startedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    finishedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    exitCode: nullableNumber,
    summary: nullableString,
    error: nullableString,
    durationMs: nullableNumber,
    durationApiMs: nullableNumber,
    numTurns: nullableNumber,
    totalCostUsd: nullableNumber,
    usageInputTokens: nullableNumber,
    usageOutputTokens: nullableNumber,
    usageCacheReadTokens: nullableNumber,
    usageCacheCreationTokens: nullableNumber,
  },
} as const;

const employeeSnapshotSchema = {
  type: "object",
  required: [
    "id",
    "name",
    "machineId",
    "hostname",
    "labels",
    "status",
    "mainTaskId",
    "mainTaskPrompt",
    "queueTaskId",
    "queueTaskPrompt",
    "lastSeenAt",
    "consecutiveQueueFailures",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    machineId: { type: "string" },
    hostname: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["online", "offline"] },
    mainTaskId: { anyOf: [{ type: "string" }, { type: "null" }] },
    mainTaskPrompt: { anyOf: [{ type: "string" }, { type: "null" }] },
    queueTaskId: { anyOf: [{ type: "string" }, { type: "null" }] },
    queueTaskPrompt: { anyOf: [{ type: "string" }, { type: "null" }] },
    lastSeenAt: { type: "string", format: "date-time" },
    consecutiveQueueFailures: { type: "number" },
  },
} as const;

const taskOutputChunkSchema = {
  type: "object",
  required: ["taskId", "employeeId", "stream", "seq", "content", "createdAt"],
  properties: {
    taskId: { type: "string" },
    employeeId: { type: "string" },
    stream: { type: "string", enum: ["stdout", "stderr"] },
    seq: { type: "number" },
    content: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const snapshotSchema = {
  type: "object",
  required: ["employees", "tasks", "logs"],
  properties: {
    employees: { type: "array", items: employeeSnapshotSchema },
    tasks: { type: "array", items: taskRecordSchema },
    logs: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: taskOutputChunkSchema,
      },
    },
  },
} as const;

export const restTaskRequestSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    atAgents: {
      anyOf: [
        { type: "string", enum: ["queue", "all"] },
        { type: "array", items: { type: "string" }, minItems: 1 },
      ],
      default: "queue",
    },
    prompt: { type: "string", minLength: 1 },
    workspace: { type: "string" },
    timeoutSec: { type: "number", minimum: 1 },
    priority: { type: "integer", minimum: 0, maximum: 3 },
    requiredLabels: { type: "array", items: { type: "string" } },
    cliConfig: taskCliConfigSchema,
    webhook: {
      anyOf: [
        { type: "string", format: "uri" },
        {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
          },
        },
      ],
    },
    webHook: {
      anyOf: [{ type: "string", format: "uri" }, { type: "object", required: ["url"], properties: { url: { type: "string" } } }],
    },
    webhookUrl: { type: "string", format: "uri" },
    sessionId: { type: "string" },
  },
} as const;

export const restTaskAcceptedSchema = {
  type: "object",
  required: ["status", "leaderCommandId", "tasks"],
  properties: {
    status: { type: "string", enum: ["accepted"] },
    leaderCommandId: { type: "string" },
    tasks: { type: "array", items: taskRecordSchema },
  },
} as const;

const sessionHistoryMessageSchema = {
  type: "object",
  required: ["type", "role", "taskId", "content", "createdAt"],
  properties: {
    type: { type: "string", enum: ["task.prompt", "task.output", "task.result"] },
    role: { type: "string", enum: ["user", "assistant", "system"] },
    taskId: { type: "string" },
    stream: { type: "string", enum: ["stdout", "stderr"] },
    seq: { type: "number" },
    content: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const sessionHistorySchema = {
  type: "object",
  required: ["sessionId", "tasks", "messages"],
  properties: {
    sessionId: { type: "string" },
    tasks: { type: "array", items: taskRecordSchema },
    messages: { type: "array", items: sessionHistoryMessageSchema },
  },
} as const;

export const taskListQuerySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["queued", "dispatched", "accepted", "running", "completed", "failed", "cancelled", "timeout"] },
    employeeId: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 100 },
    offset: { type: "number", minimum: 0 },
  },
} as const;

export const taskListResponseSchema = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: { type: "array", items: taskRecordSchema },
  },
} as const;

export const taskOutputResponseSchema = {
  type: "object",
  required: ["taskId", "output"],
  properties: {
    taskId: { type: "string" },
    output: { type: "string" },
  },
} as const;

export const taskPatchSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["cancelled"] },
    timeoutSec: { type: "number", minimum: 1 },
    cliConfig: taskCliConfigSchema,
  },
} as const;

export const claudeSessionItemSchema = {
  type: "object",
  required: ["id", "sizeBytes", "modifiedAt", "lineCount"],
  properties: {
    id: { type: "string" },
    sizeBytes: { type: "number" },
    modifiedAt: { type: "string", format: "date-time" },
    lineCount: { type: "number" },
    firstUserMessage: nullableString,
    latestUserMessage: nullableString,
  },
} as const;

export const claudeSessionsResponseSchema = {
  type: "object",
  required: ["employeeId", "workspace", "sessions"],
  properties: {
    employeeId: { type: "string" },
    workspace: nullableString,
    activeSessionId: nullableString,
    sessions: { type: "array", items: claudeSessionItemSchema },
  },
} as const;

export function parseRestTaskRequest(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const request = body as RestTaskRequest;
  const command = parseLeaderToServerMessage({
    type: "command.dispatch",
    atAgents: request.atAgents ?? "queue",
    prompt: request.prompt,
    workspace: request.workspace,
    timeoutSec: request.timeoutSec,
    sessionId: request.sessionId,
  });

  const webhookUrl = parseWebhookUrl(request.webhook ?? request.webHook ?? request.webhookUrl);
  return {
    command: command as Extract<LeaderToServerMessage, { type: "command.dispatch" }>,
    webhookUrl,
    cliConfig: request.cliConfig ?? undefined,
    priority: typeof request.priority === "number" ? request.priority : undefined,
    requiredLabels: Array.isArray(request.requiredLabels) ? request.requiredLabels : undefined,
  };
}

function parseWebhookUrl(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const rawUrl =
    typeof value === "string"
      ? value
      : typeof value === "object" && !Array.isArray(value) && typeof (value as { url?: unknown }).url === "string"
        ? (value as { url: string }).url
        : null;
  if (!rawUrl) {
    throw new Error("webhook must be a URL string or an object with a url string.");
  }

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("webhook URL must use http or https.");
  }
  return url.toString();
}

// ── Schedules ──────────────────────────────────────────────────────────────

export type CreateScheduleRequest = {
  name: string;
  cron: string;
  enabled?: boolean;
  targetMode?: "queue" | "direct" | "broadcast";
  targetAgents?: string[];
  prompt: string;
  workspace?: string;
  timeoutSec?: number;
  priority?: number;
  requiredLabels?: string[];
};

export type UpdateScheduleRequest = Partial<CreateScheduleRequest>;

export const createScheduleRequestSchema = {
  type: "object",
  required: ["name", "cron", "prompt"],
  properties: {
    name: { type: "string", minLength: 1 },
    cron: { type: "string", minLength: 9 },
    enabled: { type: "boolean", default: true },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"], default: "queue" },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string", minLength: 1 },
    workspace: { type: "string" },
    timeoutSec: { type: "number", minimum: 1 },
    priority: { type: "integer", minimum: 0, maximum: 3, default: 0 },
    requiredLabels: { type: "array", items: { type: "string" } },
  },
} as const;

export const updateScheduleRequestSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    cron: { type: "string", minLength: 9 },
    enabled: { type: "boolean" },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"] },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string", minLength: 1 },
    workspace: { type: "string" },
    timeoutSec: { type: "number", minimum: 1 },
    priority: { type: "integer", minimum: 0, maximum: 3 },
    requiredLabels: { type: "array", items: { type: "string" } },
  },
} as const;

export const scheduleResponseSchema = {
  type: "object",
  required: ["id", "name", "cron", "enabled", "targetMode", "prompt", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    cron: { type: "string" },
    enabled: { type: "boolean" },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"] },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string" },
    workspace: nullableString,
    timeoutSec: nullableNumber,
    priority: { type: "integer" },
    requiredLabels: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    lastRunAt: nullableString,
    nextRunAt: nullableString,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

export const scheduleListResponseSchema = {
  type: "object",
  required: ["schedules"],
  properties: {
    schedules: { type: "array", items: scheduleResponseSchema },
  },
} as const;
