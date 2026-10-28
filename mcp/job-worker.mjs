// Background job for the MCP server: runs one long engine tool (routing, placement, export files) on a copy of the
// project in its own thread, so the MCP server keeps answering (job_status) while it works.
import { parentPort, workerData } from 'node:worker_threads';
import { loadEngine, projectFiles } from './engine-vm.mjs';

const ctx = loadEngine(workerData.root);
const { Engine, Model } = ctx;
parentPort.once('message', async m => {
  try {
    Object.assign(Engine.env, { base: m.base, headers: m.headers, fetch, myLib: () => m.myLib || [], savePart: async () => { }, ui: () => { } });
    Model.load(m.project);
    await ctx.kernelReady;
    const result = m.kind === 'export' ? await projectFiles(ctx, new Set(m.include)) : await Engine.exec(m.name, m.input, 'agent');
    parentPort.postMessage({ ok: true, result, project: m.kind === 'export' ? null : Model.snapshot() });
  } catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
});
