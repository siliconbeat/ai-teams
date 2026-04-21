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

describe("AI Teams server integration", () => {
  it("rejects unauthenticated websocket clients and accepts token clients", async () => {
    const rejected = new WebSocket(`${baseUrl}/ws/leader`);
    sockets.push(rejected);
    const close = await waitForClose(rejected);
    expect(close.code).toBe(1008);

    const leader = await connectLeader();
    expect(leader.readyState).toBe(WebSocket.OPEN);
  });

  it("serves Swagger OpenAPI documentation without API token", async () => {
    const response = await fetch(`${httpBaseUrl}/docs/json`);
    expect(response.status).toBe(200);
    const openapi = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(openapi.openapi).toMatch(/^3\./);
    expect(openapi.paths["/api/tasks"]).toBeTruthy();
  });

  it("dispatches all and multiple-agent commands to registered agents", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const aliceDispatch = waitForAgentDispatch(alice);
    const bobDispatch = waitForAgentDispatch(bob);
    leader.send(
      JSON.stringify({
        type: "command.dispatch",
        atAgents: "all",
        prompt: "run all",
      }),
    );
    expect((await aliceDispatch).prompt).toBe("run all");
    expect((await bobDispatch).prompt).toBe("run all");

    const runBothTask = waitForLeaderMessage(
      leader,
      (message) => message.type === "task.upsert" && message.task.prompt === "run both",
    );
    leader.send(
      JSON.stringify({
        type: "command.dispatch",
        atAgents: ["alice", "bob"],
        prompt: "run both",
      }),
    );
    await runBothTask;
  });

  it("dispatches queue commands to one available agent at a time", async () => {
    const alice = await connectAgent("alice");
    const bob = await connectAgent("bob");
    const leader = await connectLeader();

    const aliceDispatch = waitForAgentDispatch(alice);
    const bobUnexpected = waitForAgentDispatch(bob, 80).then(() => true, () => false);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queued once" }));

    const first = await aliceDispatch;
    expect(first.prompt).toBe("queued once");
    expect(first.employeeId).toBe("alice");
    expect(first.targetMode).toBe("queue");
    expect(await bobUnexpected).toBe(false);

    const bobDispatch = waitForAgentDispatch(bob);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queued twice" }));
    const second = await bobDispatch;
    expect(second.prompt).toBe("queued twice");
    expect(second.employeeId).toBe("bob");
    expect(second.targetMode).toBe("queue");
  });

  it("streams agent task events to leaders and completes the task", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();
    const sessionId = "claude-session-1";

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "hello" }));
    const dispatch = await dispatchPromise;
    const outputPromise = waitForLeaderMessage(
      leader,
      (message) => message.type === "task.output" && message.chunk.taskId === dispatch.taskId && message.chunk.content === "hi",
    );
    const completedPromise = waitForLeaderMessage(
      leader,
      (message) => message.type === "task.upsert" && message.task.id === dispatch.taskId && message.task.status === "completed",
    );
    agent.send(JSON.stringify({ type: "task.accepted", taskId: dispatch.taskId }));
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123, sessionId }));
    agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: 1, content: "hi" }));
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));

    await outputPromise;
    const completed = await completedPromise;
    expect(completed.type).toBe("task.upsert");
    expect(completed.task.sessionId).toBe(sessionId);

    const historyResponse = await fetch(`${httpBaseUrl}/api/sessions/${sessionId}/history`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      sessionId: string;
      tasks: Array<{ id: string }>;
      messages: Array<{ type: string; role: string; taskId: string; content: string }>;
    };
    expect(history.sessionId).toBe(sessionId);
    expect(history.tasks.map((task) => task.id)).toContain(dispatch.taskId);
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task.prompt", role: "user", taskId: dispatch.taskId, content: "hello" }),
        expect.objectContaining({ type: "task.output", role: "assistant", taskId: dispatch.taskId, content: "hi" }),
        expect.objectContaining({ type: "task.result", role: "assistant", taskId: dispatch.taskId, content: "done" }),
      ]),
    );
  });

  it("allows reconnect within grace period and fails after grace expires", async () => {
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
      server.buildSnapshot().employees.some((employee) => employee.id === "alice" && employee.status === "offline"),
    );

    const recovered = await connectAgent("alice", dispatch.taskId);
    await delay(20);
    await waitUntil(() =>
      server.buildSnapshot().employees.some((employee) => employee.id === "alice" && employee.status === "online"),
    );
    expect(recovered.readyState).toBe(WebSocket.OPEN);
    expect(server.buildSnapshot().tasks.find((task) => task.id === dispatch.taskId)?.status).toBe("running");

    const closePromise = waitForClose(recovered);
    recovered.close();
    await closePromise;
    await waitUntil(
      () => server.buildSnapshot().tasks.some((task) => task.id === dispatch.taskId && task.status === "failed"),
      500,
    );
  });

  it("keeps timeout status when a late completion arrives", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    const dispatchPromise = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "timeout" }));
    const dispatch = await dispatchPromise;
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));

    await waitForLeaderMessage(
      leader,
      (message) => message.type === "task.upsert" && message.task.id === dispatch.taskId && message.task.status === "timeout",
      500,
    );
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "late" }));
    await delay(30);
    expect(server.buildSnapshot().tasks.find((task) => task.id === dispatch.taskId)?.status).toBe("timeout");
  });

  it("closes an agent socket that reports another employee's task", async () => {
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

  it("accepts REST task submissions and posts webhook callbacks for task lifecycle", async () => {
    const agent = await connectAgent("alice");
    const webhook = await startWebhookServer();

    try {
      const dispatchPromise = waitForAgentDispatch(agent);
      const response = await fetch(`${httpBaseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          atAgents: ["alice"],
          prompt: "rest task",
          webhook: webhook.url,
        }),
      });

      expect(response.status).toBe(202);
      const body = (await response.json()) as { status: string; tasks: Array<{ id: string; prompt: string }> };
      expect(body.status).toBe("accepted");
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]?.prompt).toBe("rest task");

      const dispatch = await dispatchPromise;
      agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));
      agent.send(
        JSON.stringify({
          type: "task.output",
          taskId: dispatch.taskId,
          stream: "stdout",
          seq: 1,
          content: "[done] result: step complete",
        }),
      );
      agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));

      await waitUntil(() => webhook.events.some((event) => event.event === "task.completed"), 500);
      expect(webhook.events.map((event) => event.event)).toEqual(
        expect.arrayContaining(["task.started", "task.output", "task.completed"]),
      );
      expect(webhook.events.find((event) => event.event === "task.output")?.chunk?.content).toBe("[done] result: step complete");

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

  it("allows parallel main and queue tasks on the same agent", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

    // Send a direct task (main slot)
    const mainDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: ["alice"], prompt: "main task" }));
    const mainTask = await mainDispatch;
    expect(mainTask.targetMode).toBe("direct");

    // Send a queue task — should dispatch to alice's queue slot since she's the only agent
    const queueDispatch = waitForAgentDispatch(agent);
    leader.send(JSON.stringify({ type: "command.dispatch", atAgents: "queue", prompt: "queue task" }));
    const queueTask = await queueDispatch;
    expect(queueTask.targetMode).toBe("queue");

    // Verify both slots are occupied
    const snapshot = server.buildSnapshot();
    const alice = snapshot.employees.find((e) => e.id === "alice")!;
    expect(alice.mainTaskId).toBe(mainTask.taskId);
    expect(alice.queueTaskId).toBe(queueTask.taskId);

    // Complete main task — should free main slot
    agent.send(JSON.stringify({ type: "task.completed", taskId: mainTask.taskId, exitCode: 0, summary: "main done" }));
    await delay(20);
    const afterMainComplete = server.buildSnapshot();
    const aliceAfter = afterMainComplete.employees.find((e) => e.id === "alice")!;
    expect(aliceAfter.mainTaskId).toBeNull();
    expect(aliceAfter.queueTaskId).toBe(queueTask.taskId);

    // Complete queue task — should free queue slot
    agent.send(JSON.stringify({ type: "task.completed", taskId: queueTask.taskId, exitCode: 0, summary: "queue done" }));
    await delay(20);
    const afterQueueComplete = server.buildSnapshot();
    const aliceFinal = afterQueueComplete.employees.find((e) => e.id === "alice")!;
    expect(aliceFinal.mainTaskId).toBeNull();
    expect(aliceFinal.queueTaskId).toBeNull();
  });
});

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
  await waitUntil(() => server.buildSnapshot().employees.some((employee) => employee.id === employeeId && employee.status === "online"));
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
