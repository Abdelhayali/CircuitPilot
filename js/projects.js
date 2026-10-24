'use strict';
// Projects stored on the server (projects.db) with autosave, plus the user's part library ("My Library").
const Projects = (() => {
  const $ = s => document.querySelector(s);
  let online = false, timer = null, lastSaved = '', saving = false, again = false;
  let myLib = [];
  let serverUpdated = 0; // server timestamp of the version we have

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function setStatus(s, title = '') {
    const el = $('#saveState'); if (!el) return;
    const map = { saved: ['✓ Saved', 'good'], saving: ['Saving…', 'muted'], dirty: ['● Unsaved', 'warn'], error: ['⚠ Not saved', 'bad'], local: ['Saved in this browser', 'muted'] };
    const [t, c] = map[s] || ['', '']; el.textContent = t; el.className = c; el.title = title;
  }

  // the server version the browser's copy (localStorage cp.design) is based on, so a change made while no tab was
  // open (Claude Desktop / Code over MCP) is not overwritten by an older browser copy at the next start
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36) + ':' + s.length; };
  function remember() { try { localStorage.setItem('cp.base', JSON.stringify({ id: Model.S.id, updated: serverUpdated, hash: hash(lastSaved) })); } catch (e) { } }

  // ---------- autosave ----------
  let paused = false;   // a folder import converts files in the editor model: those states must not be autosaved
  function schedule(kind) {
    if (kind === 'move' || paused) return;
    if (!online) { setStatus('local'); return; }
    if (Model.snapshot() === lastSaved) { setStatus('saved'); return; }
    setStatus('dirty'); clearTimeout(timer); timer = setTimeout(saveNow, 1200);
  }
  async function saveNow() {
    clearTimeout(timer);
    if (!online) { setStatus('local'); return false; }
    if (saving) { again = true; return; }
    const snap = Model.snapshot(); if (snap === lastSaved && Model.S.id) { setStatus('saved'); return true; }
    saving = true; setStatus('saving');
    try {
      const r = await api('PUT', '/api/projects/' + (Model.S.id || ''), JSON.parse(snap));
      serverUpdated = r.updated;
      if (!Model.S.id) { Model.S.id = r.id; lastSaved = Model.snapshot(); Model.emit('meta'); }
      else lastSaved = snap;
      remember();
      setStatus(Model.snapshot() === lastSaved ? 'saved' : 'dirty');
      return true;
    } catch (e) { setStatus('error', e.message); return false; }
    finally { saving = false; if (again) { again = false; schedule(); } }
  }

  // ---------- project actions ----------
  async function open(id) {
    if (Model.S.id || Model.S.components.length) await saveNow();   // nothing to keep in an empty, never-saved page
    const d = await api('GET', '/api/projects/' + id);
    serverUpdated = (await api('GET', '/api/projects/' + id + '/meta')).updated;
    Model.load(d); lastSaved = Model.snapshot(); remember(); setStatus('saved');
    App.showView('sch'); Sch.select(null); Sch.fit(); App.toast('Opened “' + (d.name || 'Untitled') + '”');
    close();
  }
  async function create(name) {
    await saveNow();
    const d = Model.blank(); d.name = name || 'Untitled';
    Model.load(d); lastSaved = '';
    await saveNow(); App.showView('sch'); Sch.select(null); Sch.fit();
    App.toast('Created project “' + d.name + '”'); close();
  }
  async function duplicate(id) {
    const d = await api('GET', '/api/projects/' + id);
    delete d.id; d.name = (d.name || 'Untitled') + ' (copy)';
    await api('PUT', '/api/projects/', d); render();
  }
  // Save as: store the current design (with its unsaved edits) as a new project and continue in it
  async function saveAs(name) {
    await saveNow();
    const d = JSON.parse(Model.snapshot()); delete d.id; d.name = name;
    const r = await api('PUT', '/api/projects/', d);
    Model.mutate(() => { Model.S.id = r.id; Model.S.name = name; });
    serverUpdated = r.updated; lastSaved = Model.snapshot(); Model.emit('meta'); setStatus('saved');
    App.toast('Saved as “' + name + '”'); return true;
  }
  async function rename(id, name) {
    if (id === Model.S.id) { Model.mutate(() => { Model.S.name = name; }); await saveNow(); }
    else { const d = await api('GET', '/api/projects/' + id); d.name = name; await api('PUT', '/api/projects/' + id, d); }
    render();
  }
  async function remove(id) {
    await api('DELETE', '/api/projects/' + id);
    if (id === Model.S.id) { const d = Model.blank(); d.name = 'Untitled'; Model.load(d); lastSaved = ''; await saveNow(); Sch.fit(); }
    render();
  }

  // ---------- dialog ----------
  const ago = t => { const s = Date.now() / 1000 - t; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(t * 1000).toLocaleDateString(); };
  async function render() {
    const list = $('#projList');
    if (!online) { list.innerHTML = '<div class="muted">Project storage needs the app to run with <code>server.py</code>. You can still download / import project files.</div>'; return; }
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const ps = await api('GET', '/api/projects'), q = $('#projSearch').value.toLowerCase();
      const rows = ps.filter(p => !q || (p.name || '').toLowerCase().includes(q));
      const note = window.CPStatic && CPStatic.mode === 'static' ? '<div class="muted small" style="margin-bottom:8px">Web version: projects are saved in this browser only. Use Export → Project file (.json) to back them up or move them to another device.</div>' : '';
      list.innerHTML = note + (rows.length ? rows.map(p => `<div class="proj${p.id === Model.S.id ? ' cur' : ''}" data-id="${esc(p.id)}">
        <div class="pinfo"><div class="pname">${esc(p.name || 'Untitled')}${p.id === Model.S.id ? ' <span class="badge basic">open</span>' : ''}</div>
        <div class="muted small">${p.parts} parts · ${p.nets} nets${p.pcb ? ' · PCB' : ''} · ${ago(p.updated)}</div></div>
        <div class="pact"><button data-a="open" class="primary">Open</button><button data-a="dup" title="Duplicate">⧉</button>${hasHistory ? '<button data-a="hist" title="Earlier versions (restore)">⟲</button>' : ''}<button data-a="ren" title="Rename">✎</button><button data-a="del" class="danger" title="Delete">🗑</button></div></div>`).join('')
        : '<div class="muted">No projects yet.</div>') + (hasHistory ? '<div class="proj"><div class="pinfo muted small">Every project keeps earlier versions (⟲). </div><div class="pact"><button data-a="deleted">Deleted projects…</button></div></div>' : '');
    } catch (e) { list.innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
  }
  // earlier versions of a project (desktop server keeps them: every ~10 min while editing, big part losses, deletes)
  const hasHistory = !(window.CPStatic && CPStatic.mode === 'static');
  async function showHistory(id, name) {
    const list = $('#projList'), vs = await api('GET', '/api/projects/' + id + '/versions');
    const when = t => new Date(t * 1000).toLocaleString();
    list.innerHTML = `<div class="proj" data-id="${esc(id)}"><div class="pinfo"><div class="pname">${esc(name)}</div><div class="muted small">Earlier versions — newest first</div></div><div class="pact"><button data-a="back">← Back</button></div></div>` +
      (vs.length ? vs.map(v => `<div class="proj" data-id="${esc(id)}"><div class="pinfo"><div class="pname" style="display:none">${esc(name)}</div><div>${esc(when(v.saved))}</div>
        <div class="muted small">${v.parts} parts · ${esc(v.reason === 'parts removed' ? 'saved before parts were removed' : v.reason === 'deleted' ? 'state when deleted' : v.reason === 'before restore' ? 'state before a restore' : 'autosave')}</div></div>
        <div class="pact"><button data-a="restore" data-v="${v.version}" data-when="${esc(when(v.saved))}" class="primary">Restore</button></div></div>`).join('') : '<div class="muted">No earlier versions yet (they are kept while you edit, about every 10 minutes).</div>');
  }
  async function showDeleted() {
    const list = $('#projList'), ds = await api('GET', '/api/projects/_deleted');
    list.innerHTML = `<div class="proj"><div class="pinfo"><div class="pname">Deleted projects</div></div><div class="pact"><button data-a="back">← Back</button></div></div>` +
      (ds.length ? ds.map(p => `<div class="proj" data-id="${esc(p.id)}"><div class="pinfo"><div class="pname">${esc(p.name || 'Untitled')}</div><div class="muted small">${p.parts} parts · deleted ${esc(new Date(p.deleted * 1000).toLocaleString())}</div></div>
        <div class="pact"><button data-a="hist" title="Versions of this project">⟲ Versions</button></div></div>`).join('') : '<div class="muted">No deleted projects.</div>');
  }
  function show() { $('#projModal').classList.remove('hidden'); $('#projSearch').value = ''; render(); }
  function close() { $('#projModal').classList.add('hidden'); }

  // ---------- My Library ----------
  async function loadLibrary() {
    if (!online) return myLib;
    try { myLib = await api('GET', '/api/library'); } catch (e) { }
    return myLib;
  }
  async function savePart(def) {
    if (!online) throw new Error('Saving to My Library needs server.py');
    await api('PUT', '/api/library/' + encodeURIComponent(def.key), def);
    await loadLibrary(); return true;
  }
  async function deletePart(key) { await api('DELETE', '/api/library/' + encodeURIComponent(key)); await loadLibrary(); }

  async function poll() {
    if (!online || !Model.S.id || saving || document.hidden) return;
    if (Model.snapshot() !== lastSaved) return; // local edits pending — they win
    try {
      const m = await api('GET', '/api/projects/' + Model.S.id + '/meta');
      if (serverUpdated && m.updated > serverUpdated + 0.001) {
        const d = await api('GET', '/api/projects/' + Model.S.id);
        if (Model.snapshot() !== lastSaved) return;
        serverUpdated = m.updated; Model.load(d, true); lastSaved = Model.snapshot(); remember(); setStatus('saved');
        if (window.Sch && Sch.offscreen && Sch.offscreen()) Sch.fit();   // parts moved out of view (e.g. auto-layout from Claude Code)
        App.toast('Project updated by an external tool');
      } else if (!serverUpdated) serverUpdated = m.updated;
    } catch (e) { }
  }
  // Screenshot requests from Claude Code (view_design over MCP): server.py relays them to the tab that has the
  // project open. Long-polling keeps working while the tab is in the background (timers there are throttled).
  async function pullLatest() {
    if (!online || !Model.S.id || Model.snapshot() !== lastSaved) return;   // local edits are newer
    try {
      const m = await api('GET', '/api/projects/' + Model.S.id + '/meta');
      if (m.updated > serverUpdated + 0.001) { const d = await api('GET', '/api/projects/' + Model.S.id); serverUpdated = m.updated; Model.load(d, true); lastSaved = Model.snapshot(); setStatus('saved'); }
    } catch (e) { }
  }
  async function renderLoop() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let ctl = null, pid = null, since = Date.now() / 1000;   // focus requests older than this page are ignored
    Model.subscribe(() => { if (ctl && Model.S.id !== pid) ctl.abort(); });   // another project opened: wait for its requests now
    for (;;) {
      if (!Model.S.id || !Engine.env.render) { await sleep(3000); continue; }
      let job = null;
      ctl = new AbortController(); pid = Model.S.id;
      try {
        const r = await fetch('/api/render/next?project=' + encodeURIComponent(pid) + '&since=' + since, { signal: ctl.signal });
        if (r.status === 200) job = await r.json(); else if (r.status !== 204) { await sleep(10000); continue; }
      } catch (e) { if (!ctl.signal.aborted) await sleep(10000); continue; }
      if (job && Model.S.id !== pid) { try { await fetch('/api/render/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, error: 'The project was closed in the browser' }) }); } catch (e) { } continue; }
      if (!job) continue;
      if (job.focus) {   // Claude (MCP) is working on another project: follow it so the user sees the work live
        since = job.t;
        if (job.focus !== Model.S.id) { try { await open(job.focus); App.toast('Following Claude: opened the project it is working on', 5000); } catch (e) { } }
        continue;
      }
      let out;
      try { await pullLatest(); const img = await Engine.env.render(job.args || {}); out = { id: job.id, mime: img.mime, data: img.data, w: img.w, h: img.h }; }
      catch (e) { out = { id: job.id, error: e.message || String(e) }; }
      try { await fetch('/api/render/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) }); } catch (e) { }
    }
  }
  async function init() {
    try { await api('GET', '/api/projects'); online = true; } catch (e) { online = false; }
    Model.subscribe(schedule);
    if (online) {
      await loadLibrary();
      if (Model.S.id) { // the browser's copy: still on the server? changed there since (by a copilot)?
        try {
          const id = Model.S.id, m = await api('GET', '/api/projects/' + id + '/meta'), d = await api('GET', '/api/projects/' + id);
          let base = null; try { base = JSON.parse(localStorage.getItem('cp.base') || 'null'); } catch (e) { }
          if (base && base.id !== id) base = null;
          const local = Model.snapshot(), clean = !!base && base.hash === hash(local);
          const newer = !base || m.updated > (base.updated || 0) + 0.001;
          if (newer) {
            Model.load(d); const srv = Model.snapshot();
            if (srv !== local && !clean) {   // edited in both places: the server's version stays, the browser's edits become a copy
              const c = JSON.parse(local); delete c.id; c.name = (c.name || 'Untitled') + ' (browser copy)';
              try { await api('PUT', '/api/projects/', c); setTimeout(() => App.toast('This project was changed by Claude while CircuitPilot was closed — showing that version. Your unsaved browser edits are in “' + c.name + '” (Projects).', 12000), 500); } catch (e) { }
            }
            serverUpdated = m.updated; lastSaved = srv; remember();
          }
        } catch (e) { delete Model.S.id; }
      }
      // a link like /?project=<id> (Claude Desktop, or a drawing window the MCP server starts) shows that project —
      // an empty page opened that way is not saved as a new "Untitled" project first
      const want = new URLSearchParams(location.search).get('project');
      if (!(want && !Model.S.id && !Model.S.components.length)) await saveNow();
      setInterval(poll, 2500);
      if (!(window.CPStatic && CPStatic.mode === 'static')) renderLoop();   // screenshots for Claude: start before opening
      if (want && want !== Model.S.id) { try { await open(want); } catch (e) { } history.replaceState(null, '', location.pathname); }
    } else setStatus('local');
    $('#projClose').onclick = close;
    $('#projSearch').oninput = render;
    $('#projNew').onclick = () => { const n = prompt('Project name', 'New project'); if (n !== null) create(n.trim() || 'Untitled'); };
    $('#projImport').onclick = () => $('#fileIn').click();
    $('#projList').onclick = async e => {
      const b = e.target.closest('button[data-a]'), row = e.target.closest('.proj');
      if (b && b.dataset.a === 'back') return render();
      if (b && b.dataset.a === 'deleted') return showDeleted().catch(err => App.toast(err.message));
      if (!b || !row) return;
      const id = row.dataset.id, name = row.querySelector('.pname').firstChild.textContent;
      try {
        if (b.dataset.a === 'open') await open(id);
        if (b.dataset.a === 'dup') await duplicate(id);
        if (b.dataset.a === 'ren') { const n = prompt('Rename project', name); if (n && n.trim()) await rename(id, n.trim()); }
        if (b.dataset.a === 'del' && confirm(`Delete project “${name}”?${hasHistory ? ' (It can be brought back later from ⟲ Deleted projects.)' : ' This cannot be undone.'}`)) await remove(id);
        if (b.dataset.a === 'hist') await showHistory(id, name);
        if (b.dataset.a === 'restore') {
          const v = +b.dataset.v, d = b.dataset.when;
          if (confirm(`Restore “${name}” to the version of ${d}? The current state is kept as a version too.`)) {
            if (id === Model.S.id) await saveNow();
            await api('POST', '/api/projects/' + id + '/restore', { version: v });
            if (id === Model.S.id || b.dataset.deleted) await open(id); else render();
            App.toast(`Restored “${name}” (${d})`);
          }
        }
      } catch (err) { App.toast(err.message); }
    };
  }
  return { init, show, close, saveNow, saveAs, create, openId: open, pause: v => { paused = !!v; if (paused) clearTimeout(timer); }, get online() { return online; }, get myLib() { return myLib; }, loadLibrary, savePart, deletePart, markLoaded: () => { lastSaved = ''; } };
})();
