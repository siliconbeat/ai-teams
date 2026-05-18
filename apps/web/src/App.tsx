import { useEffect, useMemo, useRef, useState } from "react";
import {
  isEncryptedEnvelope,
  parseJsonMessage,
  parseServerToLeaderMessage,
  resolveAtAgentsFromPrompt,
  type AgentTarget,
  EmployeeSnapshot,
  LeaderToServerMessage,
  ServerToLeaderMessage,
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
} from "@ai-teams/shared";

// ---------------------------------------------------------------------------
// Web Crypto E2E decryption (AES-256-GCM)
// ---------------------------------------------------------------------------

// @ts-expect-error Vite injects import.meta.env at build time
const ENCRYPTION_KEY_HEX: string | undefined = import.meta.env?.VITE_AI_TEAMS_ENCRYPTION_KEY as string | undefined;

async function webCryptoDecrypt(raw: string): Promise<string> {
  if (!ENCRYPTION_KEY_HEX) return raw;
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedEnvelope(parsed)) return raw;
  const keyBytes = new Uint8Array(
    Array.from({ length: 32 }, (_, i) => parseInt(ENCRYPTION_KEY_HEX.slice(i * 2, i * 2 + 2), 16)),
  );
  const iv = Uint8Array.from(atob(parsed.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(parsed.ciphertext), (c) => c.charCodeAt(0));
  const tag = Uint8Array.from(atob(parsed.tag), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, combined);
  return new TextDecoder().decode(decrypted);
}

function webCryptoEncrypt(plainText: string): Promise<string> {
  if (!ENCRYPTION_KEY_HEX) return Promise.resolve(plainText);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = new Uint8Array(
    Array.from({ length: 32 }, (_, i) => parseInt(ENCRYPTION_KEY_HEX.slice(i * 2, i * 2 + 2), 16)),
  );
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]).then((key) =>
    crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(plainText))
      .then((encrypted) => {
        const encryptedBytes = new Uint8Array(encrypted);
        const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
        const tag = encryptedBytes.slice(encryptedBytes.length - 16);
        return JSON.stringify({
          encrypted: true,
          iv: btoa(String.fromCharCode(...iv)),
          ciphertext: btoa(String.fromCharCode(...ciphertext)),
          tag: btoa(String.fromCharCode(...tag)),
        });
      })
  );
}

type CommandDraft = {
  prompt: string;
  workspace: string;
};

type CommandHistoryItem = {
  id: string;
  target: AgentTarget;
  prompt: string;
  createdAt: string;
  createdAtMs: number;
};

type ChatFeedItem = {
  id: string;
  side: "leader" | "employee";
  author: string;
  target?: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
  status?: TaskStatus;
  executingBy?: string[];
};

type EmployeeTerminalLog = {
  content: string;
  seenTaskIds: string[];
  seenOutputIds: string[];
  seenFinishedTaskIds: string[];
};

type ActivePage = "monitor" | "tasks" | "employees" | "errors" | "stats";

const TASK_FILTERS: Array<TaskStatus | "all"> = ["all", "running", "failed", "completed", "cancelled"];
const TOKEN_STORAGE_KEY = "ai-teams.auth-token";
const TERMINAL_LOG_STORAGE_KEY = "ai-teams.employee-terminal-logs";
const MAX_TERMINAL_LOG_CHARS_PER_EMPLOYEE = 200_000;
const MAX_TERMINAL_LOG_MARKERS_PER_EMPLOYEE = 5000;

function getInitialToken() {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_AI_TEAMS_AUTH_TOKEN || localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

function createTerminalLog(): EmployeeTerminalLog {
  return {
    content: "",
    seenTaskIds: [],
    seenOutputIds: [],
    seenFinishedTaskIds: [],
  };
}

function loadTerminalLogs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TERMINAL_LOG_STORAGE_KEY) || "{}") as Record<
      string,
      Partial<EmployeeTerminalLog>
    >;
    return Object.fromEntries(
      Object.entries(parsed).map(([employeeId, log]) => [
        employeeId,
        {
          content: typeof log.content === "string" ? log.content : "",
          seenTaskIds: Array.isArray(log.seenTaskIds) ? log.seenTaskIds.filter(isString) : [],
          seenOutputIds: Array.isArray(log.seenOutputIds) ? log.seenOutputIds.filter(isString) : [],
          seenFinishedTaskIds: Array.isArray(log.seenFinishedTaskIds) ? log.seenFinishedTaskIds.filter(isString) : [],
        },
      ]),
    );
  } catch {
    return {};
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function trimTerminalLog(content: string) {
  return content.length > MAX_TERMINAL_LOG_CHARS_PER_EMPLOYEE
    ? content.slice(-MAX_TERMINAL_LOG_CHARS_PER_EMPLOYEE)
    : content;
}

function trimMarkers(markers: string[]) {
  return markers.slice(-MAX_TERMINAL_LOG_MARKERS_PER_EMPLOYEE);
}

function isTerminalStatus(status: TaskStatus) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}

