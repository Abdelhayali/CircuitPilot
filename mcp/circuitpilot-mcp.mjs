#!/usr/bin/env node
// CircuitPilot MCP server + REST API.
//
// Exposes every CircuitPilot design tool (parts database, schematic editing, ERC, custom parts,
// project knowledge, PCB generation, Gerber export) to Claude Code and other MCP clients over stdio,
// or to any tool over HTTP with --http.
//
//   claude mcp add circuitpilot -- node /path/to/mcp/circuitpilot-mcp.mjs
//   node mcp/circuitpilot-mcp.mjs --http 5174          (REST: GET /tools, POST /tools/<name>)
//
// Environment: CP_URL (default http://localhost:5173), CP_PASSWORD (else read from access-password.txt),
//              CP_PROJECT (project id or name to open at start), CP_APP_EXE (the Windows app, started when nothing
//              answers at CP_URL), CP_DATA_DIR (projects folder for a server.py started from here; default: the
//              Windows app's %LOCALAPPDATA%\CircuitPilot).
// Every tool takes `project` (id or exact name); the current project is remembered in DATA_DIR/mcp-state.json.
// Long tools (routing, placement, export) run as background jobs: they answer within ~40 s, else job_status.
// It talks to the running server.py, so projects changed here appear live in the browser.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { loadEngine } from './engine-vm.mjs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.CP_URL || 'http://localhost:5173').replace(/\/+$/, '');
let PASSWORD = process.env.CP_PASSWORD || '';
if (!PASSWORD) { try { PASSWORD = fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { } }
// log to stderr and to a file (the MCP client may not keep stderr): %LOCALAPPDATA%/CircuitPilot/mcp.log or ~/.circuitpilot/mcp.log
const LOG_FILE = path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CircuitPilot') : path.join(os.homedir(), '.circuitpilot'), 'mcp.log');
const log = (...a) => {
  console.error('[circuitpilot]', ...a);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if ((fs.statSync(LOG_FILE, { throwIfNoEntry: false }) || { size: 0 }).size > 4e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' [' + process.pid + '] ' + a.map(x => x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
  } catch { }
};
// a stray error in one job must not take the server (and every other running job) down
process.on('uncaughtException', e => log('uncaught exception (server keeps running):', e));
process.on('unhandledRejection', e => log('unhandled rejection (server keeps running):', e instanceof Error ? e : String(e)));

// ---------- load the shared engine (same code as the browser app) ----------
const ctx = loadEngine(ROOT, log);
const { Engine, Model, Pcb, Cnc } = ctx;
// where the app keeps its projects: the Windows app's data folder (also used when this server starts server.py itself),
// and where this MCP server remembers the current project between restarts
const DATA_DIR = process.env.CP_DATA_DIR || (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CircuitPilot') : path.join(os.homedir(), '.circuitpilot'));
const STATE_FILE = path.join(DATA_DIR, 'mcp-state.json');
const headers = PASSWORD ? { authorization: 'Bearer ' + PASSWORD } : {};
let myLib = [];
Object.assign(Engine.env, {
  base: BASE, headers, fetch,
  myLib: () => myLib,
  savePart: async def => { await api('PUT', '/api/library/' + encodeURIComponent(def.key), def); },
  ui: () => { },
  // screenshots (view_design): drawn by the CircuitPilot tab open in the browser, relayed by server.py
  render: args => renderSerial(currentId, args),   // view_design
  readGerberZip: async f => readGerberZip(f),
});
// the files of a zip (stored or deflated), from its central directory
function unzip(buf) {
  const out = {}; let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  let q = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(q + 10), csize = buf.readUInt32LE(q + 20), nl = buf.readUInt16LE(q + 28), xl = buf.readUInt16LE(q + 30), cl = buf.readUInt16LE(q + 32), off = buf.readUInt32LE(q + 42), name = buf.toString('utf8', q + 46, q + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    if (!name.endsWith('/')) out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    q += 46 + nl + xl + cl;
  }
  return out;
}
function readGerberZip(f) {
  const buf = fs.readFileSync(path.resolve(f)), files = unzip(buf), names = Object.keys(files);
  // the outline: .GKO / .GM1 / Edge_Cuts / outline; its coordinates in the file's own format (FS, MO)
  const ol = names.find(n => /\.(gko|gm1|gml)$|edge[_.-]?cuts|outline|board.?outline/i.test(n));
  let size = [0, 0];
  if (ol) {
    const t = files[ol].toString('latin1'), fs_ = t.match(/%FS[LT]?A?X(\d)(\d)Y(\d)(\d)\*%/), inch = /%MOIN\*%/.test(t), dec = fs_ ? +fs_[2] : 6, k = (inch ? 25.4 : 1) / 10 ** dec;
    const xs = [], ys = []; let x = 0, y = 0;
    for (const m of t.matchAll(/(?:X(-?\d+))?(?:Y(-?\d+))?(?:I-?\d+)?(?:J-?\d+)?D0?[123]\*/g)) { if (m[1] != null) x = +m[1] * k; if (m[2] != null) y = +m[2] * k; xs.push(x); ys.push(y); }
    if (xs.length) size = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  }
  const layers = Math.max(1, names.filter(n => /\.(gtl|gbl|g\d+l?|gl\d)$|[-_.](f|b|in\d+)[_.]cu\b/i.test(n)).length);
  return { data: new Uint8Array(buf), size: size.map(v => +v.toFixed(2)), layers: layers > 2 ? layers : 2, files: names };
}

// ---------- make sure the CircuitPilot app is running (Claude Desktop / Claude Code only start this MCP server) ----------
async function ping() {
  try { const r = await fetch(BASE + '/api/version', { headers, signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}
let appReady = null;
function ensureApp() {
  if (!appReady) appReady = (async () => {
    if (await ping()) return true;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) return false;   // a remote app cannot be started from here
    const port = new URL(BASE).port || '5173';
    try {
      if (process.env.CP_APP_EXE) {   // the Windows app: CircuitPilot.exe serves the app (and opens its window when the user wants it)
        spawn(process.env.CP_APP_EXE, ['--server-only', '--port', port], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); log('started CircuitPilot.exe');
      } else {
        const args = ['server.py', port, '--allow-ports', '8080'];
        if (fs.existsSync(path.join(ROOT, 'access-password.txt'))) args.push('--password-file', 'access-password.txt');
        fs.mkdirSync(DATA_DIR, { recursive: true });
        spawn(process.env.CP_PYTHON || 'python', args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { CP_DATA_DIR: DATA_DIR }) }).unref(); log('started server.py, projects in ' + DATA_DIR);
      }
    } catch (e) { log('could not start CircuitPilot:', e.message); return false; }
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); if (await ping()) return true; }
    return false;
  })().then(ok => { if (!ok) appReady = null; return ok; });
  return appReady;
}
// Show the user the project being worked on: open the app in the browser once if no tab is connected,
// and ask open tabs to switch to this project (they follow Claude).
let browserOpened = false;
function openBrowser(url) {
  browserOpened = true;
  const [cmd, args] = process.env.CP_APP_EXE ? [process.env.CP_APP_EXE, ['--open', url]]   // the Windows app's own window
    : process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { }
}
async function showProject(id) {
  if (!id) return;
  try { await api('POST', '/api/render/focus', { project: id }); } catch { }
  try { const t = await api('GET', '/api/render/tabs'); if (!t.tabs && !browserOpened) openBrowser(BASE + '/?project=' + encodeURIComponent(id)); } catch { }
}

// one drawing at a time through the app window: concurrent requests (two exports, an export and a view_design) queue up
let renderChain = Promise.resolve();
function renderSerial(pid, args) {
  const run = async () => { await ensureRenderTab(pid); const r = await api('POST', '/api/render/request', { project: pid, args }); touchHeadless(); return r; };
  const p = renderChain.then(run, run); renderChain = p.catch(() => { }); return p;
}
// ---------- drawing without a window: a headless Edge / Chrome tab renders screenshots and PDFs ----------
// Used only when no CircuitPilot tab shows the project; closed again after 10 idle minutes.
let headless = null, headlessTimer = null;
function browserPath() {
  const env = process.env, c = [];
  if (process.platform === 'win32') for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  else c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  return process.env.CP_BROWSER || c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
function touchHeadless() {
  if (!headless) return;
  clearTimeout(headlessTimer); headlessTimer = setTimeout(stopHeadless, 10 * 60e3); headlessTimer.unref && headlessTimer.unref();
}
function stopHeadless() { if (headless) { try { headless.kill(); } catch { } headless = null; log('headless browser closed'); } }
process.on('exit', stopHeadless);
async function tabProjects() { try { const t = await api('GET', '/api/render/tabs'); return { n: t.tabs || 0, projects: t.projects || [] }; } catch { return { n: 0, projects: [] }; } }
async function ensureRenderTab(id, waitS = 25) {
  if (!id) return false;
  let t = await tabProjects();
  if (t.projects.includes(id)) return true;
  if (t.n) await showProject(id);   // an open window switches to the project
  else if (!headless) {
    const exe = browserPath();
    let url = BASE + '/?project=' + encodeURIComponent(id);
    if (PASSWORD) {   // the app wants a login: a one-time link sets the cookie in the headless browser
      const tk = await api('POST', '/api/login-ticket').catch(() => ({}));
      if (tk.ticket) url = BASE + '/login-ticket?t=' + encodeURIComponent(tk.ticket) + '&next=' + encodeURIComponent('/?project=' + id);
    }
    if (exe) {
      const prof = path.join(DATA_DIR, 'headless-browser'); fs.mkdirSync(prof, { recursive: true });
      headless = spawn(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-port=0', '--disable-extensions', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--window-size=1600,1000', '--user-data-dir=' + prof, url], { stdio: 'ignore', windowsHide: true });
      headless.on('exit', () => { headless = null; });
      log('headless browser started for drawing: ' + exe);
      touchHeadless();
    }
  } else if (headless) await showProject(id);
  for (let i = 0; i < waitS * 2; i++) { await new Promise(r => setTimeout(r, 500)); t = await tabProjects(); if (t.projects.includes(id)) return true; if (i === 10 && t.n) await showProject(id); }
  return false;
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({}, headers, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { j = { error: r.status === 401 ? 'Unauthorized — set CP_PASSWORD to the app password' : txt.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- project session ----------
// The current project is remembered on disk (per app address), so a restart of this server (e.g. after a timeout)
// keeps working on the same project. There is no silent fallback: without a current project the tools ask for one.
let currentId = null;
const stateKey = () => BASE;
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; } }
function setCurrent(id) {
  currentId = id;
  try { const st = loadState(); st[stateKey()] = { project: id, at: new Date().toISOString() }; fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1)); } catch (e) { log('could not save the current project:', e.message); }
}
// id, exact name, or a unique part of a name — never a guess
async function resolveProject(ref) {
  const ps = await api('GET', '/api/projects'), r = String(ref == null ? '' : ref).trim(), lo = r.toLowerCase();
  if (!r) return null;
  const byId = ps.find(p => p.id === r); if (byId) return byId;
  const exact = ps.filter(p => (p.name || '').toLowerCase() === lo);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`${exact.length} projects are called "${r}" — use the id: ${exact.map(p => `${p.id} (${p.parts} parts, ${new Date(p.updated * 1000).toISOString().slice(0, 16)})`).join(', ')}`);
  const part = ps.filter(p => (p.name || '').toLowerCase().includes(lo));
  if (part.length === 1) return part[0];
  if (part.length > 1) throw new Error(`"${r}" matches ${part.length} projects — use the id or the full name: ${part.map(p => `${p.name} (${p.id})`).join(', ')}`);
  return null;
}
const projectExists = async id => { try { await api('GET', '/api/projects/' + id + '/meta'); return true; } catch { return false; } };
async function ensureProject() {
  if (currentId && await projectExists(currentId)) return currentId;
  const saved = (loadState()[stateKey()] || {}).project;
  if (saved && saved !== currentId && await projectExists(saved)) { currentId = saved; log('continuing with project ' + saved); return currentId; }
  currentId = null;
  if (process.env.CP_PROJECT) { const p = await resolveProject(process.env.CP_PROJECT); if (p) { setCurrent(p.id); await showProject(p.id); return p.id; } }
  const ps = await api('GET', '/api/projects');
  if (!ps.length) { const d = Model.blank(); d.name = 'Untitled'; const id = (await api('PUT', '/api/projects/', d)).id; setCurrent(id); await showProject(id); return id; }
  throw new Error('No project is open. Pass project (id or exact name) to this tool, or call open_project / create_project first. Recent projects: ' +
    ps.slice(0, 8).map(p => `${p.name} (${p.id}, ${p.parts} parts)`).join('; '));
}
// tools that change a project wait for a running job on it (its result would overwrite theirs)
function assertIdle(id, name) {
  const j = [...jobs.values()].find(q => q.project === id && q.status === 'running');
  if (j) throw new Error(`Project is busy: job ${j.id} (${j.tool}) is running for ${Math.round((Date.now() - j.started) / 1000)} s. Call job_status {job_id: "${j.id}"} and wait for it before ${name}.`);
}
async function withProject(fn, write = true, name = '') {
  const id = await ensureProject();
  if (write) assertIdle(id, name || 'changing the project');
  Model.load(await api('GET', '/api/projects/' + id));
  try { myLib = await api('GET', '/api/library'); } catch { }
  const before = Model.snapshot();
  const out = await fn();
  if (write && Model.snapshot() !== before) await api('PUT', '/api/projects/' + id, JSON.parse(Model.snapshot()));
  return out;
}

