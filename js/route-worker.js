'use strict';
// Runs placement + the autorouter off the UI thread. Receives the design, returns the new PCB.
// the worker's own ?v= goes to its scripts too, so an update never runs with a cached older engine
const V = self.location.search || '';
importScripts('lib.js' + V, 'model.js' + V, 'strokefont.js' + V, 'pcb.js' + V);
// board regions of a panel (several boards joined by break-off tabs) come from Shape3D.detectBoards: placement puts each
// sheet's parts on its own board. Without it (load error) placement ignores the boards, routing is unaffected.
try { importScripts('enclosure.js' + V, 'shape3d.js' + V); } catch (e) { }
self.onmessage = e => {
  const { state, opt = {}, place } = e.data;
  try {
    Model.load(state);
    let lastP = 0;
    const onProgress = p => { const t = Date.now(); if (t - lastP < 120 && p.phase !== 'ripup') return; lastP = t; self.postMessage(Object.assign({ type: 'progress' }, p)); };
    // best result so far (routing only): the page applies it if the user stops early
    const onBest = b => self.postMessage({ type: 'best', pcb: Object.assign({}, Model.S.pcb, { traces: b.traces, vias: b.vias, routed: b.routed }), unrouted: b.unrouted });
    const placement = place ? Pcb.autoPlace(place) : null;
    const routing = opt.noRoute || placement?.fits === false ? null : Pcb.route(Object.assign({}, opt, { onProgress, onBest: place ? null : onBest }));
    self.postMessage({
      type: 'done', placement, routing, pcb: Model.S.pcb, board: Model.S.board,
      positions: Model.S.components.filter(c => place || c.pcb).map(c => [c.ref, c.pcb || null]),
    });
  } catch (err) { self.postMessage({ type: 'error', message: err.message }); }
};
