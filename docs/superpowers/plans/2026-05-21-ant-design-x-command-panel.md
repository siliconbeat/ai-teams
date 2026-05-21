# @ant-design/x Command Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Leader chat command panel with @ant-design/x components (Bubble.List, ThoughtChain, Sender, Suggestion).

**Architecture:** The command panel (`aside.command-panel`) and mobile chat are reimplemented using @ant-design/x chat components. A shared `ChatPanel` component renders in both desktop and mobile layouts via CSS. Existing WebSocket logic, `chatFeed` computation, and `sendCommand()` remain unchanged.

**Tech Stack:** React 19, @ant-design/x (Bubble, ThoughtChain, Sender, Suggestion, XProvider), antd (dark theme)

**Spec:** `docs/superpowers/specs/2026-05-21-ant-design-x-command-panel-design.md`

---

### Task 1: Install dependencies

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install @ant-design/x and peer dependencies**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web add @ant-design/x antd @ant-design/icons dayjs
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm install && pnpm --filter @ai-teams/web build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml pnpm-lock.yaml
git commit -m "chore(web): add @ant-design/x and peer dependencies"
```

---

### Task 2: Add XProvider dark theme wrapper

**Files:**
- Modify: `apps/web/src/App.tsx` (imports section, line ~1; render section wrapping `div.app-shell`)

This task wraps the app with antd's dark theme and @ant-design/x's XProvider so all x components inherit dark styling.

- [ ] **Step 1: Add imports at top of App.tsx**

Add after the existing imports (line 14):

```tsx
import { XProvider } from "@ant-design/x";
import { ConfigProvider, theme } from "antd";
```

- [ ] **Step 2: Wrap the return JSX with providers**

Wrap the existing `<div className="app-shell">` return (line 1101) with:

```tsx
return (
  <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
    <XProvider>
      <div className="app-shell">
        {/* ... existing content unchanged ... */}
      </div>
    </XProvider>
  </ConfigProvider>
);
```

- [ ] **Step 3: Verify dev server starts**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm dev:web
```

Expected: Vite dev server starts without errors. Page renders same as before but with antd dark theme context available.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): wrap app with antd dark theme and XProvider"
```

---

### Task 3: Compute bubbleItems from chatFeed

**Files:**
- Modify: `apps/web/src/App.tsx` (add imports for @ant-design/x types, add `bubbleItems` useMemo after `chatFeed` at line ~678)

This task adds the data mapping layer. No UI change yet.

- [ ] **Step 1: Add @ant-design/x imports**

Add to the import block at top of file:

```tsx
import { Bubble, ThoughtChain, Sender, Suggestion } from "@ant-design/x";
import type { BubbleProps } from "@ant-design/x";
```

- [ ] **Step 2: Add thoughtChainStatus helper function**

Add after `statusLabel` function (line ~716):

```tsx
function thoughtChainStatus(status: TaskStatus): "success" | "error" | "loading" | undefined {
  if (status === "completed") return "success";
  if (status === "failed" || status === "timeout") return "error";
  if (status === "running") return "loading";
  return undefined;
}
```

- [ ] **Step 3: Add bubbleItems useMemo**

Add after `chatFeed` useMemo (after line 678):

```tsx
const bubbleItems = useMemo(() =>
  chatFeed.map((item) => {
    const isLeader = item.side === "leader";
    return {
      key: item.id,
      role: isLeader ? "user" as const : "ai" as const,
      content: item.content,
      ...(isLeader && item.executingBy?.length ? { executingBy: item.executingBy } : {}),
      ...(!isLeader && item.status ? { taskStatus: item.status } : {}),
      ...(isLeader && item.target ? { target: item.target } : {}),
      createdAt: item.createdAt,
      author: item.author,
    };
  })
, [chatFeed]);
```

- [ ] **Step 4: Verify no type errors**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web exec tsc --noEmit
```

