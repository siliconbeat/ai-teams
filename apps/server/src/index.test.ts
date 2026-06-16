import fs from "node:fs";
import { createHmac } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAiTeamsServer, type AiTeamsServer } from "./index";
import type { ServerToEmployeeMessage, ServerToLeaderMessage } from "@ai-teams/shared";

const TOKEN = "test-token";

let tmpDir: string;
let server: AiTeamsServer;
let baseUrl: string;
let httpBaseUrl: string;
let sockets: WebSocket[];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-test-"));
  sockets = [];
  server = await createAiTeamsServer({
    authToken: TOKEN,
    dbPath: path.join(tmpDir, "ai-teams.db"),
    defaultTimeoutSec: 0.08,
    disconnectGraceMs: 80,
    agentRegistrationMode: "open",
    logger: false,
  });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${address.port}`;
  httpBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(sockets.map((socket) => closeSocket(socket)));
  await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 认证 ──────────────────────────────────────────────────────

describe("认证", () => {
  it("拒绝未认证的 WebSocket 连接", async () => {
    const rejected = new WebSocket(`${baseUrl}/ws/leader`);
    sockets.push(rejected);
    const close = await waitForClose(rejected);
    expect(close.code).toBe(1008);
  });

  it("接受带 token 的 WebSocket 连接", async () => {
    const leader = await connectLeader();
    expect(leader.readyState).toBe(WebSocket.OPEN);
  });

  it("Agent 注册时同步权限模式到快照", async () => {
    await connectAgent("alice", undefined, { permissionMode: "bypassPermissions" });
    const employee = server.buildSnapshot().employees.find((e) => e.id === "alice");
    expect(employee?.permissionMode).toBe("bypassPermissions");
  });

  it("Agent 注册后立即请求任务不会因为注册竞态被关闭", async () => {
    const agentToken = await createAgentRegistrationToken("race-agent");
    const socket = await connectWs(`${baseUrl}/ws/agent`);
    const registeredPromise = waitForWsMessage<ServerToEmployeeMessage>(
      socket,
      (message) => message.type === "agent.registered",
    );

    sendAgentRegister(socket, "race-agent", undefined, { agentToken });
    socket.send(JSON.stringify({ type: "agent.request_task", employeeId: "race-agent" }));

    await registeredPromise;
    await delay(50);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(server.buildSnapshot().employees).toContainEqual(
      expect.objectContaining({ id: "race-agent", status: "online" }),
    );
  });

  it("拒绝未认证的 REST 请求", async () => {
    const response = await fetch(`${httpBaseUrl}/api/snapshot`);
    expect(response.status).toBe(401);
  });

  it("接受 query 参数 token", async () => {
    const response = await fetch(`${httpBaseUrl}/api/snapshot?token=${TOKEN}`);
    expect(response.status).toBe(200);
  });

  it("Swagger 文档无需认证即可访问", async () => {
    const response = await fetch(`${httpBaseUrl}/docs/json`);
    expect(response.status).toBe(200);
    const openapi = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(openapi.openapi).toMatch(/^3\./);
    expect(openapi.paths["/api/tasks"]).toBeTruthy();
    expect(openapi.paths["/api/missions"]).toBeTruthy();
  });
});

describe("Agent 注册审批", () => {
  it("Agent 必须先在 Web 端添加，并且员工 ID 与 Agent Token 匹配才能注册", async () => {
    await Promise.all(sockets.map((socket) => closeSocket(socket)));
    sockets = [];
    await server.close();
    server = await createAiTeamsServer({
      authToken: TOKEN,
      dbPath: path.join(tmpDir, "approval.db"),
      defaultTimeoutSec: 0.08,
      disconnectGraceMs: 80,
      agentRegistrationMode: "approval",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    const unknownSocket = await connectWs(`${baseUrl}/ws/agent`);
    sendAgentRegister(unknownSocket, "secure-agent", undefined, { agentToken: "unregistered-token" });
    const unknownClose = await waitForClose(unknownSocket);
    expect(unknownClose).toMatchObject({ code: 1008, reason: "agent_not_registered" });

    const createRes = await fetch(`${httpBaseUrl}/api/agent-registry`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "secure-agent", name: "Secure Agent", labels: ["secure"] }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { agentToken: string };
    expect(createBody.agentToken.length).toBeGreaterThan(10);

    const rejectedNoAgentToken = await connectWs(`${baseUrl}/ws/agent`);
    sendAgentRegister(rejectedNoAgentToken, "secure-agent", undefined, { labels: ["secure"] });
    const noTokenClose = await waitForClose(rejectedNoAgentToken);
    expect(noTokenClose).toMatchObject({ code: 1008, reason: "agent_token_invalid" });

    const rejectedWrongAgentToken = await connectWs(`${baseUrl}/ws/agent`);
    sendAgentRegister(rejectedWrongAgentToken, "secure-agent", undefined, { labels: ["secure"], agentToken: "wrong-token" });
    const wrongTokenClose = await waitForClose(rejectedWrongAgentToken);
    expect(wrongTokenClose).toMatchObject({ code: 1008, reason: "agent_token_invalid" });

    const approved = await connectAgent("secure-agent", undefined, { labels: ["secure"], agentToken: createBody.agentToken });
    expect(approved.readyState).toBe(WebSocket.OPEN);
    expect(server.buildSnapshot().employees.some((e) => e.id === "secure-agent" && e.status === "online")).toBe(true);
  });
});

// ─── 健康检查 ──────────────────────────────────────────────────

describe("GET /health", () => {
  it("返回服务健康状态", async () => {
    const response = await fetch(`${httpBaseUrl}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; employees: number; tasks: number };
    expect(body.status).toBe("ok");
    expect(body.employees).toBe(0);
    expect(body.tasks).toBe(0);
  });

  it("默认数据库路径与 health 返回路径一致", async () => {
    await Promise.all(sockets.map((socket) => closeSocket(socket)));
    sockets = [];
    await server.close();

    const dataDir = path.join(tmpDir, "data-root");
    server = await createAiTeamsServer({
      authToken: TOKEN,
      dataDir,
      defaultTimeoutSec: 0.08,
      disconnectGraceMs: 80,
      agentRegistrationMode: "open",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address() as AddressInfo;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${httpBaseUrl}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dbPath: string };
    expect(body.dbPath).toBe(path.join(dataDir, "ai-teams.db"));
    expect(fs.existsSync(body.dbPath)).toBe(true);
  });
});

