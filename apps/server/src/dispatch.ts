import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  type AgentTarget,
  type EmployeeSnapshot,
  type EmployeeToServerMessage,
  type LeaderToServerMessage,
  type ServerToEmployeeMessage,
  type ServerToLeaderMessage,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskStatus,
  type TaskTargetMode,
  TERMINAL_STATUSES,
  isClaudeSessionFailure,
} from "@ai-teams/shared";
import type { Database } from "./db.js";
import type { StateStore } from "./state-store.js";
import { nextQueueRecovery, isPermanentModelFailure } from "./queue-recovery.js";
import { deleteTaskLogsThroughSeq, getAgentRegistration, persistEmployee, persistTask, persistTaskLog, persistTaskWebhook, upsertAgentRegistration } from "./db.js";
import type { WebhookEventType } from "./schemas.js";
import type { MaybeEncryptor } from "./crypto.js";

export function nowIso() {
  return new Date().toISOString();
}

export function sendJson<T>(socket: WebSocket, payload: T, encryptor?: MaybeEncryptor) {
  if (socket.readyState === WebSocket.OPEN) {
    const plain = JSON.stringify(payload);
    socket.send(encryptor ? encryptor.encrypt(plain) : plain);
  }
}

export type DispatchContext = {
  state: StateStore;
  authToken: string;
  defaultTimeoutSec: number;
  disconnectGraceMs: number;
  runningDisconnectGraceMs: number;
  db: Database;
  log: FastifyInstance["log"];
  encryptor?: MaybeEncryptor;
  maxLogChunksPerTask: number;
  maxRuntimeTasks: number;
  hashAgentToken?: (token: string) => string;
};

