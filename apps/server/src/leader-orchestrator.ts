import { randomUUID } from "node:crypto";
import {
  TERMINAL_STATUSES,
  type AgentTarget,
  type MissionApprovalPolicy,
  type MissionApprovalRecord,
  type MissionEventRecord,
  type MissionRecord,
  type MissionStatus,
  type MissionSubtaskRecord,
  type TaskCliConfig,
  type TaskRecord,
} from "@ai-teams/shared";
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import {
  addMissionSubtask,
  appendMissionEvent,
  countMissionSubtasks,
  createMission,
  createMissionApproval,
  getMissionApprovalById,
  getMissionById,
  listMissionApprovals,
  listMissionEvents,
  listMissions,
  listMissionSubtasks,
  persistMission,
  resolveMissionApproval,
  updateMissionFields,
  type MissionCreateInput,
} from "./db.js";
import { nowIso } from "./dispatch.js";
import type { StateStore } from "./state-store.js";

export type MissionCreateRequest = {
  objective: string;
  workspace?: string;
  approvalPolicy?: MissionApprovalPolicy;
  maxIterations?: number;
  maxTasks?: number;
  timeoutSec?: number;
  autoStart?: boolean;
};

export type MissionDetail = {
  mission: MissionRecord;
  events: MissionEventRecord[];
  subtasks: Array<MissionSubtaskRecord & { task: TaskRecord | null }>;
  approvals: MissionApprovalRecord[];
};

export type DispatchMissionTask = (
  message: {
    type: "command.dispatch";
    atAgents: AgentTarget;
    prompt: string;
    workspace?: string;
    timeoutSec?: number;
    priority?: number;
    requiredLabels?: string[];
  },
  webhookUrl?: string | null,
  cliConfig?: TaskCliConfig,
  priority?: number,
  requiredLabels?: string[] | null,
) => { ok: true; leaderCommandId: string; tasks: TaskRecord[] } | { ok: false; code: string; message: string };

type LeaderAction =
  | {
      type: "create_task";
      target: AgentTarget;
      prompt: string;
      role?: string;
      priority?: number;
      requiredLabels?: string[];
      cliConfig?: TaskCliConfig;
    }
  | { type: "ask_human"; question: string; options?: string[] }
  | { type: "finish_mission"; result: string }
  | { type: "fail_mission"; error: string };

type LeaderDecision = {
  summary: string;
  actions: LeaderAction[];
};

const ACTIVE_STATUSES = new Set<MissionStatus>(["created", "planning", "dispatching", "waiting_agents", "reviewing"]);
const RISK_KEYWORDS = [
  "生产",
  "部署",
  "发布",
  "删除",
  "迁移",
  "数据库",
  "权限",
  "密钥",
  "secret",
  "token",
  "credential",
  "production",
  "deploy",
  "migration",
];

