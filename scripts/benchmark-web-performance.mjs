// Isolated synthetic frontend benchmark. No database or real Agent connections.
// PERF_WEB_DIST=/absolute/vite/output PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/benchmark-web-performance.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
if (process.env.PERF_ALLOW_LOAD !== '1') throw Error('Benchmark disabled by default: obtain user approval for the machine/time, then set PERF_ALLOW_LOAD=1. Headless GPU/renderer load can make the desktop unresponsive.');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { WebSocketServer } = createRequire(new URL('../apps/server/package.json', import.meta.url))('ws');
const dist = process.env.PERF_WEB_DIST;
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) throw Error('Set PERF_WEB_DIST to an isolated production build');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-teams-perf-'));
let fixture;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({tasks:fixture.tasks, total:fixture.tasks.length, schedules:[], missions:[], agents:[]})); return; }
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = relative.startsWith('/assets/') ? path.join(dist, relative) : path.join(dist, 'index.html');
  if (!file.startsWith(dist + '/') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
const wss = new WebSocketServer({server});
wss.on('connection', ws => ws.send(JSON.stringify({type:'snapshot', snapshot:fixture})));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true});
const browserCDP = await browser.newBrowserCDPSession();
const processMetrics = async () => { try { return (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo; } catch { return []; } };
const results = [];
let activeTimer;
let interrupted = false;
const stop = () => { interrupted = true; clearInterval(activeTimer); void browser.close(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const now = new Date().toISOString();
function makeFixture(history, warm) {
  const employees = Array.from({length:6}, (_, i) => ({id:`e${i}`, name:`Agent ${i+1}`, machineId:`m${i}`, hostname:'synthetic', labels:[], status:'online', mainTaskId:`t${i}`, mainTaskPrompt:'Synthetic review', queueTaskId:null, queueTaskPrompt:null, lastSeenAt:now, consecutiveQueueFailures:0, weight:1}));
  const tasks = Array.from({length:6+history}, (_, i) => ({id:`t${i}`, leaderCommandId:`l${i}`, employeeId:`e${i%6}`, sessionId:null, targetMode:'direct', prompt:`Synthetic task ${i}`, workspace:null, timeoutSec:3600, cliConfig:null, priority:0, requiredLabels:null, status:i<6?'running':'completed', retryCount:0, attempt:1, createdAt:now, startedAt:now, finishedAt:i<6?null:now, exitCode:i<6?null:0, summary:i<6?null:('## Review result\n\nVerified synthetic example.\n\n- One item\n- Another item\n\n```js\nconst valid = true;\n```\n').repeat(3), error:null}));
  const logs = Object.fromEntries(employees.map((e,i)=>[`t${i}`, Array.from({length:warm?200:0},(_,n)=>({taskId:`t${i}`,employeeId:e.id,stream:'stdout',seq:n,content:`line ${n}: ${'synthetic output '.repeat(8)}\n`,createdAt:now}))]));
  return {employees,tasks,logs};
}
try {
  for (let repeat = 1; repeat <= Number(process.env.PERF_REPEATS || 1); repeat++) for (const scenario of [
    {name:'cold-idle',history:0,warm:false,rate:0},
    {name:'cold-stream',history:0,warm:false,rate:60},
    {name:'warm-idle',history:60,warm:true,rate:0},
    {name:'warm-idle-no-animation',history:60,warm:true,rate:0,noAnimation:true},
    {name:'warm-no-history-stream',history:0,warm:true,rate:60},
    {name:'warm-stream',history:60,warm:true,rate:60},
    {name:'warm-stream-no-animation',history:60,warm:true,rate:60,noAnimation:true},
    {name:'warm-stream-tasks-page',history:60,warm:true,rate:60,tasksPage:true},
  ]) {
    if(interrupted) break;
    if(process.env.PERF_CASES && !process.env.PERF_CASES.split(',').includes(scenario.name)) continue;
    fixture = makeFixture(scenario.history,scenario.warm);
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => {
      localStorage.setItem('ai-teams.auth-token','synthetic');
      window.bench = {commits:0,long:[],htmlWrites:0,htmlChars:0};
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber:true,inject:()=>1,onCommitFiberRoot:()=>window.bench.commits++,onCommitFiberUnmount:()=>{}};
      new PerformanceObserver(list => window.bench.long.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask'});
      const original = Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
      Object.defineProperty(Element.prototype,'innerHTML',{...original,set(value){if(this.classList.contains('log-window')){window.bench.htmlWrites++;window.bench.htmlChars+=value.length;}return original.set.call(this,value);}});
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(()=>document.body.innerText.includes('Agent 1'));
    if (scenario.tasksPage) await page.getByRole('button',{name:'任务日志',exact:true}).click();
    if(scenario.noAnimation) await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
    await page.waitForTimeout(800);
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    const metrics = async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
    const before = await metrics();
    const processesBefore = await processMetrics();
    if(process.env.PERF_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    await page.evaluate(()=>window.bench={commits:0,long:[],htmlWrites:0,htmlChars:0});
    if(process.env.PERF_INPUT) await page.evaluate(()=>{
      window.inputLatencies=[];
      document.addEventListener('input',()=>{const started=performance.now();requestAnimationFrame(()=>window.inputLatencies.push(performance.now()-started));},true);
    });
    let sent=0;
    const expected = Array(6).fill('');
    const start=performance.now();
    const timer = scenario.rate ? setInterval(()=>{
      const i=sent%6; const seq=200+Math.floor(sent/6);
      // Same 133-character payload size as the baseline, now with unique sequence markers.
      const chunk={taskId:`t${i}`,employeeId:`e${i}`,stream:'stdout',seq,content:(String(seq).padStart(8,'0')+' '+ 'new incremental synthetic output '.repeat(4)).slice(0,132)+'\n',createdAt:new Date().toISOString(),delta:true};
      expected[i] = (expected[i] + chunk.content).slice(-60000);
      for(const ws of wss.clients) if(ws.readyState===1)ws.send(JSON.stringify({type:'task.output',chunk}));
      sent++;
    },1000/scenario.rate):null;
    activeTimer = timer;
    const samples = [];
    const duration = Number(process.env.PERF_DURATION_MS || 6000);
    while (performance.now() - start < duration) {
      await new Promise(resolve=>setTimeout(resolve,Math.min(10000, duration - (performance.now() - start))));
      if (duration >= 60000) {
        if(process.env.PERF_INPUT && !scenario.tasksPage) {
          const input=page.locator('.command-panel textarea').first();
          await input.fill(''); await input.pressSequentially('input check',{delay:20});
        }
        let gcHeapMB;
        if(process.env.PERF_GC_SAMPLES) { await cdp.send('HeapProfiler.collectGarbage'); gcHeapMB=(await metrics()).JSHeapUsedSize/1048576; }
        const sample = await metrics();
        const point={second:(performance.now()-start)/1000,heapMB:sample.JSHeapUsedSize/1048576,gcHeapMB,elements:await page.locator('*').count()};
        samples.push(point);
        if(process.env.PERF_GC_SAMPLES) console.log('SAMPLE',JSON.stringify(point));
      }
    }
    clearInterval(timer);
    const after=await metrics(); const elapsed=(performance.now()-start)/1000;
    const processesAfter = await processMetrics();
    if(process.env.PERF_PROFILE) fs.writeFileSync(path.join(output,`${scenario.name}.cpuprofile`),JSON.stringify((await cdp.send('Profiler.stop')).profile));
    const stats=await page.evaluate(()=>({...window.bench,elements:document.querySelectorAll('*').length,terminals:document.querySelectorAll('.log-window').length}));
    const delta={};for(const key of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'])delta[key]=after[key]-before[key];
    await page.waitForTimeout(250);
    if(process.env.PERF_VERIFY && scenario.rate && !scenario.tasksPage) {
      const texts = await page.locator('.employee-card .log-window').allTextContents();
      assert.equal(texts.length,6);
      texts.forEach((value,i)=>assert.ok(value.endsWith(expected[i]),`retained log mismatch: Agent ${i}`));
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const heapAfterGCMB = (await metrics()).JSHeapUsedSize/1048576;
    const result={...scenario,repeat,elapsed,sent,mainThreadBusyPercent:100*delta.TaskDuration/elapsed,delta,heapMB:after.JSHeapUsedSize/1048576,heapAfterGCMB,samples,...stats,errors};
    result.processCPU = processesAfter.map(p => { const previous=processesBefore.find(x=>x.id===p.id);return {type:p.type,id:p.id,cpuSeconds:previous?p.cpuTime-previous.cpuTime:null,averageOneCorePercent:previous?100*(p.cpuTime-previous.cpuTime)/elapsed:null}; });
    if(process.env.PERF_INPUT) {
      const latencies=(await page.evaluate(()=>window.inputLatencies)).sort((a,b)=>a-b);
      result.inputSamples=latencies.length; result.inputToRafP95=latencies[Math.floor(latencies.length*.95)];
    }
    results.push(result); console.log(JSON.stringify(result));
    if(process.env.PERF_INTERACTION && scenario.name==='warm-stream') {
      const terminal = page.locator('.employee-card .log-window').first();
      const follow = page.locator('.employee-card .terminal-follow').first();
      const emit = (seq, content) => { for(const ws of wss.clients) if(ws.readyState===1) ws.send(JSON.stringify({type:'task.output',chunk:{taskId:'t0',employeeId:'e0',stream:'stdout',seq,content,createdAt:now}})); };
      await follow.click(); const paused = await terminal.textContent();
      emit(100000,'\nPAUSED-OUTPUT-ONE\n'); await page.waitForTimeout(200);
      assert.equal(await terminal.textContent(),paused);
      await page.getByRole('button',{name:'有新输出 · 回到底部',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.employee-card .log-window').textContent.includes('PAUSED-OUTPUT-ONE'));
      const beforeDuplicate = await terminal.textContent(); emit(100000,'\nPAUSED-OUTPUT-ONE\n'); await page.waitForTimeout(200);
      assert.equal(await terminal.textContent(),beforeDuplicate);
      await terminal.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
      emit(100001,'\nSCROLLED-OUTPUT-TWO\n'); await page.waitForTimeout(200);
      assert.equal(await terminal.textContent(),beforeDuplicate);
      await page.getByRole('button',{name:'有新输出 · 回到底部',exact:true}).click();
      const latencies = [];
      await page.evaluate(()=>{
        window.inputLatencies=[];
        document.addEventListener('input',()=>{const start=performance.now();requestAnimationFrame(()=>window.inputLatencies.push(performance.now()-start));},true);
      });
      let seq=110000;
      const interactionStream=setInterval(()=>emit(seq++,`\nINPUT-STREAM-${seq}\n`),16);
      try {
        const input=page.locator('.command-panel textarea').first(); await input.click();
        await input.pressSequentially('Synthetic input response verification 12345',{delay:50});
        await page.waitForTimeout(200);
        latencies.push(...await page.evaluate(()=>window.inputLatencies));
      } finally {clearInterval(interactionStream);}
      await page.waitForTimeout(250);
      const beforeReconnect = await terminal.textContent();
      for(const ws of wss.clients) ws.close();
      await page.waitForTimeout(3500);
      assert.equal(await terminal.textContent(),beforeReconnect,'reconnect replay duplicated retained logs');
      latencies.sort((a,b)=>a-b);
      result.interactions={inputSamples:latencies.length,inputToRafP95:latencies[Math.floor(latencies.length*.95)],pausedStable:true,scrollStable:true,replayDeduplicated:true,reconnectStable:true};
      await page.setViewportSize({width:390,height:844});
      await page.locator('.mobile-agent-pill').first().click();
      await page.locator('.mobile-terminal-overlay .log-window').waitFor();
      assert.ok((await page.locator('.mobile-terminal-overlay .log-window').textContent()).includes('INPUT-STREAM'));
      await page.screenshot({path:path.join(output,'mobile-terminal.png')});
      await page.locator('.mobile-terminal-header button').click();
      await page.setViewportSize({width:1440,height:1000});
      console.log('INTERACTIONS',JSON.stringify(result.interactions));
    }
    if(scenario.name==='warm-stream') {
      await page.screenshot({path:path.join(output,'warm-stream.png')});
      await page.setViewportSize({width:390,height:844});
      await page.waitForTimeout(300);
      await page.screenshot({path:path.join(output,'mobile.png')});
    }
    if(process.env.PERF_INTERACTION && scenario.name==='warm-stream') {
      await page.setViewportSize({width:1440,height:1000});
      await page.locator('.employee-card .log-window').first().waitFor();
      const send = message => { for(const ws of wss.clients) if(ws.readyState===1) ws.send(JSON.stringify(message)); };
      send({type:'task.upsert',task:{...fixture.tasks[0],attempt:2}});
      send({type:'task.output',chunk:{taskId:'t0',employeeId:'e0',stream:'stdout',seq:0,content:'\nRETRY-SEQUENCE-ZERO\n',createdAt:now}});
      await page.waitForFunction(()=>document.querySelector('.employee-card .log-window')?.textContent.endsWith('RETRY-SEQUENCE-ZERO\n'));
      const generation='synthetic-clear';
      await page.locator('.employee-card .terminal-follow').first().click();
      fixture={...fixture,tasks:[],logs:{},taskDataGeneration:generation,employees:fixture.employees.map(e=>({...e,mainTaskId:null,mainTaskPrompt:null}))};
      send({type:'tasks.cleared',snapshot:fixture});
      send({type:'task.output',chunk:{taskId:'t0',employeeId:'e0',stream:'stdout',seq:1,content:'LATE-DELETED-OUTPUT',createdAt:now}});
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.employee-card .log-window').first().textContent(),'等待任务输出…');
      for(const ws of wss.clients) ws.close(); await page.waitForTimeout(3500);
      assert.equal(await page.locator('.employee-card .log-window').first().textContent(),'等待任务输出…');
      result.interactions.retrySequenceReset=true; result.interactions.clearLateOutputRejected=true; result.interactions.clearReconnectStable=true;
      console.log('LIFECYCLE',JSON.stringify(result.interactions));
    }
    await context.close();
  }
} finally { clearInterval(activeTimer); await browser.close(); for(const ws of wss.clients) ws.terminate(); await new Promise(r=>wss.close(r)); await new Promise(r=>server.close(r)); fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(`Results: ${output}`); }
