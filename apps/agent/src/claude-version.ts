import { execSync } from "node:child_process";

let cachedClaudeVersion: string | undefined;

export function getClaudeVersion(options: { refresh?: boolean } = {}): string | undefined {
  if (!options.refresh && cachedClaudeVersion !== undefined) {
    return cachedClaudeVersion || undefined;
  }
  try {
    const raw = execSync("claude --version 2>/dev/null", { timeout: 5000, encoding: "utf8" }).trim();
    cachedClaudeVersion = raw.split(/\s/)[0] || raw;
  } catch {
    cachedClaudeVersion = "";
  }
  return cachedClaudeVersion || undefined;
}
