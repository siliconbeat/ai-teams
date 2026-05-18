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
import { persistEmployee, persistTask, persistTaskLog, persistTaskWebhook, persistSharedQueueCursor } from "./db.js";
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
  maxLogChunksPerTask: number;
  disconnectGraceMs: number;
  db: Database;
  log: FastifyInstance["log"];
  encryptor?: MaybeEncryptor;
};

export function createDispatch(ctx: DispatchContext) {
  const { state, db, log } = ctx;

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

  function markTaskFailed(taskId: string, error: string) {
    const task = state.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    clearTaskTimeout(taskId);
    task.status = "failed";
    task.error = error;
    task.summary = task.summary ?? error;
    task.finishedAt = nowIso();
    log.warn({ taskId, employeeId: task.employeeId, error }, "Task failed");
    upsertTask(task);
    postTaskWebhook(task, "task.failed");
    if (task.employeeId) {
      const employeeId = task.employeeId;
      const isMainSlot = task.targetMode !== "queue";
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
      history.splice(0, history.length - ctx.maxLogChunksPerTask);
    }
    state.taskLogs.set(chunk.taskId, history);
    persistTaskLog(db, chunk, ctx.maxLogChunksPerTask).catch((error) => log.error({ error, taskId: chunk.taskId, seq: chunk.seq }, "Failed to persist task log"));
    broadcastToLeaders({ type: "task.output", chunk });
    postTaskWebhook(task, "task.output", { chunk });
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
    current.status = "timeout";
    current.finishedAt = nowIso();
    current.error = `任务超过 ${task.timeoutSec} 秒未完成，已超时。`;
    log.warn({ taskId: task.id, employeeId: task.employeeId, timeoutSec: task.timeoutSec }, "Task timed out");
    current.summary = current.error;
    upsertTask(current);
    postTaskWebhook(current, "task.timeout");
    if (task.employeeId) {
      const isMainSlot = task.targetMode !== "queue";
      if (isMainSlot) {
        setMainTask(task.employeeId, null, null);
      } else {
        setQueueTask(task.employeeId, null, null);
      }
    }
    clearTaskTimeout(task.id);
    if (task.employeeId) {
      const isMainSlot = task.targetMode !== "queue";
      if (isMainSlot) {
        dispatchNextMainQueuedTask(task.employeeId);
      } else {
        dispatchNextQueuedTask(task.employeeId);
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
  }

  function removeFromSharedQueue(taskId: string) {
    const index = state.sharedTaskQueue.indexOf(taskId);
    if (index !== -1) {
      state.sharedTaskQueue.splice(index, 1);
    }
  }

  function pickAvailableEmployeeIdForQueue(requiredLabels?: string[]) {
    let available = [...state.employees.values()]
      .filter((employee) => {
        const socket = state.agentSockets.get(employee.id);
        if (employee.status !== "online" || employee.queueTaskId || socket?.readyState !== WebSocket.OPEN) {
          return false;
        }
        if (requiredLabels && requiredLabels.length > 0) {
          return requiredLabels.every((label) => employee.labels.includes(label));
        }
        return true;
      });

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

    // Among equally-loaded agents, use round-robin
    const minLoad = (available[0].mainTaskId ? 1 : 0) + (available[0].queueTaskId ? 1 : 0);
    const lightest = available.filter((e) => (e.mainTaskId ? 1 : 0) + (e.queueTaskId ? 1 : 0) === minLoad);

    const employee = lightest[state.sharedQueueCursor % lightest.length];
    state.sharedQueueCursor = (state.sharedQueueCursor + 1) % Math.max(lightest.length, 1);
    void persistSharedQueueCursor(db, state.sharedQueueCursor);
    return employee.id;
  }

  function dispatchSharedQueuedTask(preferredEmployeeId?: string) {
    if (state.sharedTaskQueue.length === 0) {
      return;
    }

    // Peek at the first valid task to get its requiredLabels for agent matching
    let firstTask: TaskRecord | null = null;
    for (const tid of state.sharedTaskQueue) {
      const t = state.tasks.get(tid);
      if (t && t.status === "queued") { firstTask = t; break; }
    }
    const requiredLabels = firstTask?.requiredLabels;

    const employeeId = preferredEmployeeId ?? pickAvailableEmployeeIdForQueue(requiredLabels);
    if (!employeeId) {
      return;
    }

    const employee = state.employees.get(employeeId);
    if (!employee || employee.queueTaskId || employee.status !== "online") {
      return;
    }

    while (state.sharedTaskQueue.length > 0) {
      const taskId = state.sharedTaskQueue.shift()!;
      const task = state.tasks.get(taskId);
      if (task && task.status === "queued" && task.targetMode === "queue") {
        dispatchTask(task, employeeId);
        return;
      }
    }
  }

  function dispatchSharedQueuedTasks() {
    for (let index = 0; index < state.employees.size && state.sharedTaskQueue.length > 0; index += 1) {
      const employeeId = pickAvailableEmployeeIdForQueue();
      if (!employeeId) {
        return;
      }
      dispatchSharedQueuedTask(employeeId);
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
  ) {
    const task: TaskRecord = {
      id: randomUUID(),
      leaderCommandId: leaderCommandId ?? randomUUID(),
      employeeId,
      sessionId: null,
      targetMode,
      prompt,
      workspace: workspace?.trim() || null,
      timeoutSec: timeoutSec ?? ctx.defaultTimeoutSec,
      cliConfig: (cliConfig && typeof cliConfig === "object" && !Array.isArray(cliConfig) ? cliConfig : null) as TaskRecord["cliConfig"],
      priority: priority ?? 1,
      requiredLabels: requiredLabels ?? null,
      status: "queued",
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
      return [...state.employees.values()].map((employee) => employee.id);
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
    if (message.atAgents === "queue") {
      return {
        ok: true as const,
        leaderCommandId,
        tasks: [createTask(null, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, "queue", webhookUrl, cliConfig, message.priority, message.requiredLabels)],
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
        createTask(employeeId, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, targetMode, webhookUrl, cliConfig, message.priority, message.requiredLabels),
      ),
    };
  }

  function handleRegister(message: Extract<EmployeeToServerMessage, { type: "agent.register" }>, socket: WebSocket) {
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

    state.agentSockets.set(message.employeeId, socket);
    state.socketToEmployeeId.set(socket, message.employeeId);

    let mainTaskId: string | null = null;
    let mainTaskPrompt: string | null = null;
    let queueTaskId: string | null = null;
    let queueTaskPrompt: string | null = null;

    // Resolve main slot
    if (previousMainTaskId && activeMainTaskId !== previousMainTaskId) {
      markTaskFailed(previousMainTaskId, "员工重连时未恢复原运行的主任务。");
    } else if (activeMainTaskId) {
      const activeTask = state.tasks.get(activeMainTaskId);
      if (activeTask && activeTask.employeeId === message.employeeId && !TERMINAL_STATUSES.has(activeTask.status)) {
        mainTaskId = activeTask.id;
        mainTaskPrompt = activeTask.prompt;
      }
    }

    // Resolve queue slot
    if (previousQueueTaskId && activeQueueTaskId !== previousQueueTaskId) {
      markTaskFailed(previousQueueTaskId, "员工重连时未恢复原运行的队列任务。");
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
    });

    if (!mainTaskId) {
      dispatchNextMainQueuedTask(message.employeeId);
    }
    if (!queueTaskId) {
      dispatchNextQueuedTask(message.employeeId);
    }
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

  function handleAgentMessage(message: EmployeeToServerMessage, socket: WebSocket) {
    if (message.type === "agent.register") {
      handleRegister(message, socket);
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

    if (!taskBelongsToSocket(message.taskId, socketEmployeeId, socket)) {
      socket.close(1008, "task_owner_mismatch");
      return;
    }

    const task = state.tasks.get(message.taskId);
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
        cancelTaskById(message.taskId);
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
        task.status = "queued";
        task.employeeId = null;
        upsertTask(task);
        log.info({ taskId, employeeId }, "Task re-queued after disconnect grace period");

        if (task.targetMode === "queue") {
          enqueueSharedTask(taskId);
        } else {
          const queue = state.mainTaskQueues.get(employeeId) ?? [];
          if (!queue.includes(taskId)) queue.push(taskId);
          state.mainTaskQueues.set(employeeId, queue);
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

  return {
    dispatchLeaderCommand,
    handleAgentMessage,
    handleLeaderMessage,
    cancelTaskById,
    startDisconnectRecovery,
  };
}
