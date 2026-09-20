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
