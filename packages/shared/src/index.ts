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

export const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timeout"]);

export type AgentTarget = "queue" | "all" | string[];
export type TaskTargetMode = "queue" | "direct" | "broadcast";
export type MissionStatus =
  | "created"
  | "planning"
  | "dispatching"
  | "waiting_agents"
  | "reviewing"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";
export type MissionApprovalPolicy = "auto" | "ask_on_risky_change" | "manual_each_iteration";
export type MissionApprovalStatus = "pending" | "approved" | "rejected";

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
  consecutiveQueueFailures: number;
  queuePaused?: boolean;
  version?: string;
  claudeVersion?: string;
  permissionMode?: string;
  weight: number;
}

export type AgentRegistrationStatus = "pending" | "approved";

export interface AgentRegistrationRecord {
  employeeId: string;
  name: string;
  machineId: string | null;
  hostname: string | null;
  labels: string[];
  status: AgentRegistrationStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
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
  retryCount: number;
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
  delta?: boolean;
}

export interface MissionRecord {
  id: string;
  objective: string;
  workspace: string | null;
  status: MissionStatus;
  approvalPolicy: MissionApprovalPolicy;
  maxIterations: number;
  maxTasks: number;
  currentIteration: number;
  timeoutSec: number | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MissionEventRecord {
  id: string;
  missionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MissionSubtaskRecord {
  missionId: string;
  taskId: string;
  iteration: number;
  role: string;
  createdAt: string;
}

export interface MissionApprovalRecord {
  id: string;
  missionId: string;
  status: MissionApprovalStatus;
  question: string;
  options: string[];
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StateSnapshot {
  employees: EmployeeSnapshot[];
  tasks: TaskRecord[];
  logs: Record<string, TaskOutputChunk[]>;
  serverVersion?: string;
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
      sessionId?: string;
    }
  | { type: "task.cancel"; taskId: string }
  | { type: "queue.resume" }
  | { type: "agent.registered"; consecutiveQueueFailures: number }
  | { type: "session.reset" }
  | { type: "server.error"; code: string; message: string };

export type EmployeeToServerMessage =
  | {
      type: "agent.register";
      employeeId: string;
      agentToken?: string;
      name: string;
      machineId: string;
      hostname: string;
      labels: string[];
      version?: string;
      claudeVersion?: string;
      permissionMode?: string;
      activeMainTaskId?: string | null;
      activeQueueTaskId?: string | null;
      lastOutputSeq?: number;
      weight?: number;
    }
  | { type: "agent.heartbeat"; employeeId: string }
  | { type: "agent.request_task"; employeeId: string }
  | { type: "task.accepted"; taskId: string }
  | { type: "task.started"; taskId: string; pid: number; sessionId?: string | null; claudeVersion?: string }
  | { type: "task.output"; taskId: string; stream: "stdout" | "stderr"; seq: number; content: string; delta?: boolean }
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
  | { type: "task.cancelled"; taskId: string }
  | { type: "session.reset.ack"; employeeId: string };

export type LeaderToServerMessage =
  | {
      type: "command.dispatch";
      atAgents: AgentTarget;
      prompt: string;
      workspace?: string;
      timeoutSec?: number;
      priority?: number;
      requiredLabels?: string[];
      sessionId?: string;
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
  | { type: "employee.delete"; employeeId: string }
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
    serverVersion: undefined,
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
    const sessionId = optionalStringField(message, "sessionId");
    return {
      type,
      atAgents: agentTargetField(message, "atAgents"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: optionalStringField(message, "workspace"),
      timeoutSec: optionalPositiveNumberField(message, "timeoutSec"),
      priority: optionalNonNegativeNumberField(message, "priority"),
      requiredLabels: optionalStringArrayField(message, "requiredLabels"),
      ...(sessionId !== undefined ? { sessionId } : {}),
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
      agentToken: optionalStringField(message, "agentToken"),
      name: nonEmptyStringField(message, "name"),
      machineId: nonEmptyStringField(message, "machineId"),
      hostname: nonEmptyStringField(message, "hostname"),
      labels: stringArrayField(message, "labels"),
      version: optionalStringField(message, "version"),
      claudeVersion: optionalStringField(message, "claudeVersion"),
      permissionMode: optionalStringField(message, "permissionMode"),
      activeMainTaskId: optionalNullableStringField(message, "activeMainTaskId"),
      activeQueueTaskId: optionalNullableStringField(message, "activeQueueTaskId"),
      lastOutputSeq: optionalNonNegativeNumberField(message, "lastOutputSeq"),
      weight: optionalNonNegativeNumberField(message, "weight"),
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
      claudeVersion: optionalStringField(message, "claudeVersion"),
    };
  }

  if (type === "task.output") {
    const stream = stringField(message, "stream");
    if (stream !== "stdout" && stream !== "stderr") {
      throw new ProtocolError("task.output.stream must be stdout or stderr.");
    }
    const delta = message.delta === true;
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      stream,
      seq: positiveIntegerField(message, "seq"),
      content: stringField(message, "content"),
      ...(delta ? { delta: true } : {}),
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

  if (type === "session.reset.ack") {
    return { type, employeeId: nonEmptyStringField(message, "employeeId") };
  }

  throw new ProtocolError(`Unsupported employee message type: ${type}`);
}

export function parseServerToEmployeeMessage(value: unknown): ServerToEmployeeMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (type === "task.dispatch") {
    const sessionId = optionalStringField(message, "sessionId");
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
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  if (type === "task.cancel") {
    return { type, taskId: nonEmptyStringField(message, "taskId") };
  }

  if (type === "queue.resume") {
    return { type };
  }

  if (type === "agent.registered") {
    return { type, consecutiveQueueFailures: nonNegativeNumberField(message, "consecutiveQueueFailures") };
  }

  if (type === "session.reset") {
    return { type };
  }

  if (type === "server.error") {
    return {
      type,
      code: nonEmptyStringField(message, "code"),
      message: nonEmptyStringField(message, "message"),
    };
  }

  throw new ProtocolError(`Unsupported server-to-employee message type: ${type}`);
}

export function parseServerToLeaderMessage(value: unknown): ServerToLeaderMessage {
  const message = objectValue(value, "message");
  const type = stringField(message, "type");

  if (
    type === "snapshot" ||
    type === "employee.upsert" ||
    type === "employee.delete" ||
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

function optionalStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
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

const SAFE_ARG_RE = /^[a-zA-Z0-9_\-.:\/]+$/;
const MAX_PROMPT_LEN = 1024 * 1024; // 1 MB

function validateStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${fieldName} must be an array.`);
  for (const item of value) {
    if (typeof item !== "string") throw new ProtocolError(`${fieldName} must contain only strings.`);
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
  const obj = value as Record<string, unknown>;
  const result: TaskCliConfig = {};
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string") throw new ProtocolError("cliConfig.model must be a string.");
    result.model = obj.model;
  }
  if (obj.permissionMode !== undefined) {
    if (typeof obj.permissionMode !== "string") throw new ProtocolError("cliConfig.permissionMode must be a string.");
    result.permissionMode = obj.permissionMode;
  }
  if (obj.maxTurns !== undefined) {
    if (typeof obj.maxTurns !== "number" || obj.maxTurns < 1) throw new ProtocolError("cliConfig.maxTurns must be a positive number.");
    result.maxTurns = obj.maxTurns;
  }
  if (obj.systemPrompt !== undefined) {
    if (typeof obj.systemPrompt !== "string") throw new ProtocolError("cliConfig.systemPrompt must be a string.");
    result.systemPrompt = obj.systemPrompt;
  }
  if (obj.appendSystemPrompt !== undefined) {
    if (typeof obj.appendSystemPrompt !== "string") throw new ProtocolError("cliConfig.appendSystemPrompt must be a string.");
    result.appendSystemPrompt = obj.appendSystemPrompt;
  }
  if (obj.allowedTools !== undefined) {
    result.allowedTools = validateStringArray(obj.allowedTools, "cliConfig.allowedTools");
  }
  if (obj.disallowedTools !== undefined) {
    result.disallowedTools = validateStringArray(obj.disallowedTools, "cliConfig.disallowedTools");
  }
  if (obj.extraArgs !== undefined) {
    const args = validateStringArray(obj.extraArgs, "cliConfig.extraArgs");
    for (const arg of args) {
      if (!SAFE_ARG_RE.test(arg)) {
        throw new ProtocolError(`cliConfig.extraArgs contains invalid argument: ${arg.slice(0, 50)}`);
      }
    }
    result.extraArgs = args;
  }
  return result;
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
