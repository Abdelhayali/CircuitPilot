// CircuitPilot PCB Bench — how well does an AI model design boards with CircuitPilot's tools?
//
// Every task runs the model in the same agent loop as the app (CircuitPilot's real engine executes its tool calls)
// and then scores the DESIGN it left behind, 0–100:
//   schematic 35  required parts (10) · required connections (15) · values (5) · ERC (5)
//   placement 15  every part placed (5) · no overlaps / outside / on holes (5) · board / edge constraints (5)
//   routing   25  routed nets / all nets; unrouted nets are listed as missing connections
//   DRC       15  no DRC errors (−25 % per error)
//   behaviour 10  ends with an answer within the step limit; −10 % per failed / malformed tool call
// Tasks without a PCB are scored on schematic + behaviour, scaled to 100.
// Design tasks start from an empty project; repair tasks start from a broken design (missing connection, unrouted
// nets, overlapping parts, DRC short, wrong value, part off the board).
//
//   node bench/pcb_bench.mjs --base http://localhost:11434/v1 --model qwen3.5:4b
//   node bench/pcb_bench.mjs --provider anthropic --model claude-sonnet-5-5 --key $ANTHROPIC_API_KEY --tools full
//   node bench/pcb_bench.mjs --base https://openrouter.ai/api/v1 --model <id> --key <key> --only D1,R2 --repeat 2
//   node bench/pcb_bench.mjs --board               (rebuild bench/results/LEADERBOARD.md from the saved runs)
import { loadEngine } from '../mcp/engine-vm.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'bench', 'results');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = k => process.argv.includes('--' + k);
// API key: --key, else the BENCH_KEY environment variable, else bench/.key (gitignored). With no --provider / --base the
// key picks the service: sk-ant-… → Anthropic, sk-or-… → OpenRouter.
const KEY = arg('key', process.env.BENCH_KEY || (() => { try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.key'), 'utf8').trim(); } catch { return ''; } })());
const PROVIDER = arg('provider', /^sk-ant-/.test(KEY) ? 'anthropic' : 'openai');
const BASE = arg('base', PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : /^sk-or-/.test(KEY) ? 'https://openrouter.ai/api/v1' : 'http://localhost:11434/v1');
const MODEL = arg('model', 'qwen3.5:4b'), TOOLSET = arg('tools', 'compact');
const ONLY = arg('only', ''), REPEAT = +arg('repeat', 1), STEPS = +arg('steps', 24), TEMP = +arg('temperature', 0), LABEL = arg('label', MODEL);
const CAP = 3000, THINK = arg('think', 'default');   // --think off: reasoning_effort none (thinking models)

fs.mkdirSync(RES, { recursive: true });
if (has('board')) { leaderboard(); process.exit(0); }

// ---------- engine (same code as the app) ----------
const ctx = loadEngine(ROOT, () => { }); const { Engine, Model, Pcb } = ctx;
const cache = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'finetune/cache/parts.json'), 'utf8')); } catch { return {}; } })();
const pw = (() => { try { return fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { return ''; } })();
// part searches: the running CircuitPilot app when it answers (http://localhost:5173), else the cached answers
Object.assign(Engine.env, { base: 'http://cp', headers: {}, myLib: () => [], savePart: async () => { }, ui: () => { },
  fetch: async u => { const p = String(u).replace(/^http:\/\/cp/, ''); try { const r = await fetch('http://localhost:5173' + p, { headers: pw ? { authorization: 'Bearer ' + pw } : {}, signal: AbortSignal.timeout(20000) }); if (r.ok) return r; } catch { } return new Response(cache[p] || '{"results":[]}', { status: cache[p] ? 200 : 404, headers: { 'content-type': 'application/json' } }); } });
// bounded effort so a run takes minutes, not hours (the same for every model)
const autoPlace0 = Pcb.autoPlace; Pcb.autoPlace = o => autoPlace0(Object.assign({}, o, { time_s: 5 }));
const LIMIT = { generate_pcb: 20, route_pcb: 20,  reroute: 30 };
const run = (n, i, mode = 'agent') => Engine.exec(n, Object.assign({}, i, LIMIT[n] ? { time_limit_s: Math.min(+(i && i.time_limit_s) || 1e9, LIMIT[n]) } : {}), mode);
const toolList = mode => (TOOLSET === 'full' ? Engine.TOOLS.filter(t => !t.web) : Engine.LITE.tools()).filter(t => mode === 'agent' || t.ro);
const systemFor = mode => Engine.LITE.system + '\n\n' + Engine.LITE.mode[mode] + '\n\n' + Engine.designContext();

// ---------- design helpers for fixtures and checks ----------
const S = () => Model.S;
const val = v => { const m = /^([\d.]+)\s*([kKmMuUµnNpPrR]?)/.exec(String(v || '').replace(',', '.')); if (!m) return NaN; return +m[1] * ({ k: 1e3, K: 1e3, M: 1e6, m: 1e-3, u: 1e-6, U: 1e-6, 'µ': 1e-6, n: 1e-9, N: 1e-9, p: 1e-12, P: 1e-12 }[m[2]] || 1); };
const near = (a, b, t) => isFinite(a) && Math.abs(a - b) / b <= t;
const text = c => { const l = S().lib[c.lcsc] || S().lib[c.dbfp] || {}; return `${c.type} ${c.value} ${c.footprint} ${l.name || ''} ${l.package || ''} ${l.category || ''} ${l.footprint && l.footprint.name || ''}`.toUpperCase(); };
// what a part is, also for database / library parts (type "part"): from its reference letter and name
const kindOf = c => {
  if (c.type !== 'part') return c.type;
  const t = text(c), p = String(c.ref).replace(/\d+$/, '').toUpperCase();
  if (p === 'LED' || /LED/.test(t)) return 'led';
  if (p === 'R' || /RESISTOR/.test(t)) return 'resistor';
  if (p === 'C' || /CAPACITOR|MLCC/.test(t)) return 'capacitor';
  if (p === 'L' || /INDUCTOR|FERRITE/.test(t)) return 'inductor';
  if (/MOSFET|AO3400|SI2302|2N7002|N-CH/.test(t)) return 'nmos';
  if (/NPN|3904|8050|2222|BC8[0-9]7/.test(t)) return 'npn';
  if (p === 'D' || /DIODE|1N4148|1N400|SS1\d|SCHOTTKY/.test(t)) return 'diode';
  if (p === 'J' || p === 'P' || p === 'CN' || p === 'H' || p === 'HDR' || /HEADER|HDR|CONN|TERMINAL|JST|PZ254|PIN ?HEADER|2\.54/.test(t)) return 'connector';
  if (p === 'SW' || /SWITCH|BUTTON|TACT/.test(t)) return 'switch';
  return 'part';
};
const find = (re, type) => S().components.filter(c => (!type || [].concat(type).includes(kindOf(c)) || [].concat(type).includes(c.type)) && (!re || re.test(text(c))));
// the net on a pin, by pin number or name ("1", "A", "VOUT"); null when unconnected
const netOf = (c, pin) => {
  if (!c) return null;
  const d = Model.summary().components.find(x => x.ref === c.ref); if (!d) return null;
  for (const tk of String(d.pins).split(' ')) { const m = /^([^:]+):([^=]*)=(.*)$/.exec(tk); if (m && (m[1] === String(pin) || m[2].toUpperCase() === String(pin).toUpperCase())) return m[3] || null; }
  return null;
};
const pinsOn = n => S().nets[n] || [];
const isGnd = n => !!n && Model.isGround(n), isSupply = n => !!n && Model.isPower(n) && !Model.isGround(n);
const twoPinNets = c => [netOf(c, '1'), netOf(c, '2')];
const ercIssues = () => Model.erc().filter(i => i.level !== 'info');
const hasPcb = () => S().board.w > 0 && Pcb.placed().length > 0;

// fixtures: designs the repair tasks start from
async function fxLed(pcb) {
  Model.load(Model.blank());
  await run('add_components', { components: [{ type: 'connector', value: 'PWR', pins: ['VIN', 'GND'], x: 100, y: 100 }, { type: 'resistor', value: '330', x: 250, y: 100 }, { type: 'led', value: 'RED', x: 400, y: 100 }, { type: 'capacitor', value: '100n', x: 250, y: 220 }] });
  await run('connect', { connections: [{ net: '+5V', pins: ['J1.VIN', 'R1.1', 'C1.1'] }, { net: 'LED_A', pins: ['R1.2', 'D1.A'] }, { net: 'GND', pins: ['D1.K', 'J1.GND', 'C1.2'] }] });
  if (pcb) await run('generate_pcb', { board_width: 25, board_height: 20 });
}
const blank = async () => Model.load(Model.blank());

// ---------- the tasks ----------
// parts: [label, () => bool] · links: [label, () => bool] · values: [label, () => bool] · board: [label, () => bool]
const ledChain = (supplyRe) => ['LED in series with a resistor between a supply and GND', () => find(null, 'led').some(d => { const a = netOf(d, 'A') || netOf(d, '2'), k = netOf(d, 'K') || netOf(d, '1'); if (!a || !isGnd(k)) return false; return find(null, 'resistor').some(r => { const [n1, n2] = twoPinNets(r); return (n1 === a && isSupply(n2) && (!supplyRe || supplyRe.test(n2))) || (n2 === a && isSupply(n1) && (!supplyRe || supplyRe.test(n1))); }); })];
const TASKS = [
  { id: 'D1', kind: 'design', setup: blank, pcb: true, prompt: 'Make a 5 V power indicator: a green LED with its series resistor fed from a 2-pin input header, and make the PCB.',
    parts: [['LED', () => find(null, 'led').length >= 1], ['resistor', () => find(null, 'resistor').length >= 1], ['input header', () => find(null, 'connector').length >= 1 || find(/HEADER|CONN/).length >= 1]],
    links: [ledChain()], values: [['LED resistor gives 5–20 mA', () => find(null, 'resistor').some(r => val(r.value) >= 150 && val(r.value) <= 680)]] },
  { id: 'D2', kind: 'design', setup: blank, pcb: true, prompt: 'Design a 3.3 V supply from a 5 V input: AMS1117-3.3 with input and output capacitors and a power LED on 3.3 V. Board 30 x 20 mm with a GND pour on both layers.',
    parts: [['AMS1117', () => find(/AMS1117/).length >= 1], ['2+ capacitors', () => find(null, ['capacitor', 'capacitor_polarized']).length >= 2], ['LED', () => find(null, 'led').length >= 1]],
    links: [['regulator input and output each have a capacitor to GND', () => { const u = find(/AMS1117/)[0]; if (!u) return false; const vin = netOf(u, 'VIN'), vo = netOf(u, 'VOUT'); const capOn = n => find(null, ['capacitor', 'capacitor_polarized']).some(c => { const [a, b] = twoPinNets(c); return (a === n && isGnd(b)) || (b === n && isGnd(a)); }); return !!vin && !!vo && vin !== vo && capOn(vin) && capOn(vo); }],
      ['regulator GND on GND', () => { const u = find(/AMS1117/)[0]; return !!u && isGnd(netOf(u, 'GND') || netOf(u, 'ADJ/GND') || netOf(u, '1')); }], ledChain()],
    board: [['30 × 20 mm', () => Math.abs(S().board.w - 30) < 0.6 && Math.abs(S().board.h - 20) < 0.6], ['GND pour top + bottom', () => ['F', 'B'].every(l => (S().pcb.pours || []).some(p => isGnd(p.net) && p.layer === l))]] },
  { id: 'D3', kind: 'design', setup: blank, pcb: true, prompt: 'NE555 astable that blinks a red LED at about 1 Hz from 9 V, on a PCB with 4 M3 mounting holes.',
    parts: [['555 timer', () => find(/555/).length >= 1], ['LED', () => find(null, 'led').length >= 1], ['timing capacitor', () => find(null, ['capacitor', 'capacitor_polarized']).length >= 1]],
    links: [['555 output drives the LED (through a resistor)', () => { const u = find(/555/)[0]; if (!u) return false; const o = netOf(u, 'OUT') || netOf(u, 'Q') || netOf(u, '3'); return !!o && find(null, 'resistor').some(r => twoPinNets(r).includes(o)); }]],
    values: [['about 1 Hz (0.5–2 Hz) from the RC values', () => { const R = find(null, 'resistor').map(r => val(r.value)).filter(isFinite), C = find(null, ['capacitor', 'capacitor_polarized']).map(c => val(c.value)).filter(x => isFinite(x) && x >= 1e-7); for (const c of C) for (const a of R) for (const b of R) { const f = 1.44 / ((a + 2 * b) * c); if (f >= 0.5 && f <= 2) return true; } return false; }]],
    board: [['4 mounting holes', () => (S().pcb.holes || []).length >= 4]] },
  { id: 'D4', kind: 'design', setup: blank, pcb: true, prompt: 'I2C sensor board: an SHT40 (or similar) with 100 nF decoupling, 4.7k pull-ups on SDA and SCL and a 4-pin header (3V3, GND, SDA, SCL) on the board edge. Make the PCB.',
    parts: [['sensor IC', () => S().components.some(c => kindOf(c) === 'part')], ['2 pull-ups', () => find(null, 'resistor').length >= 2], ['decoupling cap', () => find(null, 'capacitor').length >= 1], ['header', () => find(null, 'connector').length >= 1 || find(/HEADER|CONN/).length >= 1]],
    links: [['SDA and SCL each reach the sensor, a pull-up and the header', () => ['SDA', 'SCL'].every(n => Object.keys(S().nets).some(k => k.toUpperCase().includes(n) && pinsOn(k).length >= 3))]],
    values: [['pull-ups 2.2k–10k', () => find(null, 'resistor').filter(r => val(r.value) >= 2.2e3 && val(r.value) <= 10e3).length >= 2]],
    board: [['header on the board edge', () => { const j = find(null, 'connector')[0] || find(/HEADER|CONN/)[0]; if (!j || !j.pcb) return false; const m = Pcb.partMargin(j); return m.body_mm < 2.5; }]] },
  { id: 'D5', kind: 'design', setup: blank, pcb: true, prompt: 'Relay driver: switch a 12 V relay coil from a 3.3 V GPIO with an NPN transistor, base resistor and flyback diode. Coil and GPIO on headers. Make the board.',
    parts: [['NPN', () => find(null, 'npn').length >= 1 || find(/3904|8050|2222|BC8|NPN/).length >= 1], ['base resistor', () => find(null, 'resistor').length >= 1], ['flyback diode', () => find(null, ['diode', 'schottky']).length >= 1 || find(/4148|4007|SS1|DIODE/).length >= 1]],
    links: [['emitter on GND', () => { const q = find(null, 'npn')[0] || find(/3904|8050|2222|NPN/)[0]; return !!q && isGnd(netOf(q, 'E') || netOf(q, '2')); }], ['diode across the coil (cathode to +12V side)', () => find(null, ['diode', 'schottky']).some(d => { const k = netOf(d, 'K') || netOf(d, '1'), a = netOf(d, 'A') || netOf(d, '2'); const q = find(null, 'npn')[0]; return isSupply(k) && !!q && a === (netOf(q, 'C') || netOf(q, '3')); })]] },
  { id: 'D6', kind: 'design', setup: blank, pcb: true, prompt: 'Non-inverting op-amp amplifier with a gain of 10 on a single 5 V supply, input and output on headers, with supply decoupling. Make the PCB.',
    parts: [['op-amp', () => find(null, 'opamp').length >= 1 || find(/358|MCP60|LMV|OPA|TLV|TL07/).length >= 1], ['feedback resistors', () => find(null, 'resistor').length >= 2], ['decoupling', () => find(null, 'capacitor').length >= 1]],
    links: [['op-amp powered (V+ on a supply, V- on GND)', () => { const u = find(null, 'opamp')[0]; // by pin name first (a real part, e.g. a SOT-23-5 op-amp, has other pin numbers), else the generic 8-pin 7 / 4
      const pos = ['V+', 'VCC', 'VDD', 'VS+', '+VS'].map(n => netOf(u, n)).find(Boolean) || netOf(u, '7'), neg = ['V-', 'VEE', 'VSS', 'GND', 'VS-', '-VS'].map(n => netOf(u, n)).find(Boolean) || netOf(u, '4');
      return !!u && isSupply(pos) && isGnd(neg); }]],
    values: [['gain 10 (±15 %)', () => { const r = find(null, 'resistor').map(c => val(c.value)); return r.some(a => r.some(b => a !== b && near(1 + a / b, 10, 0.15))); }]] },
  { id: 'D7', kind: 'design', setup: blank, pcb: true, prompt: 'Sensor node: 5 V in on a 2-pin header, AMS1117-3.3 regulator with capacitors, an I2C temperature sensor (SHT40 or BME280) with pull-ups and decoupling, and a status LED on 3.3 V. Board 35 x 25 mm, GND pour on both layers.',
    parts: [['regulator', () => find(/AMS1117|LDO|REG/).length >= 1], ['sensor', () => S().components.filter(c => kindOf(c) === 'part').length >= 2], ['LED', () => find(null, 'led').length >= 1], ['3+ capacitors', () => find(null, ['capacitor', 'capacitor_polarized']).length >= 3]],
    links: [['SDA / SCL pulled up and wired', () => ['SDA', 'SCL'].every(n => Object.keys(S().nets).some(k => k.toUpperCase().includes(n) && pinsOn(k).length >= 2))], ledChain(/3V3|3\.3/)],
    board: [['35 × 25 mm', () => Math.abs(S().board.w - 35) < 0.6 && Math.abs(S().board.h - 25) < 0.6], ['GND pour top + bottom', () => ['F', 'B'].every(l => (S().pcb.pours || []).some(p => isGnd(p.net) && p.layer === l))]] },
  { id: 'D8', kind: 'design', setup: blank, pcb: false, prompt: 'Schematic only: a divider from 12 V to about 3 V for an ADC, followed by an RC low-pass at about 100 Hz, output on a header.',
    parts: [['3+ resistors or 2 + 1 cap', () => find(null, 'resistor').length >= 2 && find(null, 'capacitor').length >= 1]],
    links: [['divider middle feeds the filter', () => find(null, 'capacitor').some(c => { const [a, b] = twoPinNets(c); return (isGnd(a) || isGnd(b)); })]],
    values: [['divider ratio ≈ 0.25', () => { const r = find(null, 'resistor').map(c => val(c.value)); return r.some(a => r.some(b => a !== b && near(b / (a + b), 0.25, 0.15))); }], ['fc 50–200 Hz', () => { const r = find(null, 'resistor').map(c => val(c.value)), c = find(null, 'capacitor').map(x => val(x.value)); return r.some(a => c.some(b => { const f = 1 / (2 * Math.PI * a * b); return f >= 50 && f <= 200; })); }]] },
  // --- repairs
  { id: 'R1', kind: 'repair', pcb: false, prompt: 'ERC reports problems in my schematic. Find them and fix the circuit.', setup: async () => { await fxLed(false); await run('disconnect', { pins: ['D1.A'] }); },
    parts: [['LED still there', () => find(null, 'led').length >= 1]], links: [ledChain()] },
  { id: 'R2', kind: 'repair', pcb: true, prompt: 'Some nets on my PCB are not routed. Finish the routing.', setup: async () => { await fxLed(true); await run('remove_tracks', { net: 'LED_A' }); await run('remove_tracks', { net: '+5V' }); },
    parts: [['parts kept', () => S().components.length >= 4]], links: [ledChain()] },
  { id: 'R3', kind: 'repair', pcb: true, prompt: 'Parts overlap on my PCB. Fix the placement and make sure everything is still routed and DRC clean.', setup: async () => { await fxLed(true); const d = Model.comp('D1'), r = Model.comp('R1'); Model.mutate(() => { r.pcb.x = d.pcb.x + 0.3; r.pcb.y = d.pcb.y; }); },
    parts: [['parts kept', () => S().components.length >= 4]], links: [ledChain()] },
  { id: 'R4', kind: 'repair', pcb: true, prompt: 'DRC shows an error on my board. Make the board DRC clean.', setup: async () => { await fxLed(true); const pr = Pcb.padsOf(Model.comp('R1')), pd = Pcb.padsOf(Model.comp('D1')); await run('add_track', { net: 'GND', points: [[pr[0].x, pr[0].y + 0.05], [pd[1].x, pd[1].y]], layer: 'top' }).catch(() => { }); },
    parts: [['parts kept', () => S().components.length >= 4]], links: [ledChain()] },
  { id: 'R5', kind: 'repair', pcb: false, prompt: 'My LED gets very hot and dim after a while. Check the circuit and fix it (5 V supply, red LED, about 10 mA).', setup: async () => { await fxLed(false); await run('update_component', { ref: 'R1', value: '10' }); },
    parts: [['LED still there', () => find(null, 'led').length >= 1]], links: [ledChain()], values: [['resistor for ~10 mA (220–470 Ω)', () => find(null, 'resistor').some(r => val(r.value) >= 220 && val(r.value) <= 470)]] },
  { id: 'R6', kind: 'repair', pcb: true, prompt: 'One part is outside my board outline. Fix the PCB.', setup: async () => { await fxLed(true); const j = Model.comp('J1'); Model.mutate(() => { j.pcb.x = S().board.w + 6; }); },
    parts: [['parts kept', () => S().components.length >= 4]], links: [ledChain()] },
];

// ---------- scoring ----------
function score(t, final, stats) {
  const frac = list => list && list.length ? list.filter(([, f]) => { try { return !!f(); } catch { return false; } }).length / list.length : 1;
  const failed = list => (list || []).filter(([, f]) => { try { return !f(); } catch { return true; } }).map(([l]) => l);
  const erc = ercIssues();
  const sch = { parts: frac(t.parts), links: frac(t.links), values: frac(t.values), erc: Math.max(0, 1 - 0.25 * erc.length) };
  const out = { schematic: 10 * sch.parts + 15 * sch.links + 5 * sch.values + 5 * sch.erc, details: { erc: erc.map(i => i.msg).slice(0, 8), failed: [...failed(t.parts), ...failed(t.links), ...failed(t.values), ...failed(t.board)] } };
  const beh = stats.finished ? Math.max(0, 1 - 0.1 * (stats.errors + stats.bad)) : 0;
  out.behaviour = 10 * beh;
  if (t.pcb) {
    const placed = hasPcb() ? Pcb.placed().length : 0, total = S().components.length || 1;
    let probs = []; try { probs = hasPcb() ? Pcb.checkPlacement() : []; } catch { }
    const st = hasPcb() ? Pcb.status() : { nets: Object.keys(S().nets).length, routed: 0, unrouted: Object.keys(S().nets) };
    let drc = { errors: 99, warnings: 0 }; try { if (hasPcb()) { const d = Pcb.drc(); drc = { errors: d.violations.filter(v => v.severity === 'error').length, warnings: d.violations.filter(v => v.severity !== 'error').length, top: d.violations.filter(v => v.severity === 'error').slice(0, 5).map(v => v.msg) }; } } catch { }
    out.placement = 5 * Math.min(1, placed / total) + 5 * (hasPcb() ? Math.max(0, 1 - 0.2 * probs.length) : 0) + 5 * frac(t.board);
    out.routing = 25 * (st.nets ? st.routed / st.nets : 0);
    out.drc = hasPcb() ? 15 * Math.max(0, 1 - 0.25 * drc.errors) : 0;
    out.total = out.schematic + out.placement + out.routing + out.drc + out.behaviour;
    Object.assign(out.details, { placed: `${placed}/${total}`, placement_problems: probs.map(p => p.msg).slice(0, 6), missing_connections: st.unrouted, drc_errors: drc.errors, drc_warnings: drc.warnings, drc_top: drc.top, board: hasPcb() ? `${S().board.w} × ${S().board.h} mm` : 'none' });
  } else out.total = (out.schematic + out.behaviour) * 100 / 45;
  for (const k of ['schematic', 'placement', 'routing', 'drc', 'behaviour', 'total']) if (out[k] != null) out[k] = +out[k].toFixed(1);
  return out;
}

// ---------- model calls ----------
async function callOpenAI(system, hist, tools) {
  const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, KEY ? { authorization: 'Bearer ' + KEY } : {}),
    body: JSON.stringify({ model: MODEL, temperature: TEMP, max_tokens: 4096, ...(THINK === 'off' ? { reasoning_effort: 'none' } : {}), messages: [{ role: 'system', content: system }, ...hist.map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : m.role === 'assistant' ? Object.assign({ role: 'assistant', content: m.content || '' }, m.calls.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) } : {}) : m)],
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }), signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json(), m = j.choices[0].message;
  return { text: (m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), usage: j.usage || {}, calls: (m.tool_calls || []).map(c => { let a = null; try { a = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments; } catch { } return { id: c.id || 'c' + Math.random().toString(36).slice(2), name: c.function.name, args: a }; }) };
}
async function callAnthropic(system, hist, tools) {
  const msgs = [];
  for (const m of hist) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))] });
    else { const last = msgs[msgs.length - 1], block = { type: 'tool_result', tool_use_id: m.id, content: m.content }; if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block); else msgs.push({ role: 'user', content: [block] }); }
  }
  const r = await fetch(BASE.replace(/\/$/, '') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, temperature: TEMP, system, messages: msgs, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }), signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return { text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), usage: j.usage || {}, calls: j.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })) };
}
// --provider driver: an agent outside this process answers each step over http://localhost:8099 (bench/drive.mjs).
// It gets exactly what an API model gets (system prompt with the design, the tools, the task, tool results capped at
// 3000 characters, 24 steps); tokens are estimated from the request / reply size (characters / 3.6).
let drvWait = null, drvObs = null, drvSeen = 0, drvSys = '';
const est = x => Math.ceil(x.length / 3.6);
if (PROVIDER === 'driver') {
  const http = await import('node:http');
  http.createServer((q, res) => { let b = ''; q.on('data', d => b += d); q.on('end', async () => {
    const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (q.url === '/intro') return send({ tools: toolList('agent').map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), system: Engine.LITE.system + '\n\n' + Engine.LITE.mode.agent });
    if (q.url === '/reply' && drvWait) { const r = drvWait; drvWait = null; drvObs = null; let j; try { j = JSON.parse(b || '{}'); } catch (e) { return send({ error: 'bad JSON: ' + e.message }); } r(j); }
    for (let i = 0; i < 6000 && !drvObs; i++) await new Promise(z => setTimeout(z, 100));
    send(drvObs || { waiting: true });
  }); }).listen(8099, () => console.log('driver on http://localhost:8099'));
}
async function callDriver(system, hist, tools) {
  if (hist.length === 1) { drvSeen = 0; drvSys = ''; }
  const ctxNow = system.slice(system.indexOf(Engine.LITE.mode.agent) + Engine.LITE.mode.agent.length).trim();
  drvObs = { step: hist.filter(m => m.role === 'assistant').length, design_context: ctxNow !== drvSys ? ctxNow : undefined, messages: hist.slice(drvSeen).map(m => m.role === 'tool' ? { tool_result: m.content } : m.role === 'user' ? { user: m.content } : null).filter(Boolean) };
  drvSys = ctxNow; drvSeen = hist.length;
  const j = await new Promise(r => drvWait = r);
  const calls = (j.calls || []).map((c, i) => ({ id: 'd' + Date.now() + i, name: c.name, args: c.args && typeof c.args === 'object' ? c.args : null }));
  const req = JSON.stringify({ system, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), hist });
  return { text: String(j.text || ''), calls, usage: { prompt_tokens: est(req), completion_tokens: est(JSON.stringify(j)) } };
}
const call = PROVIDER === 'anthropic' ? callAnthropic : PROVIDER === 'driver' ? callDriver : callOpenAI;

