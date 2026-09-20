import type { TaskOutputChunk, TaskRecord } from '@ai-teams/shared';

export const TERMINAL_STORAGE_KEY = 'ai-teams.employee-terminal-logs';
export const TERMINAL_LIMIT = 60_000;
export type TerminalLog = { content: string; seenTaskIds: string[]; seenOutputIds: string[]; seenFinishedTaskIds: string[]; attempts?: Record<string, number> };
const empty = (): TerminalLog => ({ content: '', seenTaskIds: [], seenOutputIds: [], seenFinishedTaskIds: [] });
const ended = (task: TaskRecord) => ['completed', 'failed', 'cancelled', 'timeout'].includes(task.status);

/** Processes every event synchronously; only view notifications are coalesced. */
export class TerminalStore {
  private logs = new Map<string, TerminalLog>();
  private seen = new Map<string, Set<string>>();
  private listeners = new Map<string, Set<() => void>>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private savedRevision = 0;
  clearVersion = 0;

  constructor(initial: Record<string, TerminalLog> = {}) {
    for (const [id, log] of Object.entries(initial)) {
      this.logs.set(id, { content: log.content.slice(-TERMINAL_LIMIT), seenTaskIds: log.seenTaskIds.slice(-1500), seenOutputIds: log.seenOutputIds.slice(-1500), seenFinishedTaskIds: log.seenFinishedTaskIds.slice(-1500), attempts: Object.fromEntries(Object.entries(log.attempts ?? {}).slice(-1500)) });
      this.seen.set(id, new Set(log.seenOutputIds.slice(-1500)));
    }
  }
  get(id: string) { return this.logs.get(id)?.content ?? ''; }
  subscribe(id: string, listener: () => void) {
    const bucket = this.listeners.get(id) ?? new Set();
    bucket.add(listener); this.listeners.set(id, bucket);
    return () => { bucket.delete(listener); if (!bucket.size) this.listeners.delete(id); };
  }
  private change(id: string) {
    this.revision++; this.dirty.add(id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) for (const listener of this.listeners.get(id) ?? []) listener();
  }
  task(task: TaskRecord, header: string, footer: string) {
    if (!task.employeeId) return;
    const id = task.employeeId;
    const log = this.logs.get(id) ?? empty();
    const attempts = log.attempts ?? {};
    if (attempts[task.id] !== undefined && attempts[task.id] !== task.attempt) {
      // The same task may be retried with seq restarted at zero.
      log.seenTaskIds = log.seenTaskIds.filter(key => key !== task.id);
      log.seenFinishedTaskIds = log.seenFinishedTaskIds.filter(key => key !== task.id);
      log.seenOutputIds = log.seenOutputIds.filter(key => !key.startsWith(`${task.id}:`));
      this.seen.set(id, new Set(log.seenOutputIds));
    }
    log.attempts = Object.fromEntries(Object.entries({ ...attempts, [task.id]: task.attempt }).slice(-1500));
    let changed = false;
    if (!log.seenTaskIds.includes(task.id)) {
      log.content += `${log.content ? '\n' : ''}${header}`;
      log.seenTaskIds = [...log.seenTaskIds, task.id].slice(-1500); changed = true;
    }
    if (ended(task) && !log.seenFinishedTaskIds.includes(task.id)) {
      log.content += footer;
      log.seenFinishedTaskIds = [...log.seenFinishedTaskIds, task.id].slice(-1500); changed = true;
    }
    log.content = log.content.slice(-TERMINAL_LIMIT);
    this.logs.set(id, log);
    if (changed) this.change(id);
  }
  output(chunk: TaskOutputChunk) {
    const id = chunk.employeeId;
    const log = this.logs.get(id) ?? empty();
    // A late output for a cleared/unknown task must never revive its terminal.
    if (!log.seenTaskIds.includes(chunk.taskId)) return;
    const seen = this.seen.get(id) ?? new Set(log.seenOutputIds);
    const key = `${chunk.taskId}:${chunk.seq}`;
    if (seen.has(key)) return;
    seen.add(key); log.seenOutputIds.push(key);
    if (log.seenOutputIds.length > 1500) seen.delete(log.seenOutputIds.shift()!);
    log.content = (log.content + chunk.content).slice(-TERMINAL_LIMIT);
    this.logs.set(id, log); this.seen.set(id, seen); this.change(id);
  }
  clear() {
    this.clearVersion++;
    for (const id of this.logs.keys()) this.dirty.add(id);
    this.logs.clear(); this.seen.clear(); this.revision++; this.flush();
  }
  remove(id: string) {
    this.logs.delete(id); this.seen.delete(id); this.change(id);
  }
  persist(storage: Pick<Storage, 'setItem'>) {
    if (this.savedRevision === this.revision) return;
    try { storage.setItem(TERMINAL_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.logs))); this.savedRevision = this.revision; } catch { /* Quota/private mode must not interrupt live logs. */ }
  }
  stop() { this.flush(); }
}
