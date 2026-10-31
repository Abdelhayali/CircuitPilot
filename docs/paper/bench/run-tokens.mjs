// Size of tool answers the agent reads (characters; ~4 characters per token) against the raw project JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../../mcp/engine-vm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..', '..');
const designs = JSON.parse(fs.readFileSync(path.join(HERE, 'designs.json'), 'utf8'));
const ctx = loadEngine(ROOT), { Engine, Model } = ctx;
Object.assign(Engine.env, { fetch, myLib: () => [], savePart: async () => { }, ui: () => { } });
const calls = [['get_design', {}], ['get_pcb_layout', {}], ['pcb_status', {}], ['run_drc', {}], ['run_drc', { full: true }], ['get_tracks', {}], ['run_erc', {}]];
const out = [];
for (const d of designs) {
  Model.load(JSON.parse(JSON.stringify(d.data.data || d.data)));
  const row = { name: d.name, raw: JSON.stringify(Model.snapshot()).length };
  for (const [n, a] of calls) { try { row[n + (a.full ? '_full' : '')] = JSON.stringify(await Engine.exec(n, a, 'agent')).length; } catch (e) { row[n] = null; } }
  out.push(row);
}
const tools = Engine.TOOLS.reduce((a, t) => a + JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema }).length, 0);
console.log(JSON.stringify({ tool_schema_chars: tools, tools: Engine.TOOLS.length, rows: out }, null, 1));