Expected: No new type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): add bubbleItems computation for Bubble.List"
```

---

### Task 4: Build Suggestion items and replace target selection logic

**Files:**
- Modify: `apps/web/src/App.tsx` (add `suggestionItems` useMemo, modify sendCommand to use Suggestion-selected target)

This task replaces the chip-button target picker state with Suggestion-driven target selection.

- [ ] **Step 1: Add suggestionItems useMemo**

Add after `bubbleItems` useMemo:

```tsx
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
```

- [ ] **Step 2: Add Suggestion trigger and selection handler state**

Add state for the Suggestion component. Add near other useState hooks (around line ~130):

```tsx
const [suggestionOpen, setSuggestionOpen] = useState(false);
```

Add the handler functions after `suggestionItems`:

```tsx
const handleSuggestionTrigger = (inputText: string) => {
  const atIndex = inputText.lastIndexOf("@");
  if (atIndex === -1) return false;
  const afterAt = inputText.slice(atIndex + 1);
  return afterAt;
};

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
    // Insert @Name into prompt
    const currentPrompt = draft.prompt;
    const atName = `@${emp.name}`;
    if (!currentPrompt.includes(atName)) {
      setDraft((c) => ({ ...c, prompt: c.prompt ? `${c.prompt} ${atName}` : atName }));
    }
  }
  setSuggestionOpen(false);
};
```

- [ ] **Step 3: Verify no type errors**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): add Suggestion items and target selection logic"
```

---

### Task 5: Replace desktop command panel with @ant-design/x components

**Files:**
- Modify: `apps/web/src/App.tsx` (replace lines 1692-1792, the `aside.command-panel` section)

This is the core UI replacement. The entire `aside.command-panel` block is rewritten.

- [ ] **Step 1: Replace the aside.command-panel JSX**

Replace the entire `<aside className="command-panel">...</aside>` block (lines 1692-1792) with:

```tsx
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
    <div className="chat-list" ref={chatListRef}>
      {chatFeed.length === 0 ? (
        <div className="chat-empty">还没有发送过指令。</div>
      ) : (
        <Bubble.List
          style={{ height: "100%" }}
          autoScroll
          items={bubbleItems}
          roles={{
            user: {
              placement: "end",
              avatar: { style: { background: "#52c41a", fontSize: 12 } as React.CSSProperties, children: "L" },
              header: (_, info) => {
                const item = info.originData;
                return (
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, fontSize: 12, color: "#90a1be" }}>
                    {item.target && <span>{item.target} · </span>}
                    <span>{item.createdAt}</span>
                  </div>
                );
              },
              contentRender: (_, info) => {
                const item = info.originData;
                return (
                  <div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{item.content}</div>
                    {item.executingBy?.length > 0 && (
                      <ThoughtChain
                        size="small"
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
              avatar: (_, info) => {
                const item = info.originData;
                const initial = item.author?.[0] ?? "?";
                return { style: { background: "#1677ff", fontSize: 12 } as React.CSSProperties, children: initial };
              },
              header: (_, info) => {
                const item = info.originData;
                return (
                  <div style={{ fontSize: 12, color: "#90a1be", display: "flex", gap: 6 }}>
                    <strong style={{ color: "#c9d6f2" }}>{item.author}</strong>
                    <span>{item.createdAt}</span>
                  </div>
                );
              },
              contentRender: (_, info) => {
                const item = info.originData;
                const isError = item.taskStatus === "failed" || item.taskStatus === "timeout";
                return (
                  <div style={isError ? { color: "#ff4d4f" } : undefined}>
                    {item.content}
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
        onTrigger={(v) => {
          const lastAtIndex = v.lastIndexOf("@");
          if (lastAtIndex === -1) return false;
          return v.slice(lastAtIndex + 1);
        }}
        onSelect={handleSuggestionSelect}
      >
        {({ onTrigger, onKeyDown }) => (
          <Sender
            value={draft.prompt}
            onChange={(val) => {
              setDraft((c) => ({ ...c, prompt: val }));
              // Check if @ was typed to trigger suggestion
              const lastAtIndex = val.lastIndexOf("@");
              if (lastAtIndex !== -1) {
                const afterAt = val.slice(lastAtIndex + 1);
                if (!afterAt.includes(" ")) {
                  onTrigger(val);
                }
              }
            }}
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
```

