import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { stopTaskProcess } from "./process-tree.js";

it.skipIf(process.platform === "win32")("kills a TERM-resistant CLI and its inherited-stdio descendant before confirming teardown", async () => {
  // Own process group, no CLI/model/network/user workspace. Both children have a safety deadline.
  const child = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const tool=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),10000); console.log('ready');"],{stdio:['ignore',1,2]});
    console.log('pid:'+tool.pid); setTimeout(()=>process.exit(0),10000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data.toString(); });
  try {
    const deadline = Date.now() + 2000;
    while (!output.includes("ready") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(output).toContain("ready");
    const descendant = Number(output.match(/pid:(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    const close = once(child, "close");
    await stopTaskProcess(child, true, 50);
    await close;
    expect(() => process.kill(-child.pid!, 0)).toThrow();
    expect(() => process.kill(descendant, 0)).toThrow();
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
}, 8000);