// ---------- background jobs: long tools run in a worker thread on a copy of the project ----------
// (also the tools that can take more than a few seconds on a big board: on the main thread they stall every other call)
const LONG = new Set(['generate_pcb', 'route_pcb', 'optimize_pcb', 'auto_layout', 'place_footprints', 'update_pcb_from_schematic', 'export_project', 'reroute',
  'place_in_free_area', 'stitch_pour', 'connect_pads_to_pour', 'apply_pour_template', 'arrange_silk_labels']);
const isLong = (name, input) => LONG.has(name) || (name === 'batch' && Array.isArray(input.calls) && input.calls.some(c => c && LONG.has(c.tool || c.name)));
const JOB_WAIT = +(process.env.CP_JOB_WAIT || 40000);   // answer directly when done within this time, else hand out a job id
const jobs = new Map(); let jobSeq = 0;
// At most CP_MAX_JOBS workers at once (default 2); more jobs wait their turn instead of competing for memory. Each
// worker has its own heap limit, so a job that runs out of memory fails alone. The handle's terminate() also takes a
// job out of the queue.
const MAX_WORKERS = Math.max(1, +(process.env.CP_MAX_JOBS || 2)), WORKER_MB = Math.max(512, +(process.env.CP_JOB_HEAP_MB || 3072));
let activeWorkers = 0; const waiting = [];
function workerRun(msg, label = msg.name || msg.kind) {
  const h = { w: null, cancelled: false, queued: true, terminate() { h.cancelled = true; const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); if (h.w) return h.w.terminate(); } };
  let go;
  h.p = new Promise((res, rej) => {
    go = () => {
      if (h.cancelled) return rej(new Error('cancelled'));
      activeWorkers++; h.queued = false;
      let done = false;
      const end = (ok, v) => { if (done) return; done = true; activeWorkers--; const n = waiting.shift(); if (n) n(); ok ? res(v) : rej(v); };
      let w;
      try { w = h.w = new Worker(new URL('./job-worker.mjs', import.meta.url), { workerData: { root: ROOT }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MB } }); }
      catch (e) { return end(false, e); }
      w.on('error', e => { log(`job ${label}: worker error`, e); end(false, e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('the job ran out of memory (try again when fewer jobs run, or raise CP_JOB_HEAP_MB)') : e); });
      w.once('message', m => { w.terminate().catch(() => { }); m.ok ? end(true, m) : end(false, new Error(m.error)); });
      w.once('exit', c => end(false, new Error(h.cancelled ? 'cancelled' : c ? 'worker stopped (' + c + ')' : 'worker stopped')));
      w.postMessage(msg);
    };
    if (activeWorkers < MAX_WORKERS) go(); else { waiting.push(go); log(`job ${label} queued (${activeWorkers} running)`); }
  });
  h.p.catch(() => { });
  return { w: h, p: h.p };
}
async function startJob(tool, input) {
  const id = await ensureProject(); assertIdle(id, tool);
  const project = await api('GET', '/api/projects/' + id), meta = await api('GET', '/api/projects/' + id + '/meta');
  try { myLib = await api('GET', '/api/library'); } catch { }
  const job = { id: 'job' + (++jobSeq) + '-' + Date.now().toString(36).slice(-4), tool, project: id, name: project.name, started: Date.now(), status: 'running' };
  if (tool === 'export_project') job.promise = exportJob(job, project, input);
  else {
    const r = workerRun({ kind: 'tool', name: tool, input, project, myLib, base: BASE, headers });
    job.worker = r.w;
    job.promise = r.p.then(async m => {
      const now = await api('GET', '/api/projects/' + id + '/meta').catch(() => null);
      const changed = now && now.updated > meta.updated + 0.001;   // edited meanwhile (in the app)
      if (m.project !== JSON.stringify(project)) await api('PUT', '/api/projects/' + id, JSON.parse(m.project));
      return changed && m.result && typeof m.result === 'object' ? Object.assign({ warning: 'The project was edited while this job ran; those edits were replaced by the job result' }, m.result) : m.result;
    });
  }
  job.promise.then(r => { job.status = 'done'; job.result = r; job.ended = Date.now(); }, e => { if (job.status === 'running') { job.status = 'failed'; job.error = e.message; job.ended = Date.now(); log(`job ${job.id} ${tool} failed:`, e.message); } });
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.status !== 'running' && Date.now() - (j.ended || j.started) > 3600e3) jobs.delete(k);   // forget old jobs after an hour
  return job;
}
const jobView = j => ({ job_id: j.id, tool: j.tool, project: j.project, project_name: j.name, status: j.status === 'running' && j.worker && j.worker.queued ? 'queued' : j.status, seconds: Math.round(((j.ended || Date.now()) - j.started) / 1000) });
async function awaitJob(j, ms) {
  await Promise.race([j.promise.catch(() => { }), new Promise(r => setTimeout(r, ms))]);
  if (j.status === 'done') return j.result;
  if (j.status === 'failed') throw new Error(`${j.tool} failed: ${j.error}`);
  if (j.status === 'cancelled') return Object.assign(jobView(j), { note: 'cancelled — nothing was saved' });
  return Object.assign(jobView(j), { note: `${j.worker && j.worker.queued ? 'Waiting for another job to finish, then it starts by itself.' : 'Still working.'} Call job_status {job_id: "${j.id}"} — it waits up to 55 s for the result. Other projects can be edited meanwhile; this one is locked until the job ends.` });
}
// export: files from the worker, PDFs + images from the app window, all into one folder per project
async function exportJob(job, project, input) {
  const all = ['project', 'gerbers', 'jlcpcb', 'bom', 'netlist', 'enclosure', 'easyeda', 'pdf', 'images', 'order_readme'];
  let inc = Array.isArray(input.include) && input.include.length ? input.include.slice() : all;
  if (inc.includes('flat') && !inc.includes('enclosure')) inc.push('enclosure');   // the flat parts come with the enclosure files
  const { p, w } = workerRun({ kind: 'export', include: inc, project, myLib, base: BASE, headers }); job.worker = w;
  const { result: X } = await p, written = [], skipped = X.skipped.slice();
  // dated: a snapshot folder <project>-<YYYY-MM-DD> (several exports a day: -2, -3 …)
  const root = path.resolve(String(input.out_dir || path.join(os.homedir(), 'Documents', 'CircuitPilot exports')));
  let dir = path.join(root, X.base);
  if (input.dated) { const d0 = path.join(root, `${X.base}-${new Date().toISOString().slice(0, 10)}`); dir = d0; for (let k = 2; fs.existsSync(dir); k++) dir = `${d0}-${k}`; }
  if (inc.includes('flat') && !inc.includes('enclosure_all')) for (const k of Object.keys(X.files)) if (/^enclosure\/(jlc3dp\/|[^/]+\.(scad|js)$)/.test(k) && !input.include.includes('enclosure')) delete X.files[k];
  const put = (rel, data) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data instanceof Uint8Array ? Buffer.from(data) : data); written.push(rel.replace(/\\/g, '/')); };
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, d] of Object.entries(X.files)) put(rel, d);
  const shots = [];
  if (inc.includes('pdf')) { if (X.hasPcb) shots.push([{ view: 'pdf_pcb' }, X.base + '-pcb-drawing.pdf']); shots.push([{ view: 'pdf_doc' }, X.base + '-datasheet.pdf']); }
  if (inc.includes('images') && X.parts) {
    for (let i = 1; i <= X.sheets; i++) shots.push([{ view: 'schematic', sheet: i, full: true }, 'images/' + (X.sheets > 1 ? `schematic-sheet${i}.png` : 'schematic.png')]);
    if (X.hasPcb) for (const [a, n] of [[{ view: 'pcb' }, 'pcb-2d.png'], [{ view: 'pcb_3d', side: 'iso' }, 'pcb-3d.png'], [{ view: 'pcb_3d', side: 'top' }, 'pcb-3d-top.png'], [{ view: 'pcb_3d', side: 'bottom' }, 'pcb-3d-bottom.png'], [{ view: 'enclosure' }, 'enclosure.png']])
      shots.push([Object.assign({ full: true }, a), 'images/' + n]);
  }
  if (shots.length) {
    const tab = await ensureRenderTab(job.project, 30);
    if (!tab) skipped.push('PDFs and images: no CircuitPilot window could show this project (open ' + BASE + ' and run export_project again)');
    else for (const [args, rel] of shots) {
      if (job.status !== 'running') break;
      // a busy browser (routing, another export) answers late: wait and try again instead of skipping the file
      let last = null;
      for (let k = 0; k < 5 && job.status === 'running'; k++) {
        try { const r = await renderSerial(job.project, args); if (!r || !r.data) throw new Error('nothing drawn'); put(rel, new Uint8Array(Buffer.from(r.data, 'base64'))); last = null; break; }
        catch (e) { last = e; if (!/did not answer|in time|504|timed? ?out|busy/i.test(e.message)) break; log(`export ${X.base}: ${rel} — browser busy, retry ${k + 1}`); await new Promise(r => setTimeout(r, 10000 * (k + 1))); }
      }
      if (last) skipped.push(rel + ': ' + last.message);
    }
  }
  // one page that says what goes where (F16)
  if (inc.includes('order_readme')) {
    const has = re => written.filter(f => re.test(f)), lines = [`# ${X.name} — what to order`, '', `Exported by CircuitPilot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`, ''];
    if (has(/gerbers\.zip$/).length) lines.push('## PCB — JLCPCB (jlcpcb.com)', `- Upload \`${has(/gerbers\.zip$/)[0]}\`.`, ...(has(/^jlcpcb\//).length ? [`- Assembly: BOM and pick-and-place: ${has(/^jlcpcb\//).map(f => '`' + f + '`').join(', ')}.`] : []), X.drc ? `- DRC: ${typeof X.drc === 'string' ? X.drc : JSON.stringify(X.drc)}` : '', '');
    if (has(/jlc3dp\//).length) lines.push('## Printed enclosure parts — JLC3DP (jlc3dp.com)', ...has(/jlc3dp\/.*\.stl$/).map(f => `- \`${f}\` (STEP next to it)`), '- Settings: `enclosure/jlc3dp/README-JLC3DP.txt`.', '');
    if (has(/jlccnc\//).length) lines.push('## Sheet-metal parts — JLCCNC (jlccnc.com)', ...has(/jlccnc\/.*\.step$/).map(f => `- \`${f}\` + the DXF with the same name`), '- Settings: `enclosure/jlccnc/README-JLCCNC.txt`.', '');
    if (has(/adhesive\//).length) lines.push('## Skin adhesive', ...has(/adhesive\/.*\.(pdf|dxf)$/).map(f => `- \`${f}\``), '- Print the PDF at 100 % and check the 50 mm line.', '');
    if (skipped.length) lines.push('## Not exported', ...skipped.map(s => '- ' + s), '');
    fs.writeFileSync(path.join(dir, 'ORDER-README.md'), lines.filter(l => l !== null).join('\n')); written.push('ORDER-README.md');
  }
  fs.writeFileSync(path.join(dir, 'README.txt'), `${X.name} — exported by CircuitPilot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n` +
    written.map(f => '  ' + f).join('\n') + (skipped.length ? '\n\nNot exported:\n' + skipped.map(f => '  ' + f).join('\n') : '') +
    '\n\nJLCPCB order: upload ' + X.base + '-gerbers.zip, then for assembly the BOM and CPL files in jlcpcb/.\n' + (X.vias ? X.vias + '\n' : ''));
  return { folder: dir, files: written, skipped, drc: X.drc, vias: X.vias };
}

// ---------- extra tools (projects & exports) ----------
const EXTRA = [
  { name: 'start_here', description: 'CALL THIS FIRST whenever the user asks for anything about electronics: designing a circuit, schematic, PCB or board, choosing parts, routing, Gerbers, an enclosure / case, or a datasheet. It starts the CircuitPilot app if needed, opens it in the browser, and returns the step-by-step workflow and the current project.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_projects', description: 'List all CircuitPilot projects (id, name, parts, nets, whether a PCB exists, last update). The current project is marked.', input_schema: { type: 'object', properties: {} } },
  { name: 'open_project', description: 'Make a project current (by id or name). All design tools act on the current project; the browser app shows changes live.', input_schema: { type: 'object', required: ['project'], properties: { project: { type: 'string', description: 'Project id or name' } } } },
  { name: 'create_project', description: 'Create a new empty project and make it current.', input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, knowledge_folder: { type: 'string', description: 'Optional knowledge folder path' } } } },
  { name: 'rename_project', description: 'Rename the current project.', input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  { name: 'export_gerbers', description: 'Run DRC, then write Gerber (copper, mask, paste, silkscreen, outline) + Excellon drill files and a .zip for the fab into a folder on this machine. Refuses when DRC has errors unless force is true.', input_schema: { type: 'object', required: ['out_dir'], properties: { out_dir: { type: 'string', description: 'Absolute folder path (created if missing)' }, force: { type: 'boolean', description: 'export even with DRC errors' } } } },
  { name: 'export_enclosure', description: 'Write the enclosure files for ordering into a folder on this machine (+ a .zip). Box mode → base + lid STL and STEP, OpenSCAD .scad, notes. Custom 3D mode → printed parts as STL + STEP (folder jlc3dp/), sheet-metal parts such as electrode plates as DXF (cut lines only) + STEP with the same name plus one panel of all plates with break-off bridges (folder jlccnc/), a README per service with the order settings and warnings, the OpenSCAD source and the 3D script. for: jlc3dp | jlccnc writes only the files of that service.', input_schema: { type: 'object', required: ['out_dir'], properties: { out_dir: { type: 'string', description: 'Absolute folder path (created if missing)' }, for: { type: 'string', enum: ['all', 'jlc3dp', 'jlccnc'], description: 'default all' } } } },
  { name: 'get_bom', description: 'Bill of materials of the current project as CSV text (qty, refs, type, value, footprint, LCSC part).', input_schema: { type: 'object', properties: {} } },
  { name: 'add_to_report', description: 'Add the current project to a report file: kind "design" writes a summary entry (name, board, layers, parts, nets, routing, vias, DRC, datasheet title / description, project notes) — updated in place when the project is already there; kind "finding" adds a note (title, text, severity). JSON file {designs: [], findings: []} (default Documents/CircuitPilot exports/report.json), or Markdown when the path ends with .md.', input_schema: { type: 'object', properties: { path: { type: 'string' }, kind: { type: 'string', enum: ['design', 'finding'] }, title: { type: 'string' }, text: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'error'] }, extra: { type: 'object', description: 'more fields for the entry' } } } },
  { name: 'import_folder', description: 'Add every project found in a folder and all its subfolders: CircuitPilot project files (.json / .circuit.json) and EasyEDA PCB files (.json, imported with tracks). Each becomes a new project; files that match a project already in CircuitPilot (same name and part count) are skipped unless skip_existing: false. dry_run: true only lists what would be imported. The first imported project becomes current.', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'folder on this PC' }, recursive: { type: 'boolean', description: 'default true' }, dry_run: { type: 'boolean' }, skip_existing: { type: 'boolean', description: 'default true' } } } },
  { name: 'export_parts', description: 'Write parts of My Library (default: all) to a JSON file, to use them in another CircuitPilot database or on another PC (import_parts).', input_schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, path: { type: 'string', description: 'file path (default Documents/CircuitPilot exports/my-library.json)' } } } },
  { name: 'import_parts', description: 'Add the parts of a JSON file from export_parts (or one part object) to My Library. Existing parts with the same key are kept unless overwrite: true.', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, overwrite: { type: 'boolean' } } } },
  { name: 'job_status', description: 'Result of a background job (long tools — generate_pcb, route_pcb, reroute, optimize_pcb, place_footprints, place_in_free_area, update_pcb_from_schematic, auto_layout, stitch_pour, connect_pads_to_pour, arrange_silk_labels, export_project — hand out a job_id when they take longer than ~40 s). Waits up to wait_s (default 50, max 55) for it to finish. Without job_id: lists the jobs.', input_schema: { type: 'object', properties: { job_id: { type: 'string' }, wait_s: { type: 'number' } } } },
  { name: 'cancel_job', description: 'Stop a running background job; nothing of it is saved.', input_schema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
  { name: 'copy_project', description: 'Copy a project (default: the current one) to a new project, e.g. before trying a big change or to start a variant. The copy becomes current unless open: false.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'name of the copy (default "<name> (copy)")' }, open: { type: 'boolean' } } } },
  { name: 'list_project_versions', description: 'Earlier saved states of a project (default: the current one). Kept automatically: about every 10 minutes while it is edited, whenever many parts disappear in one save, before a restore and when it is deleted. Without a project: also lists deleted projects that can be restored.', input_schema: { type: 'object', properties: {} } },
  { name: 'restore_project_version', description: 'Make an earlier state of a project current again (version from list_project_versions). The state it replaces is kept as a version too. Also brings back a deleted project (project = its id).', input_schema: { type: 'object', required: ['version'], properties: { version: { type: 'number' } } } },
  { name: 'export_cnc_gcode', description: 'G-code to mill this PCB on a desktop CNC with GRBL (CNC 3018 Pro and similar): 1_isolation.nc (V-bit rings around the copper; pours, clearances and keep-outs as in the Gerbers), 2_drill_<size>.nc (one file per bit), 3_cutout.nc (holes bigger than the end mill, then the outline in steps with holding tabs), preview.svg and a README with the bit order and set-up. One copper side only (route with set_design_rules {preset: "home"}); X0 Y0 = lower-left corner of the job, Z0 = copper surface. Warns where nets are closer than the V-bit (they would stay shorted) and about vias (they need wire links). Writes the files into out_dir.', input_schema: { type: 'object', required: ['out_dir'], properties: { out_dir: { type: 'string', description: 'Absolute folder path (created if missing)' }, iso_dia: { type: 'number', description: 'V-bit cut width at the cut depth, mm (default 0.15)' }, iso_depth: { type: 'number', description: 'isolation depth, mm (default 0.08)' }, iso_passes: { type: 'number', description: 'rings around the copper (default 2)' }, iso_overlap: { type: 'number', description: 'overlap between rings, 0-0.9 (default 0.3)' }, iso_feed: { type: 'number', description: 'mm/min (default 120)' }, plunge_feed: { type: 'number', description: 'mm/min (default 60)' }, drill_feed: { type: 'number', description: 'mm/min (default 40)' }, cut_dia: { type: 'number', description: 'end mill for the outline, mm (default 2); holes of this size + 0.1 and bigger are milled with it instead of drilled' }, cut_step: { type: 'number', description: 'depth per outline pass, mm (default 0.3)' }, cut_feed: { type: 'number', description: 'mm/min (default 100)' }, tabs: { type: 'number', description: 'holding tabs on the outline (default 4, 0 = none)' }, tab_width: { type: 'number', description: 'mm (default 2)' }, tab_height: { type: 'number', description: 'mm (default 0.5)' }, spindle: { type: 'number', description: 'S value (default 1000 = full speed with GRBL $30=1000)' }, board_thick: { type: 'number', description: 'copper board thickness, mm (default the design thickness, 1.6)' }, mirror: { type: 'string', enum: ['auto', 'on', 'off'], description: 'auto (default): mirrored when the parts go on the other side of the copper (through-hole only, or bottom copper); off for SMD on the copper side' }, origin: { type: 'string', enum: ['job', 'board'], description: 'job (default): X0 Y0 = lower-left corner of the whole job, every move at X, Y >= 0; board: X0 Y0 = board corner' }, layer: { type: 'string', enum: ['F', 'B'], description: 'copper side to mill (default: the side with the tracks)' } } } },
  { name: 'export_electrodes', description: 'The electrode() plates as gold (ENIG) PCB electrodes for JLCPCB (as: "pcb", default): one 0.6 mm board with all plates joined by mouse-bite tabs — gold over the whole skin side (mask open, vias tented), a solder pad on the back over each pod wire hole, true-arc outline — Gerbers + drill files + a zip for upload + an order README (ENIG 2U", Remove Mark, Single PCB) + an assembly guide picture. as: "sheet": the stainless sheet-metal set (all plates as one part on 5 mm bars + snip guide). projects: more projects whose plates go into the same board / part (e.g. the wrist and the chest designs in one order). Then jlcpcb_quote {gerber_zip} prices the gold board.', input_schema: { type: 'object', properties: { as: { type: 'string', enum: ['pcb', 'sheet'] }, projects: { type: 'array', items: { type: 'string' }, description: 'more project ids / names to merge' }, thickness: { type: 'number' }, out_dir: { type: 'string', description: 'folder (default Documents/CircuitPilot exports/<project>-electrodes)' } } } },
  { name: 'copy_block', description: 'Copy a circuit block (group of parts: schematic, PCB layout, tracks inside the block) within the current project or into another one (to_project). Power nets and keep_nets stay connected, wiring inside the block gets fresh nets, nets to outside parts are left off.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, to_project: { type: 'string', description: 'target project id or exact name (default: the same project)' }, keep_nets: { type: 'array', items: { type: 'string' } }, suffix: { type: 'string' }, sch_offset: { type: 'array', items: { type: 'number' } }, pcb_offset: { type: 'array', items: { type: 'number' } }, place: { type: 'string', enum: ['next', 'free', 'none'] }, sheet: { type: 'number' }, near: {} } } },
];
// every tool takes `project`: the call works on that project (it becomes the current one) — no guessing after a restart
const PROJECT_ARG = { type: 'string', description: 'Project id (or exact name) this call works on; it becomes the current project. Pass it in every call.' };
const NO_PROJECT_ARG = new Set(['list_projects', 'open_project', 'create_project', 'job_status', 'cancel_job', 'export_parts', 'import_parts', 'import_folder']);
const TOOLS = [...EXTRA, ...Engine.TOOLS.filter(t => !EXTRA.some(x => x.name === t.name)).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))]
  .map(t => NO_PROJECT_ARG.has(t.name) ? t : Object.assign({}, t, { input_schema: Object.assign({}, t.input_schema, { properties: Object.assign({ project: PROJECT_ARG }, t.input_schema.properties || {}) }) }));