// ─── AI Leader Missions ─────────────────────────────────────────

describe("AI Leader Missions", () => {
  it("创建 Mission 后复用任务队列派发子任务，并在 Review 完成后结束", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");

    const response = await fetch(`${httpBaseUrl}/api/missions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        objective: "实现一个兼容旧接口的稳定性优化并测试",
        approvalPolicy: "auto",
        maxIterations: 4,
        maxTasks: 6,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { mission: { id: string; status: string }; subtasks: Array<{ taskId: string }> };
    const missionId = created.mission.id;

    await waitUntil(async () => (await getMission(missionId)).subtasks.length >= 2, 1000);
    let detail = await getMission(missionId);
    expect(detail.mission.status).toBe("waiting_agents");
    expect(detail.subtasks.map((s) => s.role).sort()).toEqual(["analyst", "implementer"]);

    for (const subtask of detail.subtasks) {
      const task = server.buildSnapshot().tasks.find((t) => t.id === subtask.taskId)!;
      const socket = task.employeeId === "alice" ? alice : bob;
      completeTask(socket, task.id, `${subtask.role} done`);
    }

    await waitUntil(async () => (await getMission(missionId)).subtasks.some((s) => s.role === "reviewer"), 1000);
    detail = await getMission(missionId);
    const review = detail.subtasks.find((s) => s.role === "reviewer")!;
    const reviewTask = server.buildSnapshot().tasks.find((t) => t.id === review.taskId)!;
    completeTask(reviewTask.employeeId === "alice" ? alice : bob, reviewTask.id, "review passed");

    await waitUntil(async () => (await getMission(missionId)).mission.status === "completed", 1000);
    detail = await getMission(missionId);
    expect(detail.mission.result).toContain("Mission 完成");
    expect(detail.subtasks).toHaveLength(3);
  });

  it("风险 Mission 会暂停等待人工确认，批准后继续派发任务", async () => {
    await connectAgent("alice");
    const response = await fetch(`${httpBaseUrl}/api/missions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        objective: "修改生产数据库迁移策略并删除旧表",
        approvalPolicy: "ask_on_risky_change",
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { mission: { id: string } };
    const missionId = created.mission.id;

    await waitUntil(async () => (await getMission(missionId)).mission.status === "waiting_human", 1000);
    let detail = await getMission(missionId);
    const approval = detail.approvals.find((item) => item.status === "pending");
    expect(approval).toBeTruthy();
    expect(detail.subtasks).toHaveLength(0);

    const approveResponse = await fetch(`${httpBaseUrl}/api/missions/${missionId}/approvals/${approval!.id}/respond`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(approveResponse.status).toBe(200);

    await waitUntil(async () => (await getMission(missionId)).subtasks.length >= 1, 1000);
    detail = await getMission(missionId);
    expect(detail.mission.status).toBe("waiting_agents");
    expect(detail.approvals.find((item) => item.id === approval!.id)?.status).toBe("approved");
  });

  it("子任务标记 NEEDS_HUMAN_APPROVAL 后请求确认，批准后继续完成", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const response = await fetch(`${httpBaseUrl}/api/missions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        objective: "验证失败审批流程",
        approvalPolicy: "auto",
        maxIterations: 4,
        maxTasks: 4,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { mission: { id: string } };
    const missionId = created.mission.id;

    await waitUntil(async () => (await getMission(missionId)).subtasks.length >= 2, 1000);
    const detail = await getMission(missionId);
    for (const [index, subtask] of detail.subtasks.entries()) {
      const task = server.buildSnapshot().tasks.find((t) => t.id === subtask.taskId)!;
      const socket = task.employeeId === "alice" ? alice : bob;
      completeTask(socket, subtask.taskId, index === 0 ? "NEEDS_HUMAN_APPROVAL: risky operation" : "worker done");
    }

    await waitUntil(async () => (await getMission(missionId)).mission.status === "waiting_human", 1000);
    const waiting = await getMission(missionId);
    const approval = waiting.approvals.find((item) => item.status === "pending")!;

    const approveResponse = await fetch(`${httpBaseUrl}/api/missions/${missionId}/approvals/${approval.id}/respond`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(approveResponse.status).toBe(200);

    await waitUntil(async () => (await getMission(missionId)).subtasks.some((s) => s.role === "reviewer"), 1000);
    const afterApproval = await getMission(missionId);
    const review = afterApproval.subtasks.find((s) => s.role === "reviewer")!;
    const reviewTask = server.buildSnapshot().tasks.find((t) => t.id === review.taskId)!;
    completeTask(reviewTask.employeeId === "alice" ? alice : bob, review.taskId, "review passed after approval");

    await waitUntil(async () => (await getMission(missionId)).mission.status === "completed", 1000);
  });

  it("子任务失败后批准继续会派发失败复盘任务，而不是直接结束", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const response = await fetch(`${httpBaseUrl}/api/missions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        objective: "验证失败后继续流程",
        approvalPolicy: "auto",
        maxIterations: 4,
        maxTasks: 6,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { mission: { id: string } };
    const missionId = created.mission.id;

    await waitUntil(async () => (await getMission(missionId)).subtasks.length >= 2, 1000);
    const detail = await getMission(missionId);
    for (const [index, subtask] of detail.subtasks.entries()) {
      if (index === 0) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await waitUntil(() => {
            const task = server.buildSnapshot().tasks.find((t) => t.id === subtask.taskId);
            return Boolean(task?.employeeId && task.status === "dispatched");
          }, 1000);
          const task = server.buildSnapshot().tasks.find((t) => t.id === subtask.taskId)!;
          const socket = task.employeeId === "alice" ? alice : bob;
          socket.send(JSON.stringify({ type: "task.started", taskId: subtask.taskId, pid: 123 }));
          socket.send(JSON.stringify({ type: "task.failed", taskId: subtask.taskId, error: `worker failed ${attempt}` }));
          await delay(20);
        }
      } else {
        const task = server.buildSnapshot().tasks.find((t) => t.id === subtask.taskId)!;
        const socket = task.employeeId === "alice" ? alice : bob;
        completeTask(socket, subtask.taskId, "worker done");
      }
    }

    await waitUntil(async () => (await getMission(missionId)).mission.status === "waiting_human", 1000);
    const waiting = await getMission(missionId);
    const approval = waiting.approvals.find((item) => item.status === "pending")!;
    const approveResponse = await fetch(`${httpBaseUrl}/api/missions/${missionId}/approvals/${approval.id}/respond`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(approveResponse.status).toBe(200);

    await waitUntil(async () => (await getMission(missionId)).subtasks.some((s) => s.role === "reviewer"), 1000);
    const afterApproval = await getMission(missionId);
    expect(afterApproval.mission.status).toBe("waiting_agents");
    const review = afterApproval.subtasks.find((s) => s.role === "reviewer")!;
    const reviewTask = server.buildSnapshot().tasks.find((t) => t.id === review.taskId)!;
    completeTask(reviewTask.employeeId === "alice" ? alice : bob, review.taskId, "failure review done");

    await waitUntil(async () => (await getMission(missionId)).mission.status === "completed", 1000);
  });
});

