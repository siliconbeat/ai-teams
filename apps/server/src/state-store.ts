import type { EmployeeSnapshot, TaskOutputChunk, TaskRecord } from "@ai-teams/shared";
import type WebSocket from "ws";

export type CronJobLike = { stop(): void; nextDate(): Date | null };

export interface StateStore {
  agentSockets: Map<string, WebSocket>;
  leaderSockets: Set<WebSocket>;
  employees: Map<string, EmployeeSnapshot>;
  tasks: Map<string, TaskRecord>;
  taskLogs: Map<string, TaskOutputChunk[]>;
  taskWebhooks: Map<string, string>;
  socketToEmployeeId: WeakMap<WebSocket, string>;
  taskTimeouts: Map<string, NodeJS.Timeout>;
  disconnectTimers: Map<string, NodeJS.Timeout>;
  heartbeatTimers: Map<string, NodeJS.Timeout>;
  taskQueues: Map<string, string[]>;
  mainTaskQueues: Map<string, string[]>;
  sharedTaskQueue: string[];
  scheduleJobs: Map<string, CronJobLike>;
  consecutiveQueueFailures: Map<string, number>;
  failureTimestamps: Map<string, number>;
  queuePausedSet: Set<string>;
}

export function createInMemoryStateStore(): StateStore {
  return {
    agentSockets: new Map(),
    leaderSockets: new Set(),
    employees: new Map(),
    tasks: new Map(),
    taskLogs: new Map(),
    taskWebhooks: new Map(),
    socketToEmployeeId: new WeakMap(),
    taskTimeouts: new Map(),
    disconnectTimers: new Map(),
    heartbeatTimers: new Map(),
    taskQueues: new Map(),
    mainTaskQueues: new Map(),
    sharedTaskQueue: [],
    scheduleJobs: new Map(),
    consecutiveQueueFailures: new Map(),
    failureTimestamps: new Map(),
    queuePausedSet: new Set(),
  };
}
