import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ActiveTask, AgentState } from "./config.js";
import { runClaudeTask, type RunnerDeps } from "./runner.js";

// No Claude invocation, user workspace edits, credentials, or model requests.
vi.mock("./records.js", () => ({ ensureWorkspaceClaudeMd: vi.fn(), ensureClaudeHookFiles: vi.fn() }));
vi.mock("./claude-version.js", () => ({ getClaudeVersion: () => "stub" }));
vi.mock("./state.js", () => ({ resetClaudeSession: () => ({ claudeSessionId: "new-main-session", sessionReady: false }) }));

function harness(overrides: Partial<ActiveTask> = {}, cachedReady = false) {
  let active: ActiveTask | null = {
    taskId: "task", attempt: 1, seq: 0, child: null, summary: [], cancelRequested: false,
    sawStreamText: false, lastToolBlock: false, stderrTail: "", retriedWithFreshSession: false,
    resumingSession: false, generation: 0, targetMode: "queue", claudeSessionId: "allocated-id",
    cliConfig: null, resultMetrics: {}, ...overrides,
  };
  let state: AgentState = { claudeSessionId: "main-id", sessionReady: cachedReady };
  const children: Array<ChildProcess & { stdout: PassThrough; stderr: PassThrough }> = [];
  const spawnClaude = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: vi.fn(),
    }) as unknown as typeof children[number];
    children.push(child);
    return child;
  });
  const send = vi.fn();
  const finishTask = vi.fn((..._args: Parameters<RunnerDeps["finishTask"]>) => { active = null; });
  const deps: RunnerDeps = {
    findActiveTask: () => active, send, finishTask,
    emitOutput: vi.fn(), emitStderr: (_id, text) => { if (active) active.stderrTail += text; },
    getAgentState: () => state, setAgentState: (value) => { state = value; },
    spawnClaude: spawnClaude as unknown as typeof spawn,
  };
  runClaudeTask("task", "original task", process.cwd(), deps);
  return { deps, children, send, finishTask, spawnClaude, state: () => state, active: () => active,
    replace: (next: ActiveTask) => { active = next; } };
}

function line(child: ChildProcess & { stdout: PassThrough }, node: unknown) {
  child.stdout.write(`${JSON.stringify(node)}\n`);
}

describe("CLI session lifecycle (isolated subprocess stub)", () => {
  it("does not advertise a generated/init/error session as resumable after startup 429", () => {
    const h = harness();
    line(h.children[0], { type: "system", subtype: "init", session_id: "allocated-id" });
    line(h.children[0], { type: "result", is_error: true, session_id: "allocated-id", errors: ["API 429 rate limit"], result: "failed" });
    h.children[0].emit("close", 1);
    expect(h.send.mock.calls.map(([m]) => m.sessionId)).toEqual([null]);
    expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.objectContaining({ recoverable: true }));
    expect(h.spawnClaude).toHaveBeenCalledTimes(1);
  });

  it.each([1, 0])("missing explicit resume is terminal, even when structured CLI exits %i", (exitCode) => {
    const h = harness({ resumingSession: true });
    const error = "No conversation found with session ID: allocated-id (previous API 529)";
    if (exitCode) h.children[0].stderr.write(error);
    else line(h.children[0], { type: "result", is_error: true, result: error });
    h.children[0].emit("close", exitCode);
    expect(h.spawnClaude).toHaveBeenCalledTimes(1);
    expect(h.spawnClaude.mock.calls[0][1]).toContain("--resume");
    expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.stringContaining("[session_unavailable]"));
    expect(h.finishTask.mock.calls[0]?.[2]).toContain("确认已执行操作");
  });

  it("confirms actual assistant history but never replays a task after tool execution evidence", () => {
    const h = harness();
    line(h.children[0], { type: "assistant", session_id: "actual-id", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
    expect(h.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: "task.started", sessionId: "actual-id" });
    h.children[0].stderr.write("Session ID actual-id is already in use");
    h.children[0].emit("close", 1);
    expect(h.spawnClaude).toHaveBeenCalledTimes(1);
    expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.stringContaining("session_unavailable"));
  });

  it("retries a fresh ID collision once without resetting the parallel main session", () => {
    const h = harness();
    const old = h.children[0];
    old.stderr.write("Session ID allocated-id is already in use");
    old.emit("close", 1);
    expect(h.spawnClaude).toHaveBeenCalledTimes(2);
    const newId = h.active()!.claudeSessionId;
    expect(newId).not.toBe("allocated-id");
    expect(h.spawnClaude.mock.calls[1][1]).toContain("--session-id");
    expect(h.spawnClaude.mock.calls[1][1]).toContain(newId);
    expect(h.spawnClaude.mock.calls[1][1]).not.toContain("--resume");
    expect(h.state().claudeSessionId).toBe("main-id");
    old.stderr.write("No conversation found with session ID: old");
    old.emit("error", new Error("late old process error"));
    expect(h.finishTask).not.toHaveBeenCalled();
    line(h.children[1], { type: "result", subtype: "success", is_error: false, session_id: newId, result: "done" });
    h.children[1].emit("close", 0);
    expect(h.finishTask).toHaveBeenCalledWith("task", "completed", 0);
  });

  it("does not replace implicitly resumed main history when its session is busy", () => {
    const h = harness({ targetMode: "direct", claudeSessionId: "main-id" }, true);
    h.children[0].stderr.write("Session ID main-id is already in use");
    h.children[0].emit("close", 1);
    expect(h.spawnClaude).toHaveBeenCalledTimes(1);
    expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.stringContaining("session_unavailable"));
  });

  it("never marks sessions resumable when persistence is disabled", () => {
    const h = harness({ cliConfig: { extraArgs: ["--no-session-persistence"] } });
    line(h.children[0], { type: "result", subtype: "success", session_id: "allocated-id", result: "done" });
    expect(h.send.mock.calls.map(([m]) => m.sessionId)).toEqual([null]);
    h.children[0].emit("close", 0);
  });

  it.each([true, false])("binds streamed execution and fails closed without persistence (resume=%s)", (resumingSession) => {
    for (const persist of [true, false]) {
      const h = harness({ resumingSession, cliConfig: persist ? null : { extraArgs: ["--no-session-persistence"] } });
      line(h.children[0], { type: "stream_event", session_id: "allocated-id", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } });
      h.children[0].stderr.write("API 529 overloaded");
      h.children[0].emit("close", 1);
      if (persist) {
        expect(h.send.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: "allocated-id" });
        expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.objectContaining({ recoverable: true }));
      } else {
        expect(h.finishTask).toHaveBeenCalledWith("task", "failed", expect.stringContaining("[session_unavailable]"));
      }
    }
  });

  it("cancellation prevents fallback and obsolete attempts cannot finish their replacement", () => {
    const h = harness();
    h.active()!.cancelRequested = true;
    h.children[0].stderr.write("Session ID allocated-id is already in use");
    h.children[0].emit("close", 1);
    expect(h.finishTask).toHaveBeenCalledWith("task", "cancelled");
    expect(h.spawnClaude).toHaveBeenCalledTimes(1);
    const next = harness();
    next.replace({ ...next.active()!, attempt: 2 });
    next.children[0].emit("close", 1);
    expect(next.finishTask).not.toHaveBeenCalled();
  });
});