- [ ] **Step 2: Start dev server and visually verify**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm dev:all
```

Verify:
1. Command panel renders with Bubble.List
2. Leader messages appear on right with green avatar
3. Employee messages appear on left with blue avatar
4. ThoughtChain shows execution status inside leader messages
5. Sender renders with collapsible workspace header
6. Typing `@` triggers Suggestion dropdown with agent list
7. Selecting an agent inserts @Name into input
8. Enter sends message, Alt+Enter adds newline

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): replace desktop command panel with @ant-design/x components"
```

---

### Task 6: Replace mobile chat with shared @ant-design/x components

**Files:**
- Modify: `apps/web/src/App.tsx` (replace mobile chat feed lines 1207-1239 and mobile input bar lines 1242-1296)

- [ ] **Step 1: Replace mobile-chat-feed and mobile-input-bar JSX**

Replace the mobile chat feed block (`<div className="mobile-chat-feed">...</div>`, lines 1207-1239) with:

```tsx
<div className="mobile-chat-feed" ref={mobileChatRef}>
  {chatFeed.length === 0 ? (
    <div className="mobile-chat-empty">还没有发送过指令。</div>
  ) : (
    <Bubble.List
      style={{ height: "100%" }}
      autoScroll
      items={bubbleItems}
      roles={{
        user: {
          placement: "end",
          avatar: { style: { background: "#52c41a", fontSize: 12 } as React.CSSProperties, children: "L" },
          header: (_, info) => {
            const item = info.originData;
            return (
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, fontSize: 11, color: "#90a1be" }}>
                {item.target && <span>{item.target} · </span>}
                <span>{item.createdAt}</span>
              </div>
            );
          },
          contentRender: (_, info) => {
            const item = info.originData;
            return (
              <div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{item.content}</div>
                {item.executingBy?.length > 0 && (
                  <ThoughtChain
                    size="small"
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
          avatar: (_, info) => {
            const item = info.originData;
            const initial = item.author?.[0] ?? "?";
            return { style: { background: "#1677ff", fontSize: 12 } as React.CSSProperties, children: initial };
          },
          header: (_, info) => {
            const item = info.originData;
            return (
              <div style={{ fontSize: 11, color: "#90a1be", display: "flex", gap: 4 }}>
                <strong style={{ color: "#c9d6f2" }}>{item.author}</strong>
                <span>{item.createdAt}</span>
              </div>
            );
          },
          contentRender: (_, info) => {
            const item = info.originData;
            const isError = item.taskStatus === "failed" || item.taskStatus === "timeout";
            return <div style={isError ? { color: "#ff4d4f", fontSize: 12 } : { fontSize: 12 }}>{item.content}</div>;
          },
          styles: { content: { background: "rgba(255, 255, 255, 0.06)", border: "1px solid rgba(255, 255, 255, 0.08)" } },
        },
      }}
    />
  )}
</div>
```

Replace the mobile input bar block (`<div className="mobile-input-bar">...</div>`, lines 1242-1296) with:

```tsx
<div className="mobile-input-bar">
  <Suggestion
    items={suggestionItems}
    open={suggestionOpen}
    onOpenChange={setSuggestionOpen}
    onTrigger={(v) => {
      const lastAtIndex = v.lastIndexOf("@");
      if (lastAtIndex === -1) return false;
      return v.slice(lastAtIndex + 1);
    }}
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
        onSubmit={() => sendCommand()}
        submitType="enter"
        placeholder="输入指令... @ 选择目标"
        style={{ flexShrink: 0 }}
      />
    )}
  </Suggestion>
</div>
```

- [ ] **Step 2: Verify mobile layout**

