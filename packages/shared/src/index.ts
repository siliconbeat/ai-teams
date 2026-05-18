export type EmployeeStatus = "online" | "offline";

export type TaskStatus =
  | "queued"
  | "dispatched"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type AgentTarget = "queue" | "all" | string[];
export type TaskTargetMode = "queue" | "direct" | "broadcast";

export interface TaskCliConfig {
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraArgs?: string[];
}

export interface EmployeeSnapshot {
  id: string;
  name: string;
  machineId: string;
  hostname: string;
  labels: string[];
  status: EmployeeStatus;
  mainTaskId: string | null;
  mainTaskPrompt: string | null;
  queueTaskId: string | null;
  queueTaskPrompt: string | null;
  lastSeenAt: string;
}

export interface TaskRecord {
  id: string;
  leaderCommandId: string;
  employeeId: string | null;
  sessionId: string | null;
  targetMode: TaskTargetMode;
  prompt: string;
  workspace: string | null;
  timeoutSec: number;
  cliConfig: TaskCliConfig | null;
  priority: number;
  requiredLabels: string[] | null;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  totalCostUsd: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  usageCacheReadTokens: number | null;
  usageCacheCreationTokens: number | null;
}

export interface TaskOutputChunk {
  taskId: string;
  employeeId: string;
  stream: "stdout" | "stderr";
  seq: number;
  content: string;
  createdAt: string;
}

export interface StateSnapshot {
  employees: EmployeeSnapshot[];
  tasks: TaskRecord[];
  logs: Record<string, TaskOutputChunk[]>;
}

export type ServerToEmployeeMessage =
  | {
      type: "task.dispatch";
      taskId: string;
      leaderCommandId: string;
      employeeId: string;
      targetMode: TaskTargetMode;
      prompt: string;
      workspace: string | null;
      timeoutSec: number;
      cliConfig: TaskCliConfig | null;
    }
  | { type: "task.cancel"; taskId: string };

export type EmployeeToServerMessage =
  | {
      type: "agent.register";
      employeeId: string;
      name: string;
      machineId: string;
      hostname: string;
      labels: string[];
      activeMainTaskId?: string | null;
      activeQueueTaskId?: string | null;
      lastOutputSeq?: number;
    }
  | { type: "agent.heartbeat"; employeeId: string }
  | { type: "agent.request_task"; employeeId: string }
  | { type: "task.accepted"; taskId: string }
  | { type: "task.started"; taskId: string; pid: number; sessionId?: string | null }
  | { type: "task.output"; taskId: string; stream: "stdout" | "stderr"; seq: number; content: string }
  | {
      type: "task.completed";
      taskId: string;
      exitCode: number;
      summary?: string;
      durationMs?: number | null;
      durationApiMs?: number | null;
      numTurns?: number | null;
      totalCostUsd?: number | null;
      usageInputTokens?: number | null;
      usageOutputTokens?: number | null;
      usageCacheReadTokens?: number | null;
      usageCacheCreationTokens?: number | null;
    }
  | { type: "task.failed"; taskId: string; error: string }
  | { type: "task.cancelled"; taskId: string };

export type LeaderToServerMessage =
  | {
      type: "command.dispatch";
      atAgents: AgentTarget;
      prompt: string;
      workspace?: string;
      timeoutSec?: number;
      priority?: number;
      requiredLabels?: string[];
    }
  | {
      type: "command.send";
      employeeId: string;
      prompt: string;
      workspace?: string;
      timeoutSec?: number;
    }
  | {
      type: "command.broadcast";
      prompt: string;
      workspace?: string;
      timeoutSec?: number;
    }
  | { type: "task.cancel"; taskId: string };

export type ServerToLeaderMessage =
  | { type: "snapshot"; snapshot: StateSnapshot }
  | { type: "employee.upsert"; employee: EmployeeSnapshot }
  | { type: "task.upsert"; task: TaskRecord }
  | { type: "task.output"; chunk: TaskOutputChunk }
  | { type: "server.error"; code: string; message: string }
  | { type: "command.error"; code: string; message: string; leaderCommandId?: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function createEmptySnapshot(): StateSnapshot {
  return {
    employees: [],
    tasks: [],
    logs: {},
  };
}

export function parseJsonMessage(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProtocolError("Message is not valid JSON.");
  }
}

