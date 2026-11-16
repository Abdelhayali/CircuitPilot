'use strict';
// Firmware for the design's MCU. design_pins.h is made from the schematic: every connected signal pin of the MCU
// becomes a PIN_ macro (#define PIN_HBC_TX 5 // U1.5 GPIO5 -> HBC_TX), so code never hard-codes a pin number.
// The code files are kept with the design: S.firmware = { mcu: 'U1', files: { 'name.ino': text } }.
// Arduino style by default; any text file (C, MicroPython, CircuitPython, Rust ...) can be kept too.
// Exports write them to firmware/<design>/<design>/ (the Arduino sketch folder rule: folder name = sketch name).
// Pure functions of the design (no DOM) except open / mount, so the MCP server can run them too.
const Firmware = (() => {
  const HEADER = 'design_pins.h';
  // parts that are not the MCU even with many pins
  const NOT_MCU = /^(R|C|L|D|LED|Q|SW|J|TP|F|FB|Y|BT|BZ|K|FID|H|MH)\d/i;
  // names that say "this part is a microcontroller or a module with one"
  const MCU_RE = /ESP32|ESP8266|RP2040|RP2350|PICO|NRF5|XIAO|SEEED|STM32|ATMEGA|ATTINY|ATSAM|SAMD|ARDUINO|NANO|UNO|MEGA|LEONARDO|TEENSY|CH32|CH55|PIC\d|PIC32|MSP430|NUCLEO|BLUEPILL|GD32|MICROBIT|EFM32|CC26|CC13|PY32|RA4M|MCU|WROOM|MINI-?1|SUPERMINI|BMD|NRF52/i;
  // boards whose headers say D0..D10 (Arduino names): the chip port each one is wired to
  const BOARDS = [
    { name: 'XIAO nRF52840 (Seeed nRF52)', re: /XIAO.*(52840|NRF)|(52840|NRF).*XIAO/i, map: { D0: 'P0.02', D1: 'P0.03', D2: 'P0.28', D3: 'P0.29', D4: 'P0.04', D5: 'P0.05', D6: 'P1.11', D7: 'P1.12', D8: 'P1.13', D9: 'P1.14', D10: 'P1.15' } },
    { name: 'XIAO ESP32-S3', re: /XIAO.*S3/i, map: { D0: 'GPIO1', D1: 'GPIO2', D2: 'GPIO3', D3: 'GPIO4', D4: 'GPIO5', D5: 'GPIO6', D6: 'GPIO43', D7: 'GPIO44', D8: 'GPIO7', D9: 'GPIO8', D10: 'GPIO9' } },
    { name: 'XIAO ESP32-C3', re: /XIAO.*(C3|ESP32)/i, map: { D0: 'GPIO2', D1: 'GPIO3', D2: 'GPIO4', D3: 'GPIO5', D4: 'GPIO6', D5: 'GPIO7', D6: 'GPIO21', D7: 'GPIO20', D8: 'GPIO8', D9: 'GPIO9', D10: 'GPIO10' } },
    { name: 'XIAO RP2040', re: /XIAO.*RP2040/i, map: { D0: 'GP26', D1: 'GP27', D2: 'GP28', D3: 'GP29', D4: 'GP6', D5: 'GP7', D6: 'GP0', D7: 'GP1', D8: 'GP2', D9: 'GP4', D10: 'GP3' } },
  ];
  // ATmega328P (Uno, Nano, Pro Mini): port bits to Arduino pin names
  const AVR_RE = /ATMEGA328|ATMEGA168|UNO|NANO|PRO\s?MINI/i;
  const family = t => /ESP32|ESP8266/i.test(t) ? 'ESP32 / ESP8266 (Arduino-ESP32 core)' : /RP2040|RP2350|PICO/i.test(t) ? 'RP2040 / Pico (arduino-pico core)'
    : /NRF5|NRF52/i.test(t) ? 'nRF52 (Arduino nRF52 core)' : /STM32|NUCLEO|BLUEPILL/i.test(t) ? 'STM32 (STM32duino core)' : AVR_RE.test(t) ? 'AVR ATmega328P (Arduino AVR core)'
    : /SAMD|ATSAM/i.test(t) ? 'SAMD (Arduino SAMD core)' : /TEENSY/i.test(t) ? 'Teensy (Teensyduino)' : /CH32|CH55/i.test(t) ? 'WCH CH32 / CH55' : /PIC|MSP430|GD32|RA4M|EFM32|CC26|CC13|PY32|MICROBIT/i.test(t) ? 'other MCU family' : 'Arduino-style MCU';

  const text = c => `${c.name || ''} ${c.value || ''} ${c.type || ''} ${c.footprint || ''}`;
  // the pins of a part that are connected to a net
  function connectedPins(c) {
    return Model.pinsWorld(c).map(p => ({ num: String(p.num), name: String(p.name || ''), net: Model.netOf(p.key) })).filter(p => p.net);
  }
  // the MCU: the chosen part, else the one whose name says MCU / module, else the part with the most connected pins
  function mcuOf(S = Model.S) {
    const cs = S.components || [], fw = S.firmware || {}, pick = c => c && { c, ref: c.ref, text: text(c), pins: connectedPins(c) };
    if (fw.mcu) { const c = cs.find(x => x.ref === fw.mcu); if (c) return pick(c); }
    const cands = cs.filter(c => !NOT_MCU.test(c.ref) && MCU_RE.test(text(c)));
    let best = null, n = -1;
    for (const c of (cands.length ? cands : cs.filter(c => !NOT_MCU.test(c.ref)))) { const k = connectedPins(c).length; if (k > n) { n = k; best = c; } }
    return best && (cands.length || n >= 4) ? pick(best) : null;
  }
  // the Arduino expression of one MCU pin, from its name on the schematic. todo: no number could be found
  function pinExpr(m, p) {
    const toks = String(p.name).toUpperCase().split(/[\s\/,]+/).filter(Boolean), board = BOARDS.find(b => b.re.test(m.text));
    for (const t of toks) if (/^[DA]\d{1,2}$/.test(t)) return { expr: t };
    if (board) for (const t of toks) { const dn = Object.keys(board.map).find(k => board.map[k] === t); if (dn) return { expr: dn, note: t }; }
    if (AVR_RE.test(m.text)) for (const t of toks) {
      const b = /^P([BCD])([0-7])$/.exec(t); if (!b) continue;
      const port = b[1], n = +b[2];
      if (port === 'D') return { expr: 'D' + n };
      if (port === 'B' && n <= 5) return { expr: 'D' + (n + 8) };
      if (port === 'C' && n <= 5) return { expr: 'A' + n };
    }
    for (const t of toks) { const g = /(?:GPIO|GP|IO)(\d+)$/.exec(t); if (g) return { expr: g[1] }; }
    for (const t of toks) if (/^P[A-K]\d+$/.test(t)) return { expr: t };        // STM32duino pin names (PA5)
    for (const t of toks) if (/^\d+$/.test(t)) return { expr: t };              // boards with numbered pins
    const label = toks[0] || 'pin ' + p.num;
    return { expr: '0', note: `no Arduino name for "${label}": set the number from the board pinout`, todo: true };
  }
  // the generated header and its pin list
  function build(S = Model.S) {
    const m = mcuOf(S), L = [], pins = [], used = new Set();
    L.push(`// ${HEADER}: pin names of "${S.name || 'this design'}", made by CircuitPilot from the schematic.`);
    L.push('// Rebuilt on every save: change the schematic, not this file. Include it with #include "design_pins.h".', '#pragma once', '');
    if (!m) { L.push('// No MCU found in the design: choose one in Firmware > MCU.'); return { text: L.join('\n') + '\n', pins, mcu: null }; }
    const board = BOARDS.find(b => b.re.test(m.text));
    L.push(`// MCU ${m.ref}: ${m.c.name || m.c.value || m.c.type}`, `// Core: ${family(m.text)}${board ? ' · board: ' + board.name : ''}`, '');
    const sig = m.pins.filter(p => !Model.isGround(p.net) && !Model.isPower(p.net))
      .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
    if (!sig.length) L.push('// No signal pins of the MCU are connected yet.');
    for (const p of sig) {
      let id = /^N\$\d+$/.test(p.net) ? `PIN_${m.ref}_${p.num}` : 'PIN_' + p.net.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const base = id; let i = 2; while (used.has(id)) id = base + '_' + i++; used.add(id);
      const r = pinExpr(m, p);
      pins.push({ id, mcu_pin: `${m.ref}.${p.num}`, name: p.name, net: p.net, expr: r.expr, note: r.note || null, todo: !!r.todo });
      L.push(`#define ${id.padEnd(28)} ${r.expr.padEnd(7)} // ${m.ref}.${p.num}${p.name ? ' ' + p.name : ''} -> ${p.net}${r.note ? ' (' + r.note + ')' : ''}`);
    }
    return { text: L.join('\n') + '\n', pins, mcu: m };
  }
  const userFiles = (S = Model.S) => Object.assign({}, (S.firmware && S.firmware.files) || {});
  const validName = n => /^[A-Za-z0-9_][\w.\-\/]{0,80}$/.test(n) && !n.includes('..') && !n.endsWith('/');

  // everything the code needs, plus the checks: PIN_ names used in the files that the header does not define
  function info() {
    const S = Model.S, b = build(S), files = userFiles(S), warnings = [];
    const defined = new Set(b.pins.map(p => p.id));
    for (const p of b.pins) if (p.todo) warnings.push(`${HEADER}: ${p.id} (${p.mcu_pin}) has no pin number: ${p.note}`);
    if (!b.mcu) warnings.push('No MCU found in the design: choose one in Firmware > MCU.');
    for (const [n, t] of Object.entries(files)) {
      const seen = new Set();
      for (const x of t.matchAll(/\bPIN_[A-Z0-9_]+\b/g)) if (!defined.has(x[0]) && !seen.has(x[0])) { seen.add(x[0]); warnings.push(`${n} uses ${x[0]}, which ${HEADER} does not define`); }
      if (/\bPIN_[A-Z0-9_]+\b/.test(t) && !/#\s*include\s*[<"](\.\/)?design_pins\.h[>"]/.test(t)) warnings.push(`${n} uses PIN_ names but does not #include "design_pins.h"`);
    }
    return {
      mcu: b.mcu ? { ref: b.mcu.ref, name: b.mcu.c.name || b.mcu.c.value || b.mcu.c.type, chosen: !!(S.firmware && S.firmware.mcu), core: family(b.mcu.text) } : null,
      header: HEADER, header_text: b.text, pins: b.pins, files: Object.keys(files), warnings,
    };
  }
  // the files of the design for export: the generated header and the code files
  function files(S = Model.S) {
    const b = build(S), out = {};
    if (b.mcu) out[HEADER] = b.text;
    return Object.assign(out, userFiles(S));
  }
  // read: code files (text) and the MCU chosen (or automatic)
  function get() {
    const S = Model.S, b = build(S);
    return { mcu: (S.firmware && S.firmware.mcu) || null, mcu_auto: b.mcu ? b.mcu.ref : null, files: userFiles(S), header: b.text, header_name: HEADER };
  }
  // write one file (text, or delete: true), and/or choose the MCU part (mcu: ref, "" = automatic)
  function set(input = {}) {
    const name = String(input.file || '').trim();
    return Model.mutate(() => {
      const S = Model.S, fw = Object.assign({}, S.firmware || {}), fl = Object.assign({}, fw.files || {});
      if (input.mcu !== undefined) {
        if (input.mcu) { const c = Model.comp(String(input.mcu)); if (!c) throw new Error(`No part ${input.mcu} in this design`); fw.mcu = c.ref; }
        else delete fw.mcu;
      }
      if (name) {
        if (!validName(name)) throw new Error(`Bad file name "${name}": letters, digits, . _ - and / for folders`);
        if (name === HEADER) throw new Error(`${HEADER} is made from the schematic and cannot be written`);
        if (input.delete) delete fl[name];
        else if (input.text != null) fl[name] = String(input.text);
        else throw new Error('Give the text of the file (or delete: true)');
      }
      fw.files = fl; S.firmware = fw;
      return { file: name || null, mcu: fw.mcu || null, files: Object.keys(fl) };
    }, 'firmware');
  }
  const sketchTemplate = name => `// ${name}: Arduino sketch of "${Model.S.name || 'this design'}".\n// Pin names come from design_pins.h (made from the schematic).\n#include "design_pins.h"\n\nvoid setup() {\n  Serial.begin(115200);\n  // pinMode(PIN_NAME, OUTPUT);\n}\n\nvoid loop() {\n}\n`;

  // ---------- the Firmware dialog (opened from the schematic toolbar) ----------
  let cur = null, saveT = 0;
  const $i = id => document.getElementById(id);
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = t => { $i('fwStatus').textContent = t || ''; };
  function paint(full) {
    if (!$i('fwModal') || $i('fwModal').classList.contains('hidden')) return;
    const i = info(), S = Model.S, fw = S.firmware || {}, cs = S.components.filter(c => !NOT_MCU.test(c.ref));
    $i('fwBoard').textContent = i.mcu ? `${i.mcu.ref} ${i.mcu.name} · ${i.mcu.core} · ${i.pins.length} connected pins` : 'No MCU in the design yet: place a microcontroller, or choose one above.';
    $i('fwHeader').textContent = i.header_text;
    $i('fwWarn').innerHTML = i.warnings.length ? i.warnings.map(w => `<div>${h(w)}</div>`).join('') : '<div class="muted">No problems found.</div>';
    if (!full) return;
    $i('fwMcu').innerHTML = `<option value="">Automatic${i.mcu ? ' (' + h(i.mcu.ref) + ')' : ''}</option>` + cs.map(c => `<option value="${h(c.ref)}">${h(c.ref)} · ${h(c.name || c.value || c.type || '')}</option>`).join('');
    $i('fwMcu').value = fw.mcu && cs.some(c => c.ref === fw.mcu) ? fw.mcu : '';
    if (!cur || (cur !== HEADER && !i.files.includes(cur))) cur = i.files[0] || HEADER;
    $i('fwTabs').innerHTML = [HEADER, ...i.files].map(n => `<button class="fw-tab${n === cur ? ' on' : ''}" data-f="${h(n)}">${h(n)}${n === HEADER ? ' (made from the schematic)' : ''}</button>`).join('');
    const ta = $i('fwText'); ta.readOnly = cur === HEADER;
    ta.value = cur === HEADER ? i.header_text : (get().files[cur] || '');
    if (!$i('fwNewName').value) $i('fwNewName').value = (Exports.slug(S.name) || 'sketch') + '.ino';
  }
  function flush() {
    clearTimeout(saveT); saveT = 0;
    if (!cur || cur === HEADER) return;
    try { set({ file: cur, text: $i('fwText').value }); status(''); } catch (e) { status(e.message); }
  }
  function open() {
    $i('fwModal').classList.remove('hidden');
    status(''); cur = null; paint(true);
  }
  function close() { flush(); $i('fwModal').classList.add('hidden'); }
  // the chat asks the AI copilot to write the file (it reads firmware_pins and writes with set_firmware)
  function askAi() {
    flush();
    const target = cur && cur !== HEADER ? cur : ($i('fwNewName').value.trim() || 'the sketch');
    const p = $i('prompt'); if (!p) return;
    const ask = `Write the firmware for the MCU of this design in the file "${target}" (set_firmware). Use the PIN_ names of design_pins.h (firmware_pins lists them) and #include "design_pins.h"; no hard-coded pin numbers. Arduino style unless I ask for another language. Afterwards list what each pin does and what to check on the board.`;
    p.value = p.value.trim() ? p.value.trim() + '\n\n' + ask : ask;
    close(); p.focus();
  }
  function mount() {
    if (!$i('fwModal')) return;
    $i('fwClose').onclick = close;
    $i('fwMcu').onchange = e => { try { set({ mcu: e.target.value }); status(''); } catch (err) { status(err.message); } paint(true); };
    $i('fwTabs').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; flush(); cur = b.dataset.f; paint(true); };
    $i('fwText').oninput = () => { if (cur === HEADER) return; clearTimeout(saveT); saveT = setTimeout(flush, 500); };
    $i('fwNew').onclick = () => {
      const name = $i('fwNewName').value.trim(); flush();
      try { set({ file: name, text: /\.ino$/i.test(name) ? sketchTemplate(name) : '' }); cur = name; status('Saved ' + name); } catch (e) { status(e.message); }
      paint(true);
    };
    $i('fwDel').onclick = () => {
      if (!cur || cur === HEADER) { status(HEADER + ' is made from the schematic: it cannot be deleted.'); return; }
      try { set({ file: cur, delete: true }); status('Deleted ' + cur + ' (Undo brings it back).'); cur = null; } catch (e) { status(e.message); }
      paint(true);
    };
    $i('fwAsk').onclick = askAi;
    Model.subscribe(kind => { if (kind === 'load') { cur = null; paint(true); } else paint(false); });
  }
  return { info, files, get, set, build, mcuOf, open, mount, close, HEADER, BOARDS };
})();