Open dev tools, switch to mobile viewport (≤640px). Verify:
1. Chat feed shows with Bubble.List
2. Sender renders at bottom
3. @mention Suggestion works on mobile
4. Scrolling works correctly

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): replace mobile chat with @ant-design/x components"
```

---

### Task 7: Clean up replaced state, refs, and CSS

**Files:**
- Modify: `apps/web/src/App.tsx` (remove unused refs, state, functions)
- Modify: `apps/web/src/App.css` (remove replaced CSS classes)

- [ ] **Step 1: Remove unused refs and state from App.tsx**

Remove the following if no longer used outside the replaced sections:
- `chatListRef` — check if still used for desktop `div.chat-list`. If Bubble.List handles scroll, remove the ref and its `useEffect` (lines 1040-1043).
- `mobileChatRef` — same check for mobile.
- `mobileTextareaRef` — replaced by Sender. Remove the ref and its usage in `sendCommand()` (line 908).
- `selectedTarget` state — **KEEP**. Still used by `sendCommand()` via `resolveAtAgentsFromPrompt`.
- `toggleTarget`, `selectQueueTarget`, `selectAllTargets` functions — remove (replaced by Suggestion `handleSuggestionSelect`).
- `scrollToBottom` function (line 1033-1038) — remove if no refs use it.

- [ ] **Step 2: Remove replaced CSS from App.css**

Remove these CSS blocks (desktop chat message styles, now handled by Bubble):
- `.chat-message` (lines 602-607)
- `.leader-message` and children (lines 609-626)
- `.chat-message__time-outside` (lines 628-633)
- `.chat-message__executing` and children (lines 635-646)
- `.executing-status.*` (lines 648-668)
- `.employee-message` and children (lines 670-679)
- `.chat-message p` (lines 681-685)
- `.chat-message small` (lines 687-689)
- `.target-picker` (lines 593-600)
- `.target-chip` and `.target-chip.active` (lines 268-277, 280-283 — **only if not used by schedule form**)
- Mobile chat overrides inside `.mobile-chat-feed` (lines 1255-1298)
- `.mobile-target-row` (lines 1322-1340)
- `.mobile-input-row` and children (lines 1342-1381)

**Keep** these CSS blocks (still needed):
- `.chat-panel` (lines 542-548) — layout for the panel
- `.chat-header` and children (lines 550-566) — header styling
- `.chat-list` (lines 568-584) — outer scroll container for Bubble.List
- `.chat-composer` (lines 586-591) — layout for Sender wrapper
- `.chat-empty` (line 692) — empty state text
- `.mobile-chat-feed` base (lines 1242-1253) — mobile scroll container
- `.mobile-input-bar` base (lines 1310-1320) — mobile input layout
- `.mobile-chat-empty` (lines 1300-1307) — mobile empty state

- [ ] **Step 3: Add minimal CSS overrides for @ant-design/x dark theme**

Add after the `.chat-composer` block in App.css:

```css
/* @ant-design/x overrides */
.chat-list .ant-bubble-list {
  height: 100%;
}

.chat-list .ant-bubble-content {
  font-size: 13px;
  line-height: 1.5;
}

.chat-composer .ant-sender {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.04);
}

.mobile-input-bar .ant-sender {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.04);
}
```

- [ ] **Step 4: Verify build and visual check**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web build
```

Start dev server, check both desktop and mobile layouts render correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.css
git commit -m "refactor(web): clean up replaced chat CSS and unused refs"
```

---

### Task 8: Final verification and build

**Files:**
- All changed files

- [ ] **Step 1: Run full typecheck**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm typecheck
```

Expected: No type errors.

- [ ] **Step 2: Run full build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm build
```

Expected: All three packages build successfully.

- [ ] **Step 3: Run dev server full integration check**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm dev:all
```

Manual verification checklist:
- [ ] Desktop: Command panel renders with Bubble.List
- [ ] Desktop: Leader messages right-aligned with avatar
- [ ] Desktop: Employee messages left-aligned with avatar
- [ ] Desktop: ThoughtChain shows execution status
- [ ] Desktop: Sender input with workspace header
- [ ] Desktop: Typing @ triggers Suggestion dropdown
- [ ] Desktop: Selecting target from Suggestion works
- [ ] Desktop: Enter sends, Alt+Enter adds newline
- [ ] Mobile: Chat feed renders correctly
- [ ] Mobile: Sender at bottom works
- [ ] Mobile: @mention Suggestion works
- [ ] No console errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(web): final adjustments for @ant-design/x integration"
```
