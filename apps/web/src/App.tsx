import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { XProvider } from "@ant-design/x";
import { Avatar, ConfigProvider, theme } from "antd";
import { Bubble, ThoughtChain, Sender, Suggestion } from "@ant-design/x";
import type { BubbleProps } from "@ant-design/x";

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

type ExecutingAgent = {
  name: string;
  status: TaskStatus;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderTerminalHtml(text: string): string {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const escaped = escapeHtml(line);
    let cls = "term-output";
    if (line.startsWith("$ ") || line.startsWith("$\t")) {
      cls = "term-meta";
    } else if (line.startsWith("[done]")) {
      cls = "term-done";
    } else if (line.startsWith("[tool]")) {
      cls = "term-tool";
    } else if (line.startsWith("[agent]")) {
      cls = "term-agent";
    }
    return `<span class="${cls}">${escaped}${i < lines.length - 1 ? "\n" : ""}</span>`;
  }).join("");
}

type ChatFeedItem = {
  id: string;
  side: "leader" | "employee";
  author: string;
  target?: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
  status?: TaskStatus;
  executingBy?: ExecutingAgent[];
};

type EmployeeTerminalLog = {
  content: string;
  seenTaskIds: string[];
  seenOutputIds: string[];
  seenFinishedTaskIds: string[];
};

type ActivePage = "monitor" | "tasks" | "employees" | "errors" | "stats" | "schedules";

type ScheduleItem = {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  targetMode: "queue" | "direct" | "broadcast";
  targetAgents: string[];
  prompt: string;
  workspace: string | null;
  timeoutSec: number | null;
  priority: number;
  requiredLabels: string[] | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ScheduleFormData = {
  name: string;
  cron: string;
  prompt: string;
  targetMode: "queue" | "direct" | "broadcast";
  targetAgents: string[];
  workspace: string;
  timeoutSec: string;
  enabled: boolean;
};

const TASK_FILTERS: Array<TaskStatus | "all"> = ["all", "running", "failed", "completed", "cancelled"];
const TOKEN_STORAGE_KEY = "ai-teams.auth-token";
const TERMINAL_LOG_STORAGE_KEY = "ai-teams.employee-terminal-logs";
const MAX_TERMINAL_LOG_CHARS_PER_EMPLOYEE = 200_000;
const MAX_TERMINAL_LOG_MARKERS_PER_EMPLOYEE = 5000;
const MAX_TASKS = 300;
const CHAT_FEED_LIMIT = 200;

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

function capTasks(map: Record<string, TaskRecord>, max: number): Record<string, TaskRecord> {
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  const terminal = entries
    .filter(([_, t]) => isTerminalStatus(t.status))
    .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  const toEvict = new Set(terminal.slice(0, entries.length - max + 20).map(([id]) => id));
  const next: Record<string, TaskRecord> = {};
  for (const [id, t] of entries) {
    if (!toEvict.has(id)) next[id] = t;
  }
  return next;
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

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function SlotStrip({ label, task, onCancel }: { label: string; task: TaskRecord | undefined; onCancel: (id: string) => void }) {
  const isActive = task && (task.status === "running" || task.status === "accepted" || task.status === "dispatched");
  const startedAt = task?.startedAt;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActive || !startedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isActive, startedAt]);

  const elapsed = isActive && startedAt ? formatElapsed(Date.now() - new Date(startedAt).getTime()) : null;

  return (
    <div className={`task-strip ${task ? `task-${task.status}` : ""}`}>
      <span title={task ? `[${label}] ${task.prompt}` : undefined}>
        {task ? `[${label}] ${task.prompt}` : `[${label}] 空闲`}
      </span>
      {isActive ? (
        <>
          {elapsed != null && <span className="task-elapsed">[{elapsed}]</span>}
          <button className="secondary-button" onClick={() => onCancel(task.id)}>
            取消
          </button>
        </>
      ) : null}
    </div>
  );
}