export function createLeaderOrchestrator(options: {
  db: Database;
  state: StateStore;
  dispatchMissionTask: DispatchMissionTask;
  log: FastifyInstance["log"];
  pollMs?: number;
}) {
  const { db, state, dispatchMissionTask, log } = options;
  const running = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;

  async function recordEvent(missionId: string, type: string, payload: Record<string, unknown> = {}) {
    await appendMissionEvent(db, {
      id: randomUUID(),
      missionId,
      type,
      payload,
      createdAt: nowIso(),
    });
  }

  async function updateStatus(mission: MissionRecord, status: MissionStatus, fields: Partial<MissionRecord> = {}) {
    mission.status = status;
    mission.updatedAt = nowIso();
    Object.assign(mission, fields);
    await persistMission(db, mission);
    await recordEvent(mission.id, `mission.${status}`, {
      currentIteration: mission.currentIteration,
      result: fields.result,
      error: fields.error,
    });
  }

  async function create(input: MissionCreateRequest): Promise<MissionRecord> {
    const now = nowIso();
    const mission = await createMission(db, {
      id: randomUUID(),
      objective: input.objective.trim(),
      workspace: input.workspace?.trim() || null,
      approvalPolicy: input.approvalPolicy ?? "ask_on_risky_change",
      maxIterations: Math.max(1, Math.min(50, input.maxIterations ?? 6)),
      maxTasks: Math.max(1, Math.min(200, input.maxTasks ?? 20)),
      timeoutSec: input.timeoutSec && input.timeoutSec > 0 ? input.timeoutSec : null,
      createdAt: now,
    } satisfies MissionCreateInput);
    await recordEvent(mission.id, "mission.created", {
      objective: mission.objective,
      approvalPolicy: mission.approvalPolicy,
      maxIterations: mission.maxIterations,
      maxTasks: mission.maxTasks,
    });
    if (input.autoStart !== false) {
      kick(mission.id);
    }
    return mission;
  }

  async function detail(missionId: string): Promise<MissionDetail | null> {
    const mission = await getMissionById(db, missionId);
    if (!mission) return null;
    const [events, subtasks, approvals] = await Promise.all([
      listMissionEvents(db, missionId),
      listMissionSubtasks(db, missionId),
      listMissionApprovals(db, missionId),
    ]);
    return {
      mission,
      events,
      approvals,
      subtasks: subtasks.map((subtask) => ({
        ...subtask,
        task: state.tasks.get(subtask.taskId) ?? null,
      })),
    };
  }

  async function list(limit?: number) {
    return listMissions(db, limit);
  }

  async function cancel(missionId: string): Promise<MissionRecord | null> {
    const mission = await getMissionById(db, missionId);
    if (!mission) return null;
    if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
      return mission;
    }
    await updateStatus(mission, "cancelled", { completedAt: nowIso(), error: "Mission was cancelled." });
    return mission;
  }

  async function respondToApproval(approvalId: string, approved: boolean, response: string | null): Promise<MissionApprovalRecord | null> {
    const existing = await getMissionApprovalById(db, approvalId);
    if (!existing) return null;
    if (existing.status !== "pending") return existing;
    const resolved = await resolveMissionApproval(db, approvalId, approved ? "approved" : "rejected", response, nowIso());
    await recordEvent(existing.missionId, approved ? "approval.approved" : "approval.rejected", {
      approvalId,
      response,
    });
    const mission = await getMissionById(db, existing.missionId);
    if (mission && mission.status === "waiting_human") {
      if (approved) {
        await updateStatus(mission, "planning");
        kick(mission.id);
      } else {
        await updateStatus(mission, "cancelled", {
          error: response || "Human rejected the approval request.",
          completedAt: nowIso(),
        });
      }
    }
    return resolved ?? existing;
  }

  function latestPendingPlan(events: MissionEventRecord[]): LeaderDecision | null {
    const reversed = [...events].reverse();
    const event = reversed.find((item) => item.type === "leader.plan_pending");
    if (!event) return null;
    const executed = reversed.find((item) => item.type === "leader.plan_executed");
    if (executed && executed.createdAt >= event.createdAt) return null;
    const summary = typeof event.payload.summary === "string" ? event.payload.summary : "等待确认的执行计划";
    const actions = Array.isArray(event.payload.actions) ? parseLeaderActions(event.payload.actions) : [];
    return actions.length > 0 ? { summary, actions } : null;
  }

  async function hasApprovedPlan(missionId: string, after: string): Promise<boolean> {
    const approvals = await listMissionApprovals(db, missionId);
    return approvals.some((approval) => approval.status === "approved" && approval.resolvedAt && approval.resolvedAt >= after);
  }

  async function run(missionId: string) {
    if (state.clearingTasks || running.has(missionId)) return;
    running.add(missionId);
    try {
      let mission = await getMissionById(db, missionId);
      if (!mission || !ACTIVE_STATUSES.has(mission.status)) return;

      for (let guard = 0; guard < 8; guard += 1) {
        mission = await getMissionById(db, missionId);
        if (!mission || !ACTIVE_STATUSES.has(mission.status)) return;

        if (mission.currentIteration >= mission.maxIterations) {
          await updateStatus(mission, "failed", {
            error: `Mission reached maxIterations=${mission.maxIterations}.`,
            completedAt: nowIso(),
          });
          return;
        }

        const subtasks = await listMissionSubtasks(db, mission.id);
        const taskRecords = subtasks.map((subtask) => state.tasks.get(subtask.taskId)).filter(Boolean) as TaskRecord[];
        const openTasks = taskRecords.filter((task) => !TERMINAL_STATUSES.has(task.status));
        if (openTasks.length > 0) {
          if (mission.status !== "waiting_agents") {
            await updateStatus(mission, "waiting_agents", { currentIteration: mission.currentIteration });
          }
          return;
        }

        const events = await listMissionEvents(db, mission.id);
        const pendingPlan = latestPendingPlan(events);
        if (pendingPlan) {
          const planEvent = [...events].reverse().find((event) => event.type === "leader.plan_pending");
          if (planEvent && !(await hasApprovedPlan(mission.id, planEvent.createdAt))) {
            if (mission.status !== "waiting_human") {
              await createApproval(mission, "请确认 AI Leader 生成的下一轮执行计划。", ["approve", "reject"]);
            }
            return;
          }
          if (planEvent) {
            await recordEvent(mission.id, "leader.plan_executed", { planEventId: planEvent.id });
          }
          await executeDecision(mission, pendingPlan);
          return;
        }

        const decision = makeLeaderDecision(mission, taskRecords, events);
        await recordEvent(mission.id, "leader.decision", {
          summary: decision.summary,
          actions: decision.actions,
        });

        if (mission.approvalPolicy === "manual_each_iteration" && decision.actions.some((action) => action.type === "create_task")) {
          await recordEvent(mission.id, "leader.plan_pending", {
            summary: decision.summary,
            actions: decision.actions,
          });
          await createApproval(mission, "请确认 AI Leader 生成的下一轮执行计划。", ["approve", "reject"]);
          return;
        }

        await executeDecision(mission, decision);
      }
    } catch (error) {
      log.error({ error, missionId }, "Mission orchestrator failed");
      const mission = await getMissionById(db, missionId);
      if (mission && mission.status !== "cancelled" && mission.status !== "completed") {
        await updateStatus(mission, "failed", {
          error: error instanceof Error ? error.message : "Mission orchestrator failed.",
          completedAt: nowIso(),
        });
      }
    } finally {
      running.delete(missionId);
    }
  }

  function kick(missionId: string) {
    if (state.clearingTasks) return;
    setTimeout(() => void run(missionId), 0).unref();
  }

  async function scanActive() {
    const missions = await listMissions(db, 100);
    for (const mission of missions) {
      if (ACTIVE_STATUSES.has(mission.status)) {
        kick(mission.id);
      }
    }
  }

  function start() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void scanActive().catch((error) => log.error({ error }, "Mission scan failed"));
    }, options.pollMs ?? 500);
    pollTimer.unref();
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function createApproval(mission: MissionRecord, question: string, options: string[]) {
    const approval: MissionApprovalRecord = {
      id: randomUUID(),
      missionId: mission.id,
      status: "pending",
      question,
      options,
      response: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    await createMissionApproval(db, approval);
    await recordEvent(mission.id, "approval.requested", {
      approvalId: approval.id,
      question,
      options,
    });
    await updateStatus(mission, "waiting_human");
  }

  async function executeDecision(mission: MissionRecord, decision: LeaderDecision) {
    const actions = decision.actions;
    if (actions.length === 0) {
      await updateStatus(mission, "failed", { error: "Leader returned no actions.", completedAt: nowIso() });
      return;
    }
    for (const action of actions) {
      if (action.type === "ask_human") {
        await createApproval(mission, action.question, action.options?.length ? action.options : ["approve", "reject"]);
        return;
      }
      if (action.type === "finish_mission") {
        await updateStatus(mission, "completed", { result: action.result, completedAt: nowIso() });
        return;
      }
      if (action.type === "fail_mission") {
        await updateStatus(mission, "failed", { error: action.error, completedAt: nowIso() });
        return;
      }
    }

    const createActions = actions.filter((action): action is Extract<LeaderAction, { type: "create_task" }> => action.type === "create_task");
    if (createActions.length === 0) {
      return;
    }

    const existingTaskCount = await countMissionSubtasks(db, mission.id);
    if (existingTaskCount + createActions.length > mission.maxTasks) {
      await updateStatus(mission, "failed", {
        error: `Mission would exceed maxTasks=${mission.maxTasks}.`,
        completedAt: nowIso(),
      });
      return;
    }

    await updateStatus(mission, "dispatching");
    const nextIteration = mission.currentIteration + 1;
    for (const action of createActions) {
      const result = dispatchMissionTask(
        {
          type: "command.dispatch",
          atAgents: action.target,
          prompt: action.prompt,
          workspace: mission.workspace ?? undefined,
          timeoutSec: mission.timeoutSec ?? undefined,
          priority: action.priority,
          requiredLabels: action.requiredLabels,
        },
        null,
        action.cliConfig,
        action.priority,
        action.requiredLabels ?? null,
      );
      if (!result.ok) {
        await updateStatus(mission, "failed", {
          error: result.message,
          completedAt: nowIso(),
        });
        return;
      }
      for (const task of result.tasks) {
        await addMissionSubtask(db, {
          missionId: mission.id,
          taskId: task.id,
          iteration: nextIteration,
          role: action.role || "worker",
          createdAt: nowIso(),
        });
        await recordEvent(mission.id, "task.created", {
          taskId: task.id,
          leaderCommandId: result.leaderCommandId,
          role: action.role || "worker",
          target: action.target,
        });
      }
    }
    await updateMissionFields(db, mission.id, {
      status: "waiting_agents",
      currentIteration: nextIteration,
      updatedAt: nowIso(),
    });
    await recordEvent(mission.id, "mission.waiting_agents", { currentIteration: nextIteration });
  }

  return {
    async drain() {
      // Existing iterations may still be writing events after dispatch is paused.
      while (running.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    create,
    list,
    detail,
    cancel,
    respondToApproval,
    kick,
    start,
    stop,
  };
}

function parseLeaderActions(rawActions: unknown[]): LeaderAction[] {
  const actions: LeaderAction[] = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "create_task" && typeof item.prompt === "string") {
      const target = parseTarget(item.target);
      if (!target) continue;
      actions.push({
        type: "create_task",
        target,
        prompt: item.prompt,
        role: typeof item.role === "string" ? item.role : undefined,
        priority: typeof item.priority === "number" ? item.priority : undefined,
        requiredLabels: Array.isArray(item.requiredLabels) ? item.requiredLabels.filter((v): v is string => typeof v === "string") : undefined,
      });
    }
    if (item.type === "ask_human" && typeof item.question === "string") {
      actions.push({
        type: "ask_human",
        question: item.question,
        options: Array.isArray(item.options) ? item.options.filter((v): v is string => typeof v === "string") : undefined,
      });
    }
    if (item.type === "finish_mission" && typeof item.result === "string") {
      actions.push({ type: "finish_mission", result: item.result });
    }
    if (item.type === "fail_mission" && typeof item.error === "string") {
      actions.push({ type: "fail_mission", error: item.error });
    }
  }
  return actions;
}

