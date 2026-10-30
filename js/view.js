'use strict';
// Pan/zoom viewport shared by the schematic and PCB canvases.
class Viewport {
  constructor(svg, { min = 0.2, max = 40, scale = 2, onChange } = {}) {
    Object.assign(this, { svg, min, max, s: scale, cx: 0, cy: 0, onChange });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this.toWorld(e.clientX, e.clientY), r = svg.getBoundingClientRect();
      this.s = Math.min(this.max, Math.max(this.min, this.s * Math.exp(-e.deltaY * 0.0015)));
      this.cx = p.x - (e.clientX - r.left - r.width / 2) / this.s;
      this.cy = p.y - (e.clientY - r.top - r.height / 2) / this.s;
      this.apply();
    }, { passive: false });
    new ResizeObserver(() => this.apply()).observe(svg);
    // phones: one finger pans, two fingers pinch-zoom (a tap still selects through the mouse events the browser sends)
    let tp = null;
    const pts = e => [...e.touches].map(t => [t.clientX, t.clientY]);
    svg.addEventListener('touchstart', e => { tp = pts(e); }, { passive: true });
    svg.addEventListener('touchmove', e => {
      if (!tp) return; e.preventDefault(); const now = pts(e);
      if (now.length === 1 && tp.length === 1) this.panBy(now[0][0] - tp[0][0], now[0][1] - tp[0][1]);
      else if (now.length >= 2 && tp.length >= 2) {
        const c = q => [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], d = q => Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]) || 1;
        const c0 = c(tp), c1 = c(now), p = this.toWorld(c0[0], c0[1]), r = svg.getBoundingClientRect();
        this.s = Math.min(this.max, Math.max(this.min, this.s * d(now) / d(tp)));
        this.cx = p.x - (c1[0] - r.left - r.width / 2) / this.s; this.cy = p.y - (c1[1] - r.top - r.height / 2) / this.s; this.apply();
      }
      tp = now;
    }, { passive: false });
    svg.addEventListener('touchend', e => { tp = e.touches.length ? pts(e) : null; }, { passive: true });
  }
  toWorld(x, y) {
    const r = this.svg.getBoundingClientRect();
    return { x: this.cx + (x - r.left - r.width / 2) / this.s, y: this.cy + (y - r.top - r.height / 2) / this.s };
  }
  apply() {
    const r = this.svg.getBoundingClientRect(); if (!r.width) return;
    const w = r.width / this.s, h = r.height / this.s;
    this.vb = [this.cx - w / 2, this.cy - h / 2, w, h];
    this.svg.setAttribute('viewBox', this.vb.join(' '));
    this.onChange && this.onChange(this.vb);
  }
  fit(b, pad) {
    const r = this.svg.getBoundingClientRect(); if (!r.width || !b) return;
    const bw = b[2] - b[0] + 2 * pad, bh = b[3] - b[1] + 2 * pad;
    this.s = Math.min(this.max, Math.max(this.min, Math.min(r.width / bw, r.height / bh)));
    this.cx = (b[0] + b[2]) / 2; this.cy = (b[1] + b[3]) / 2; this.apply();
  }
  // bring box b into view: pan to it if it fits at the current zoom, otherwise zoom out to fit it
  reveal(b, pad) {
    if (!b) return; if (!this.vb) this.apply(); const v = this.vb; if (!v) return;
    if (b[0] - pad >= v[0] && b[1] - pad >= v[1] && b[2] + pad <= v[0] + v[2] && b[3] + pad <= v[1] + v[3]) return;
    if (b[2] - b[0] + 2 * pad <= v[2] && b[3] - b[1] + 2 * pad <= v[3]) { this.cx = (b[0] + b[2]) / 2; this.cy = (b[1] + b[3]) / 2; this.apply(); }
    else this.fit(b, pad);
  }
  panBy(dxPx, dyPx) { this.cx -= dxPx / this.s; this.cy -= dyPx / this.s; this.apply(); }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
