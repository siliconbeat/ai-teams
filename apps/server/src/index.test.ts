import fs from "node:fs";
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

  it("streams agent task events to leaders and completes the task", async () => {
    const agent = await connectAgent("alice");
    const leader = await connectLeader();

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
    agent.send(JSON.stringify({ type: "task.started", taskId: dispatch.taskId, pid: 123 }));
    agent.send(JSON.stringify({ type: "task.output", taskId: dispatch.taskId, stream: "stdout", seq: 1, content: "hi" }));
    agent.send(JSON.stringify({ type: "task.completed", taskId: dispatch.taskId, exitCode: 0, summary: "done" }));

    await outputPromise;
    const completed = await completedPromise;
    expect(completed.type).toBe("task.upsert");
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
      maxConcurrentTasks: 1,
      activeTaskId: activeTaskId ?? null,
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
