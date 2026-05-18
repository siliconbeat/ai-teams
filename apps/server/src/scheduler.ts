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
  onFire: (id: string) => void,
): void {
  const atAgents = schedule.targetMode === "queue"
    ? ("queue" as const)
    : schedule.targetMode === "broadcast"
    ? ("all" as const)
    : schedule.targetAgents;

  const job = new CronJob(
    schedule.cronExpr,
    () => {
      dispatchFn(
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
      onFire(schedule.id);
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