// ─── 任务 CRUD REST API ────────────────────────────────────────

describe("POST /api/tasks — 创建任务", () => {
  it("创建 queue 任务", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "queue task", atAgents: "queue" }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; tasks: Array<{ id: string; status: string; targetMode: string }> };
    expect(body.status).toBe("accepted");
    expect(body.tasks).toHaveLength(1);
    expect(["queued", "dispatched"]).toContain(body.tasks[0]!.status);
    expect(body.tasks[0]!.targetMode).toBe("queue");

    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);
  });

  it("创建 direct 任务", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "direct task", atAgents: ["alice"] }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; tasks: Array<{ targetMode: string }> };
    expect(body.tasks[0]!.targetMode).toBe("direct");

    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);
  });

  it("创建 broadcast 任务", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const aliceDispatch = waitForAgentDispatch(alice);
    const bobDispatch = waitForAgentDispatch(bob);

    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "broadcast task", atAgents: "all" }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; tasks: Array<{ targetMode: string }> };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.every((t) => t.targetMode === "broadcast")).toBe(true);

    const d1 = await aliceDispatch;
    const d2 = await bobDispatch;
    alice.send(JSON.stringify({ type: "task.completed", taskId: d1.taskId, exitCode: 0, summary: "done" }));
    bob.send(JSON.stringify({ type: "task.completed", taskId: d2.taskId, exitCode: 0, summary: "done" }));
    await delay(20);
  });

  it("拒绝空 prompt", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect([400, 500]).toContain(response.status);
  });

  it("目标员工全部离线时 direct 任务创建后标记 failed", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nobody here", atAgents: ["alice"] }),
    });
    // 任务创建成功(202)，但因为没有在线 agent 会立即失败
    expect(response.status).toBe(202);
    const body = (await response.json()) as { tasks: Array<{ id: string }> };
    await delay(20);
    const snapshot = server.buildSnapshot();
    const task = snapshot.tasks.find((t) => t.id === body.tasks[0]!.id);
    expect(task!.status).toBe("failed");
  });

  it("支持 cliConfig 参数", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "with config",
        atAgents: ["alice"],
        cliConfig: { model: "claude-sonnet-4-6", maxTurns: 5 },
      }),
    });

    const dispatch = await dispatchPromise;
    expect(dispatch.cliConfig).toEqual({ model: "claude-sonnet-4-6", maxTurns: 5 });

    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);
  });

  it("裁剪每个任务持久化日志，避免无限增长", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);
    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "log pruning", atAgents: ["alice"], timeoutSec: 2 }),
    });
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));
    for (let i = 1; i <= 405; i += 1) {
      agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: i, content: `chunk-${i}\n` }));
    }
    await waitUntil(() => (server.buildSnapshot().logs[dispatch.taskId] ?? []).length === 0, 20).catch(() => undefined);
    await delay(80);

    const response = await fetch(`${httpBaseUrl}/api/tasks/${dispatch.taskId}/output`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await response.json()) as { output: string };
    expect(body.output).not.toContain("chunk-1\n");
    expect(body.output).toContain("chunk-405\n");
  });
});

