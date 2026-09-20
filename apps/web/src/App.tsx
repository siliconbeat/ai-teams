import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps } from "react";
import {
  isEncryptedEnvelope,
  parseJsonMessage,
  parseServerToLeaderMessage,
  resolveAtAgentsFromPrompt,
  TERMINAL_STATUSES,
  type AgentRegistrationRecord,
  type AgentTarget,
  EmployeeSnapshot,
  LeaderToServerMessage,
  type MissionApprovalPolicy,
  type MissionApprovalRecord,
  type MissionEventRecord,
  type MissionRecord,
  type MissionSubtaskRecord,
  ServerToLeaderMessage,
  TaskRecord,
  TaskStatus,
} from "@ai-teams/shared";
import { XProvider } from "@ant-design/x";
import { CopyOutlined } from "@ant-design/icons";
import { App as AntApp, Avatar, ConfigProvider, theme } from "antd";
import { Bubble, ThoughtChain, Sender, Suggestion } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { TerminalStore } from "./terminal-store";
import { LiveTerminal } from "./LiveTerminal";

// ---------------------------------------------------------------------------
// Web Crypto E2E decryption (AES-256-GCM)
// ---------------------------------------------------------------------------

// @ts-expect-error Vite injects import.meta.env at build time
const ENCRYPTION_KEY_HEX: string | undefined = import.meta.env?.VITE_AI_TEAMS_ENCRYPTION_KEY as string | undefined;

let cachedKeyBytes: Uint8Array | null = null;
function getKeyBytes(): Uint8Array {
  if (!cachedKeyBytes) {
    cachedKeyBytes = new Uint8Array(
      Array.from({ length: 32 }, (_, i) => parseInt(ENCRYPTION_KEY_HEX!.slice(i * 2, i * 2 + 2), 16)),
    );
  }
  return cachedKeyBytes;
}

async function webCryptoDecrypt(raw: string): Promise<string> {
  if (!ENCRYPTION_KEY_HEX) return raw;
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedEnvelope(parsed)) return raw;
  const key = await crypto.subtle.importKey("raw", getKeyBytes().buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = Uint8Array.from(atob(parsed.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(parsed.ciphertext), (c) => c.charCodeAt(0));
  const tag = Uint8Array.from(atob(parsed.tag), (c) => c.charCodeAt(0));
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, combined);
  return new TextDecoder().decode(decrypted);
}

function webCryptoEncrypt(plainText: string): Promise<string> {
  if (!ENCRYPTION_KEY_HEX) return Promise.resolve(plainText);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.importKey("raw", getKeyBytes().buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt"]).then((key) =>
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

const COLLAPSED_MAX_HEIGHT = 220;
function CollapsibleContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 20);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="bubble-collapsible">
      <div
        ref={ref}
        className="bubble-collapsible__content"
        style={expanded ? { maxHeight: "none", overflow: "visible" } : undefined}
      >
        {children}
      </div>
      {overflow && !expanded && (
        <div className="bubble-collapsible__fade">
          <button className="bubble-collapsible__btn" onClick={() => setExpanded(true)}>查看更多</button>
        </div>
      )}
    </div>
  );
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
    } else if (line.startsWith("[thinking]")) {
      cls = "term-thinking";
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
  quotedPrompt?: string;
  replyQuote?: string;
  replyQuoteAuthor?: string;
  taskId?: string;
  employeeId?: string;
  sessionId?: string;
};

type EmployeeTerminalLog = {
  content: string;
  seenTaskIds: string[];
  seenOutputIds: string[];
  seenFinishedTaskIds: string[];
  attempts?: Record<string, number>;
};

type ActivePage = "monitor" | "tasks" | "employees" | "errors" | "stats" | "schedules" | "missions";

type AgentRegistryItem = AgentRegistrationRecord;

type AgentRegistryForm = {
  employeeId: string;
  name: string;
  labels: string;
};

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

type MissionDetail = {
  mission: MissionRecord;
  events: MissionEventRecord[];
  subtasks: Array<MissionSubtaskRecord & { task: TaskRecord | null }>;
  approvals: MissionApprovalRecord[];
};

type MissionFormData = {
  objective: string;
  workspace: string;
  approvalPolicy: MissionApprovalPolicy;
  maxIterations: string;
  maxTasks: string;
  timeoutSec: string;
};

const TASK_FILTERS: Array<TaskStatus | "all"> = ["all", "queued", "running", "failed", "completed", "cancelled"];
const TASK_FILTER_LABELS: Partial<Record<TaskStatus | "all", string>> = {
  all: "全部", queued: "等待中", running: "运行中", failed: "失败", completed: "已完成", cancelled: "已取消",
};
const TOKEN_STORAGE_KEY = "ai-teams.auth-token";
const TERMINAL_LOG_STORAGE_KEY = "ai-teams.employee-terminal-logs";
const TASK_GENERATION_STORAGE_KEY = "ai-teams.task-data-generation";
const MAX_TASKS = 300;
const CHAT_FEED_LIMIT = 200;

function getInitialToken() {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_AI_TEAMS_AUTH_TOKEN || localStorage.getItem(TOKEN_STORAGE_KEY) || "";
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
          attempts: log.attempts && typeof log.attempts === "object" ? Object.fromEntries(Object.entries(log.attempts).filter(([, value]) => typeof value === "number")) : {},
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

function isTerminalStatus(status: TaskStatus) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["dispatched", "accepted", "running"]);
const MAX_VISIBLE_BARS = 20;

function QueueIndicator({ tasks }: { tasks: Record<string, TaskRecord> }) {
  const { running, queued } = useMemo(() => {
    let running = 0;
    let queued = 0;
    for (const t of Object.values(tasks)) {
      if (ACTIVE_STATUSES.has(t.status)) running++;
      else if (t.status === "queued" && t.targetMode === "queue") queued++;
    }
    return { running, queued };
  }, [tasks]);

  if (running === 0 && queued === 0) return null;

  const total = running + queued;
  const visible = Math.min(total, MAX_VISIBLE_BARS);
  const overflow = total - visible;
  const visibleRunning = Math.min(running, visible);
  const visibleQueued = visible - visibleRunning;

  return (
    <div className="queue-indicator" title={`执行中 ${running} · 队列 ${queued}`}>
      {Array.from({ length: visibleRunning }, (_, i) => (
        <span key={`r${i}`} className="bar running" />
      ))}
      {Array.from({ length: visibleQueued }, (_, i) => (
        <span key={`q${i}`} className="bar queued" />
      ))}
      {overflow > 0 && <span className="overflow">+{overflow}</span>}
    </div>
  );
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
  if (employee.queuePaused) {
    return { label: "已暂停", className: "paused" };
  }
  if (employee.queueRecovery) {
    return { label: employee.queueRecovery.phase === "blocked" ? "需处理" : employee.queueRecovery.phase === "probe" ? "恢复探测" : "冷却中", className: "paused" };
  }
  if (employee.consecutiveQueueFailures >= 5) {
    return { label: "队列暂停", className: "paused" };
  }
  if (!activeTask) {
    return { label: "在线", className: "online" };
  }
  if (activeTask.status === "dispatched") {
    return { label: "派发中", className: "dispatched" };
  }
  if (activeTask.status === "accepted") {
    return { label: "已接收", className: "accepted" };
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
  const isStaleSlot = task && !isActive && (task.status === "queued" || isTerminalStatus(task.status));
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
      <span className="task-strip__label">{label}</span>
      <span className="task-strip__prompt" title={task?.prompt}>{task ? task.prompt : "空闲"}</span>
      {isActive ? (
        <>
          <span className="task-elapsed">{elapsed}</span>
          <button className="secondary-button" onClick={() => onCancel(task.id)}>
            取消
          </button>
        </>
      ) : null}
      {isStaleSlot ? (
        <button className="secondary-button danger-button" onClick={() => onCancel(task.id)}>
          清理
        </button>
      ) : null}
    </div>
  );
}

