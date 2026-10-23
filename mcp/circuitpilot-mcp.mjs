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
const log = (...a) => console.error('[circuitpilot]', ...a);

// ---------- load the shared engine (same code as the browser app) ----------
const ctx = loadEngine(ROOT, log);
const { Engine, Model, Pcb } = ctx;
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
  render: async args => { await ensureRenderTab(currentId); const r = await api('POST', '/api/render/request', { project: currentId, args }); touchHeadless(); return r; },   // view_design
});

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
const LONG = new Set(['generate_pcb', 'route_pcb', 'optimize_pcb', 'auto_layout', 'place_footprints', 'update_pcb_from_schematic', 'export_project']);
const JOB_WAIT = +(process.env.CP_JOB_WAIT || 40000);   // answer directly when done within this time, else hand out a job id
const jobs = new Map(); let jobSeq = 0;
function workerRun(msg) {
  const w = new Worker(new URL('./job-worker.mjs', import.meta.url), { workerData: { root: ROOT } });
  const p = new Promise((res, rej) => {
    w.once('message', m => { w.terminate(); m.ok ? res(m) : rej(new Error(m.error)); });
    w.once('error', e => rej(e));
    w.once('exit', c => rej(new Error(c ? 'worker stopped (' + c + ')' : 'worker stopped')));
  });
  w.postMessage(msg);
  return { w, p };
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
  job.promise.then(r => { job.status = 'done'; job.result = r; job.ended = Date.now(); }, e => { if (job.status === 'running') { job.status = 'failed'; job.error = e.message; job.ended = Date.now(); } });
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.status !== 'running' && Date.now() - (j.ended || j.started) > 3600e3) jobs.delete(k);   // forget old jobs after an hour
  return job;
}
const jobView = j => ({ job_id: j.id, tool: j.tool, project: j.project, project_name: j.name, status: j.status, seconds: Math.round(((j.ended || Date.now()) - j.started) / 1000) });
async function awaitJob(j, ms) {
  await Promise.race([j.promise.catch(() => { }), new Promise(r => setTimeout(r, ms))]);
  if (j.status === 'done') return j.result;
  if (j.status === 'failed') throw new Error(`${j.tool} failed: ${j.error}`);
  if (j.status === 'cancelled') return Object.assign(jobView(j), { note: 'cancelled — nothing was saved' });
  return Object.assign(jobView(j), { note: `Still working. Call job_status {job_id: "${j.id}"} — it waits up to 55 s for the result. Other projects can be edited meanwhile; this one is locked until the job ends.` });
}
// export: files from the worker, PDFs + images from the app window, all into one folder per project
async function exportJob(job, project, input) {
  const all = ['project', 'gerbers', 'jlcpcb', 'bom', 'netlist', 'enclosure', 'easyeda', 'pdf', 'images'];
  const inc = Array.isArray(input.include) && input.include.length ? input.include : all;
  const { p, w } = workerRun({ kind: 'export', include: inc, project, myLib, base: BASE, headers }); job.worker = w;
  const { result: X } = await p, written = [], skipped = X.skipped.slice();
  const root = path.resolve(String(input.out_dir || path.join(os.homedir(), 'Documents', 'CircuitPilot exports'))), dir = path.join(root, X.base);
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
      try { const r = await api('POST', '/api/render/request', { project: job.project, args }); touchHeadless(); if (!r || !r.data) throw new Error('nothing drawn'); put(rel, new Uint8Array(Buffer.from(r.data, 'base64'))); }
      catch (e) { skipped.push(rel + ': ' + e.message); }
    }
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
  { name: 'export_enclosure', description: 'Write the 3D-printable enclosure for the current project into a folder on this machine: box mode → base + lid STL, parametric OpenSCAD .scad and notes; custom 3D mode → one STL per part, OpenSCAD source and the 3D script; plus a .zip.', input_schema: { type: 'object', required: ['out_dir'], properties: { out_dir: { type: 'string', description: 'Absolute folder path (created if missing)' } } } },
  { name: 'get_bom', description: 'Bill of materials of the current project as CSV text (qty, refs, type, value, footprint, LCSC part).', input_schema: { type: 'object', properties: {} } },
  { name: 'export_parts', description: 'Write parts of My Library (default: all) to a JSON file, to use them in another CircuitPilot database or on another PC (import_parts).', input_schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, path: { type: 'string', description: 'file path (default Documents/CircuitPilot exports/my-library.json)' } } } },
  { name: 'import_parts', description: 'Add the parts of a JSON file from export_parts (or one part object) to My Library. Existing parts with the same key are kept unless overwrite: true.', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, overwrite: { type: 'boolean' } } } },
  { name: 'job_status', description: 'Result of a background job (long tools — generate_pcb, route_pcb, optimize_pcb, place_footprints, update_pcb_from_schematic, auto_layout, export_project — hand out a job_id when they take longer than ~40 s). Waits up to wait_s (default 50, max 55) for it to finish. Without job_id: lists the jobs.', input_schema: { type: 'object', properties: { job_id: { type: 'string' }, wait_s: { type: 'number' } } } },
  { name: 'cancel_job', description: 'Stop a running background job; nothing of it is saved.', input_schema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
  { name: 'copy_project', description: 'Copy a project (default: the current one) to a new project, e.g. before trying a big change or to start a variant. The copy becomes current unless open: false.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'name of the copy (default "<name> (copy)")' }, open: { type: 'boolean' } } } },
  { name: 'list_project_versions', description: 'Earlier saved states of a project (default: the current one). Kept automatically: about every 10 minutes while it is edited, whenever many parts disappear in one save, before a restore and when it is deleted. Without a project: also lists deleted projects that can be restored.', input_schema: { type: 'object', properties: {} } },
  { name: 'restore_project_version', description: 'Make an earlier state of a project current again (version from list_project_versions). The state it replaces is kept as a version too. Also brings back a deleted project (project = its id).', input_schema: { type: 'object', required: ['version'], properties: { version: { type: 'number' } } } },
  { name: 'copy_block', description: 'Copy a circuit block (group of parts: schematic, PCB layout, tracks inside the block) within the current project or into another one (to_project). Power nets and keep_nets stay connected, wiring inside the block gets fresh nets, nets to outside parts are left off.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, to_project: { type: 'string', description: 'target project id or exact name (default: the same project)' }, keep_nets: { type: 'array', items: { type: 'string' } }, suffix: { type: 'string' }, sch_offset: { type: 'array', items: { type: 'number' } }, pcb_offset: { type: 'array', items: { type: 'number' } }, place: { type: 'string', enum: ['next', 'free', 'none'] }, sheet: { type: 'number' }, near: {} } } },
];
// every tool takes `project`: the call works on that project (it becomes the current one) — no guessing after a restart
const PROJECT_ARG = { type: 'string', description: 'Project id (or exact name) this call works on; it becomes the current project. Pass it in every call.' };
const NO_PROJECT_ARG = new Set(['list_projects', 'open_project', 'create_project', 'job_status', 'cancel_job', 'export_parts', 'import_parts']);
const TOOLS = [...EXTRA, ...Engine.TOOLS.filter(t => !EXTRA.some(x => x.name === t.name)).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))]
  .map(t => NO_PROJECT_ARG.has(t.name) ? t : Object.assign({}, t, { input_schema: Object.assign({}, t.input_schema, { properties: Object.assign({ project: PROJECT_ARG }, t.input_schema.properties || {}) }) }));