describe("GET /api/tasks — 查询任务列表", () => {
  it("返回空列表", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });

  it("按状态过滤", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "task1", atAgents: ["alice"] }),
    });
    await dispatchPromise;

    const response = await fetch(`${httpBaseUrl}/api/tasks?status=queued`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await response.json()) as { tasks: Array<{ status: string }> };
    expect(body.tasks.every((t) => t.status === "queued")).toBe(true);
  });

  it("按 employeeId 过滤", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const d1 = waitForAgentDispatch(alice);
    const d2 = waitForAgentDispatch(bob);

    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "for alice", atAgents: ["alice"] }),
    });
    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "for bob", atAgents: ["bob"] }),
    });
    await Promise.all([d1, d2]);

    const response = await fetch(`${httpBaseUrl}/api/tasks?employeeId=alice`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await response.json()) as { tasks: Array<{ employeeId: string | null }> };
    expect(body.tasks.every((t) => t.employeeId === "alice")).toBe(true);
  });

  it("支持 limit 和 offset 分页", async () => {
    const agent = await connectAgent("alice");

    for (let i = 0; i < 5; i++) {
      const d = waitForAgentDispatch(agent);
      await fetch(`${httpBaseUrl}/api/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: `task ${i}`, atAgents: ["alice"] }),
      });
      const dispatch = await d;
      agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: `done ${i}` }));
      await delay(20);
    }

    const page1 = await (await fetch(`${httpBaseUrl}/api/tasks?limit=2&offset=0`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { tasks: unknown[] };
    const page2 = await (await fetch(`${httpBaseUrl}/api/tasks?limit=2&offset=2`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { tasks: unknown[] };
    expect(page1.tasks).toHaveLength(2);
    expect(page2.tasks).toHaveLength(2);
  });
});

describe("GET /api/tasks/:taskId — 查询单个任务", () => {
  it("返回指定任务", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "find me", atAgents: ["alice"] }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    await dispatchPromise;

    const response = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const task = (await response.json()) as { id: string; prompt: string };
    expect(task.id).toBe(createBody.tasks[0]!.id);
    expect(task.prompt).toBe("find me");
  });

  it("404 返回不存在的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks/nonexistent-id`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/tasks/:taskId — 更新任务", () => {
  it("404 更新不存在的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks/nonexistent-id`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ timeoutSec: 600 }),
    });
    expect(response.status).toBe(404);
  });

  it("取消排队中的任务（通过 status 字段）", async () => {
    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cancel via patch", atAgents: "queue" }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    const taskId = createBody.tasks[0]!.id;

    const patchRes = await fetch(`${httpBaseUrl}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(patchRes.status).toBe(200);
  });

  it("404 更新不存在的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks/nonexistent-id`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ timeoutSec: 600 }),
    });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/tasks/:taskId — 删除任务", () => {
  it("删除终态任务", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "delete me", atAgents: ["alice"] }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);

    const response = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("拒绝删除非终态任务", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "running task", atAgents: ["alice"] }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    await dispatchPromise;

    const response = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(409);
  });

  it("404 删除不存在的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks/nonexistent-id`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

// ─── 取消任务 REST API ─────────────────────────────────────────

describe("POST /api/tasks/:taskId/cancel — 取消/终止任务", () => {
  it("取消排队中的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "queued task", atAgents: "queue" }),
    });
    const createBody = (await response.json()) as { tasks: Array<{ id: string }> };
    const taskId = createBody.tasks[0]!.id;

    const cancelRes = await fetch(`${httpBaseUrl}/api/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.status).toBe(200);
    const task = (await cancelRes.json()) as { status: string; summary: string };
    expect(task.status).toBe("cancelled");
    expect(task.summary).toContain("已取消");
  });

  it("取消运行中的任务（通知 Agent）", async () => {
    const agent = await connectAgent("alice");
    const cancelPromise = waitForWsMessage(
      agent,
      (msg: ServerToEmployeeMessage) => msg.type === "task.cancel",
    );
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "running task", atAgents: ["alice"], timeoutSec: 300 }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));
    await delay(20);

    const cancelRes = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.status).toBe(200);

    const cancelMsg = await cancelPromise;
    expect(cancelMsg.taskId).toBe(createBody.tasks[0]!.id);
  });

  it("Agent 离线时取消运行中任务标记为 failed", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "offline cancel", atAgents: ["alice"], timeoutSec: 300 }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));
    await delay(20);

    // Disconnect agent
    const closePromise = waitForClose(agent);
    agent.close();
    await closePromise;
    await waitUntil(() =>
      server.buildSnapshot().employees.some((e) => e.id === "alice" && e.status === "offline"),
    );

    const cancelRes = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.status).toBe(200);
    const task = (await cancelRes.json()) as { status: string };
    expect(task.status).toBe("failed");
  });

  it("404 取消不存在的任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/tasks/nonexistent-id/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("取消已完成的任务保持幂等成功", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "already done", atAgents: ["alice"] }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);

    const cancelRes = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json() as { status: string };
    expect(body.status).toBe("completed");
  });

  it("重复取消已取消的任务保持幂等成功", async () => {
    const createRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cancel twice", atAgents: "queue" }),
    });
    const createBody = (await createRes.json()) as { tasks: Array<{ id: string }> };

    await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const secondCancel = await fetch(`${httpBaseUrl}/api/tasks/${createBody.tasks[0]!.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(secondCancel.status).toBe(200);
    const body = await secondCancel.json() as { status: string };
    expect(body.status).toBe("cancelled");
  });
});

// ─── WebSocket 任务调度 ────────────────────────────────────────

