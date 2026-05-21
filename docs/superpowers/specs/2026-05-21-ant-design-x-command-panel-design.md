# @ant-design/x Command Panel Design

## Summary

Replace the Leader chat command panel with `@ant-design/x` components: `Bubble.List` for messages, `ThoughtChain` for task execution progress, `Sender` for input, and `Suggestion` for @mention target selection. Drop-in replacement — same features, better UI.

## Scope

- **In scope**: Desktop command panel (`aside.command-panel`), mobile chat feed + input bar, component mapping from current divs to @ant-design/x
- **Out of scope**: Monitor/tasks/employees/schedules/errors/stats pages, WebSocket logic, E2E encryption, REST API, EmployeeCard, `chatFeed` computation core

## Component Mapping

### 1. Bubble.List — Message Feed

Replaces: `div.chat-list` (desktop, lines 1703-1735) and `div.mobile-chat-feed` (mobile, lines 1207-1239)

Data source: New `bubbleItems` computed from existing `chatFeed` array.

```tsx
const bubbleItems = useMemo(() => chatFeed.map((item) => {
  const isLeader = item.side === "leader";
  return {
    key: item.id,
    role: isLeader ? "user" : "ai",
    content: item.content,
    ...isLeader && item.executingBy?.length ? { executingBy: item.executingBy } : {},
    ...!isLeader && item.status ? { taskStatus: item.status } : {},
    ...isLeader && item.target ? { target: item.target } : {},
    createdAt: item.createdAt,
    author: item.author,
  };
}), [chatFeed]);
```

Role presets on `Bubble.List`:
```tsx
roles={{
  user: {
    placement: "end",
    avatar: { style: { background: "#52c41a" }, children: "L" },
    style: { background: "#1677ff" },
  },
  ai: {
    placement: "start",
    avatar: (_, info) => ({ children: info.author?.[0] ?? "?" }),
    style: { background: "#1a1a1a", border: "1px solid #303030" },
  },
}}
```

- `autoScroll: true` eliminates manual `scrollToBottom` useEffect
- `contentRender` for leader: renders ThoughtChain when `executingBy` exists
- `contentRender` for employee: red-tinted background for failed/timeout status
- Height: `flex: 1` on parent, explicit `style={{ height: '100%' }}` on Bubble.List for scroll

### 2. ThoughtChain — Task Execution Status

Replaces: `div.chat-message__executing` spans (desktop lines 1713-1721, mobile lines 1217-1224)

Rendered inside leader Bubble's `contentRender` when `executingBy` array is present.

```tsx
<ThoughtChain
  items={executingBy.map((agent) => ({
    key: agent.name,
    title: agent.name,
    description: statusLabel(agent.status),
    status: thoughtChainStatus(agent.status),
    collapsible: executingBy.length > 2,
  }))}
  size="small"
  style={{ marginTop: 8 }}
/>
```

Status mapping:
| TaskStatus | ThoughtChain status |
|---|---|
| completed | `"success"` |
| failed, timeout | `"error"` |
| running | `"loading"` |
| dispatched, accepted, queued, cancelled | undefined (default icon) |

### 3. Sender — Input Area

Replaces: `div.chat-composer` (desktop, lines 1736-1790) and `div.mobile-input-bar` (mobile, lines 1242-1296)

```tsx
<Sender
  value={draft.prompt}
  onChange={(val) => setDraft((c) => ({ ...c, prompt: val }))}
  onSubmit={sendCommand}
  submitType="enter"
  placeholder="按 Enter 发送；Option/Alt + Enter 换行。默认进入任务队列..."
  header={
    <Sender.Header
      title="工作目录"
      open={false}
    >
      <input
        value={draft.workspace}
        onChange={(e) => setDraft((c) => ({ ...c, workspace: e.target.value }))}
        placeholder="/Users/junhang/workspace/project"
        style={{ width: '100%', padding: '4px 8px' }}
      />
    </Sender.Header>
  }
  style={{ flexShrink: 0 }}
/>
```

- Enter sends, Alt/Option+Enter adds newline (matches current behavior)
- Workspace input in collapsible Sender.Header
- No send button needed — Sender handles submit internally

### 4. Suggestion — @mention Target Picker

Replaces: `div.target-picker` chip buttons (desktop lines 1737-1762, mobile lines 1244-1268)

Wraps the Sender component. Triggered when user types `@`.

```tsx
<Suggestion
  items={suggestionItems}
  onTrigger={(str) => {
    if (!str.endsWith('@')) return false;
    return '';
  }}
  onSelect={(value) => {
    // Map value to AgentTarget
    // Insert @Name into draft.prompt
  }}
>
  {({ onTrigger, onKeyDown }) => (
    <Sender ... />
  )}
</Suggestion>
```

Items built from `employeeList`:
```tsx
const suggestionItems = useMemo(() => [
  { label: "任务队列", value: "queue", description: "Round-robin to idle agents" },
  { label: "@所有员工", value: "all", description: "Broadcast to all online agents" },
  ...employeeList.map((emp) => ({
    label: `@${emp.name}`,
    value: emp.id,
    description: `Direct — ${emp.status}`,
    disabled: emp.status === "offline",
  })),
], [employeeList]);
```

### 5. XProvider — Theme

Wraps `aside.command-panel` to configure dark theme:

```tsx
import { XProvider } from "@ant-design/x";
import { theme } from "antd";

<XProvider theme={{ algorithm: theme.darkAlgorithm }}>
  <aside className="command-panel">...</aside>
</XProvider>
```

## State Changes

- Remove: `selectedTarget` state (Suggestion handles target selection inline)
- Remove: `chatListRef`, `mobileChatRef` refs (Bubble.List handles scroll)
- Remove: `scrollToBottom` function and related useEffect
- Keep: `chatFeed` computation unchanged
- Add: `bubbleItems` computed from `chatFeed`

## Mobile Layout

Both desktop and mobile share the same Bubble.List + Suggestion > Sender components. CSS handles layout:

- Desktop: `aside.command-panel` with fixed 500px width
- Mobile: full-width chat feed + fixed bottom input bar

Remove mobile-specific `mobile-chat-feed`, `mobile-input-bar`, `mobile-target-row` markup. The same components render differently via CSS media queries.

## Dependencies

Add to `apps/web/package.json`:
- `@ant-design/x` — core component library
- `antd` — peer dependency (theme, ConfigProvider)
- `@ant-design/icons` — peer dependency (avatars, status icons)
- `dayjs` — peer dependency

## Files Changed

| File | Change |
|---|---|
| `apps/web/package.json` | Add 4 dependencies |
| `apps/web/src/App.tsx` | Rewrite command panel (lines 1692-1792), mobile chat (1207-1296), add bubbleItems, remove replaced state/refs, add imports |
| `apps/web/src/App.css` | Remove `.chat-list`, `.chat-message`, `.leader-message`, `.employee-message`, `.target-picker`, `.target-chip`, `.chat-composer`, `.chat-message__executing`, `.executing-status` and mobile equivalents. Add minimal overrides for @ant-design/x dark theme. |

## What's NOT Changing

- WebSocket connection logic
- `chatFeed` computation core (only adding `bubbleItems` mapping)
- `sendCommand()` logic (only called from Sender.onSubmit)
- Monitor/tasks/employees/schedules/errors/stats pages
- EmployeeCard component
- E2E encryption
- REST API calls
- Terminal log rendering