export function parseLeaderToServerMessage(value: unknown): LeaderToServerMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (type === "command.dispatch") {
    return {
      type,
      atAgents: agentTargetField(message, "atAgents"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: optionalStringField(message, "workspace"),
      timeoutSec: optionalPositiveNumberField(message, "timeoutSec"),
    };
  }

  if (type === "command.send") {
    return {
      type,
      employeeId: nonEmptyStringField(message, "employeeId"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: optionalStringField(message, "workspace"),
      timeoutSec: optionalPositiveNumberField(message, "timeoutSec"),
    };
  }

  if (type === "command.broadcast") {
    return {
      type,
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: optionalStringField(message, "workspace"),
      timeoutSec: optionalPositiveNumberField(message, "timeoutSec"),
    };
  }

  if (type === "task.cancel") {
    return { type, taskId: nonEmptyStringField(message, "taskId") };
  }

  throw new ProtocolError(`Unsupported leader message type: ${type}`);
}

export function parseEmployeeToServerMessage(value: unknown): EmployeeToServerMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (type === "agent.register") {
    return {
      type,
      employeeId: nonEmptyStringField(message, "employeeId"),
      name: nonEmptyStringField(message, "name"),
      machineId: nonEmptyStringField(message, "machineId"),
      hostname: nonEmptyStringField(message, "hostname"),
      labels: stringArrayField(message, "labels"),
      activeMainTaskId: optionalNullableStringField(message, "activeMainTaskId"),
      activeQueueTaskId: optionalNullableStringField(message, "activeQueueTaskId"),
      lastOutputSeq: optionalNonNegativeNumberField(message, "lastOutputSeq"),
    };
  }

  if (type === "agent.heartbeat") {
    return { type, employeeId: nonEmptyStringField(message, "employeeId") };
  }

  if (type === "agent.request_task") {
    return { type, employeeId: nonEmptyStringField(message, "employeeId") };
  }

  if (type === "task.accepted" || type === "task.cancelled") {
    return { type, taskId: nonEmptyStringField(message, "taskId") };
  }

  if (type === "task.started") {
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      pid: nonNegativeNumberField(message, "pid"),
      sessionId: optionalNullableStringField(message, "sessionId"),
    };
  }

  if (type === "task.output") {
    const stream = stringField(message, "stream");
    if (stream !== "stdout" && stream !== "stderr") {
      throw new ProtocolError("task.output.stream must be stdout or stderr.");
    }
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      stream,
      seq: positiveIntegerField(message, "seq"),
      content: stringField(message, "content"),
    };
  }

  if (type === "task.completed") {
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      exitCode: nonNegativeNumberField(message, "exitCode"),
      summary: optionalStringField(message, "summary"),
      durationMs: optionalNonNegativeNumberField(message, "durationMs"),
      durationApiMs: optionalNonNegativeNumberField(message, "durationApiMs"),
      numTurns: optionalNonNegativeNumberField(message, "numTurns"),
      totalCostUsd: optionalNonNegativeNumberField(message, "totalCostUsd"),
      usageInputTokens: optionalNonNegativeNumberField(message, "usageInputTokens"),
      usageOutputTokens: optionalNonNegativeNumberField(message, "usageOutputTokens"),
      usageCacheReadTokens: optionalNonNegativeNumberField(message, "usageCacheReadTokens"),
      usageCacheCreationTokens: optionalNonNegativeNumberField(message, "usageCacheCreationTokens"),
    };
  }

  if (type === "task.failed") {
    return { type, taskId: nonEmptyStringField(message, "taskId"), error: nonEmptyStringField(message, "error") };
  }

  throw new ProtocolError(`Unsupported employee message type: ${type}`);
}

export function parseServerToEmployeeMessage(value: unknown): ServerToEmployeeMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (type === "task.dispatch") {
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      leaderCommandId: nonEmptyStringField(message, "leaderCommandId"),
      employeeId: nonEmptyStringField(message, "employeeId"),
      targetMode: taskTargetModeField(message, "targetMode"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: nullableStringField(message, "workspace"),
      timeoutSec: positiveNumberField(message, "timeoutSec"),
      cliConfig: optionalCliConfigField(message, "cliConfig"),
    };
  }

  if (type === "task.cancel") {
    return { type, taskId: nonEmptyStringField(message, "taskId") };
  }

  throw new ProtocolError(`Unsupported server-to-employee message type: ${type}`);
}

export function parseServerToLeaderMessage(value: unknown): ServerToLeaderMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (
    type === "snapshot" ||
    type === "employee.upsert" ||
    type === "task.upsert" ||
    type === "task.output"
  ) {
    return message as ServerToLeaderMessage;
  }

  if (type === "server.error" || type === "command.error") {
    return {
      type,
      code: nonEmptyStringField(message, "code"),
      message: nonEmptyStringField(message, "message"),
      leaderCommandId: optionalStringField(message, "leaderCommandId"),
    } as ServerToLeaderMessage;
  }

  throw new ProtocolError(`Unsupported server-to-leader message type: ${type}`);
}