// tools that need no project at all
const NO_PROJECT = new Set(['search_parts', 'web_search', 'web_fetch', 'list_my_parts', 'enclosure_script_help', 'list_batteries']);
const RO = new Set(Engine.TOOLS.filter(t => t.ro).map(t => t.name));

// the code this server runs vs. the files on disk: an update while it runs is not in its tool list — say so
const CODE_FILES = ['js/engine.js', 'js/shape3d.js', 'mcp/circuitpilot-mcp.mjs'].map(f => path.join(ROOT, f)), mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const CODE_AT_START = CODE_FILES.map(mtime);
const outdated = () => CODE_FILES.some((f, i) => mtime(f) > CODE_AT_START[i] + 1000);
async function callTool(name, input = {}) {
  if (input.project != null && input.project !== '' && !NO_PROJECT_ARG.has(name)) {
    const ref = input.project; input = Object.assign({}, input); delete input.project;
    const p = await resolveProject(ref);
    if (p) { if (p.id !== currentId) { setCurrent(p.id); await showProject(p.id); } }
    else if (name === 'restore_project_version' && /^[\w.-]{4,80}$/.test(String(ref))) setCurrent(String(ref));   // a deleted project
    else throw new Error(`No project "${ref}" — list_projects shows the projects (ids and names)`);
  }
  if (isLong(name, input)) { const j = await startJob(name, input); return awaitJob(j, JOB_WAIT); }
  switch (name) {
    case 'add_to_report': return withProject(async () => {
      const S = Model.S, file = path.resolve(String(input.path || path.join(os.homedir(), 'Documents', 'CircuitPilot exports', 'report.json'))), kind = input.kind || 'design';
      const st = S.board.w ? Pcb.status() : null, d = S.board.w ? Pcb.drc() : null, doc = S.doc || {}, notes = S.notes || {};
      const design = Object.assign({ project: S.name || 'Untitled', id: S.id, updated: new Date().toISOString().slice(0, 16),
        board: S.board.w ? `${S.board.w} x ${S.board.h} mm, ${(S.board.shape && S.board.shape.type) || 'rect'}, ${Pcb.rules().layers} layers` : null,
        parts: S.components.length, nets: Object.keys(S.nets).length, routed: st ? `${st.routed}/${st.nets}` : null, vias: st ? st.vias : null, track_mm: st ? st.trace_length_mm : null,
        drc: d ? d.summary : null, via_sizes: S.board.w ? Pcb.viaSummary() : null, title: doc.title || null, tagline: doc.subtitle || doc.tagline || null, description: doc.description || null, notes: notes.values && Object.keys(notes.values).length ? notes.values : undefined }, input.extra || {});
      const finding = Object.assign({ project: S.name || 'Untitled', id: S.id, date: new Date().toISOString().slice(0, 16), title: input.title || '', text: input.text || '', severity: input.severity || 'info' }, input.extra || {});
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (/\.md$/i.test(file)) {
        const md = kind === 'design'
          ? `\n## ${design.project}\n\n${Object.entries(design).filter(([k, v]) => v != null && k !== 'project').map(([k, v]) => `- **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')}\n`
          : `\n### ${finding.severity.toUpperCase()}: ${finding.title || finding.project}\n\n${finding.project} · ${finding.date}\n\n${finding.text}\n`;
        fs.appendFileSync(file, md); return { file, added: kind };
      }
      let R = { designs: [], findings: [] }; try { R = Object.assign(R, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { }
      if (kind === 'design') { const i = R.designs.findIndex(x => x.id === S.id); if (i >= 0) R.designs[i] = design; else R.designs.push(design); }
      else R.findings.push(finding);
      fs.writeFileSync(file, JSON.stringify(R, null, 1));
      return { file, kind, designs: R.designs.length, findings: R.findings.length, entry: kind === 'design' ? design : finding };
    }, false, 'add_to_report');
    case 'import_folder': {
      const root = path.resolve(String(input.path || '')); if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('No folder ' + root);
      const SKIP = /^(node_modules|\.git|__pycache__|dist|build)$/i, files = [];
      const walk = (dir, depth) => {
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (input.recursive !== false && depth < 12 && !SKIP.test(e.name)) walk(p, depth + 1); }
          else if (/\.json$/i.test(e.name) && files.length < 5000) files.push(p);
        }
      };
      walk(root, 0);
      const existing = await api('GET', '/api/projects'), found = [], skipped = [];
      for (const f of files) {
        const rel = path.relative(root, f).replace(/\\/g, '/');
        let d; try { if (fs.statSync(f).size > 30e6) throw new Error('too big'); d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { skipped.push(rel + ' (' + (e.message === 'too big' ? 'too big' : 'not valid JSON') + ')'); continue; }
        let kind = null, name = null, parts = null;
        if (d && Array.isArray(d.components) && d.nets && typeof d.nets === 'object') { kind = 'circuitpilot'; name = d.name; parts = d.components.length; }
        else { const ee = ctx.EasyEDA.isEasyEDA(d); if (ee === 'schematic') { skipped.push(rel + ' (EasyEDA schematic: import its PCB file)'); continue; } if (ee) { kind = 'easyeda'; name = (d.head && d.head.title) || d.title || null; } }
        if (!kind) { skipped.push(rel + ' (not a project)'); continue; }
        name = name || path.basename(f).replace(/\.circuit\.json$|\.json$/i, '');
        const dup = existing.some(p => (p.name || '') === name && (kind !== 'circuitpilot' || p.parts === parts));   // EasyEDA: same name
        found.push({ file: rel, kind, name, parts, already_in_circuitpilot: dup || undefined, d });
      }
      const todo = found.filter(x => !(x.already_in_circuitpilot && input.skip_existing !== false));
      const list = x => ({ file: x.file, kind: x.kind === 'circuitpilot' ? 'CircuitPilot project' : 'EasyEDA PCB', name: x.name, parts: x.parts == null ? undefined : x.parts, already_in_circuitpilot: x.already_in_circuitpilot });
      if (input.dry_run) return { folder: root, json_files: files.length, would_import: todo.map(list), already_there: found.filter(x => !todo.includes(x)).map(list), skipped: skipped.slice(0, 50) };
      const imported = [], failed = [];
      for (const x of todo) {
        try {
          let data;
          if (x.kind === 'circuitpilot') { data = JSON.parse(JSON.stringify(x.d)); delete data.id; data.name = x.name; }
          else { const nd = Model.blank(); nd.name = x.name; Model.load(nd); ctx.EasyEDA.importPcb(x.d); data = JSON.parse(Model.snapshot()); delete data.id; }
          const r = await api('PUT', '/api/projects/', data); imported.push({ id: r.id, name: x.name, file: x.file, parts: data.components.length });
        } catch (e) { failed.push(x.file + ': ' + e.message); }
      }
      if (imported.length) { setCurrent(imported[0].id); await showProject(imported[0].id); }
      return { folder: root, json_files: files.length, imported, already_there: found.filter(x => !todo.includes(x)).map(x => x.file), failed: failed.length ? failed : undefined, skipped: skipped.slice(0, 50), current: imported.length ? imported[0].id : undefined };
    }
    case 'export_parts': {
      const lib = await api('GET', '/api/library'), want = Array.isArray(input.keys) && input.keys.length ? new Set(input.keys) : null;
      const parts = lib.filter(p => !want || want.has(p.key)), file = path.resolve(String(input.path || path.join(os.homedir(), 'Documents', 'CircuitPilot exports', 'my-library.json')));
      if (want) { const miss = [...want].filter(k => !parts.some(p => p.key === k)); if (miss.length) throw new Error('Not in My Library: ' + miss.join(', ')); }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ format: 'circuitpilot-parts', version: 1, exported: new Date().toISOString(), parts }, null, 1));
      return { file, parts: parts.map(p => p.key) };
    }
    case 'import_parts': {
      const d = JSON.parse(fs.readFileSync(path.resolve(String(input.path)), 'utf8')), list = Array.isArray(d) ? d : Array.isArray(d.parts) ? d.parts : [d];
      const have = new Set((await api('GET', '/api/library')).map(p => p.key)), added = [], kept = [], bad = [];
      for (const p of list) {
        if (!p || !p.key || !Array.isArray(p.pins)) { bad.push(p && (p.key || p.name) || '?'); continue; }
        if (have.has(p.key) && !input.overwrite) { kept.push(p.key); continue; }
        await api('PUT', '/api/library/' + encodeURIComponent(p.key), p); added.push(p.key);
      }
      return { added, kept_existing: kept.length ? kept : undefined, invalid: bad.length ? bad : undefined };
    }
    case 'job_status': {
      if (!input.job_id) return [...jobs.values()].map(jobView);
      const j = jobs.get(String(input.job_id)); if (!j) throw new Error(`No job ${input.job_id} (jobs are forgotten an hour after they end, or when the MCP server restarts)`);
      return awaitJob(j, Math.min(55, Math.max(0, input.wait_s == null ? 50 : +input.wait_s)) * 1000);
    }
    case 'cancel_job': {
      const j = jobs.get(String(input.job_id)); if (!j) throw new Error(`No job ${input.job_id}`);
      if (j.status === 'running') { j.status = 'cancelled'; j.ended = Date.now(); try { j.worker && j.worker.terminate(); } catch { } }
      return jobView(j);
    }
    case 'copy_project': {
      const id = await ensureProject(), d = await api('GET', '/api/projects/' + id);
      delete d.id; d.name = input.name || (d.name || 'Untitled') + ' (copy)';
      const r = await api('PUT', '/api/projects/', d);
      if (input.open !== false) { setCurrent(r.id); await showProject(r.id); }
      return { copied: d.name, id: r.id, from: id, current: input.open !== false ? r.id : id };
    }
    case 'list_project_versions': {
      const id = await ensureProject().catch(() => null), meta = id ? await api('GET', '/api/projects/' + id + '/meta').catch(() => null) : null;
      const vs = id ? await api('GET', '/api/projects/' + id + '/versions').catch(() => []) : [];
      return { project: id, name: meta ? meta.name : undefined, versions: vs.map(v => ({ version: v.version, saved: new Date(v.saved * 1000).toISOString().slice(0, 19), parts: v.parts, name: v.name, reason: v.reason })), deleted_projects: (await api('GET', '/api/projects/_deleted').catch(() => [])).map(p => ({ id: p.id, name: p.name, parts: p.parts, deleted: new Date(p.deleted * 1000).toISOString().slice(0, 19) })) };
    }
    case 'restore_project_version': {
      const id = currentId || await ensureProject(); assertIdle(id, 'restoring');
      const r = await api('POST', '/api/projects/' + id + '/restore', { version: input.version });
      setCurrent(id); await showProject(id); return r;
    }
    case 'copy_block': {
      if (!input.to_project) return withProject(() => Engine.exec('copy_block', input, 'agent'), true, 'copy_block');
      const src = await ensureProject(), tgt = await resolveProject(input.to_project);
      if (!tgt) throw new Error(`No project "${input.to_project}"`);
      assertIdle(tgt.id, 'copy_block');
      Model.load(await api('GET', '/api/projects/' + src));
      const block = ctx.Blocks.extract(input.refs);
      Model.load(await api('GET', '/api/projects/' + tgt.id));
      const o = Object.assign({}, input); delete o.to_project; if (o.sch_offset == null) o.sch_offset = [0, 0]; if (!o.place) o.place = 'free';   // another board: the nearest free area
      const r = Model.mutate(() => ctx.Blocks.insert(block, o));
      await api('PUT', '/api/projects/' + tgt.id, JSON.parse(Model.snapshot()));
      return Object.assign({ from: src, to: tgt.id, to_name: tgt.name, note_current: 'The current project is still ' + src }, r);
    }
    case 'start_here': {
      const ps = await api('GET', '/api/projects'), id = await ensureProject().catch(() => null), cur = ps.find(p => p.id === id);
      const v = await api('GET', '/api/version').catch(() => ({})), dataDir = v.data_dir || '?';
      const sameDir = !v.data_dir || path.resolve(v.data_dir).toLowerCase() === path.resolve(DATA_DIR).toLowerCase();
      return {
        app: BASE + ' (running; the user sees every change live in the browser)',
        projects_folder: dataDir + (sameDir ? '' : ` — NOTE: not the CircuitPilot app's folder (${DATA_DIR}); a server.py started by hand uses its own projects.db. Tell the user if projects seem to be missing.`),
        current_project: cur ? Object.assign({ id, name: cur.name, parts: cur.parts, nets: cur.nets, pcb: cur.pcb }, await (async () => { const d = await api('GET', '/api/projects/' + id).catch(() => ({})); return d.notes ? { notes: d.notes } : {}; })()) : null,
        projects: ps.slice(0, 12).map(p => ({ id: p.id, name: p.name, parts: p.parts, updated: new Date(p.updated * 1000).toISOString().slice(0, 16) })),
        rule: 'Pass project (the id) in every tool call. Long tools may return a job_id — then call job_status until it is done.',
        workflow: WORKFLOW,
      };
    }
    case 'list_projects': {
      const ps = await api('GET', '/api/projects');
      if (!currentId) { const saved = (loadState()[stateKey()] || {}).project; if (saved && ps.some(p => p.id === saved)) currentId = saved; }
      return ps.map(p => ({ ...p, current: p.id === currentId, busy: [...jobs.values()].some(j => j.project === p.id && j.status === 'running') || undefined, updated: new Date(p.updated * 1000).toISOString() }));
    }
    case 'open_project': {
      const p = await resolveProject(input.project); if (!p) throw new Error(`No project matching "${input.project}"`);
      setCurrent(p.id); await showProject(currentId);
      const d = await api('GET', '/api/projects/' + p.id).catch(() => ({}));
      return Object.assign({ opened: p.name, id: p.id, parts: p.parts, nets: p.nets }, d.notes && (d.notes.text || Object.keys(d.notes.values || {}).length) ? { notes: d.notes } : {});
    }
    case 'create_project': {
      const d = Model.blank(); d.name = input.name || 'Untitled';
      setCurrent((await api('PUT', '/api/projects/', d)).id); await showProject(currentId);
      let k = null;
      if (input.knowledge_folder) k = await withProject(() => Engine.exec('set_knowledge_folder', { path: input.knowledge_folder }));
      return { created: d.name, id: currentId, knowledge: k };
    }
    case 'rename_project': return withProject(() => { Model.mutate(() => { Model.S.name = input.name; }); return { ok: true, name: input.name }; });
    case 'export_gerbers': return withProject(async () => {
      const d = Pcb.drc();
      if (d.errors && !input.force) return { exported: false, drc: d.summary, errors: d.violations.filter(v => v.severity === 'error').slice(0, 20).map(v => v.msg), hint: 'Fix these (route_pcb, optimize_pcb, place_footprint) or call again with force: true' };
      const files = Pcb.gerbers(), dir = path.resolve(String(input.out_dir || ''));
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, txt] of Object.entries(files)) { const f = path.join(dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); }
      const vias = Pcb.viaSummary();
      fs.writeFileSync(path.join(dir, 'ORDER-NOTES.txt'), `${Model.S.name || 'Board'}: ${Model.S.board.w} x ${Model.S.board.h} mm, ${Pcb.rules().layers} layers\n${vias}\nDRC: ${d.summary}\n`);
      const zipPath = path.join(dir, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-gerbers.zip');
      fs.writeFileSync(zipPath, Buffer.from(await ctx.makeZip(files).arrayBuffer()));
      return { exported: true, drc: d.summary, vias, warnings: d.violations.filter(v => v.severity !== 'error').slice(0, 10).map(v => v.msg), folder: dir, files: Object.keys(files), zip: zipPath };
    });
    case 'export_cnc_gcode': return withProject(async () => {
      const d = Pcb.drc(), { files, info } = Cnc.job(input), dir = path.resolve(String(input.out_dir || ''));
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, txt] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), txt);
      return Object.assign({ folder: dir, drc: d.summary, drc_errors: d.errors ? d.violations.filter(v => v.severity === 'error').slice(0, 10).map(v => v.msg) : undefined }, info, { files: Object.keys(files) });
    });
    case 'export_electrodes': return withProject(async () => {
      const list = Engine.plates(), from = [Model.S.name || currentId];
      // the other projects' plates (their own 3D scripts), merged into the same board / part
      const keep = Model.snapshot();
      try {
        for (const ref of input.projects || []) {
          const pj = await resolveProject(ref); if (!pj) throw new Error(`No project "${ref}"`);
          Model.load(await api('GET', '/api/projects/' + pj.id));
          const more = Engine.plates(); if (!more.length) throw new Error(`Project "${pj.name}" has no electrode plates`);
          list.push(...more.map(q => Object.assign(q, { name: (pj.name || pj.id).replace(/[^\w.-]+/g, '_').slice(0, 20) + '_' + q.name }))); from.push(pj.name || pj.id);
        }
      } finally { Model.load(JSON.parse(keep)); }
      if (!list.length) throw new Error('No electrode plates — electrode({…}) in the 3D script makes them');
      const { files, info } = Engine.electrodeFiles(list, { as: input.as, thickness: input.thickness, name: from.length > 1 ? from.join('+') : from[0] });
      const base = (from.length > 1 ? from.join('+') : from[0]).replace(/[^\w.+-]+/g, '_');
      const dir = path.resolve(String(input.out_dir || path.join(os.homedir(), 'Documents', 'CircuitPilot exports', base + '-electrodes')));
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, d] of Object.entries(files)) { const f = path.join(dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d instanceof Uint8Array ? Buffer.from(d) : d); }
      let zip = null;
      if ((input.as || 'pcb') === 'pcb') { const g = Object.fromEntries(Object.entries(files).filter(([n]) => /\.(G\w\w|DRL)$/i.test(n))); zip = path.join(dir, base + '-gold-electrodes-gerbers.zip'); fs.writeFileSync(zip, Buffer.from(await ctx.makeZip(g).arrayBuffer())); }
      return Object.assign({ folder: dir, files: Object.keys(files), gerber_zip: zip || undefined, projects: from, next: zip ? `jlcpcb_quote {gerber_zip: "${zip.replace(/\\/g, '/')}", finish: 2, thickness: ${input.thickness || 0.6}} prices it` : undefined }, info);
    }, false);
    case 'export_enclosure': return withProject(async () => {
      const dir = path.resolve(String(input.out_dir || ''));
      // custom: print parts (STL + STEP), sheet parts (DXF + STEP + panel), README per service; box: STL + STEP + .scad
      const { files, info } = ctx.Engine.enclosureFiles({ service: input.for || 'all' });
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, data] of Object.entries(files)) { const f = path.join(dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data instanceof Uint8Array ? Buffer.from(data) : data); }
      const zipPath = path.join(dir, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-enclosure.zip');
      fs.writeFileSync(zipPath, Buffer.from(await ctx.makeZip(files).arrayBuffer()));
      return { folder: dir, files: Object.keys(files), zip: zipPath, mode: info.mode || 'box', outer_mm: info.outer_mm, parts: info.parts, collisions: info.collisions, cutouts: (info.cutouts || []).length, warnings: info.warnings, note: 'Order: the README-*.txt next to the files has the settings for each service (JLC3DP prints, JLCCNC sheet parts).' };
    });
    case 'get_bom': return withProject(() => {
      const g = {};
      for (const c of Model.S.components) { const k = [c.type, c.value, c.footprint, c.lcsc || ''].join('|'); (g[k] = g[k] || []).push(c.ref); }
      return 'Qty,References,Type,Value,Footprint,LCSC\n' + Object.entries(g).map(([k, r]) => { const [t, v, f, l] = k.split('|'); return `${r.length},"${r.join(' ')}",${t},"${v}",${f},${/^C\d+$/.test(l) ? l : ''}`; }).join('\n');
    });
  }
  if (!Engine.TOOLS.some(t => t.name === name)) throw new Error('Unknown tool ' + name);
  await ctx.kernelReady;   // the fast 3D kernel (enclosure scripts) is loaded before any tool runs
  if (NO_PROJECT.has(name)) { Model.load(Model.blank()); try { myLib = await api('GET', '/api/library'); } catch { } return Engine.exec(name, input, 'agent'); }
  return withProject(() => Engine.exec(name, input, 'agent'), !RO.has(name), name);
}

