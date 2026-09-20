import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { EmployeeToServerMessage, ServerToEmployeeMessage, TaskRecord } from "@ai-teams/shared";
import { SqliteDatabase, initDb, hydrateState, upsertAgentRegistration, getTaskLogsByTaskId } from "./db.js";
import { createInMemoryStateStore } from "./state-store.js";
import { createDispatch } from "./dispatch.js";
import { nextQueueRecovery } from "./queue-recovery.js";

let db: SqliteDatabase;
let state: ReturnType<typeof createInMemoryStateStore>;
let dispatch: ReturnType<typeof createDispatch>;
const wires = new Map<string, { socket: WebSocket; messages: ServerToEmployeeMessage[] }>();

function startDispatcher() {
  dispatch = createDispatch({ state, db, authToken: "test", defaultTimeoutSec: 36000,
    disconnectGraceMs: 15000, runningDisconnectGraceMs: 120000,
    maxLogChunksPerTask: 400, maxRuntimeTasks: 500, hashAgentToken: t => t,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyInstance["log"] });
}

async function register(id = "alice", activeQueueTaskId?: string, pendingTaskIds?: string[]) {
  const messages: ServerToEmployeeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, send: (raw: string) => messages.push(JSON.parse(raw)), close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
  wires.set(id, { socket, messages });
  await upsertAgentRegistration(db, { employeeId: id, name: id, machineId: id, hostname: id, labels: [], status: "approved", tokenHash: "test" });
  await dispatch.handleAgentMessage({ type: "agent.register", employeeId: id, name: id, machineId: id, hostname: id, labels: [], agentToken: "test", activeQueueTaskId, pendingTaskIds }, socket);
  return socket;
}

function submit() {
  const result = dispatch.dispatchLeaderCommand({ type: "command.dispatch", atAgents: "queue", prompt: "isolated simulated task" });
  if (!result.ok) throw Error(result.message);
  return result.tasks[0]!;
}

async function send(task: TaskRecord, message: Omit<Extract<EmployeeToServerMessage, { type: "task.failed" }>, "taskId">) {
  const socket = wires.get(task.employeeId!)!.socket;
  await dispatch.handleAgentMessage({ type: "task.started", taskId: task.id, attempt: task.attempt, pid: 1 }, socket);
  await dispatch.handleAgentMessage({ ...message, taskId: task.id, attempt: task.attempt }, socket);
}

async function advance(ms: number) {
  // Real heartbeats continue during model cooldown; no real model or minute waits.
  for (let left = ms; left > 0; left -= 10000) {
    for (const [employeeId, wire] of wires) await dispatch.handleAgentMessage({ type: "agent.heartbeat", employeeId }, wire.socket);
    await vi.advanceTimersByTimeAsync(Math.min(left, 10000));
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  wires.clear();
  db = new SqliteDatabase(new DatabaseSync(":memory:"));
  await initDb(db);
  state = createInMemoryStateStore();
  startDispatcher();
  await register();
});