describe("WebSocket 任务调度", () => {
  it("broadcast 分发给所有在线 Agent", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const aliceDispatch = waitForAgentDispatch(alice);
    const bobDispatch = waitForAgentDispatch(bob);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "all", prompt: "run all" }));

    expect((await aliceDispatch).prompt).toBe("run all");
    expect((await bobDispatch).prompt).toBe("run all");
  });

  it("broadcast 不会给已离线 Agent 创建失败任务", async () => {
    await connectAgent("alice");
    const bob = await connectAgent("bob");
    bob.close();
    await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === "bob" && e.status === "offline"));
    const leader = await connectLeader();

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "all", prompt: "online only" }));
    await delay(30);

    const matching = server.buildSnapshot().tasks.filter((task) => task.prompt === "online only");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.employeeId).toBe("alice");
  });

  it("direct 分发给指定 Agent", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const aliceDispatch = waitForAgentDispatch(alice);
    const bobUnexpected = waitForAgentDispatch(bob, 80).then(() => true, () => false);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "only alice" }));

    expect((await aliceDispatch).prompt).toBe("only alice");
    expect(await bobUnexpected).toBe(false);
  });

  it("queue 分发给空闲 Agent", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const dispatch1 = Promise.race([waitForAgentDispatch(alice), waitForAgentDispatch(bob)]);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "round 1" }));
    const first = await dispatch1;
    expect(first.targetMode).toBe("queue");

    const dispatch2 = Promise.race([waitForAgentDispatch(alice), waitForAgentDispatch(bob)]);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "round 2" }));
    const second = await dispatch2;
    expect(second.targetMode).toBe("queue");
  });

  it("queue 加权随机分配", async () => {
    // Run multiple rounds to verify weighted distribution statistically
    let aliceCount = 0;
    const rounds = 20;

    for (let r = 0; r < rounds; r++) {
      const alice = await connectAgent(`alice-r${r}`, undefined, { weight: 3 });
      const bob = await connectAgent(`bob-r${r}`, undefined, { weight: 1 });
      const leader = await connectLeader();

      leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: `weighted ${r}` }));
      await delay(30);

      const snap = server.buildSnapshot();
      const task = snap.tasks.find(t => t.prompt === `weighted ${r}`);
      if (task?.employeeId?.startsWith("alice")) aliceCount++;

      // cleanup
      alice.close();
      bob.close();
      leader.close();
      await delay(20);
    }

    // With weight 3:1, alice should get the majority (> 10/20)
    expect(aliceCount).toBeGreaterThan(rounds / 2);
  });

  it("优先执行不会让 priority 超过协议上限，并把同优先级任务放到队列前面", async () => {
    const firstRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "first max priority", atAgents: "queue", priority: 3 }),
    });
    const secondRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "second max priority", atAgents: "queue", priority: 3 }),
    });
    const firstBody = (await firstRes.json()) as { tasks: Array<{ id: string }> };
    const secondBody = (await secondRes.json()) as { tasks: Array<{ id: string }> };
    expect(firstBody.tasks[0]).toBeTruthy();
    expect(secondBody.tasks[0]).toBeTruthy();

    const prioritizeRes = await fetch(`${httpBaseUrl}/api/tasks/${secondBody.tasks[0]!.id}/prioritize`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(prioritizeRes.status).toBe(200);
    const prioritized = (await prioritizeRes.json()) as { priority: number };
    expect(prioritized.priority).toBe(3);

    const agentToken = await createAgentRegistrationToken("alice");
    const agent = await connectWs(`${baseUrl}/ws/agent`);
    const dispatchPromise = waitForAgentDispatch(agent);
    sendAgentRegister(agent, "alice", undefined, { agentToken });
    await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === "alice" && e.status === "online"));

    const dispatch = await dispatchPromise;
    expect(dispatch.prompt).toBe("second max priority");
  });

  it("优先任务标签不匹配时不会阻塞后续可执行队列任务", async () => {
    const gpuRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "gpu only", atAgents: "queue", priority: 3, requiredLabels: ["gpu"] }),
    });
    const cpuRes = await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cpu only", atAgents: "queue", priority: 1, requiredLabels: ["cpu"] }),
    });
    const gpuBody = (await gpuRes.json()) as { tasks: Array<{ id: string }> };
    const cpuBody = (await cpuRes.json()) as { tasks: Array<{ id: string }> };

    const prioritizeRes = await fetch(`${httpBaseUrl}/api/tasks/${gpuBody.tasks[0]!.id}/prioritize`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(prioritizeRes.status).toBe(200);

    const agentToken = await createAgentRegistrationToken("cpu-agent", { labels: ["cpu"] });
    const agent = await connectWs(`${baseUrl}/ws/agent`);
    const dispatchPromise = waitForAgentDispatch(agent);
    sendAgentRegister(agent, "cpu-agent", undefined, { labels: ["cpu"], agentToken });
    await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === "cpu-agent" && e.status === "online"));

    const dispatch = await dispatchPromise;
    expect(dispatch.prompt).toBe("cpu only");

    const snapshot = server.buildSnapshot();
    expect(snapshot.tasks.find((t) => t.id === gpuBody.tasks[0]!.id)?.status).toBe("queued");
    expect(snapshot.tasks.find((t) => t.id === cpuBody.tasks[0]!.id)?.status).toBe("dispatched");
  });

  it("服务重启后按 priority 恢复共享队列顺序", async () => {
    const dbPath = path.join(tmpDir, "restart-order.db");
    await Promise.all(sockets.map((socket) => closeSocket(socket)));
    sockets = [];
    await server.close();
    server = await createAiTeamsServer({
      authToken: TOKEN,
      dbPath,
      defaultTimeoutSec: 2,
      disconnectGraceMs: 80,
      agentRegistrationMode: "open",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    let address = server.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "low priority after restart", atAgents: "queue", priority: 0 }),
    });
    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "high priority after restart", atAgents: "queue", priority: 3 }),
    });
    await delay(30);
    await server.close();

    server = await createAiTeamsServer({
      authToken: TOKEN,
      dbPath,
      defaultTimeoutSec: 2,
      disconnectGraceMs: 80,
      agentRegistrationMode: "open",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    address = server.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    const agentToken = await createAgentRegistrationToken("restart-agent");
    const agent = await connectWs(`${baseUrl}/ws/agent`);
    const dispatchPromise = waitForAgentDispatch(agent);
    sendAgentRegister(agent, "restart-agent", undefined, { agentToken });
    await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === "restart-agent" && e.status === "online"));
    const dispatch = await dispatchPromise;
    expect(dispatch.prompt).toBe("high priority after restart");
  });

  it("服务重启后清理员工快照里的已重排槽位", async () => {
    const dbPath = path.join(tmpDir, "restart-stale-slot.db");
    await Promise.all(sockets.map((socket) => closeSocket(socket)));
    sockets = [];
    await server.close();
    server = await createAiTeamsServer({
      authToken: TOKEN,
      dbPath,
      defaultTimeoutSec: 2,
      disconnectGraceMs: 80,
      agentRegistrationMode: "open",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    let address = server.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    const agent = await connectAgent("stale-agent");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "stale slot after restart", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    expect(server.buildSnapshot().employees.find((e) => e.id === "stale-agent")?.queueTaskId).toBe(dispatch.taskId);

    await Promise.all(sockets.map((socket) => closeSocket(socket)));
    sockets = [];
    await server.close();

    server = await createAiTeamsServer({
      authToken: TOKEN,
      dbPath,
      defaultTimeoutSec: 2,
      disconnectGraceMs: 80,
      agentRegistrationMode: "open",
      logger: false,
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    address = server.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
    httpBaseUrl = `http://127.0.0.1:${address.port}`;

    const snapshot = server.buildSnapshot();
    expect(snapshot.employees.find((e) => e.id === "stale-agent")?.queueTaskId).toBeNull();
    expect(snapshot.tasks.find((t) => t.id === dispatch.taskId)?.status).toBe("queued");
  });

  it("WebSocket task.cancel 取消运行中的任务", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "cancel via ws", timeoutSec: 300 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));

    const cancelPromise = waitForWsMessage(agent, (msg: ServerToEmployeeMessage) => msg.type === "task.cancel");
    leader.send(JSON.stringify({ type: "task.cancel", taskId: dispatch.taskId }));
    const cancelMsg = await cancelPromise;
    expect(cancelMsg.taskId).toBe(dispatch.taskId);
  });

  it("WebSocket 取消排队中的任务", async () => {
    const leader = await connectLeader();
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "cancel queued" }));
    await delay(20);

    const snapshot = server.buildSnapshot();
    const queuedTask = snapshot.tasks.find((t) => t.prompt === "cancel queued");
    expect(queuedTask).toBeTruthy();

    leader.send(JSON.stringify({ type: "task.cancel", taskId: queuedTask!.id }));
    await delay(20);

    const updated = server.buildSnapshot().tasks.find((t) => t.id === queuedTask!.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("WebSocket 取消不存在任务会返回 command.error", async () => {
    const leader = await connectLeader();
    const errorPromise = waitForLeaderMessage(leader, (message) => message.type === "command.error");
    leader.send(JSON.stringify({ type: "task.cancel", taskId: "missing-task" }));
    const error = await errorPromise;
    expect(error.code).toBe("not_found");
  });
});

// ─── 任务生命周期 ──────────────────────────────────────────────

