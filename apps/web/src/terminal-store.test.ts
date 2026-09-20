import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskOutputChunk, TaskRecord } from '@ai-teams/shared';
import { TerminalStore, TERMINAL_LIMIT } from './terminal-store';

const task = (id = 'task', employeeId = 'agent') => ({ id, employeeId, status: 'running', attempt: 1 } as TaskRecord);
const chunk = (seq: number, content = `${seq},`, taskId = 'task', employeeId = 'agent'): TaskOutputChunk => ({ seq, content, taskId, employeeId, stream: 'stdout', createdAt: '2026-09-20T00:00:00Z' });
afterEach(() => vi.useRealTimers());

describe('TerminalStore', () => {
  it('coalesces notifications without losing, duplicating or reordering a burst larger than the old 400 limit', () => {
    vi.useFakeTimers();
    const store = new TerminalStore(); store.task(task(), 'header\n', ''); store.flush();
    const changed = vi.fn(); store.subscribe('agent', changed);
    for (let i = 0; i < 1000; i++) store.output(chunk(i));
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.get('agent')).toBe('header\n' + Array.from({ length: 1000 }, (_, i) => `${i},`).join(''));
    store.output(chunk(999)); store.flush();
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('only notifies the changed employee and supports unsubscribe', () => {
    const store = new TerminalStore(); store.task(task(), '', ''); store.flush();
    const a = vi.fn(), b = vi.fn(); const stop = store.subscribe('agent', a); store.subscribe('other', b);
    store.output(chunk(1)); store.flush(); expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
    stop(); store.output(chunk(2)); store.flush(); expect(a).toHaveBeenCalledTimes(1);
  });
  it('clears pending notifications and rejects late output without resurrecting deleted content', () => {
    const store = new TerminalStore(); store.task(task(), 'header', ''); store.output(chunk(0));
    store.clear(); store.output(chunk(1)); store.flush(); expect(store.get('agent')).toBe('');
    store.task(task('new'), 'new header', ''); store.output(chunk(0, 'new output', 'new')); store.flush();
    expect(store.get('agent')).toBe('new headernew output');
  });
  it('preserves finish ordering and avoids duplicate task headers/footers on reconnect', () => {
    const store = new TerminalStore(); store.task(task(), 'header', ''); store.output(chunk(0, 'output'));
    const done = { ...task(), status: 'completed' } as TaskRecord;
    store.task(done, 'header', 'footer'); store.task(done, 'header', 'footer'); store.flush();
    expect(store.get('agent')).toBe('headeroutputfooter');
    let saved = ''; store.persist({setItem: (_key, value) => { saved = value; }});
    const restored = new TerminalStore(JSON.parse(saved)); restored.task(done, 'header', 'footer'); restored.output(chunk(0, 'output')); restored.flush();
    expect(restored.get('agent')).toBe('headeroutputfooter');
  });
  it('bounds retained text and markers and handles storage failure', () => {
    const store = new TerminalStore(); store.task(task(), 'header', '');
    for (let i = 0; i < 5000; i++) store.output(chunk(i, `line${i}\n` + 'x'.repeat(100)));
    expect(store.get('agent').length).toBe(TERMINAL_LIMIT);
    let saved = ''; store.persist({setItem: (_key, value) => { saved = value; }});
    expect(JSON.parse(saved).agent.seenOutputIds).toHaveLength(1500);
    store.output(chunk(5001)); expect(() => store.persist({setItem: () => { throw Error('quota'); }})).not.toThrow();
    store.stop();
  });
  it('accepts restarted sequence numbers on a new attempt of the same task', () => {
    const store = new TerminalStore(); store.task(task(), 'first:', ''); store.output(chunk(0, 'one'));
    store.task({ ...task(), attempt: 2 }, 'retry:', ''); store.output(chunk(0, 'two')); store.flush();
    expect(store.get('agent')).toBe('first:one\nretry:two');
    store.output(chunk(0, 'two')); store.flush(); expect(store.get('agent')).toBe('first:one\nretry:two');
  });
});
