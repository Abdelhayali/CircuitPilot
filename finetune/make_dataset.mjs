// CircuitPilot fine-tune data: tool-use conversations made by RUNNING the real engine (same code as the app), so
// every tool result in the data is exactly what CircuitPilot returns. The model sees the compact tool set and system
// prompt of the app's compact mode (Engine.LITE in js/engine.js) — train what the app serves.
//
//   node finetune/make_dataset.mjs [--n 2400] [--workers 12] [--seed 1] [--out finetune/data]
//
// Part searches go to the running CircuitPilot app (http://localhost:5173, password from access-password.txt) and are
// cached in finetune/cache/parts.json, so later runs work offline and give the same data.
import { loadEngine } from '../mcp/engine-vm.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('n', 2400), WORKERS = +arg('workers', 12), SEED = +arg('seed', 1), OUT = path.resolve(ROOT, arg('out', 'finetune/data'));
const CACHE = path.join(ROOT, 'finetune', 'cache', 'parts.json');
const RESULT_CAP = 3000;   // the app's compact mode cuts tool results to this too (js/ai.js)

// ---------------------------------------------------------------- main: split the work over worker processes
async function mainProcess() {
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  // warm the parts cache once in this process (workers then only read it)
  await warmParts();
  const per = Math.ceil(N / WORKERS), parts = [];
  for (let w = 0; w < WORKERS; w++) parts.push(new Promise((res, rej) => {
    const p = fork(fileURLToPath(import.meta.url), ['--worker', '--from', String(w * per), '--count', String(Math.min(per, N - w * per)), '--seed', String(SEED), '--out', OUT], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    p.on('exit', c => c ? rej(new Error('worker ' + w + ' exit ' + c)) : res());
  }));
  await Promise.all(parts);
  // merge, split train / validation
  const all = [];
  for (const f of fs.readdirSync(OUT).filter(f => /^part-\d+\.jsonl$/.test(f)).sort()) { for (const l of fs.readFileSync(path.join(OUT, f), 'utf8').split('\n')) if (l.trim()) all.push(l); fs.unlinkSync(path.join(OUT, f)); }
  const rnd = rng(SEED + 99); for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const nVal = Math.max(20, Math.round(all.length * 0.04));
  fs.writeFileSync(path.join(OUT, 'val.jsonl'), all.slice(0, nVal).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'train.jsonl'), all.slice(nVal).join('\n') + '\n');
  const kinds = {}; for (const l of all) { const k = JSON.parse(l).meta.kind; kinds[k] = (kinds[k] || 0) + 1; }
  console.log(`${all.length} conversations → train ${all.length - nVal}, val ${nVal}`); console.log(kinds);
  process.exit(0);
}

