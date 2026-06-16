import { describe, expect, it } from "vitest";
import { shouldRetryWithFreshClaudeSession } from "./runner.js";
import type { ActiveTask } from "./config.js";

function task(overrides: Partial<ActiveTask>): ActiveTask {
  return {
    taskId: "task-1",
    seq: 0,
    child: null,
    summary: [],
    cancelRequested: false,
    sawStreamText: false,
    lastToolBlock: false,
    stderrTail: "",
    retriedWithFreshSession: false,
    resumingSession: false,
    generation: 0,
    targetMode: "direct",
    claudeSessionId: "session-1",
    cliConfig: null,
    resultMetrics: {},
    ...overrides,
  };
}

describe("shouldRetryWithFreshClaudeSession", () => {
  it("retries busy Claude sessions for direct, queue, and explicit resume tasks", () => {
    const stderrTail = "Error: Session ID 379c1ae9-f1ed-47de-b43b-9c3eec3f5892 is already in use.";
    for (const current of [
      task({ targetMode: "direct", resumingSession: false, stderrTail }),
      task({ targetMode: "queue", resumingSession: false, stderrTail }),
      task({ targetMode: "direct", resumingSession: true, stderrTail }),
    ]) {
      expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => current)).toBe(true);
    }
  });

  it("keeps missing conversation retry limited to non-queue fresh direct tasks", () => {
    const stderrTail = "No conversation found with session ID abc";
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "direct", resumingSession: false, stderrTail }))).toBe(true);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "queue", resumingSession: false, stderrTail }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "direct", resumingSession: true, stderrTail }))).toBe(false);
  });

  it("does not retry cancelled or already retried tasks", () => {
    const stderrTail = "Error: Session ID abc is already in use.";
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ stderrTail, cancelRequested: true }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ stderrTail, retriedWithFreshSession: true }))).toBe(false);
  });
});
