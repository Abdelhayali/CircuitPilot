// Held-out evaluation: hand-written tasks (not from the training templates) run through the same agent loop as the
// app's compact mode, against any OpenAI-compatible server (Ollama, llama.cpp, Colab tunnel …). The model's tool
// calls run on the real engine; each task is scored by checking the resulting DESIGN (ERC, values, nets, board).
//
//   node finetune/eval.mjs --base http://localhost:11434/v1 --model qwen3.5:4b [--only B1,E2] [--out finetune/out/eval-base.json]
import { loadEngine } from '../mcp/engine-vm.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:11434/v1'), MODEL = arg('model', 'qwen3.5:4b'), KEY = arg('key', ''), ONLY = arg('only', ''), OUT = arg('out', '');
const STEPS = +arg('steps', 14), CAP = 3000;

const ctx = loadEngine(ROOT, () => { }); const { Engine, Model, Pcb } = ctx;
const cache = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'finetune/cache/parts.json'), 'utf8')); } catch { return {}; } })();
const pw = (() => { try { return fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { return ''; } })();
// part searches: the running app when it answers, else the data cache
Object.assign(Engine.env, { base: 'http://cp', headers: {}, myLib: () => [], savePart: async () => { }, ui: () => { },
  fetch: async u => { const p = String(u).replace(/^http:\/\/cp/, ''); try { const r = await fetch('http://localhost:5173' + p, { headers: pw ? { authorization: 'Bearer ' + pw } : {}, signal: AbortSignal.timeout(20000) }); if (r.ok) return r; } catch { } return new Response(cache[p] || '{"results":[]}', { status: cache[p] ? 200 : 404, headers: { 'content-type': 'application/json' } }); } });
const autoPlace0 = Pcb.autoPlace; Pcb.autoPlace = o => autoPlace0(Object.assign({}, o, { time_s: 3 }));
const HIDDEN = { generate_pcb: { time_limit_s: 10 }, route_pcb: { time_limit_s: 10 }, optimize_pcb: { time_limit_s: 15 } };
const LITE = Engine.LITE;
const toolsFor = mode => LITE.tools().filter(t => mode === 'agent' || t.ro).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const X = (n, i) => Engine.exec(n, Object.assign({}, i, HIDDEN[n] || {}), 'agent');

// ---------- fixtures ----------
async function ledDesign(pcb) {
  Model.load(Model.blank());
  await X('add_components', { components: [{ type: 'connector', value: 'PWR', pins: ['VIN', 'GND'], x: 100, y: 100 }, { type: 'resistor', value: '330', x: 250, y: 100 }, { type: 'led', value: 'RED', x: 400, y: 100 }] });
  await X('connect', { connections: [{ net: '+5V', pins: ['J1.VIN', 'R1.1'] }, { net: 'LED_A', pins: ['R1.2', 'D1.A'] }, { net: 'GND', pins: ['D1.K', 'J1.GND'] }] });
  if (pcb) await X('generate_pcb', { board_width: 25, board_height: 20 });
}
const blank = async () => Model.load(Model.blank());
// ---------- checks ----------
const S = () => Model.S;
// database parts (type "part") count by what they are: reference letter and name
const PFX = { resistor: /^R\d/, capacitor: /^C\d/, led: /^(D|LED)\d/, switch: /^(SW|S|K)\d/, npn: /^Q\d/, nmos: /^Q\d/, diode: /^D\d/, opamp: /^U\d/ };
const comps = t => S().components.filter(c => c.type === t || (c.type === 'part' && PFX[t] && PFX[t].test(c.ref) && (t !== 'led' || /LED/i.test(c.value + ' ' + ((S().lib[c.lcsc] || {}).name || ''))) && (t !== 'diode' || !/LED/i.test(c.value))));
const val = v => { const m = /^([\d.]+)\s*([kKmMuUnNpP]?)/.exec(String(v).replace(',', '.')); if (!m) return NaN; return +m[1] * ({ k: 1e3, K: 1e3, M: 1e6, m: 1e-3, u: 1e-6, U: 1e-6, n: 1e-9, N: 1e-9, p: 1e-12, P: 1e-12 }[m[2]] || 1); };
const ercOk = () => Model.erc().filter(i => i.level !== 'info').length === 0;
const near = (a, b, tol) => Math.abs(a - b) / b <= tol;
const routed = () => { try { const s = Pcb.status(); return S().board.w > 0 && s.placed > 0 && !s.unrouted.length; } catch { return false; } };
const hasText = (t, re) => re.test(t || '');
const anyPart = re => S().components.some(c => re.test(`${c.value} ${c.type}`));

const TASKS = [
  // build from scratch
  { id: 'B1', setup: blank, prompt: 'Add a blue LED with a series resistor running from 3.3 V, about 5 mA.', check: () => comps('led').length >= 1 && comps('resistor').some(r => val(r.value) >= 40 && val(r.value) <= 150) && ercOk() },
  { id: 'B2', setup: blank, prompt: 'voltage divider from 12V to 3.3V for an ADC input', check: () => { const r = comps('resistor').map(c => val(c.value)); return r.length >= 2 && r.some(a => r.some(b => a !== b && near(b / (a + b), 3.3 / 12, 0.1))) && ercOk(); } },
  { id: 'B3', setup: blank, prompt: 'Add an AMS1117-3.3 regulator with input and output capacitors, 5V input.', check: () => anyPart(/AMS1117/i) && comps('capacitor').length >= 2 && ercOk() },
  { id: 'B4', setup: blank, prompt: 'NE555 astable that blinks an LED at about 1 Hz', check: () => anyPart(/555/) && comps('led').length >= 1 && ercOk() },
  { id: 'B5', setup: blank, prompt: 'SHT40 humidity sensor on I2C with 4.7k pull-ups and a 4-pin header', check: () => anyPart(/SHT4/i) && (S().nets.SDA || []).length >= 3 && (S().nets.SCL || []).length >= 3 && ercOk() },
  { id: 'B6', setup: blank, prompt: 'Drive a 12V relay coil from a 3.3V GPIO with an NPN transistor and a flyback diode.', check: () => (comps('npn').length >= 1 || anyPart(/3904|8050|2222|BC8|NPN/i)) && (comps('diode').length >= 1 || anyPart(/4148|4007|SS1|diode/i)) && ercOk() },
  { id: 'B7', setup: blank, prompt: 'RC low pass filter with a 1 kHz cutoff', check: () => { const r = comps('resistor').map(c => val(c.value)), c = comps('capacitor').map(c => val(c.value)); return r.some(a => c.some(b => near(1 / (2 * Math.PI * a * b), 1000, 0.25))) && ercOk(); } },
  { id: 'B8', setup: blank, prompt: 'non-inverting amplifier with a gain of 11, single 5 V supply', check: () => { const r = comps('resistor').map(c => val(c.value)); return (comps('opamp').length >= 1 || anyPart(/358|MCP60|LMV|OPA|TLV/i)) && r.some(a => r.some(b => a !== b && near(1 + a / b, 11, 0.15))) && ercOk(); } },
  { id: 'B9', setup: blank, prompt: 'ad a grren led with resistr on 5v', check: () => comps('led').length >= 1 && comps('resistor').length >= 1 && ercOk() },
  { id: 'B10', setup: blank, prompt: 'push button input with a 10k pull-up to 3.3V and a debounce capacitor', check: () => comps('switch').length >= 1 && comps('resistor').some(r => near(val(r.value), 10e3, 0.05)) && comps('capacitor').length >= 1 && ercOk() },
  { id: 'B11', setup: blank, prompt: 'I need a MOSFET to switch a 12 V fan from my microcontroller', check: () => (comps('nmos').length >= 1 || anyPart(/3400|2302|7002|NMOS|MOSFET/i)) && ercOk() },
  // edits on an existing design
  { id: 'E1', setup: () => ledDesign(), prompt: 'change R1 to 470', check: () => near(val(Model.comp('R1') && Model.comp('R1').value), 470, 0.01) },
  { id: 'E2', setup: () => ledDesign(), prompt: 'rename the net LED_A to LED_ANODE', check: () => !!S().nets.LED_ANODE && !S().nets.LED_A },
  { id: 'E3', setup: () => ledDesign(), prompt: 'remove D1', check: () => !Model.comp('D1') },
  { id: 'E4', setup: () => ledDesign(), prompt: 'use 0805 footprints for R1 and D1', check: () => Model.comp('R1').footprint === '0805' && Model.comp('D1').footprint === '0805' },
  { id: 'E5', setup: () => ledDesign(), prompt: 'add a 100nF capacitor between +5V and GND', check: () => comps('capacitor').some(c => near(val(c.value), 100e-9, 0.01)) && ercOk() },
  { id: 'E6', setup: () => ledDesign(), prompt: 'chnage the resistor to 1k', check: () => near(val(Model.comp('R1').value), 1000, 0.01) },
  { id: 'E7', setup: () => ledDesign(), prompt: 'make the LED blue', check: () => /BLUE/i.test(Model.comp('D1').value) },
  // PCB
  { id: 'P1', setup: () => ledDesign(), prompt: 'make the pcb', check: () => routed() },
  { id: 'P2', setup: () => ledDesign(), prompt: 'make a 30x20 mm pcb', check: () => routed() && Math.abs(S().board.w - 30) < 0.6 && Math.abs(S().board.h - 20) < 0.6 },
  { id: 'P3', setup: () => ledDesign(true), prompt: 'add a GND pour on both layers', check: () => { const p = S().pcb.pours || []; return p.some(x => x.net === 'GND' && x.layer === 'F') && p.some(x => x.net === 'GND' && x.layer === 'B'); } },
  { id: 'P4', setup: () => ledDesign(true), prompt: 'make the board round, 25 mm diameter', check: () => S().board.shape && S().board.shape.type === 'ellipse' || (S().board.shape && /circle|ellipse/.test(S().board.shape.type)) },
  { id: 'P5', setup: () => ledDesign(true), prompt: 'switch to JLCPCB 4 layer rules', check: () => (S().rules || {}).preset === 'jlcpcb_4layer' || +(S().rules || {}).layers === 4 },
  { id: 'P6', setup: () => ledDesign(true), prompt: 'put J1 on the left edge of the board', check: () => Model.comp('J1').pcb && Model.comp('J1').pcb.x < S().board.w * 0.35 },
  // read-only questions (Ask mode)
  { id: 'A1', mode: 'ask', setup: () => ledDesign(), prompt: 'what value is R1?', check: (t) => hasText(t, /330/) },
  { id: 'A2', mode: 'ask', setup: () => ledDesign(), prompt: 'which pins are connected to GND?', check: (t) => hasText(t, /D1/) && hasText(t, /J1/) },
  { id: 'A3', mode: 'ask', setup: () => ledDesign(true), prompt: 'is the board fully routed?', check: (t) => hasText(t, /yes|all .*routed|fully routed|every net/i) && !hasText(t, /\bnot\b.*routed|unrouted:/i) },
  { id: 'A4', mode: 'ask', setup: () => ledDesign(), prompt: 'any ERC errors?', check: (t) => hasText(t, /pass|no (issues|errors|problems)|clean/i) },
  // no tool needed
  { id: 'T1', setup: blank, prompt: 'what resistor do I need for 20 mA at 12 V?', check: (t, tr) => hasText(t, /600|620/) && !S().components.length },
  { id: 'T2', setup: blank, prompt: 'hi', check: (t, tr) => (t || '').length > 5 && !S().components.length },
  // several steps in one request
  { id: 'M1', setup: blank, prompt: 'Make a 5V to 3.3V regulator with AMS1117 and capacitors, then make the PCB', check: () => anyPart(/AMS1117/i) && routed() },
  { id: 'M2', setup: blank, prompt: 'Build a red LED indicator for 5V and make a 25x20mm board with a GND pour', check: () => comps('led').length >= 1 && Math.abs(S().board.w - 25) < 0.6 && (S().pcb.pours || []).some(p => p.net === 'GND') },
];

// ---------- the agent loop (as js/ai.js compact mode) ----------
async function chat(messages, tools) {
  const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, KEY ? { authorization: 'Bearer ' + KEY } : {}),
    body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0, max_tokens: 3000 }), signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return (await r.json()).choices[0].message;
}
async function runTask(t) {
  await t.setup(); const mode = t.mode || 'agent', tools = toolsFor(mode), trace = [];
  const hist = [{ role: 'user', content: t.prompt }];
  let final = '', calls = 0, errors = 0, bad = 0; const t0 = Date.now();
  for (let step = 0; step < STEPS; step++) {
    const system = LITE.system + '\n\n' + LITE.mode[mode] + '\n\n' + Engine.designContext();
    let m; try { m = await chat([{ role: 'system', content: system }, ...hist], tools); } catch (e) { trace.push('REQUEST ' + e.message); break; }
    const tc = m.tool_calls || [];
    hist.push({ role: 'assistant', content: m.content || '', ...(tc.length ? { tool_calls: tc } : {}) });
    if (!tc.length) { final = (m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); break; }
    for (const c of tc) {
      calls++; let args, content;
      try { args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function.arguments || {}); } catch { args = null; }
      if (!args) { bad++; content = 'Error: Could not parse tool arguments as JSON'; }
      else if (!tools.some(x => x.function.name === c.function.name)) { bad++; content = `Error: Unknown tool ${c.function.name}`; }
      else { try { const out = await Engine.exec(c.function.name, Object.assign({}, args, HIDDEN[c.function.name] || {}), mode); content = typeof out === 'string' ? out : JSON.stringify(out); } catch (e) { content = 'Error: ' + e.message; errors++; } }
      if (content.length > CAP) content = content.slice(0, CAP) + ' …(cut)';
      trace.push(`${c.function.name}(${JSON.stringify(args).slice(0, 200)}) → ${content.slice(0, 160)}`);
      hist.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  let ok = false; try { ok = !!t.check(final, trace); } catch { ok = false; }
  return { id: t.id, ok, calls, errors, bad_calls: bad, seconds: Math.round((Date.now() - t0) / 1000), final: final.slice(0, 400), trace };
}

const list = TASKS.filter(t => !ONLY || ONLY.split(',').includes(t.id));
const res = [];
for (const t of list) { const r = await runTask(t); res.push(r); console.log(`${r.ok ? 'PASS' : 'fail'} ${t.id.padEnd(4)} ${String(r.calls).padStart(2)} calls ${r.errors} err ${r.bad_calls} bad ${r.seconds}s  ${t.prompt.slice(0, 60)}`); }
const pass = res.filter(r => r.ok).length, sum = k => res.reduce((a, r) => a + r[k], 0);
const groups = {}; for (const r of res) { const g = r.id[0]; groups[g] = groups[g] || [0, 0]; groups[g][0] += r.ok ? 1 : 0; groups[g][1]++; }
const summary = { model: MODEL, base: BASE, pass, total: res.length, rate: +(pass / res.length).toFixed(3), by_group: Object.fromEntries(Object.entries(groups).map(([g, [a, b]]) => [g, `${a}/${b}`])), tool_calls: sum('calls'), tool_errors: sum('errors'), bad_calls: sum('bad_calls'), minutes: +(sum('seconds') / 60).toFixed(1) };
console.log(JSON.stringify(summary));
if (OUT) fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify({ summary, results: res }, null, 1));
process.exit(0);
