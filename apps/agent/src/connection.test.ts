import { afterEach, beforeEach, expect, it, vi } from "vitest";
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    constructor() { super(); sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
  } };
});
vi.mock("./config.js", () => ({ AGENT_TOKEN: "isolated", EMPLOYEE_ID: "alice", EMPLOYEE_NAME: "Alice", EMPLOYEE_LABELS: [], EMPLOYEE_WEIGHT: 1, CLAUDE_PERMISSION_MODE: "default", RECONNECT_MS: 1000, SERVER_URL: "http://localhost:1", MAX_BUFFERED_MESSAGES: 4 }));
vi.mock("./claude-version.js", () => ({ getClaudeVersion: () => "test" }));
import { connect, resetReconnectAttempt, send, registerAgent, type ConnectionState } from "./connection.js";
let state: ConnectionState;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetReconnectAttempt(); sockets.length = 0;
  state = { socket: null, reconnectTimer: null, heartbeatTimer: null, bufferedMessages: [] };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("handshakes without registration retain exponential backoff; registration resets it", async () => {
  connect(state, () => null, () => null, () => {});
  sockets[0].emit("open"); sockets[0].emit("close", 1006);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  sockets[1].emit("open"); sockets[1].emit("close", 1006);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(3);
  sockets[2].emit("open");
  sockets[2].emit("message", Buffer.from(JSON.stringify({ type: "agent.registered", consecutiveQueueFailures: 0 })));
  await vi.advanceTimersByTimeAsync(10000);
  expect(sockets[2].sent.some((m: any) => m.type === "agent.heartbeat")).toBe(true);
  sockets[2].emit("close", 1006);
  expect(state.heartbeatTimer).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(4);
});

it("authentication rejection exits rather than reconnecting forever", () => {
  vi.spyOn(process, "exit").mockImplementation(() => { throw Error("exit"); });
  connect(state, () => null, () => null, () => {});
  expect(() => sockets[0].emit("close", 1008, "invalid_token")).toThrow("exit");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(state.reconnectTimer).toBeNull();
});

it("bounded disconnect buffering preserves terminal events and advertises them in registration", () => {
  send(state, { type: "task.completed", taskId: "finished", exitCode: 0, attempt: 1 });
  for (let seq = 0; seq < 20; seq++) send(state, { type: "task.output", taskId: "active", seq, stream: "stdout", content: "bounded" });
  expect(state.bufferedMessages).toHaveLength(4);
  expect(state.bufferedMessages[0].type).toBe("task.completed");
  connect(state, () => null, () => null, () => {});
  registerAgent(state, null, null);
  expect(sockets[0].sent[0].pendingTaskIds).toEqual(["finished"]);
});

it("persists terminals before sending and removes them only after server ACK", () => {
  const save = vi.fn();
  state.persistTerminals = save;
  connect(state, () => null, () => null, () => {});
  send(state, { type: "task.completed", taskId: "durable", attempt: 2, exitCode: 0 });
  expect(save).toHaveBeenCalledWith([expect.objectContaining({ taskId: "durable", attempt: 2 })]);
  expect(state.terminalMessages).toHaveLength(1);
  registerAgent(state, null, null);
  expect(sockets[0].sent.at(-1).pendingTerminals).toHaveLength(1);
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "task.ack", taskId: "durable", attempt: 1 })));
  expect(state.terminalMessages).toHaveLength(1);
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "task.ack", taskId: "durable", attempt: 2 })));
  expect(state.terminalMessages).toEqual([]);
});

it("storage failure pauses admission but does not prevent sending terminal evidence", () => {
  state.persistTerminals = () => { throw new Error("ENOSPC"); };
  connect(state, () => null, () => null, () => {});
  expect(() => send(state, { type: "task.completed", taskId: "full", attempt: 1, exitCode: 0 })).not.toThrow();
  expect(state.storageFailed).toBe(true);
  expect(sockets[0].sent.at(-1).type).toBe("task.completed");
});

it("bounds disconnected output by bytes, not just message count", () => {
  send(state, { type: "task.output", taskId: "large", seq: 1, stream: "stdout", content: "x".repeat(3 * 1024 * 1024) });
  expect(Buffer.byteLength(JSON.stringify(state.bufferedMessages))).toBeLessThan(2 * 1024 * 1024);
});

it("authentication rejection drains via the lifecycle owner without reconnect", () => {
  state.onFatal = vi.fn();
  connect(state, () => null, () => null, () => {});
  sockets[0].emit("close", 1008, "replaced");
  expect(state.onFatal).toHaveBeenCalledOnce();
  expect(state.stopped).toBe(true);
  expect(state.reconnectTimer).toBeNull();
});