function parseTarget(value: unknown): AgentTarget | null {
  if (value === "queue" || value === "all") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim())) {
    return [...new Set(value.map((item) => item.trim()))];
  }
  return null;
}

function makeLeaderDecision(mission: MissionRecord, tasks: TaskRecord[], events: MissionEventRecord[]): LeaderDecision {
  const completedTasks = tasks.filter((task) => task.status === "completed");
  const failedTasks = tasks.filter((task) => task.status === "failed" || task.status === "timeout");
  const hasReviewTask = events.some((event) => event.type === "task.created" && event.payload.role === "reviewer");
  const hasHumanApproval = events.some((event) => event.type === "approval.approved");
  const approvedFailureContinuation = hasHumanApproval && events.some((event) => {
    return event.type === "approval.requested" && typeof event.payload.question === "string" && event.payload.question.includes("失败");
  });
  const needsHumanApproval = completedTasks.some((task) => /NEEDS_HUMAN_APPROVAL|需要人类确认|需要人工确认/i.test(task.summary || ""));
  const approvedRiskContinuation = hasHumanApproval && events.some((event) => {
    return event.type === "approval.requested" && typeof event.payload.question === "string" && /风险|NEEDS_HUMAN_APPROVAL|确认/.test(event.payload.question);
  });

  if (tasks.length === 0 && !hasHumanApproval && mission.approvalPolicy === "ask_on_risky_change" && looksRisky(mission.objective)) {
    return {
      summary: "目标包含生产、权限、迁移或删除等高风险关键词，需要先确认执行边界。",
      actions: [
        {
          type: "ask_human",
          question: "该 Mission 可能涉及高风险操作。是否允许 AI Leader 继续拆分并派发分析/执行任务？",
          options: ["approve", "reject"],
        },
      ],
    };
  }

  if (failedTasks.length > 0 && approvedFailureContinuation) {
    if (!hasReviewTask) {
      return {
        summary: "人类已确认失败分支，继续派发失败复盘与补救建议任务。",
        actions: [
          {
            type: "create_task",
            target: "queue",
            role: "reviewer",
            priority: 3,
            prompt: buildFailureReviewPrompt(mission, tasks),
          },
        ],
      };
    }
    return {
      summary: "人类已确认失败分支，Mission 以部分结果结束。",
      actions: [
        {
          type: "finish_mission",
          result: buildMissionResult(mission, tasks),
        },
      ],
    };
  }

  if (failedTasks.length > 0) {
    return {
      summary: "部分子任务失败，需要人工确认是否继续。",
      actions: [
        {
          type: "ask_human",
          question: `Mission 中有 ${failedTasks.length} 个子任务失败或超时。请确认是否继续下一轮，或拒绝以取消 Mission。`,
          options: ["approve", "reject"],
        },
      ],
    };
  }

  if (needsHumanApproval && !approvedRiskContinuation) {
    return {
      summary: "子任务输出标记需要人工确认。",
      actions: [
        {
          type: "ask_human",
          question: "Agent 输出中包含 NEEDS_HUMAN_APPROVAL 或类似风险提示。是否允许 AI Leader 继续 Review/收尾？",
          options: ["approve", "reject"],
        },
      ],
    };
  }

  if (tasks.length === 0) {
    return {
      summary: "启动第一轮多 Agent 分析与执行。",
      actions: [
        {
          type: "create_task",
          target: "queue",
          role: "analyst",
          priority: 2,
          prompt: buildWorkerPrompt(mission, "分析当前目标，梳理可执行步骤、风险点和验证方式。不要修改代码，输出结构化建议。"),
        },
        {
          type: "create_task",
          target: "queue",
          role: "implementer",
          priority: 1,
          prompt: buildWorkerPrompt(mission, "在确保兼容旧功能和接口的前提下，执行可安全落地的改动，并说明已验证内容。如需高风险操作，请明确标记 NEEDS_HUMAN_APPROVAL。"),
        },
      ],
    };
  }

  if (completedTasks.length > 0 && !hasReviewTask) {
    return {
      summary: "第一轮执行完成，派发独立 Review/验证任务。",
      actions: [
        {
          type: "create_task",
          target: "queue",
          role: "reviewer",
          priority: 3,
          prompt: buildReviewPrompt(mission, completedTasks),
        },
      ],
    };
  }

  return {
    summary: "所有必要子任务已经完成，Mission 可以结束。",
    actions: [
      {
        type: "finish_mission",
        result: buildMissionResult(mission, tasks),
      },
    ],
  };
}

