// App updates (Windows app): when a newer CircuitPilot release is on GitHub, ask the user to download and install it.
(() => {
  const SKIP = 'cp-update-skip', esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MB = b => (b / 1e6).toFixed(0) + ' MB';
  let box = null, poll = null, later = false;
  const call = async (op, body) => {
    const r = await fetch('/api/update/' + op, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CircuitPilot-App': '1' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
  };
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  // the release text: headings, bullets and **bold** kept simple
  const notes = t => esc(String(t || '').replace(/\r/g, '').trim()).split('\n').slice(0, 40).map(l =>
    /^#+\s/.test(l) ? `<b>${l.replace(/^#+\s*/, '')}</b>` : /^\s*[-*]\s/.test(l) ? '• ' + l.replace(/^\s*[-*]\s*/, '') : l).join('<br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  function show(s, force) {
    const rel = s.latest || {}, d = s.download || {};
    if (!force && (later || get(SKIP) === rel.tag) && !d.active && !d.ready) return;
    if (!box) {
      box = document.createElement('div');
      box.id = 'updateBox';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;width:min(420px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 30px var(--shadow);padding:12px 14px;gap:8px';
      document.body.appendChild(box);
      box.addEventListener('click', onClick);
    }
    const busy = d.active, ready = d.ready;
    const prog = busy ? (d.phase === 'checking' ? 'Checking the download (SHA-256)…' : d.phase === 'unpacking' ? 'Unpacking…' : `Downloading… ${MB(d.bytes)} of ${d.total ? MB(d.total) : '?'}`) : '';
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:14px">⬆ CircuitPilot ${esc(rel.tag)} is available</b><button data-u="close" title="Close" class="small">✕</button></div>
      <div class="small muted">You have ${esc(s.current)}${rel.date ? ' · released ' + esc(rel.date) : ''}${rel.size ? ' · ' + MB(rel.size) : ''}</div>
      <div class="small" style="overflow:auto;max-height:36vh;border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--panel2)"><b>${esc(rel.name)}</b><br>${notes(rel.notes)}</div>
      ${busy ? `<progress value="${d.total ? d.bytes / d.total : 0}" style="width:100%"></progress><div class="small">${prog}</div>` : ''}
      ${d.error ? `<div class="small" style="color:var(--bad)">✗ ${esc(d.error)}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        ${!s.app ? `<a class="small" href="${esc(rel.page)}" target="_blank" rel="noopener"><button class="primary">Open the download page</button></a>`
          : ready ? '<span class="small" style="align-self:center">Downloaded. CircuitPilot closes, updates and opens again (your projects stay).</span><button data-u="install" class="primary">Install and restart</button>'
          : busy ? '<button data-u="cancel">Pause</button>'
          : `<button data-u="skip" class="small">Skip this version</button><button data-u="later">Later</button><button data-u="download" class="primary">Download update</button>`}
      </div>`;
  }
  async function onClick(e) {
    const b = e.target.closest('[data-u]'); if (!b) return;
    const op = b.dataset.u;
    if (op === 'close' || op === 'later') { later = true; box.remove(); box = null; return; }
    if (op === 'skip') { if (cur && cur.latest) put(SKIP, cur.latest.tag); box.remove(); box = null; return; }
    b.disabled = true;
    try {
      if (op === 'install') {
        box.innerHTML = '<b>Installing the update…</b><div class="small muted">CircuitPilot closes now and opens again with the new version in a few seconds.</div>';
        await call('install');
        return;
      }
      cur = await call(op); show(cur, true); watch();
    } catch (err) { b.disabled = false; alert('Update: ' + err.message); }
  }
  let cur = null;
  function watch() {
    clearTimeout(poll);
    if (cur && cur.download && cur.download.active) poll = setTimeout(async () => { try { cur = await call('check'); show(cur, true); } catch (e) {} watch(); }, 1000);
  }
  // the ⬆ Update button in the top bar (Windows app): always there, highlighted when a new version is out
  function button(s) {
    const b = document.getElementById('btnUpdate'); if (!b) return;
    if (!s || !s.current) return;
    b.classList.remove('hidden');
    b.classList.toggle('primary', !!s.newer);
    b.title = s.newer ? `CircuitPilot ${s.latest.tag} is available (you have ${s.current}) — click to update` : `CircuitPilot ${s.current} — click to check for a new version`;
    b.querySelector('.lbl').textContent = s.newer ? ' Update available' : ' Update';
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#btnUpdate'); if (!b) return;
    b.disabled = true; b.querySelector('.lbl').textContent = ' Checking…';
    check(true).finally(() => { b.disabled = false; button(cur); });
  });
  async function check(force) {
    try { cur = await call('check', { force }); } catch (e) { if (force) alert('Update check failed: ' + e.message); return; }
    button(cur);
    if (cur.newer || (cur.download && (cur.download.active || cur.download.ready))) { show(cur, force); watch(); }
    else if (force) alert(cur.current ? `CircuitPilot ${cur.current} is the latest version.` : 'This copy of CircuitPilot has no version number (not the Windows app).');
  }
  window.CPUpdate = { check: () => check(true) };
  setTimeout(() => check(false), 4000);              // after start-up
  setInterval(() => check(false), 6 * 3600 * 1000);  // and every 6 hours while it stays open
})();
