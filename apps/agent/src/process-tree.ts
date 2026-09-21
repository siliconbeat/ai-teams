import type { ChildProcess } from "node:child_process";

/** Only signal the execution domain created for this child, never a name match. */
export function signalTaskProcess(child: ChildProcess, group: boolean, signal: NodeJS.Signals) {
  try {
    if (group && child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Retain ownership until close AND escalation; descendants can outlive the CLI. */
export function stopTaskProcess(child: ChildProcess, group: boolean, graceMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    let closed = false;
    let escalated = false;
    let settled = false;
    let poll: NodeJS.Timeout | undefined;
    const done = () => {
      if (settled || !closed || !escalated) return;
      if (group && child.pid) {
        try { process.kill(-child.pid, 0); poll = setTimeout(done, 50); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
      }
      settled = true; clearTimeout(limit); resolve();
    };
    child.once("close", () => { closed = true; done(); });
    const limit = setTimeout(() => {
      if (!settled) { settled = true; if (poll) clearTimeout(poll); reject(new Error("Task process teardown could not be confirmed; slot remains quarantined.")); }
    }, graceMs + 5000);
    try { signalTaskProcess(child, group, "SIGTERM"); }
    catch (error) { clearTimeout(limit); settled = true; reject(error); return; }
    setTimeout(() => {
      try { signalTaskProcess(child, group, "SIGKILL"); escalated = true; done(); }
      catch (error) { clearTimeout(limit); settled = true; reject(error); }
    }, graceMs);
  });
}
