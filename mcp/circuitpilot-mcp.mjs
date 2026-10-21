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
//              CP_PROJECT (project id or name to open at start).
// It talks to the running server.py, so projects changed here appear live in the browser.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.CP_URL || 'http://localhost:5173').replace(/\/+$/, '');
let PASSWORD = process.env.CP_PASSWORD || '';
if (!PASSWORD) { try { PASSWORD = fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { } }
const log = (...a) => console.error('[circuitpilot]', ...a);

// ---------- load the shared engine (same code as the browser app) ----------
const ctx = vm.createContext({
  console: { log, info: log, warn: log, error: log }, fetch, TextEncoder, TextDecoder, Blob, URL, URLSearchParams,
  setTimeout, clearTimeout, AbortController, AbortSignal,
});
for (const [file, name] of [['lib.js', 'Lib'], ['model.js', 'Model'], ['pcb.js', 'Pcb'], ['enclosure.js', 'Enclosure'], ['shape3d.js', 'Shape3D'], ['engine.js', 'Engine']]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8') + `\n;globalThis.${name} = ${name};`, ctx, { filename: file });
}
const { Engine, Model, Pcb } = ctx;
const headers = PASSWORD ? { authorization: 'Bearer ' + PASSWORD } : {};
let myLib = [];
Object.assign(Engine.env, {
  base: BASE, headers, fetch,
  myLib: () => myLib,
  savePart: async def => { await api('PUT', '/api/library/' + encodeURIComponent(def.key), def); },
  ui: () => { },
  // screenshots (view_design): drawn by the CircuitPilot tab open in the browser, relayed by server.py
  render: async args => api('POST', '/api/render/request', { project: currentId, args }),
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
    const args = ['server.py', new URL(BASE).port || '5173', '--allow-ports', '8080'];
    if (fs.existsSync(path.join(ROOT, 'access-password.txt'))) args.push('--password-file', 'access-password.txt');
    try { spawn(process.env.CP_PYTHON || 'python', args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref(); log('started server.py'); }
    catch (e) { log('could not start server.py:', e.message); return false; }
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
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { }
}
async function showProject(id) {
  if (!id) return;
  try { await api('POST', '/api/render/focus', { project: id }); } catch { }
  try { const t = await api('GET', '/api/render/tabs'); if (!t.tabs && !browserOpened) openBrowser(BASE + '/?project=' + encodeURIComponent(id)); } catch { }
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({}, headers, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { j = { error: r.status === 401 ? 'Unauthorized — set CP_PASSWORD to the app password' : txt.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- project session ----------
let currentId = null;
async function resolveProject(ref) {
  const ps = await api('GET', '/api/projects');
  if (!ref) return ps[0] || null;
  return ps.find(p => p.id === ref) || ps.find(p => (p.name || '').toLowerCase() === String(ref).toLowerCase()) ||
    ps.find(p => (p.name || '').toLowerCase().includes(String(ref).toLowerCase())) || null;
}
async function ensureProject() {
  if (currentId) return currentId;
  const p = await resolveProject(process.env.CP_PROJECT);
  if (p) currentId = p.id;
  else { const d = Model.blank(); d.name = 'Untitled'; currentId = (await api('PUT', '/api/projects/', d)).id; }
  await showProject(currentId);
  return currentId;
}
async function withProject(fn) {
  const id = await ensureProject();
  Model.load(await api('GET', '/api/projects/' + id));
  try { myLib = await api('GET', '/api/library'); } catch { }
  const before = Model.snapshot();
  const out = await fn();
  if (Model.snapshot() !== before) await api('PUT', '/api/projects/' + id, JSON.parse(Model.snapshot()));
  return out;
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
];
const TOOLS = [...EXTRA, ...Engine.TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))];

async function callTool(name, input = {}) {
  switch (name) {
    case 'start_here': {
      const ps = await api('GET', '/api/projects'), id = await ensureProject(), cur = ps.find(p => p.id === id);
      return {
        app: BASE + ' (running; the user sees every change live in the browser)',
        current_project: cur ? { id, name: cur.name, parts: cur.parts, nets: cur.nets, pcb: cur.pcb } : { id },
        other_projects: ps.filter(p => p.id !== id).slice(0, 10).map(p => p.name),
        workflow: WORKFLOW,
      };
    }
    case 'list_projects': {
      const ps = await api('GET', '/api/projects');
      return ps.map(p => ({ ...p, current: p.id === currentId, updated: new Date(p.updated * 1000).toISOString() }));
    }
    case 'open_project': {
      const p = await resolveProject(input.project); if (!p) throw new Error(`No project matching "${input.project}"`);
      currentId = p.id; await showProject(currentId); return { opened: p.name, id: p.id, parts: p.parts, nets: p.nets };
    }
    case 'create_project': {
      const d = Model.blank(); d.name = input.name || 'Untitled';
      currentId = (await api('PUT', '/api/projects/', d)).id; await showProject(currentId);
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
      const zipPath = path.join(dir, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-gerbers.zip');
      fs.writeFileSync(zipPath, Buffer.from(await ctx.makeZip(files).arrayBuffer()));
      return { exported: true, drc: d.summary, warnings: d.violations.filter(v => v.severity !== 'error').slice(0, 10).map(v => v.msg), folder: dir, files: Object.keys(files), zip: zipPath };
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
  return withProject(() => Engine.exec(name, input, 'agent'));
}

// Serialize calls: every tool loads, edits and saves the shared project.
let queue = Promise.resolve();
async function callChecked(name, input) {
  if (!(await ensureApp())) throw new Error(`The CircuitPilot app is not running at ${BASE} and could not be started. Ask the user to run "python server.py" in ${ROOT}.`);
  return callTool(name, input);
}
const run = (name, input) => (queue = queue.then(() => callChecked(name, input), () => callChecked(name, input)));

const WORKFLOW = `1. New design: create_project {name}. To continue an existing one: list_projects → open_project.
2. Parts: search_parts for real ICs, modules, regulators, connectors (JLCPCB catalogue) → get_part for the exact pinout. Passives (resistor, capacitor, LED, diode…) can be added by type.
3. Schematic: add_components (give x/y positions, ~150 units apart, related parts together) → connect pins with named nets (GND, +3V3, +5V are power nets) → run_erc and fix errors. Use sheets (add_sheet) for big designs.
4. Look at it: view_design {view:"schematic"} and fix crowded or confusing areas.
5. PCB: generate_pcb (board size if the user gave one) → pcb_status / run_drc → if nets are unrouted: optimize_pcb → add_copper_pour GND → run_drc. Check with view_design {view:"pcb"} and {view:"pcb_3d"}.
6. Optional: enclosure (get_enclosure / set_enclosure, or enclosure_script_help for wearables and custom cases; check with view_design {view:"enclosure"}), datasheet text (set_documentation), Gerbers (export_gerbers {out_dir}).
Tell the user what you built and what to check (footprints against datasheets, antenna keep-out, power ratings).`;

const INSTRUCTIONS = `CircuitPilot is an AI schematic + PCB designer. These tools edit the CURRENT project (see list_projects / open_project / create_project); the user sees every change live in the CircuitPilot browser app.
Workflow: search_parts → get_part for real ICs/modules (exact pinout + footprint) → add_components → connect (named nets; GND / +3V3 / +5V are power nets) → run_erc → generate_pcb → export_gerbers.
Pins are "REF.PIN" using the pin number or name. Use create_part for parts missing from the database. If the project has a knowledge folder, read it (knowledge_list / knowledge_search / knowledge_read) and follow its rules.
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
        if (input.project) { await callTool('open_project', { project: input.project }); delete input.project; }
        return out(200, { result: await run(m[1], input) });
      } catch (e) { return out(400, { error: e.message }); }
    }
    out(404, { error: 'Use GET /tools, GET /openapi.json or POST /tools/<name>' });
  }).listen(port, host, () => log(`REST API on http://${host}:${port}  (GET /tools, POST /tools/<name>, GET /openapi.json) → ${BASE}`));
}

const argv = process.argv.slice(2), hi = argv.indexOf('--http');
if (hi >= 0) startHttp(+argv[hi + 1] || 5174, argv.includes('--public') ? '0.0.0.0' : '127.0.0.1');
else startStdio();