function looksRisky(objective: string) {
  const normalized = objective.toLowerCase();
  return RISK_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function buildWorkerPrompt(mission: MissionRecord, instruction: string) {
  return [
    "你是 AI Teams 中由 AI Leader 指派的执行 Agent。",
    `Mission ID: ${mission.id}`,
    `总目标: ${mission.objective}`,
    mission.workspace ? `工作目录: ${mission.workspace}` : "工作目录: 使用 Agent 默认 workspace",
    "",
    "你的职责:",
    instruction,
    "",
    "要求:",
    "- 保持旧版功能和接口兼容。",
    "- 每个结论必须说明验证方式。",
    "- 如果遇到需要人类确认的风险操作，输出 NEEDS_HUMAN_APPROVAL 并说明原因。",
  ].join("\n");
}

function buildReviewPrompt(mission: MissionRecord, completedTasks: TaskRecord[]) {
  const summaries = completedTasks.map((task, index) => {
    return `子任务 ${index + 1} (${task.id}, ${task.employeeId ?? "unassigned"}):\n${task.summary || task.prompt}`;
  }).join("\n\n");
  return [
    "你是 AI Teams 中由 AI Leader 指派的 Review Agent。",
    `Mission ID: ${mission.id}`,
    `总目标: ${mission.objective}`,
    "",
    "请基于以下子任务结果进行独立 Review:",
    summaries,
    "",
    "输出:",
    "- 是否满足目标。",
    "- 是否保持旧版功能和接口兼容。",
    "- 还需要补充哪些测试。",
    "- 如果需要人类确认，输出 NEEDS_HUMAN_APPROVAL。",
  ].join("\n");
}

function buildFailureReviewPrompt(mission: MissionRecord, tasks: TaskRecord[]) {
  const summaries = tasks.map((task, index) => {
    const result = task.summary || task.error || task.prompt;
    return `子任务 ${index + 1} (${task.id}, ${task.status}, ${task.employeeId ?? "unassigned"}):\n${result}`;
  }).join("\n\n");
  return [
    "你是 AI Teams 中由 AI Leader 指派的失败复盘 Agent。",
    `Mission ID: ${mission.id}`,
    `总目标: ${mission.objective}`,
    "",
    "以下子任务中存在失败或超时。人类已批准继续下一轮，请基于当前结果复盘并给出补救建议:",
    summaries,
    "",
    "输出:",
    "- 哪些目标已经完成，哪些没有完成。",
    "- 失败或超时的可能原因。",
    "- 推荐的下一步补救方式和验证方式。",
    "- 如果继续执行会有风险，输出 NEEDS_HUMAN_APPROVAL。",
  ].join("\n");
}

function buildMissionResult(mission: MissionRecord, tasks: TaskRecord[]) {
  const taskLines = tasks.map((task) => {
    return `- ${task.id} [${task.status}] ${task.employeeId ?? "unassigned"}: ${task.summary || task.error || task.prompt.slice(0, 160)}`;
  });
  return [`Mission 完成: ${mission.objective}`, "", ...taskLines].join("\n");
}