describe("任务生命周期", () => {
  it("完整生命周期：queued → dispatched → accepted → running → completed", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const sessionId = "session-lifecycle-1";

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "full lifecycle" }));
    const dispatch = await dispatchPromise;

    const acceptedPromise = waitForLeaderMessage(leader, (m) => m.type === "task.upsert" && m.task.id === dispatch.taskId && m.task.status === "accepted");
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    await acceptedPromise;

    const runningPromise = waitForLeaderMessage(leader, (m) => m.type === "task.upsert" && m.task.id === dispatch.taskId && m.task.status === "running");
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123, sessionId }));
    await runningPromise;

    const outputPromise = waitForLeaderMessage(leader, (m) => m.type === "task.output" && m.chunk.content === "hello world");
    agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: 1, content: "hello world" }));
    await outputPromise;

    const completedPromise = waitForLeaderMessage(leader, (m) => m.type === "task.upsert" && m.task.id === dispatch.taskId && m.task.status === "completed");
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "all done", durationMs: 1500, numTurns: 3 }));
    const completed = await completedPromise;

    expect(completed.task.sessionId).toBe(sessionId);
    expect(completed.task.durationMs).toBe(1500);
    expect(completed.task.numTurns).toBe(3);
    expect(completed.task.summary).toBe("all done");
  });

  it("任务启动时刷新 Agent 的 Claude Code 版本号", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "refresh claude version" }));
    const dispatch = await dispatchPromise;

    const employeePromise = waitForLeaderMessage(leader, (m) => {
      return m.type === "employee.upsert" && m.employee.id === "alice" && m.employee.claudeVersion === "9.9.9";
    });
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1, claudeVersion: "9.9.9" }));
    const employeeUpdate = await employeePromise;

    expect(employeeUpdate.employee.claudeVersion).toBe("9.9.9");
    expect(server.buildSnapshot().employees.find((e) => e.id === "alice")?.claudeVersion).toBe("9.9.9");
  });

  it("失败生命周期：任务出错时标记 failed", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "will fail" }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));

    const failedPromise = waitForLeaderMessage(leader, (m) => m.type === "task.upsert" && m.task.id === dispatch.taskId && m.task.status === "failed");
    agent.send(JSON.stringify({ type: "task.failed", taskId: dispatch.taskId, error: "something broke" }));
    const failed = await failedPromise;

    expect(failed.task.error).toBe("something broke");
    expect(failed.task.status).toBe("failed");
  });

  it("queue 任务最终失败后释放队列槽位", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    let dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue fails finally", timeoutSec: 2 }));
    let dispatch = await dispatchPromise;
    const taskId = dispatch.taskId;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      agent.send(JSON.stringify({ type: "task.started", taskId, pid: attempt + 1 }));
      if (attempt < 3) {
        dispatchPromise = waitForAgentDispatch(agent);
        agent.send(JSON.stringify({ type: "task.failed", taskId, error: `failed ${attempt}` }));
        dispatch = await dispatchPromise;
        expect(dispatch.taskId).toBe(taskId);
      } else {
        agent.send(JSON.stringify({ type: "task.failed", taskId, error: "failed finally" }));
      }
    }

    await waitUntil(() => {
      const snapshot = server.buildSnapshot();
      const task = snapshot.tasks.find((t) => t.id === taskId);
      const alice = snapshot.employees.find((e) => e.id === "alice");
      return task?.status === "failed" && alice?.queueTaskId === null;
    }, 800);
  });

  it("超时后标记 timeout 且忽略迟到完成事件", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "timeout test" }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));

    await waitForLeaderMessage(
      leader,
      (m) => m.type === "task.upsert" && m.task.id === dispatch.taskId && m.task.status === "timeout",
      500,
    );

    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "late" }));
    await delay(30);
    expect(server.buildSnapshot().tasks.find((t) => t.id === dispatch.taskId)?.status).toBe("timeout");
  });

  it("queue 任务超时重排后接受原 Agent 的取消回执且不断开连接", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue timeout ack", timeoutSec: 0.03 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));

    await waitUntil(() => server.buildSnapshot().tasks.some((task) => task.id === dispatch.taskId && task.status === "queued"), 500);
    const closed = waitForClose(agent, 80).then(() => true, () => false);
    agent.send(JSON.stringify({ type: "task.cancelled", taskId: dispatch.taskId }));
    expect(await closed).toBe(false);
    expect(agent.readyState).toBe(WebSocket.OPEN);
  });

  it("Agent 完成后释放员工槽位", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const dispatchPromise = waitForAgentDispatch(agent);

    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "slot test" }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1 }));

    const alice = server.buildSnapshot().employees.find((e) => e.id === "alice")!;
    expect(alice.mainTaskId).toBe(dispatch.taskId);

    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));
    await delay(20);

    const after = server.buildSnapshot().employees.find((e) => e.id === "alice")!;
    expect(after.mainTaskId).toBeNull();
  });
});

// ─── 会话历史 ──────────────────────────────────────────────────

describe("GET /api/sessions/:sessionId/history", () => {
  it("返回完整的会话消息流", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const sessionId = "history-session-1";

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "history test" }));
    const dispatch = await dispatchPromise;

    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 1, sessionId }));
    agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: 1, content: "output chunk" }));
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "final result" }));
    await delay(30);

    const response = await fetch(`${httpBaseUrl}/api/sessions/${sessionId}/history`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const history = (await response.json()) as {
      sessionId: string;
      tasks: Array<{ id: string }>;
      messages: Array<{ type: string; role: string; content: string }>;
    };
    expect(history.sessionId).toBe(sessionId);
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task.prompt", role: "user", content: "history test" }),
        expect.objectContaining({ type: "task.output", role: "assistant", content: "output chunk" }),
        expect.objectContaining({ type: "task.result", role: "assistant", content: "final result" }),
      ]),
    );
  });
});

// ─── 断线恢复 ──────────────────────────────────────────────────