const EmployeeCard = memo(function EmployeeCard({
  employee,
  mainTask,
  queueTask,
  displayTask,
  terminalText,
  cancelTask,
  onResetSession,
}: {
  employee: EmployeeSnapshot;
  mainTask: TaskRecord | undefined;
  queueTask: TaskRecord | undefined;
  displayTask: TaskRecord | undefined;
  terminalText: string;
  cancelTask: (taskId: string) => void;
  onResetSession: (employeeId: string) => void;
}) {
  const logRef = useRef<HTMLPreElement | null>(null);
  const prevTerminalText = useRef(terminalText);
  const [menuOpen, setMenuOpen] = useState(false);

  const activeTask = mainTask ?? queueTask;
  const taskStatus = activeTask?.status ?? displayTask?.status ?? "idle";
  const presence = getAgentPresence(employee, activeTask);

  useEffect(() => {
    if (prevTerminalText.current !== terminalText) {
      prevTerminalText.current = terminalText;
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [terminalText]);

  return (
    <article className={`employee-card${presence.className === "busy" ? " card-busy" : ""}`}>
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
        <div className="card-menu">
          <button className="card-menu-btn" onClick={() => setMenuOpen((v) => !v)}>···</button>
          {menuOpen && (
            <>
              <div className="card-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="card-menu-dropdown">
                <button className="card-menu-item" onClick={() => { setMenuOpen(false); onResetSession(employee.id); }}>
                  重置会话
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="employee-meta">
        <span>{employee.hostname}</span>
        <span>ID: {employee.id}{employee.version ? ` · v${employee.version}` : ""}</span>
        <span>标签: {employee.labels.join(", ") || "未设置"}</span>
      </div>
      <SlotStrip label="主任务" task={mainTask} onCancel={cancelTask} />
      <SlotStrip label="队列" task={queueTask} onCancel={cancelTask} />
      <pre className="log-window" ref={logRef} dangerouslySetInnerHTML={{ __html: renderTerminalHtml(terminalText) }} />
    </article>
  );
}, (prev, next) => {
  if (prev.terminalText !== next.terminalText) return false;
  if (prev.mainTask?.id !== next.mainTask?.id || prev.queueTask?.id !== next.queueTask?.id || prev.displayTask?.id !== next.displayTask?.id) return false;
  const pe = prev.employee, ne = next.employee;
  if (pe.status !== ne.status || pe.mainTaskId !== ne.mainTaskId || pe.queueTaskId !== ne.queueTaskId || pe.name !== ne.name || pe.consecutiveQueueFailures !== ne.consecutiveQueueFailures || pe.version !== ne.version) return false;
  if (pe.labels.length !== ne.labels.length || pe.labels.some((l, i) => l !== ne.labels[i])) return false;
  return true;
});

export default function App() {
  const [authToken, setAuthToken] = useState(getInitialToken);
  const [tokenDraft, setTokenDraft] = useState(authToken);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showReconnect, setShowReconnect] = useState(false);
  const [employees, setEmployees] = useState<Record<string, EmployeeSnapshot>>({});
  const [serverVersion, setServerVersion] = useState<string>("");
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
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleItem | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormData>({
    name: "", cron: "", prompt: "", targetMode: "queue", targetAgents: [], workspace: "", timeoutSec: "", enabled: true,
  });
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const terminalLogsRef = useRef(terminalLogs);
  terminalLogsRef.current = terminalLogs;
  const wsRef = useRef<WebSocket | null>(null);
  const mobileTerminalRef = useRef<HTMLPreElement | null>(null);

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

      ws.onclose = (event) => {
        if (disposed) return;
        wsRef.current = null;
        setConnected(false);
        if (event.code === 1008) {
          setConnectionError("认证失败：Token 无效，请检查后重新输入。");
          setShowReconnect(false);
          return;
        }
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
        setTasks(capTasks(Object.fromEntries(message.snapshot.tasks.map((item) => [item.id, item])), MAX_TASKS));
        setLogs(message.snapshot.logs);
        if (message.snapshot.serverVersion) setServerVersion(message.snapshot.serverVersion);
        break;
      }
      case "employee.upsert": {
        setEmployees((current) => ({ ...current, [message.employee.id]: message.employee }));
        break;
      }
      case "task.upsert": {
        setTasks((current) => ({ ...current, [message.task.id]: message.task }));
        if (isTerminalStatus(message.task.status)) {
          setLogs((current) => {
            if (!(message.task.id in current)) return current;
            const { [message.task.id]: _, ...rest } = current;
            return rest;
          });
        }
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

  const tasksByEmployee = useMemo(() => {
    const map = new Map<string, TaskRecord[]>();
    for (const t of Object.values(tasks)) {
      if (!t.employeeId) continue;
      const list = map.get(t.employeeId);
      if (list) list.push(t);
      else map.set(t.employeeId, [t]);
    }
    return map;
  }, [tasks]);

  const errorTasks = useMemo(() => {
    return Object.values(tasks)
      .filter((t) => ["failed", "timeout", "cancelled"].includes(t.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [tasks]);

  const statsData = useMemo(() => {
    const allTasks = Object.values(tasks);
    const total = allTasks.length;
    const completed = allTasks.filter((t) => t.status === "completed").length;
    const failed = allTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
    const running = allTasks.filter((t) => t.status === "running").length;
    const totalCost = allTasks.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
    const totalDurationMs = allTasks.filter((t) => t.durationMs != null).reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
    const avgDuration = completed > 0 ? totalDurationMs / completed : 0;
    const employeeStats = employeeList.map((emp) => {
      const empTasks = tasksByEmployee.get(emp.id) ?? [];
      const empCompleted = empTasks.filter((t) => t.status === "completed").length;
      const empFailed = empTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
      const empCost = empTasks.reduce((s, t) => s + (t.totalCostUsd ?? 0), 0);
      const empAvgMs = empCompleted > 0
        ? empTasks.filter((t) => t.durationMs != null).reduce((s, t) => s + (t.durationMs ?? 0), 0) / empCompleted
        : 0;
      return { employee: emp, completed: empCompleted, failed: empFailed, cost: empCost, avgMs: empAvgMs };
    });
    return { total, completed, failed, running, totalCost, avgDuration, employeeStats };
  }, [tasks, employeeList, tasksByEmployee]);

  const employeesData = useMemo(() => {
    return employeeList.map((emp) => {
      const empTasks = tasksByEmployee.get(emp.id) ?? [];
      const completed = empTasks.filter((t) => t.status === "completed").length;
      const failed = empTasks.filter((t) => ["failed", "timeout", "cancelled"].includes(t.status)).length;
      return { employee: emp, completed, failed, total: empTasks.length };
    });
  }, [employeeList, tasksByEmployee]);

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
        .filter((t) => t.employeeId && t.status !== "queued")
        .map((t) => ({ name: employees[t.employeeId!]?.name ?? t.employeeId!, status: t.status }));
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

    return [...leaderItems, ...employeeItems].sort((a, b) => a.createdAtMs - b.createdAtMs).slice(-CHAT_FEED_LIMIT);
  }, [employees, tasks]);

  const bubbleItems = useMemo(() =>
    chatFeed.map((item) => {
      const isLeader = item.side === "leader";
      return {
        key: item.id,
        role: isLeader ? "user" as const : "ai" as const,
        content: item.content,
        extraInfo: {
          executingBy: isLeader && item.executingBy?.length ? item.executingBy : undefined,
          taskStatus: !isLeader && item.status ? item.status : undefined,
          target: isLeader && item.target ? item.target : undefined,
          createdAt: item.createdAt,
          author: item.author,
        },
      };
    })
  , [chatFeed]);

  const suggestionItems = useMemo(() => [
    { label: "任务队列", value: "queue", description: "Round-robin to idle agents" },
    { label: "@所有员工", value: "all", description: "Broadcast to all online agents" },
    ...employeeList.map((emp) => ({
      label: `@${emp.name}`,
      value: emp.id,
      description: `Direct — ${emp.status === "online" ? "online" : "offline"}`,
      disabled: emp.status === "offline",
    })),
  ], [employeeList]);

  const handleSuggestionSelect = (value: string) => {
    if (value === "queue") {
      setSelectedTarget("queue");
    } else if (value === "all") {
      setSelectedTarget("all");
    } else {
      const emp = employees[value];
      if (!emp) return;
      setSelectedTarget((current) => {
        const currentIds = current === "all" || current === "queue" ? [] : current;
        return currentIds.includes(value) ? currentIds : [...currentIds, value];
      });
      const atName = `@${emp.name}`;
      if (!draft.prompt.includes(atName)) {
        setDraft((c) => ({ ...c, prompt: c.prompt ? `${c.prompt} ${atName}` : atName }));
      }
    }
    setSuggestionOpen(false);
  };

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

  function statusLabel(status: TaskStatus) {
    switch (status) {
      case "dispatched": case "accepted": return "等待中";
      case "running": return "执行中";
      case "completed": return "已完成";
      case "failed": return "失败";
      case "timeout": return "超时";
      case "cancelled": return "已取消";
      default: return status;
    }
  }

  function thoughtChainStatus(status: TaskStatus): "success" | "error" | "loading" | undefined {
    if (status === "completed") return "success";
    if (status === "failed" || status === "timeout") return "error";
    if (status === "running") return "loading";
    return undefined;
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
    setConnectionError(null);
    setAuthToken(next);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setAuthToken("");
    setTokenDraft("");
    setConnected(false);
    wsRef.current?.close();
  }

  // ── Schedule API helpers ──

  async function fetchSchedules() {
    try {
      const res = await fetch("/api/schedules", { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json() as { schedules: ScheduleItem[] };
        setSchedules(data.schedules);
      }
    } catch { /* ignore */ }
  }

  async function saveSchedule() {
    setScheduleError(null);
    const body: Record<string, unknown> = {
      name: scheduleForm.name,
      cron: scheduleForm.cron,
      prompt: scheduleForm.prompt,
      targetMode: scheduleForm.targetMode,
      enabled: scheduleForm.enabled,
    };
    if (scheduleForm.targetMode === "direct" && scheduleForm.targetAgents.length > 0) {
      body.targetAgents = scheduleForm.targetAgents;
    }
    if (scheduleForm.workspace.trim()) body.workspace = scheduleForm.workspace.trim();
    if (scheduleForm.timeoutSec && Number(scheduleForm.timeoutSec) > 0) body.timeoutSec = Number(scheduleForm.timeoutSec);

    const url = editingSchedule ? `/api/schedules/${editingSchedule.id}` : "/api/schedules";
    const method = editingSchedule ? "PATCH" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setScheduleError(err.error || `请求失败 (${res.status})`);
        return;
      }
      setScheduleModalOpen(false);
      setEditingSchedule(null);
      fetchSchedules();
    } catch {
      setScheduleError("网络请求失败");
    }
  }

  async function deleteSchedule(id: string) {
    try {
      const res = await fetch(`/api/schedules/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      fetchSchedules();
    } catch { /* ignore */ }
  }

  async function toggleScheduleEnabled(schedule: ScheduleItem) {
    try {
      const res = await fetch(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      if (!res.ok) return;
      fetchSchedules();
    } catch { /* ignore */ }
  }

  async function triggerSchedule(id: string) {
    try {
      const res = await fetch(`/api/schedules/${id}/trigger`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      fetchSchedules();
    } catch { /* ignore */ }
  }

  function openCreateScheduleModal() {
    setEditingSchedule(null);
    setScheduleForm({ name: "", cron: "", prompt: "", targetMode: "queue", targetAgents: [], workspace: "", timeoutSec: "", enabled: true });
    setScheduleError(null);
    setScheduleModalOpen(true);
  }

  function openEditScheduleModal(schedule: ScheduleItem) {
    setEditingSchedule(schedule);
    setScheduleForm({
      name: schedule.name,
      cron: schedule.cron,
      prompt: schedule.prompt,
      targetMode: schedule.targetMode,
      targetAgents: schedule.targetAgents,
      workspace: schedule.workspace ?? "",
      timeoutSec: schedule.timeoutSec && schedule.timeoutSec > 0 ? String(schedule.timeoutSec) : "",
      enabled: schedule.enabled,
    });
    setScheduleError(null);
    setScheduleModalOpen(true);
  }

  useEffect(() => {
    if (authToken && activePage === "schedules") fetchSchedules();
  }, [authToken, activePage]);

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
  }

  const cancelTask = useCallback((taskId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload: LeaderToServerMessage = { type: "task.cancel", taskId };
    webCryptoEncrypt(JSON.stringify(payload)).then((encrypted) => {
      wsRef.current?.send(encrypted);
    });
  }, []);

  const resetSession = useCallback((employeeId: string) => {
    fetch(`/api/agents/${employeeId}/reset-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    }).then((res) => {
      if (!res.ok) return res.json().then((d) => { alert(d.error || "重置失败"); });
    }).catch(() => { alert("网络请求失败"); });
  }, [authToken]);

  const retryTask = useCallback((task: TaskRecord) => {
    const body: Record<string, unknown> = {
      prompt: task.prompt,
    };
    if (task.targetMode === "direct" && task.employeeId) {
      body.atAgents = [task.employeeId];
    }
    if (task.cliConfig) {
      body.cliConfig = task.cliConfig;
    }
    fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) return res.json().then((d) => { alert(d.message || "重试失败"); });
    }).catch(() => { alert("网络请求失败"); });
  }, [authToken]);

  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(TERMINAL_LOG_STORAGE_KEY, JSON.stringify(terminalLogs));
    }, 500);
    return () => clearTimeout(timer);
  }, [terminalLogs]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "hidden") {
        localStorage.setItem(TERMINAL_LOG_STORAGE_KEY, JSON.stringify(terminalLogsRef.current));
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

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

        if (isTerminalStatus(task.status) && seenTaskIds.has(task.id) && seenFinishedTaskIds.has(task.id)) {
          continue;
        }

        let content = currentLog.content;
        let entryChanged = false;

        if (!seenTaskIds.has(task.id)) {
          content = `${content}${content ? "\n" : ""}${buildTaskHeader(task)}`;
          seenTaskIds.add(task.id);
          entryChanged = true;
        }

        const taskLogs = logs[task.id] ?? [];
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
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <XProvider>
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
            <strong>AI Teams{serverVersion ? ` v${serverVersion}` : ""}</strong>
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
            className={`nav-item ${activePage === "schedules" ? "active" : ""}`}
            onClick={() => setActivePage("schedules")}
          >
            定时任务
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
          <a
            className="nav-item"
            href="/docs-site/index.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            文档
          </a>
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
              <pre className="mobile-terminal-content" ref={mobileTerminalRef} dangerouslySetInnerHTML={{ __html: renderTerminalHtml(text) }} />
            </div>
          </div>
        );
      })()}

      {/* Mobile: chat feed */}
      <div className="mobile-chat-feed">
        {chatFeed.length === 0 ? (
          <div className="mobile-chat-empty">还没有发送过指令。</div>
        ) : (
          <Bubble.List
            style={{ height: "100%" }}
            autoScroll
            items={bubbleItems}
            role={{
              user: {
                placement: "end",
                avatar: <Avatar style={{ background: "#52c41a", fontSize: 11 }}>L</Avatar>,
                header: (_content: any, info: any) => {
                  const item = info.extraInfo;
                  return (
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, fontSize: 11, color: "#90a1be" }}>
                      {item.target && <span>{item.target} · </span>}
                      <span>{item.createdAt}</span>
                    </div>
                  );
                },
                contentRender: (_content: any, info: any) => {
                  const item = info.extraInfo;
                  return (
                    <div>
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{String(_content)}</div>
                      {item.executingBy?.length > 0 && (
                        <ThoughtChain
                          style={{ marginTop: 6 }}
                          items={item.executingBy.map((agent: ExecutingAgent) => ({
                            key: agent.name,
                            title: agent.name,
                            description: statusLabel(agent.status),
                            status: thoughtChainStatus(agent.status),
                          }))}
                        />
                      )}
                    </div>
                  );
                },
                styles: { content: { background: "linear-gradient(135deg, rgba(104, 182, 255, 0.28), rgba(121, 255, 209, 0.12))" } },
              },
              ai: {
                placement: "start",
                avatar: (_content: any, info: any) => {
                  const item = info.extraInfo;
                  const initial = item.author?.[0] ?? "?";
                  return <Avatar style={{ background: "#1677ff", fontSize: 11 }}>{initial}</Avatar>;
                },
                header: (_content: any, info: any) => {
                  const item = info.extraInfo;
                  return (
                    <div style={{ fontSize: 11, color: "#90a1be", display: "flex", gap: 4 }}>
                      <strong style={{ color: "#c9d6f2" }}>{item.author}</strong>
                      <span>{item.createdAt}</span>
                    </div>
                  );
                },
                contentRender: (_content: any, info: any) => {
                  const item = info.extraInfo;
                  const isError = item.taskStatus === "failed" || item.taskStatus === "timeout";
                  return <div style={isError ? { color: "#ff4d4f", fontSize: 12 } : { fontSize: 12 }}>{String(_content)}</div>;
                },
                styles: { content: { background: "rgba(255, 255, 255, 0.06)", border: "1px solid rgba(255, 255, 255, 0.08)" } },
              },
            }}
          />
        )}
      </div>

      {/* Mobile: command input */}
      <div className="mobile-input-bar">
        <Suggestion
          items={suggestionItems}
          open={suggestionOpen}
          onOpenChange={setSuggestionOpen}
          onSelect={handleSuggestionSelect}
        >
          {({ onTrigger, onKeyDown }) => (
            <Sender
              value={draft.prompt}
              onChange={(val) => {
                setDraft((c) => ({ ...c, prompt: val }));
                const lastAtIndex = val.lastIndexOf("@");
                if (lastAtIndex !== -1) {
                  const afterAt = val.slice(lastAtIndex + 1);
                  if (!afterAt.includes(" ")) {
                    onTrigger(val);
                  }
                }
              }}
              onKeyDown={onKeyDown}
              onSubmit={() => sendCommand()}
              submitType="enter"
              placeholder="输入指令... @ 选择目标"
              style={{ flexShrink: 0 }}
            />
          )}
        </Suggestion>
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
                  const terminalText = terminalLogs[employee.id]?.content || "等待输出...";
                  return (
                    <EmployeeCard
                      key={employee.id}
                      employee={employee}
                      mainTask={slots?.main}
                      queueTask={slots?.queue}
                      displayTask={displayTasksByEmployee[employee.id]}
                      terminalText={terminalText}
                      cancelTask={cancelTask}
                      onResetSession={resetSession}
                    />
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
                        {task.status === "failed" && (
                          <button className="retry-btn" onClick={() => retryTask(task)}>重试</button>
                        )}
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
                {employeesData.length === 0 ? (
                  <div className="history-empty">暂无员工注册。</div>
                ) : (
                  employeesData.map((ed) => (
                    <div className="task-row" key={ed.employee.id} style={{ gap: 12 }}>
                      <div className="task-row__main">
                        <strong>{ed.employee.name} <small style={{ color: "#888" }}>({ed.employee.id})</small></strong>
                        <p>主机: {ed.employee.hostname} | 标签: {ed.employee.labels.length > 0 ? ed.employee.labels.join(", ") : "无"}</p>
                        <p>完成: {ed.completed} | 失败: {ed.failed} | 总任务: {ed.total}</p>
                      </div>
                      <div className="task-row__side">
                        <span className={`status-pill ${ed.employee.status}`}>{ed.employee.status}</span>
                        <small>{new Date(ed.employee.lastSeenAt).toLocaleTimeString()}</small>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </main>
        )}
        {activePage === "errors" && (
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
        )}
        {activePage === "stats" && (
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
                    { label: "总任务", value: statsData.total, color: "#6366f1" },
                    { label: "已完成", value: statsData.completed, color: "#22c55e" },
                    { label: "失败/超时", value: statsData.failed, color: "#ef4444" },
                    { label: "执行中", value: statsData.running, color: "#f59e0b" },
                    { label: "总费用", value: `$${statsData.totalCost.toFixed(4)}`, color: "#8b5cf6" },
                    { label: "平均耗时", value: statsData.avgDuration > 0 ? `${(statsData.avgDuration / 1000).toFixed(1)}s` : "-", color: "#06b6d4" },
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
                    statsData.employeeStats.map((es) => (
                      <div className="task-row" key={es.employee.id} style={{ gap: 12 }}>
                        <div className="task-row__main">
                          <strong>{es.employee.name}</strong>
                          <p>完成: {es.completed} | 失败: {es.failed} | 费用: ${es.cost.toFixed(4)} | 平均耗时: {es.avgMs > 0 ? `${(es.avgMs / 1000).toFixed(1)}s` : "-"}</p>
                        </div>
                        <div className="task-row__side">
                          <span className={`status-pill ${es.employee.status}`}>{es.employee.status}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </main>
        )}
        {activePage === "schedules" && (
          <main className="task-log-page">
            <section className="task-log-panel">
              <div className="section-title-row">
                <div>
                  <h1>定时任务</h1>
                  <p>管理 cron 定时调度，自动向 Agent 或队列派发任务。</p>
                </div>
                <button className="primary-button schedule-create-btn" onClick={openCreateScheduleModal}>
                  + 新建
                </button>
              </div>
              <div className="task-table">
                {schedules.length === 0 ? (
                  <div className="history-empty">暂无定时任务。点击"新建"创建第一个。</div>
                ) : (
                  schedules.map((schedule) => (
                    <div className="task-row schedule-row" key={schedule.id}>
                      <div className="task-row__main">
                        <div className="schedule-row__header">
                          <strong>{schedule.name}</strong>
                          <span className={`schedule-target-badge schedule-target-${schedule.targetMode}`}>
                            {schedule.targetMode === "queue" ? "队列" : schedule.targetMode === "broadcast" ? "广播" : "指定"}
                          </span>
                        </div>
                        <p className="schedule-cron">{schedule.cron}</p>
                        <p className="schedule-prompt">{schedule.prompt}</p>
                      </div>
                      <div className="task-row__side schedule-row__side">
                        <div className="schedule-toggle" onClick={() => toggleScheduleEnabled(schedule)}>
                          <div className={`schedule-toggle__track ${schedule.enabled ? "on" : "off"}`}>
                            <div className="schedule-toggle__thumb" />
                          </div>
                          <small>{schedule.enabled ? "启用" : "禁用"}</small>
                        </div>
                        {schedule.lastRunAt && (
                          <small title="上次执行">上次: {new Date(schedule.lastRunAt).toLocaleString()}</small>
                        )}
                        {schedule.nextRunAt && schedule.enabled && (
                          <small title="下次执行">下次: {new Date(schedule.nextRunAt).toLocaleString()}</small>
                        )}
                        <div className="schedule-actions">
                          <button className="secondary-button" onClick={() => triggerSchedule(schedule.id)}>
                            触发
                          </button>
                          <button className="secondary-button" onClick={() => openEditScheduleModal(schedule)}>
                            编辑
                          </button>
                          <button className="secondary-button schedule-delete-btn" onClick={() => {
                            if (confirm(`确定删除定时任务"${schedule.name}"？`)) deleteSchedule(schedule.id);
                          }}>
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {scheduleModalOpen && (
              <div className="modal-overlay" onClick={() => setScheduleModalOpen(false)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <h2>{editingSchedule ? "编辑定时任务" : "新建定时任务"}</h2>
                    <button className="secondary-button" onClick={() => setScheduleModalOpen(false)}>✕</button>
                  </div>
                  <div className="modal-body">
                    {scheduleError && <div className="modal-error">{scheduleError}</div>}
                    <label className="field">
                      <span>名称</span>
                      <input
                        value={scheduleForm.name}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="每日站会报告"
                      />
                    </label>
                    <label className="field">
                      <span>Cron 表达式（5 字段）</span>
                      <input
                        value={scheduleForm.cron}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, cron: e.target.value }))}
                        placeholder="0 9 * * 1-5"
                        className="cron-input"
                      />
                      <small style={{ color: "#7f93b5", marginTop: 2 }}>
                        格式: 分 时 日 月 星期 &nbsp; 例: {scheduleForm.cron ? "" : "0 9 * * 1-5 (工作日早9点)"}
                      </small>
                    </label>
                    <label className="field">
                      <span>目标模式</span>
                      <select
                        value={scheduleForm.targetMode}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, targetMode: e.target.value as ScheduleFormData["targetMode"] }))}
                      >
                        <option value="queue">队列（空闲 Agent 执行）</option>
                        <option value="direct">指定 Agent</option>
                        <option value="broadcast">广播（所有 Agent）</option>
                      </select>
                    </label>
                    {scheduleForm.targetMode === "direct" && (
                      <div className="field">
                        <span>目标 Agents</span>
                        <div className="target-picker" style={{ marginTop: 4 }}>
                          {employeeList.map((emp) => {
                            const selected = scheduleForm.targetAgents.includes(emp.id);
                            return (
                              <button
                                key={emp.id}
                                className={`target-chip ${selected ? "active" : ""}`}
                                onClick={() => setScheduleForm((f) => ({
                                  ...f,
                                  targetAgents: selected
                                    ? f.targetAgents.filter((id) => id !== emp.id)
                                    : [...f.targetAgents, emp.id],
                                }))}
                              >
                                {emp.name}
                              </button>
                            );
                          })}
                          {employeeList.length === 0 && <small style={{ color: "#7f93b5" }}>暂无在线员工</small>}
                        </div>
                      </div>
                    )}
                    <label className="field">
                      <span>Prompt</span>
                      <textarea
                        value={scheduleForm.prompt}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, prompt: e.target.value }))}
                        placeholder="输入要执行的任务指令..."
                        rows={4}
                      />
                    </label>
                    <label className="field">
                      <span>工作目录（可选）</span>
                      <input
                        value={scheduleForm.workspace}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, workspace: e.target.value }))}
                        placeholder="/Users/junhang/workspace/project"
                      />
                    </label>
                    <label className="field">
                      <span>超时秒数（可选）</span>
                      <input
                        type="number"
                        value={scheduleForm.timeoutSec}
                        onChange={(e) => setScheduleForm((f) => ({ ...f, timeoutSec: e.target.value }))}
                        placeholder="600"
                      />
                    </label>
                    <label className="field schedule-enable-field">
                      <span>立即启用</span>
                      <div
                        className="schedule-toggle"
                        onClick={() => setScheduleForm((f) => ({ ...f, enabled: !f.enabled }))}
                      >
                        <div className={`schedule-toggle__track ${scheduleForm.enabled ? "on" : "off"}`}>
                          <div className="schedule-toggle__thumb" />
                        </div>
                        <small>{scheduleForm.enabled ? "启用" : "禁用"}</small>
                      </div>
                    </label>
                  </div>
                  <div className="modal-footer">
                    <button className="secondary-button" onClick={() => setScheduleModalOpen(false)}>取消</button>
                    <button
                      className="primary-button"
                      style={{ width: "auto", marginTop: 0, padding: "8px 20px" }}
                      onClick={saveSchedule}
                      disabled={!scheduleForm.name || !scheduleForm.cron || !scheduleForm.prompt}
                    >
                      {editingSchedule ? "保存" : "创建"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        )}
      </div>

      <aside className="command-panel">
        <div className="panel-card chat-panel">
          <div className="chat-header">
            <div>
              <h2>Leader 群聊指挥中心</h2>
              <p>输入 <code>@</code> 选择目标，或直接发送到任务队列。</p>
            </div>
            <button className="secondary-button" onClick={clearToken}>
              切换 Token
            </button>
          </div>
          <div className="chat-list">
            {chatFeed.length === 0 ? (
              <div className="chat-empty">还没有发送过指令。</div>
            ) : (
              <Bubble.List
                style={{ height: "100%" }}
                autoScroll
                items={bubbleItems}
                role={{
                  user: {
                    placement: "end",
                    avatar: <Avatar style={{ background: "#52c41a", fontSize: 12 }}>L</Avatar>,
                    header: (_content: any, info: any) => {
                      const item = info.extraInfo;
                      return (
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, fontSize: 12, color: "#90a1be" }}>
                          {item.target && <span>{item.target} · </span>}
                          <span>{item.createdAt}</span>
                        </div>
                      );
                    },
                    contentRender: (_content: any, info: any) => {
                      const item = info.extraInfo;
                      return (
                        <div>
                          <div style={{ whiteSpace: "pre-wrap" }}>{String(_content)}</div>
                          {item.executingBy?.length > 0 && (
                            <ThoughtChain
                              style={{ marginTop: 8 }}
                              items={item.executingBy.map((agent: ExecutingAgent) => ({
                                key: agent.name,
                                title: agent.name,
                                description: statusLabel(agent.status),
                                status: thoughtChainStatus(agent.status),
                                collapsible: item.executingBy.length > 2,
                              }))}
                            />
                          )}
                        </div>
                      );
                    },
                    styles: { content: { background: "linear-gradient(135deg, rgba(104, 182, 255, 0.28), rgba(121, 255, 209, 0.12))" } },
                  },
                  ai: {
                    placement: "start",
                    avatar: (_content: any, info: any) => {
                      const item = info.extraInfo;
                      const initial = item.author?.[0] ?? "?";
                      return <Avatar style={{ background: "#1677ff", fontSize: 12 }}>{initial}</Avatar>;
                    },
                    header: (_content: any, info: any) => {
                      const item = info.extraInfo;
                      return (
                        <div style={{ fontSize: 12, color: "#90a1be", display: "flex", gap: 6 }}>
                          <strong style={{ color: "#c9d6f2" }}>{item.author}</strong>
                          <span>{item.createdAt}</span>
                        </div>
                      );
                    },
                    contentRender: (_content: any, info: any) => {
                      const item = info.extraInfo;
                      const isError = item.taskStatus === "failed" || item.taskStatus === "timeout";
                      return (
                        <div style={isError ? { color: "#ff4d4f" } : undefined}>
                          {String(_content)}
                        </div>
                      );
                    },
                    styles: {
                      content: {
                        background: "rgba(255, 255, 255, 0.06)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                      },
                    },
                  },
                }}
              />
            )}
          </div>
          <div className="chat-composer">
            <Suggestion
              items={suggestionItems}
              open={suggestionOpen}
              onOpenChange={setSuggestionOpen}
              onSelect={handleSuggestionSelect}
            >
              {({ onTrigger, onKeyDown }) => (
                <Sender
                  value={draft.prompt}
                  onChange={(val) => {
                    setDraft((c) => ({ ...c, prompt: val }));
                    const lastAtIndex = val.lastIndexOf("@");
                    if (lastAtIndex !== -1) {
                      const afterAt = val.slice(lastAtIndex + 1);
                      if (!afterAt.includes(" ")) {
                        onTrigger(val);
                      }
                    }
                  }}
                  onKeyDown={onKeyDown}
                  onSubmit={() => sendCommand()}
                  submitType="enter"
                  placeholder="按 Enter 发送；Option/Alt + Enter 换行。输入 @ 选择目标..."
                  header={
                    <Sender.Header title="工作目录" open={false}>
                      <input
                        value={draft.workspace}
                        onChange={(e) => setDraft((c) => ({ ...c, workspace: e.target.value }))}
                        placeholder="/Users/junhang/workspace/project"
                        style={{ width: "100%", padding: "4px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#eef4ff", fontSize: 12 }}
                      />
                    </Sender.Header>
                  }
                  style={{ flexShrink: 0 }}
                />
              )}
            </Suggestion>
          </div>
        </div>
      </aside>
        </div>
      </XProvider>
    </ConfigProvider>
  );
}