async function runTask(t) {
  await t.setup();
  const mode = 'agent', tools = toolList(mode), hist = [{ role: 'user', content: t.prompt }], trace = [];
  const stats = { calls: 0, errors: 0, bad: 0, steps: 0, finished: false, tokens_in: 0, tokens_out: 0 }; let final = ''; const t0 = Date.now();
  for (let step = 0; step < STEPS; step++) {
    stats.steps++;
    let r; try { r = await call(systemFor(mode), hist, tools); } catch (e) { trace.push('REQUEST FAILED ' + e.message); break; }
    stats.tokens_in += r.usage.prompt_tokens || (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0); stats.tokens_out += r.usage.completion_tokens || r.usage.output_tokens || 0;
    hist.push({ role: 'assistant', content: r.text, calls: r.calls });
    if (!r.calls.length) { final = r.text; stats.finished = true; break; }
    for (const c of r.calls) {
      stats.calls++; let content;
      if (!c.args) { stats.bad++; content = 'Error: Could not parse tool arguments as JSON'; }
      else if (!tools.some(x => x.name === c.name)) { stats.bad++; content = `Error: Unknown tool ${c.name}`; }
      else { try { const out = await run(c.name, c.args, mode); content = typeof out === 'string' ? out : JSON.stringify(out); } catch (e) { content = 'Error: ' + e.message; stats.errors++; } }
      if (content.length > CAP) content = content.slice(0, CAP) + ' …(cut)';
      trace.push(`${c.name} ${JSON.stringify(c.args || {}).slice(0, 220)} → ${content.slice(0, 200)}`);
      hist.push({ role: 'tool', id: c.id, content });
    }
  }
  const sc = score(t, final, stats);
  return Object.assign({ id: t.id, kind: t.kind, seconds: Math.round((Date.now() - t0) / 1000) }, sc, { stats, final: final.slice(0, 600), trace, design: JSON.parse(Model.snapshot()) });
}

