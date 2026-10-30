// Screenshots for the tutorial PDF (docs/tutorial/img/*.jpg), then the PDF itself (docs/CircuitPilot-Tutorial.pdf).
// Drives headless Chrome over the DevTools protocol against a running CircuitPilot server that holds the demo projects.
// Usage: node docs/tutorial/capture-tutorial.mjs [--pdf-only]   (CP_URL, default http://localhost:5199; CHROME)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..');
const IMG = path.join(HERE, 'img'), BASE = process.env.CP_URL || 'http://localhost:5199';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = 1440, H = 900, PORT = 9334, PDF_ONLY = process.argv.includes('--pdf-only');
const P = { xiao: 'tutxiao0001', nrf: 'tutnrf00002', hbc: 'tuthbc000003' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(IMG, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tut-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch { } await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = {}, listeners = {};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending[m.id]) { const p = pending[m.id]; delete pending[m.id]; m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method && listeners[m.method]) listeners[m.method](m.params);
};
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending[id] = { res, rej }; ws.send(JSON.stringify({ id, method, params })); });
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
// light theme for the screenshots (the app follows the system theme unless one was picked)
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
async function go(url) { const loaded = new Promise(r => listeners['Page.loadEventFired'] = r); await cdp('Page.navigate', { url }); await loaded; await sleep(2500); }
async function shot(name, clip) {
  await sleep(900);
  await js(`document.querySelector('#toast')?.classList.remove('on'); return 1`).catch(() => { });
  const r = await cdp('Page.captureScreenshot', Object.assign({ format: 'jpeg', quality: 82 }, clip ? { clip: Object.assign({ scale: 1 }, clip), captureBeyondViewport: false } : {}));
  fs.writeFileSync(path.join(IMG, name + '.jpg'), Buffer.from(r.data, 'base64')); console.log('saved', name);
}
const closeAll = `document.getElementById('modal')?.classList.add('hidden'); document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); document.getElementById('libPanel')?.classList.add('hidden'); document.activeElement?.blur(); return 1`;
// the drawing itself (inside the editor), 2× for sharp symbols and text
const schClip = async () => { const r = await js(`const e = document.getElementById('schSvg').getBoundingClientRect(), b = document.getElementById('sworld').getBoundingClientRect(); const x0 = Math.max(e.x, b.x - 14), y0 = Math.max(e.y, b.y - 14), x1 = Math.min(e.right, b.right + 14), y1 = Math.min(e.bottom - 40, b.bottom + 14); return [x0, y0, x1 - x0, y1 - y0]`); return { x: r[0], y: r[1], width: r[2], height: r[3], scale: 2 }; };
async function step(name, expr, wait = 600, clip) {
  if (!want(name)) return;
  try { await js(closeAll); if (expr) await js(expr); await sleep(wait); await shot(name, clip === 'sch' ? await schClip() : clip); }
  catch (e) { console.log('FAILED', name, e.message); }
}
const open = id => go(`${BASE}/?project=${id}`);
const view = v => `Model.S.schFrame = false; document.querySelector('[data-view=${v}]').click(); await new Promise(r => setTimeout(r, 700));`;