// Serialize calls: every tool loads, edits and saves the shared project.
let queue = Promise.resolve();
async function callChecked(name, input) {
  if (!(await ensureApp())) throw new Error(`The CircuitPilot app is not running at ${BASE} and could not be started. Ask the user to run "python server.py" in ${ROOT}.`);
  return callTool(name, input);
}
const run = (name, input) => (queue = queue.then(() => callChecked(name, input), () => callChecked(name, input)));

const WORKFLOW = `1. New design: create_project {name}. To continue an existing one: list_projects → open_project. Pass project (the id) in every call after that.
2. Parts: search_parts for real ICs, modules, regulators, connectors (JLCPCB catalogue) → get_part for the exact pinout. Passives (resistor, capacitor, LED, diode…) can be added by type.
3. Schematic: add_components (give x/y positions, ~150 units apart, related parts together) → connect pins with named nets (GND, +3V3, +5V are power nets) → run_erc and fix errors. Use sheets (add_sheet) for big designs.
4. Look at it: view_design {view:"schematic"} and fix crowded or confusing areas.
5. PCB: generate_pcb (board size if the user gave one) → pcb_status / run_drc → if nets are unrouted: optimize_pcb → add_copper_pour GND → run_drc. Check with view_design {view:"pcb"} and {view:"pcb_3d"}.
6. Optional: enclosure — set_enclosure (parametric box) or, for wearables and custom cases, set_enclosure_script {template, params} (35 templates, no code, returns a 4-view picture + fit and manufacturability report); small edits: set_enclosure_script {vars} / {patch} (no resend); battery: list_batteries (charge_mA gives the charge rate), then params {battery, batteryPlace}; check_enclosure {process} for the full manufacturability check (thin walls, knife edges, slits, fit, leaks); electrode() in scripts for skin plates; export_enclosure {for: jlc3dp | jlccnc} writes STL / STEP / DXF + order README; view_design {view:"enclosure", overview / section + at / angle / thickness}. Datasheet text (set_documentation), Gerbers (export_gerbers {out_dir}).
Tell the user what you built and what to check (footprints against datasheets, antenna keep-out, power ratings).`;

