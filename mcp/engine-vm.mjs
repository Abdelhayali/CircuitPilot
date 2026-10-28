// The shared CircuitPilot engine (same code as the browser app) in a Node vm, for the MCP server and its job worker.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FILES = [['lib.js', 'Lib'], ['model.js', 'Model'], ['strokefont.js', 'StrokeFont'], ['pcb.js', 'Pcb'], ['cnc.js', 'Cnc'], ['enclosure.js', 'Enclosure'], ['shape3d.js', 'Shape3D'], ['kicad.js', 'KiCad'],
  ['openlib.js', 'OpenLib'], ['easyeda.js', 'EasyEDA'], ['exports.js', 'Exports'], ['blocks.js', 'Blocks'], ['engine.js', 'Engine']];

export function loadEngine(root, log = () => { }) {
  const ctx = vm.createContext({
    console: { log, info: log, warn: log, error: log }, fetch, TextEncoder, TextDecoder, Blob, URL, URLSearchParams,
    setTimeout, clearTimeout, AbortController, AbortSignal,
  });
  for (const [file, name] of FILES)
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8') + `\n;globalThis.${name} = ${name};`, ctx, { filename: file });
  // fast 3D kernel (Manifold, WASM) for the enclosure scripts; ready within ms, until then the BSP kernel is used
  // ctx.kernelReady: await it before running enclosure scripts (a fresh export worker must not fall back to the slow
  // kernel, where gap() and the 2D booleans do not exist)
  ctx.kernelReady = Promise.resolve(false);
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vendor', 'manifold.js'), 'utf8'), ctx, { filename: 'manifold.js' });
    ctx.kernelReady = ctx.ManifoldModule({ wasmBinary: fs.readFileSync(path.join(root, 'js', 'vendor', 'manifold.wasm')) }).then(m => ctx.Shape3D.useManifold(m), e => { log('3D kernel not loaded: ' + e.message); return false; });
  } catch (e) { log('3D kernel not loaded: ' + e.message); }
  // open-library part lists straight from the app folder
  ctx.OpenLib.readIndex = async () => fs.readFileSync(path.join(root, 'data', 'open-parts.txt'), 'utf8');
  ctx.KiCad.readIndex = async () => fs.readFileSync(path.join(root, 'data', 'kicad-footprints.txt'), 'utf8');
  return ctx;
}

// Every file of the loaded project that the engine can make on its own (no browser): project, BOM, netlist,
// Gerbers, JLCPCB BOM + CPL, enclosure, EasyEDA. PDFs and images are drawn by the app window (render bridge).
export async function projectFiles(ctx, inc) {
  const { Model, Pcb, Exports: X } = ctx, S = Model.S, base = X.slug(S.name), hasPcb = !!(S.board.w && Pcb.placed().length);
  const files = {}, skipped = [], zip = async f => new Uint8Array(await ctx.makeZip(f).arrayBuffer());
  let drc = null;
  if (inc.has('project')) files[base + '.circuit.json'] = X.project();
  if (inc.has('bom')) files[base + '-bom.csv'] = X.bom();
  if (inc.has('netlist')) files[base + '.net'] = X.netlist();
  if (hasPcb) {
    if (inc.has('gerbers')) {
      drc = Pcb.drc().summary;
      const g = Pcb.gerbers(); for (const [n, t] of Object.entries(g)) files['gerbers/' + n] = t;
      files[base + '-gerbers.zip'] = await zip(g);
    }
    if (inc.has('jlcpcb')) { files[`jlcpcb/${base}-BOM-JLCPCB.csv`] = X.bomJlc(); files[`jlcpcb/${base}-CPL-JLCPCB.csv`] = X.cpl(); }
    if (inc.has('enclosure')) {
      try {
        const { files: e } = ctx.Engine.enclosureFiles({ service: 'all' }); for (const [n, d] of Object.entries(e)) files['enclosure/' + n] = d;
      } catch (e) { skipped.push('enclosure: ' + e.message); }
    }
    if (inc.has('easyeda')) {
      try {
        const sch = ctx.EasyEDA.exportSchematic({}), pcb = ctx.EasyEDA.exportPcb();
        files[`easyeda/SCH_${base}.json`] = sch; files[`easyeda/PCB_${base}.json`] = pcb;
        files[`easyeda/${base}-easyeda.zip`] = await zip({ [`SCH_${base}.json`]: sch, [`PCB_${base}.json`]: pcb });
      } catch (e) { skipped.push('EasyEDA: ' + e.message); }
    }
  } else for (const k of ['gerbers', 'jlcpcb', 'enclosure', 'easyeda']) if (inc.has(k)) skipped.push(k + ': no PCB yet (generate_pcb)');
  return { files, skipped, drc, vias: hasPcb ? Pcb.viaSummary() : null, base, name: S.name || 'Untitled', hasPcb, sheets: Math.max(1, (S.sheets || []).length), parts: S.components.length };
}
