import type { EmployeeSnapshot } from "@ai-teams/shared";

export type QueueRecovery = NonNullable<EmployeeSnapshot["queueRecovery"]>;

// Keep recovery separate from user pause and the per-task retry budget.
export function nextQueueRecovery(previous: QueueRecovery | undefined, reason: string, now: number, requestedMs = 0, random = Math.random()): QueueRecovery {
  const failures = Math.min((previous?.failures ?? 0) + 1, 32);
  const base = Math.min(60_000 * 2 ** Math.min(failures - 1, 3), 300_000);
  const retryAfter = Number.isFinite(requestedMs) ? Math.max(0, Math.min(requestedMs, 600_000)) : 0;
  return { phase: "cooldown", failures, reason, until: now + Math.max(retryAfter, Math.min(300_000, base * (1 + random * 0.2))) };
}

export { isPermanentModelFailure } from "@ai-teams/shared";