describe("断线恢复", () => {
  it("宽限期内重连恢复任务", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "long task", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    const firstClose = waitForClose(agent);
    agent.close();
    await firstClose;
    await waitUntil(() =>
      server.buildSnapshot().employees.some((e) => e.id === "alice" && e.status === "offline"),
    );

    const recovered = await connectAgent("alice", dispatch.taskId);
    await delay(20);
    await waitUntil(() =>
      server.buildSnapshot().employees.some((e) => e.id === "alice" && e.status === "online"),
    );
    expect(recovered.readyState).toBe(WebSocket.OPEN);
    expect(server.buildSnapshot().tasks.find((t) => t.id === dispatch.taskId)?.status).toBe("running");
  });

  it("断线后宽限期内任务保留，超时后重新入队", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "will timeout", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    const closePromise = waitForClose(agent);
    agent.close();
    await closePromise;

    // Wait for server to process the disconnect
    await waitUntil(
      () => server.buildSnapshot().employees.find((e) => e.id === "alice")?.status === "offline",
      500,
    );

    // Within grace period (80ms), task should still be running
    const snapshotAfterDisconnect = server.buildSnapshot();
    const taskAfterDisconnect = snapshotAfterDisconnect.tasks.find((t) => t.id === dispatch.taskId);
    expect(taskAfterDisconnect?.status).toBe("running");

    // After grace period, task should be re-queued
    await waitUntil(
      () => server.buildSnapshot().tasks.some((t) => t.id === dispatch.taskId && t.status === "queued"),
      500,
    );
  });
});

// ─── 断线任务恢复 ────────────────────────────────────────────────

describe("断线任务恢复", () => {
  it("宽限期内重连恢复任务", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "resume task", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    const closePromise = waitForClose(agent);
    agent.close();
    await closePromise;

    // Reconnect within grace period (80ms) reporting the same active task
    await delay(10);
    const recovered = await connectAgent("alice", dispatch.taskId);
    await delay(20);
    await waitUntil(() =>
      server.buildSnapshot().employees.some((e) => e.id === "alice" && e.status === "online"),
    );
    expect(recovered.readyState).toBe(WebSocket.OPEN);
    expect(server.buildSnapshot().tasks.find((t) => t.id === dispatch.taskId)?.status).toBe("running");
  });

  it("宽限期过后队列任务重新入队，其他 Agent 可接手", async () => {
    const alice = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(alice);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "reassign task", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    alice.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    const closePromise = waitForClose(alice);
    alice.close();
    await closePromise;

    // Wait for grace period to expire and task to be re-queued
    await waitUntil(
      () => server.buildSnapshot().tasks.some((t) => t.id === dispatch.taskId && t.status === "queued"),
      500,
    );

    // Bob comes online and should get the re-queued task from shared queue
    const bob = await connectAgent("bob");
    await delay(20);
    const snapshot = server.buildSnapshot();
    expect(snapshot.tasks.find((t) => t.id === dispatch.taskId)?.status).toBe("dispatched");
  });

  it("直接任务断线后回到员工个人队列", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "direct task", timeoutSec: 2 }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    const closePromise = waitForClose(agent);
    agent.close();
    await closePromise;

    // Wait for grace period to expire
    await waitUntil(
      () => server.buildSnapshot().tasks.some((t) => t.id === dispatch.taskId && t.status === "queued"),
      500,
    );

    // Verify task is queued but not in shared queue (targetMode is direct)
    const task = server.buildSnapshot().tasks.find((t) => t.id === dispatch.taskId);
    expect(task?.targetMode).toBe("direct");
  });
});

describe("双槽位并行", () => {
  it("main 和 queue 槽位可同时运行", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const mainDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "main task" }));
    const mainTask = await mainDispatch;
    expect(mainTask.targetMode).toBe("direct");

    const queueDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue task" }));
    const queueTask = await queueDispatch;
    expect(queueTask.targetMode).toBe("queue");

    const snapshot = server.buildSnapshot();
    const alice = snapshot.employees.find((e) => e.id === "alice")!;
    expect(alice.mainTaskId).toBe(mainTask.taskId);
    expect(alice.queueTaskId).toBe(queueTask.taskId);
  });

  it("完成后释放槽位", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const mainDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "main task" }));
    const mainTask = await mainDispatch;

    const queueDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue task" }));
    const queueTask = await queueDispatch;

    agent.send(JSON.stringify({ type: "task.completed", taskId: mainTask.taskId, exitCode: 0, summary: "main done" }));
    await delay(20);
    const afterMain = server.buildSnapshot().employees.find((e) => e.id === "alice")!;
    expect(afterMain.mainTaskId).toBeNull();
    expect(afterMain.queueTaskId).toBe(queueTask.taskId);

    agent.send(JSON.stringify({ type: "task.completed", taskId: queueTask.taskId, exitCode: 0, summary: "queue done" }));
    await delay(20);
    const afterQueue = server.buildSnapshot().employees.find((e) => e.id === "alice")!;
    expect(afterQueue.mainTaskId).toBeNull();
    expect(afterQueue.queueTaskId).toBeNull();
  });

  it("员工槽位满时新任务排队等待", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const mainDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "main task" }));
    await mainDispatch;

    const queueDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue task" }));
    await queueDispatch;

    // Both slots occupied, send another direct task — should be queued
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "waiting task" }));
    await delay(20);
    const snapshot = server.buildSnapshot();
    const waitingTask = snapshot.tasks.find((t) => t.prompt === "waiting task");
    expect(waitingTask).toBeTruthy();
    expect(waitingTask!.status).toBe("queued");
  });
});

// ─── 安全 ──────────────────────────────────────────────────────

describe("安全", () => {
  it("Agent 不能上报其他员工的任务", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(alice);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "owned" }));
    const dispatch = await dispatchPromise;

    bob.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 999 }));
    const close = await waitForClose(bob);
    expect(close.code).toBe(1008);
  });

  it("未注册的 Agent 发送任务事件被关闭连接", async () => {
    const socket = await connectWs(`${baseUrl}/ws/agent`);
    socket.send(JSON.stringify({ type: "task.accepted", taskId: "fake-id" }));
    const close = await waitForClose(socket);
    expect(close.code).toBe(1008);
  });

  it("未匹配的 Agent Token 被拒绝", async () => {
    await createAgentRegistrationToken("token-check-agent");
    const socket = await connectWs(`${baseUrl}/ws/agent`);
    sendAgentRegister(socket, "token-check-agent", undefined, { agentToken: "wrong-token" });
    const close = await waitForClose(socket);
    expect(close).toMatchObject({ code: 1008, reason: "agent_token_invalid" });
  });
});

// ─── Webhook 回调 ──────────────────────────────────────────────