// ---------- run ----------
if (has('rescore')) {
  for (const f of fs.readdirSync(RES).filter(f => f.endsWith('.json'))) {
    const J = JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'));
    for (const r of J.results) { const t = TASKS.find(x => x.id === r.id); if (!t || !r.design) continue; Model.load(r.design); Object.assign(r, score(t, r.final, r.stats)); }
    Object.assign(J.summary, summarize(J.results, J.summary)); fs.writeFileSync(path.join(RES, f), JSON.stringify(J, null, 1)); console.log('rescored', f, J.summary.score);
  }
  leaderboard(); process.exit(0);
}
const list = TASKS.filter(t => !ONLY || ONLY.split(',').includes(t.id));
const results = [];
console.log(`CircuitPilot PCB Bench · ${LABEL} · ${PROVIDER} ${BASE} · tools ${TOOLSET} · ${list.length} tasks × ${REPEAT}`);
for (let k = 0; k < REPEAT; k++) for (const t of list) {
  const r = await runTask(t); results.push(r);
  const pcb = t.pcb ? ` place ${String(r.placement).padStart(4)} route ${String(r.routing).padStart(4)} drc ${String(r.drc).padStart(4)}` : ' '.repeat(36);
  console.log(`${t.id.padEnd(3)} ${String(r.total).padStart(5)}  sch ${String(r.schematic).padStart(4)}${pcb} beh ${String(r.behaviour).padStart(4)}  ${r.stats.calls} calls ${r.stats.errors + r.stats.bad} err ${r.seconds}s${r.details.failed.length ? '  ✗ ' + r.details.failed.join('; ') : ''}${(r.details.missing_connections || []).length ? '  unrouted: ' + r.details.missing_connections.join(',') : ''}`);
}
const summary = summarize(results, { model: LABEL, provider: PROVIDER, base: BASE, tools: TOOLSET + (THINK === 'off' ? ', no thinking' : '') + (PROVIDER === 'driver' ? ', agent driver, tokens estimated' : ''), date: new Date().toISOString().slice(0, 16) });
console.log(JSON.stringify(summary));
const file = path.join(RES, LABEL.replace(/[^\w.-]+/g, '_') + '__' + TOOLSET + (THINK === 'off' ? '_nothink' : '') + '.json');
fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
leaderboard();
process.exit(0);

