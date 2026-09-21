import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ServerToEmployeeMessage } from "@ai-teams/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sent: [] as any[], children: [] as any[], failStartup: false, spawn: vi.fn() }));
vi.mock("./config.js", () => ({ EMPLOYEE_ID: "isolated", MAX_ERROR_TAIL: 16000, RUNNER_MODE: "claude", reinitializeConfig: vi.fn() }));
vi.mock("./setup.js", () => ({ runSetup: vi.fn(), loadConfigFile: vi.fn() }));
vi.mock("./state.js", () => ({ loadState: () => ({ claudeSessionId: "test", sessionReady: false }), persistState: () => false,
  resetClaudeSession: vi.fn(), stateStorageHealthy: true }));
vi.mock("./outbox.js", () => ({ loadTerminalOutbox: () => [], saveTerminalOutbox: vi.fn() }));
vi.mock("./records.js", () => ({ recordTaskStart: vi.fn(), recordTaskFinish: vi.fn() }));
vi.mock("./connection.js", () => ({ connect: vi.fn(), send: (_state: unknown, message: unknown) => h.sent.push(message) }));
vi.mock("./runner.js", () => ({ runFakeTask: vi.fn(), runClaudeTask: (...args: unknown[]) => h.spawn(...args) }));
let runtime: typeof import("./index.js");
let signals: Map<NodeJS.Signals, Set<(...args: any[]) => void>>;
const message = (taskId: string, timeoutSec = 30): Extract<ServerToEmployeeMessage, { type: "task.dispatch" }> => ({
  type: "task.dispatch", taskId, attempt: 1, leaderCommandId: "command", employeeId: "isolated", targetMode: "direct",
  prompt: "test", workspace: null, timeoutSec, cliConfig: null,
});
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  h.sent.length = 0; h.children.length = 0; h.failStartup = false; h.spawn.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  signals = new Map((["SIGTERM", "SIGINT"] as NodeJS.Signals[]).map(signal => [signal, new Set(process.listeners(signal))]));
  h.spawn.mockImplementation((taskId, _prompt, _workspace, deps) => {
    if (h.failStartup) throw new Error("EACCES startup");
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    h.children.push(child);
    deps.findActiveTask(taskId).child = child as unknown as ChildProcess;
  });
  runtime = await import("./index.js");
});
afterEach(() => {
  for (const [signal, before] of signals) for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("startup exceptions settle the task and free the slot", () => {
  h.failStartup = true; runtime.startTask(message("failed"));
  expect(h.sent).toContainEqual(expect.objectContaining({ type: "task.failed", taskId: "failed", error: expect.stringContaining("EACCES") }));
  h.failStartup = false; runtime.startTask(message("next"));
  expect(h.spawn).toHaveBeenCalledTimes(2);
});

it("session persistence failure cannot suppress the terminal result", () => {
  runtime.startTask(message("done")); runtime.finishTask("done", "completed", 0);
  expect(h.sent).toContainEqual(expect.objectContaining({ type: "task.completed", taskId: "done" }));
});

it("local deadline cancels execution even without a server connection", async () => {
  runtime.startTask(message("deadline", 0.05));
  await vi.advanceTimersByTimeAsync(50);
  expect(h.children[0].kill).toHaveBeenCalledWith("SIGTERM");
  expect(h.sent.some(m => m.type === "task.cancelled")).toBe(false);
  h.children[0].emit("close");
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  expect(h.sent).toContainEqual(expect.objectContaining({ type: "task.cancelled", taskId: "deadline" }));
});

it("shutdown rejects new work and acknowledges cancellation only after teardown", async () => {
  runtime.startTask(message("old"));
  const shutdown = runtime.gracefulShutdown("test");
  runtime.startTask(message("late"));
  expect(h.spawn).toHaveBeenCalledTimes(1);
  expect(h.sent.some(m => m.type === "task.cancelled")).toBe(false);
  expect(h.sent).toContainEqual(expect.objectContaining({ type: "task.failed", taskId: "late" }));
  h.children[0].emit("close");
  await vi.advanceTimersByTimeAsync(3000); await shutdown;
  expect(h.sent).toContainEqual(expect.objectContaining({ type: "task.cancelled", taskId: "old" }));
  expect(h.sent.some(m => m.type === "agent.request_task")).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(process.exit).toHaveBeenCalledWith(0);
});
