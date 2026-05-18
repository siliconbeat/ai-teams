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

  it("409 取消已完成的任务", async () => {
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
    expect(cancelRes.status).toBe(409);
  });

  it("409 取消已取消的任务", async () => {
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
    expect(secondCancel.status).toBe(409);
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

  it("queue 轮询分发给空闲 Agent", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const aliceDispatch = waitForAgentDispatch(alice);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "round 1" }));
    const first = await aliceDispatch;
    expect(first.targetMode).toBe("queue");

    const bobDispatch = waitForAgentDispatch(bob);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "round 2" }));
    const second = await bobDispatch;
    expect(second.targetMode).toBe("queue");
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
    const socket = await connectWs(`${baseUrl}/ws/agent?token=${TOKEN}`);
    socket.send(JSON.stringify({ type: "task.accepted", taskId: "fake-id" }));
    const close = await waitForClose(socket);
    expect(close.code).toBe(1008);
  });

  it("错误 Token 的 Agent 被拒绝", async () => {
    const socket = new WebSocket(`${baseUrl}/ws/agent?token=wrong-token`);
    sockets.push(socket);
    const close = await waitForClose(socket);
    expect(close.code).toBe(1008);
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

async function connectAgent(employeeId: string, activeTaskId?: string) {
  const socket = await connectWs(`${baseUrl}/ws/agent?token=${TOKEN}`);
  socket.send(
    JSON.stringify({
      type: "agent.register",
      employeeId,
      name: employeeId,
      machineId: employeeId,
      hostname: "test-host",
      labels: [],
      activeMainTaskId: activeTaskId ?? null,
      activeQueueTaskId: null,
      lastOutputSeq: 0,
    }),
  );
  await waitUntil(() => server.buildSnapshot().employees.some((e) => e.id === employeeId && e.status === "online"));
  return socket;
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

async function waitUntil(predicate: () => boolean, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
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
