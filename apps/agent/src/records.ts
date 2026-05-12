import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOOK_SCRIPT_CONTENT } from "./claude-hook-script.js";
import {
  EMPLOYEE_ID,
  EMPLOYEE_NAME,
  DAILY_RECORDS_DIR,
  DEFAULT_WORKSPACE,
  WORKSPACE_CLAUDE_MD,
  CLAUDE_MD_SECTION_START,
  CLAUDE_MD_SECTION_END,
  STATE_FILE,
  HOOKS_DIR,
  CLAUDE_HOOK_SCRIPT,
  CLAUDE_HOOK_SETTINGS,
  CLAUDE_HOOKS_ENABLED,
  type ActiveTask,
} from "./config.js";

function localTimestamp() {
  return new Date().toLocaleString();
}

function localDateKey() {
  return new Date().toISOString().slice(0, 10);
}

export function appendDailyRecord(markdown: string) {
  fs.mkdirSync(DAILY_RECORDS_DIR, { recursive: true });
  const filePath = path.join(DAILY_RECORDS_DIR, `${localDateKey()}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${EMPLOYEE_NAME} Daily Activity - ${localDateKey()}\n\n`);
  }
  fs.appendFileSync(filePath, markdown);
}

function formatPromptForRecord(prompt: string) {
  return prompt.trim().replace(/\n/g, "\n  ");
}

export function recordTaskStart(task: ActiveTask, prompt: string, workspace: string | null) {
  appendDailyRecord(
    [
      `## ${localTimestamp()} Task Started`,
      `- Agent: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`,
      `- Task ID: ${task.taskId}`,
      `- Target mode: ${task.targetMode}`,
      `- Claude session: ${task.claudeSessionId}`,
      `- Workspace: ${workspace || DEFAULT_WORKSPACE}`,
      `- Prompt:`,
      `  ${formatPromptForRecord(prompt)}`,
      "",
    ].join("\n"),
  );
}

export function recordTaskFinish(task: ActiveTask, status: "completed" | "failed" | "cancelled", detail?: string | number) {
  appendDailyRecord(
    [
      `## ${localTimestamp()} Task ${status}`,
      `- Agent: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`,
      `- Task ID: ${task.taskId}`,
      `- Target mode: ${task.targetMode}`,
      `- Claude session: ${task.claudeSessionId}`,
      typeof detail === "undefined" ? "" : `- Detail: ${String(detail).replace(/\n/g, " ")}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function ensureWorkspaceClaudeMd() {
  fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  const section = buildWorkspaceClaudeSection();
  const current = fs.existsSync(WORKSPACE_CLAUDE_MD) ? fs.readFileSync(WORKSPACE_CLAUDE_MD, "utf8") : "";
  const startIndex = current.indexOf(CLAUDE_MD_SECTION_START);
  const endIndex = current.indexOf(CLAUDE_MD_SECTION_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const next = `${current.slice(0, startIndex).trimEnd()}\n\n${section}\n\n${current
      .slice(endIndex + CLAUDE_MD_SECTION_END.length)
      .trimStart()}`;
    fs.writeFileSync(WORKSPACE_CLAUDE_MD, next.trimEnd() + "\n");
    return;
  }

  const next = current.trim()
    ? `${current.trimEnd()}\n\n${section}\n`
    : `${section}\n`;
  fs.writeFileSync(WORKSPACE_CLAUDE_MD, next);
}

function buildWorkspaceClaudeSection() {
  return [
    CLAUDE_MD_SECTION_START,
    "## AI Teams Agent Operating Rules",
    "",
    `- Agent identity: ${EMPLOYEE_NAME} (${EMPLOYEE_ID}).`,
    `- Default workspace: \`${DEFAULT_WORKSPACE}\`.`,
    `- Default managed session state: \`${STATE_FILE}\`.`,
    `- Daily memory files: \`${path.join(DAILY_RECORDS_DIR, "YYYY-MM-DD.md")}\`.`,
    `- Claude hook settings: \`${CLAUDE_HOOK_SETTINGS}\`.`,
    "",
    "### Conversation Responsibility",
    "",
    "- Treat direct `@Agent` or explicitly selected-Agent messages as this Agent's long-running default conversation.",
    "- Keep continuity for direct Agent conversations by using the managed default session state.",
    "- Treat queue tasks as isolated execution jobs; use their task-specific session context and avoid assuming they update the default conversation unless explicitly requested.",
    "- When reporting back, summarize what changed, what was verified, and any remaining risks.",
    "",
    "### Memory And State Rules",
    "",
    "- At the start of a direct Agent conversation, read the most recent daily memory files before acting when continuity, prior decisions, or current workspace state could matter.",
    "- Read today's memory file first, then recent previous days only as needed. Do not bulk-load all history unless the task asks for a retrospective.",
    "- Use the daily memory files to understand what this Agent did, which tasks completed, which tools ran, and what unresolved work remains.",
    "- Append durable observations through the AI Teams recorder and Claude hooks; avoid hand-editing generated hook records unless correcting an obvious mistake.",
    "- Do not store secrets, tokens, private credentials, or sensitive user data in daily memory files.",
    "",
    "### Files Managed By AI Teams",
    "",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/session-state.json` stores the default Claude session id for this Agent.",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/daily/` stores Markdown activity memory by date.",
    "- `.ai-teams/agents/<EMPLOYEE_ID>/hooks/` stores generated Claude Code hook scripts and settings.",
    "- These files are runtime state, not source code. Do not delete them unless explicitly asked to reset Agent memory.",
    CLAUDE_MD_SECTION_END,
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function ensureClaudeHookFiles() {
  if (!CLAUDE_HOOKS_ENABLED) {
    return;
  }
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_HOOK_SCRIPT, CLAUDE_HOOK_SCRIPT_CONTENT);
  fs.chmodSync(CLAUDE_HOOK_SCRIPT, 0o755);
  fs.writeFileSync(CLAUDE_HOOK_SETTINGS, JSON.stringify(buildClaudeHookSettings(), null, 2));
}

function buildHookCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(CLAUDE_HOOK_SCRIPT)}`;
}

function buildClaudeHookSettings() {
  const hook = {
    type: "command",
    command: buildHookCommand(),
    timeout: 10,
  };
  return {
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [hook] }],
      UserPromptSubmit: [{ matcher: "*", hooks: [hook] }],
      PostToolUse: [{ matcher: "*", hooks: [hook] }],
      Stop: [{ matcher: "*", hooks: [hook] }],
      StopFailure: [{ matcher: "*", hooks: [hook] }],
      SessionEnd: [{ matcher: "*", hooks: [hook] }],
      PostCompact: [{ matcher: "*", hooks: [hook] }],
    },
  };
}