const EmployeeCard = memo(function EmployeeCard({
  employee,
  mainTask,
  queueTask,
  displayTask,
  terminalStore,
  cancelTask,
  onResetSession,
  onResumeQueue,
  onPauseQueue,
}: {
  employee: EmployeeSnapshot;
  mainTask: TaskRecord | undefined;
  queueTask: TaskRecord | undefined;
  displayTask: TaskRecord | undefined;
  terminalStore: TerminalStore;
  cancelTask: (taskId: string) => void;
  onResetSession: (employeeId: string) => void;
  onResumeQueue: (employeeId: string) => void;
  onPauseQueue: (employeeId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const activeTask = mainTask ?? queueTask;
  const taskStatus = activeTask?.status ?? displayTask?.status ?? "idle";
  const presence = getAgentPresence(employee, activeTask);

  return (
    <article className={`employee-card${presence.className === "busy" ? " card-busy" : ""}`}>
      <div className="employee-card__header">
        <div>
          <div className="employee-card__title">
            <h2>{employee.name}</h2>
            <span className={`task-state-badge task-${taskStatus}`}>{TASK_FILTER_LABELS[taskStatus as TaskStatus] ?? (taskStatus === "idle" ? "空闲" : taskStatus)}</span>
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
                {!employee.queuePaused && employee.status !== "offline" && (
                  <button className="card-menu-item" onClick={() => { setMenuOpen(false); onPauseQueue(employee.id); }}>
                    暂停队列
                  </button>
                )}
                {(employee.queuePaused || employee.queueRecovery || employee.consecutiveQueueFailures >= 5) && (
                  <button className="card-menu-item" onClick={() => { setMenuOpen(false); onResumeQueue(employee.id); }}>
                    {employee.queuePaused ? "恢复接单" : "立即重试（单任务探测）"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="employee-meta">
        <span>{employee.hostname}</span>
        <span>ID: {employee.id}{employee.version ? ` · v${employee.version}` : ""}{employee.claudeVersion ? ` · Claude ${employee.claudeVersion}` : ""}</span>
        <span>标签: {employee.labels.join(", ") || "未设置"}</span>
        {employee.queuePaused && (
          <span className="meta-warning">手动暂停</span>
        )}
        {!employee.queuePaused && employee.consecutiveQueueFailures >= 5 && (
          <span className="meta-warning">连续失败: {employee.consecutiveQueueFailures} 次</span>
        )}
        {employee.queueRecovery && (
          <span className="meta-warning" title={employee.queueRecovery.reason}>
            {employee.queueRecovery.phase === "blocked" ? "请修复认证/额度配置后手动恢复" : employee.queueRecovery.phase === "probe" ? "仅放行一个队列任务验证恢复" : `下次探测：${new Date(employee.queueRecovery.until).toLocaleTimeString()}`}
            {employee.queuePaused ? "（手动暂停期间不自动探测）" : ""}
            <br />原因：{employee.queueRecovery.reason.slice(0, 180)}
          </span>
        )}
        {employee.weight > 1 && (
          <span>权重: {employee.weight}</span>
        )}
        {employee.permissionMode && (
          <span className={employee.permissionMode === "bypassPermissions" ? "meta-warning" : ""}>权限: {employee.permissionMode}</span>
        )}
      </div>
      <SlotStrip label="主任务" task={mainTask} onCancel={cancelTask} />
      <SlotStrip label="队列" task={queueTask} onCancel={cancelTask} />
      <LiveTerminal store={terminalStore} employeeId={employee.id} />
    </article>
  );
});


  function thoughtChainStatus(status: TaskStatus): "success" | "error" | "loading" | undefined {
    if (status === "completed") return "success";
    if (status === "failed" || status === "timeout") return "error";
    if (status === "running") return "loading";
    return undefined;
  }

const ChatMessages = memo(function ChatMessages({ items, onReply }: { items: ComponentProps<typeof Bubble.List>["items"]; onReply: (session: string, employee: string, name: string, quote: string) => void }) {
  return (<Bubble.List
                style={{ height: "100%" }}
                autoScroll
                items={items}
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
                        <div className="bubble-copy-wrap">
                          {item.replyQuote && <div className="bubble-quote">{item.replyQuoteAuthor ? `${item.replyQuoteAuthor}: ` : ""}{item.replyQuote.length > 60 ? item.replyQuote.slice(0, 60) + "..." : item.replyQuote}</div>}
                          <div style={{ whiteSpace: "pre-wrap" }}>{String(_content)}</div>
                          {item.executingBy?.length > 0 && (
                            <ThoughtChain
                              style={{ marginTop: 8 }}
                              items={item.executingBy.map((agent: ExecutingAgent) => ({
                                key: agent.name,
                                title: agent.name,
                                status: thoughtChainStatus(agent.status),
                                collapsible: item.executingBy.length > 2,
                              }))}
                            />
                          )}
                          <button className="bubble-copy-btn" onClick={() => navigator.clipboard.writeText(String(_content))}>
                            <CopyOutlined />
                          </button>
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
                        <div className="bubble-copy-wrap">
                          {item.quotedPrompt && <div className="bubble-quote">{item.quotedPrompt.length > 60 ? item.quotedPrompt.slice(0, 60) + "..." : item.quotedPrompt}</div>}
                          <CollapsibleContent>
                            <div style={isError ? { color: "#ff4d4f" } : undefined}>
                              <XMarkdown content={String(_content)} />
                            </div>
                          </CollapsibleContent>
                          <button className="bubble-copy-btn" onClick={() => navigator.clipboard.writeText(String(_content))}>
                            <CopyOutlined />
                          </button>
                          {item.sessionId && item.employeeId && (
                            <button
                              className="bubble-reply-btn"
                              onClick={() => {
                                onReply(item.sessionId, item.employeeId, item.author || "", String(_content).slice(0, 200));
                              }}
                              title="回复"
                            >
                              ↩
                            </button>
                          )}
                        </div>
                      );
                    },
                    styles: {
                      root: { width: "100%" },
                      body: { width: "100%" },
                      content: {
                        background: "rgba(255, 255, 255, 0.06)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                      },
                    },
                  },
                }}
              />);
});

export default function App() {
  const [authToken, setAuthToken] = useState(getInitialToken);
  const [tokenDraft, setTokenDraft] = useState(authToken);
  const modalRef = useRef<ReturnType<typeof AntApp.useApp>["modal"] | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showReconnect, setShowReconnect] = useState(false);
  const [employees, setEmployees] = useState<Record<string, EmployeeSnapshot>>({});
  const [serverVersion, setServerVersion] = useState<string>("");
  const [tasks, setTasks] = useState<Record<string, TaskRecord>>({});
  const [terminalStore] = useState(() => new TerminalStore(loadTerminalLogs()));
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [history, setHistory] = useState<CommandHistoryItem[]>([]);
  const [activePage, setActivePage] = useState<ActivePage>("monitor");
  const activePageRef = useRef<ActivePage>(activePage);
  activePageRef.current = activePage;
  const [taskFilter, setTaskFilter] = useState<TaskStatus | "all">("all");
  const [taskDisplayLimit, setTaskDisplayLimit] = useState(30);
  const taskQueryRef = useRef({ taskFilter, taskDisplayLimit });
  taskQueryRef.current = { taskFilter, taskDisplayLimit };
  const [taskLogList, setTaskLogList] = useState<TaskRecord[]>([]);
  const [taskLogLoading, setTaskLogLoading] = useState(false);
  const [clearingTasks, setClearingTasks] = useState(false);
  const [taskCleanupNotice, setTaskCleanupNotice] = useState<string | null>(null);
  const taskDataGeneration = useRef(0);
  const serverTaskGeneration = useRef<string | undefined>(undefined);
  const taskListRequest = useRef(0);
  const [selectedTarget, setSelectedTarget] = useState<AgentTarget>("queue");
  const [resumeSession, setResumeSession] = useState<{ sessionId: string; agentName: string; quote: string } | null>(null);
  const replyQuotesRef = useRef<Record<string, { agentName: string; quote: string }>>({});
  const [draft, setDraft] = useState<CommandDraft>({
    prompt: "",
    workspace: "",
  });
  const [mobileTerminalEmployeeId, setMobileTerminalEmployeeId] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [selectedMission, setSelectedMission] = useState<MissionDetail | null>(null);
  const [missionLoading, setMissionLoading] = useState(false);
  const [missionForm, setMissionForm] = useState<MissionFormData>({
    objective: "",
    workspace: "",
    approvalPolicy: "ask_on_risky_change",
    maxIterations: "6",
    maxTasks: "20",
    timeoutSec: "",
  });
  const [missionError, setMissionError] = useState<string | null>(null);
  const [agentRegistry, setAgentRegistry] = useState<AgentRegistryItem[]>([]);
  const [agentRegistryLoading, setAgentRegistryLoading] = useState(false);
  const [agentRegistryForm, setAgentRegistryForm] = useState<AgentRegistryForm>({ employeeId: "", name: "", labels: "" });
  const [agentTokenNotice, setAgentTokenNotice] = useState<{ employeeId: string; token: string } | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleItem | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormData>({
    name: "", cron: "", prompt: "", targetMode: "queue", targetAgents: [], workspace: "", timeoutSec: "", enabled: true,
  });
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskOutputCache, setTaskOutputCache] = useState<Record<string, string>>({});
  const [taskOutputLoading, setTaskOutputLoading] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    let disposed = false;
    let incoming = Promise.resolve();
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
        if (disposed || wsRef.current !== ws) { ws.close(); return; }
        setConnected(true);
        setConnectionError(null);
        setShowReconnect(false);
        if (showReconnectTimer) { clearTimeout(showReconnectTimer); showReconnectTimer = null; }
      };

      ws.onclose = (event) => {
        if (disposed || wsRef.current !== ws) return;
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

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;
        // Async decryption must not reorder output, completion, snapshot or clear events.
        // Events accepted before disconnect finish before the next connection's snapshot.
        incoming = incoming.then(async () => {
        if (disposed) return;
        try {
          const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
          const decrypted = await webCryptoDecrypt(raw);
          if (disposed) return;
          const message = parseServerToLeaderMessage(parseJsonMessage(decrypted));
          handleLeaderEvent(message);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : "服务端消息格式错误。");
        }
        });
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
      case "tasks.cleared": {
        resetTaskViews();
        rememberTaskGeneration(message.snapshot.taskDataGeneration);
        setEmployees(Object.fromEntries(message.snapshot.employees.map((item) => [item.id, item])));
        setTaskCleanupNotice("所有任务及 Mission 历史已清空。已启用的定时任务仍会按计划生成新任务。");
        break;
      }
      case "snapshot": {
        if (message.snapshot.taskDataGeneration !== undefined) {
          try {
            const previous = serverTaskGeneration.current ?? localStorage.getItem(TASK_GENERATION_STORAGE_KEY) ?? "";
            if (previous !== message.snapshot.taskDataGeneration) resetTaskViews();
          } catch { /* unavailable storage */ }
          rememberTaskGeneration(message.snapshot.taskDataGeneration);
        }
        setEmployees(Object.fromEntries(message.snapshot.employees.map((item) => [item.id, item])));
        setTasks(capTasks(Object.fromEntries(message.snapshot.tasks.map((item) => [item.id, item])), MAX_TASKS));
        for (const task of [...message.snapshot.tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
          terminalStore.task({ ...task, status: "running" }, buildTaskHeader(task), "");
          for (const chunk of message.snapshot.logs[task.id] ?? []) terminalStore.output(chunk);
          terminalStore.task(task, buildTaskHeader(task), buildTaskFinishedLine(task));
        }
        if (activePageRef.current === "tasks") fetchTaskLogList();
        if (message.snapshot.serverVersion) setServerVersion(message.snapshot.serverVersion);
        break;
      }
      case "employee.upsert": {
        setEmployees((current) => ({ ...current, [message.employee.id]: message.employee }));
        break;
      }
      case "employee.delete": {
        terminalStore.remove(message.employeeId);
        setEmployees((current) => {
          const { [message.employeeId]: _removed, ...rest } = current;
          return rest;
        });
        break;
      }
      case "task.upsert": {
        terminalStore.task(message.task, buildTaskHeader(message.task), buildTaskFinishedLine(message.task));
        setTasks((current) => capTasks({ ...current, [message.task.id]: message.task }, MAX_TASKS));
        if (activePageRef.current === "tasks") {
          fetchTaskLogList();
        }
        break;
      }
      case "task.output": {
        terminalStore.output(message.chunk);
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
      const mainTask = employee.mainTaskId ? tasks[employee.mainTaskId] : undefined;
      const queueTask = employee.queueTaskId ? tasks[employee.queueTaskId] : undefined;
      map[employee.id] = {
        main: mainTask && ACTIVE_STATUSES.has(mainTask.status) ? mainTask : undefined,
        queue: queueTask && ACTIVE_STATUSES.has(queueTask.status) ? queueTask : undefined,
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

  const agentStatusStats = useMemo(() => {
    let online = 0;
    let offline = 0;
    let abnormal = 0;
    for (const employee of employeeList) {
      const displayTask = displayTasksByEmployee[employee.id];
      const isAbnormal =
        employee.queuePaused ||
        !!employee.queueRecovery ||
        employee.consecutiveQueueFailures >= 5 ||
        displayTask?.status === "failed" ||
        displayTask?.status === "timeout" ||
        displayTask?.status === "cancelled";
      if (isAbnormal) {
        abnormal += 1;
      } else if (employee.status === "offline") {
        offline += 1;
      } else {
        online += 1;
      }
    }
    return { online, offline, abnormal };
  }, [displayTasksByEmployee, employeeList]);

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
        target = "@All";
      } else {
        target = groupTasks
          .map((t) => (t.employeeId ? `@${employees[t.employeeId]?.name ?? t.employeeId}` : ""))
          .filter(Boolean)
          .join(" ");
      }
      const executingBy = groupTasks
        .filter((t) => t.employeeId && t.status !== "queued")
        .map((t) => ({ name: employees[t.employeeId!]?.name ?? t.employeeId!, status: t.status }));
      const replyQuoteEntry = first.sessionId ? replyQuotesRef.current[first.sessionId] : undefined;
      leaderItems.push({
        id: `leader-${first.leaderCommandId}`,
        side: "leader",
        author: "Leader",
        target: target || undefined,
        content: first.prompt,
        createdAt: new Date(first.createdAt).toLocaleTimeString(),
        createdAtMs: new Date(first.createdAt).getTime(),
        executingBy: executingBy.length > 0 ? executingBy : undefined,
        replyQuote: replyQuoteEntry?.quote,
        replyQuoteAuthor: replyQuoteEntry?.agentName,
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
        quotedPrompt: task.prompt,
        taskId: task.id,
        employeeId: task.employeeId ?? undefined,
        sessionId: task.sessionId ?? undefined,
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
          quotedPrompt: !isLeader ? item.quotedPrompt : undefined,
          replyQuote: isLeader ? item.replyQuote : undefined,
          replyQuoteAuthor: isLeader ? item.replyQuoteAuthor : undefined,
          createdAt: item.createdAt,
          author: item.author,
          taskId: item.taskId,
          employeeId: item.employeeId,
          sessionId: item.sessionId,
        },
      };
    })
  , [chatFeed]);

  const replyToMessage = useCallback((sessionId: string, employeeId: string, agentName: string, quote: string) => {
    setResumeSession({ sessionId, agentName, quote });
    setSelectedTarget([employeeId]);
  }, []);

  const getSuggestionItems = useCallback((keyword?: string) => {
    if (!keyword) return [];
    if (keyword.startsWith("/")) {
      const search = keyword.slice(1).toLowerCase();
      return [
        { label: "/code-review", value: "/code-review", description: "请求代码审查" },
      ].filter((item) => item.value.toLowerCase().includes(search));
    }
    const search = keyword.startsWith("@") ? keyword.slice(1).toLowerCase() : keyword.toLowerCase();
    return [
      { label: "@All", value: "all", description: "Broadcast to all online agents" },
      ...employeeList
        .filter((emp) => emp.name.toLowerCase().includes(search))
        .map((emp) => ({
          label: `@${emp.name}`,
          value: emp.id,
          description: `Direct — ${emp.status === "online" ? "online" : "offline"}`,
          disabled: emp.status === "offline",
        })),
    ];
  }, [employeeList]);

  const handleSuggestionSelect = (value: string) => {
    let insertText: string;
    if (value === "/code-review") {
      insertText = "/code-review ";
    } else if (value === "all") {
      setSelectedTarget("all");
      insertText = "@All ";
    } else {
      const emp = employees[value];
      if (!emp) return;
      setSelectedTarget((current) => {
        const currentIds = current === "all" || current === "queue" ? [] : current;
        return currentIds.includes(value) ? currentIds : [...currentIds, value];
      });
      insertText = `@${emp.name} `;
    }
    setDraft((c) => {
      const prompt = c.prompt.replace(/[@/][^@\s/]*$/, insertText);
      return { ...c, prompt };
    });
  };

  function formatTarget(target: AgentTarget, employeeMap: Record<string, EmployeeSnapshot>) {
    if (target === "queue") {
      return "任务队列";
    }
    if (target === "all") {
      return "@All";
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

  async function fetchTaskOutput(taskId: string) {
    const generation = taskDataGeneration.current;
    if (taskOutputCache[taskId]) return;
    setTaskOutputLoading(taskId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/output`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json() as { taskId: string; output: string };
        if (generation !== taskDataGeneration.current) return;
        setTaskOutputCache((prev) => {
          const entries = Object.entries({ ...prev, [taskId]: data.output });
          if (entries.length > 50) {
            const trimmed = Object.fromEntries(entries.slice(-50));
            return trimmed;
          }
          return { ...prev, [taskId]: data.output };
        });
      }
    } catch { /* ignore */ }
    setTaskOutputLoading(null);
  }

  function toggleTaskExpansion(taskId: string) {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
    } else {
      setExpandedTaskId(taskId);
      fetchTaskOutput(taskId);
    }
  }

  async function fetchTaskLogList() {
    const generation = taskDataGeneration.current;
    const requestId = ++taskListRequest.current;
    setTaskLogLoading(true);
    try {
      const params = new URLSearchParams();
      const query = taskQueryRef.current;
      if (query.taskFilter !== "all") params.set("status", query.taskFilter);
      params.set("limit", String(query.taskDisplayLimit));
      params.set("offset", "0");
      const res = await fetch(`/api/tasks?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json() as { tasks: TaskRecord[] };
        if (generation !== taskDataGeneration.current || requestId !== taskListRequest.current) return;
        setTaskLogList(data.tasks);
      }
    } catch { /* ignore */ }
    if (requestId === taskListRequest.current) setTaskLogLoading(false);
  }

  function resetTaskViews() {
    taskDataGeneration.current++;
    taskListRequest.current++;
    setTasks({});
    setTaskLogList([]);
    setTaskLogLoading(false);
    setTaskOutputCache({});
    setTaskOutputLoading(null);
    setExpandedTaskId(null);
    setHistory([]);
    terminalStore.clear();
    setResumeSession(null);
    replyQuotesRef.current = {};
    setMissions([]);
    setSelectedMission(null);
    try { localStorage.removeItem(TERMINAL_LOG_STORAGE_KEY); } catch { /* unavailable storage */ }
  }

  function rememberTaskGeneration(generation?: string) {
    if (generation === undefined) return;
    serverTaskGeneration.current = generation;
    try { localStorage.setItem(TASK_GENERATION_STORAGE_KEY, generation); } catch { /* unavailable storage */ }
  }

  async function clearAllTasks() {
    setClearingTasks(true);
    setTaskCleanupNotice(null);
    const generation = taskDataGeneration.current;
    try {
      const res = await fetch("/api/tasks", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "clear-all-tasks" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "清空失败，请重试。");
      // The WebSocket event usually arrives first; avoid erasing newly created tasks twice.
      if (generation === taskDataGeneration.current) resetTaskViews();
      setTaskCleanupNotice(`已清空 ${data.deleted.tasks} 个任务和 ${data.deleted.missions} 个 Mission。已向在线 Agent 发送 ${data.cancellationRequests} 个终止请求。${data.offlineTasks ? ` ${data.offlineTasks} 个离线任务无法立即确认停止，请检查对应 Agent。` : ""} ${data.enabledSchedules} 个定时任务仍启用，后续可能产生新任务。`);
      await fetchTaskLogList();
    } catch (error) {
      setTaskCleanupNotice(error instanceof Error ? error.message : "清空失败，请重试。");
    } finally {
      setClearingTasks(false);
    }
  }

  function confirmClearAllTasks() {
    modalRef.current?.confirm({
      title: "清空所有任务？",
      content: "将删除所有等待中、运行中及已结束的任务、输出日志和 Mission 历史，并向在线 Agent 请求终止执行。此操作不可撤销，且不受当前筛选条件限制。员工、Agent 和定时任务配置会保留；启用中的定时任务仍会继续生成新任务。离线 Agent 上的进程无法立即确认停止，重连后会请求终止。",
      okText: "确认清空所有任务", cancelText: "取消", okButtonProps: { danger: true },
      onOk: clearAllTasks,
    });
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

  // ── Mission API helpers ──

  async function fetchMissions(selectId?: string) {
    const generation = taskDataGeneration.current;
    setMissionLoading(true);
    try {
      const res = await fetch("/api/missions", { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json() as { missions: MissionRecord[] };
        if (generation !== taskDataGeneration.current) return;
        setMissions(data.missions);
        const nextId = selectId ?? selectedMission?.mission.id ?? data.missions[0]?.id;
        if (nextId) {
          await fetchMissionDetail(nextId);
        } else {
          setSelectedMission(null);
        }
      }
    } catch { /* ignore */ }
    setMissionLoading(false);
  }

  async function fetchMissionDetail(missionId: string) {
    const generation = taskDataGeneration.current;
    try {
      const res = await fetch(`/api/missions/${missionId}`, { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json() as MissionDetail;
        if (generation !== taskDataGeneration.current) return;
        setSelectedMission(data);
      }
    } catch { /* ignore */ }
  }

  async function createMission() {
    setMissionError(null);
    const objective = missionForm.objective.trim();
    if (!objective) {
      setMissionError("请输入总目标");
      return;
    }
    const body: Record<string, unknown> = {
      objective,
      approvalPolicy: missionForm.approvalPolicy,
      maxIterations: Number(missionForm.maxIterations) || 6,
      maxTasks: Number(missionForm.maxTasks) || 20,
      autoStart: true,
    };
    if (missionForm.workspace.trim()) body.workspace = missionForm.workspace.trim();
    if (missionForm.timeoutSec && Number(missionForm.timeoutSec) > 0) body.timeoutSec = Number(missionForm.timeoutSec);
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as MissionDetail | { error?: string };
      if (!res.ok) {
        setMissionError(("error" in data && data.error) || "创建 Mission 失败");
        return;
      }
      const detail = data as MissionDetail;
      setMissionForm((current) => ({ ...current, objective: "" }));
      await fetchMissions(detail.mission.id);
    } catch {
      setMissionError("网络请求失败");
    }
  }

  async function respondMissionApproval(approval: MissionApprovalRecord, approved: boolean) {
    try {
      const res = await fetch(`/api/missions/${approval.missionId}/approvals/${approval.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        alert(data.error || "审批请求失败");
        return;
      }
      await fetchMissions(approval.missionId);
    } catch {
      alert("网络请求失败");
    }
  }

  async function cancelMission(missionId: string) {
    try {
      const res = await fetch(`/api/missions/${missionId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        alert(data.error || "取消 Mission 失败");
        return;
      }
      await fetchMissions(missionId);
    } catch {
      alert("网络请求失败");
    }
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

  async function fetchAgentRegistry() {
    setAgentRegistryLoading(true);
    try {
      const res = await fetch("/api/agent-registry", { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json() as { agents: AgentRegistryItem[] };
        setAgentRegistry(data.agents);
      }
    } catch { /* ignore */ }
    setAgentRegistryLoading(false);
  }

  function parseLabelsInput(value: string) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  async function createAgentRegistration() {
    const employeeId = agentRegistryForm.employeeId.trim();
    if (!employeeId) {
      alert("请输入 Agent ID");
      return;
    }
    try {
      const res = await fetch("/api/agent-registry", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          employeeId,
          name: agentRegistryForm.name.trim() || employeeId,
          labels: parseLabelsInput(agentRegistryForm.labels),
        }),
      });
      const data = await res.json() as { agentToken?: string; error?: string };
      if (!res.ok) {
        alert(data.error || "添加 Agent 失败");
        return;
      }
      setAgentTokenNotice({ employeeId, token: data.agentToken || "" });
      setAgentRegistryForm({ employeeId: "", name: "", labels: "" });
      await fetchAgentRegistry();
    } catch {
      alert("网络请求失败");
    }
  }

  async function approveAgentRegistration(employeeId: string) {
    try {
      const res = await fetch(`/api/agent-registry/${employeeId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({}),
      });
      const data = await res.json() as { agentToken?: string; error?: string };
      if (!res.ok) {
        alert(data.error || "批准 Agent 失败");
        return;
      }
      setAgentTokenNotice({ employeeId, token: data.agentToken || "" });
      await fetchAgentRegistry();
    } catch {
      alert("网络请求失败");
    }
  }

  async function deleteAgentRegistration(employeeId: string) {
    if (!window.confirm(`确认删除 Agent ${employeeId}？在线连接会被断开。`)) return;
    try {
      const res = await fetch(`/api/agent-registry/${employeeId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        alert(data.error || "删除 Agent 失败");
        return;
      }
      await fetchAgentRegistry();
    } catch {
      alert("网络请求失败");
    }
  }

  async function saveSchedule() {
    setScheduleError(null);
    if (scheduleForm.targetMode === "direct" && scheduleForm.targetAgents.length === 0) {
      setScheduleError("指定 Agent 模式至少选择一个目标 Agent");
      return;
    }
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

  useEffect(() => {
    if (authToken && activePage === "missions") fetchMissions();
  }, [authToken, activePage]);

  useEffect(() => {
    if (!authToken || activePage !== "missions") return;
    const timer = setInterval(() => {
      fetchMissions();
    }, 3000);
    return () => clearInterval(timer);
  }, [authToken, activePage, selectedMission?.mission.id]);

  useEffect(() => {
    if (authToken && activePage === "employees") fetchAgentRegistry();
  }, [authToken, activePage]);

  function sendCommand() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !draft.prompt.trim()) {
      return;
    }

    const resolved = resolveAtAgentsFromPrompt(draft.prompt.trim(), employeeList, selectedTarget);
    const commandPrompt = (resolved.prompt || draft.prompt.trim()).replace(/@all\s*/gi, "").trim();
    const payload: LeaderToServerMessage = {
      type: "command.dispatch",
      atAgents: resolved.atAgents,
      prompt: commandPrompt,
      workspace: draft.workspace.trim() || undefined,
      ...(resumeSession ? { sessionId: resumeSession.sessionId } : {}),
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
    setSelectedTarget("queue");
    if (resumeSession) {
      const keys = Object.keys(replyQuotesRef.current);
      if (keys.length >= 50) delete replyQuotesRef.current[keys[0]];
      replyQuotesRef.current[resumeSession.sessionId] = { agentName: resumeSession.agentName, quote: resumeSession.quote };
    }
    setResumeSession(null);
  }

  const cancelTask = useCallback((taskId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    const task = tasks[taskId];
    if (task && (task.status === "queued" || isTerminalStatus(task.status))) {
      setEmployees((current) => {
        let changed = false;
        const next: Record<string, EmployeeSnapshot> = {};
        for (const [employeeId, employee] of Object.entries(current)) {
          if (employee.mainTaskId !== taskId && employee.queueTaskId !== taskId) {
            next[employeeId] = employee;
            continue;
          }
          changed = true;
          next[employeeId] = {
            ...employee,
            mainTaskId: employee.mainTaskId === taskId ? null : employee.mainTaskId,
            mainTaskPrompt: employee.mainTaskId === taskId ? null : employee.mainTaskPrompt,
            queueTaskId: employee.queueTaskId === taskId ? null : employee.queueTaskId,
            queueTaskPrompt: employee.queueTaskId === taskId ? null : employee.queueTaskPrompt,
          };
        }
        return changed ? next : current;
      });
    }
    const payload: LeaderToServerMessage = { type: "task.cancel", taskId };
    webCryptoEncrypt(JSON.stringify(payload)).then((encrypted) => {
      wsRef.current?.send(encrypted);
    });
  }, [tasks]);

  const prioritizeTask = useCallback(async (taskId: string) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/prioritize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) {
        const fallback = "优先执行失败";
        try {
          const data = await response.json() as { error?: string; message?: string };
          alert(data.error || data.message || fallback);
        } catch {
          alert(fallback);
        }
      }
    } catch {
      alert("网络请求失败");
    }
  }, [authToken]);

  const resetSession = useCallback((employeeId: string) => {
    fetch(`/api/agents/${employeeId}/reset-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    }).then((res) => {
      if (!res.ok) return res.json().then((d) => { alert(d.error || "重置失败"); });
    }).catch(() => { alert("网络请求失败"); });
  }, [authToken]);

  const resumeQueue = useCallback((employeeId: string) => {
    fetch(`/api/agents/${employeeId}/resume-queue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    }).then((res) => {
      if (!res.ok) return res.json().then((d) => { alert(d.error || "恢复失败"); });
    }).catch(() => { alert("网络请求失败"); });
  }, [authToken]);

  const pauseQueue = useCallback((employeeId: string) => {
    fetch(`/api/agents/${employeeId}/pause-queue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    }).then((res) => {
      if (!res.ok) return res.json().then((d) => { alert(d.error || "暂停失败"); });
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
    const persist = () => terminalStore.persist(localStorage);
    const timer = setInterval(persist, 5000);
    const onHide = () => { if (document.visibilityState === "hidden") persist(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", persist);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", persist); terminalStore.stop(); persist(); };
  }, [terminalStore]);

  useEffect(() => {
    if (activePage === "tasks" && authToken) {
      fetchTaskLogList();
    }
  }, [activePage, taskFilter, taskDisplayLimit, authToken]);

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
      <AntApp>
        <XProvider>
        <ModalBridge modalRef={modalRef} />
        <div className={`app-shell${activePage === "tasks" ? " mobile-tasks-mode" : ""}`}>
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
            <p>AGENT OPERATIONS</p>
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
            className={`nav-item ${activePage === "missions" ? "active" : ""}`}
            onClick={() => setActivePage("missions")}
          >
            AI Leader
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
        <button className="secondary-button mobile-task-nav" onClick={() => setActivePage(activePage === "tasks" ? "monitor" : "tasks")}>
          {activePage === "tasks" ? "返回对话" : "任务列表"}
        </button>
        <button className="secondary-button mobile-logout" onClick={() => { modalRef.current?.confirm({ title: "确认退出", content: "确认退出当前连接？", okText: "退出", cancelText: "取消", onOk: clearToken }); }}>
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
      {isMobile && mobileTerminalEmployeeId && (() => {
        const emp = employees[mobileTerminalEmployeeId];
        return (
          <div className="mobile-terminal-overlay" onClick={() => setMobileTerminalEmployeeId(null)}>
            <div className="mobile-terminal-card" onClick={(e) => e.stopPropagation()}>
              <div className="mobile-terminal-header">
                <span>{emp?.name ?? mobileTerminalEmployeeId}</span>
                <button onClick={() => setMobileTerminalEmployeeId(null)}>✕</button>
              </div>
              <LiveTerminal store={terminalStore} employeeId={mobileTerminalEmployeeId} />
            </div>
          </div>
        );
      })()}

      {/* Mobile: chat feed */}
      {isMobile && activePage !== "tasks" && <div className="mobile-chat-feed">
        {chatFeed.length === 0 ? (
          <div className="mobile-chat-empty">还没有发送过指令。</div>
        ) : (
          <ChatMessages items={bubbleItems} onReply={replyToMessage} />
        )}
      </div>}

      {/* Mobile: command input */}
      {isMobile && activePage !== "tasks" && <div className="mobile-input-bar">
        <Suggestion
          items={getSuggestionItems}
          onSelect={handleSuggestionSelect}
          open={suggestionOpen}
          onOpenChange={setSuggestionOpen}
        >
          {({ onTrigger, onKeyDown }) => (
            <Sender
              value={draft.prompt}
              onChange={(val) => {
                setDraft((c) => ({ ...c, prompt: val }));
                const match = val.match(/([@/][^@\s/]*)$/);
                if (match) {
                  onTrigger(match[1]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "@" || e.key === "/") {
                  onTrigger(e.key);
                }
                const isNavKey = suggestionOpen && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(e.key);
                if (isNavKey) {
                  onKeyDown(e);
                } else {
                  e.stopPropagation();
                }
                if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                  if (e.defaultPrevented || suggestionOpen) return;
                  e.preventDefault();
                  sendCommand();
                }
              }}
              placeholder="输入指令... @ 目标 / 命令"
              style={{ flexShrink: 0 }}
            />
          )}
        </Suggestion>
      </div>}

      <div className="workspace-panel">
        {activePage === "monitor" && !isMobile && (
          <main className="board">
            <header className="board-header">
              <div>
                <h1>运行工作台</h1>
                <p>{connectionError ?? (connected ? "已连接服务端" : "正在等待服务端连接")}</p>
              </div>
              <div className="board-header-indicators">
                <div className="agent-status-summary" aria-label="Agent 状态统计">
                  <span className="agent-status-count online">在线 <strong>{agentStatusStats.online}</strong></span>
                  <span className="agent-status-count offline">离线 <strong>{agentStatusStats.offline}</strong></span>
                  <span className="agent-status-count abnormal">异常 <strong>{agentStatusStats.abnormal}</strong></span>
                </div>
                <QueueIndicator tasks={tasks} />
                <div className={`status-pill ${connected ? "online" : "offline"}`}>
                  {connected ? "Leader Online" : "Leader Offline"}
                </div>
              </div>
            </header>

            <section className="employee-grid">
              {employeeList.length === 0 ? (
                <div className="empty-state">暂无员工接入。先启动服务端和员工端。</div>
              ) : (
                employeeList.map((employee) => {
                  const slots = activeTasksByEmployee[employee.id];
                  return (
                    <EmployeeCard
                      key={employee.id}
                      employee={employee}
                      mainTask={slots?.main}
                      queueTask={slots?.queue}
                      displayTask={displayTasksByEmployee[employee.id]}
                      terminalStore={terminalStore}
                      cancelTask={cancelTask}
                      onResetSession={resetSession}
                      onResumeQueue={resumeQueue}
                      onPauseQueue={pauseQueue}
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
                  <p>查看任务记录，或清空服务端全部任务及关联历史。</p>
                </div>
                <div className="filter-row">
                  {TASK_FILTERS.map((filter) => (
                    <button
                      className={`filter-chip ${taskFilter === filter ? "active" : ""}`}
                      key={filter}
                      onClick={() => { setTaskFilter(filter); setTaskDisplayLimit(30); }}
                    >
                      {TASK_FILTER_LABELS[filter] ?? filter}
                    </button>
                  ))}
                  <button className="secondary-button schedule-delete-btn" disabled={clearingTasks || !connected} onClick={confirmClearAllTasks}>
                    {clearingTasks ? "正在清空…" : "清空所有任务"}
                  </button>
                </div>
              </div>
              {taskCleanupNotice && <p role="status" aria-live="polite">{taskCleanupNotice}</p>}
              <div className="task-table">
                {taskLogLoading && taskLogList.length === 0 ? (
                  <div className="task-output-loading">加载中...</div>
                ) : taskLogList.length === 0 ? (
                  <div className="history-empty">暂无符合条件的任务。</div>
                ) : (
                  taskLogList.map((task) => {
                    const isExpanded = expandedTaskId === task.id;
                    const cachedOutput = taskOutputCache[task.id];
                    const isLoading = taskOutputLoading === task.id;
                    return (
                      <div className={`task-row task-${task.status}`} key={task.id}>
                        <div className="task-row__summary" role="button" tabIndex={0} aria-expanded={isExpanded} onKeyDown={(event) => {
                          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleTaskExpansion(task.id); }
                        }} onClick={() => toggleTaskExpansion(task.id)}>
                          <div className="task-row__main">
                            <strong><span style={{ marginRight: 6 }}>{isExpanded ? "▾" : "▸"}</span>{task.employeeId ? employees[task.employeeId]?.name ?? task.employeeId : "任务队列"}</strong>
                            <p>{task.prompt}</p>
                            {task.error ? <span className="error-text">{task.error}</span> : null}
                          </div>
                          <div className="task-row__side">
                            <span className={`status-pill ${task.status}`}>{TASK_FILTER_LABELS[task.status] ?? task.status}</span>
                            <small>{new Date(task.createdAt).toLocaleTimeString()}</small>
                            {task.status === "failed" && (
                              <button className="retry-btn" onClick={(e) => { e.stopPropagation(); retryTask(task); }}>重试</button>
                            )}
                            {task.status === "queued" && (
                              <>
                                <button className="action-btn action-btn--green" onClick={(e) => { e.stopPropagation(); prioritizeTask(task.id); }}>优先执行</button>
                                <button className="retry-btn" onClick={(e) => { e.stopPropagation(); cancelTask(task.id); }}>取消</button>
                              </>
                            )}
                            {task.status === "completed" && task.sessionId && task.employeeId && (
                              <button className="action-btn action-btn--blue" onClick={(e) => {
                                e.stopPropagation();
                                const eid = task.employeeId!;
                                const agentName = employees[eid]?.name ?? eid;
                                const quote = (task.summary || task.prompt || "").slice(0, 200);
                                setResumeSession({ sessionId: task.sessionId!, agentName, quote });
                                setSelectedTarget([task.employeeId!]);
                                setActivePage("monitor");
                              }}>继续对话</button>
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="task-output-panel">
                            {isLoading ? (
                              <div className="task-output-loading">加载中...</div>
                            ) : cachedOutput ? (
                              <pre className="log-window task-output-log" dangerouslySetInnerHTML={{ __html: renderTerminalHtml(cachedOutput) }} />
                            ) : (
                              <div className="task-output-empty">暂无输出记录。</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              {taskLogList.length > 0 && <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="primary-button"
                  onClick={() => setTaskDisplayLimit((n) => n + 30)}
                >
                  加载更多
                </button>
              </div>}
            </section>
          </main>
        )}
        {activePage === "employees" && (
          <main className="task-log-page">
            <section className="task-log-panel">
              <div className="section-title-row">
                <div>
                  <h1>员工管理</h1>
                  <p>管理 Agent 注册审批、连接状态和队列权限。</p>
                </div>
              </div>
              <div className="agent-create-row">
                <input
                  value={agentRegistryForm.employeeId}
                  onChange={(e) => setAgentRegistryForm((form) => ({ ...form, employeeId: e.target.value }))}
                  placeholder="Agent ID"
                />
                <input
                  value={agentRegistryForm.name}
                  onChange={(e) => setAgentRegistryForm((form) => ({ ...form, name: e.target.value }))}
                  placeholder="显示名称"
                />
                <input
                  value={agentRegistryForm.labels}
                  onChange={(e) => setAgentRegistryForm((form) => ({ ...form, labels: e.target.value }))}
                  placeholder="标签，逗号分隔"
                />
                <button className="primary-button" onClick={createAgentRegistration}>添加 Agent</button>
              </div>
              {agentTokenNotice && (
                <div className="agent-token-notice">
                  <strong>{agentTokenNotice.employeeId} Agent Token</strong>
                  <code>{agentTokenNotice.token}</code>
                  <button className="secondary-button" onClick={() => navigator.clipboard.writeText(agentTokenNotice.token)}>复制</button>
                </div>
              )}
              <div className="task-table agent-registry-table">
                {agentRegistryLoading && agentRegistry.length === 0 ? (
                  <div className="history-empty">加载 Agent 注册信息...</div>
                ) : agentRegistry.length === 0 ? (
                  <div className="history-empty">暂无 Agent 注册记录。</div>
                ) : (
                  agentRegistry.map((agent) => {
                    const employee = employees[agent.employeeId];
                    return (
                      <div className="task-row" key={agent.employeeId}>
                        <div className="task-row__main">
                          <strong>{agent.name} <small style={{ color: "#888" }}>({agent.employeeId})</small></strong>
                          <p>主机: {agent.hostname || employee?.hostname || "未知"} | 标签: {agent.labels.length > 0 ? agent.labels.join(", ") : "无"}</p>
                          <p>最后注册: {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "未连接"}</p>
                        </div>
                        <div className="task-row__side">
                          <span className={`status-pill ${agent.status === "approved" ? "online" : "queued"}`}>{agent.status === "approved" ? "已批准" : "待批准"}</span>
                          {employee && <span className={`status-pill ${employee.status}`}>{employee.status}</span>}
                          {agent.status === "pending" && (
                            <button className="action-btn action-btn--green" onClick={() => approveAgentRegistration(agent.employeeId)}>批准</button>
                          )}
                          <button className="retry-btn" onClick={() => deleteAgentRegistration(agent.employeeId)}>删除</button>
                        </div>
                      </div>
                    );
                  })
                )}
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
                            modalRef.current?.confirm({ title: "删除定时任务", content: `确定删除定时任务"${schedule.name}"？`, okText: "删除", cancelText: "取消", onOk: () => deleteSchedule(schedule.id) });
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
                        placeholder="/path/to/workspace"
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
                      disabled={!scheduleForm.name || !scheduleForm.cron || !scheduleForm.prompt || (scheduleForm.targetMode === "direct" && scheduleForm.targetAgents.length === 0)}
                    >
                      {editingSchedule ? "保存" : "创建"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        )}
        {activePage === "missions" && (
          <main className="task-log-page">
            <section className="task-log-panel mission-panel">
              <div className="section-title-row">
                <div>
                  <h1>AI Leader</h1>
                  <p>提交一个总目标，由 AI Leader 拆分子任务、派发 Agent、等待结果并在风险节点请求确认。</p>
                </div>
                <button className="secondary-button" onClick={() => fetchMissions()}>
                  刷新
                </button>
              </div>

              <div className="mission-create-grid">
                <label className="field mission-objective-field">
                  <span>总目标</span>
                  <textarea
                    value={missionForm.objective}
                    onChange={(e) => setMissionForm((f) => ({ ...f, objective: e.target.value }))}
                    placeholder="例如：完成生产稳定性优化，保持旧版接口兼容，并完成测试验证。"
                    rows={4}
                  />
                </label>
                <label className="field">
                  <span>工作目录</span>
                  <input
                    value={missionForm.workspace}
                    onChange={(e) => setMissionForm((f) => ({ ...f, workspace: e.target.value }))}
                    placeholder="可选，默认使用 Agent workspace"
                  />
                </label>
                <label className="field">
                  <span>确认策略</span>
                  <select
                    value={missionForm.approvalPolicy}
                    onChange={(e) => setMissionForm((f) => ({ ...f, approvalPolicy: e.target.value as MissionApprovalPolicy }))}
                  >
                    <option value="ask_on_risky_change">风险操作时确认</option>
                    <option value="manual_each_iteration">每轮计划都确认</option>
                    <option value="auto">自动推进</option>
                  </select>
                </label>
                <label className="field">
                  <span>最大轮次</span>
                  <input
                    type="number"
                    value={missionForm.maxIterations}
                    onChange={(e) => setMissionForm((f) => ({ ...f, maxIterations: e.target.value }))}
                    min={1}
                    max={50}
                  />
                </label>
                <label className="field">
                  <span>最大任务数</span>
                  <input
                    type="number"
                    value={missionForm.maxTasks}
                    onChange={(e) => setMissionForm((f) => ({ ...f, maxTasks: e.target.value }))}
                    min={1}
                    max={200}
                  />
                </label>
                <label className="field">
                  <span>任务超时秒数</span>
                  <input
                    type="number"
                    value={missionForm.timeoutSec}
                    onChange={(e) => setMissionForm((f) => ({ ...f, timeoutSec: e.target.value }))}
                    placeholder="可选"
                  />
                </label>
                <div className="mission-create-actions">
                  {missionError && <small className="modal-error">{missionError}</small>}
                  <button className="primary-button" onClick={createMission} disabled={!missionForm.objective.trim()}>
                    创建 Mission
                  </button>
                </div>
              </div>

              <div className="mission-layout">
                <div className="task-table mission-list">
                  {missionLoading && missions.length === 0 ? (
                    <div className="history-empty">加载中...</div>
                  ) : missions.length === 0 ? (
                    <div className="history-empty">暂无 Mission。</div>
                  ) : (
                    missions.map((mission) => (
                      <div
                        className={`task-row mission-row ${selectedMission?.mission.id === mission.id ? "selected" : ""}`}
                        key={mission.id}
                        onClick={() => fetchMissionDetail(mission.id)}
                      >
                        <div className="task-row__main">
                          <strong>{mission.objective}</strong>
                          <p>轮次 {mission.currentIteration}/{mission.maxIterations} · 任务上限 {mission.maxTasks}</p>
                        </div>
                        <div className="task-row__side">
                          <span className={`status-pill ${mission.status === "completed" ? "online" : mission.status === "failed" || mission.status === "cancelled" ? "offline" : "queued"}`}>
                            {mission.status}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mission-detail">
                  {!selectedMission ? (
                    <div className="history-empty">选择一个 Mission 查看详情。</div>
                  ) : (
                    <>
                      <div className="mission-detail-header">
                        <div>
                          <h2>{selectedMission.mission.objective}</h2>
                          <p>ID: {selectedMission.mission.id}</p>
                        </div>
                        <div className="mission-detail-actions">
                          <span className={`status-pill ${selectedMission.mission.status === "completed" ? "online" : selectedMission.mission.status === "failed" || selectedMission.mission.status === "cancelled" ? "offline" : "queued"}`}>
                            {selectedMission.mission.status}
                          </span>
                          {!["completed", "failed", "cancelled"].includes(selectedMission.mission.status) && (
                            <button className="secondary-button" onClick={() => cancelMission(selectedMission.mission.id)}>
                              取消
                            </button>
                          )}
                        </div>
                      </div>

                      {selectedMission.approvals.filter((approval) => approval.status === "pending").map((approval) => (
                        <div className="mission-approval" key={approval.id}>
                          <strong>需要确认</strong>
                          <p>{approval.question}</p>
                          <div className="schedule-actions">
                            <button className="primary-button" onClick={() => respondMissionApproval(approval, true)}>
                              批准继续
                            </button>
                            <button className="secondary-button schedule-delete-btn" onClick={() => respondMissionApproval(approval, false)}>
                              拒绝取消
                            </button>
                          </div>
                        </div>
                      ))}

                      <div className="mission-section">
                        <h3>子任务</h3>
                        <div className="task-table">
                          {selectedMission.subtasks.length === 0 ? (
                            <div className="history-empty">暂无子任务。</div>
                          ) : selectedMission.subtasks.map((subtask) => (
                            <div className="task-row" key={subtask.taskId}>
                              <div className="task-row__main">
                                <strong>{subtask.role} · 第 {subtask.iteration} 轮</strong>
                                <p>{subtask.task?.prompt ?? subtask.taskId}</p>
                              </div>
                              <div className="task-row__side">
                                {subtask.task && (
                                  <span className={`status-pill ${subtask.task.status === "completed" ? "online" : subtask.task.status === "failed" || subtask.task.status === "timeout" ? "offline" : "queued"}`}>
                                    {subtask.task.status}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="mission-section">
                        <h3>事件</h3>
                        <div className="mission-events">
                          {selectedMission.events.map((event) => (
                            <div className="mission-event" key={event.id}>
                              <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                              <strong>{event.type}</strong>
                              <code>{JSON.stringify(event.payload)}</code>
                            </div>
                          ))}
                        </div>
                      </div>

                      {selectedMission.mission.result && (
                        <div className="mission-result">
                          <h3>结果</h3>
                          <pre>{selectedMission.mission.result}</pre>
                        </div>
                      )}
                      {selectedMission.mission.error && (
                        <div className="mission-result mission-error-result">
                          <h3>错误</h3>
                          <pre>{selectedMission.mission.error}</pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </section>
          </main>
        )}
      </div>

      {!isMobile && <aside className="command-panel">
        <div className="panel-card chat-panel">
          <div className="chat-header">
            <div>
              <h2>任务指挥台</h2>
              <p>输入 <code>@</code> 选择目标，或直接发送到任务队列。</p>
            </div>
            <button className="secondary-button" onClick={() => { modalRef.current?.confirm({ title: "确认退出", content: "确认退出当前连接？", okText: "退出", cancelText: "取消", onOk: clearToken }); }}>
              切换 Token
            </button>
          </div>
          <div className="chat-list">
            {chatFeed.length === 0 ? (
              <div className="chat-empty">还没有发送过指令。</div>
            ) : (
              <ChatMessages items={bubbleItems} onReply={replyToMessage} />
            )}
          </div>
          <div className="chat-composer">
            <Suggestion
              items={getSuggestionItems}
              onSelect={handleSuggestionSelect}
              open={suggestionOpen}
              onOpenChange={setSuggestionOpen}
            >
              {({ onTrigger, onKeyDown }) => (
                <Sender
                  value={draft.prompt}
                  onChange={(val) => {
                    setDraft((c) => ({ ...c, prompt: val }));
                    const match = val.match(/([@/][^@\s/]*)$/);
                    if (match) {
                      onTrigger(match[1]);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "@" || e.key === "/") {
                      onTrigger(e.key);
                    }
                    const isNavKey = suggestionOpen && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(e.key);
                    if (isNavKey) {
                      onKeyDown(e);
                    } else {
                      e.stopPropagation();
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                      if (e.defaultPrevented || suggestionOpen) return;
                      e.preventDefault();
                      sendCommand();
                    }
                  }}
                  placeholder={resumeSession ? `回复 ${resumeSession.agentName} 的会话，按 Enter 发送` : "按 Enter 发送，Shift+Enter 换行；@ 选择目标"}
                  header={
                    <>
                      {resumeSession && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", marginBottom: 4, background: "rgba(22,119,255,0.12)", borderRadius: 6, fontSize: 12 }}>
                          <span style={{ color: "#69b1ff" }}>↩ {resumeSession.agentName} — {resumeSession.quote.length > 40 ? resumeSession.quote.slice(0, 40) + "..." : resumeSession.quote}</span>
                          <button onClick={() => setResumeSession(null)} style={{ background: "none", border: "none", color: "#999", cursor: "pointer", fontSize: 12 }}>取消</button>
                        </div>
                      )}
                      <Sender.Header title="工作目录" open={false}>
                        <input
                          value={draft.workspace}
                          onChange={(e) => setDraft((c) => ({ ...c, workspace: e.target.value }))}
                          placeholder="/path/to/workspace"
                          style={{ width: "100%", padding: "4px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#eef4ff", fontSize: 12 }}
                        />
                      </Sender.Header>
                    </>
                  }
                  style={{ flexShrink: 0 }}
                />
              )}
            </Suggestion>
          </div>
        </div>
      </aside>}
        </div>
      </XProvider>
      </AntApp>
    </ConfigProvider>
  );
}

function ModalBridge({ modalRef }: { modalRef: React.MutableRefObject<ReturnType<typeof AntApp.useApp>["modal"] | null> }) {
  const { modal } = AntApp.useApp();
  modalRef.current = modal;
  return null;
}
