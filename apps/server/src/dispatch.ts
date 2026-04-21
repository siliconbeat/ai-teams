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
} from "@ai-teams/shared";
import type { Database, ServerState } from "./db.js";
import { persistEmployee, persistTask, persistTaskLog, persistTaskWebhook, persistSharedQueueCursor } from "./db.js";
import type { WebhookEventType } from "./schemas.js";

export const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timeout"]);

export function nowIso() {
  return new Date().toISOString();
}

export function sendJson<T>(socket: WebSocket, payload: T) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function extractDoneSessionId(content: string) {
  const match = content.match(/^\[done\]\s+session_id:\s*(\S+)/m);
  return match?.[1] ?? null;
}

export type DispatchContext = {
  state: ServerState;
  authToken: string;
  defaultTimeoutSec: number;
  maxLogChunksPerTask: number;
  disconnectGraceMs: number;
  db: Database;
  log: FastifyInstance["log"];
};

export function createDispatch(ctx: DispatchContext) {
  const { state, db, log } = ctx;

  function broadcastToLeaders(payload: ServerToLeaderMessage) {
    for (const socket of state.leaderSockets) {
      sendJson(socket, payload);
    }
  }

  function upsertEmployee(employee: EmployeeSnapshot) {
    state.employees.set(employee.id, employee);
    void persistEmployee(db, employee);
    broadcastToLeaders({ type: "employee.upsert", employee });
  }

  function upsertTask(task: TaskRecord) {
    state.tasks.set(task.id, task);
    void persistTask(db, task);
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
    void persistTaskLog(db, chunk, ctx.maxLogChunksPerTask);
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
      sendJson<ServerToEmployeeMessage>(socket, { type: "task.cancel", taskId: task.id });
    }
    current.status = "timeout";
    current.finishedAt = nowIso();
    current.error = `任务超过 ${task.timeoutSec} 秒未完成，已超时。`;
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
    if (!state.sharedTaskQueue.includes(taskId)) {
      state.sharedTaskQueue.push(taskId);
    }
  }

  function removeFromSharedQueue(taskId: string) {
    const index = state.sharedTaskQueue.indexOf(taskId);
    if (index !== -1) {
      state.sharedTaskQueue.splice(index, 1);
    }
  }

  function pickAvailableEmployeeIdForQueue() {
    const available = [...state.employees.values()]
      .filter((employee) => {
        const socket = state.agentSockets.get(employee.id);
        return employee.status === "online" && !employee.queueTaskId && socket?.readyState === WebSocket.OPEN;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    if (available.length === 0) {
      return null;
    }

    const employee = available[state.sharedQueueCursor % available.length];
    state.sharedQueueCursor = (state.sharedQueueCursor + 1) % Math.max(available.length, 1);
    void persistSharedQueueCursor(db, state.sharedQueueCursor);
    return employee.id;
  }

  function dispatchSharedQueuedTask(preferredEmployeeId?: string) {
    if (state.sharedTaskQueue.length === 0) {
      return;
    }

    const employeeId = preferredEmployeeId ?? pickAvailableEmployeeIdForQueue();
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
    });
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
      void persistTaskWebhook(db, task.id, webhookUrl);
    }
    upsertTask(task);
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
  ) {
    const leaderCommandId = randomUUID();
    if (message.atAgents === "queue") {
      return {
        ok: true as const,
        leaderCommandId,
        tasks: [createTask(null, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, "queue", webhookUrl, cliConfig)],
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
        createTask(employeeId, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, targetMode, webhookUrl, cliConfig),
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
      });
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
        break;
      case "task.started":
        task.status = "running";
        task.sessionId = message.sessionId ?? task.sessionId;
        task.startedAt = task.startedAt ?? nowIso();
        upsertTask(task);
        postTaskWebhook(task, "task.started");
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

  function handleLeaderMessage(message: LeaderToServerMessage, socket: WebSocket) {
    switch (message.type) {
      case "command.dispatch": {
        const result = dispatchLeaderCommand(message);
        if (!result.ok) {
          sendJson<ServerToLeaderMessage>(socket, {
            type: "command.error",
            code: result.code,
            message: result.message,
          });
        }
        break;
      }
      case "command.send":
        createTask(message.employeeId, message.prompt, message.workspace, message.timeoutSec, undefined, "direct");
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
      case "task.cancel": {
        const task = state.tasks.get(message.taskId);
        if (!task || TERMINAL_STATUSES.has(task.status)) {
          return;
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
          return;
        }
        if (!task.employeeId) {
          markTaskFailed(task.id, "任务尚未分配给员工，无法取消运行中的进程。");
          return;
        }
        const agentSocket = state.agentSockets.get(task.employeeId);
        if (!agentSocket) {
          markTaskFailed(task.id, "员工已离线，无法取消运行中的进程。");
          return;
        }
        sendJson<ServerToEmployeeMessage>(agentSocket, { type: "task.cancel", taskId: task.id });
        break;
      }
    }
  }

  return {
    dispatchLeaderCommand,
    handleAgentMessage,
    handleLeaderMessage,
  };
}
