import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CONFIG_DIR = path.join(os.homedir(), ".ai-teams");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export type AgentConfig = {
  serverUrl: string;
  authToken: string;
  agentToken?: string;
  employeeId: string;
  employeeName: string;
  workspace: string;
  runnerMode: string;
  permissionMode?: string;
  weight?: number;
};

export function getConfigPath() {
  return CONFIG_FILE;
}

export function loadConfigFile(): AgentConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveConfigFile(config: AgentConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export async function runSetup(existing: AgentConfig | null): Promise<AgentConfig> {
  const rl = createInterface({ input, output });

  console.log("");
  console.log("  AI Teams Agent 配置");
  console.log("  ───────────────────");
  console.log("");

  const serverUrl = await rl.question(`  服务器地址 [${existing?.serverUrl ?? "ws://localhost:3789"}]: `);
  const authToken = await rl.question(`  认证 Token${existing ? " [******]" : ""}: `);
  const agentToken = await rl.question(`  Agent Token${existing?.agentToken ? " [******]" : ""}: `);
  const employeeId = await rl.question(`  员工 ID [${existing?.employeeId ?? "emp_local"}]: `);
  const employeeName = await rl.question(`  员工名称 [${existing?.employeeName ?? "Local Agent"}]: `);
  const workspace = await rl.question(`  工作目录 [${existing?.workspace ?? process.cwd()}]: `);
  const runnerMode = await rl.question(`  Runner 模式 (claude/fake) [${existing?.runnerMode ?? "claude"}]: `);
  const permissionMode = await rl.question(`  Claude 权限模式 [${existing?.permissionMode ?? "bypassPermissions"}]: `);
  const weight = await rl.question(`  任务权重 [${existing?.weight ?? 1}]: `);

  rl.close();

  const parsedWeight = Number(weight.trim() || existing?.weight || 1);
  const config: AgentConfig = {
    serverUrl: serverUrl.trim() || existing?.serverUrl || "ws://localhost:3789",
    authToken: authToken.trim() || existing?.authToken || "",
    agentToken: agentToken.trim() || existing?.agentToken || "",
    employeeId: employeeId.trim() || existing?.employeeId || "emp_local",
    employeeName: employeeName.trim() || existing?.employeeName || "Local Agent",
    workspace: workspace.trim() || existing?.workspace || process.cwd(),
    runnerMode: runnerMode.trim() || existing?.runnerMode || "claude",
    permissionMode: permissionMode.trim() || existing?.permissionMode || "bypassPermissions",
    weight: parsedWeight >= 1 ? parsedWeight : 1,
  };

  saveConfigFile(config);
  console.log("");
  console.log(`  \u2713 配置已保存到 ${CONFIG_FILE}`);
  return config;
}
