import { execFile } from "node:child_process";

let cachedClaudeVersion: string | undefined;
let refreshing = false;
let lastRefresh = 0;

export function getClaudeVersion(options: { refresh?: boolean } = {}): string | undefined {
  if (!refreshing && (options.refresh || Date.now() - lastRefresh > 60_000)) {
    refreshing = true;
    lastRefresh = Date.now();
    execFile("claude", ["--version"], { timeout: 5000, encoding: "utf8", maxBuffer: 4096 }, (error, stdout) => {
      if (!error) cachedClaudeVersion = stdout.trim().split(/\s/)[0] || undefined;
      refreshing = false;
    });
  }
  return cachedClaudeVersion || undefined;
}