const INSTRUCTIONS = `CircuitPilot is an AI schematic + PCB designer. These tools edit the CURRENT project (see list_projects / open_project / create_project); the user sees every change live in the CircuitPilot browser app.
Workflow: search_parts → get_part for real ICs/modules (exact pinout + footprint) → add_components → connect (named nets; GND / +3V3 / +5V are power nets) → run_erc → generate_pcb → export_gerbers.
Pins are "REF.PIN" using the pin number or name. Use create_part for parts missing from the database. If the project has a knowledge folder, read it (knowledge_list / knowledge_search / knowledge_read) and follow its rules.
Always pass project (the project id) in every tool call. Long tools (generate_pcb, route_pcb, optimize_pcb, export_project …) may return a job_id: call job_status {job_id} until it reports the result.
Save tokens: get_pcb_layout is compact (filter with refs / region / fields, add with include), run_drc lists 5 violations (full: true for all), view_design {size: "small"} for quick looks, get_tracks {near / region / vias_only}. One call for a full re-route: reroute (pours off → power nets first → rest → pours back → stitching → labels → DRC); batch runs many edits (routing too). Project notes (set_project_notes) come back with open_project.
Keep-outs: add_keepout (antenna end, under a coin cell …), strict rule set_design_rules {noViaInPad: true}; place_in_free_area moves parts to free board space; copy_block / copy_project copy a circuit block or a whole project; list_project_versions / restore_project_version undo an overwrite.
JLCPCB: jlcpcb_parts gives live stock / price for LCSC parts; jlcpcb_quote uploads the Gerbers and returns the live board price, build times and shipping. Orders are placed by the user with the Order at JLCPCB button in the app.
Draw single tracks yourself with add_track (pads "U1.3" + [x, y] corners, {x, y, via: true} to change layer; route_pcb keeps them), list them with get_tracks, delete with remove_tracks.
Vias: add_via {near: "U2.9"} (a pad) or {near: [x, y], net} finds the closest legal spot itself (all clearances, hole to hole, edge, keep-outs, no via in pad) and, from a pad, adds the short track to it — prefer it over guessing x, y. When run_drc says "Net GND is not routed" on a board with GND pours (pads the pour cannot reach with the full clearance), or the EasyEDA export warns about pads reached only through thin pour copper: connect_pads_to_pour {net: "GND"} joins every cut-off pad group with a via to the other layer's pour; then run_drc.
Look at your work: view_design returns a screenshot (schematic, pcb, pcb_3d, enclosure) drawn by the CircuitPilot tab open in the browser. Check the result after changes and fix what looks wrong.
Datasheet: get_documentation / set_documentation write the product text of the Documentation tab (the user exports the PDF there). Use auto_layout sparingly; place parts with add_components x/y when you can.`;