// tools that need no project at all
const NO_PROJECT = new Set(['search_parts', 'web_search', 'web_fetch', 'list_my_parts', 'enclosure_script_help']);
const RO = new Set(Engine.TOOLS.filter(t => t.ro).map(t => t.name));

async function callTool(name, input = {}) {
  if (input.project != null && input.project !== '' && !NO_PROJECT_ARG.has(name)) {
    const ref = input.project; input = Object.assign({}, input); delete input.project;
    const p = await resolveProject(ref);
    if (p) { if (p.id !== currentId) { setCurrent(p.id); await showProject(p.id); } }
    else if (name === 'restore_project_version' && /^[\w.-]{4,80}$/.test(String(ref))) setCurrent(String(ref));   // a deleted project
    else throw new Error(`No project "${ref}" — list_projects shows the projects (ids and names)`);
  }
  if (LONG.has(name)) { const j = await startJob(name, input); return awaitJob(j, JOB_WAIT); }
  switch (name) {
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
        current_project: cur ? { id, name: cur.name, parts: cur.parts, nets: cur.nets, pcb: cur.pcb } : null,
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
      setCurrent(p.id); await showProject(currentId); return { opened: p.name, id: p.id, parts: p.parts, nets: p.nets };
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
      for (const [n, txt] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), txt);
      const vias = Pcb.viaSummary();
      fs.writeFileSync(path.join(dir, 'ORDER-NOTES.txt'), `${Model.S.name || 'Board'}: ${Model.S.board.w} x ${Model.S.board.h} mm, ${Pcb.rules().layers} layers\n${vias}\nDRC: ${d.summary}\n`);
      const zipPath = path.join(dir, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-gerbers.zip');
      fs.writeFileSync(zipPath, Buffer.from(await ctx.makeZip(files).arrayBuffer()));
      return { exported: true, drc: d.summary, vias, warnings: d.violations.filter(v => v.severity !== 'error').slice(0, 10).map(v => v.msg), folder: dir, files: Object.keys(files), zip: zipPath };
    });
    case 'export_enclosure': return withProject(async () => {
      const dir = path.resolve(String(input.out_dir || ''));
      let files, info;
      if (ctx.Enclosure.mode() === 'custom') {   // free-form 3D script: one STL per part + OpenSCAD + the script
        const sc = (() => { try { return ctx.Shape3D.context(ctx.Enclosure.layout()); } catch { return { pcb: null }; } })();
        const r = ctx.Shape3D.run(ctx.Enclosure.script(), sc, { mesh: false }), base = (Model.S.name || 'design').replace(/[^\w.-]+/g, '_');
        files = {}; for (const p of r.parts) files[base + '-' + p.name + '.stl'] = p.stl;
        files[base + '-enclosure.scad'] = r.scad; files[base + '-enclosure-script.js'] = ctx.Enclosure.script();
        info = { mode: 'custom', parts: r.parts.map(p => ({ name: p.name, size_mm: p.size_mm })), collisions: r.report.collisions, cutouts: [] };
      } else ({ files, info } = ctx.Enclosure.exportFiles());
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), data instanceof Uint8Array ? Buffer.from(data) : data);
      const zipPath = path.join(dir, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-enclosure.zip');
      fs.writeFileSync(zipPath, Buffer.from(await ctx.makeZip(files).arrayBuffer()));
      return { folder: dir, files: Object.keys(files), zip: zipPath, mode: info.mode || 'box', outer_mm: info.outer_mm, parts: info.parts, collisions: info.collisions, cutouts: info.cutouts.length };
    });
    case 'get_bom': return withProject(() => {
      const g = {};
      for (const c of Model.S.components) { const k = [c.type, c.value, c.footprint, c.lcsc || ''].join('|'); (g[k] = g[k] || []).push(c.ref); }
      return 'Qty,References,Type,Value,Footprint,LCSC\n' + Object.entries(g).map(([k, r]) => { const [t, v, f, l] = k.split('|'); return `${r.length},"${r.join(' ')}",${t},"${v}",${f},${/^C\d+$/.test(l) ? l : ''}`; }).join('\n');
    });
  }
  if (!Engine.TOOLS.some(t => t.name === name)) throw new Error('Unknown tool ' + name);
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
6. Optional: enclosure (get_enclosure / set_enclosure, or enclosure_script_help for wearables and custom cases; check with view_design {view:"enclosure"}), datasheet text (set_documentation), Gerbers (export_gerbers {out_dir}).
Tell the user what you built and what to check (footprints against datasheets, antenna keep-out, power ratings).`;

const INSTRUCTIONS = `CircuitPilot is an AI schematic + PCB designer. These tools edit the CURRENT project (see list_projects / open_project / create_project); the user sees every change live in the CircuitPilot browser app.
Workflow: search_parts → get_part for real ICs/modules (exact pinout + footprint) → add_components → connect (named nets; GND / +3V3 / +5V are power nets) → run_erc → generate_pcb → export_gerbers.
Pins are "REF.PIN" using the pin number or name. Use create_part for parts missing from the database. If the project has a knowledge folder, read it (knowledge_list / knowledge_search / knowledge_read) and follow its rules.
Always pass project (the project id) in every tool call. Long tools (generate_pcb, route_pcb, optimize_pcb, export_project …) may return a job_id: call job_status {job_id} until it reports the result.
Keep-outs: add_keepout (antenna end, under a coin cell …), strict rule set_design_rules {noViaInPad: true}; place_in_free_area moves parts to free board space; copy_block / copy_project copy a circuit block or a whole project; list_project_versions / restore_project_version undo an overwrite.
Draw single tracks yourself with add_track (pads "U1.3" + [x, y] corners, {x, y, via: true} to change layer; route_pcb keeps them), list them with get_tracks, delete with remove_tracks.
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
          return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] });
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
