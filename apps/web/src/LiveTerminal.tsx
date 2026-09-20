import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TerminalStore } from './terminal-store';

/** A bounded plain-text viewport: no HTML parsing or one DOM node per log line. */
export const LiveTerminal = memo(function LiveTerminal({ store, employeeId }: { store: TerminalStore; employeeId: string }) {
  const subscribe = useCallback((notify: () => void) => store.subscribe(employeeId, notify), [store, employeeId]);
  const snapshot = useCallback(() => store.get(employeeId), [store, employeeId]);
  const content = useSyncExternalStore(subscribe, snapshot);
  const resetSnapshot = useCallback(() => store.clearVersion, [store]);
  const clearVersion = useSyncExternalStore(subscribe, resetSnapshot);
  const [following, setFollowing] = useState(true);
  const [frozen, setFrozen] = useState('');
  const [frozenVersion, setFrozenVersion] = useState(clearVersion);
  const view = useRef<HTMLPreElement>(null);
  const visible = following || frozenVersion !== clearVersion ? content : frozen;
  useEffect(() => { setFrozen(''); setFrozenVersion(clearVersion); setFollowing(true); }, [clearVersion]);
  useEffect(() => {
    if (!following) return;
    const frame = requestAnimationFrame(() => { if (view.current) view.current.scrollTop = view.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [following, content]);
  const pause = () => { setFrozen(content); setFrozenVersion(clearVersion); setFollowing(false); };
  return <section className="live-terminal" aria-label={`${employeeId} 实时日志`}>
    <div className="terminal-toolbar">
      <span className={following ? 'terminal-live' : 'terminal-paused'}>{following ? '● 实时日志' : 'Ⅱ 已暂停跟随'}</span>
      <span className="terminal-retention">最近 6 万字符</span>
      <button className="terminal-follow" onClick={() => following ? pause() : setFollowing(true)}>
        {following ? '暂停跟随' : content !== frozen ? '有新输出 · 回到底部' : '回到底部'}
      </button>
    </div>
    <pre ref={view} className="log-window" tabIndex={0} aria-label="日志内容"
      onWheel={event => { if (following && event.deltaY < 0) pause(); }}
      onTouchMove={() => { if (following) pause(); }}
      onKeyDown={event => { if (following && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause(); }}
      onScroll={() => { const el = view.current; if (following && el && el.scrollHeight - el.clientHeight - el.scrollTop > 40) pause(); }}
    >{visible || '等待任务输出…'}</pre>
  </section>;
});
