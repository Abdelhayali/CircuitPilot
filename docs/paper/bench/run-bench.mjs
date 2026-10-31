// Routing benchmark for the paper: every design in designs.json is routed headless by the shared engine
// (the same code as the app and the MCP server), with and without negotiated rip-up, then checked by DRC.
// Usage: node docs/paper/bench/run-bench.mjs [time_limit_s] > results.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../../mcp/engine-vm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..', '..');
const T = +(process.argv[2] || 60), ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const designs = JSON.parse(fs.readFileSync(path.join(HERE, 'designs.json'), 'utf8')).filter(d => !ONLY || ONLY.includes(d.id));
const ctx = loadEngine(ROOT);
const { Engine, Model, Pcb } = ctx;
Object.assign(Engine.env, { fetch, myLib: () => [], savePart: async () => { }, ui: () => { } });
await ctx.kernelReady;

const out = [];
for (const d of designs) {
  const row = { id: d.id, name: d.name };
  for (const mode of ['full', 'noripup']) {
    Model.load(JSON.parse(JSON.stringify(d.data.data || d.data)));
    const S = Model.S, R = Pcb.rules(), idx = Model.pinIndex();
    if (mode === 'full') {
      const pins = Object.values(S.nets).reduce((a, n) => a + n.length, 0);
      const conn = Pcb.connectivity(), multi = Object.keys(conn).length;
      Object.assign(row, { parts: S.components.length, placed: Pcb.placed().length, nets: multi, pins, layers: R.layers, preset: R.preset || '', board_mm: [S.board.w, S.board.h], area_mm2: +(S.board.w * S.board.h).toFixed(1), shape: S.board.shape || 'rect', pours: (S.pcb.pours || []).length, trace_w: R.traceWidth, clearance: R.clearance });
    }
    // remove autorouted copper (hand-drawn copper stays, as in the app)
    S.pcb.traces = S.pcb.traces.filter(t => t.manual); S.pcb.vias = S.pcb.vias.filter(v => v.manual);
    Engine.env.route = mode === 'full' ? null : async ({ opt }) => Model.mutate(() => ({ routing: Pcb.route(Object.assign({}, opt, { ripup: false })) }));
    const t0 = performance.now();
    let r, err = null;
    try { r = await Engine.exec('route_pcb', { time_limit_s: T }, 'agent'); } catch (e) { err = e.message; }
    const secs = (performance.now() - t0) / 1000, st = Pcb.status(), drc = Pcb.drc();
    const errs = drc.violations.filter(v => v.severity === 'error');
    row[mode] = { seconds: +secs.toFixed(2), routed: st.routed, total: st.nets, unrouted: st.unrouted.length, vias: st.vias, length_mm: st.trace_length_mm, drc_errors: errs.length, drc_types: [...new Set(errs.map(v => v.type))], grid_mm: r && (r.routing?.grid_mm ?? r.grid_mm), err };
    console.error(d.name, mode, JSON.stringify(row[mode]));
  }
  out.push(row);
}
console.log(JSON.stringify(out, null, 1));
