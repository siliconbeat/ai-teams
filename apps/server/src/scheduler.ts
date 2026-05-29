import { CronJob } from "cron";
import type { ScheduleRecord } from "./db.js";
import type { CronJobLike } from "./state-store.js";

export type ScheduleDispatchFn = (
  message: { type: "command.dispatch"; atAgents: "queue" | "all" | string[]; prompt: string; workspace?: string; timeoutSec?: number },
  webhookUrl?: string | null,
  cliConfig?: unknown,
  priority?: number,
  requiredLabels?: string[] | null,
) => { ok: boolean; code?: string; message?: string; tasks?: unknown[] };

export function startScheduleJob(
  schedule: ScheduleRecord,
  dispatchFn: ScheduleDispatchFn,
  jobs: Map<string, CronJobLike>,
  onFire: (id: string) => Promise<void> | void,
  onError?: (id: string, error: unknown) => void,
): void {
  const atAgents = schedule.targetMode === "queue"
    ? ("queue" as const)
    : schedule.targetMode === "broadcast"
    ? ("all" as const)
    : schedule.targetAgents;

  const job = new CronJob(
    schedule.cronExpr,
    () => {
      void (async () => {
        const result = dispatchFn(
          {
            type: "command.dispatch",
            atAgents,
            prompt: schedule.prompt,
            workspace: schedule.workspace ?? undefined,
            timeoutSec: schedule.timeoutSec ?? undefined,
          },
          null,
          undefined,
          schedule.priority,
          schedule.requiredLabels,
        );
        if (!result.ok) {
          throw new Error(result.message ?? result.code ?? "Schedule dispatch failed.");
        }
        await onFire(schedule.id);
      })().catch((error) => onError?.(schedule.id, error));
    },
    null,
    true,
  );
  jobs.set(schedule.id, job);
}

export function stopScheduleJob(jobs: Map<string, CronJobLike>, scheduleId: string) {
  const job = jobs.get(scheduleId);
  if (job) {
    job.stop();
    jobs.delete(scheduleId);
  }
}
