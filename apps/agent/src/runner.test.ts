import { describe, expect, it } from "vitest";
import { classifyModelTransientFailure, shouldRetryWithFreshClaudeSession, handleClaudeJsonLine } from "./runner.js";
import type { ActiveTask } from "./config.js";

function task(overrides: Partial<ActiveTask>): ActiveTask {
  return {
    taskId: "task-1",
    attempt: 1,
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
  it("retries a fresh session-id collision, but never discards resumed history", () => {
    const stderrTail = "Error: Session ID 379c1ae9-f1ed-47de-b43b-9c3eec3f5892 is already in use.";
    for (const current of [
      task({ targetMode: "direct", resumingSession: false, stderrTail }),
      task({ targetMode: "queue", resumingSession: false, stderrTail }),
    ]) {
      expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => current)).toBe(true);
    }
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ resumingSession: true, stderrTail }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ usedResume: true, stderrTail }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ hasExecutionEvidence: true, stderrTail }))).toBe(false);
  });

  it("does not silently replace a missing conversation with empty history", () => {
    const stderrTail = "No conversation found with session ID abc";
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "direct", resumingSession: false, stderrTail }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "queue", resumingSession: false, stderrTail }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ targetMode: "direct", resumingSession: true, stderrTail }))).toBe(false);
  });

  it("does not retry cancelled or already retried tasks", () => {
    const stderrTail = "Error: Session ID abc is already in use.";
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ stderrTail, cancelRequested: true }))).toBe(false);
    expect(shouldRetryWithFreshClaudeSession("task-1", 1, () => task({ stderrTail, retriedWithFreshSession: true }))).toBe(false);
  });
});

describe("classifyModelTransientFailure", () => {
  it("marks 429 and 529 model errors as recoverable with cooldown", () => {
    const rateLimit = task({ stderrTail: "Error: API returned 429 rate limit. Retry after 2 seconds." });
    const overloaded = task({ stderrTail: "Error: 529 overloaded" });

    expect(classifyModelTransientFailure("task-1", 1, () => rateLimit)).toMatchObject({
      recoverable: true,
      retryAfterMs: 2000,
    });
    expect(classifyModelTransientFailure("task-1", 1, () => overloaded)).toMatchObject({
      recoverable: true,
      cooldownMs: 60000,
    });
  });

  it("does not mark normal task failures as recoverable", () => {
    expect(classifyModelTransientFailure("task-1", 1, () => task({ stderrTail: "TypeScript error" }))).toBeNull();
  });
  it("does not retry authentication/configuration errors or ordinary git upstream text", () => {
    for (const stderrTail of ["API 401 Unauthorized upstream error", "API 403 Forbidden", "invalid_api_key", "git upstream branch not found"]) {
      expect(classifyModelTransientFailure("task-1", 1, () => task({ stderrTail }))).toBeNull();
    }
  });
  it("captures structured CLI errors from stdout even if the CLI later exits zero", () => {
    const current = task({});
    handleClaudeJsonLine("task-1", JSON.stringify({ type: "result", is_error: true, errors: ["API 529 overloaded"] }), () => current, () => {});
    expect(current.cliResultError).toBe(true);
    expect(classifyModelTransientFailure("task-1", 1, () => current)?.recoverable).toBe(true);
  });
  it("bounds extreme Retry-After values and detects transient network failures", () => {
    expect(classifyModelTransientFailure("task-1", 1, () => task({ stderrTail: "429 Retry-After: 999999 seconds" }))?.cooldownMs).toBe(600000);
    expect(classifyModelTransientFailure("task-1", 1, () => task({ stderrTail: "fetch failed ECONNRESET" }))?.recoverable).toBe(true);
  });
});