export default function App() {
  const [authToken, setAuthToken] = useState(getInitialToken);
  const [tokenDraft, setTokenDraft] = useState(authToken);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showReconnect, setShowReconnect] = useState(false);
  const [employees, setEmployees] = useState<Record<string, EmployeeSnapshot>>({});
  const [tasks, setTasks] = useState<Record<string, TaskRecord>>({});
  const [logs, setLogs] = useState<Record<string, TaskOutputChunk[]>>({});
  const [terminalLogs, setTerminalLogs] = useState<Record<string, EmployeeTerminalLog>>(loadTerminalLogs);
  const [history, setHistory] = useState<CommandHistoryItem[]>([]);
  const [activePage, setActivePage] = useState<ActivePage>("monitor");
  const [taskFilter, setTaskFilter] = useState<TaskStatus | "all">("all");
  const [taskDisplayLimit, setTaskDisplayLimit] = useState(30);
  const [selectedTarget, setSelectedTarget] = useState<AgentTarget>("queue");
  const [draft, setDraft] = useState<CommandDraft>({
    prompt: "",
    workspace: "",
  });
  const [mobileTerminalEmployeeId, setMobileTerminalEmployeeId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logWindowRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const mobileChatRef = useRef<HTMLDivElement | null>(null);
  const mobileTerminalRef = useRef<HTMLPreElement | null>(null);
  const mobileTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let showReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connectLeader() {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(`${protocol}//${window.location.host}/ws/leader`);
      url.searchParams.set("token", authToken);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        setConnected(true);
        setConnectionError(null);
        setShowReconnect(false);
        if (showReconnectTimer) { clearTimeout(showReconnectTimer); showReconnectTimer = null; }
      };

      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        setConnected(false);
        // Show reconnect button after 10s if still not connected
        if (showReconnectTimer) clearTimeout(showReconnectTimer);
        showReconnectTimer = setTimeout(() => setShowReconnect(true), 10000);
        reconnectTimer = setTimeout(connectLeader, 3000);
      };

      ws.onerror = () => {
        if (disposed) return;
        setShowReconnect(true);
      };

      ws.onmessage = async (event) => {
        if (disposed) return;
        try {
          const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
          const decrypted = await webCryptoDecrypt(raw);
          const message = parseServerToLeaderMessage(parseJsonMessage(decrypted));
          handleLeaderEvent(message);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : "服务端消息格式错误。");
        }
      };
    }

    connectLeader();

    // Reconnect when page becomes visible after background suspension
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        wsRef.current = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        connectLeader();
      } else if (ws.readyState === WebSocket.OPEN) {
        // Ping to verify the connection is truly alive
        ws.send("");
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (showReconnectTimer) clearTimeout(showReconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [authToken]);

  function handleLeaderEvent(message: ServerToLeaderMessage) {
    switch (message.type) {
      case "snapshot": {
        setEmployees(Object.fromEntries(message.snapshot.employees.map((item) => [item.id, item])));
        setTasks(Object.fromEntries(message.snapshot.tasks.map((item) => [item.id, item])));
        setLogs(message.snapshot.logs);
        break;
      }
      case "employee.upsert": {
        setEmployees((current) => ({ ...current, [message.employee.id]: message.employee }));
        break;
      }
      case "task.upsert": {
        setTasks((current) => ({ ...current, [message.task.id]: message.task }));
        break;
      }
      case "task.output": {
        setLogs((current) => {
          const history = current[message.chunk.taskId] ?? [];
          const next = [...history, message.chunk].slice(-400);
          return { ...current, [message.chunk.taskId]: next };
        });
        break;
      }
      case "server.error":
      case "command.error": {
        setConnectionError(message.message);
        break;
      }
    }
  }

  const employeeList = useMemo(
    () => Object.values(employees).sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );

  const activeTasksByEmployee = useMemo(() => {
    const map: Record<string, { main?: TaskRecord; queue?: TaskRecord }> = {};
    for (const employee of employeeList) {
      map[employee.id] = {
        main: employee.mainTaskId ? tasks[employee.mainTaskId] : undefined,
        queue: employee.queueTaskId ? tasks[employee.queueTaskId] : undefined,
      };
    }
    return map;
  }, [employeeList, tasks]);

  const latestTasksByEmployee = useMemo(() => {
    const map: Record<string, TaskRecord | undefined> = {};
    for (const task of Object.values(tasks)) {
      if (!task.employeeId) {
        continue;
      }
      const current = map[task.employeeId];
      if (!current || task.createdAt > current.createdAt) {
        map[task.employeeId] = task;
      }
    }
    return map;
  }, [tasks]);

  const displayTasksByEmployee = useMemo(() => {
    const map: Record<string, TaskRecord | undefined> = {};
    for (const employee of employeeList) {
      const slots = activeTasksByEmployee[employee.id];
      map[employee.id] = slots?.main ?? slots?.queue ?? latestTasksByEmployee[employee.id];
    }
    return map;
  }, [activeTasksByEmployee, employeeList, latestTasksByEmployee]);

  const taskListAll = useMemo(() => {
    return Object.values(tasks)
      .filter((task) => taskFilter === "all" || task.status === taskFilter)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [taskFilter, tasks]);

  const taskList = useMemo(() => {
    return taskListAll.slice(0, taskDisplayLimit);
  }, [taskListAll, taskDisplayLimit]);

  const taskHasMore = taskListAll.length > taskDisplayLimit;

  const chatFeed = useMemo<ChatFeedItem[]>(() => {
    // Group tasks by leaderCommandId to deduplicate broadcast commands
    const commandGroups = new Map<string, TaskRecord[]>();
    for (const task of Object.values(tasks)) {
      const key = task.leaderCommandId;
      const group = commandGroups.get(key);
      if (group) group.push(task);
      else commandGroups.set(key, [task]);
    }

    const leaderItems: ChatFeedItem[] = [];
    for (const groupTasks of commandGroups.values()) {
      const first = groupTasks[0];
      const targetMode = first.targetMode;
      let target: string | undefined;
      if (targetMode === "queue") {
        target = "任务队列";
      } else if (targetMode === "broadcast") {
        target = "@全部员工";
      } else {
        target = groupTasks
          .map((t) => (t.employeeId ? `@${employees[t.employeeId]?.name ?? t.employeeId}` : ""))
          .filter(Boolean)
          .join(" ");
      }
      const executingBy = groupTasks
        .filter((t) => t.employeeId && (t.status === "dispatched" || t.status === "accepted" || t.status === "running"))
        .map((t) => employees[t.employeeId!]?.name ?? t.employeeId!);
      leaderItems.push({
        id: `leader-${first.leaderCommandId}`,
        side: "leader",
        author: "Leader",
        target: target || undefined,
        content: first.prompt,
        createdAt: new Date(first.createdAt).toLocaleTimeString(),
        createdAtMs: new Date(first.createdAt).getTime(),
        executingBy: executingBy.length > 0 ? executingBy : undefined,
      });
    }

    const employeeItems: ChatFeedItem[] = Object.values(tasks)
      .filter((task) => task.finishedAt && isTerminalStatus(task.status))
      .map((task) => ({
        id: `employee-${task.id}`,
        side: "employee" as const,
        author: task.employeeId ? employees[task.employeeId]?.name ?? task.employeeId : "任务队列",
        content: task.summary || task.error || statusToMessage(task.status),
        createdAt: new Date(task.finishedAt ?? task.createdAt).toLocaleTimeString(),
        createdAtMs: new Date(task.finishedAt ?? task.createdAt).getTime(),
        status: task.status,
      }));

    return [...leaderItems, ...employeeItems].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }, [employees, tasks]);

  function formatTarget(target: AgentTarget, employeeMap: Record<string, EmployeeSnapshot>) {
    if (target === "queue") {
      return "任务队列";
    }
    if (target === "all") {
      return "@全部员工";
    }
    return target.map((id) => `@${employeeMap[id]?.name ?? id}`).join(" ");
  }

  function statusToMessage(status: TaskStatus) {
    if (status === "completed") {
      return "任务已完成。";
    }
    if (status === "cancelled") {
      return "任务已取消。";
    }
    if (status === "timeout") {
      return "任务已超时。";
    }
    if (status === "failed") {
      return "任务执行失败。";
    }
    return `任务状态：${status}`;
  }

  function getAgentPresence(employee: EmployeeSnapshot, activeTask?: TaskRecord) {
    if (employee.status === "offline") {
      return { label: "离线", className: "offline" };
    }
    if (!activeTask) {
      return { label: "在线", className: "online" };
    }
    if (activeTask.status === "dispatched") {
      return { label: "派发中", className: "dispatched" };
    }
    if (activeTask.status === "accepted") {
      return { label: "已接单", className: "accepted" };
    }
    if (activeTask.status === "running") {
      return { label: "任务中", className: "busy" };
    }
    return { label: "在线", className: "online" };
  }

  function buildTaskHeader(task: TaskRecord) {
    const receivedAt = new Date(task.createdAt).toLocaleTimeString();
    return [
      `$ received task ${task.id.slice(0, 8)} @ ${receivedAt}`,
      `$ leader: ${task.prompt}`,
      task.workspace ? `$ workspace: ${task.workspace}` : "$ workspace: default",
      `$ status: ${task.status}`,
      "",
    ].join("\n");
  }

  function buildTaskFinishedLine(task: TaskRecord) {
    const finishedAt = task.finishedAt ? new Date(task.finishedAt).toLocaleTimeString() : new Date().toLocaleTimeString();
    const errorLine = task.error ? `\n$ error: ${task.error}` : "";
    return `\n$ finished: ${task.status} @ ${finishedAt}${errorLine}\n`;
  }

  function saveToken() {
    const next = tokenDraft.trim();
    if (!next) {
      return;
    }
    localStorage.setItem(TOKEN_STORAGE_KEY, next);
    setAuthToken(next);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setAuthToken("");
    setTokenDraft("");
    setConnected(false);
    wsRef.current?.close();
  }

  function toggleTarget(employeeId: string) {
    setSelectedTarget((current) => {
      const currentIds = current === "all" || current === "queue" ? [] : current;
      const next = currentIds.includes(employeeId)
        ? currentIds.filter((id) => id !== employeeId)
        : [...currentIds, employeeId];
      return next.length === 0 ? "queue" : next;
    });
  }

  function selectQueueTarget() {
    setSelectedTarget("queue");
  }

  function selectAllTargets() {
    setSelectedTarget("all");
  }

  function sendCommand() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !draft.prompt.trim()) {
      return;
    }

    const resolved = resolveAtAgentsFromPrompt(draft.prompt.trim(), employeeList, selectedTarget);
    const commandPrompt = resolved.prompt || draft.prompt.trim();
    const payload: LeaderToServerMessage = {
      type: "command.dispatch",
      atAgents: resolved.atAgents,
      prompt: commandPrompt,
      workspace: draft.workspace.trim() || undefined,
    };

    webCryptoEncrypt(JSON.stringify(payload)).then((encrypted) => {
      wsRef.current?.send(encrypted);
    });
    setHistory((current) => [
      ...current,
      {
        id: `${Date.now()}`,
        target: resolved.atAgents,
        prompt: commandPrompt,
        createdAt: new Date().toLocaleTimeString(),
        createdAtMs: Date.now(),
      },
    ]);
    setDraft((current) => ({ ...current, prompt: "" }));
    if (mobileTextareaRef.current) mobileTextareaRef.current.style.height = "auto";
  }

  function cancelTask(taskId: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload: LeaderToServerMessage = { type: "task.cancel", taskId };
    webCryptoEncrypt(JSON.stringify(payload)).then((encrypted) => {
      wsRef.current?.send(encrypted);
    });
  }

  useEffect(() => {
    for (const element of Object.values(logWindowRefs.current)) {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }, [terminalLogs]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_LOG_STORAGE_KEY, JSON.stringify(terminalLogs));
  }, [terminalLogs]);

  useEffect(() => {
    const taskEntries = Object.values(tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (taskEntries.length === 0) {
      return;
    }

    setTerminalLogs((current) => {
      let changed = false;
      const next: Record<string, EmployeeTerminalLog> = { ...current };

      for (const task of taskEntries) {
        if (!task.employeeId) {
          continue;
        }
        const employeeId = task.employeeId;
        const currentLog = next[employeeId] ?? createTerminalLog();
        const seenTaskIds = new Set(currentLog.seenTaskIds);
        const seenOutputIds = new Set(currentLog.seenOutputIds);
        const seenFinishedTaskIds = new Set(currentLog.seenFinishedTaskIds);
        let content = currentLog.content;
        let entryChanged = false;

        if (!seenTaskIds.has(task.id)) {
          content = `${content}${content ? "\n" : ""}${buildTaskHeader(task)}`;
          seenTaskIds.add(task.id);
          entryChanged = true;
        }

        const taskLogs = [...(logs[task.id] ?? [])].sort((a, b) => a.seq - b.seq);
        for (const chunk of taskLogs) {
          const outputId = `${task.id}:${chunk.seq}`;
          if (seenOutputIds.has(outputId)) {
            continue;
          }
          content = `${content}${chunk.content}`;
          seenOutputIds.add(outputId);
          entryChanged = true;
        }

        if (isTerminalStatus(task.status) && !seenFinishedTaskIds.has(task.id)) {
          content = `${content}${buildTaskFinishedLine(task)}`;
          seenFinishedTaskIds.add(task.id);
          entryChanged = true;
        }

        if (entryChanged) {
          changed = true;
          next[employeeId] = {
            content: trimTerminalLog(content),
            seenTaskIds: trimMarkers([...seenTaskIds]),
            seenOutputIds: trimMarkers([...seenOutputIds]),
            seenFinishedTaskIds: trimMarkers([...seenFinishedTaskIds]),
          };
        } else if (!next[employeeId]) {
          next[employeeId] = currentLog;
        }
      }

      return changed ? next : current;
    });
  }, [logs, tasks]);

  function scrollToBottom(ref: React.RefObject<HTMLDivElement | null>) {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  useEffect(() => {
    scrollToBottom(chatListRef);
    scrollToBottom(mobileChatRef);
  }, [chatFeed]);

  useEffect(() => {
    if (mobileTerminalEmployeeId && mobileTerminalRef.current) {
      requestAnimationFrame(() => {
        if (mobileTerminalRef.current) {
          mobileTerminalRef.current.scrollTop = mobileTerminalRef.current.scrollHeight;
        }
      });
    }
  }, [mobileTerminalEmployeeId, terminalLogs]);

  if (!authToken) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand auth-brand">
            <span className="brand-badge">AI</span>
            <div>
              <strong>AI Teams</strong>
              <p>员工协作控制台</p>
            </div>
          </div>
          <label className="field">
            <span>访问 Token</span>
            <input
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveToken();
                }
              }}
              placeholder="AI_TEAMS_AUTH_TOKEN"
              type="password"
            />
          </label>
          <button className="primary-button" onClick={saveToken}>
            连接控制台
          </button>
        </div>
      </div>
    );
  }

  // Mobile agent status pills
  const mobileAgentStatus = employeeList.map((employee) => {
    const slots = activeTasksByEmployee[employee.id];
    const activeTask = slots?.main ?? slots?.queue;
    const isOnline = employee.status !== "offline";
    const isBusy = activeTask && ["running", "accepted", "dispatched"].includes(activeTask.status);
    const presenceClass = !isOnline ? "offline" : isBusy ? "busy" : "online";
    const taskLabel = activeTask && isBusy
      ? activeTask.prompt.length > 20 ? activeTask.prompt.slice(0, 20) + "..." : activeTask.prompt
      : "";
    return { employee, presenceClass, taskLabel };
  });

  return (
    <div className="app-shell">
      {showReconnect && !connected && (
        <div className="reconnect-overlay" onClick={() => window.location.reload()}>
          刷新
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-badge">AI</span>
          <div>
            <strong>AI Teams</strong>
            <p>员工协作控制台</p>
          </div>
        </div>
        <nav className="nav-list">
          <button
            className={`nav-item ${activePage === "monitor" ? "active" : ""}`}
            onClick={() => setActivePage("monitor")}
          >
            监控台
          </button>
          <button
            className={`nav-item ${activePage === "employees" ? "active" : ""}`}
            onClick={() => setActivePage("employees")}
          >
            员工管理
          </button>
          <button
            className={`nav-item ${activePage === "tasks" ? "active" : ""}`}
            onClick={() => setActivePage("tasks")}
          >
            任务日志
          </button>
          <button
            className={`nav-item ${activePage === "errors" ? "active" : ""}`}
            onClick={() => setActivePage("errors")}
          >
            异常记录
          </button>
          <button
            className={`nav-item ${activePage === "stats" ? "active" : ""}`}
            onClick={() => setActivePage("stats")}
          >
            统计分析
          </button>
        </nav>
        <button className="secondary-button mobile-logout" onClick={clearToken}>
          ⏻
        </button>
      </header>

      {/* Mobile: agent status bar */}
      <div className="mobile-status-bar">
        {mobileAgentStatus.length === 0 ? (
          <div className="mobile-agent-pill offline">
            <span className="dot" />
            <span className="agent-name">暂无员工</span>
          </div>
        ) : (
          mobileAgentStatus.map(({ employee, presenceClass, taskLabel }) => (
            <div
              className={`mobile-agent-pill ${presenceClass} ${mobileTerminalEmployeeId === employee.id ? "selected" : ""}`}
              key={employee.id}
              onClick={() => setMobileTerminalEmployeeId(mobileTerminalEmployeeId === employee.id ? null : employee.id)}
            >
              <span className="dot" />
              <span className="agent-name">{employee.name}</span>
              {taskLabel ? <span className="agent-task">{taskLabel}</span> : null}
            </div>
          ))
        )}
      </div>

      {/* Mobile: terminal overlay */}
      {mobileTerminalEmployeeId && (() => {
        const emp = employees[mobileTerminalEmployeeId];
        const text = terminalLogs[mobileTerminalEmployeeId]?.content || "等待输出...";
        return (
          <div className="mobile-terminal-overlay" onClick={() => setMobileTerminalEmployeeId(null)}>
            <div className="mobile-terminal-card" onClick={(e) => e.stopPropagation()}>
              <div className="mobile-terminal-header">
                <span>{emp?.name ?? mobileTerminalEmployeeId}</span>
                <button onClick={() => setMobileTerminalEmployeeId(null)}>✕</button>
              </div>
              <pre className="mobile-terminal-content" ref={mobileTerminalRef}>{text}</pre>
            </div>
          </div>
        );
      })()}

      {/* Mobile: chat feed */}
      <div className="mobile-chat-feed" ref={mobileChatRef}>
        {chatFeed.length === 0 ? (
          <div className="mobile-chat-empty">还没有发送过指令。</div>
        ) : (
          chatFeed.map((item) =>
            item.side === "leader" ? (
              <div className="leader-message-wrapper" key={item.id}>
                <div className={`chat-message leader-message ${item.status ? `task-${item.status}` : ""}`}>
                  <p>{item.content}</p>
                  {item.target ? <small>{item.target}</small> : null}
                  {item.executingBy && item.executingBy.length > 0 && (
                    <div className="chat-message__executing">
                      {item.executingBy.map((name) => (
                        <span key={name}>● {name} 执行中</span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="chat-message__time-outside">{item.createdAt}</span>
              </div>
            ) : (
              <div className={`chat-message employee-message ${item.status ? `task-${item.status}` : ""}`} key={item.id}>
                <div className="chat-message__meta">
                  <strong>{item.author}</strong>
                  <span>{item.createdAt}</span>
                </div>
                <p>{item.content}</p>
              </div>
            )
          )
        )}
      </div>

      {/* Mobile: command input */}
      <div className="mobile-input-bar">
        <div className="mobile-target-row">
          <button
            className={`target-chip ${selectedTarget === "queue" ? "active" : ""}`}
            onClick={selectQueueTarget}
          >
            队列
          </button>
          <button
            className={`target-chip ${selectedTarget === "all" ? "active" : ""}`}
            onClick={selectAllTargets}
          >
            全部
          </button>
          {employeeList.map((employee) => {
            const selected = selectedTarget !== "all" && selectedTarget !== "queue" && selectedTarget.includes(employee.id);
            return (
              <button
                className={`target-chip ${selected ? "active" : ""}`}
                key={employee.id}
                onClick={() => toggleTarget(employee.id)}
              >
                {employee.name}
              </button>
            );
          })}
        </div>
        <div className="mobile-input-row">
          <textarea
            ref={mobileTextareaRef}
            value={draft.prompt}
            onChange={(event) => {
              setDraft((current) => ({ ...current, prompt: event.target.value }));
              event.target.style.height = "auto";
              event.target.style.height = Math.min(event.target.scrollHeight, 120) + "px";
            }}
            placeholder="输入指令..."
            rows={1}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.altKey || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              sendCommand();
            }}
          />
          <button
            className="send-btn"
            onClick={sendCommand}
            disabled={!draft.prompt.trim()}
          >
            ▲
          </button>
        </div>
      </div>

      <div className="workspace-panel">
        {activePage === "monitor" && (
          <main className="board">
            <header className="board-header">
              <div>
                <h1>AI 员工监控</h1>
                <p>{connectionError ?? (connected ? "已连接服务端" : "正在等待服务端连接")}</p>
              </div>
              <div className={`status-pill ${connected ? "online" : "offline"}`}>
                {connected ? "Leader Online" : "Leader Offline"}
              </div>
            </header>

            <section className="employee-grid">
              {employeeList.length === 0 ? (
                <div className="empty-state">暂无员工接入。先启动服务端和员工端。</div>
              ) : (
                employeeList.map((employee) => {
                  const slots = activeTasksByEmployee[employee.id];
                  const mainTask = slots?.main;
                  const queueTask = slots?.queue;
                  const activeTask = mainTask ?? queueTask;
                  const task = displayTasksByEmployee[employee.id];
                  const taskStatus = activeTask?.status ?? task?.status ?? "idle";
                  const presence = getAgentPresence(employee, activeTask);
                  const terminalText = terminalLogs[employee.id]?.content || "等待输出...";
                  const isCancellable =
                    activeTask &&
                    (activeTask.status === "running" ||
                      activeTask.status === "accepted" ||
                      activeTask.status === "dispatched");

                  function buildSlotStrip(label: string, slotTask: TaskRecord | undefined) {
                    const isActive =
                      slotTask &&
                      (slotTask.status === "running" ||
                        slotTask.status === "accepted" ||
                        slotTask.status === "dispatched");
                    return (
                      <div className={`task-strip ${slotTask ? `task-${slotTask.status}` : ""}`}>
                        <span>
                          {slotTask
                            ? `[${label}] ${slotTask.prompt}`
                            : `[${label}] 空闲`}
                        </span>
                        {isActive ? (
                          <button className="secondary-button" onClick={() => cancelTask(slotTask.id)}>
                            取消
                          </button>
                        ) : null}
                      </div>
                    );
                  }

                  return (
                    <article className="employee-card" key={employee.id}>
                      <div className="employee-card__header">
                        <div>
                          <div className="employee-card__title">
                            <h2>{employee.name}</h2>
                            <span className={`task-state-badge task-${taskStatus}`}>{taskStatus}</span>
                          </div>
                        </div>
                        <div className={`status-pill agent-presence ${presence.className}`}>
                          {presence.label}
                        </div>
                      </div>
                      <div className="employee-meta">
                        <span>{employee.hostname}</span>
                        <span>ID: {employee.id}</span>
                        <span>标签: {employee.labels.join(", ") || "未设置"}</span>
                      </div>
                      {buildSlotStrip("主任务", mainTask)}
                      {buildSlotStrip("队列", queueTask)}
                      <pre
                        className="log-window"
                        ref={(element) => {
                          logWindowRefs.current[employee.id] = element;
                        }}
                      >
                        {terminalText}
                      </pre>
                    </article>
                  );
                })
              )}
            </section>
          </main>
        )}
        {activePage === "tasks" && (
          <main className="task-log-page">
            <section className="task-log-panel">
              <div className="section-title-row">
                <div>
                  <h1>任务日志</h1>
                  <p>展示最近 30 条任务，失败任务会高亮。</p>
                </div>
                <div className="filter-row">
                  {TASK_FILTERS.map((filter) => (
                    <button
                      className={`filter-chip ${taskFilter === filter ? "active" : ""}`}
                      key={filter}
                      onClick={() => { setTaskFilter(filter); setTaskDisplayLimit(30); }}
                    >
                      {filter}
                    </button>
                  ))}
                </div>
              </div>
              <div className="task-table">
                {taskList.length === 0 ? (
                  <div className="history-empty">暂无符合条件的任务。</div>
                ) : (
                  taskList.map((task) => (
                    <div className={`task-row task-${task.status}`} key={task.id}>
                      <div className="task-row__main">
                        <strong>{task.employeeId ? employees[task.employeeId]?.name ?? task.employeeId : "任务队列"}</strong>
                        <p>{task.prompt}</p>
                        {task.error ? <span className="error-text">{task.error}</span> : null}
                      </div>
                      <div className="task-row__side">
                        <span className={`status-pill ${task.status}`}>{task.status}</span>
                        <small>{new Date(task.createdAt).toLocaleTimeString()}</small>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {taskHasMore && (
                <button
                  className="primary-button"
                  style={{ marginTop: "10px" }}
                  onClick={() => setTaskDisplayLimit((n) => n + 30)}
                >
                  加载更多（剩余 {taskListAll.length - taskDisplayLimit} 条）
                </button>
              )}
            </section>
          </main>
        )}
        {activePage === "employees" && (
          <main className="task-log-page">
            <section className="task-log-panel">
              <div className="section-title-row">
                <div>
                  <h1>员工管理</h1>
                  <p>所有已注册的 AI 员工及其状态。</p>
                </div>
              </div>
              <div className="task-table">
                {employeeList.length === 0 ? (
                  <div className="history-empty">暂无员工注册。</div>
                ) : (
                  employeeList.map((emp) => {
                    const empTasks = Object.values(tasks).filter((t) => t.employeeId === emp.id);
                    const completed = empTasks.filter((t) => t.status === "completed").length;
                    const failed = empTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
                    return (
                      <div className="task-row" key={emp.id} style={{ gap: 12 }}>
                        <div className="task-row__main">
                          <strong>{emp.name} <small style={{ color: "#888" }}>({emp.id})</small></strong>
                          <p>主机: {emp.hostname} | 标签: {emp.labels.length > 0 ? emp.labels.join(", ") : "无"}</p>
                          <p>完成: {completed} | 失败: {failed} | 总任务: {empTasks.length}</p>
                        </div>
                        <div className="task-row__side">
                          <span className={`status-pill ${emp.status}`}>{emp.status}</span>
                          <small>{new Date(emp.lastSeenAt).toLocaleTimeString()}</small>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </main>
        )}
        {activePage === "errors" && (() => {
          const errorTasks = Object.values(tasks).filter(
            (t) => ["failed", "timeout", "cancelled"].includes(t.status),
          );
          return (
            <main className="task-log-page">
              <section className="task-log-panel">
                <div className="section-title-row">
                  <div>
                    <h1>异常记录</h1>
                    <p>失败、超时和取消的任务。</p>
                  </div>
                </div>
                <div className="task-table">
                  {errorTasks.length === 0 ? (
                    <div className="history-empty">暂无异常任务。</div>
                  ) : (
                    errorTasks.map((task) => (
                      <div className={`task-row task-${task.status}`} key={task.id} style={{ gap: 12 }}>
                        <div className="task-row__main">
                          <strong>{task.employeeId ? employees[task.employeeId]?.name ?? task.employeeId : "任务队列"}</strong>
                          <p>{task.prompt}</p>
                          {task.error ? <span className="error-text">{task.error}</span> : null}
                          {task.durationMs != null && <small>耗时: {(task.durationMs / 1000).toFixed(1)}s</small>}
                        </div>
                        <div className="task-row__side">
                          <span className={`status-pill ${task.status}`}>{task.status}</span>
                          <small>{new Date(task.createdAt).toLocaleTimeString()}</small>
                          <button
                            className="secondary-button"
                            style={{ marginTop: 4, fontSize: 12 }}
                            onClick={() => {
                              setDraft((d) => ({ ...d, prompt: task.prompt }));
                              setSelectedTarget(task.employeeId ? [task.employeeId] : "queue");
                            }}
                          >
                            重试
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </main>
          );
        })()}
        {activePage === "stats" && (() => {
          const allTasks = Object.values(tasks);
          const total = allTasks.length;
          const completed = allTasks.filter((t) => t.status === "completed").length;
          const failed = allTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
          const running = allTasks.filter((t) => t.status === "running").length;
          const totalCost = allTasks.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
          const totalDurationMs = allTasks.filter((t) => t.durationMs != null).reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
          const avgDuration = completed > 0 ? totalDurationMs / completed : 0;
          return (
            <main className="task-log-page">
              <section className="task-log-panel">
                <div className="section-title-row">
                  <div>
                    <h1>统计分析</h1>
                    <p>任务执行概览。</p>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
                  {[
                    { label: "总任务", value: total, color: "#6366f1" },
                    { label: "已完成", value: completed, color: "#22c55e" },
                    { label: "失败/超时", value: failed, color: "#ef4444" },
                    { label: "执行中", value: running, color: "#f59e0b" },
                    { label: "总费用", value: `$${totalCost.toFixed(4)}`, color: "#8b5cf6" },
                    { label: "平均耗时", value: avgDuration > 0 ? `${(avgDuration / 1000).toFixed(1)}s` : "-", color: "#06b6d4" },
                  ].map((card) => (
                    <div key={card.label} style={{ background: "#1e1e2e", borderRadius: 8, padding: 16, textAlign: "center" }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color: card.color }}>{card.value}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{card.label}</div>
                    </div>
                  ))}
                </div>
                <div className="section-title-row" style={{ marginTop: 16 }}>
                  <div><h3>各 Agent 统计</h3></div>
                </div>
                <div className="task-table">
                  {employeeList.length === 0 ? (
                    <div className="history-empty">暂无员工。</div>
                  ) : (
                    employeeList.map((emp) => {
                      const empTasks = allTasks.filter((t) => t.employeeId === emp.id);
                      const empCompleted = empTasks.filter((t) => t.status === "completed").length;
                      const empFailed = empTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
                      const empCost = empTasks.reduce((s, t) => s + (t.totalCostUsd ?? 0), 0);
                      const empAvgMs = empCompleted > 0
                        ? empTasks.filter((t) => t.durationMs != null).reduce((s, t) => s + (t.durationMs ?? 0), 0) / empCompleted
                        : 0;
                      return (
                        <div className="task-row" key={emp.id} style={{ gap: 12 }}>
                          <div className="task-row__main">
                            <strong>{emp.name}</strong>
                            <p>完成: {empCompleted} | 失败: {empFailed} | 费用: ${empCost.toFixed(4)} | 平均耗时: {empAvgMs > 0 ? `${(empAvgMs / 1000).toFixed(1)}s` : "-"}</p>
                          </div>
                          <div className="task-row__side">
                            <span className={`status-pill ${emp.status}`}>{emp.status}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </main>
          );
        })()}
      </div>

      <aside className="command-panel">
        <div className="panel-card chat-panel">
          <div className="chat-header">
            <div>
              <h2>Leader 群聊指挥中心</h2>
              <p>目标可单独选择，也可在输入中使用 <code>@Alice</code> 合并目标。</p>
            </div>
            <button className="secondary-button" onClick={clearToken}>
              切换 Token
            </button>
          </div>
          <div className="chat-list" ref={chatListRef}>
            {chatFeed.length === 0 ? (
              <div className="chat-empty">还没有发送过指令。</div>
            ) : (
              chatFeed.map((item) =>
                item.side === "leader" ? (
                  <div className="leader-message-wrapper" key={item.id}>
                    <div className={`chat-message leader-message ${item.status ? `task-${item.status}` : ""}`}>
                      <p>{item.content}</p>
                      {item.target ? <small>{item.target}</small> : null}
                      {item.executingBy && item.executingBy.length > 0 && (
                        <div className="chat-message__executing">
                          {item.executingBy.map((name) => (
                            <span key={name}>● {name} 执行中</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="chat-message__time-outside">{item.createdAt}</span>
                  </div>
                ) : (
                  <div className={`chat-message employee-message ${item.status ? `task-${item.status}` : ""}`} key={item.id}>
                    <div className="chat-message__meta">
                      <strong>{item.author}</strong>
                      <span>{item.createdAt}</span>
                    </div>
                    <p>{item.content}</p>
                  </div>
                )
              )
            )}
          </div>
          <div className="chat-composer">
            <div className="target-picker">
              <button
                className={`target-chip ${selectedTarget === "queue" ? "active" : ""}`}
                onClick={selectQueueTarget}
              >
                任务队列
              </button>
              <button
                className={`target-chip ${selectedTarget === "all" ? "active" : ""}`}
                onClick={selectAllTargets}
              >
                @所有员工
              </button>
              {employeeList.map((employee) => {
                const selected = selectedTarget !== "all" && selectedTarget !== "queue" && selectedTarget.includes(employee.id);
                return (
                  <button
                    className={`target-chip ${selected ? "active" : ""}`}
                    key={employee.id}
                    onClick={() => toggleTarget(employee.id)}
                  >
                    {employee.name}
                  </button>
                );
              })}
            </div>
            <label className="field">
              <span>工作目录（可选）</span>
              <input
                value={draft.workspace}
                onChange={(event) => setDraft((current) => ({ ...current, workspace: event.target.value }))}
                placeholder="/Users/junhang/workspace/project"
              />
            </label>
            <label className="field">
              <span>群聊输入</span>
              <textarea
                value={draft.prompt}
                onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="按 Enter 发送；Option/Alt + Enter 换行。默认进入任务队列，由一个空闲 Agent 执行；输入 @Alice 或选择 Agent 可指定会话。"
                rows={5}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.altKey || event.nativeEvent.isComposing) {
                    return;
                  }
                  event.preventDefault();
                  sendCommand();
                }}
              />
            </label>
            <button className="primary-button" onClick={sendCommand}>
              发送到群聊
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
