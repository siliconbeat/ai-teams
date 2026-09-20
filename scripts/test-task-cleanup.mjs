// Run after pnpm build. Requires Playwright with Chromium installed.
// PLAYWRIGHT_MODULE_PATH may point to a shared/bundled Playwright installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createAiTeamsServer } from "../apps/server/dist/index.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const WebSocket = createRequire(new URL("../apps/server/package.json", import.meta.url))("ws");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-cleanup-browser-"));
const token = "isolated-cleanup-browser-test";
// This test must never use a configured remote database or real agent.
delete process.env.DATABASE_URL;
delete process.env.AI_TEAMS_ENCRYPTION_KEY;
const server = await createAiTeamsServer({ authToken: token, dbPath: path.join(outputDir, "test.db"), logger: false });
await server.app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${server.app.server.address().port}`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
let browser;
let recoveryAgent;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((auth) => localStorage.setItem("ai-teams.auth-token", auth), token);
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForLoadState("networkidle");
  console.log("Rendered buttons:", await page.getByRole("button").allTextContents());
  await page.getByRole("button", { name: "任务日志", exact: true }).click();
  const submit = async (prompt) => {
    const res = await fetch(`${base}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ prompt, atAgents: "queue" }) });
    assert.equal(res.status, 202);
    return (await res.json()).tasks[0].id;
  };
  const waitingId = await submit("browser-waiting-task");
  const cancelledId = await submit("browser-cancelled-task");
  const cancelled = await fetch(`${base}/api/tasks/${cancelledId}/cancel`, { method: "POST", headers, body: "{}" });
  assert.equal(cancelled.status, 200);
  await page.getByRole("button", { name: "等待中", exact: true }).click();
  await page.locator(".task-row").filter({ hasText: "browser-waiting-task" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".task-row").length === 1);
  assert.equal(await page.locator(".task-row").count(), 1);
  assert.equal(await page.locator(".task-row").filter({ hasText: "browser-cancelled-task" }).count(), 0);
  // Real-time refresh must preserve the selected queued filter.
  await submit("browser-second-waiting-task");
  await page.locator(".task-row").filter({ hasText: "browser-second-waiting-task" }).waitFor();
  assert.equal(await page.locator(".task-row").count(), 2);
  await page.getByRole("button", { name: "清空所有任务", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /不受当前筛选条件限制/);
  await page.getByRole("dialog").getByRole("button", { name: /取\s*消/ }).click();
  assert.equal((await fetch(`${base}/api/tasks/${waitingId}`, { headers })).status, 200);
  // Open a second console to verify broadcast clearing and stale HTTP response handling.
  const second = await context.newPage();
  await second.goto(base);
  await second.waitForLoadState("networkidle");
  await second.getByRole("button", { name: "任务日志", exact: true }).click();
  await second.locator(".task-row").first().waitFor();
  let release;
  const responseBarrier = new Promise((resolve) => { release = resolve; });
  let intercepted;
  const interceptedResponse = new Promise((resolve) => { intercepted = resolve; });
  await second.route("**/api/tasks?**", async (route) => {
    const oldResponse = await route.fetch();
    intercepted();
    await responseBarrier;
    await route.fulfill({ response: oldResponse });
  });
  await second.getByRole("button", { name: "等待中", exact: true }).click();
  await interceptedResponse;
  await page.getByRole("button", { name: "清空所有任务", exact: true }).click();
  await page.getByRole("button", { name: "确认清空所有任务", exact: true }).click();
  await page.getByText("暂无符合条件的任务。", { exact: true }).waitFor();
  await second.getByText("暂无符合条件的任务。", { exact: true }).waitFor();
  release();
  await second.waitForLoadState("networkidle");
  assert.equal(await second.locator(".task-row").count(), 0);
  assert.equal((await (await fetch(`${base}/api/tasks`, { headers })).json()).tasks.length, 0);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(outputDir, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outputDir, "mobile.png"), fullPage: true });
  assert.equal(await page.getByRole("button", { name: "清空所有任务", exact: true }).isVisible(), true);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "任务列表", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "等待中", exact: true }).isVisible(), true);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "任务列表", exact: true }).click();
  await page.getByText("暂无符合条件的任务。", { exact: true }).waitFor();
  // Short real-server recovery UI check. The simulated Agent never starts a CLI.
  const registration = await fetch(`${base}/api/agent-registry`, { method: "POST", headers, body: JSON.stringify({ employeeId: "recovery-ui", name: "Recovery UI" }) });
  assert.equal(registration.status, 201);
  const { agentToken } = await registration.json();
  recoveryAgent = new WebSocket(base.replace("http:", "ws:") + "/ws/agent");
  const receive = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { recoveryAgent.off("message", listener); reject(Error(`Missing ${type}`)); }, 5000);
    function listener(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type === type) { clearTimeout(timer); recoveryAgent.off("message", listener); resolve(message); }
    }
    recoveryAgent.on("message", listener);
  });
  await new Promise((resolve, reject) => { recoveryAgent.once("open", resolve); recoveryAgent.once("error", reject); });
  const registered = receive("agent.registered");
  recoveryAgent.send(JSON.stringify({ type: "agent.register", employeeId: "recovery-ui", name: "Recovery UI", machineId: "isolated", hostname: "isolated", labels: [], agentToken }));
  await registered;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.waitForLoadState("networkidle");
  const dispatched = receive("task.dispatch");
  await submit("recovery-ui-only-simulated-task");
  const task = await dispatched;
  recoveryAgent.send(JSON.stringify({ type: "task.started", taskId: task.taskId, attempt: task.attempt, pid: 1 }));
  recoveryAgent.send(JSON.stringify({ type: "task.failed", taskId: task.taskId, attempt: task.attempt, error: "429 simulated rate limit", recoverable: true }));
  await page.getByText("冷却中", { exact: true }).waitFor();
  await page.getByText(/下次探测：/).waitFor();
  await page.screenshot({ path: path.join(outputDir, "recovery-cooldown.png"), fullPage: true });
  assert.equal((await fetch(`${base}/api/agents/recovery-ui/resume-queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  await page.locator(".card-menu-btn").click();
  const probe = receive("task.dispatch");
  await page.getByRole("button", { name: "立即重试（单任务探测）", exact: true }).click();
  const probeTask = await probe;
  assert.equal(probeTask.taskId, task.taskId);
  assert.equal(probeTask.attempt, task.attempt + 1);
  await page.getByText("恢复探测", { exact: true }).waitFor();
  recoveryAgent.send(JSON.stringify({ type: "task.completed", taskId: task.taskId, attempt: probeTask.attempt, exitCode: 0 }));
  await page.getByText("恢复探测", { exact: true }).waitFor({ state: "hidden" });
  console.log("PASS: real recovery state, deadline/reason UI, authenticated manual single probe, successful recovery.");
  assert.deepEqual(errors, []);
  console.log("PASS: queued filtering, realtime filtering, confirmation cancel, filtered global cleanup, multi-page sync, stale response rejection, reload, mobile button, no browser errors.");
  console.log(`Screenshots: ${outputDir}`);
} finally {
  recoveryAgent?.close();
  await browser?.close();
  await server.close();
}