const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = n => !ONLY.length || ONLY.includes(n);
if (!PDF_ONLY) {
  await open(P.xiao);
  // first start: the AI connect window
  await step('connect-ai', `document.getElementById('btnConnect').click(); return 1`, 800);
  await step('app-overview', `${view('sch')} Sch.fit(); document.getElementById('prompt').value = 'Design a receiver: AD8310 log amp on an MSOP-DIP adapter, XIAO nRF52840 on pin headers, 1206 parts, 1-layer board for my CNC'; return 1`);
  await step('projects', `document.getElementById('btnProjects').click(); return 1`, 1200);
  await step('schematic', `${view('sch')} Sch.fit(); return 1`, 600, 'sch');
  await step('schematic-organized', `${view('sch')} document.getElementById('btnOrganize').click(); await new Promise(r => setTimeout(r, 500)); Sch.fit(); return 1`, 900, 'sch');
  await step('library', `document.getElementById('btnLibrary').click(); const q = document.getElementById('lpQ'); q.value = 'AMS1117 3.3'; q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise(r => setTimeout(r, 6000)); const row = document.querySelector('#lpRows tr'); if (row) row.click(); return 1`, 2500);
  await step('part-editor', `document.getElementById('btnNewPart').click(); return 1`, 1200);
  await step('export-menu', `${view('sch')} const b = [...document.querySelectorAll('.dd > button')].find(x => /Export/.test(x.textContent)); b.parentNode.querySelector('.ddm').style.display = 'block'; return 1`, 500);
  await js(`document.querySelectorAll('.ddm').forEach(m => m.style.display = ''); return 1`);
  await step('pcb', `${view('pcb')} Pcb.fit && Pcb.fit(); return 1`, 1200);
  await step('rules', `${view('pcb')} document.getElementById('btnRules').click(); return 1`, 900);
  await step('drc', `${view('pcb')} document.getElementById('btnDrc').click(); return 1`, 2500);
  await step('cnc-toolpaths', `${view('pcb')} document.getElementById('btnCnc').click(); await new Promise(r => setTimeout(r, 9000)); return 1`, 500);
  await step('cnc-result-2d', `document.getElementById('cncModal').classList.remove('hidden'); document.querySelector('[data-cv=r2d]').click(); return 1`, 800);
  await step('cnc-result-3d', `document.getElementById('cncModal').classList.remove('hidden'); document.querySelector('[data-cv=r3d]').click(); return 1`, 5000);
  await js(`document.querySelector('[data-cv=paths]').click(); return 1`);
  await step('settings', `document.getElementById('btnSettings').click(); return 1`, 1200);
  await step('settings-claude', `document.getElementById('btnSettings').click(); await new Promise(r => setTimeout(r, 500)); const f = [...document.querySelectorAll('fieldset legend')].find(l => /Claude Desktop/.test(l.textContent)); f && f.scrollIntoView({ block: 'center' }); return 1`, 900);
  await step('knowledge', `document.getElementById('btnKnow').click(); return 1`, 1000);

  await open(P.nrf);
  await step('pcb-routed', `${view('pcb')} Pcb.fit && Pcb.fit(); return 1`, 1500);
  await step('pcb-3d', `${view('pcb')} document.getElementById('btn3d').click(); await new Promise(r => setTimeout(r, 9000)); return 1`, 1000);
  await js(`if (document.getElementById('btn3d').classList.contains('on')) document.getElementById('btn3d').click(); return 1`);
  await step('enclosure', `${view('enc')} await new Promise(r => setTimeout(r, 9000)); return 1`, 1500);
  await step('documentation', `${view('doc')} await new Promise(r => setTimeout(r, 9000)); return 1`, 1500);

  await open(P.hbc);
  await step('enclosure-wearable', `${view('enc')} await new Promise(r => setTimeout(r, 9000)); return 1`, 1500);
  await step('schematic-sheets', `${view('sch')} Sch.fit(); return 1`, 900, 'sch');
}

// ---------- the PDF: tutorial.html printed by the same browser ----------
await go(pathToFileURL(path.join(HERE, 'tutorial.html')).href);
await sleep(1500);
const pdf = await cdp('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>', footerTemplate: '<div style="font:8px sans-serif;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span> · CircuitPilot tutorial · pcbgo.site</div>',
  marginTop: 0.5, marginBottom: 0.6, marginLeft: 0.55, marginRight: 0.55 });
const out = path.join(ROOT, 'docs', 'CircuitPilot-Tutorial.pdf');
fs.writeFileSync(out, Buffer.from(pdf.data, 'base64')); console.log('PDF', out, Math.round(fs.statSync(out).size / 1024), 'KB');
ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