function summarize(results, head) {
const avg = (k, rs = results) => { const v = rs.map(r => r[k]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null; };
const pcbRs = results.filter(r => r.routing != null);
return { ...head, tasks: results.length,
  score: avg('total'), design: avg('total', results.filter(r => r.kind === 'design')), repair: avg('total', results.filter(r => r.kind === 'repair')),
  schematic_pct: +(avg('schematic') / 35 * 100).toFixed(1), placement_pct: pcbRs.length ? +(avg('placement', pcbRs) / 15 * 100).toFixed(1) : null, routing_pct: pcbRs.length ? +(avg('routing', pcbRs) / 25 * 100).toFixed(1) : null,
  drc_clean: pcbRs.length ? `${pcbRs.filter(r => r.details.drc_errors === 0).length}/${pcbRs.length}` : null, fully_routed: pcbRs.length ? `${pcbRs.filter(r => !(r.details.missing_connections || []).length).length}/${pcbRs.length}` : null,
  tokens_in_task: Math.round(results.reduce((a, r) => a + (r.stats.tokens_in || 0), 0) / results.length), tokens_out_task: Math.round(results.reduce((a, r) => a + (r.stats.tokens_out || 0), 0) / results.length),
  tool_calls: results.reduce((a, r) => a + r.stats.calls, 0), tool_errors: results.reduce((a, r) => a + r.stats.errors + r.stats.bad, 0), minutes: +(results.reduce((a, r) => a + r.seconds, 0) / 60).toFixed(1) };
}

function leaderboard() {
  const rows = fs.readdirSync(RES).filter(f => f.endsWith('.json')).map(f => { const j = JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8')), r = j.results || [];
    // older runs: the token averages from their task results
    if (j.summary.tokens_in_task == null && r.length) { j.summary.tokens_in_task = Math.round(r.reduce((a, x) => a + (x.stats.tokens_in || 0), 0) / r.length); j.summary.tokens_out_task = Math.round(r.reduce((a, x) => a + (x.stats.tokens_out || 0), 0) / r.length); }
    return j.summary; }).sort((a, b) => b.score - a.score);
  const kt = n => n == null ? '–' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n);
  const table = ['| Model | Tools | Runs | Score | Design | Repair | Schematic % | Placement % | Routing % | DRC clean | Fully routed | Tool errors | Tokens / task (in · out) | Date |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(s => `| ${s.model} | ${s.tools} | ${s.tasks / 14 >= 1 ? Math.round(s.tasks / 14) + ' × 14' : s.tasks + ' tasks'} | **${s.score}** | ${s.design} | ${s.repair} | ${s.schematic_pct} | ${s.placement_pct} | ${s.routing_pct} | ${s.drc_clean} | ${s.fully_routed} | ${s.tool_errors}/${s.tool_calls} | ${kt(s.tokens_in_task)} · ${kt(s.tokens_out_task)} | ${String(s.date).slice(0, 10)} |`)];
  const md = ['# CircuitPilot PCB Bench — leaderboard', '', 'Each model designs and repairs boards with CircuitPilot\'s tools; the design it leaves behind is scored 0–100 per task (schematic 35, placement 15, routing 25, DRC 15, behaviour 10) and averaged. "Design" = the 8 tasks from an empty project, "Repair" = the 6 broken boards; DRC clean / fully routed count the PCB tasks. Tokens / task = average tokens sent to the model (the conversation is re-sent at every step, so this grows with the number of steps) and generated by it, per task. How to run: [bench/README.md](../README.md).', '', ...table];
  fs.writeFileSync(path.join(RES, 'LEADERBOARD.md'), md.join('\n') + '\n');
  // the same table in the main README, between its markers
  const readme = path.join(ROOT, 'README.md');
  try {
    const r = fs.readFileSync(readme, 'utf8'), nl = r.includes('\r\n') ? '\r\n' : '\n', a = r.indexOf('<!-- BENCH:START -->'), b = r.indexOf('<!-- BENCH:END -->');
    if (a >= 0 && b > a) fs.writeFileSync(readme, r.slice(0, a) + '<!-- BENCH:START -->' + nl + table.join(nl) + nl + nl + '<sub>Updated ' + new Date().toISOString().slice(0, 10) + ' · full results: [bench/results/LEADERBOARD.md](bench/results/LEADERBOARD.md)</sub>' + nl + r.slice(b));
  } catch (e) { }
  if (has('board')) console.log(md.join('\n'));
}
