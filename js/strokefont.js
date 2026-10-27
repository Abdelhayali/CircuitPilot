'use strict';
// Simple stroke font (glyphs on a 4 × 6 grid, y up): silkscreen text (Gerber has no fonts) and the 3D script's text().
const StrokeFont = (() => {
  const GLYPHS = {
    '0': '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0', '1': '1,5 2,6 2,0|1,0 3,0', '2': '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
    '3': '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1|1,3 3,3', '4': '3,0 3,6 0,2 4,2', '5': '4,6 0,6 0,3 3,3 4,2 4,1 3,0 0,0',
    '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3', '7': '0,6 4,6 1,0', '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
    '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
    A: '0,0 0,4 2,6 4,4 4,0|0,3 4,3', B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0', C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
    D: '0,0 0,6 2,6 4,4 4,2 2,0 0,0', E: '4,6 0,6 0,0 4,0|0,3 3,3', F: '4,6 0,6 0,0|0,3 3,3', G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
    H: '0,0 0,6|4,0 4,6|0,3 4,3', I: '1,6 3,6|2,6 2,0|1,0 3,0', J: '4,6 4,1 3,0 1,0 0,1', K: '0,0 0,6|4,6 0,2|1,3 4,0', L: '0,6 0,0 4,0',
    M: '0,0 0,6 2,3 4,6 4,0', N: '0,0 0,6 4,0 4,6', O: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0', P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
    Q: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|2,2 4,0', R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0', S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
    T: '0,6 4,6|2,6 2,0', U: '0,6 0,1 1,0 3,0 4,1 4,6', V: '0,6 2,0 4,6', W: '0,6 1,0 2,3 3,0 4,6', X: '0,0 4,6|0,6 4,0', Y: '0,6 2,3 4,6|2,3 2,0',
    Z: '0,6 4,6 0,0 4,0', '-': '1,3 3,3', '_': '0,0 4,0', '.': '1.8,0 2.2,0 2.2,0.4 1.8,0.4 1.8,0', '+': '2,1.5 2,4.5|0.5,3 3.5,3', '/': '0,0 4,6',
    '(': '3,6 2,5 2,1 3,0', ')': '1,6 2,5 2,1 1,0', ':': '1.8,1 2.2,1|1.8,4 2.2,4', '#': '1,0 1,6|3,0 3,6|0,2 4,2|0,4 4,4', ',': '2,0.5 1.4,-0.8',
    '?': '0,5 1,6 3,6 4,5 4,4 2,3 2,2|2,0 2,0.4', '=': '0.5,2 3.5,2|0.5,4 3.5,4', '*': '2,1 2,5|0.5,2 3.5,4|0.5,4 3.5,2', "'": '2,6 2,4.5',
  };
  const ADV = 5.5;   // grid units per character (glyph 4 + gap 1.5)
  const parsed = {};   // glyph strings → stroke point arrays, parsed once
  const glyph = ch => parsed[ch] || (parsed[ch] = ch === ' ' ? [] : (GLYPHS[ch] != null ? GLYPHS[ch] : GLYPHS['?']).split('|').map(st => st.split(' ').map(p => p.split(',').map(Number))));
  // text → polylines in board mm (y down). x / y: anchor point on the baseline; mirror: read from the bottom side
  function strokeText(str, x, y, h, anchor = 'start', mirror = false) {
    const u = h / 6, s = String(str).toUpperCase(), width = Math.max(0, s.length * ADV - 1.5) * u;
    const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x, out = [];
    const mid = 2 * (x0 + width / 2);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], g = glyph(ch);
      for (const stroke of g) out.push(stroke.map(([gx, gy]) => { let px = x0 + (i * ADV + gx) * u; if (mirror) px = mid - px; return [Math.round(px * 1e4) / 1e4, Math.round((y - gy * u) * 1e4) / 1e4]; }));
    }
    return out;
  }
  const textWidth = (str, h) => Math.max(0, String(str).length * ADV - 1.5) * h / 6;
  return { GLYPHS, ADV, glyph, strokeText, textWidth };
})();
if (typeof module !== 'undefined') module.exports = StrokeFont;
