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
} from "@ai-teams/shared";
import type { Database } from "./db.js";
import type { StateStore } from "./state-store.js";
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

function extractDoneSessionId(content: string) {
  const match = content.match(/^\[done\]\s+session_id:\s*(\S+)/m);
  return match?.[1] ?? null;
}

export type DispatchContext = {
  state: StateStore;
  authToken: string;
  defaultTimeoutSec: number;
  disconnectGraceMs: number;
  db: Database;
  log: FastifyInstance["log"];
  encryptor?: MaybeEncryptor;
  maxLogChunksPerTask: number;
  agentRegistrationMode: "open" | "approval";
  getAgentToken?: (socket: WebSocket) => string | null;
  hashAgentToken?: (token: string) => string;
};

export function createDispatch(ctx: DispatchContext) {
  const { state, db, log } = ctx;
  const retryDelays = new Map<string, NodeJS.Timeout>();

  function broadcastToLeaders(payload: ServerToLeaderMessage) {
    for (const socket of state.leaderSockets) {
      sendJson(socket, payload, ctx.encryptor);
    }
  }

  function upsertEmployee(employee: EmployeeSnapshot) {
    state.employees.set(employee.id, employee);
    persistEmployee(db, employee).catch((error) => log.error({ error, employeeId: employee.id }, "Failed to persist employee"));
    broadcastToLeaders({ type: "employee.upsert", employee });
  }

  function resetHeartbeatTimer(employeeId: string) {
    const existing = state.heartbeatTimers.get(employeeId);
    if (existing) clearTimeout(existing);
    state.heartbeatTimers.set(employeeId, setTimeout(() => {
      state.heartbeatTimers.delete(employeeId);
      const employee = state.employees.get(employeeId);
      if (!employee || employee.status === "offline") return;
      log.warn({ employeeId }, "Agent heartbeat timeout, marking offline");
      employee.status = "offline";
      upsertEmployee(employee);
      // Reclaim queue-slot tasks that haven't started running yet
      const queueTaskId = employee.queueTaskId;
      if (queueTaskId) {
        const task = state.tasks.get(queueTaskId);
        if (task && (task.status === "queued" || task.status === "dispatched")) {
          task.status = "queued";
          task.employeeId = null;
          task.startedAt = null;
          upsertTask(task);
          state.sharedTaskQueue.push(task.id);
          log.info({ taskId: task.id }, "Reclaimed queue task from unresponsive agent");
        }
      }
      setQueueTask(employeeId, null, null);
      dispatchSharedQueuedTasks();
    }, 30000));
  }

  function upsertTask(task: TaskRecord) {
    state.tasks.set(task.id, task);
    persistTask(db, task).catch((error) => log.error({ error, taskId: task.id }, "Failed to persist task"));
    broadcastToLeaders({ type: "task.upsert", task });
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
  ) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ai-teams-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return deliverWebhook(webhookUrl, body, signature, taskId, attempt + 1);
      }
      if (!response.ok) {
        log.warn({ taskId, webhookUrl, status: response.status, attempt }, "Task webhook returned non-2xx after retries");
      } else if (attempt > 1) {
        log.info({ taskId, webhookUrl, attempt }, "Task webhook succeeded on retry");
      }
    } catch (error) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return deliverWebhook(webhookUrl, body, signature, taskId, attempt + 1);
      }
      log.warn({ taskId, webhookUrl, error, attempt }, "Task webhook delivery failed after retries");
    }
  }

  function postTaskWebhook(task: TaskRecord, event: WebhookEventType, extra: Record<string, unknown> = {}) {
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

  const MAX_QUEUE_RETRY = 3;
  const MAX_CONSECUTIVE_QUEUE_FAILURES = 5;
  const AUTO_RESUME_MS = 10 * 60 * 1000; // 10 minutes

  function trackQueueFailure(employeeId: string) {
    const prev = state.consecutiveQueueFailures.get(employeeId) ?? 0;
    const next = prev + 1;
    state.consecutiveQueueFailures.set(employeeId, next);
    const emp = state.employees.get(employeeId);
    if (emp) {
      emp.consecutiveQueueFailures = next;
      upsertEmployee(emp);
    }
    if (next >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      state.failureTimestamps.set(employeeId, Date.now());
      log.warn({ employeeId, consecutiveFailures: next }, "Agent paused for queue tasks due to consecutive failures");
    }
  }

  function reEnqueueOrTerminalFail(task: TaskRecord, employeeId: string | null, error: string, options?: { clearSlot?: boolean; incrementRetry?: boolean }): true | false {
    if (task.retryCount < MAX_QUEUE_RETRY) {
      if (options?.incrementRetry !== false) {
        task.retryCount += 1;
      }
      task.status = "queued";
      task.employeeId = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.error = error;
      task.summary = task.summary ?? error;
      log.info({ taskId: task.id, retryCount: task.retryCount, error, previousEmployeeId: employeeId }, "Queue task re-enqueued after failure");
      upsertTask(task);
      if (employeeId && options?.clearSlot !== false) {
        setQueueTask(employeeId, null, null);
      }
      enqueueSharedTask(task.id);
      dispatchSharedQueuedTasks();
      return true;
    }
    return false;
  }

  function markTaskFailed(taskId: string, error: string) {
    const task = state.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    clearTaskTimeout(taskId);
    const employeeId = task.employeeId;
    const isQueueTask = task.targetMode === "queue";
    const wasRunning = task.status === "accepted" || task.status === "running";

    // Only count as consecutive failure if the task was actually running (not a dispatch rejection)
    if (isQueueTask && employeeId && wasRunning) {
      trackQueueFailure(employeeId);
    }

    if (isQueueTask && reEnqueueOrTerminalFail(task, employeeId, error, {
      clearSlot: wasRunning,
      incrementRetry: wasRunning,
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
    if (employeeId) {
      const isMainSlot = !isQueueTask;
      if (isMainSlot) {
        setMainTask(employeeId, null, null);
        dispatchNextMainQueuedTask(employeeId);
      } else {
        setQueueTask(employeeId, null, null);
        dispatchNextQueuedTask(employeeId);
      }
    } else {
      removeFromSharedQueue(task.id);
      dispatchSharedQueuedTasks();
    }
  }

  function appendTaskLog(chunk: TaskOutputChunk) {
    const task = state.tasks.get(chunk.taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    const doneSessionId = extractDoneSessionId(chunk.content);
    if (!task.sessionId && doneSessionId) {
      task.sessionId = doneSessionId;
      upsertTask(task);
    }
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    history.push(chunk);
    if (history.length > ctx.maxLogChunksPerTask) {
      const removed = history.splice(0, history.length - ctx.maxLogChunksPerTask);
      const cutoffSeq = removed[removed.length - 1]?.seq;
      if (cutoffSeq !== undefined) {
        deleteTaskLogsThroughSeq(db, chunk.taskId, cutoffSeq)
          .catch((error) => log.error({ error, taskId: chunk.taskId, cutoffSeq }, "Failed to prune task logs"));
      }
    }
    state.taskLogs.set(chunk.taskId, history);
    persistTaskLog(db, chunk).catch((error) => log.error({ error, taskId: chunk.taskId, seq: chunk.seq }, "Failed to persist task log"));
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

    // Timeout doesn't count as consecutive failure — the agent isn't broken, just slow
    // Don't clear slot — agent hasn't processed cancel yet

    if (isQueueTask && reEnqueueOrTerminalFail(current, employeeId, error, { clearSlot: false })) {
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
    if (employeeId) {
      const isMainSlot = !isQueueTask;
      if (isMainSlot) {
        setMainTask(employeeId, null, null);
        dispatchNextMainQueuedTask(employeeId);
      } else {
        setQueueTask(employeeId, null, null);
        dispatchNextQueuedTask(employeeId);
      }
    }
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
    const socket = state.agentSockets.get(employee.id);
    if (employee.status !== "online" || employee.queueTaskId || socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (state.queuePausedSet.has(employee.id)) {
      return false;
    }

    const failures = state.consecutiveQueueFailures.get(employee.id) ?? 0;
    if (failures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      const failureTs = state.failureTimestamps.get(employee.id);
      if (failureTs && (Date.now() - failureTs) > AUTO_RESUME_MS) {
        state.consecutiveQueueFailures.set(employee.id, 0);
        state.failureTimestamps.delete(employee.id);
        const emp = state.employees.get(employee.id);
        if (emp) {
          emp.consecutiveQueueFailures = 0;
          upsertEmployee(emp);
        }
        log.info({ employeeId: employee.id }, "Agent auto-resumed after timeout, failure count reset");
      } else {
        return false;
      }
    }

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
      if (preferredEmployeeId) {
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
    if (currentSlotTaskId && currentSlotTaskId !== task.id) {
      const queueMap = isQueueSlot ? state.taskQueues : state.mainTaskQueues;
      const queue = queueMap.get(assignedEmployeeId) ?? [];
      queue.push(task.id);
      queueMap.set(assignedEmployeeId, queue);
      return;
    }

    task.employeeId = assignedEmployeeId;
    task.status = "dispatched";
    log.info({ taskId: task.id, employeeId: assignedEmployeeId, targetMode: task.targetMode, prompt: task.prompt.slice(0, 80) }, "Task dispatched");
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
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    }, ctx.encryptor);
  }

  function dispatchNextQueuedTask(employeeId: string) {
    const employee = state.employees.get(employeeId);
    if (!employee || employee.queueTaskId || employee.status !== "online") {
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
    const task: TaskRecord = {
      id: randomUUID(),
      leaderCommandId: leaderCommandId ?? randomUUID(),
      employeeId,
      sessionId: sessionId ?? null,
      targetMode,
      prompt,
      workspace: workspace?.trim() || null,
      timeoutSec: timeoutSec ?? ctx.defaultTimeoutSec,
      cliConfig: (cliConfig && typeof cliConfig === "object" && !Array.isArray(cliConfig) ? cliConfig : null) as TaskRecord["cliConfig"],
      priority: priority ?? 1,
      requiredLabels: requiredLabels ?? null,
      status: "queued",
      retryCount: 0,
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
      persistTaskWebhook(db, task.id, webhookUrl).catch((error) => log.error({ error, taskId: task.id }, "Failed to persist task webhook"));
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
    if (!task || TERMINAL_STATUSES.has(task.status)) return;

    const socket = state.agentSockets.get(employeeId);
    if (!socket) {
      markTaskFailed(taskId, "员工重连时未恢复任务，且 socket 不可用。");
      return;
    }

    // Re-dispatch the task with sessionId for --resume
    task.status = "dispatched";
    log.info({ taskId: task.id, employeeId, sessionId: task.sessionId, prompt: task.prompt.slice(0, 80) }, "Re-dispatching task for session recovery");
    upsertTask(task);

    sendJson<ServerToEmployeeMessage>(socket, {
      type: "task.dispatch",
      taskId: task.id,
      leaderCommandId: task.leaderCommandId,
      employeeId,
      targetMode: task.targetMode,
      prompt: task.prompt,
      workspace: task.workspace,
      timeoutSec: task.timeoutSec,
      cliConfig: task.cliConfig,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    }, ctx.encryptor);

    // If agent doesn't recover within 120s, re-queue or fail
    const recoveryTimer = setTimeout(() => {
      const t = state.tasks.get(taskId);
      if (!t || TERMINAL_STATUSES.has(t.status) || t.status === "running" || t.status === "accepted") return;
      log.warn({ taskId, employeeId }, "Task recovery timed out after 120s, re-queuing");
      if (isQueueSlot) {
        t.status = "queued";
        t.employeeId = null;
        t.startedAt = null;
        upsertTask(t);
        if (isQueueSlot) {
          setQueueTask(employeeId, null, null);
        } else {
          setMainTask(employeeId, null, null);
        }
        enqueueSharedTask(t.id);
        dispatchSharedQueuedTasks();
      } else {
        markTaskFailed(taskId, "员工重连后 120s 未恢复任务，自动标记失败。");
      }
    }, 120_000);
    recoveryTimer.unref();
  }

  async function validateAgentRegistration(message: Extract<EmployeeToServerMessage, { type: "agent.register" }>, socket: WebSocket) {
    const now = nowIso();
    const registration = await getAgentRegistration(db, message.employeeId);
    if (ctx.agentRegistrationMode === "open") {
      await upsertAgentRegistration(db, {
        employeeId: message.employeeId,
        name: message.name,
        machineId: message.machineId,
        hostname: message.hostname,
        labels: message.labels,
        status: "approved",
        approvedAt: registration?.approvedAt ?? now,
        lastSeenAt: now,
      });
      return true;
    }

    if (!registration) {
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

    const agentToken = ctx.getAgentToken?.(socket);
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

    const previous = state.employees.get(message.employeeId);
    const previousMainTaskId = previous?.mainTaskId ?? null;
    const previousQueueTaskId = previous?.queueTaskId ?? null;
    const activeMainTaskId = message.activeMainTaskId ?? null;
    const activeQueueTaskId = message.activeQueueTaskId ?? null;

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

    state.agentSockets.set(message.employeeId, socket);
    state.socketToEmployeeId.set(socket, message.employeeId);

    let mainTaskId: string | null = null;
    let mainTaskPrompt: string | null = null;
    let queueTaskId: string | null = null;
    let queueTaskPrompt: string | null = null;

    // Resolve main slot
    if (previousMainTaskId && activeMainTaskId !== previousMainTaskId) {
      recoverOrFail(previousMainTaskId, message.employeeId, false);
    } else if (activeMainTaskId) {
      const activeTask = state.tasks.get(activeMainTaskId);
      if (activeTask && activeTask.employeeId === message.employeeId && !TERMINAL_STATUSES.has(activeTask.status)) {
        mainTaskId = activeTask.id;
        mainTaskPrompt = activeTask.prompt;
      }
    }

    // Resolve queue slot
    if (previousQueueTaskId && activeQueueTaskId !== previousQueueTaskId) {
      recoverOrFail(previousQueueTaskId, message.employeeId, true);
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
      version: message.version,
      claudeVersion: message.claudeVersion,
      permissionMode: message.permissionMode,
      weight: message.weight ?? 1,
    });

    sendJson<ServerToEmployeeMessage>(socket, {
      type: "agent.registered",
      consecutiveQueueFailures: state.consecutiveQueueFailures.get(message.employeeId) ?? 0,
    }, ctx.encryptor);

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

  async function handleAgentMessage(message: EmployeeToServerMessage, socket: WebSocket) {
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

    if (!taskBelongsToSocket(message.taskId, socketEmployeeId, socket)) {
      socket.close(1008, "task_owner_mismatch");
      return;
    }

    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }

    switch (message.type) {
      case "task.accepted":
        task.status = "accepted";
        upsertTask(task);
        log.info({ taskId: task.id, employeeId: socketEmployeeId }, "Task accepted");
        break;
      case "task.started":
        task.status = "running";
        task.sessionId = message.sessionId ?? task.sessionId;
        task.startedAt = task.startedAt ?? nowIso();
        upsertTask(task);
        postTaskWebhook(task, "task.started");
        log.info({ taskId: task.id, employeeId: socketEmployeeId, sessionId: task.sessionId, pid: message.pid }, "Task started");
        break;
      case "task.output":
        if (!task.employeeId) {
          return;
        }
        appendTaskLog({
          taskId: message.taskId,
          employeeId: task.employeeId,
          stream: message.stream,
          seq: message.seq,
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
          if (prev > 0) {
            state.consecutiveQueueFailures.set(task.employeeId, 0);
            const emp = state.employees.get(task.employeeId);
            if (emp) {
              emp.consecutiveQueueFailures = 0;
              upsertEmployee(emp);
            }
            log.info({ employeeId: task.employeeId }, "Consecutive queue failure count reset after successful task");
          }
        }
        if (task.employeeId) {
          const isMainSlot = task.targetMode !== "queue";
          if (isMainSlot) {
            setMainTask(task.employeeId, null, null);
            dispatchNextMainQueuedTask(task.employeeId);
          } else {
            setQueueTask(task.employeeId, null, null);
            dispatchNextQueuedTask(task.employeeId);
          }
        }
        break;
      case "task.failed":
        markTaskFailed(message.taskId, message.error);
        break;
      case "task.cancelled":
        if (task.status === "queued") {
          // Task was already re-enqueued (e.g., after timeout), just clear the slot
          log.info({ taskId: task.id, employeeId: task.employeeId }, "Task already re-enqueued, clearing slot from cancel response");
          if (task.employeeId) {
            setQueueTask(task.employeeId, null, null);
            dispatchNextQueuedTask(task.employeeId);
          }
          break;
        }
        task.status = "cancelled";
        clearTaskTimeout(task.id);
        task.finishedAt = nowIso();
        task.summary = "任务已取消。";
        log.info({ taskId: task.id, employeeId: task.employeeId }, "Task cancelled");
        upsertTask(task);
        postTaskWebhook(task, "task.cancelled");
        if (task.employeeId) {
          const isMainSlot = task.targetMode !== "queue";
          if (isMainSlot) {
            setMainTask(task.employeeId, null, null);
            dispatchNextMainQueuedTask(task.employeeId);
          } else {
            setQueueTask(task.employeeId, null, null);
            dispatchNextQueuedTask(task.employeeId);
          }
        }
        break;
    }
  }

  function cancelTaskById(taskId: string): { ok: true; task: TaskRecord } | { ok: false; code: string; message: string } {
    const task = state.tasks.get(taskId);
    if (!task) {
      return { ok: false, code: "not_found", message: "任务不存在。" };
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      return { ok: false, code: "already_terminal", message: `任务已处于终态 ${task.status}，无法取消。` };
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

    const timer = setTimeout(() => {
      state.disconnectTimers.delete(employeeId);
      if (state.agentSockets.has(employeeId)) return;

      for (const taskId of taskIds) {
        const task = state.tasks.get(taskId);
        if (!task || TERMINAL_STATUSES.has(task.status)) continue;

        clearTaskTimeout(taskId);
        task.employeeId = null;
        task.retryCount += 1;

        if (task.retryCount >= MAX_QUEUE_RETRY) {
          task.status = "failed";
          task.error = `任务重试次数超过上限（${MAX_QUEUE_RETRY}次），已终止。`;
          task.finishedAt = nowIso();
          upsertTask(task);
          log.warn({ taskId, employeeId, retryCount: task.retryCount }, "Task exceeded max retry count, marked failed");
          continue;
        }

        task.status = "queued";
        upsertTask(task);
        log.info({ taskId, employeeId, retryCount: task.retryCount }, "Task re-queued after disconnect grace period");

        if (task.targetMode === "queue") {
          enqueueSharedTask(taskId);
        } else {
          const queue = state.mainTaskQueues.get(employeeId) ?? [];
          if (!queue.includes(taskId)) queue.push(taskId);
          state.mainTaskQueues.set(employeeId, queue);
        }

        // Schedule delayed re-dispatch for subsequent retries
        if (task.retryCount > 1) {
          const retryDelay = (task.retryCount - 1) * 5000;
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
    }, ctx.disconnectGraceMs);

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
    employee.consecutiveQueueFailures = 0;
    employee.queuePaused = false;
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
      for (const timer of retryDelays.values()) {
        clearTimeout(timer);
      }
      retryDelays.clear();
    },
  };
}