// ---------- MCP over stdio (JSON-RPC 2.0, newline delimited) ----------
function startStdio() {
  const send = m => process.stdout.write(JSON.stringify(m) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) handle(line).catch(e => log('handler error', e));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  async function handle(line) {
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params = {} } = msg;
    const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: 'circuitpilot', version: '1.0.0' }, instructions: INSTRUCTIONS });
      // ready-made prompt in the client's prompt menu (Claude Desktop: + → CircuitPilot)
      case 'prompts/list': return reply({ prompts: [{ name: 'design_board', title: 'Design a board with CircuitPilot', description: 'Describe a circuit; Claude designs the schematic, PCB and (optionally) the enclosure in CircuitPilot', arguments: [{ name: 'description', description: 'What should the board do? e.g. "ESP32-C3 with a BME280 sensor and USB-C, 30 × 30 mm"', required: true }] }] });
      case 'prompts/get': {
        if (params.name !== 'design_board') return fail(-32602, 'Unknown prompt ' + params.name);
        const desc = (params.arguments && params.arguments.description) || '';
        return reply({ description: 'Design a board with CircuitPilot', messages: [{ role: 'user', content: { type: 'text', text: `Use CircuitPilot (call start_here first) to design this board: ${desc}\n\nCreate a new project, pick real JLCPCB parts, build and check the schematic, make and route the PCB, look at the result with view_design, then tell me what you built and what I should check.` } }] });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      case 'tools/call': {
        try {
          const out = await run(params.name, params.arguments || {});
          if (out && typeof out === 'object' && out.__image) {   // view_design: hand the screenshot to the model as an image
            const { __image, ...rest } = out;
            return reply({ content: [{ type: 'image', data: __image.data, mimeType: __image.mime }, { type: 'text', text: JSON.stringify(rest, null, 1) }] });
          }
          const stale = outdated() ? [{ type: 'text', text: 'Note: CircuitPilot was updated after this tool server started — its tool list (and code) is the old one. Reconnect / restart the CircuitPilot MCP server to get the new tools and options.' }] : [];
          return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }, ...stale] });
        } catch (e) { return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
      }
      default: return fail(-32601, 'Method not found: ' + method);
    }
  }
  log(`MCP server ready (stdio) → ${BASE}`);
}

