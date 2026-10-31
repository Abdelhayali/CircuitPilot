// CNC isolation-milling statistics for the paper: G-code jobs for the 1-layer designs, with and without SMD pad relief.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../../mcp/engine-vm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..', '..');
const designs = JSON.parse(fs.readFileSync(path.join(HERE, 'designs.json'), 'utf8')).filter(d => /CNC/.test(d.name));
const ctx = loadEngine(ROOT), { Model, Cnc } = ctx;
const out = [];
for (const d of designs) for (const relief of ['off', 'on']) {
  Model.load(JSON.parse(JSON.stringify(d.data.data || d.data)));
  const t0 = performance.now(), r = Cnc.job({ pad_relief: relief }), ms = performance.now() - t0;
  const lines = Object.entries(r.files || {}).filter(([n]) => n.endsWith('.nc')).reduce((a, [, t]) => a + String(t).split('\n').length, 0);
  out.push({ name: d.name, relief, ms: Math.round(ms), gcode_lines: lines, files: Object.keys(r.files || {}), info: r.info, warnings: r.warnings });
}
console.log(JSON.stringify(out, null, 1));
