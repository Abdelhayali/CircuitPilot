'use strict';

const BenchBringup = (() => {
  const $ = id => document.getElementById(id);
  const data = () => Model.S.benchBringup || {};
  const checklist = () => data().checklist || [];
  const runs = () => data().runs || [];
  const named = r => r.revision + ' · ' + r.unit;
  const id = () => Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(16).padStart(8,'0')).join('');
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const status = text => $('bringupStatus').textContent = text;
  const format = v => v + ' V';
  let project, editorProject, runId, selected, compareId, side, pendingReading;

  function save(patch) {
    Model.mutate(() => {
      Model.S.benchBringup = {...data(), ...patch};
    });
  }

  function sync() {
    if (project === Model.S) return;
    project = Model.S;
    runId = selected = compareId = side = pendingReading = undefined;
  }

  const currentRun = () => runs().find(r => r.id === runId) || runs().at(-1);
  const currentStep = r => r?.steps.find(s => s.id === selected) || nextOutstanding(r) || r?.steps.at(-1);
  const lastReading = (r, s) => r.log.findLast(e => e.step === s.id);
  const withinRange = (v, s) => v >= s.min && v <= s.max;
  const outcome = (r, s) => {
    const e = lastReading(r, s);
    if (!e) return 'Pending';
    if (!s.point) return 'Complete';
    return withinRange(e.value, s) ? 'Pass' : 'Out of range';
  };
  const nextOutstanding = r => r?.steps.find(s => ['Pending', 'Out of range'].includes(outcome(r, s)));

  function parseVoltage(text) {
    const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mV|V)?$/i.exec(text.trim());
    if (!m) return null;
    const v = Number(m[1]) / (m[2]?.toLowerCase() === 'mv' ? 1000 : 1);
    return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : null;
  }

  function resolvePin(text) {
    const split = text.lastIndexOf('.');
    const c = Model.comp(split < 0 ? text : text.slice(0, split));
    if (!c) return;
    const pins = Model.pinsWorld(c);
    return split < 0 ? (pins.length === 1 ? pins[0] : undefined) :
      pins.find(p => same(p.num, text.slice(split + 1)));
  }

  function probeReference(text) {
    const pin = resolvePin(text);
    if (pin) return {pin: pin.key};
    const net = Object.keys(Model.S.nets).find(n => same(n, text));
    return net ? {net} : undefined;
  }

  const refLabel = ref => ref.pin || ref.net;
  const ambiguousReference = (point, ref, nets) => ref.pin === point || (!!ref.net && nets[point] === ref.net);
  const instructions = s => s.label + (s.point ? '. Measure ' + s.point + ' relative to ' +
    refLabel(s.reference) + '. Expected ' + format(s.min) + ' to ' + format(s.max) + '.' : '');

  function element(tag, text) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function addRow(s = {}) {
    const row = element('fieldset');
    row.dataset.id = s.id || id();
    row.className = 'bringup-step';
    const fields = [
      ['label', 'Instruction', s.label, 'e.g. Check the 3.3 V rail', '', 240],
      ['point', 'Test point or pin', s.point, 'TP4 or U5.3', 'bringupPins', 100],
      ['reference', 'Ground or reference', s.reference ? refLabel(s.reference) : '', 'GND or TP1.1', 'bringupReferences', 100],
      ['min', 'Minimum (V)', s.min, '3.15', '', 24],
      ['max', 'Maximum (V)', s.max, '3.45', '', 24]
    ];
    for (const [key, title, value, placeholder, list, length] of fields) {
      const label = element('label', title);
      const input = element('input');
      input.name = key;
      input.value = value ?? '';
      input.placeholder = placeholder;
      input.maxLength = length;
      input.required = key === 'label';
      if (key === 'min' || key === 'max') input.inputMode = 'decimal';
      if (list) input.setAttribute('list', list);
      label.append(input);
      row.append(label);
    }
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.onclick = () => row.remove();
    row.append(remove);
    $('bringupRows').append(row);
  }

  function updateEditor() {
    editorProject = Model.S;
    $('bringupRows').replaceChildren();
    const pins = Model.S.components.flatMap(c => {
      const entries = Model.pinsWorld(c);
      return entries.length === 1 ? [c.ref, entries[0].key] : entries.map(p => p.key);
    });
    $('bringupPins').replaceChildren(...pins.map(pin => new Option(pin)));
    $('bringupReferences').replaceChildren(...[...Object.keys(Model.S.nets), ...pins].map(p => new Option(p)));
    $('bringupLegacy').hidden = checklist().length > 0 || !legacySteps().length;
    checklist().forEach(addRow);
    if (!checklist().length) addRow();
  }

  const legacySteps = () => (Array.isArray(Model.S.notes?.values?.bringup_steps) ?
    Model.S.notes.values.bringup_steps : []).filter(s => typeof s === 'string' && s.trim());

  function readRow(row, index) {
    const value = key => row.querySelector('[name="' + key + '"]').value.trim();
    const label = value('label'), point = value('point'), reference = value('reference');
    const step = {id: row.dataset.id, label};
    const prefix = 'Step ' + (index + 1) + '. ';
    if (!label) throw new Error(prefix + 'Enter an instruction.');
    if (![point, reference, value('min'), value('max')].some(Boolean)) return step;
    const pin = resolvePin(point), ref = probeReference(reference);
    const min = parseVoltage(value('min')), max = parseVoltage(value('max'));
    if (!pin) throw new Error(prefix + 'Choose a test point or a specific pin in this project.');
    if (!ref) throw new Error(prefix + 'Choose a ground net or a reference pin in this project.');
    if (ambiguousReference(pin.key, ref, Model.pinIndex())) {
      throw new Error(prefix + 'Choose a different reference pin or net.');
    }
    if (min === null || max === null || min > max) throw new Error(prefix + 'Enter a valid minimum and maximum voltage.');
    return {...step, point: pin.key, reference: ref, min, max};
  }

  function snapshotBoard(steps) {
    const {w, h} = Model.S.board;
    if (!(w > 0 && h > 0) || !steps.some(s => s.point)) return null;
    const parts = Pcb.placed(), nets = Model.pinIndex();
    const pads = parts.flatMap(c => Pcb.padsOf(c, nets).map(p => ({
      key: c.pinAlias?.[p.num] ? c.ref + '.' + c.pinAlias[p.num] : p.key,
      net: p.net, x: p.x, y: p.y, layer: p.layer
    })));
    // Keep the original probe locations when the project moves on to another revision.
    for (const s of steps) {
      if (!s.point) continue;
      s.probes = {
        point: pads.filter(p => p.key === s.point),
        reference: pads.filter(p => s.reference.pin ? p.key === s.reference.pin : p.net === s.reference.net)
      };
    }
    return {w, h, outline: Pcb.boardPoly(), footprints: parts.map(c => ({
      box: Pcb.fpBox(c), side: Pcb.isBottom(c) ? 'B' : 'F'
    }))};
  }

  function startRun() {
    const revision = $('bringupRevision').value.trim(), unit = $('bringupUnit').value.trim();
    if (!revision || !unit) throw new Error('Enter a board revision and board ID.');
    if (!checklist().length) throw new Error('Save a checklist before starting a run.');
    if (runs().some(r => same(r.revision, revision) && same(r.unit, unit))) {
      throw new Error('A run already exists for this revision and board ID. Select it from the Run menu.');
    }
    const nets = Model.pinIndex();
    const steps = checklist().map(s => {
      if (s.point && (!resolvePin(s.point) || (s.reference.pin && !resolvePin(s.reference.pin)) ||
          (s.reference.net && !Object.hasOwn(Model.S.nets, s.reference.net)) || ambiguousReference(s.point, s.reference, nets))) {
        throw new Error('Update the probe locations for “' + s.label + '” before starting this run.');
      }
      return {...s};
    });
    const run = {id: id(), revision, unit, steps, board: snapshotBoard(steps), log: []};
    save({runs: [...runs(), run]});
    runId = run.id;
    selected = compareId = side = pendingReading = undefined;
    $('bringupNew').reset();
    render();
    status('Run started for ' + named(run) + '.');
  }

  function append(r, s, value) {
    const updated = {...r, log: [...r.log, {step: s.id, at: new Date().toISOString(), value}]};
    save({runs: runs().map(old => old.id === r.id ? updated : old)});
    selected = s.id;
    pendingReading = undefined;
    if (!$('bench-bringup').hidden) render();
    if (!s.point) return 'Marked complete. Say “next step” to continue.';
    return 'Logged ' + format(value) + ' at ' + s.point + '. ' +
      (withinRange(value, s) ? 'Within range.' : 'Out of range. Expected ' + format(s.min) + ' to ' + format(s.max) + '.');
  }

  function switchStep(s) {
    selected = s?.id;
    pendingReading = undefined;
    side = s?.probes?.point.length && s.probes.point.every(p => p.layer === 'B') ? 'B' : 'F';
    if (!$('bench-bringup').hidden) render();
  }

  function reportNext(r) {
    const s = nextOutstanding(r);
    if (!s) return 'All ' + r.steps.length + ' checklist steps are complete for ' + named(r) + '.';
    switchStep(s);
    return 'Step ' + (r.steps.indexOf(s) + 1) + ' of ' + r.steps.length + '. ' + instructions(s);
  }

  function drawMap(r, s) {
    const board = r.board, probes = s?.probes;
    $('bringupMapPanel').hidden = !board || !probes;
    if (!board || !probes) return;
    const face = side || (probes.point.length && probes.point.every(p => p.layer === 'B') ? 'B' : 'F');
    $('bringupTop').setAttribute('aria-pressed', String(face === 'F'));
    $('bringupBottom').setAttribute('aria-pressed', String(face === 'B'));
    const c = $('bringupMap'), ctx = c.getContext('2d');
    const k = Math.min((c.width - 28) / board.w, (c.height - 28) / board.h);
    const project = ([x,y]) => [(c.width - k * board.w) / 2 + k * (face === 'F' ? x : board.w - x),
      (c.height - k * board.h) / 2 + k * y];
    ctx.clearRect(0,0,c.width,c.height);
    ctx.beginPath();
    board.outline.map(project).forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#849eb8';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#50647a';
    for (const {box: [x0,y0,x1,y1], side: layer} of board.footprints) {
      if (layer !== face) continue;
      const [x,y] = project([x0,y0]);
      ctx.strokeRect(x,y,k * (x1-x0) * (face === 'F' ? 1 : -1),k * (y1-y0));
    }
    const visible = pads => pads.filter(p => !p.layer || p.layer === face);
    const points = visible(probes.point), refs = visible(probes.reference);
    function plot(pads, color, radius) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const p of pads) {
        const [x,y] = project([p.x,p.y]);
        ctx.beginPath();
        ctx.arc(x,y,radius,0,2*Math.PI);
        ctx.stroke();
      }
    }
    plot(refs, '#ffcc78', 4);
    plot(points, '#38dafe', 7);
    $('bringupMapLabel').textContent = [
      points.length ? 'Cyan • ' + s.point : s.point + (probes.point.length ? ' is on the other side' : ' has no pad in this PCB'),
      refs.length ? 'Amber • ' + refLabel(s.reference) : refLabel(s.reference) + (probes.reference.length ?
        ' is on the other side' : ' has no pad in this PCB')
    ].join(' · ');
  }

  function renderResults(r) {
    const other = runs().find(old => old.id === compareId);
    const table = element('table');
    table.createCaption().textContent = other ? 'Compare latest results' : 'Latest results';
    const header = table.createTHead().insertRow();
    for (const text of ['Step', named(r), ...(other ? [named(other)] : [])]) {
      const th = element('th', text);
      th.scope = 'col';
      header.append(th);
    }
    const body = table.createTBody();
    const summary = (run, step) => {
      const e = lastReading(run, step);
      return step.point ? (e ? format(e.value) + ' · ' + outcome(run, step) + ' · ' : 'Pending · ') +
        format(step.min) + ' to ' + format(step.max) + ' vs ' + refLabel(step.reference) : outcome(run, step);
    };
    const matches = (s,t) => t.id === s.id && t.point === s.point &&
      (!s.point || (t.reference.pin === s.reference.pin && t.reference.net === s.reference.net));
    const add = (s, current, previous) => {
      const row = body.insertRow();
      row.insertCell().textContent = s.label + (s.point ? ' · ' + s.point : '');
      const currentCell = row.insertCell();
      currentCell.textContent = current ? summary(r,current) : 'No matching step';
      if (current) currentCell.dataset.outcome = outcome(r,current);
      if (other) {
        const previousCell = row.insertCell();
        previousCell.textContent = previous ? summary(other,previous) : 'No matching step';
        if (previous) previousCell.dataset.outcome = outcome(other,previous);
      }
    };
    for (const s of r.steps) add(s, s, other?.steps.find(t => matches(s,t)));
    for (const s of other?.steps || []) {
      if (!r.steps.some(t => matches(s,t))) add(s,undefined,s);
    }
    $('bringupResults').replaceChildren(table);
  }

  function render() {
    const r = currentRun();
    $('bringupSession').hidden = !r;
    if (!r) return;
    const s = currentStep(r);
    $('bringupRuns').replaceChildren(...runs().map(run => new Option(named(run),run.id)));
    $('bringupRuns').value = r.id;
    $('bringupCompare').replaceChildren(new Option('None',''), ...runs().filter(run => run.id !== r.id)
      .map(run => new Option(named(run),run.id)));
    $('bringupCompare').value = compareId || '';
    $('bringupSteps').replaceChildren(...r.steps.map((step,i) => new Option(
      (i + 1) + '. ' + step.label + ' · ' + outcome(r, step), step.id)));
    $('bringupSteps').value = s.id;
    $('bringupPrompt').textContent = instructions(s);
    $('bringupReading').hidden = !s.point;
    $('bringupDone').hidden = !!s.point;
    $('bringupDone').disabled = !!lastReading(r, s);
    $('bringupVolts').value = '';
    $('bringupAttempts').replaceChildren(...r.log.filter(e => e.step === s.id).slice().reverse().map(e =>
      element('li', (s.point ? format(e.value) + ' · ' + (withinRange(e.value,s) ? 'Pass' : 'Out of range') :
        'Completed') + ' · ' + new Date(e.at).toLocaleString())));
    drawMap(r,s);
    renderResults(r);
  }

  function spokenVoltage(text) {
    const words = ['zero','one','two','three','four','five','six','seven','eight','nine'];
    const normalized = text.trim().toLowerCase()
      .replace(/\b(?:millivolts?|volts?)\b/g, m => m.startsWith('milli') ? 'mV' : 'V')
      .replace(/^minus\s+|^negative\s+/,'-')
      .replace(/^plus\s+|^positive\s+/,'+')
      .replace(/\bpoint\b/g,'.')
      .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine)\b/g, m => words.indexOf(m))
      .replace(/\s+/g,'');
    return parseVoltage(normalized);
  }

  function answer(question) {
    sync();
    const q = question.trim().replace(/[.!?]+$/, '');
    const r = currentRun(), s = currentStep(r);
    const log = /^(?:log|record)\s+(.+?)(?:\s+at\s+(.+))?$/i.exec(q);
    const confirm = /^confirm(?: reading)?$/i.test(q), cancel = /^cancel reading$/i.test(q);
    const done = /^(?:mark (?:this )?step complete|complete (?:this )?step)$/i.test(q);
    if (!(log || confirm || cancel || done)) return;
    if (cancel) {
      pendingReading = undefined;
      return 'Reading canceled.';
    }
    if (!r) return 'Start a board run in the Bring-up tab first.';
    if (done) {
      if (s.point) return 'This step needs a voltage reading. Say “log” and the voltage.';
      return lastReading(r,s) ? 'This step is already complete.' : append(r,s,null);
    }
    if (confirm) {
      if (pendingReading?.run !== r.id || pendingReading.step !== s.id) return 'There is no reading to confirm for this step.';
      return append(r,s,pendingReading.value);
    }
    pendingReading = undefined;
    if (!s.point) return 'Select a voltage measurement step before logging a reading.';
    if (log[2]) {
      const target = log[2].trim().replace(/^test point\s*/i,'TP').replace(/^TP\s+(?=\d)/i,'TP');
      if (resolvePin(target)?.key !== s.point) return 'The selected step measures ' + s.point + '. Select the intended step first.';
    }
    const value = spokenVoltage(log[1]);
    if (value === null) return 'Say a voltage, for example “log three point two eight volts”.';
    // Bind the read-back to the selected run and step before asking for confirmation.
    pendingReading = {run: r.id, step: s.id, value};
    return 'I heard ' + format(value) + ' for ' + s.point + ' on ' + named(r) + '. Say “confirm reading” or “cancel reading”.';
  }

  function next() {
    sync();
    const r = currentRun();
    return r ? reportNext(r) : checklist().length ? 'Start a board run in the Bring-up tab first.' : undefined;
  }

  function expected(pin) {
    if (!pin) return;
    sync();
    const r = currentRun(), active = currentStep(r);
    if (active?.point === pin) return instructions(active);
    const matches = (r?.steps || checklist()).filter(s => s.point === pin);
    if (matches.length === 1) return instructions(matches[0]);
    if (matches.length > 1) return pin + ' has several voltage checks. Select the step in Bring-up for its range.';
  }

  function init() {
    const safe = action => {
      try { action(); } catch (e) { status(e.message); }
    };
    $('bringupAdd').onclick = () => addRow();
    $('bringupLegacy').onclick = () => {
      $('bringupRows').replaceChildren();
      legacySteps().forEach(label => addRow({label}));
    };
    $('bringupSetup').onsubmit = e => {
      e.preventDefault();
      safe(() => {
        save({checklist: [...$('bringupRows').children].map(readRow)});
        updateEditor();
        status('Checklist saved for new runs.');
      });
    };
    $('bringupNew').onsubmit = e => { e.preventDefault(); safe(startRun); };
    $('bringupRuns').onchange = e => {
      runId = e.target.value;
      compareId = undefined;
      switchStep(nextOutstanding(currentRun()));
      status('');
    };
    $('bringupCompare').onchange = e => { compareId = e.target.value; renderResults(currentRun()); };
    $('bringupSteps').onchange = e => {
      switchStep(currentRun().steps.find(s => s.id === e.target.value));
      status('');
    };
    $('bringupNext').onclick = () => status(next());
    for (const [button,face] of [['bringupTop','F'],['bringupBottom','B']]) $(button).onclick = () => {
      side = face;
      drawMap(currentRun(),currentStep(currentRun()));
    };
    $('bringupReading').onsubmit = e => {
      e.preventDefault();
      safe(() => {
        const value = parseVoltage($('bringupVolts').value);
        if (value === null) throw new Error('Enter a voltage such as 3.28 V or 250 mV.');
        const r = currentRun();
        status(append(r,currentStep(r),value));
      });
    };
    $('bringupDone').onclick = () => safe(() => {
      const r = currentRun();
      status(append(r,currentStep(r),null));
    });
    const dlg = $('benchDialog');
    function open() {
      sync();
      if (editorProject !== Model.S) updateEditor();
      render();
      if (!checklist().length && !runs().length) $('bringupSetup').closest('details').open = true;
      status(!checklist().length && !runs().length ?
        'Save a checklist with instructions and voltage limits, then start a board run.' : '');
    }
    dlg.addEventListener('bench-tab', e => {
      pendingReading = undefined;
      if (e.detail === 'bringup') open();
    });
    dlg.addEventListener('bench-open', () => { if (!$('bench-bringup').hidden) open(); });
    dlg.addEventListener('close', () => { pendingReading = undefined; });
    Model.subscribe(kind => {
      if (kind === 'load' && dlg.open && !$('bench-bringup').hidden) open();
    });
  }

  window.addEventListener('DOMContentLoaded',init);
  return {answer, next, expected, clearPending: () => { pendingReading = undefined; }};
})();