describe("Webhook 回调", () => {
  it("完整生命周期触发 webhook 事件并携带 HMAC 签名", async () => {
    const agent = await connectAgent("alice");
    const webhook = await startWebhookServer();

    try {
      const dispatchPromise = waitForAgentDispatch(agent);
      const response = await fetch(`${httpBaseUrl}/api/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ atAgents: ["alice"], prompt: "webhook test", webhook: webhook.url }),
      });
      expect(response.status).toBe(202);

      const dispatch = await dispatchPromise;
      agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));
      agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: 1, content: "output" }));
      agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));

      await waitUntil(() => webhook.events.some((e) => e.event === "task.completed"), 500);
      expect(webhook.events.map((e) => e.event)).toEqual(
        expect.arrayContaining(["task.started", "task.output", "task.completed"]),
      );

      for (const event of webhook.events) {
        expect(event.signature).toBeTruthy();
        expect(event.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
        const expected = `sha256=${createHmac("sha256", TOKEN).update(event.rawBody!).digest("hex")}`;
        expect(event.signature).toBe(expected);
      }
    } finally {
      await webhook.close();
    }
  });
});

// ─── 定时任务 ──────────────────────────────────────────────────

describe("Schedules", () => {
  it("拒绝没有目标 Agent 的 direct 定时任务", async () => {
    const response = await fetch(`${httpBaseUrl}/api/schedules`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "empty direct",
        cron: "*/5 * * * * *",
        targetMode: "direct",
        prompt: "run direct",
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Direct schedules");
  });
});

// ─── 快照 ──────────────────────────────────────────────────────

describe("GET /api/snapshot", () => {
  it("返回完整系统状态", async () => {
    const agent = await connectAgent("alice");
    const dispatchPromise = waitForAgentDispatch(agent);

    await fetch(`${httpBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "snapshot test", atAgents: ["alice"] }),
    });
    await dispatchPromise;

    const response = await fetch(`${httpBaseUrl}/api/snapshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      employees: Array<{ id: string; status: string }>;
      tasks: Array<{ id: string }>;
      logs: Record<string, unknown[]>;
    };
    expect(snapshot.employees).toHaveLength(1);
    expect(snapshot.employees[0]!.id).toBe("alice");
    expect(snapshot.employees[0]!.status).toBe("online");
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Helper 函数 ───────────────────────────────────────────────

async function connectLeader() {
  return connectWs(`${baseUrl}/ws/leader?token=${TOKEN}`);
}

async function connectAgent(employeeId: string, activeTaskId?: string, opts?: { weight?: number; labels?: string[]; agentToken?: string; permissionMode?: string }) {
  const agentToken = await createAgentRegistrationToken(employeeId, opts);
  const socket = await connectWs(`${baseUrl}/ws/agent`);
  sendAgentRegister(socket, employeeId, activeTaskId, { ...opts, agentToken });
  await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === employeeId && e.status === "online"));
  return socket;
}

async function createAgentRegistrationToken(employeeId: string, opts?: { labels?: string[]; agentToken?: string }) {
  const response = await fetch(`${httpBaseUrl}/api/agent-registry`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      employeeId,
      name: employeeId,
      labels: opts?.labels ?? [],
      ...(opts?.agentToken ? { token: opts.agentToken } : {}),
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { agentToken: string };
  return body.agentToken;
}

function sendAgentRegister(socket: WebSocket, employeeId: string, activeTaskId?: string, opts?: { weight?: number; labels?: string[]; permissionMode?: string; agentToken?: string }) {
  socket.send(
    JSON.stringify({
      type: "agent.register",
      employeeId,
      agentToken: opts?.agentToken,
      name: employeeId,
      machineId: employeeId,
      hostname: "test-host",
      labels: opts?.labels ?? [],
      permissionMode: opts?.permissionMode,
      weight: opts?.weight,
      activeMainTaskId: activeTaskId ?? null,
      activeQueueTaskId: null,
      lastOutputSeq: 0,
    }),
  );
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForAgentDispatch(socket: WebSocket, timeoutMs = 500): Promise<Extract<ServerToEmployeeMessage, { type: "task.dispatch" }>> {
  return waitForWsMessage(socket, (message): message is Extract<ServerToEmployeeMessage, { type: "task.dispatch" }> => {
    return message.type === "task.dispatch";
  }, timeoutMs);
}

async function getMission(missionId: string) {
  const response = await fetch(`${httpBaseUrl}/api/missions/${missionId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    mission: { id: string; status: string; result: string | null };
    subtasks: Array<{ taskId: string; role: string; iteration: number }>;
    approvals: Array<{ id: string; status: string; question: string }>;
  }>;
}

function completeTask(socket: WebSocket, taskId: string, summary: string) {
  socket.send(JSON.stringify({ type: "task.accepted", taskId }));
  socket.send(JSON.stringify({ type: "task.started", taskId, pid: 123, sessionId: `session-${taskId}` }));
  socket.send(JSON.stringify({ type: "task.completed", taskId, exitCode: 0, summary }));
}

function waitForLeaderMessage<T extends ServerToLeaderMessage>(
  socket: WebSocket,
  predicate: (message: ServerToLeaderMessage) => message is T,
  timeoutMs?: number,
): Promise<T>;
function waitForLeaderMessage(
  socket: WebSocket,
  predicate: (message: ServerToLeaderMessage) => boolean,
  timeoutMs?: number,
): Promise<ServerToLeaderMessage>;
function waitForLeaderMessage(
  socket: WebSocket,
  predicate: (message: ServerToLeaderMessage) => boolean,
  timeoutMs = 500,
) {
  return waitForWsMessage(socket, predicate, timeoutMs);
}

function waitForWsMessage<T>(
  socket: WebSocket,
  predicate: (message: T) => boolean,
  timeoutMs = 500,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed while waiting for message."));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 500): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for close.")), timeoutMs);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  const closed = waitForClose(socket).catch(() => ({ code: 0, reason: "" }));
  socket.close();
  return closed;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("Timed out waiting for condition.");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWebhookServer() {
  const events: Array<{ event: string; chunk?: { content?: string }; signature?: string; rawBody?: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers["x-ai-teams-signature"];
      if (rawBody) {
        events.push({
          ...(JSON.parse(rawBody) as { event: string; chunk?: { content?: string } }),
          signature: typeof signature === "string" ? signature : undefined,
          rawBody,
        });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "received" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    events,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
