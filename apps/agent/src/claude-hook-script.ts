export const CLAUDE_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function readStdin() {
  return new Promise((resolve) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
  });
}

function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

function timestamp() {
  return new Date().toLocaleString();
}

function safeLine(value) {
  return String(value ?? "").replace(/\\n/g, " ").trim();
}

function truncate(value, max = 1200) {
  const text = safeLine(value);
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function describeTool(input) {
  if (!input.tool_name) {
    return "";
  }
  const toolInput = input.tool_input || {};
  if (input.tool_name === "Bash" && toolInput.command) {
    return " - " + input.tool_name + ": " + truncate(toolInput.command, 500);
  }
  const filePath = toolInput.file_path || toolInput.path;
  if (filePath) {
    return " - " + input.tool_name + ": " + filePath;
  }
  return " - " + input.tool_name;
}

(async () => {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    const recordDir = process.env.AI_TEAMS_RECORD_DIR;
    if (!recordDir) {
      process.exit(0);
    }

    const dailyDir = path.join(recordDir, "daily");
    fs.mkdirSync(dailyDir, { recursive: true });
    const filePath = path.join(dailyDir, dateKey() + ".md");
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "# " + process.env.AI_TEAMS_AGENT_NAME + " Daily Activity - " + dateKey() + "\\n\\n");
    }

    const event = input.hook_event_name || "Unknown";
    const lines = [
      "### " + timestamp() + " Claude Hook: " + event,
      "- Agent: " + process.env.AI_TEAMS_AGENT_NAME + " (" + process.env.AI_TEAMS_AGENT_ID + ")",
      "- Task ID: " + (process.env.AI_TEAMS_TASK_ID || "none"),
      "- Target mode: " + (process.env.AI_TEAMS_TASK_TARGET_MODE || "unknown"),
      "- Managed session: " + (process.env.AI_TEAMS_TASK_SESSION_ID || "unknown"),
      "- Claude hook session: " + (input.session_id || "unknown"),
      "- CWD: " + (input.cwd || "unknown"),
      input.transcript_path ? "- Transcript: " + input.transcript_path : "",
      describeTool(input),
      input.prompt ? "- Prompt: " + truncate(input.prompt) : "",
      input.last_assistant_message ? "- Last assistant message: " + truncate(input.last_assistant_message) : "",
      input.error ? "- Error: " + truncate(input.error) : "",
      input.reason ? "- Reason: " + input.reason : "",
      input.compact_summary ? "- Compact summary: " + truncate(input.compact_summary) : "",
      "",
    ].filter(Boolean);

    fs.appendFileSync(filePath, lines.join("\\n") + "\\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(0);
  }
})();
`;