export function createDispatch(ctx: DispatchContext) {
  const { state, db, log } = ctx;
  const retryDelays = new Map<string, NodeJS.Timeout>();
  const pendingWrites = new Set<Promise<void>>();
  const employeeWrites = new Map<string, Promise<void>>();
  let deferredWrites: Array<() => Promise<void>> = [];
  const deferredMessages: Array<{ message: EmployeeToServerMessage; socket: WebSocket }> = [];
  const pendingCancellations = new Map<string, Set<string>>();
  let webhookController = new AbortController();

  function writeTaskData(write: () => Promise<void>) {
    if (state.clearingTasks) { deferredWrites.push(write); return; }
    const pending = write().catch((error) => log.error({ error }, "Failed to persist task data"));
    pendingWrites.add(pending);
    void pending.then(() => pendingWrites.delete(pending));
  }

  function requestOrphanCancellation(employeeId: string, taskId: string, socket: WebSocket) {
    const pending = pendingCancellations.get(employeeId) ?? new Set<string>();
    pending.add(taskId);
    pendingCancellations.set(employeeId, pending);
    sendJson<ServerToEmployeeMessage>(socket, { type: "task.cancel", taskId }, ctx.encryptor);
  }
  const recoveryTimers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  function armRecovery(employee: EmployeeSnapshot) {
    const existing = recoveryTimers.get(employee.id);
    if (existing) clearTimeout(existing);
    recoveryTimers.delete(employee.id);
    const recovery = employee.queueRecovery;
    if (closed || state.clearingTasks || employee.queuePaused || recovery?.phase !== "cooldown") return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(employee.id);
      if (closed || state.clearingTasks || employee.queuePaused || employee.queueRecovery !== recovery) return;
      recovery.phase = "probe";
      if (recovery.taskId) {
        const retry = retryDelays.get(recovery.taskId);
        if (retry) clearTimeout(retry);
        retryDelays.delete(recovery.taskId);
      }
      upsertEmployee(employee);
      dispatchSharedQueuedTasks();
    }, Math.max(0, recovery.until - Date.now()));
    timer.unref();
    recoveryTimers.set(employee.id, timer);
  }

  function coolDownEmployee(employeeId: string, reason: string, requestedMs?: number, permanent = false) {
    const employee = state.employees.get(employeeId);
    if (!employee) return;
    const recovery = nextQueueRecovery(employee.queueRecovery, reason, Date.now(), requestedMs);
    employee.queueRecovery = permanent ? { ...recovery, phase: "blocked", until: 0 } : recovery;
    upsertEmployee(employee);
    armRecovery(employee);
  }

  function hasProbeInFlight() {
    return [...state.employees.values()].some(e => e.queueRecovery?.phase === "probe" && !!e.queueTaskId);
  }

  function hasAutomaticRecovery(requiredLabels?: string[] | null) {
    return [...state.employees.values()].some(e => !e.queuePaused && e.status === "online" &&
      (!requiredLabels?.length || requiredLabels.every(label => e.labels.includes(label))) &&
      e.queueRecovery && e.queueRecovery.phase !== "blocked");
  }

  function broadcastToLeaders(payload: ServerToLeaderMessage) {
    for (const socket of state.leaderSockets) {
      sendJson(socket, payload, ctx.encryptor);
    }
  }

  function upsertEmployee(employee: EmployeeSnapshot) {
    state.employees.set(employee.id, employee);
    // PostgreSQL pool writes may otherwise complete out of order, overwriting a
    // new cooldown with an older heartbeat snapshot.
    const snapshot = structuredClone(employee);
    const pending = (employeeWrites.get(employee.id) ?? Promise.resolve())
      .then(() => persistEmployee(db, snapshot))
      .catch((error) => log.error({ error, employeeId: employee.id }, "Failed to persist employee"));
    employeeWrites.set(employee.id, pending);
    pendingWrites.add(pending);
    void pending.then(() => {
      pendingWrites.delete(pending);
      if (employeeWrites.get(employee.id) === pending) employeeWrites.delete(employee.id);
    });
    broadcastToLeaders({ type: "employee.upsert", employee });
  }

  function resetHeartbeatTimer(employeeId: string) {
    const existing = state.heartbeatTimers.get(employeeId);
    if (existing) clearTimeout(existing);
    state.heartbeatTimers.set(employeeId, setTimeout(() => {
      state.heartbeatTimers.delete(employeeId);
      const employee = state.employees.get(employeeId);
      if (closed || !employee || employee.status === "offline") return;
      log.warn({ employeeId }, "Agent heartbeat timeout, marking offline");
      employee.status = "offline";
      upsertEmployee(employee);
      // Do not free an occupied slot while its process may still be running.
      // Closing the half-open socket enters the normal disconnect grace path.
      state.agentSockets.get(employeeId)?.terminate();
    }, 30000));
  }

  function upsertTask(task: TaskRecord) {
    state.tasks.set(task.id, task);
    writeTaskData(() => persistTask(db, task));
    broadcastToLeaders({ type: "task.upsert", task });
    pruneRuntimeState();
  }

  function pruneRuntimeState() {
    if (state.tasks.size <= ctx.maxRuntimeTasks) {
      return;
    }
    const terminalTasks = [...state.tasks.values()]
      .filter((task) => TERMINAL_STATUSES.has(task.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const removeCount = Math.min(terminalTasks.length, state.tasks.size - ctx.maxRuntimeTasks);
    for (let i = 0; i < removeCount; i += 1) {
      const taskId = terminalTasks[i]!.id;
      state.tasks.delete(taskId);
      state.taskLogs.delete(taskId);
      const timer = retryDelays.get(taskId);
      if (timer) clearTimeout(timer);
      retryDelays.delete(taskId);
    }
  }

  function signWebhookPayload(body: string): string {
    const hmac = createHmac("sha256", ctx.authToken);
    hmac.update(body);
    return `sha256=${hmac.digest("hex")}`;
  }

  async function deliverWebhook(
    webhookUrl: string,
    body: string,
    signature: string,
    taskId: string,
    attempt = 1,
    signal = webhookController.signal,
  ) {
    if (signal.aborted) return;
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ai-teams-signature": signature,
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return deliverWebhook(webhookUrl, body, signature, taskId, attempt + 1, signal);
      }
      if (!response.ok) {
        log.warn({ taskId, webhookUrl, status: response.status, attempt }, "Task webhook returned non-2xx after retries");
      } else if (attempt > 1) {
        log.info({ taskId, webhookUrl, attempt }, "Task webhook succeeded on retry");
      }
    } catch (error) {
      if (signal.aborted) return;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return deliverWebhook(webhookUrl, body, signature, taskId, attempt + 1, signal);
      }
      log.warn({ taskId, webhookUrl, error, attempt }, "Task webhook delivery failed after retries");
    }
  }

  function postTaskWebhook(task: TaskRecord, event: WebhookEventType, extra: Record<string, unknown> = {}) {
    if (state.clearingTasks) return;
    const webhookUrl = state.taskWebhooks.get(task.id);
    if (!webhookUrl) {
      return;
    }

    const payload = {
      event,
      timestamp: nowIso(),
      task,
      ...extra,
    };

    const body = JSON.stringify(payload);
    void deliverWebhook(webhookUrl, body, signWebhookPayload(body), task.id);
    if (event !== "task.started" && event !== "task.output" && event !== "queue.updated") {
      state.taskWebhooks.delete(task.id);
    }
  }

  function notifySharedQueueWebhooks() {
    const queue = state.sharedTaskQueue;
    for (let i = 0; i < queue.length; i++) {
      const task = state.tasks.get(queue[i]);
      if (!task || !state.taskWebhooks.has(task.id)) continue;
      postTaskWebhook(task, "queue.updated", { queuePosition: i, queueLength: queue.length });
    }
  }

  function clearTaskTimeout(taskId: string) {
    const timer = state.taskTimeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      state.taskTimeouts.delete(taskId);
    }
  }

  function setMainTask(employeeId: string, taskId: string | null, prompt: string | null) {
    const employee = state.employees.get(employeeId);
    if (!employee) {
      return;
    }
    employee.mainTaskId = taskId;
    employee.mainTaskPrompt = prompt;
    employee.lastSeenAt = nowIso();
    upsertEmployee(employee);
  }

  function setQueueTask(employeeId: string, taskId: string | null, prompt: string | null) {
    const employee = state.employees.get(employeeId);
    if (!employee) {
      return;
    }
    employee.queueTaskId = taskId;
    employee.queueTaskPrompt = prompt;
    employee.lastSeenAt = nowIso();
    upsertEmployee(employee);
  }

  function releaseTaskSlots(taskId: string, dispatchNext = true) {
    let released = false;
    for (const employee of state.employees.values()) {
      if (employee.mainTaskId === taskId) {
        setMainTask(employee.id, null, null);
        released = true;
        if (dispatchNext) {
          dispatchNextMainQueuedTask(employee.id);
        }
      }
      if (employee.queueTaskId === taskId) {
        setQueueTask(employee.id, null, null);
        released = true;
        if (dispatchNext) {
          dispatchNextQueuedTask(employee.id);
        }
      }
    }
    return released;
  }

  function scheduleStaleQueueSlotRelease(taskId: string, employeeId: string | null) {
    if (!employeeId) return;
    const timer = setTimeout(() => {
      const task = state.tasks.get(taskId);
      const employee = state.employees.get(employeeId);
      if (!task || !employee || employee.queueTaskId !== taskId) return;
      if (task.status === "queued" && task.employeeId === null) {
        log.warn({ taskId, employeeId }, "Queue task cancel acknowledgement timed out, releasing stale slot");
        releaseTaskSlots(taskId);
        dispatchSharedQueuedTasks();
      }
    }, 15_000);
    timer.unref();
  }

  const MAX_QUEUE_RETRY = 3;
  const MAX_RECOVERABLE_QUEUE_RETRY = 8;
  const MAX_CONSECUTIVE_QUEUE_FAILURES = 5;
  const MAX_MODEL_COOLDOWN_MS = 10 * 60 * 1000;

  function clampDelayMs(value: number, fallback: number) {
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.max(1_000, Math.min(value, MAX_MODEL_COOLDOWN_MS));
  }

  function computeRecoverableRetryDelayMs(task: TaskRecord, requestedDelayMs?: number) {
    const base = requestedDelayMs !== undefined ? clampDelayMs(requestedDelayMs, 30_000) : 30_000;
    const exponential = Math.min(5_000 * Math.pow(2, Math.max(0, task.retryCount - 1)), MAX_MODEL_COOLDOWN_MS);
    const jitter = Math.floor(Math.random() * 2_000);
    return clampDelayMs(Math.max(base, exponential) + jitter, 30_000);
  }

  function scheduleTaskRetry(taskId: string, delayMs: number) {
    const existing = retryDelays.get(taskId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      retryDelays.delete(taskId);
      dispatchSharedQueuedTasks();
    }, delayMs);
    timer.unref();
    retryDelays.set(taskId, timer);
  }

  function trackQueueFailure(employeeId: string, reason: string) {
    const prev = state.consecutiveQueueFailures.get(employeeId) ?? 0;
    const next = prev + 1;
    state.consecutiveQueueFailures.set(employeeId, next);
    const emp = state.employees.get(employeeId);
    if (emp) {
      emp.consecutiveQueueFailures = next;
      upsertEmployee(emp);
    }
    if (next >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      coolDownEmployee(employeeId, reason);
      log.warn({ employeeId, consecutiveFailures: next }, "Agent paused for queue tasks due to consecutive failures");
    }
  }

  function reEnqueueOrTerminalFail(task: TaskRecord, employeeId: string | null, error: string, options?: { clearSlot?: boolean; incrementRetry?: boolean; recoverable?: boolean; retryDelayMs?: number }): true | false {
    const maxRetry = options?.recoverable ? MAX_RECOVERABLE_QUEUE_RETRY : MAX_QUEUE_RETRY;
    if (task.retryCount < maxRetry) {
      if (options?.incrementRetry !== false) {
        task.retryCount += 1;
      }
      task.status = "queued";
      task.employeeId = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.error = error;
      task.summary = task.summary ?? error;
      log.info({ taskId: task.id, retryCount: task.retryCount, error, previousEmployeeId: employeeId, retryDelayMs: options?.retryDelayMs, recoverable: options?.recoverable }, "Queue task re-enqueued after failure");
      upsertTask(task);
      if (employeeId && options?.clearSlot !== false) {
        setQueueTask(employeeId, null, null);
      }
      enqueueSharedTask(task.id);
      if (options?.retryDelayMs && options.retryDelayMs > 0) {
        scheduleTaskRetry(task.id, options.retryDelayMs);
      }
      dispatchSharedQueuedTasks();
      return true;
    }
    return false;
  }

  function markTaskFailed(taskId: string, error: string, options?: { recoverable?: boolean; cooldownMs?: number; retryAfterMs?: number; nonRetryable?: boolean }) {
    const task = state.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    clearTaskTimeout(taskId);
    const employeeId = task.employeeId;
    const isQueueTask = task.targetMode === "queue";
    const wasRunning = task.status === "accepted" || task.status === "running";
    const sessionFailure = isClaudeSessionFailure(error);
    const nonRetryable = sessionFailure || options?.nonRetryable;

    // Only count as consecutive failure if the task was actually running (not a dispatch rejection)
    if (isQueueTask && employeeId && wasRunning && !options?.recoverable && !nonRetryable) {
      trackQueueFailure(employeeId, error);
    }

    const requestedCooldownMs = options?.retryAfterMs ?? options?.cooldownMs;
    const retryDelayMs = options?.recoverable
      ? computeRecoverableRetryDelayMs(task, requestedCooldownMs)
      : undefined;
    const permanent = isPermanentModelFailure(error);
    if (isQueueTask && employeeId && !nonRetryable) {
      const employee = state.employees.get(employeeId);
      if (permanent || options?.recoverable || employee?.queueRecovery?.phase === "probe") {
        coolDownEmployee(employeeId, error, requestedCooldownMs, permanent);
      }
      if (employee?.queueRecovery) {
        employee.queueRecovery.taskId = task.id;
        upsertEmployee(employee);
      }
    }

    if (isQueueTask && !permanent && !nonRetryable && reEnqueueOrTerminalFail(task, employeeId, error, {
      clearSlot: true,
      incrementRetry: true,
      recoverable: options?.recoverable,
      retryDelayMs,
    })) {
      return;
    }

    // Terminal failure (direct/broadcast, or queue task exceeded retries)
    task.status = "failed";
    task.error = error;
    task.summary = task.summary ?? error;
    task.finishedAt = nowIso();
    log.warn({ taskId, employeeId, error }, "Task failed");
    upsertTask(task);
    postTaskWebhook(task, "task.failed");
    const released = releaseTaskSlots(task.id);
    if (!employeeId && !released) {
      removeFromSharedQueue(task.id);
      dispatchSharedQueuedTasks();
    }
  }

  function appendTaskLog(chunk: TaskOutputChunk) {
    const task = state.tasks.get(chunk.taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    // Output (including an error result with an allocated UUID) is not proof
    // of resumable history. Only the Agent's confirmed task.started updates it.
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    // Agent sequence restarts on every attempt. Keep the storage key monotonic
    // and use (attempt, sourceSeq) to suppress reconnect replay duplicates.
    if (history.some(item => item.attempt === chunk.attempt && item.sourceSeq === chunk.sourceSeq)) return;
    chunk.seq = (history.at(-1)?.seq ?? 0) + 1;
    history.push(chunk);
    if (history.length > ctx.maxLogChunksPerTask) {
      const removed = history.splice(0, history.length - ctx.maxLogChunksPerTask);
      const cutoffSeq = removed[removed.length - 1]?.seq;
      if (cutoffSeq !== undefined) {
        writeTaskData(() => deleteTaskLogsThroughSeq(db, chunk.taskId, cutoffSeq));
      }
    }
    state.taskLogs.set(chunk.taskId, history);
    writeTaskData(() => persistTaskLog(db, chunk));
    broadcastToLeaders({ type: "task.output", chunk });
    if (!chunk.delta) {
      postTaskWebhook(task, "task.output", { chunk });
    }
  }

  function markTaskTimeout(task: TaskRecord) {
    const current = state.tasks.get(task.id);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return;
    }
    const socket = task.employeeId ? state.agentSockets.get(task.employeeId) : undefined;
    if (socket) {
      sendJson<ServerToEmployeeMessage>(socket, { type: "task.cancel", taskId: task.id }, ctx.encryptor);
    }
    clearTaskTimeout(task.id);

    const employeeId = task.employeeId;
    const isQueueTask = task.targetMode === "queue";
    const error = `任务超过 ${task.timeoutSec} 秒未完成，已超时。`;
    if (employeeId && state.employees.get(employeeId)?.queueRecovery?.phase === "probe") {
      coolDownEmployee(employeeId, error);
    }

    // Timeout doesn't count as consecutive failure — the agent isn't broken, just slow
    // Don't clear slot — agent hasn't processed cancel yet

    if (isQueueTask && reEnqueueOrTerminalFail(current, employeeId, error, { clearSlot: false })) {
      scheduleStaleQueueSlotRelease(current.id, employeeId);
      return;
    }

    // Terminal timeout (direct/broadcast, or queue task exceeded retries)
    current.status = "timeout";
    current.finishedAt = nowIso();
    current.error = error;
    current.summary = error;
    log.warn({ taskId: task.id, employeeId, timeoutSec: task.timeoutSec }, "Task timed out");
    upsertTask(current);
    postTaskWebhook(current, "task.timeout");
    releaseTaskSlots(current.id);
  }

  function enqueueSharedTask(taskId: string) {
    if (state.sharedTaskQueue.includes(taskId)) return;
    const task = state.tasks.get(taskId);
    if (!task) { state.sharedTaskQueue.push(taskId); return; }
    // Insert sorted by priority DESC — higher priority first
    let insertAt = state.sharedTaskQueue.length;
    for (let i = 0; i < state.sharedTaskQueue.length; i++) {
      const existing = state.tasks.get(state.sharedTaskQueue[i]);
      if (existing && task.priority > existing.priority) {
        insertAt = i;
        break;
      }
    }
    state.sharedTaskQueue.splice(insertAt, 0, taskId);
    notifySharedQueueWebhooks();
  }

  function removeFromSharedQueue(taskId: string, notify = true) {
    const index = state.sharedTaskQueue.indexOf(taskId);
    if (index !== -1) {
      state.sharedTaskQueue.splice(index, 1);
      if (notify) {
        notifySharedQueueWebhooks();
      }
    }
  }

  function isEmployeeAvailableForQueue(employee: EmployeeSnapshot, requiredLabels?: string[] | null) {
    if (pendingCancellations.has(employee.id)) return false;
    const socket = state.agentSockets.get(employee.id);
    if (employee.status !== "online" || employee.queueTaskId || socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (state.queuePausedSet.has(employee.id)) {
      return false;
    }

    if (employee.queueRecovery?.phase === "blocked" || employee.queueRecovery?.phase === "cooldown") return false;
    // Shared model capacity: only one queue-slot recovery probe globally.
    if (hasProbeInFlight()) return false;
    if (hasAutomaticRecovery(requiredLabels) && employee.queueRecovery?.phase !== "probe") return false;

    if (requiredLabels && requiredLabels.length > 0) {
      return requiredLabels.every((label) => employee.labels.includes(label));
    }
    return true;
  }

  function pickAvailableEmployeeIdForQueue(requiredLabels?: string[]) {
    let available = [...state.employees.values()]
      .filter((employee) => isEmployeeAvailableForQueue(employee, requiredLabels));

    if (available.length === 0) {
      return null;
    }

    // Sort by load (fewer active tasks first), then by id for stability
    available.sort((a, b) => {
      const loadA = (a.mainTaskId ? 1 : 0) + (a.queueTaskId ? 1 : 0);
      const loadB = (b.mainTaskId ? 1 : 0) + (b.queueTaskId ? 1 : 0);
      if (loadA !== loadB) return loadA - loadB;
      return a.id.localeCompare(b.id);
    });

    // Among equally-loaded agents, use weighted random selection
    const minLoad = (available[0].mainTaskId ? 1 : 0) + (available[0].queueTaskId ? 1 : 0);
    const lightest = available.filter((e) => (e.mainTaskId ? 1 : 0) + (e.queueTaskId ? 1 : 0) === minLoad);

    if (lightest.length === 1) {
      return lightest[0].id;
    }

    const totalWeight = lightest.reduce((sum, e) => sum + (e.weight ?? 1), 0);
    let random = Math.random() * totalWeight;
    for (const employee of lightest) {
      random -= (employee.weight ?? 1);
      if (random < 0) {
        return employee.id;
      }
    }
    return lightest[lightest.length - 1].id;
  }

  function logIfQueueStalledByPausedAgents() {
    if (state.sharedTaskQueue.length === 0) {
      return;
    }
    const onlineEmployees = [...state.employees.values()].filter((e) => e.status === "online");
    const allPaused = onlineEmployees.length > 0 && onlineEmployees.every(
      (e) => state.queuePausedSet.has(e.id) || (state.consecutiveQueueFailures.get(e.id) ?? 0) >= MAX_CONSECUTIVE_QUEUE_FAILURES,
    );
    if (allPaused) {
      log.warn({ queueLength: state.sharedTaskQueue.length }, "All online agents are paused for queue tasks — queue stalled");
    }
  }

  function dispatchSharedQueuedTask(preferredEmployeeId?: string): boolean {
    if (closed || state.clearingTasks) return false;
    if (state.sharedTaskQueue.length === 0) {
      return false;
    }
    for (let i = 0; i < state.sharedTaskQueue.length; i++) {
      const taskId = state.sharedTaskQueue[i]!;
      const task = state.tasks.get(taskId);
      if (!task || task.status !== "queued" || task.targetMode !== "queue") continue;
      if (retryDelays.has(taskId)) continue;

      const requiredLabels = task.requiredLabels ?? undefined;
      let employeeId: string | null = null;
      if (task.sessionId && task.sessionEmployeeId) {
        if (preferredEmployeeId && preferredEmployeeId !== task.sessionEmployeeId) continue;
        const owner = state.employees.get(task.sessionEmployeeId);
        employeeId = owner && isEmployeeAvailableForQueue(owner, requiredLabels) ? owner.id : null;
      } else if (task.sessionId) {
        markTaskFailed(task.id, "[session_unavailable] 会话所属 Agent 未知，不能将本机会话随机派发到其他 Agent。请指定原 Agent 或确认副作用后新建任务。");
        return true;
      } else if (preferredEmployeeId) {
        const employee = state.employees.get(preferredEmployeeId);
        employeeId = employee && isEmployeeAvailableForQueue(employee, requiredLabels) ? employee.id : null;
      } else {
        employeeId = pickAvailableEmployeeIdForQueue(requiredLabels);
      }
      if (!employeeId) continue;

      state.sharedTaskQueue.splice(i, 1);
      dispatchTask(task, employeeId);
      return true;
    }

    logIfQueueStalledByPausedAgents();
    return false;
  }

  function dispatchSharedQueuedTasks() {
    for (let index = 0; index < state.employees.size && state.sharedTaskQueue.length > 0; index += 1) {
      if (!dispatchSharedQueuedTask()) {
        return;
      }
    }
  }

  function dispatchTask(task: TaskRecord, assignedEmployeeId = task.employeeId) {
    const isQueueSlot = task.targetMode === "queue";

    if (!assignedEmployeeId) {
      if (isQueueSlot) {
        enqueueSharedTask(task.id);
        dispatchSharedQueuedTasks();
      } else {
        markTaskFailed(task.id, "非队列任务必须指定目标员工。");
      }
      return;
    }

    const employee = state.employees.get(assignedEmployeeId);
    const socket = state.agentSockets.get(assignedEmployeeId);

    if (!employee || employee.status !== "online" || !socket) {
      markTaskFailed(task.id, "目标员工当前离线，任务未能分发。");
      return;
    }

    const currentSlotTaskId = isQueueSlot ? employee.queueTaskId : employee.mainTaskId;
    if (pendingCancellations.has(assignedEmployeeId) || (currentSlotTaskId && currentSlotTaskId !== task.id)) {
      const queueMap = isQueueSlot ? state.taskQueues : state.mainTaskQueues;
      const queue = queueMap.get(assignedEmployeeId) ?? [];
      queue.push(task.id);
      queueMap.set(assignedEmployeeId, queue);
      return;
    }

    if (isQueueSlot && employee.queueRecovery?.phase === "probe") {
      // Release the Agent's independent failure latch before dispatching the probe.
      sendJson<ServerToEmployeeMessage>(socket, { type: "queue.resume" }, ctx.encryptor);
    }
    task.employeeId = assignedEmployeeId;
    task.attempt += 1;
    task.status = "dispatched";
    log.info({ taskId: task.id, employeeId: assignedEmployeeId, attempt: task.attempt, targetMode: task.targetMode, prompt: task.prompt.slice(0, 80) }, "Task dispatched");
    upsertTask(task);
    if (isQueueSlot) {
      setQueueTask(assignedEmployeeId, task.id, task.prompt);
    } else {
      setMainTask(assignedEmployeeId, task.id, task.prompt);
    }
    clearTaskTimeout(task.id);
    state.taskTimeouts.set(task.id, setTimeout(() => markTaskTimeout(task), task.timeoutSec * 1000));

    sendJson<ServerToEmployeeMessage>(socket, {
      type: "task.dispatch",
      taskId: task.id,
      leaderCommandId: task.leaderCommandId,
      employeeId: assignedEmployeeId,
      targetMode: task.targetMode,
      prompt: task.prompt,
      workspace: task.workspace,
      timeoutSec: task.timeoutSec,
      cliConfig: task.cliConfig,
      attempt: task.attempt,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    }, ctx.encryptor);
  }

  function dispatchNextQueuedTask(employeeId: string) {
    if (state.clearingTasks || pendingCancellations.has(employeeId)) return;
    const employee = state.employees.get(employeeId);
    if (!employee || !isEmployeeAvailableForQueue(employee)) {
      return;
    }
    const queue = state.taskQueues.get(employeeId);
    if (!queue || queue.length === 0) {
      dispatchSharedQueuedTasks();
      return;
    }
    while (queue.length > 0) {
      const taskId = queue.shift()!;
      if (queue.length === 0) {
        state.taskQueues.delete(employeeId);
      }
      const task = state.tasks.get(taskId);
      if (task && task.status === "queued") {
        dispatchTask(task, employeeId);
        return;
      }
    }
    dispatchSharedQueuedTasks();
  }

  function dispatchNextMainQueuedTask(employeeId: string) {
    if (state.clearingTasks || pendingCancellations.has(employeeId)) return;
    const employee = state.employees.get(employeeId);
    if (!employee || employee.mainTaskId || employee.status !== "online") {
      return;
    }
    const queue = state.mainTaskQueues.get(employeeId);
    if (!queue || queue.length === 0) {
      return;
    }
    while (queue.length > 0) {
      const taskId = queue.shift()!;
      if (queue.length === 0) {
        state.mainTaskQueues.delete(employeeId);
      }
      const task = state.tasks.get(taskId);
      if (task && task.status === "queued") {
        dispatchTask(task, employeeId);
        return;
      }
    }
  }

  function createTask(
    employeeId: string | null,
    prompt: string,
    workspace: string | undefined,
    timeoutSec: number | undefined,
    leaderCommandId: string | undefined,
    targetMode: TaskTargetMode,
    webhookUrl?: string | null,
    cliConfig?: unknown,
    priority?: number,
    requiredLabels?: string[] | null,
    sessionId?: string,
  ) {
    const sessionOwners = sessionId
      ? new Set([...state.tasks.values()].filter((t) => t.sessionId === sessionId).map((t) => t.sessionEmployeeId ?? t.employeeId).filter((id): id is string => Boolean(id)))
      : new Set<string>();
    const task: TaskRecord = {
      id: randomUUID(),
      leaderCommandId: leaderCommandId ?? randomUUID(),
      employeeId,
      sessionId: sessionId ?? null,
      sessionEmployeeId: sessionId ? employeeId ?? (sessionOwners.size === 1 ? [...sessionOwners][0]! : null) : null,
      targetMode,
      prompt,
      workspace: workspace?.trim() || null,
      timeoutSec: timeoutSec ?? ctx.defaultTimeoutSec,
      cliConfig: (cliConfig && typeof cliConfig === "object" && !Array.isArray(cliConfig) ? cliConfig : null) as TaskRecord["cliConfig"],
      priority: priority ?? 1,
      requiredLabels: requiredLabels ?? null,
      status: "queued",
      retryCount: 0,
      reconnectCount: 0,
      attempt: 0,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      durationMs: null,
      durationApiMs: null,
      numTurns: null,
      totalCostUsd: null,
      usageInputTokens: null,
      usageOutputTokens: null,
      usageCacheReadTokens: null,
      usageCacheCreationTokens: null,
    };

    if (webhookUrl) {
      state.taskWebhooks.set(task.id, webhookUrl);
      writeTaskData(() => persistTaskWebhook(db, task.id, webhookUrl));
    }
    upsertTask(task);
    log.info({ taskId: task.id, targetMode, employeeId, prompt: prompt.slice(0, 80) }, "Task created");
    if (targetMode === "queue") {
      enqueueSharedTask(task.id);
      dispatchSharedQueuedTasks();
    } else {
      dispatchTask(task);
    }
    return task;
  }

  function resolveTargetIds(target: AgentTarget) {
    if (target === "queue") {
      return [];
    }
    if (target === "all") {
      return [...state.employees.values()]
        .filter((employee) => employee.status === "online" && state.agentSockets.get(employee.id)?.readyState === WebSocket.OPEN)
        .map((employee) => employee.id);
    }
    return [...new Set(target)];
  }

  function dispatchLeaderCommand(
    message: Extract<LeaderToServerMessage, { type: "command.dispatch" }>,
    webhookUrl?: string | null,
    cliConfig?: unknown,
    priority?: number,
    requiredLabels?: string[] | null,
  ) {
    if (state.clearingTasks) return { ok: false as const, code: "tasks_clearing", message: "正在清空任务，请稍后重试。" };
    const leaderCommandId = randomUUID();
    const resolvedPriority = message.priority ?? priority;
    const resolvedRequiredLabels = message.requiredLabels ?? requiredLabels;
    if (message.atAgents === "queue") {
      return {
        ok: true as const,
        leaderCommandId,
        tasks: [createTask(null, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, "queue", webhookUrl, cliConfig, resolvedPriority, resolvedRequiredLabels, message.sessionId)],
      };
    }

    const targetIds = resolveTargetIds(message.atAgents);
    if (targetIds.length === 0) {
      return {
        ok: false as const,
        code: "no_target_agents",
        message: "没有可用的目标员工。",
      };
    }

    const targetMode = message.atAgents === "all" ? "broadcast" : "direct";
    return {
      ok: true as const,
      leaderCommandId,
      tasks: targetIds.map((employeeId) =>
        createTask(employeeId, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, targetMode, webhookUrl, cliConfig, resolvedPriority, resolvedRequiredLabels, message.sessionId),
      ),
    };
  }

  function recoverOrFail(taskId: string, employeeId: string, isQueueSlot: boolean) {
    const task = state.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status) || task.employeeId !== employeeId) return;
    clearTaskTimeout(task.id);
    if (isClaudeSessionFailure(task.error ?? "")) {
      markTaskFailed(task.id, task.error!, { nonRetryable: true });
      return;
    }
    // Keep reconnect recovery independent of model failures and task retries.
    if ((task.reconnectCount ?? 0) >= (isQueueSlot ? MAX_RECOVERABLE_QUEUE_RETRY : MAX_QUEUE_RETRY)) {
      markTaskFailed(task.id, `重连恢复次数已用尽，请检查 Agent 后重新提交任务。${task.error ? ` 上次错误：${task.error}` : ""}`, { nonRetryable: true });
      return;
    }
    task.reconnectCount = (task.reconnectCount ?? 0) + 1;
    dispatchTask(task, employeeId);
  }

  async function validateAgentRegistration(message: Extract<EmployeeToServerMessage, { type: "agent.register" }>, socket: WebSocket) {
    const now = nowIso();
    const registration = await getAgentRegistration(db, message.employeeId);

    if (!registration) {
      socket.close(1008, "agent_not_registered");
      return false;
    }

    if (registration.status !== "approved") {
      await upsertAgentRegistration(db, {
        employeeId: message.employeeId,
        name: message.name,
        machineId: message.machineId,
        hostname: message.hostname,
        labels: message.labels,
        status: "pending",
        lastSeenAt: now,
      });
      socket.close(1008, "agent_pending_approval");
      return false;
    }

    const agentToken = message.agentToken;
    const tokenHash = agentToken && ctx.hashAgentToken ? ctx.hashAgentToken(agentToken) : null;
    if (!registration.tokenHash || !tokenHash || tokenHash !== registration.tokenHash) {
      socket.close(1008, "agent_token_invalid");
      return false;
    }

    await upsertAgentRegistration(db, {
      employeeId: message.employeeId,
      name: message.name,
      machineId: message.machineId,
      hostname: message.hostname,
      labels: message.labels,
      status: "approved",
      approvedAt: registration.approvedAt ?? now,
      lastSeenAt: now,
    });
    return true;
  }

  async function handleRegister(message: Extract<EmployeeToServerMessage, { type: "agent.register" }>, socket: WebSocket) {
    if (!(await validateAgentRegistration(message, socket))) {
      return;
    }
    if (socket.readyState !== WebSocket.OPEN || closed) return;
    if (state.clearingTasks) {
      deferredMessages.push({ message, socket });
      return;
    }

    const previous = state.employees.get(message.employeeId);
    const previousMainTaskId = previous?.mainTaskId ?? null;
    const previousQueueTaskId = previous?.queueTaskId ?? null;
    // A task may have finished while disconnected. Let buffered terminal events
    // settle that attempt before deciding to restart its process.
    const activeMainTaskId = message.activeMainTaskId ?? (previousMainTaskId && message.pendingTaskIds?.includes(previousMainTaskId) ? previousMainTaskId : null);
    const activeQueueTaskId = message.activeQueueTaskId ?? (previousQueueTaskId && message.pendingTaskIds?.includes(previousQueueTaskId) ? previousQueueTaskId : null);

    const disconnectTimer = state.disconnectTimers.get(message.employeeId);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      state.disconnectTimers.delete(message.employeeId);
    }

    // Clear any retry delay timers for tasks previously owned by this employee
    for (const prevTaskId of [previousMainTaskId, previousQueueTaskId]) {
      if (prevTaskId) {
        const timer = retryDelays.get(prevTaskId);
        if (timer) {
          clearTimeout(timer);
          retryDelays.delete(prevTaskId);
        }
      }
    }

    const replacedSocket = state.agentSockets.get(message.employeeId);
    if (replacedSocket && replacedSocket !== socket) {
      state.socketToEmployeeId.delete(replacedSocket);
      replacedSocket.close(1008, "agent_connection_replaced");
    }
    state.agentSockets.set(message.employeeId, socket);
    state.socketToEmployeeId.set(socket, message.employeeId);
    pendingCancellations.delete(message.employeeId);
    // A reconnect after cleanup (including a server restart) must stop old work.
    for (const taskId of [activeMainTaskId, activeQueueTaskId]) {
      const task = taskId ? state.tasks.get(taskId) : undefined;
      if (taskId && (!task || TERMINAL_STATUSES.has(task.status) || task.employeeId !== message.employeeId)) {
        requestOrphanCancellation(message.employeeId, taskId, socket);
      }
    }

    let mainTaskId: string | null = null;
    let mainTaskPrompt: string | null = null;
    let queueTaskId: string | null = null;
    let queueTaskPrompt: string | null = null;

    // Resolve main slot
    if (previousMainTaskId && activeMainTaskId !== previousMainTaskId) {
      const task = state.tasks.get(previousMainTaskId);
      if (task && !TERMINAL_STATUSES.has(task.status) && task.employeeId === message.employeeId) {
        mainTaskId = task.id;
        mainTaskPrompt = task.prompt;
      }
    } else if (activeMainTaskId) {
      const activeTask = state.tasks.get(activeMainTaskId);
      if (activeTask && activeTask.employeeId === message.employeeId && !TERMINAL_STATUSES.has(activeTask.status)) {
        mainTaskId = activeTask.id;
        mainTaskPrompt = activeTask.prompt;
      }
    }

    // Resolve queue slot
    if (previousQueueTaskId && activeQueueTaskId !== previousQueueTaskId) {
      const task = state.tasks.get(previousQueueTaskId);
      if (task && !TERMINAL_STATUSES.has(task.status) && task.employeeId === message.employeeId) {
        queueTaskId = task.id;
        queueTaskPrompt = task.prompt;
      }
    } else if (activeQueueTaskId) {
      const activeTask = state.tasks.get(activeQueueTaskId);
      if (activeTask && activeTask.employeeId === message.employeeId && !TERMINAL_STATUSES.has(activeTask.status)) {
        queueTaskId = activeTask.id;
        queueTaskPrompt = activeTask.prompt;
      }
    }

    upsertEmployee({
      id: message.employeeId,
      name: message.name,
      machineId: message.machineId,
      hostname: message.hostname,
      labels: message.labels,
      status: "online",
      mainTaskId,
      mainTaskPrompt,
      queueTaskId,
      queueTaskPrompt,
      lastSeenAt: nowIso(),
      consecutiveQueueFailures: state.consecutiveQueueFailures.get(message.employeeId) ?? 0,
      queuePaused: state.queuePausedSet.has(message.employeeId) || undefined,
      queueRecovery: previous?.queueRecovery,
      version: message.version,
      claudeVersion: message.claudeVersion,
      permissionMode: message.permissionMode,
      weight: message.weight ?? 1,
    });

    sendJson<ServerToEmployeeMessage>(socket, {
      type: "agent.registered",
      consecutiveQueueFailures: state.consecutiveQueueFailures.get(message.employeeId) ?? 0,
    }, ctx.encryptor);

    const registeredEmployee = state.employees.get(message.employeeId)!;
    if (!registeredEmployee.queueRecovery && registeredEmployee.consecutiveQueueFailures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      coolDownEmployee(message.employeeId, "连续失败达到阈值，等待恢复探测");
    } else armRecovery(registeredEmployee);
    if (mainTaskId && activeMainTaskId !== mainTaskId) recoverOrFail(mainTaskId, message.employeeId, false);
    if (queueTaskId && activeQueueTaskId !== queueTaskId) recoverOrFail(queueTaskId, message.employeeId, true);
    if (!mainTaskId) {
      dispatchNextMainQueuedTask(message.employeeId);
    }
    if (!queueTaskId) {
      dispatchNextQueuedTask(message.employeeId);
    }
    dispatchSharedQueuedTasks();
    resetHeartbeatTimer(message.employeeId);
  }

  function taskBelongsToSocket(taskId: string, employeeId: string | undefined, socket: WebSocket) {
    const socketEmployeeId = state.socketToEmployeeId.get(socket);
    if (!socketEmployeeId || (employeeId && employeeId !== socketEmployeeId)) {
      return false;
    }
    const task = state.tasks.get(taskId);
    return Boolean(task && task.employeeId === socketEmployeeId);
  }

  function messageAttempt(message: EmployeeToServerMessage) {
    return "attempt" in message && typeof message.attempt === "number" ? message.attempt : undefined;
  }

  function clearStaleSlotForSocket(taskId: string, employeeId: string) {
    const employee = state.employees.get(employeeId);
    if (!employee) return false;
    let cleared = false;
    if (employee.mainTaskId === taskId) {
      setMainTask(employeeId, null, null);
      dispatchNextMainQueuedTask(employeeId);
      cleared = true;
    }
    if (employee.queueTaskId === taskId) {
      setQueueTask(employeeId, null, null);
      dispatchNextQueuedTask(employeeId);
      cleared = true;
    }
    return cleared;
  }

  async function handleAgentMessage(message: EmployeeToServerMessage, socket: WebSocket) {
    if (closed) return;
    if (state.clearingTasks) {
      deferredMessages.push({ message, socket });
      return;
    }
    if (message.type === "agent.register") {
      await handleRegister(message, socket);
      return;
    }

    const socketEmployeeId = state.socketToEmployeeId.get(socket);
    if (!socketEmployeeId) {
      sendJson<ServerToLeaderMessage>(socket as unknown as WebSocket, {
        type: "server.error",
        code: "agent_not_registered",
        message: "Agent must register before sending task events.",
      }, ctx.encryptor);
      socket.close(1008, "agent_not_registered");
      return;
    }

    if (state.agentSockets.get(socketEmployeeId) !== socket) return;

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
        resetHeartbeatTimer(message.employeeId);
      }
      return;
    }

    if (message.type === "agent.request_task") {
      if (message.employeeId !== socketEmployeeId) {
        socket.close(1008, "employee_mismatch");
        return;
      }
      dispatchNextQueuedTask(message.employeeId);
      return;
    }

    if (message.type === "session.reset.ack") {
      log.info({ employeeId: message.employeeId }, "Agent acknowledged session reset");
      return;
    }

    const task = state.tasks.get(message.taskId);
    const pending = pendingCancellations.get(socketEmployeeId);
    if (pending?.has(message.taskId) && ["task.cancelled", "task.completed", "task.failed"].includes(message.type)) {
      pending.delete(message.taskId);
      if (pending.size === 0) pendingCancellations.delete(socketEmployeeId);
      dispatchNextMainQueuedTask(socketEmployeeId);
      dispatchNextQueuedTask(socketEmployeeId);
      return;
    }
    if (!task) {
      // Late output/results must neither recreate purged tasks nor disconnect a valid agent.
      if ("employeeId" in message && message.employeeId !== socketEmployeeId) {
        socket.close(1008, "employee_mismatch");
        return;
      }
      if (["task.cancelled", "task.completed", "task.failed"].includes(message.type)) {
        const pending = pendingCancellations.get(socketEmployeeId);
        pending?.delete(message.taskId);
        if (pending?.size === 0) pendingCancellations.delete(socketEmployeeId);
        dispatchNextMainQueuedTask(socketEmployeeId);
        dispatchNextQueuedTask(socketEmployeeId);
      } else {
        requestOrphanCancellation(socketEmployeeId, message.taskId, socket);
      }
      return;
    }
    const attempt = messageAttempt(message);
    if (
      message.type === "task.cancelled" &&
      task &&
      task.status === "queued" &&
      task.targetMode === "queue" &&
      task.employeeId === null &&
      state.employees.get(socketEmployeeId)?.queueTaskId === task.id
    ) {
      log.info({ taskId: task.id, employeeId: socketEmployeeId }, "Stale queue cancel acknowledgement received after task was re-enqueued");
      setQueueTask(socketEmployeeId, null, null);
      dispatchNextQueuedTask(socketEmployeeId);
      return;
    }

    if (task && attempt !== undefined && attempt !== task.attempt) {
      log.warn({ taskId: task.id, employeeId: socketEmployeeId, messageType: message.type, messageAttempt: attempt, currentAttempt: task.attempt }, "Ignoring stale task event from previous attempt");
      if (message.type === "task.cancelled" && task.employeeId !== socketEmployeeId) {
        // An old acknowledgement must not release this employee's newer attempt.
        clearStaleSlotForSocket(task.id, socketEmployeeId);
      }
      return;
    }

    if (!taskBelongsToSocket(message.taskId, socketEmployeeId, socket)) {
      socket.close(1008, "task_owner_mismatch");
      return;
    }

    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }

    switch (message.type) {
      case "task.accepted":
        if (task.status !== "dispatched") return;
        task.status = "accepted";
        upsertTask(task);
        log.info({ taskId: task.id, employeeId: socketEmployeeId }, "Task accepted");
        break;
      case "task.started": {
        const alreadyRunning = task.status === "running";
        task.status = "running";
        task.sessionId = message.sessionId ?? task.sessionId;
        if (message.sessionId) task.sessionEmployeeId = socketEmployeeId;
        task.startedAt = task.startedAt ?? nowIso();
        if (message.claudeVersion) {
          const employee = state.employees.get(socketEmployeeId);
          if (employee && employee.claudeVersion !== message.claudeVersion) {
            employee.claudeVersion = message.claudeVersion;
            upsertEmployee(employee);
          }
        }
        upsertTask(task);
        if (!alreadyRunning) postTaskWebhook(task, "task.started");
        log.info({ taskId: task.id, employeeId: socketEmployeeId, sessionId: task.sessionId, pid: message.pid }, "Task started");
        break;
      }
      case "task.output":
        if (!task.employeeId) {
          return;
        }
        appendTaskLog({
          taskId: message.taskId,
          employeeId: task.employeeId,
          stream: message.stream,
          seq: message.seq,
          sourceSeq: message.seq,
          attempt: task.attempt,
          content: message.content,
          createdAt: nowIso(),
          ...(message.delta ? { delta: true } : {}),
        });
        break;
      case "task.completed":
        task.status = "completed";
        clearTaskTimeout(task.id);
        task.finishedAt = nowIso();
        task.exitCode = message.exitCode;
        task.summary = message.summary ?? "任务执行完成。";
        task.error = null;
        task.durationMs = message.durationMs ?? task.durationMs;
        task.durationApiMs = message.durationApiMs ?? task.durationApiMs;
        task.numTurns = message.numTurns ?? task.numTurns;
        task.totalCostUsd = message.totalCostUsd ?? task.totalCostUsd;
        task.usageInputTokens = message.usageInputTokens ?? task.usageInputTokens;
        task.usageOutputTokens = message.usageOutputTokens ?? task.usageOutputTokens;
        task.usageCacheReadTokens = message.usageCacheReadTokens ?? task.usageCacheReadTokens;
        task.usageCacheCreationTokens = message.usageCacheCreationTokens ?? task.usageCacheCreationTokens;
        upsertTask(task);
        postTaskWebhook(task, "task.completed");
        log.info({ taskId: task.id, employeeId: task.employeeId, exitCode: task.exitCode, durationMs: task.durationMs, numTurns: task.numTurns, totalCostUsd: task.totalCostUsd }, "Task completed");
        if (task.employeeId && task.targetMode === "queue") {
          const prev = state.consecutiveQueueFailures.get(task.employeeId) ?? 0;
          if (prev > 0 || state.employees.get(task.employeeId)?.queueRecovery) {
            state.consecutiveQueueFailures.set(task.employeeId, 0);
            const emp = state.employees.get(task.employeeId);
            if (emp) {
              emp.consecutiveQueueFailures = 0;
              delete emp.queueRecovery;
              armRecovery(emp);
              upsertEmployee(emp);
            }
            log.info({ employeeId: task.employeeId }, "Consecutive queue failure count reset after successful task");
          }
        }
        releaseTaskSlots(task.id);
        break;
      case "task.failed":
        markTaskFailed(message.taskId, message.error, {
          recoverable: message.recoverable,
          cooldownMs: message.cooldownMs,
          retryAfterMs: message.retryAfterMs,
        });
        break;
      case "task.cancelled":
        if (task.status === "queued") {
          // Task was already re-enqueued (e.g., after timeout), just clear the slot
          log.info({ taskId: task.id, employeeId: task.employeeId }, "Task already re-enqueued, clearing slot from cancel response");
          releaseTaskSlots(task.id);
          break;
        }
        task.status = "cancelled";
        clearTaskTimeout(task.id);
        task.finishedAt = nowIso();
        task.summary = "任务已取消。";
        log.info({ taskId: task.id, employeeId: task.employeeId }, "Task cancelled");
        upsertTask(task);
        postTaskWebhook(task, "task.cancelled");
        releaseTaskSlots(task.id);
        break;
    }
  }

  function cancelTaskById(taskId: string): { ok: true; task: TaskRecord } | { ok: false; code: string; message: string } {
    const task = state.tasks.get(taskId);
    if (!task) {
      return { ok: false, code: "not_found", message: "任务不存在。" };
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      releaseTaskSlots(task.id);
      return { ok: true, task };
    }
    if (task.status === "queued") {
      if (task.employeeId) {
        const isMainSlot = task.targetMode !== "queue";
        const queueMap = isMainSlot ? state.mainTaskQueues : state.taskQueues;
        const queue = queueMap.get(task.employeeId);
        if (queue) {
          const idx = queue.indexOf(task.id);
          if (idx !== -1) {
            queue.splice(idx, 1);
          }
          if (queue.length === 0) {
            queueMap.delete(task.employeeId);
          }
        }
      } else {
        removeFromSharedQueue(task.id);
      }
      task.status = "cancelled";
      task.finishedAt = nowIso();
      task.summary = "任务已取消。";
      upsertTask(task);
      postTaskWebhook(task, "task.cancelled");
      releaseTaskSlots(task.id);
      return { ok: true, task };
    }
    if (!task.employeeId) {
      markTaskFailed(task.id, "任务尚未分配给员工，无法取消运行中的进程。");
      return { ok: true, task: state.tasks.get(task.id)! };
    }
    const agentSocket = state.agentSockets.get(task.employeeId);
    if (!agentSocket) {
      markTaskFailed(task.id, "员工已离线，无法取消运行中的进程。");
      return { ok: true, task: state.tasks.get(task.id)! };
    }
    sendJson<ServerToEmployeeMessage>(agentSocket, { type: "task.cancel", taskId: task.id }, ctx.encryptor);
    return { ok: true, task };
  }

  function patchTaskById(taskId: string, fields: Record<string, unknown>): { ok: true; task: TaskRecord } | { ok: false; code: string; message: string } {
    const task = state.tasks.get(taskId);
    if (!task) {
      return { ok: false, code: "not_found", message: "任务不存在。" };
    }

    if (fields.status === "cancelled") {
      return cancelTaskById(taskId);
    }

    if (TERMINAL_STATUSES.has(task.status)) {
      return { ok: false, code: "already_terminal", message: `任务已处于终态 ${task.status}，无法更新。` };
    }

    if (fields.cliConfig !== undefined) {
      if (task.status !== "queued") {
        return { ok: false, code: "already_dispatched", message: "任务已分发，无法修改 CLI 配置。" };
      }
      task.cliConfig = fields.cliConfig && typeof fields.cliConfig === "object" && !Array.isArray(fields.cliConfig)
        ? fields.cliConfig as TaskRecord["cliConfig"]
        : null;
    }

    if (fields.timeoutSec !== undefined) {
      if (typeof fields.timeoutSec !== "number" || !Number.isFinite(fields.timeoutSec) || fields.timeoutSec <= 0) {
        return { ok: false, code: "invalid_timeout", message: "timeoutSec 必须是正数。" };
      }
      task.timeoutSec = fields.timeoutSec;
      if (task.status !== "queued") {
        clearTaskTimeout(task.id);
        state.taskTimeouts.set(task.id, setTimeout(() => markTaskTimeout(task), task.timeoutSec * 1000));
      }
    }

    upsertTask(task);
    return { ok: true, task };
  }

  function handleLeaderMessage(message: LeaderToServerMessage, socket: WebSocket) {
    if (state.clearingTasks) {
      sendJson<ServerToLeaderMessage>(socket, { type: "command.error", code: "tasks_clearing", message: "正在清空任务，请稍后重试。" }, ctx.encryptor);
      return;
    }
    switch (message.type) {
      case "command.dispatch": {
        const result = dispatchLeaderCommand(message);
        if (!result.ok) {
          sendJson<ServerToLeaderMessage>(socket, {
            type: "command.error",
            code: result.code,
            message: result.message,
          }, ctx.encryptor);
        }
        break;
      }
      case "command.send":
        createTask(message.employeeId, message.prompt, message.workspace, message.timeoutSec, undefined, "direct"); // direct tasks don't use requiredLabels
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
      case "task.cancel":
        {
          const result = cancelTaskById(message.taskId);
          if (!result.ok) {
            sendJson<ServerToLeaderMessage>(socket, {
              type: "command.error",
              code: result.code,
              message: result.message,
            }, ctx.encryptor);
          }
        }
        break;
    }
  }

  function startDisconnectRecovery(employeeId: string) {
    const employee = state.employees.get(employeeId);
    if (!employee) return;

    const taskIds: string[] = [];
    if (employee.mainTaskId) taskIds.push(employee.mainTaskId);
    if (employee.queueTaskId) taskIds.push(employee.queueTaskId);
    if (taskIds.length === 0) return;
    const hasRunningTask = taskIds.some((taskId) => {
      const task = state.tasks.get(taskId);
      return task?.status === "accepted" || task?.status === "running";
    });
    const graceMs = hasRunningTask ? ctx.runningDisconnectGraceMs : ctx.disconnectGraceMs;

    const timer = setTimeout(() => {
      state.disconnectTimers.delete(employeeId);
      if (state.agentSockets.has(employeeId)) return;

      for (const taskId of taskIds) {
        const task = state.tasks.get(taskId);
        if (!task || TERMINAL_STATUSES.has(task.status)) continue;

        clearTaskTimeout(taskId);
        task.reconnectCount = (task.reconnectCount ?? 0) + 1;

        if (task.reconnectCount >= (task.targetMode === "queue" ? MAX_RECOVERABLE_QUEUE_RETRY : MAX_QUEUE_RETRY)) {
          markTaskFailed(taskId, `重连恢复次数已用尽，请检查 Agent 后重新提交任务。${task.error ? ` 上次错误：${task.error}` : ""}`, { nonRetryable: true });
          continue;
        }

        task.employeeId = null;
        task.status = "queued";
        upsertTask(task);
        log.info({ taskId, employeeId, reconnectCount: task.reconnectCount }, "Task re-queued after disconnect grace period");

        if (task.targetMode === "queue") {
          enqueueSharedTask(taskId);
        } else {
          const queue = state.mainTaskQueues.get(employeeId) ?? [];
          if (!queue.includes(taskId)) queue.push(taskId);
          state.mainTaskQueues.set(employeeId, queue);
        }

        // Schedule delayed re-dispatch for subsequent retries
        if (task.reconnectCount > 1) {
          const retryDelay = (task.reconnectCount - 1) * 5000;
          const existingDelay = retryDelays.get(taskId);
          if (existingDelay) clearTimeout(existingDelay);
          retryDelays.set(taskId, setTimeout(() => {
            retryDelays.delete(taskId);
            dispatchSharedQueuedTasks();
            dispatchNextMainQueuedTask(employeeId);
          }, retryDelay));
        }
      }

      const emp = state.employees.get(employeeId);
      if (emp) {
        if (taskIds.includes(emp.mainTaskId ?? "")) setMainTask(employeeId, null, null);
        if (taskIds.includes(emp.queueTaskId ?? "")) setQueueTask(employeeId, null, null);
        broadcastToLeaders({ type: "employee.upsert", employee: emp });
      }
      for (const taskId of taskIds) {
        const task = state.tasks.get(taskId);
        if (task) broadcastToLeaders({ type: "task.upsert", task });
      }
      dispatchSharedQueuedTasks();
    }, graceMs);

    state.disconnectTimers.set(employeeId, timer);
  }

  function resumeAgentQueue(employeeId: string): { ok: true } | { ok: false; message: string } {
    const employee = state.employees.get(employeeId);
    if (!employee) {
      return { ok: false, message: "员工不存在。" };
    }
    state.consecutiveQueueFailures.set(employeeId, 0);
    state.failureTimestamps.delete(employeeId);
    state.queuePausedSet.delete(employeeId);
    const recovery = employee.queueRecovery;
    const retryTimer = recovery?.taskId ? retryDelays.get(recovery.taskId) : undefined;
    if (retryTimer) clearTimeout(retryTimer);
    if (recovery?.taskId) retryDelays.delete(recovery.taskId);
    employee.consecutiveQueueFailures = 0;
    employee.queuePaused = false;
    if (recovery) employee.queueRecovery = { ...recovery, phase: "probe", until: Date.now() };
    armRecovery(employee);
    upsertEmployee(employee);
    log.info({ employeeId }, "Agent queue resumed, failure count and pause state reset");
    const socket = state.agentSockets.get(employeeId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendJson<ServerToEmployeeMessage>(socket, { type: "queue.resume" }, ctx.encryptor);
    }
    dispatchSharedQueuedTasks();
    return { ok: true };
  }

  function pauseAgentQueue(employeeId: string): { ok: true } | { ok: false; message: string } {
    const employee = state.employees.get(employeeId);
    if (!employee) {
      return { ok: false, message: "员工不存在。" };
    }
    state.queuePausedSet.add(employeeId);
    employee.queuePaused = true;
    armRecovery(employee);
    upsertEmployee(employee);
    log.info({ employeeId }, "Agent queue paused");
    return { ok: true };
  }

  function resetAgentSession(employeeId: string): { ok: true } | { ok: false; message: string } {
    const socket = state.agentSockets.get(employeeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return { ok: false, message: "Agent 不在线。" };
    }
    if (state.employees.get(employeeId)?.mainTaskId) {
      return { ok: false, message: "Agent 正在执行主任务，请等待任务完成后再重置。" };
    }
    sendJson<ServerToEmployeeMessage>(socket, { type: "session.reset" }, ctx.encryptor);
    log.info({ employeeId }, "Session reset requested");
    return { ok: true };
  }

  function prioritizeTask(taskId: string): { ok: true; task: TaskRecord } | { ok: false; code: string; message: string } {
    const task = state.tasks.get(taskId);
    if (!task) {
      return { ok: false, code: "not_found", message: "任务不存在。" };
    }
    if (task.status !== "queued") {
      return { ok: false, code: "not_queued", message: "只有排队中的任务可以优先执行。" };
    }
    if (task.targetMode !== "queue") {
      return { ok: false, code: "not_shared_queue", message: "只有队列任务可以优先执行。" };
    }
    const queueIndex = state.sharedTaskQueue.indexOf(taskId);
    if (queueIndex === -1) {
      return { ok: false, code: "not_in_queue", message: "任务不在共享队列中。" };
    }
    const maxPriority = state.sharedTaskQueue.reduce((max, tid) => {
      const t = state.tasks.get(tid);
      return t ? Math.max(max, t.priority ?? 1) : max;
    }, 0);
    task.priority = Math.min(3, maxPriority + 1);
    upsertTask(task);
    removeFromSharedQueue(taskId, false);
    let insertAt = state.sharedTaskQueue.length;
    for (let i = 0; i < state.sharedTaskQueue.length; i++) {
      const existing = state.tasks.get(state.sharedTaskQueue[i]!);
      if (existing && task.priority >= (existing.priority ?? 1)) {
        insertAt = i;
        break;
      }
    }
    state.sharedTaskQueue.splice(insertAt, 0, taskId);
    notifySharedQueueWebhooks();
    log.info({ taskId, priority: task.priority }, "Task prioritized");
    return { ok: true, task };
  }

  return {
    async drainTaskWrites() {
      await Promise.all([...pendingWrites]);
    },
    finishTaskCleanup() {
      let cancellationRequests = 0;
      let offlineTasks = 0;
      webhookController.abort();
      webhookController = new AbortController();
      for (const employee of state.employees.values()) {
        const ids = new Set([employee.mainTaskId, employee.queueTaskId]);
        for (const task of state.tasks.values()) {
          if (task.employeeId === employee.id && !TERMINAL_STATUSES.has(task.status) && task.status !== "queued") ids.add(task.id);
        }
        for (const taskId of ids) {
          if (!taskId) continue;
          const socket = state.agentSockets.get(employee.id);
          if (socket?.readyState === WebSocket.OPEN) {
            requestOrphanCancellation(employee.id, taskId, socket);
            cancellationRequests++;
          } else offlineTasks++;
        }
        employee.mainTaskId = null;
        employee.mainTaskPrompt = null;
        employee.queueTaskId = null;
        employee.queueTaskPrompt = null;
        upsertEmployee(employee);
      }
      for (const timer of state.taskTimeouts.values()) clearTimeout(timer);
      state.taskTimeouts.clear();
      for (const timer of retryDelays.values()) clearTimeout(timer);
      retryDelays.clear();
      for (const timer of state.disconnectTimers.values()) clearTimeout(timer);
      state.disconnectTimers.clear();
      for (const timer of recoveryTimers.values()) clearTimeout(timer);
      recoveryTimers.clear();
      state.tasks.clear();
      state.taskLogs.clear();
      state.taskWebhooks.clear();
      state.sharedTaskQueue.length = 0;
      state.taskQueues.clear();
      state.mainTaskQueues.clear();
      deferredWrites = [];
      return { cancellationRequests, offlineTasks };
    },
    async resumeAfterTaskCleanup() {
      for (const employee of state.employees.values()) armRecovery(employee);
      const writes = deferredWrites;
      deferredWrites = [];
      for (const write of writes) writeTaskData(write);
      for (const { message, socket } of deferredMessages.splice(0)) {
        if (socket.readyState === WebSocket.OPEN) await handleAgentMessage(message, socket);
      }
      dispatchSharedQueuedTasks();
      for (const employee of state.employees.values()) dispatchNextMainQueuedTask(employee.id);
    },
    dispatchLeaderCommand,
    handleAgentMessage,
    handleLeaderMessage,
    cancelTaskById,
    patchTaskById,
    prioritizeTask,
    startDisconnectRecovery,
    resumeAgentQueue,
    pauseAgentQueue,
    resetAgentSession,
    cleanup() {
      closed = true;
      for (const timer of recoveryTimers.values()) clearTimeout(timer);
      recoveryTimers.clear();
      webhookController.abort();
      for (const timer of retryDelays.values()) {
        clearTimeout(timer);
      }
      retryDelays.clear();
    },
  };
}