// ---------- REST API (--http PORT) ----------
function startHttp(port, host) {
  const openapi = () => ({
    openapi: '3.1.0', info: { title: 'CircuitPilot tools', version: '1.0.0', description: INSTRUCTIONS }, servers: [{ url: `http://${host}:${port}` }],
    paths: Object.fromEntries(TOOLS.map(t => [`/tools/${t.name}`, { post: { operationId: t.name, summary: t.description, requestBody: { content: { 'application/json': { schema: t.input_schema } } }, responses: { 200: { description: 'Tool result' } } } }])),
  });
  http.createServer(async (req, res) => {
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); };
    if (PASSWORD) {
      const a = req.headers.authorization || '';
      if (a.slice(7).trim().toLowerCase() !== PASSWORD.toLowerCase()) return out(401, { error: 'Send Authorization: Bearer <app password>' });
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/tools' || url.pathname === '/')) return out(200, TOOLS);
    if (req.method === 'GET' && url.pathname === '/openapi.json') return out(200, openapi());
    const m = /^\/tools\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      let body = ''; for await (const c of req) body += c;
      let input = {}; try { input = body ? JSON.parse(body) : {}; } catch { return out(400, { error: 'Body must be JSON' }); }
      try {
        return out(200, { result: await run(m[1], input) });
      } catch (e) { return out(400, { error: e.message }); }
    }
    out(404, { error: 'Use GET /tools, GET /openapi.json or POST /tools/<name>' });
  }).listen(port, host, () => log(`REST API on http://${host}:${port}  (GET /tools, POST /tools/<name>, GET /openapi.json) → ${BASE}`));
}

const argv = process.argv.slice(2), hi = argv.indexOf('--http');
if (hi >= 0) startHttp(+argv[hi + 1] || 5174, argv.includes('--public') ? '0.0.0.0' : '127.0.0.1');
else startStdio();
