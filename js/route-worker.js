'use strict';
// Runs placement + the autorouter off the UI thread. Receives the design, returns the new PCB.
importScripts('lib.js', 'model.js', 'strokefont.js', 'pcb.js');
self.onmessage = e => {
  const { state, opt = {}, place } = e.data;
  try {
    Model.load(state);
    let lastP = 0;
    const onProgress = p => { const t = Date.now(); if (t - lastP < 120 && p.phase !== 'ripup') return; lastP = t; self.postMessage(Object.assign({ type: 'progress' }, p)); };
    // best result so far (routing only): the page applies it if the user stops early
    const onBest = b => self.postMessage({ type: 'best', pcb: Object.assign({}, Model.S.pcb, { traces: b.traces, vias: b.vias, routed: b.routed }), unrouted: b.unrouted });
    let placement = null, routing = null, optimized = null;
    // optimiser: each better layout (placement + board + copper) is sent so Stop can keep it
    const onBestLayout = b => self.postMessage({ type: 'best', pcb: Model.S.pcb, board: Model.S.board, positions: Model.S.components.filter(c => c.pcb).map(c => [c.ref, c.pcb]), unrouted: b.unrouted });
    if (e.data.optimize) optimized = Pcb.optimize(Object.assign({}, e.data.optimize, { onProgress, onBest: onBestLayout }));
    else {
      placement = place ? Pcb.autoPlace(place) : null;
      routing = opt.noRoute ? null : Pcb.route(Object.assign({}, opt, { onProgress, onBest: place ? null : onBest }));
    }
    self.postMessage({
      type: 'done', placement, routing, optimized, pcb: Model.S.pcb, board: Model.S.board,
      positions: Model.S.components.filter(c => c.pcb).map(c => [c.ref, c.pcb]),
    });
  } catch (err) { self.postMessage({ type: 'error', message: err.message }); }
};