// ---------------------------------------------------------------- shared helpers
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }
const PART_QUERIES = {
  ldo: ['AMS1117 3.3', 'AMS1117 5.0', 'XC6206P332MR', 'ME6211C33M5G', 'RT9013-33GB', 'HT7333', 'LM1117 3.3', 'AP2112K-3.3', 'TLV75533PDBVR', 'MCP1700T-3302E/TT'],
  sensor: ['SHT40', 'BME280', 'MPU6050', 'LIS3DH', 'TMP102', 'AHT20', 'BMP280', 'MAX30205', 'INA219', 'SHT31', 'LSM6DS3', 'HDC1080', 'VEML7700', 'BH1750'],
  timer: ['NE555DR', 'NE555P', 'TLC555'],
  mosfet: ['AO3400A', 'SI2302', 'AO3401A', '2N7002'],
  bjt: ['MMBT3904', 'S8050', 'SS8050', 'MMBT2222A'],
};
async function warmParts() {
  const cache = loadCache(), pw = (() => { try { return fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { return ''; } })();
  const H = pw ? { authorization: 'Bearer ' + pw } : {};
  const get = async u => { if (cache[u]) return; try { const r = await fetch('http://localhost:5173' + u, { headers: H }); if (r.ok) cache[u] = await r.text(); } catch { } };
  // what the engine will ask: search (limit 5) and the part itself; ask through a throw-away engine so the URLs match
  const ctx = loadEngine(ROOT, () => { }); const urls = new Set();
  Object.assign(ctx.Engine.env, { base: 'http://cache', headers: {}, myLib: () => [], savePart: async () => { }, ui: () => { },
    fetch: async u => { const p = String(u).replace(/^http:\/\/cache/, ''); urls.add(p); await get(p); return new Response(cache[p] || '{"results":[]}', { status: cache[p] ? 200 : 404, headers: { 'content-type': 'application/json' } }); } });
  for (const qs of Object.values(PART_QUERIES)) for (const q of qs) {
    try { const r = await ctx.Engine.exec('search_parts', { query: q, limit: 5 }, 'agent'); for (const p of (r.results || []).filter(p => /^C\d+$/.test(p.lcsc)).slice(0, 5)) { ctx.Model.load(ctx.Model.blank()); await ctx.Engine.exec('get_part', { lcsc: p.lcsc }, 'agent').catch(() => { }); } } catch { }
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log('parts cache:', Object.keys(cache).length, 'answers');
}

// ---------------------------------------------------------------- worker
const FROM = +arg('from', 0), COUNT = +arg('count', 0);
const ctx = loadEngine(ROOT, () => { });
const { Engine, Model, Pcb } = ctx;
const cache = loadCache();
Object.assign(Engine.env, { base: 'http://cache', headers: {}, myLib: () => [], savePart: async () => { }, ui: () => { },
  fetch: async u => { const p = String(u).replace(/^http:\/\/cache/, ''); return new Response(cache[p] || '{"results":[]}', { status: cache[p] ? 200 : 404, headers: { 'content-type': 'application/json' } }); } });
// placement effort for data making only (the recorded calls are what the model should send)
const autoPlace0 = Pcb.autoPlace; Pcb.autoPlace = o => autoPlace0(Object.assign({}, o, { time_s: 2 }));
const LITE = Engine.LITE, liteTools = LITE.tools();
const toolSpec = mode => liteTools.filter(t => mode === 'agent' || t.ro).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const HIDDEN = { generate_pcb: { time_limit_s: 6 }, route_pcb: { time_limit_s: 6 }, optimize_pcb: { time_limit_s: 10 } };

class Skip extends Error { }
class Ep {
  constructor(R, mode, kind) { this.R = R; this.mode = mode; this.kind = kind; this.msgs = []; this.system = null; this.record = true; }
  user(t) {
    if (!this.record) return;
    if (!this.system) this.system = LITE.system + '\n\n' + LITE.mode[this.mode] + '\n\n' + Engine.designContext();
    this.msgs.push({ role: 'user', content: t });
  }
  // calls: [[name, args], ...] in ONE assistant message; returns the results (objects / strings, or Error)
  async call(calls, say = '') {
    const outs = [], tc = [], res = [];
    for (const [name, args] of calls) {
      let out, content;
      try { out = await Engine.exec(name, Object.assign(JSON.parse(JSON.stringify(args)), HIDDEN[name] || {}), this.mode); content = typeof out === 'string' ? out : JSON.stringify(out); }
      catch (e) { out = e; content = 'Error: ' + e.message; }
      if (content.length > RESULT_CAP) content = content.slice(0, RESULT_CAP) + ' …(cut)';
      outs.push(out); tc.push({ type: 'function', function: { name, arguments: JSON.parse(JSON.stringify(args)) } }); res.push({ role: 'tool', name, content });
    }
    if (this.record) { this.msgs.push({ role: 'assistant', content: say, tool_calls: tc }); this.msgs.push(...res); }
    return outs;
  }
  async one(name, args, say) { return (await this.call([[name, args]], say))[0]; }
  say(t) { if (this.record) this.msgs.push({ role: 'assistant', content: t }); }
  done() { return { messages: [{ role: 'system', content: this.system }, ...this.msgs], tools: toolSpec(this.mode), meta: { kind: this.kind, mode: this.mode } }; }
}
const isErr = x => x instanceof Error || (ctx.Error && x instanceof ctx.Error) || (x && typeof x === 'object' && typeof x.message === 'string' && typeof x.stack === 'string');

// ---------------------------------------------------------------- language helpers
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const nearE = (v, S = E24) => { const d = Math.pow(10, Math.floor(Math.log10(v))), m = v / d; let b = S[0]; for (const s of S.concat([10])) if (Math.abs(Math.log(s / m)) < Math.abs(Math.log(b / m))) b = s; return +(b * d).toPrecision(3); };
const nextE = (v, S = E24) => { const d = Math.pow(10, Math.floor(Math.log10(v))), m = v / d; for (const s of S.concat([10])) if (s >= m - 1e-9) return +(s * d).toPrecision(3); return 10 * d; };
const fmtR = r => r >= 1e6 ? +(r / 1e6).toPrecision(3) + 'M' : r >= 1e3 ? +(r / 1e3).toPrecision(3) + 'k' : String(+r.toPrecision(3));
const fmtC = c => c >= 1e-6 ? +(c * 1e6).toPrecision(3) + 'u' : c >= 1e-9 ? +(c * 1e9).toPrecision(3) + 'n' : +(c * 1e12).toPrecision(3) + 'p';
const ohm = r => fmtR(r) + ' Ω', farad = c => fmtC(c).replace('u', ' µ').replace(/n$/, ' n').replace(/p$/, ' p') + 'F';
const pick = (R, a) => a[Math.floor(R() * a.length)], int = (R, a, b) => a + Math.floor(R() * (b - a + 1)), chance = (R, p) => R() < p;
// the user's own style: typos, no capitals, missing letters, doubled letters, swapped letters
function typo(R, s, p = 0.45) {
  if (!chance(R, p)) return s;
  let t = chance(R, 0.5) ? s.toLowerCase() : s; const k = int(R, 1, Math.max(1, Math.round(t.length / 25)));
  for (let i = 0; i < k; i++) {
    const j = int(R, 1, Math.max(1, t.length - 2)); if (!/[a-z]/i.test(t[j])) continue;
    const op = int(R, 0, 3);
    t = op === 0 ? t.slice(0, j) + t.slice(j + 1) : op === 1 ? t.slice(0, j) + t[j] + t.slice(j) : op === 2 ? t.slice(0, j) + t[j + 1] + t[j] + t.slice(j + 2) : t.slice(0, j) + pick(R, ['a', 'e', 'i', 'o', 'n', 'r', 't']) + t.slice(j + 1);
  }
  if (chance(R, 0.3)) t = t.replace(/[.?!]$/, '');
  return t;
}
const vname = v => v === 3.3 ? '+3V3' : v === 5 ? '+5V' : v === 12 ? '+12V' : v === 9 ? '+9V' : v === 24 ? '+24V' : 'VIN';
const sx = (i, gap = 150) => 100 + i * gap;
const pinList = g => String(g.pins).split(/\s+/).map(x => { const k = x.indexOf(':'); return { num: x.slice(0, k), name: x.slice(k + 1) }; }).filter(p => p.num && p.name);
const pinRef = (U, p) => U + '.' + (/^[A-Za-z0-9_+\-]+$/.test(p.name) ? p.name : p.num);
const orderable = p => /^C\d+$/.test(p.lcsc) && !/^C99\d{6,}$/.test(p.lcsc);
const bestPart = (rs, re) => { rs = rs.filter(orderable); const ok = p => !re || re.test(p.package || ''); return rs.find(p => p.stock > 0 && p.basic && ok(p)) || rs.find(p => p.stock > 0 && ok(p)) || rs.find(p => p.basic && ok(p)) || rs.find(p => p.stock > 0) || rs.find(ok) || rs[0]; };

// ---------------------------------------------------------------- recipes: one build each, all values computed
const LEDS = { red: 2.0, green: 2.1, yellow: 2.1, blue: 3.0, white: 3.0, orange: 2.0 };
const recipes = {
  async led(ep, R) {
    const V = pick(R, [3.3, 5, 5, 9, 12]), col = pick(R, Object.keys(LEDS)), mA = pick(R, [5, 10, 10, 15, 20]), Vf = LEDS[col];
    if (V - Vf < 0.5) return recipes.led(ep, R);
    const r = nextE((V - Vf) / (mA / 1000)), fp = pick(R, ['0603', '0603', '0805', '0402']), n = vname(V), src = pick(R, ['header', 'battery', 'header']);
    const ask = pick(R, [`Add a ${col} LED with a series resistor powered from ${V} V`, `led ${col} on ${V}v with resistor, ${mA} mA`, `I need a ${col} power indicator LED for a ${V} V supply`, `Make a simple circuit: ${V}V input, ${col} LED and current limiting resistor (${mA}mA)`, `add ${col} led + resistor to ${n}`]);
    ep.user(typo(R, ask));
    const parts = [src === 'battery' ? { type: 'battery', value: V + 'V', x: sx(0), y: 100 } : { type: 'connector', value: 'PWR', pins: [n.replace('+', '') === 'VIN' ? 'VIN' : n, 'GND'], x: sx(0), y: 100 },
      { type: 'resistor', value: fmtR(r), footprint: fp, x: sx(1), y: 100 }, { type: 'led', value: col.toUpperCase(), footprint: fp, x: sx(2), y: 100 }];
    const add = await ep.one('add_components', { components: parts }, `${col[0].toUpperCase() + col.slice(1)} LED Vf ≈ ${Vf} V at ${mA} mA: R = (${V} - ${Vf}) / ${mA / 1000} = ${Math.round((V - Vf) / (mA / 1000))} Ω → ${ohm(r)} (next standard value).`);
    if (isErr(add)) throw new Skip();
    const [P, Rr, D] = add.map(a => a.ref), pp = src === 'battery' ? [P + '.1', P + '.2'] : [P + '.' + (parts[0].pins[0]), P + '.GND'];
    // sometimes the first try uses a pin name the part does not have, and the model corrects itself
    if (src !== 'battery' && chance(R, 0.12)) { const bad = await ep.one('connect', { connections: [{ net: n, pins: [P + '.VCC', Rr + '.1'] }] }); if (!isErr(bad)) throw new Skip(); }
    const c = await ep.one('connect', { connections: [{ net: n, pins: [pp[0], Rr + '.1'] }, { net: 'LED_A', pins: [Rr + '.2', D + '.A'] }, { net: 'GND', pins: [D + '.K', pp[1]] }] });
    if (isErr(c)) throw new Skip();
    return { refs: { P, R: Rr, D }, net: n, summary: `${D} (${col}) with ${Rr} = ${ohm(r)} from ${n} (${mA} mA)`, bom: [[Rr, ohm(r)], [D, col + ' LED']] };
  },
  async divider(ep, R) {
    const Vin = pick(R, [5, 12, 9, 24, 3.7]), Vout = pick(R, [3.3, 1.8, 2.5, 1.2, 1.0, 2.0].filter(v => v < Vin * 0.8)), R2 = pick(R, [10e3, 10e3, 4.7e3, 22e3, 100e3]);
    const R1 = nearE(R2 * (Vin / Vout - 1)), real = Vin * R2 / (R1 + R2);
    ep.user(typo(R, pick(R, [`Voltage divider from ${Vin} V down to ${Vout} V`, `I want ${Vout}V from ${Vin}V with a resistor divider for an ADC`, `make a divider ${Vin}v to ${Vout}v`, `add resistor divider, input ${Vin} V, output ${Vout} V, bottom resistor ${fmtR(R2)}`])));
    const add = await ep.one('add_components', { components: [{ type: 'connector', value: 'IN', pins: ['VIN', 'GND'], x: sx(0), y: 100 }, { type: 'resistor', value: fmtR(R1), x: sx(1), y: 60 }, { type: 'resistor', value: fmtR(R2), x: sx(1), y: 200 }, { type: 'connector', value: 'OUT', pins: ['VOUT', 'GND'], x: sx(2), y: 130 }] },
      `Vout = Vin · R2 / (R1 + R2). With R2 = ${ohm(R2)}: R1 = R2 · (Vin / Vout - 1) = ${Math.round(R2 * (Vin / Vout - 1))} Ω → ${ohm(R1)}, giving ${real.toFixed(2)} V.`);
    if (isErr(add)) throw new Skip();
    const [J1, Ra, Rb, J2] = add.map(a => a.ref);
    const c = await ep.one('connect', { connections: [{ net: 'VIN', pins: [J1 + '.VIN', Ra + '.1'] }, { net: 'VDIV', pins: [Ra + '.2', Rb + '.1', J2 + '.VOUT'] }, { net: 'GND', pins: [Rb + '.2', J1 + '.GND', J2 + '.GND'] }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${Ra} = ${ohm(R1)} / ${Rb} = ${ohm(R2)}: ${Vin} V → ${real.toFixed(2)} V on VDIV`, bom: [[Ra, ohm(R1)], [Rb, ohm(R2)]] };
  },
  async rc(ep, R) {
    const fc = pick(R, [100, 160, 1000, 1590, 10e3, 50, 3400]), C = pick(R, [100e-9, 10e-9, 1e-6, 47e-9]), Rv = nearE(1 / (2 * Math.PI * fc * C));
    if (Rv < 100 || Rv > 1e6) return recipes.rc(ep, R);
    const real = 1 / (2 * Math.PI * Rv * C);
    ep.user(typo(R, pick(R, [`RC low-pass filter with cutoff ${fc} Hz`, `add a low pass filter fc=${fc}Hz on the signal line`, `I need an RC filter at about ${fc >= 1000 ? fc / 1000 + ' kHz' : fc + ' Hz'}`])));
    const add = await ep.one('add_components', { components: [{ type: 'connector', value: 'SIG', pins: ['IN', 'OUT', 'GND'], x: sx(0), y: 100 }, { type: 'resistor', value: fmtR(Rv), x: sx(1), y: 100 }, { type: 'capacitor', value: fmtC(C), x: sx(2), y: 180 }] },
      `fc = 1 / (2π·R·C). With C = ${farad(C)}: R = 1 / (2π · ${fc} · ${fmtC(C)}F) ≈ ${Math.round(1 / (2 * Math.PI * fc * C))} Ω → ${ohm(Rv)} (fc ≈ ${real.toFixed(0)} Hz).`);
    if (isErr(add)) throw new Skip();
    const [J, Rr, Cc] = add.map(a => a.ref);
    const c = await ep.one('connect', { connections: [{ net: 'SIG_IN', pins: [J + '.IN', Rr + '.1'] }, { net: 'SIG_OUT', pins: [Rr + '.2', Cc + '.1', J + '.OUT'] }, { net: 'GND', pins: [Cc + '.2', J + '.GND'] }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${Rr} = ${ohm(Rv)} and ${Cc} = ${farad(C)}: fc ≈ ${real.toFixed(0)} Hz`, bom: [[Rr, ohm(Rv)], [Cc, farad(C)]] };
  },
  async npnSwitch(ep, R) {
    const load = pick(R, ['relay', 'buzzer', 'LED strip', 'motor']), V = pick(R, [5, 12, 12, 9]), Vio = pick(R, [3.3, 5]), Ic = pick(R, [50, 80, 100, 150]), beta = 100;
    const Ib = Ic / beta * 3, Rb = nearE((Vio - 0.7) / (Ib / 1000), E12), real = R => R;
    const inductive = /relay|motor/.test(load);
    ep.user(typo(R, pick(R, [`NPN transistor switch to drive a ${V} V ${load} from a ${Vio} V GPIO`, `drive a ${load} (${Ic} mA, ${V}V) with an npn from my mcu pin`, `Add a low-side transistor switch for a ${load}, ${V} V supply, control signal ${Vio} V`])));
    const comps = [{ type: 'connector', value: 'CTRL', pins: ['GPIO', 'GND'], x: sx(0), y: 200 }, { type: 'resistor', value: fmtR(Rb), x: sx(1), y: 200 }, { type: 'npn', value: 'MMBT3904', footprint: 'SOT23', x: sx(2), y: 200 },
      { type: 'connector', value: 'LOAD', pins: ['V+', 'OUT'], x: sx(3), y: 80 }];
    if (inductive) comps.push({ type: 'diode', value: '1N4148W', footprint: 'SOD123', x: sx(3), y: 160, rot: 90 });
    const add = await ep.one('add_components', { components: comps }, `Ic = ${Ic} mA, β ≈ ${beta}: drive the base with ~3× the minimum, Ib ≈ ${Ib.toFixed(1)} mA → Rb = (${Vio} - 0.7) / ${(Ib / 1000).toFixed(4)} ≈ ${Math.round((Vio - 0.7) / (Ib / 1000))} Ω → ${ohm(Rb)}.${inductive ? ' A flyback diode across the ' + load + ' protects the transistor.' : ''}`);
    if (isErr(add)) throw new Skip();
    const [J1, Rr, Q, J2, D] = add.map(a => a.ref);
    const nets = [{ net: 'GPIO', pins: [J1 + '.GPIO', Rr + '.1'] }, { net: 'Q_B', pins: [Rr + '.2', Q + '.B'] }, { net: 'GND', pins: [Q + '.E', J1 + '.GND'] }, { net: vname(V), pins: [J2 + '.V+'].concat(D ? [D + '.K'] : []) }, { net: 'LOAD_N', pins: [J2 + '.OUT', Q + '.C'].concat(D ? [D + '.A'] : []) }];
    const c = await ep.one('connect', { connections: nets }); if (isErr(c)) throw new Skip();
    return { summary: `${Q} MMBT3904 low-side switch, base resistor ${Rr} = ${ohm(Rb)}${D ? ', flyback diode ' + D : ''}`, bom: [[Rr, ohm(Rb)], [Q, 'MMBT3904']] };
  },
  async mosfet(ep, R) {
    const V = pick(R, [5, 12, 24]), load = pick(R, ['LED strip', 'fan', 'heater', 'solenoid']), Rg = pick(R, [100, 220, 47]), Rpd = pick(R, [100e3, 47e3, 10e3]);
    const inductive = /fan|solenoid/.test(load);
    ep.user(typo(R, pick(R, [`N-MOSFET low side switch for a ${V} V ${load}`, `add mosfet to switch ${load} ${V}v from gpio`, `I want to switch a ${load} with a logic-level MOSFET (${V} V)`])));
    const comps = [{ type: 'connector', value: 'CTRL', pins: ['GPIO', 'GND'], x: sx(0), y: 200 }, { type: 'resistor', value: fmtR(Rg), x: sx(1), y: 200 }, { type: 'resistor', value: fmtR(Rpd), x: sx(1), y: 300 }, { type: 'nmos', value: 'AO3400A', footprint: 'SOT23', x: sx(2), y: 200 }, { type: 'connector', value: 'LOAD', pins: ['V+', 'OUT'], x: sx(3), y: 80 }];
    if (inductive) comps.push({ type: 'diode', value: 'SS14', footprint: 'SOD123', x: sx(3), y: 160, rot: 90 });
    const add = await ep.one('add_components', { components: comps }, `AO3400A (logic level, Vgs(th) ≈ 1 V) with ${ohm(Rg)} gate resistor and ${ohm(Rpd)} pull-down so the load stays off while the GPIO floats.${inductive ? ' SS14 flyback diode for the inductive load.' : ''}`);
    if (isErr(add)) throw new Skip();
    const [J1, R1, R2, Q, J2, D] = add.map(a => a.ref);
    const c = await ep.one('connect', { connections: [{ net: 'GPIO', pins: [J1 + '.GPIO', R1 + '.1'] }, { net: 'GATE', pins: [R1 + '.2', R2 + '.1', Q + '.G'] }, { net: 'GND', pins: [R2 + '.2', Q + '.S', J1 + '.GND'] }, { net: vname(V), pins: [J2 + '.V+'].concat(D ? [D + '.K'] : []) }, { net: 'LOAD_N', pins: [J2 + '.OUT', Q + '.D'].concat(D ? [D + '.A'] : []) }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${Q} AO3400A switch with ${R1} ${ohm(Rg)} gate and ${R2} ${ohm(Rpd)} pull-down${D ? ', ' + D + ' SS14 flyback' : ''}`, bom: [[Q, 'AO3400A']] };
  },
  async opamp(ep, R) {
    const G = pick(R, [2, 5, 10, 11, 21, 3]), Rg = pick(R, [10e3, 1e3, 4.7e3]), Rf = nearE(Rg * (G - 1)), real = 1 + Rf / Rg, V = pick(R, [5, 3.3, 12]);
    ep.user(typo(R, pick(R, [`Non-inverting op-amp amplifier with gain ${G}`, `opamp gain of ${G}, single ${V}V supply`, `add a non inverting amp x${G} for a sensor signal`])));
    const add = await ep.one('add_components', { components: [{ type: 'opamp', value: 'LM358', x: sx(2), y: 150 }, { type: 'resistor', value: fmtR(Rf), x: sx(2), y: 50 }, { type: 'resistor', value: fmtR(Rg), x: sx(1), y: 260 }, { type: 'capacitor', value: '100n', x: sx(3), y: 260 }, { type: 'connector', value: 'IO', pins: ['IN', 'OUT', 'VCC', 'GND'], x: sx(0), y: 150 }] },
      `Gain = 1 + Rf / Rg. Rg = ${ohm(Rg)} → Rf = ${Math.round(Rg * (G - 1))} Ω → ${ohm(Rf)} (gain ${real.toFixed(2)}), 100 nF decoupling on the supply.`);
    if (isErr(add)) throw new Skip();
    const [U, Rf_, Rg_, C, J] = add.map(a => a.ref);
    const c = await ep.one('connect', { connections: [{ net: 'SIG_IN', pins: [J + '.IN', U + '.3'] }, { net: 'FB', pins: [U + '.2', Rf_ + '.1', Rg_ + '.1'] }, { net: 'AMP_OUT', pins: [U + '.6', Rf_ + '.2', J + '.OUT'] }, { net: vname(V), pins: [U + '.7', C + '.1', J + '.VCC'] }, { net: 'GND', pins: [U + '.4', Rg_ + '.2', C + '.2', J + '.GND'] }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${U} LM358 non-inverting, ${Rf_} = ${ohm(Rf)}, ${Rg_} = ${ohm(Rg)} (gain ${real.toFixed(2)}), ${C} 100 nF`, bom: [[U, 'LM358']] };
  },
  async button(ep, R) {
    const V = pick(R, [3.3, 5]), Rp = pick(R, [10e3, 4.7e3, 10e3]), deb = chance(R, 0.5);
    ep.user(typo(R, pick(R, [`Push button with a ${fmtR(Rp)} pull-up to ${V} V${deb ? ' and an RC debounce' : ''}`, `add a button input for my mcu${deb ? ' with debounce cap' : ''}`, `tactile switch to GPIO, pullup ${fmtR(Rp)}`])));
    const comps = [{ type: 'switch', value: 'TACT', x: sx(1), y: 200 }, { type: 'resistor', value: fmtR(Rp), x: sx(1), y: 60 }, { type: 'connector', value: 'MCU', pins: ['VCC', 'BTN', 'GND'], x: sx(0), y: 120 }];
    if (deb) comps.push({ type: 'capacitor', value: '100n', x: sx(2), y: 200 });
    const add = await ep.one('add_components', { components: comps }, `Button to GND with a ${ohm(Rp)} pull-up${deb ? ' and 100 nF across the switch (τ = ' + (Rp * 100e-9 * 1000).toFixed(1) + ' ms debounce)' : ''}; the input reads low when pressed.`);
    if (isErr(add)) throw new Skip();
    const [SW, Rr, J, C] = add.map(a => a.ref);
    const c = await ep.one('connect', { connections: [{ net: vname(V), pins: [Rr + '.1', J + '.VCC'] }, { net: 'BTN', pins: [Rr + '.2', SW + '.1', J + '.BTN'].concat(C ? [C + '.1'] : []) }, { net: 'GND', pins: [SW + '.2', J + '.GND'].concat(C ? [C + '.2'] : []) }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${SW} to GND, ${Rr} ${ohm(Rp)} pull-up on BTN${C ? ', ' + C + ' 100 nF debounce' : ''}`, bom: [[SW, 'tactile switch']] };
  },
  // --- real database parts: search, read the pins, build with those names
  async ldo(ep, R) {
    const q = pick(R, PART_QUERIES.ldo), Vin = pick(R, [5, 5, 12, 9, 3.7]);
    ep.user(typo(R, pick(R, [`Add a ${/5\.0/.test(q) ? '5 V' : '3.3 V'} regulator (${q.split(' ')[0]}) with input and output capacitors, input ${Vin} V`, `need ${q} regulator circuit`, `3v3 ldo from ${Vin}V please, use ${q.split(' ')[0]}`])));
    const s = await ep.one('search_parts', { query: q, limit: 5 }); if (isErr(s) || !(s.results || []).length) throw new Skip();
    const best = bestPart(s.results); if (!best) throw new Skip();
    const g = await ep.one('get_part', { lcsc: best.lcsc }, `${best.part} (${best.lcsc}${best.basic ? ', Basic part' : ''}${best.stock ? ', ' + best.stock + ' in stock' : ''}). Reading its pins:`); if (isErr(g)) throw new Skip();
    const PL = pinList(g), pins = PL.map(p => p.name), role = n => /^(VIN|IN|VI|INPUT)$/i.test(n) ? 'in' : /^(VOUT|OUT|VO|OUTPUT)$/i.test(n) ? 'out' : /^(GND|VSS|ADJ\/GND|GND\/ADJ|EP|PAD)$/i.test(n) ? 'gnd' : /^(EN|CE|ON\/OFF|SHDN|EN\/)/i.test(n) ? 'en' : /^(NC|N\.C\.|DNC)$/i.test(n) ? 'nc' : /BP|BYP/i.test(n) ? 'bp' : null;
    if (pins.some(p => !role(p)) || !pins.some(p => role(p) === 'in') || !pins.some(p => role(p) === 'out')) throw new Skip();
    const names = [...new Set(pins)], vt = (best.part + ' ' + q).toUpperCase(), Vout = /5\.0|5V0|-50(?![0-9])/.test(vt) ? 5 : /1\.8|-18(?![0-9])/.test(vt) ? 1.8 : 3.3, out = vname(Vout);
    const add = await ep.one('add_components', { components: [{ lcsc: best.lcsc, x: sx(2), y: 120 }, { type: 'capacitor', value: '10u', footprint: '0805', x: sx(1), y: 220 }, { type: 'capacitor', value: '10u', footprint: '0805', x: sx(3), y: 220 }, { type: 'connector', value: 'PWR', pins: ['VIN', 'GND'], x: sx(0), y: 120 }].concat(names.some(n => role(n) === 'bp') ? [{ type: 'capacitor', value: '10n', x: sx(2), y: 260 }] : []) },
      `Pins: ${g.pins}. 10 µF in and out (ceramic, 0805) as the datasheet suggests${names.some(n => role(n) === 'en') ? '; EN tied to VIN so it is always on' : ''}.`);
    if (isErr(add)) throw new Skip();
    const [U, Ci, Co, J, Cb] = add.map(a => a.ref), by = r => [...new Set(PL.filter(p => role(p.name) === r).map(p => pinRef(U, p)))];
    const conns = [{ net: 'VIN', pins: [J + '.VIN', Ci + '.1', ...by('in'), ...by('en')] }, { net: out, pins: [Co + '.1', ...by('out')] }, { net: 'GND', pins: [J + '.GND', Ci + '.2', Co + '.2', ...by('gnd')].concat(Cb ? [Cb + '.2'] : []) }];
    if (Cb) conns.push({ net: 'LDO_BP', pins: [Cb + '.1', ...by('bp')] });
    if (!by('gnd').length) throw new Skip();
    const c = await ep.one('connect', { connections: conns }); if (isErr(c)) throw new Skip();
    return { summary: `${U} ${best.part} (${best.lcsc}) → ${out}, ${Ci}/${Co} 10 µF`, bom: [[U, best.part + ' ' + best.lcsc]], net: out };
  },
  async sensor(ep, R) {
    const q = pick(R, PART_QUERIES.sensor), V = 3.3;
    ep.user(typo(R, pick(R, [`Add a ${q} sensor on I2C with pull-ups and a 4-pin header`, `${q} breakout: sensor, decoupling, i2c pullups, header`, `put a ${q} on the board (I2C, 3.3V)`])));
    const s = await ep.one('search_parts', { query: q, limit: 5 }); if (isErr(s) || !(s.results || []).length) throw new Skip();
    const best = bestPart(s.results); if (!best) throw new Skip();
    const g = await ep.one('get_part', { lcsc: best.lcsc }, `${best.part} (${best.lcsc}, ${best.package}). Reading its pins:`); if (isErr(g)) throw new Skip();
    const PL = pinList(g), pins = [...new Set(PL.map(p => p.name))];
    const role = n => /^(VDD|VCC|VDDIO|VIN|V\+|VS|VDD_IO|VDDA|VBUS)$/i.test(n) ? 'vcc' : /^(GND|VSS|EP|PAD|GND\d|VSSA|AGND|DGND)$/i.test(n) ? 'gnd' : /^(SDA|SDI|SDA\/SDI|SDI\/SDA|SDA\/SDO)$/i.test(n) ? 'sda' : /^(SCL|SCK|SCL\/SCK|SCL\/SPC|SPC)$/i.test(n) ? 'scl'
      : /^(CS|CSB|NCS)$/i.test(n) ? 'vcc' : /^(SDO|AD0|ADD0|ADD1|ADDR|ADDR0|A0|A1|A2|SA0|SDO\/SA0|ADR)$/i.test(n) ? 'gnd' : /^(INT|INT1|INT2|DRDY|ALERT|OS|RDY|INT\/DRDY)$/i.test(n) ? 'int' : /^(NC|N\.C\.|DNC|RESV|RES)$/i.test(n) ? 'nc' : null;
    if (pins.some(p => !role(p)) || !pins.some(p => role(p) === 'sda') || !pins.some(p => role(p) === 'scl') || !pins.some(p => role(p) === 'vcc') || !pins.some(p => role(p) === 'gnd')) throw new Skip();
    const hasInt = pins.some(p => role(p) === 'int');
    const add = await ep.one('add_components', { components: [{ lcsc: best.lcsc, x: sx(2), y: 150 }, { type: 'capacitor', value: '100n', x: sx(3), y: 250 }, { type: 'resistor', value: '4.7k', x: sx(1), y: 40 }, { type: 'resistor', value: '4.7k', x: sx(1) + 60, y: 40 }, { type: 'connector', value: 'I2C', pins: ['3V3', 'GND', 'SDA', 'SCL'].concat(hasInt ? ['INT'] : []), x: sx(0), y: 150 }] },
      `Pins: ${g.pins}. 100 nF decoupling at VDD, 4.7 kΩ pull-ups on SDA/SCL; address / mode pins tied to fixed levels${hasInt ? ', the interrupt pin to the header' : ''}.`);
    if (isErr(add)) throw new Skip();
    const [U, C, R1, R2, J] = add.map(a => a.ref), by = r => [...new Set(PL.filter(p => role(p.name) === r).map(p => pinRef(U, p)))];
    const conns = [{ net: '+3V3', pins: [J + '.3V3', C + '.1', R1 + '.1', R2 + '.1', ...by('vcc')] }, { net: 'GND', pins: [J + '.GND', C + '.2', ...by('gnd')] }, { net: 'SDA', pins: [J + '.SDA', R1 + '.2', ...by('sda')] }, { net: 'SCL', pins: [J + '.SCL', R2 + '.2', ...by('scl')] }];
    if (hasInt) conns.push({ net: 'SENSOR_INT', pins: [J + '.INT', ...by('int')] });
    if (chance(R, 0.15)) { const bad = await ep.one('connect', { connections: [{ net: 'SDA', pins: [U + '.SDATA', R1 + '.2'] }] }); if (!isErr(bad)) throw new Skip(); }
    const c = await ep.one('connect', { connections: conns }); if (isErr(c)) throw new Skip();
    return { summary: `${U} ${best.part} (${best.lcsc}) on I2C (SDA/SCL with ${R1}/${R2} 4.7 kΩ), ${C} 100 nF, header ${J}`, bom: [[U, best.part + ' ' + best.lcsc]] };
  },
  async timer555(ep, R) {
    const f = pick(R, [1, 2, 5, 10, 100, 1000, 0.5]), C = f >= 100 ? 10e-9 : f >= 5 ? 1e-6 : 10e-6, R1 = pick(R, [1e3, 10e3, 4.7e3]);
    const R2 = nearE(Math.max(1e3, (1.44 / (f * C) - R1) / 2)), real = 1.44 / ((R1 + 2 * R2) * C), V = pick(R, [5, 9, 12]);
    ep.user(typo(R, pick(R, [`555 astable blinker at about ${f} Hz driving an LED, ${V} V supply`, `make 555 oscillator ${f}Hz`, `Design a NE555 flasher (${f} Hz) with an LED output`])));
    const s = await ep.one('search_parts', { query: pick(R, PART_QUERIES.timer), limit: 5 }); if (isErr(s) || !(s.results || []).length) throw new Skip();
    const best = bestPart(s.results, /SOIC|SOP/i) || bestPart(s.results); if (!best) throw new Skip();
    const g = await ep.one('get_part', { lcsc: best.lcsc }); if (isErr(g)) throw new Skip();
    const PL = pinList(g);
    const find = re => PL.find(p => re.test(p.name.replace(/[~{}]/g, '')));
    const P = { gnd: find(/^GND$/i), trig: find(/^(TRIG|TR|TRIGGER)/i), out: find(/^(OUT|Q|OUTPUT)/i), rst: find(/^(RESET|RST|R|RES)$/i), ctrl: find(/^(CONT|CTRL|CV|CON|CONTROL)/i), thr: find(/^(THRES|THR|THRESHOLD|TH)/i), dis: find(/^(DISCH|DIS|DISCHARGE|D)$/i), vcc: find(/^(VCC|V\+|VDD)/i) };
    if (Object.values(P).some(v => !v)) throw new Skip();
    const rl = nextE((V - 2) / 0.01);
    const add = await ep.one('add_components', { components: [{ lcsc: best.lcsc, x: sx(2), y: 150 }, { type: 'resistor', value: fmtR(R1), x: sx(1), y: 60 }, { type: 'resistor', value: fmtR(R2), x: sx(1), y: 160 }, { type: 'capacitor', value: fmtC(C), x: sx(1), y: 280 }, { type: 'capacitor', value: '10n', x: sx(3), y: 280 }, { type: 'resistor', value: fmtR(rl), x: sx(3), y: 100 }, { type: 'led', value: 'RED', x: sx(4), y: 150 }, { type: 'connector', value: 'PWR', pins: ['VCC', 'GND'], x: sx(0), y: 150 }] },
      `f = 1.44 / ((R1 + 2·R2)·C). R1 = ${ohm(R1)}, C = ${farad(C)} → R2 ≈ ${ohm(R2)} (f ≈ ${real < 10 ? real.toFixed(2) : real.toFixed(0)} Hz). LED resistor ${ohm(rl)} for ~10 mA.`);
    if (isErr(add)) throw new Skip();
    const [U, Ra, Rb, Ct, Cc, Rl, D, J] = add.map(a => a.ref), u = p => pinRef(U, p), Vn = vname(V);
    const c = await ep.one('connect', { connections: [{ net: Vn, pins: [J + '.VCC', u(P.vcc), u(P.rst), Ra + '.1'] }, { net: 'DIS', pins: [Ra + '.2', Rb + '.1', u(P.dis)] }, { net: 'THR', pins: [Rb + '.2', Ct + '.1', u(P.thr), u(P.trig)] }, { net: 'CV', pins: [Cc + '.1', u(P.ctrl)] }, { net: 'OUT', pins: [u(P.out), Rl + '.1'] }, { net: 'LED_A', pins: [Rl + '.2', D + '.A'] }, { net: 'GND', pins: [J + '.GND', u(P.gnd), Ct + '.2', Cc + '.2', D + '.K'] }] });
    if (isErr(c)) throw new Skip();
    return { summary: `${U} ${best.part} astable at ≈ ${real < 10 ? real.toFixed(2) : real.toFixed(0)} Hz (R1 ${ohm(R1)}, R2 ${ohm(R2)}, C ${farad(C)}), LED ${D} with ${Rl}`, bom: [[U, best.part]] };
  },
};
const RECIPE_W = [['led', 4], ['divider', 2], ['rc', 2], ['npnSwitch', 2], ['mosfet', 2], ['opamp', 2], ['button', 2], ['ldo', 3], ['sensor', 3], ['timer555', 2]];
const pickRecipe = R => { let t = RECIPE_W.reduce((a, x) => a + x[1], 0) * R(); for (const [k, w] of RECIPE_W) { t -= w; if (t <= 0) return k; } return 'led'; };

// ---------------------------------------------------------------- episodes
async function ercStep(ep) {
  const e = await ep.one('run_erc', {});
  const s = typeof e === 'string' ? e : JSON.stringify(e);
  if (!/ERC passed|no issues/i.test(s)) throw new Skip();   // only clean builds are good examples
  return s;
}
const closers = [
  (r, extra) => `Done: ${r.summary}. ERC is clean.${extra}`,
  (r, extra) => `Built it — ${r.summary}. ERC passed.${extra}`,
  (r, extra) => `**Added:** ${r.summary}.\n\nERC: no issues.${extra}`,
];
async function buildEp(R, i) {
  const ep = new Ep(R, 'agent', 'build'); Model.load(Model.blank());
  const k = pickRecipe(R), r = await recipes[k](ep, R); ep.kind = 'build:' + k;
  await ercStep(ep);
  // sometimes the user wants the board too
  if (chance(R, 0.25)) {
    const ask = pick(R, ['now make the pcb', 'Generate the PCB', 'make pcb and route it', 'create the board please', 'route it on a pcb']);
    ep.say(pick(R, closers)(r, ''));
    ep.user(typo(R, ask));
    return pcbFlow(ep, R, r);
  }
  ep.say(pick(R, closers)(r, chance(R, 0.4) ? ' Say "make the PCB" when you want the board.' : ''));
  return ep;
}
async function pcbFlow(ep, R, r) {
  const g = await ep.one('generate_pcb', {}); if (isErr(g)) throw new Skip();
  const ro = g.routing || {}, b = (g.placement && g.placement.board) || ro.board || {};
  if (ro.failed && ro.failed.length) {
    const o = await ep.one('optimize_pcb', {}, `${ro.routed}/${ro.total} nets routed; ${ro.failed.join(', ')} failed — letting the optimiser move parts and re-route.`); if (isErr(o)) throw new Skip();
    const st = await ep.one('pcb_status', {}); if (isErr(st) || st.unrouted.length) throw new Skip();
  }
  const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
  const w = d.warnings ? ` ${d.warnings} warning${d.warnings > 1 ? 's' : ''} (${Object.keys(d.by_type || {}).join(', ')}) — cosmetic, no errors.` : ' DRC is clean.';
  ep.say(`PCB done: ${b.w} × ${b.h} mm, all ${ro.total || ''} nets routed${ro.vias ? ', ' + ro.vias + ' via' + (ro.vias > 1 ? 's' : '') : ''}.${w}`.replace('all  nets', 'all nets'));
  return ep;
}
// a design made silently first; the recorded part starts with the user's request about it
async function prebuilt(R, withPcb) {
  const ep = new Ep(R, 'agent', ''); ep.record = false; Model.load(Model.blank());
  let k; do { k = pickRecipe(R); } while (k === 'ldo' && chance(R, 0.5));
  const r = await recipes[k](ep, R);
  if (withPcb) { const g = await Engine.exec('generate_pcb', HIDDEN.generate_pcb, 'agent'); if (!g.routing || (g.routing.failed || []).length) throw new Skip(); }
  return r;
}
async function editEp(R) {
  const r = await prebuilt(R, chance(R, 0.3)); const ep = new Ep(R, 'agent', 'edit'); const S = Model.S;
  const res = S.components.filter(c => c.type === 'resistor'), caps = S.components.filter(c => c.type === 'capacitor');
  const kind = pick(R, ['value', 'value', 'rename', 'remove', 'footprint', 'addcap', 'ledcolor']); ep.kind = 'edit:' + kind;
  if (kind === 'value' && res.length) {
    const c = pick(R, res), old = c.value, v = fmtR(nearE(pick(R, [220, 330, 470, 1e3, 2.2e3, 4.7e3, 10e3, 22e3, 47e3, 100e3].filter(x => fmtR(x) !== c.value))));
    const byRef = chance(R, 0.6);
    ep.user(typo(R, byRef ? pick(R, [`change ${c.ref} to ${v}`, `Set ${c.ref} = ${v}Ω`, `make ${c.ref} ${v} instead`]) : `change the ${c.value} resistor to ${v}`));
    if (!byRef) { await ep.one('get_design', {}, 'Finding that resistor:'); }
    const u = await ep.one('update_component', { ref: c.ref, value: v }); if (isErr(u)) throw new Skip();
    ep.say(`${c.ref} is now ${v} Ω (was ${old}).`);
  } else if (kind === 'rename') {
    const nets = Object.keys(S.nets).filter(n => !Model.isPower(n)); if (!nets.length) throw new Skip();
    const n = pick(R, nets), to = pick(R, ['SIG', 'SENSE', 'CTRL', 'DATA', 'ADC_IN', 'PWM']) + (chance(R, 0.5) ? '_' + int(R, 1, 3) : '');
    ep.user(typo(R, pick(R, [`rename net ${n} to ${to}`, `Call the ${n} net ${to}`])));
    const u = await ep.one('rename_net', { from: n, to }); if (isErr(u)) throw new Skip();
    ep.say(`Net ${n} is now ${to}.`);
  } else if (kind === 'remove') {
    const c = pick(R, S.components.filter(c => c.type !== 'connector')); if (!c) throw new Skip();
    ep.user(typo(R, pick(R, [`remove ${c.ref}`, `delete ${c.ref} from the design`, `I don't need ${c.ref}, take it out`])));
    const u = await ep.one('remove_components', { refs: [c.ref] }); if (isErr(u)) throw new Skip();
    const e = await ep.one('run_erc', {}), s = typeof e === 'string' ? e : JSON.stringify(e);
    ep.say(`${c.ref} removed.` + (/passed|no issues/i.test(s) ? ' ERC is still clean.' : ` ERC now reports what it was connected to (${(s.match(/unconnected|only one pin/g) || []).length} item${(s.match(/unconnected|only one pin/g) || []).length === 1 ? '' : 's'}) — tell me what should replace it, or I can reconnect those pins.`));
  } else if (kind === 'footprint' && (res.length || caps.length)) {
    const fp = pick(R, ['0402', '0805', '1206', '0603']), cs = res.concat(caps).filter(c => c.footprint !== fp); if (!cs.length) throw new Skip();
    ep.user(typo(R, pick(R, [`use ${fp} for all resistors and capacitors`, `change passives to ${fp}`, `make every R and C ${fp} footprint`])));
    const out = await ep.call(cs.map(c => ['update_component', { ref: c.ref, footprint: fp }])); if (out.some(isErr)) throw new Skip();
    ep.say(`${cs.map(c => c.ref).join(', ')} now use ${fp}.` + (Model.S.board.w ? ' Run "route" again if the PCB should follow.' : ''));
  } else if (kind === 'addcap') {
    const pn = Object.keys(S.nets).find(n => Model.isPower(n) && !Model.isGround(n)); if (!pn || !S.nets.GND) throw new Skip();
    ep.user(typo(R, pick(R, [`add a 100nF decoupling cap on ${pn}`, `put 10uF bulk capacitor between ${pn} and GND`, `add decoupling to the ${pn} rail`])));
    const v = /10uF|bulk/i.test(ep.msgs[ep.msgs.length - 1].content) ? '10u' : '100n';
    const a = await ep.one('add_components', { components: [{ type: 'capacitor', value: v, footprint: v === '10u' ? '0805' : '0603', x: 100, y: 400 }] }); if (isErr(a)) throw new Skip();
    const ref = a[0].ref, c = await ep.one('connect', { connections: [{ net: pn, pins: [ref + '.1'] }, { net: 'GND', pins: [ref + '.2'] }] }); if (isErr(c)) throw new Skip();
    await ercStep(ep);
    ep.say(`${ref} ${v === '10u' ? '10 µF' : '100 nF'} added between ${pn} and GND. ERC is clean.`);
  } else if (kind === 'ledcolor') {
    const d = S.components.find(c => c.type === 'led'); if (!d) throw new Skip(); const oldCol = d.value;
    const col = pick(R, Object.keys(LEDS).filter(c => c.toUpperCase() !== oldCol));
    ep.user(typo(R, `make the LED ${col}`));
    const u = await ep.one('update_component', { ref: d.ref, value: col.toUpperCase() }); if (isErr(u)) throw new Skip();
    ep.say(`${d.ref} is now ${col}. Vf of ${col} is about ${LEDS[col]} V, so check the series resistor if you want the same current.`);
  } else throw new Skip();
  return ep;
}
async function pcbEp(R) {
  const r = await prebuilt(R, false); const ep = new Ep(R, 'agent', 'pcb');
  const kind = pick(R, ['make', 'make', 'size', 'round', 'pour', 'holes', 'rules4', 'bottom', 'edge']); ep.kind = 'pcb:' + kind;
  if (kind === 'make') { ep.user(typo(R, pick(R, ['make the pcb', 'generate pcb', 'Create the PCB and route it', 'pcb please', 'now layout the board']))); return pcbFlow(ep, R, r); }
  if (kind === 'size') {
    const w = int(R, 25, 50), h = int(R, 20, 40);
    ep.user(typo(R, pick(R, [`make a ${w}x${h} mm pcb`, `PCB ${w} by ${h} mm please`, `generate the board, size ${w}×${h}mm`])));
    const g = await ep.one('generate_pcb', { board_width: w, board_height: h }); if (isErr(g) || (g.routing.failed || []).length) throw new Skip();
    const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
    ep.say(`Board ${w} × ${h} mm, ${g.routing.routed}/${g.routing.total} nets routed, DRC ${d.summary}.`); return ep;
  }
  // the rest work on a routed board
  const g0 = await Engine.exec('generate_pcb', HIDDEN.generate_pcb, 'agent'); if (!g0.routing || (g0.routing.failed || []).length) throw new Skip();
  if (kind === 'round') {
    const d = int(R, 25, 40);
    ep.user(typo(R, pick(R, [`make the board round, ${d} mm diameter`, `circular pcb ${d}mm`, `I want a round board of ${d} mm`])));
    const s = await ep.one('set_board_shape', { shape: 'circle', d, auto_fit: true }); if (isErr(s)) throw new Skip();
    const rr0 = await ep.one('route_pcb', {}); if (isErr(rr0)) throw new Skip(); const rr = rr0.routing || rr0; if ((rr.failed || []).length || !rr.total) throw new Skip();
    const dd = await ep.one('run_drc', {}); if (isErr(dd) || dd.errors) throw new Skip();
    ep.say(`Round ${d} mm board, re-routed: ${rr.routed}/${rr.total} nets, DRC ${dd.summary}.`); return ep;
  }
  if (kind === 'pour') {
    ep.user(typo(R, pick(R, ['add gnd pour on both layers', 'Add a ground plane top and bottom', 'pour GND copper', 'add copper pour gnd'])));
    const p = await ep.one('add_copper_pour', { net: 'GND', layer: 'both' }); if (isErr(p)) throw new Skip();
    const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
    ep.say(`GND pour added on top and bottom. DRC ${d.summary}.`); return ep;
  }
  if (kind === 'holes') {
    ep.user(typo(R, pick(R, ['add 4 M3 mounting holes', 'mounting holes in the corners please', 'add screw holes m3'])));
    const p = await ep.one('add_mounting_holes', {}); if (isErr(p)) throw new Skip();
    if (!(p.holes || []).length) { const b = Model.S.board; ep.say(`No room for the holes: the board is only ${b.w} × ${b.h} mm and the corners are full of parts. M3 holes need about 6 mm square each — make the board bigger first (e.g. generate_pcb with board_width ${Math.ceil(b.w + 12)} and board_height ${Math.ceil(b.h + 12)}), then add the holes.`); return ep; }
    const rr0 = await ep.one('route_pcb', {}, `${p.holes.length} holes added; re-routing around them.`); if (isErr(rr0)) throw new Skip(); const rr = rr0.routing || rr0; if ((rr.failed || []).length || !rr.total) throw new Skip();
    const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
    ep.say(`${p.holes.length} × M3 (Ø3.2 mm) holes, board re-routed (${rr.routed}/${rr.total}), DRC ${d.summary}.`); return ep;
  }
  if (kind === 'rules4') {
    ep.user(typo(R, pick(R, ['use jlcpcb 4 layer rules', 'switch to a 4-layer board', 'make it 4 layers with gnd and power planes'])));
    const s = await ep.one('set_design_rules', { preset: 'jlcpcb_4layer' }); if (isErr(s)) throw new Skip();
    const rr0 = await ep.one('route_pcb', {}); if (isErr(rr0)) throw new Skip(); const rr = rr0.routing || rr0; if ((rr.failed || []).length || !rr.total) throw new Skip();
    const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
    ep.say(`4-layer JLCPCB rules (In1 = GND plane, In2 = power plane), re-routed ${rr.routed}/${rr.total}, DRC ${d.summary}.`); return ep;
  }
  if (kind === 'bottom' || kind === 'edge') {
    const cs = Pcb.placed().filter(c => kind === 'edge' ? c.type === 'connector' : c.type !== 'connector'); if (!cs.length) throw new Skip();
    const c = pick(R, cs), edge = pick(R, ['left', 'right', 'top', 'bottom']);
    ep.user(typo(R, kind === 'edge' ? `put ${c.ref} on the ${edge} edge` : `move ${c.ref} to the bottom side`));
    const p = await ep.one('place_footprint', kind === 'edge' ? { ref: c.ref, edge } : { ref: c.ref, side: 'bottom' }); if (isErr(p)) throw new Skip();
    const rr0 = await ep.one('route_pcb', {}); if (isErr(rr0)) throw new Skip(); const rr = rr0.routing || rr0; if ((rr.failed || []).length || !rr.total) throw new Skip();
    const d = await ep.one('run_drc', {}); if (isErr(d) || d.errors) throw new Skip();
    ep.say(`${c.ref} ${kind === 'edge' ? 'is on the ' + edge + ' edge' : 'is on the bottom side'}; re-routed ${rr.routed}/${rr.total}, DRC ${d.summary}.`); return ep;
  }
  throw new Skip();
}
async function askEp(R) {
  const pcb = chance(R, 0.45), r = await prebuilt(R, pcb); const ep = new Ep(R, 'ask', 'ask'); const S = Model.S;
  const qs = ['parts', 'net', 'value', 'erc'].concat(pcb ? ['routed', 'drc', 'size'] : ['nopcb']); const q = pick(R, qs); ep.kind = 'ask:' + q;
  if (q === 'parts') { ep.user(typo(R, pick(R, ['what parts are in my design?', 'list the components', 'how many parts do I have'])));
    const d = await ep.one('get_design', {}); ep.say(`${d.components.length} parts:\n` + d.components.map(c => `- **${c.ref}** ${c.type} ${c.value} (${c.footprint})`).join('\n')); return ep; }
  if (q === 'net') { const n = pick(R, Object.keys(S.nets)); ep.user(typo(R, pick(R, [`what is connected to ${n}?`, `which pins are on net ${n}`])));
    const d = await ep.one('get_design', {}); ep.say(`${n}: ${d.nets[n].join(', ')}.`); return ep; }
  if (q === 'value') { const c = pick(R, S.components); ep.user(typo(R, pick(R, [`what value is ${c.ref}?`, `${c.ref} value and footprint?`])));
    const d = await ep.one('get_design', {}), x = d.components.find(k => k.ref === c.ref); ep.say(`${x.ref} is a ${x.type}, value ${x.value}, footprint ${x.footprint}.`); return ep; }
  if (q === 'erc') { ep.user(typo(R, pick(R, ['is my schematic ok?', 'any ERC problems?', 'check the schematic for errors'])));
    const e = await ep.one('run_erc', {}), s = typeof e === 'string' ? e : JSON.stringify(e); ep.say(/passed|no issues/i.test(s) ? 'ERC passed — every pin is connected and there is a ground net.' : 'ERC found: ' + s); return ep; }
  if (q === 'routed') { ep.user(typo(R, pick(R, ['is the board fully routed?', 'any unrouted nets?', 'pcb status?'])));
    const s = await ep.one('pcb_status', {}); ep.say(s.unrouted.length ? `${s.routed}/${s.nets} routed; unrouted: ${s.unrouted.join(', ')}.` : `Yes — all ${s.nets} nets are routed on the ${s.board.w} × ${s.board.h} mm board (${s.vias} vias, ${s.trace_length_mm} mm of track).`); return ep; }
  if (q === 'drc') { ep.user(typo(R, pick(R, ['any DRC errors?', 'run drc', 'is the pcb ready to order?'])));
    const d = await ep.one('run_drc', {}); ep.say(d.errors ? `${d.errors} errors: ` + d.violations.filter(v => v.severity === 'error').map(v => v.msg).join('; ') : `No DRC errors${d.warnings ? ' (' + d.warnings + ' warning' + (d.warnings > 1 ? 's' : '') + ': ' + Object.keys(d.by_type).join(', ') + ')' : ''} — it is ready to order.`); return ep; }
  if (q === 'size') { ep.user(typo(R, pick(R, ['how big is the board?', 'board size?'])));
    const s = await ep.one('pcb_status', {}); ep.say(`${s.board.w} × ${s.board.h} mm (${s.board.shape}).`); return ep; }
  if (q === 'nopcb') { ep.user(typo(R, pick(R, ['is the pcb routed?', 'how big is my board?'])));
    const s = await ep.one('pcb_status', {}); ep.say('There is no PCB yet. Switch to Agent mode and ask me to "make the PCB".'); return ep; }
  throw new Skip();
}
async function planEp(R) {
  // build the recipe once (recorded on a scratch episode) to get the request, the key decision and the parts / nets;
  // then the plan answers the same request on an empty design without changing anything
  const k = pick(R, ['led', 'divider', 'rc', 'npnSwitch', 'mosfet', 'opamp', 'button']), seed = Math.floor(R() * 1e9);
  Model.load(Model.blank());
  const probe = new Ep(rng(seed), 'agent', ''); probe.system = 'x';
  await recipes[k](probe, rng(seed));
  const S = Model.S, ask = probe.msgs[0].content, why = (probe.msgs.find(m => m.role === 'assistant') || {}).content || '';
  const parts = S.components.map(c => `| ${c.ref} | ${c.type} | ${c.value} | ${c.footprint || ''} |`).join('\n');
  const nets = Object.entries(S.nets).map(([n, ps]) => `| ${n} | ${ps.join(', ')} |`).join('\n');
  Model.load(Model.blank());
  const ep = new Ep(R, 'plan', 'plan:' + k);
  ep.user(ask);
  ep.say(`## Goal
${ask}

## Key decisions
${why}

## Parts
| Ref | Type | Value | Footprint |
|---|---|---|---|
${parts}

## Connections
| Net | Pins |
|---|---|
${nets}

## Steps
1. add_components with all parts
2. connect all nets
3. run_erc

Press **Execute plan** to build it.`);
  return ep;
}
// questions that need no tool: the model answers directly (keeps it from calling tools for no reason)
async function talkEp(R) {
  const ep = new Ep(R, pick(R, ['agent', 'ask']), 'talk'); Model.load(Model.blank());
  const t = int(R, 0, 5);
  if (t === 0) { const V = pick(R, [3.3, 5, 12, 24]), I = pick(R, [1, 5, 10, 20, 100]); ep.user(typo(R, `what resistor for ${I} mA at ${V} V?`)); ep.say(`R = V / I = ${V} / ${I / 1000} = ${fmtR(V / (I / 1000))} Ω → use ${ohm(nearE(V / (I / 1000)))} (E24). Power: P = V·I = ${(V * I / 1000).toFixed(3)} W, so a ${V * I / 1000 > 0.1 ? '0805 (1/8 W) or bigger' : '0603 (1/10 W)'} resistor is fine.`); }
  else if (t === 1) { const C = pick(R, [100e-9, 1e-6, 10e-9]), Rv = pick(R, [1e3, 10e3, 4.7e3]); ep.user(typo(R, `cutoff frequency of ${fmtR(Rv)} and ${fmtC(C)}F rc filter?`)); ep.say(`fc = 1 / (2π·R·C) = 1 / (2π · ${Rv} · ${C}) ≈ ${(1 / (2 * Math.PI * Rv * C)).toFixed(1)} Hz.`); }
  else if (t === 2) { ep.user(typo(R, pick(R, ['why do I need a decoupling capacitor?', 'what does a 100nF cap next to an IC do?']))); ep.say('It supplies the fast current spikes the chip draws when it switches, so the supply at its pins stays steady. Put 100 nF as close as possible to each supply pin (short path to GND), plus 1–10 µF bulk per rail.'); }
  else if (t === 3) { const V = pick(R, [5, 12]), Vo = pick(R, [3.3, 1.8]), I = pick(R, [100, 300, 500]); ep.user(typo(R, `ldo from ${V}V to ${Vo}V at ${I}mA, how hot?`)); ep.say(`P = (Vin − Vout) · I = (${V} − ${Vo}) · ${I / 1000} = ${((V - Vo) * I / 1000).toFixed(2)} W.${(V - Vo) * I / 1000 > 0.6 ? ' That is too much for SOT-23 / SOT-223 without copper — use a buck converter or a pre-regulator.' : ' Fine for SOT-223 with some copper around the tab.'}`); }
  else if (t === 4) { ep.user(typo(R, pick(R, ['hi', 'hello', 'what can you do?']))); ep.say('Hi! I design circuits and PCBs here: tell me what to build (e.g. "3.3 V regulator with an LED") and I add the parts, wire them, check the schematic and make the board. I can also change values, move parts, add a ground pour or answer questions about your design.'); }
  else { const V = pick(R, [3.3, 5]); ep.user(typo(R, `i2c pull-up value for ${V}V, 400kHz?`)); ep.say(`2.2 kΩ–4.7 kΩ. For 400 kHz with ~100 pF bus capacitance use ${V === 3.3 ? '2.2 kΩ' : '2.7 kΩ'} (rise time 0.85·R·C ≈ ${(0.85 * (V === 3.3 ? 2.2e3 : 2.7e3) * 100e-12 * 1e9).toFixed(0)} ns < 300 ns); 4.7 kΩ is fine at 100 kHz.`); }
  return ep;
}
const EPISODES = [[buildEp, 40], [editEp, 16], [pcbEp, 18], [askEp, 12], [planEp, 6], [talkEp, 8]];

// ---------------------------------------------------------------- run this worker's share
async function workerRun() {
const outFile = path.join(OUT, `part-${String(FROM).padStart(6, '0')}.jsonl`), lines = [];
let made = 0, skipped = 0;
for (let i = FROM; made < COUNT && i < FROM + COUNT * 6; i++) {
  const R = rng(SEED * 1000003 + i * 7919);
  let t = EPISODES.reduce((a, x) => a + x[1], 0) * R(), fn = buildEp; for (const [f, w] of EPISODES) { t -= w; if (t <= 0) { fn = f; break; } }
  try {
    const ep = await fn(R, i); if (!ep || !ep.msgs.length || ep.msgs[ep.msgs.length - 1].role !== 'assistant' || ep.msgs[ep.msgs.length - 1].tool_calls) throw new Skip();
    lines.push(JSON.stringify(ep.done())); made++;
  } catch (e) { skipped++; if (!(e instanceof Skip) && skipped < 5) console.error('episode', i, e.message); }
}
fs.writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''));
console.log(`worker ${FROM}: ${made} made, ${skipped} skipped`);
process.exit(0);
}
async function probe(name) {
  for (let i = 0; i < 6; i++) {
    const R = rng(1000 + i), ep = new Ep(R, 'agent', 'probe'); Model.load(Model.blank());
    try { const r = await recipes[name](ep, R); const e = await Engine.exec('run_erc', {}, 'agent'); console.log(name, i, 'ok', JSON.stringify(e).slice(0, 300)); }
    catch (e) { console.log(name, i, e instanceof Skip ? 'SKIP' : 'ERR ' + e.message, '| last:', JSON.stringify(ep.msgs.slice(-1)).slice(0, 400)); }
  }
  process.exit(0);
}
if (process.argv.includes('--probe')) await probe(arg('probe')); else if (process.argv.includes('--worker')) await workerRun(); else await mainProcess();