export function resolveAtAgentsFromPrompt(
  prompt: string,
  employees: Array<Pick<EmployeeSnapshot, "id" | "name">>,
  selected: AgentTarget = "queue",
): { atAgents: AgentTarget; prompt: string; matchedMentions: string[]; unknownMentions: string[] } {
  const selectedIds = selected === "all" || selected === "queue" ? [] : [...selected];
  const matchedIds = new Set<string>(selectedIds);
  const matchedMentions: string[] = [];
  const unknownMentions: string[] = [];

  const employeeByMention = new Map<string, string>();
  for (const employee of employees) {
    employeeByMention.set(employee.id.toLowerCase(), employee.id);
    employeeByMention.set(employee.name.toLowerCase(), employee.id);
  }

  const cleanedPrompt = prompt.replace(/@([A-Za-z0-9_-]+)/g, (token, mention: string) => {
    const employeeId = employeeByMention.get(mention.toLowerCase());
    if (!employeeId) {
      unknownMentions.push(mention);
      return token;
    }
    matchedIds.add(employeeId);
    matchedMentions.push(mention);
    return "";
  }).replace(/\s+/g, " ").trim();

  if (selected === "all") {
    return {
      atAgents: "all",
      prompt: cleanedPrompt || prompt.trim(),
      matchedMentions,
      unknownMentions,
    };
  }

  if (matchedIds.size > 0) {
    return {
      atAgents: [...matchedIds],
      prompt: cleanedPrompt || prompt.trim(),
      matchedMentions,
      unknownMentions,
    };
  }

  return {
    atAgents: "queue",
    prompt: prompt.trim(),
    matchedMentions,
    unknownMentions,
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ProtocolError(`${key} must be a string.`);
  }
  return value;
}

function nonEmptyStringField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key).trim();
  if (!value) {
    throw new ProtocolError(`${key} must not be empty.`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProtocolError(`${key} must be a string.`);
  }
  return value;
}

function optionalNullableStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new ProtocolError(`${key} must be a string or null.`);
  }
  return value;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ProtocolError(`${key} must be a string or null.`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProtocolError(`${key} must be a string array.`);
  }
  return value;
}

function agentTargetField(record: Record<string, unknown>, key: string): AgentTarget {
  const value = record[key];
  if (value === "queue") {
    return "queue";
  }
  if (value === "all") {
    return "all";
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ProtocolError(`${key} must be "queue", "all", or a non-empty string array.`);
  }
  return value.map((item) => item.trim());
}

function taskTargetModeField(record: Record<string, unknown>, key: string): TaskTargetMode {
  const value = record[key];
  if (value === "queue" || value === "direct" || value === "broadcast") {
    return value;
  }
  throw new ProtocolError(`${key} must be queue, direct, or broadcast.`);
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProtocolError(`${key} must be a positive number.`);
  }
  return value;
}

function optionalPositiveNumberField(record: Record<string, unknown>, key: string): number | undefined {
  if (record[key] === undefined) {
    return undefined;
  }
  return positiveNumberField(record, key);
}

function nonNegativeNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`${key} must be a non-negative number.`);
  }
  return value;
}

function optionalNonNegativeNumberField(record: Record<string, unknown>, key: string): number | undefined {
  if (record[key] === undefined) {
    return undefined;
  }
  return nonNegativeNumberField(record, key);
}

function positiveIntegerField(record: Record<string, unknown>, key: string): number {
  const value = positiveNumberField(record, key);
  if (!Number.isInteger(value)) {
    throw new ProtocolError(`${key} must be an integer.`);
  }
  return value;
}

function optionalCliConfigField(record: Record<string, unknown>, key: string): TaskCliConfig | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${key} must be an object or null.`);
  }
  return value as TaskCliConfig;
}

// ---------------------------------------------------------------------------
// E2E Encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  encrypted: true;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).encrypted === true &&
    typeof (value as Record<string, unknown>).iv === "string" &&
    typeof (value as Record<string, unknown>).ciphertext === "string" &&
    typeof (value as Record<string, unknown>).tag === "string"
  );
}

export function parseEncryptionKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("AI_TEAMS_ENCRYPTION_KEY must be 32 bytes (64 hex characters).");
  }
  return key;
}