afterEach(async () => {
  dispatch.cleanup();
  await dispatch.drainTaskWrites();
  await db.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("queue recovery with real dispatcher and SQLite", () => {
  it("five unknown failures wake automatically, reset the Agent latch before one probe, then resume after success", async () => {
    let task = submit();
    for (let i = 0; i < 5; i++) {
      if (task.status === "failed") task = submit();
      await send(task, { type: "task.failed", error: "CLI failed" });
    }
    const employee = state.employees.get("alice")!;
    expect(employee.consecutiveQueueFailures).toBe(5);
    expect(employee.queueRecovery).toMatchObject({ phase: "cooldown", failures: 1, until: Date.now() + 60000 });
    const other = submit();
    await advance(59999);
    expect(employee.queueTaskId).toBeNull();
    await advance(1);
    expect(task.status).toBe("dispatched");
    expect(other.status).toBe("queued");
    const messages = wires.get("alice")!.messages;
    expect(messages.slice(-2).map(m => m.type)).toEqual(["queue.resume", "task.dispatch"]);
    await dispatch.handleAgentMessage({ type: "task.completed", taskId: task.id, attempt: task.attempt, exitCode: 0 }, wires.get("alice")!.socket);
    expect(employee.queueRecovery).toBeUndefined();
    expect(employee.consecutiveQueueFailures).toBe(0);
    expect(other.status).toBe("dispatched");
  });

  it("transient errors back off, respect Retry-After and allow only one global probe", async () => {
    await register("bob");
    const task = submit();
    await send(task, { type: "task.failed", error: "429 rate limit", recoverable: true, retryAfterMs: 90000 });
    const other = submit();
    expect(other.status).toBe("queued");
    await advance(90000);
    expect(task.status).toBe("dispatched");
    expect(other.status).toBe("queued");
    await send(task, { type: "task.failed", error: "529 overloaded", recoverable: true });
    expect(state.employees.get("alice")!.queueRecovery).toMatchObject({ phase: "cooldown", failures: 2, until: Date.now() + 120000 });
    await advance(120000);
    expect([task, other].filter(t => t.status === "dispatched")).toHaveLength(1);
    expect(state.employees.get("alice")!.status).toBe("online");
  });

  it("manual pause never auto-resumes; authenticated resume path requests a bounded probe", async () => {
    const task = submit();
    await send(task, { type: "task.failed", error: "429", recoverable: true });
    dispatch.pauseAgentQueue("alice");
    await advance(600000);
    expect(task.status).toBe("queued");
    expect(state.employees.get("alice")!.queuePaused).toBe(true);
    dispatch.resumeAgentQueue("alice");
    expect(task.status).toBe("dispatched");
    expect(state.employees.get("alice")!.queueRecovery?.phase).toBe("probe");
  });

  it("permanent authentication failure terminates the task and requires manual intervention", async () => {
    const task = submit();
    await send(task, { type: "task.failed", error: "API 401 Unauthorized upstream", recoverable: true });
    expect(task.status).toBe("failed");
    expect(state.employees.get("alice")!.queueRecovery?.phase).toBe("blocked");
    const next = submit();
    await advance(3600000);
    expect(next.status).toBe("queued");
    dispatch.resumeAgentQueue("alice");
    expect(next.status).toBe("dispatched");
  });

  it("restart preserves the deadline, retry count and recovery level", async () => {
    const task = submit();
    await send(task, { type: "task.failed", error: "429", recoverable: true });
    const until = state.employees.get("alice")!.queueRecovery!.until;
    await dispatch.drainTaskWrites();
    dispatch.cleanup();
    const restartAt = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(restartAt);
    state = createInMemoryStateStore();
    await hydrateState(db, state, 36000);
    startDispatcher();
    await register();
    expect(state.employees.get("alice")!.queueRecovery!.until).toBe(until);
    expect(state.tasks.get(task.id)!.retryCount).toBe(1);
    expect(until - Date.now()).toBe(60000);
    await advance(60000);
    expect({ employee: state.employees.get("alice"), queue: state.sharedTaskQueue }).toMatchObject({ employee: { queueRecovery: { phase: "probe" } }, queue: [] });
    expect(state.tasks.get(task.id)!.status).toBe("dispatched");
  });

  it("cleanup and shutdown cannot resurrect work through timers", async () => {
    const task = submit();
    await send(task, { type: "task.failed", error: "429", recoverable: true });
    state.clearingTasks = true;
    dispatch.finishTaskCleanup();
    state.clearingTasks = false;
    await dispatch.resumeAfterTaskCleanup();
    await advance(600000);
    expect(state.tasks.size).toBe(0);
    dispatch.cleanup();
    const sent = wires.get("alice")!.messages.length;
    await vi.advanceTimersByTimeAsync(3600000);
    expect(wires.get("alice")!.messages).toHaveLength(sent);
  });

  it("old attempt events cannot release the probe slot or overwrite retried logs", async () => {
    const task = submit();
    const socket = wires.get("alice")!.socket;
    const oldAttempt = task.attempt;
    await dispatch.handleAgentMessage({ type: "task.output", taskId: task.id, attempt: oldAttempt, stream: "stderr", seq: 1, content: "first attempt" }, socket);
    await send(task, { type: "task.failed", error: "429", recoverable: true });
    dispatch.resumeAgentQueue("alice");
    await dispatch.handleAgentMessage({ type: "task.cancelled", taskId: task.id, attempt: oldAttempt }, socket);
    expect(state.employees.get("alice")!.queueTaskId).toBe(task.id);
    await dispatch.handleAgentMessage({ type: "task.output", taskId: task.id, attempt: task.attempt, stream: "stderr", seq: 1, content: "second attempt" }, socket);
    await dispatch.drainTaskWrites();
    expect((await getTaskLogsByTaskId(db, task.id)).map(c => c.content)).toEqual(["first attempt", "second attempt"]);
  });

  it("reconnect recovery reserves its slot and superseded sockets cannot mutate it", async () => {
    const task = submit();
    const oldSocket = wires.get("alice")!.socket;
    const other = submit();
    await register();
    expect(state.employees.get("alice")!.queueTaskId).toBe(task.id);
    expect(other.status).toBe("queued");
    await dispatch.handleAgentMessage({ type: "task.completed", taskId: task.id, exitCode: 0 }, oldSocket);
    expect(task.status).toBe("dispatched");
  });
  it("a terminal event buffered during disconnect settles before any new attempt", async () => {
    const task = submit();
    const attempt = task.attempt;
    const socket = await register("alice", undefined, [task.id]);
    expect(task.attempt).toBe(attempt);
    expect(wires.get("alice")!.messages.some(m => m.type === "task.dispatch")).toBe(false);
    await dispatch.handleAgentMessage({ type: "task.completed", taskId: task.id, attempt, exitCode: 0 }, socket);
    expect(task.status).toBe("completed");
  });
  it("a task exhausting eight retries does not permanently stop future tasks", async () => {
    const task = submit();
    for (let i = 0; i < 9; i++) {
      await send(task, { type: "task.failed", error: "529 overloaded", recoverable: true });
      const until = state.employees.get("alice")!.queueRecovery!.until;
      await advance(until - Date.now());
    }
    expect(task.retryCount).toBe(8);
    expect(task.status).toBe("failed");
    const next = submit();
    expect(next.status).toBe("dispatched");
    await dispatch.handleAgentMessage({ type: "task.completed", taskId: next.id, attempt: next.attempt, exitCode: 0 }, wires.get("alice")!.socket);
    expect(state.employees.get("alice")!.queueRecovery).toBeUndefined();
  });
  it("cancelled work is not revived by the recovery timer", async () => {
    const task = submit();
    await send(task, { type: "task.failed", error: "429", recoverable: true });
    dispatch.cancelTaskById(task.id);
    await advance(600000);
    expect(task.status).toBe("cancelled");
    expect(state.employees.get("alice")!.queueTaskId).toBeNull();
  });
  it("missed heartbeat closes the connection without releasing a running slot", async () => {
    const task = submit();
    const socket = wires.get("alice")!.socket;
    await dispatch.handleAgentMessage({ type: "task.started", taskId: task.id, pid: 1, attempt: task.attempt }, socket);
    await vi.advanceTimersByTimeAsync(30000);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(state.employees.get("alice")!.status).toBe("offline");
    expect(state.employees.get("alice")!.queueTaskId).toBe(task.id);
    expect(task.status).toBe("running");
  });
});

it("caps repeated recovery delay at five minutes, bounded Retry-After at ten", () => {
  let recovery = nextQueueRecovery(undefined, "temporary", 0, 0, 0);
  for (let i = 0; i < 50; i++) recovery = nextQueueRecovery(recovery, "temporary", 0, 0, 1);
  expect(recovery.until).toBe(300000);
  expect(nextQueueRecovery(recovery, "429", 0, 999999999, 0).until).toBe(600000);
});
