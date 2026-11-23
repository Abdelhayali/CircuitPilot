'use strict';
// Projects stored on the server (projects.db) with autosave, plus the user's part library ("My Library").
const Projects = (() => {
  const $ = s => document.querySelector(s);
  let online = false, timer = null, lastSaved = '', saving = false, again = false;
  let myLib = [];
  let serverUpdated = 0; // server timestamp of the version we have

  // deletes the user clicked carry X-CircuitPilot-User (the server refuses bulk deletes without it)
  async function api(method, path, body, user) {
    const h = body ? { 'content-type': 'application/json' } : {}; if (user) h['X-CircuitPilot-User'] = '1';
    const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; e.job = j.job; throw e; }
    return j;
  }
  function setStatus(s, title = '') {
    const el = $('#saveState'); if (!el) return;
    const map = { saved: ['✓ Saved', 'good'], saving: ['Saving…', 'muted'], dirty: ['● Unsaved', 'warn'], error: ['⚠ Not saved', 'bad'], local: ['Saved in this browser', 'muted'], locked: ['🔒 Locked', 'muted'] };
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
    if (Model.S.locked) { lockState(); return; }
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
      if (typeof Cloud !== 'undefined') Cloud.saved(Model.S.id);   // signed in with Google: the project goes to Drive too
      if (window.GitHubAuto) GitHubAuto.saved();   // auto-save to GitHub, if turned on
      return true;
    } catch (e) { if (e.status === 423) { setLock(e.job || 'a job'); return false; } setStatus('error', e.message); return false; }
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
  // the design exactly as a board revision was made: the project itself when it has not changed since, else a copy
  // ("name — CP-K7Q2M R2 (as made)") from the copy kept with that revision
  async function openRevision(id, pcb, rev) {
    const d = await api('GET', '/api/projects/' + id), revs = (d.fab && d.fab.revs) || [], r = revs.find(x => (x.pcb || 1) === pcb && x.rev === rev);
    if (!r || !r.snap) { App.toast('That revision has no saved copy'); return; }
    const mine = revs.filter(x => (x.pcb || 1) === pcb), code = d.fab.id + (pcb > 1 || revs.some(x => (x.pcb || 1) > 1) ? '-' + pcb : '');
    if (r === mine[mine.length - 1]) {
      await open(id);
      if (Pcb.fabRevisions().some(x => x.pcb === pcb && x.rev === rev && x.current)) { App.toast(`${code} R${rev} is the design as it is now`, 8000); return; }
    }
    const snap = JSON.parse(r.snap); delete snap.id; snap.fab = { id: d.fab.id, asMade: { pcb, rev, hash: r.hash }, revs: [] }; snap.name = (d.name || 'Untitled') + ' — ' + code + ' R' + rev + ' (as made)';
    snap.notes = Object.assign({ text: '', values: {} }, snap.notes || {});
    snap.notes.text = `Copy of ${d.name || 'the project'} as board ${code} R${rev} was made (${new Date(r.at * 1000).toLocaleString()}, ${r.via || 'export'}). Edit the original project, not this copy.` + (snap.notes.text ? '\n\n' + snap.notes.text : '');
    const made = await api('PUT', '/api/projects/', snap); await open(made.id);
    App.toast(`Opened ${code} R${rev} as it was made — a separate copy of the design`, 9000);
  }
  async function duplicate(id) {
    const d = await api('GET', '/api/projects/' + id);
    delete d.id; delete d.fab; d.name = (d.name || 'Untitled') + ' (copy)';   // a copy is a new board: its own code
    await api('PUT', '/api/projects/', d); render();
  }
  // Save as: store the current design (with its unsaved edits) as a new project and continue in it
  async function saveAs(name) {
    await saveNow();
    const d = JSON.parse(Model.snapshot()); delete d.id; delete d.fab; d.name = name;
    const r = await api('PUT', '/api/projects/', d);
    Model.mutate(() => { Model.S.id = r.id; Model.S.name = name; delete Model.S.fab; });
    serverUpdated = r.updated; lastSaved = Model.snapshot(); Model.emit('meta'); setStatus('saved');
    App.toast('Saved as “' + name + '”'); return true;
  }
  async function rename(id, name) {
    if (id === Model.S.id) { Model.mutate(() => { Model.S.name = name; }); await saveNow(); }
    else { const d = await api('GET', '/api/projects/' + id); d.name = name; await api('PUT', '/api/projects/' + id, d); }
    render();
  }
  // lock / unlock a project (the lock itself is not an edit: it goes around Model.mutate and is saved at once)
  async function setLocked(id, on) {
    if (!on && !confirm('Unlock this project? It can then be edited and deleted again.')) return;
    if (id === Model.S.id) {
      if (on) await saveNow();
      if (on) Model.S.locked = true; else delete Model.S.locked;
      await api('PUT', '/api/projects/' + id, JSON.parse(Model.snapshot())); lastSaved = Model.snapshot(); Model.emit('meta'); lockState();
    } else { const d = await api('GET', '/api/projects/' + id); if (on) d.locked = true; else delete d.locked; await api('PUT', '/api/projects/' + id, d); }
    App.toast(on ? '🔒 Project locked — no edits, renaming or delete until you unlock it (▤ Projects → 🔓)' : '🔓 Project unlocked', 6000);
    render();
  }
  // the open project's lock: shown next to the save state; an edit attempt says why nothing happens
  let lockNote = 0;
  function lockState() { if (Model.S.locked) setStatus('locked', 'This project is locked: ▤ Projects → 🔓 to edit it'); }
  async function remove(id) {
    await api('DELETE', '/api/projects/' + id, undefined, true); forget(id);
    if (id === Model.S.id) { const d = Model.blank(); d.name = 'Untitled'; Model.load(d); lastSaved = ''; await saveNow(); Sch.fit(); }
    render();
  }

  // ---------- dialog ----------
  const ago = t => { const s = Date.now() / 1000 - t; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(t * 1000).toLocaleDateString(); };
  // the same design under two ids (copies from another PC, GitHub or Google Drive): matched by name; generic names never
  const nameKey = n => { const k = String(n || '').trim().toLowerCase().replace(/\s+/g, ' '); return !k || /^(untitled|new project|design|project)( \d+)?$/.test(k) ? '' : k; };
  // Created / last modified as the shared project lists give them (CircuitPilot-projects.csv on GitHub and in Google
  // Drive, kept after each sync), so every PC shows the same dates: created = the earliest the lists know (the first PC
  // that saved the design), last modified = the latest (an edit here after the last sync is newer than the list).
  const TIMES = 'cp.projIndexTimes';
  let IT = {};
  function setIndexTimes(source, rows) { try { const all = JSON.parse(localStorage.getItem(TIMES) || '{}'); all[source] = { at: Date.now() / 1000, rows }; localStorage.setItem(TIMES, JSON.stringify(all)); } catch (e) { } }
  function indexTimes() {
    const out = {};
    try { const all = JSON.parse(localStorage.getItem(TIMES) || '{}'); for (const [src, v] of Object.entries(all)) for (const [pid, t] of Object.entries(v.rows || {})) { const o = out[pid] || (out[pid] = { created: 0, edited: 0, src: [] }); if (+t.created > 0 && (!o.created || +t.created < o.created)) o.created = +t.created; if (+t.edited > o.edited) o.edited = +t.edited; o.src.push(src); } } catch (e) { }
    return out;
  }
  const editedOf = p => Math.max(+(p.edited || p.updated) || 0, (IT[p.id] && IT[p.id].edited) || 0);
  const createdOf = p => (IT[p.id] && IT[p.id].created) || +p.created || 0;
  const stamp = t => { const d = new Date(t * 1000); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  // as-made copies of a board revision are never duplicates
  function dupGroups(ps) {
    const g = new Map(); for (const p of ps) { if (p.asmade || p.locked) continue; const k = nameKey(p.name); if (!k) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    return [...g.values()].filter(a => a.length > 1).map(a => a.sort((x, y) => editedOf(y) - editedOf(x)));
  }
  // keep the most recently edited copy of every repeated design, delete the others (desktop: they stay under ⟲ Deleted)
  async function mergeDuplicates() {
    const ps = await api('GET', '/api/projects'), groups = dupGroups(ps); if (!groups.length) { App.toast('No repeated designs'); return render(); }
    const lines = groups.map(a => '• ' + (a[0].name || 'Untitled') + ': keep the one edited ' + stamp(editedOf(a[0])) + ', remove ' + (a.length - 1) + ' older (' + a.slice(1).map(p => stamp(editedOf(p))).join(', ') + ')');
    if (!confirm('Merge repeated designs?\n\n' + lines.join('\n') + '\n\n' + (hasHistory ? 'Removed copies can be brought back from ⟲ Deleted projects.' : 'Removed copies cannot be brought back in the web version.'))) return;
    let open = Model.S.id, removed = 0;
    for (const a of groups) for (const p of a.slice(1)) { if (p.id === Model.S.id) { await saveNow(); open = a[0].id; } await api('DELETE', '/api/projects/' + p.id, undefined, true); forget(p.id); removed++; }
    if (open !== Model.S.id) await openQuiet(open);
    App.toast(removed + ' older cop' + (removed === 1 ? 'y' : 'ies') + ' removed; the newest of each design is kept', 6000);
    if (typeof Cloud !== 'undefined' && Cloud.email) Cloud.sync().catch(() => { });
    render();
  }
  async function openQuiet(id) { const d = await api('GET', '/api/projects/' + id); Model.load(d); lastSaved = Model.snapshot(); serverUpdated = (await api('GET', '/api/projects/' + id + '/meta')).updated; remember(); Model.emit('meta'); }
  async function render() {
    IT = indexTimes();
    const list = $('#projList');
    if (!online) { list.innerHTML = '<div class="muted">Project storage needs the app to run with <code>server.py</code>. You can still download / import project files.</div>'; return; }
    list.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const ps = await api('GET', '/api/projects'), q = $('#projSearch').value.toLowerCase(), goneNote = vanished(ps);
      const sort = $('#projSort') ? $('#projSort').value : 'edited-desc', created = createdOf, nm = p => String(p.name || 'Untitled');
      const order = { 'edited-desc': (a, b) => editedOf(b) - editedOf(a), 'edited-asc': (a, b) => editedOf(a) - editedOf(b), 'created-desc': (a, b) => created(b) - created(a), 'created-asc': (a, b) => created(a) - created(b),
        'name-asc': (a, b) => nm(a).localeCompare(nm(b), undefined, { numeric: true, sensitivity: 'base' }), 'name-desc': (a, b) => nm(b).localeCompare(nm(a), undefined, { numeric: true, sensitivity: 'base' }) }[sort] || ((a, b) => editedOf(b) - editedOf(a));
      // a board code (CP-K7Q2M-2 R3, as printed on the PCB) finds its project and the revision the board was made from
      const fc = q && Pcb.parseFabCode(q), codeOf = (p, no) => p.code + (no > 1 || (p.revs || []).some(r => r[0] > 1) ? '-' + no : '');
      const hitCode = p => fc && p.code === fc.id;
      if (fc) ps.sort((a, b) => (a.asmade ? 1 : 0) - (b.asmade ? 1 : 0));
      const rows = ps.filter(p => !q || (p.name || '').toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || hitCode(p)).sort(order);
      const revNote = p => {
        if (!hitCode(p)) return '';
        if (p.asmade) return `<div class="small">As-made copy of board <b>${esc(codeOf(p, p.asmade[0]))} R${p.asmade[1]}</b></div>`;
        const no = fc.pcb || 1, mine = (p.revs || []).filter(r => r[0] === no), want = fc.rev ? mine.filter(r => r[1] === fc.rev) : mine;
        if (!mine.length) return `<div class="small">Board code <b>${esc(codeOf(p, no))}</b> — no Gerbers were made for this PCB yet.</div>`;
        return `<div class="small">Board code <b>${esc(codeOf(p, no))}</b>: ${want.length ? want.map(r => `<button data-a="rev" data-pcb="${r[0]}" data-rev="${r[1]}" title="Open the design as it was when R${r[1]} was made">Open R${r[1]}</button> <span class="muted">made ${esc(stamp(r[2]))}</span>`).join(' · ') : `no R${fc.rev} (made: ${mine.map(r => 'R' + r[1]).join(', ')})`}</div>`;
      };
      const dups = dupGroups(ps), dupOf = new Map(); for (const a of dups) a.forEach((p, i) => dupOf.set(p.id, i ? 'older' : 'newest'));
      const dupNote = dups.length ? `<div class="row-h" style="margin-bottom:8px"><span class="small bad">${dups.length} design${dups.length > 1 ? 's are' : ' is'} here more than once (same name).</span><button data-a="merge" title="Keep the most recently edited copy of each, remove the older ones">Merge duplicates</button></div>` : '';
      const signed = typeof Cloud !== 'undefined' && Cloud.email;
      // GitHub keeps the projects for every PC (Google sign-in is switched off while it does not work)
      const repo = typeof GitHub !== 'undefined' && GitHub.getRepo && GitHub.getRepo(), ghTok = typeof GitHub !== 'undefined' && GitHub.getToken && GitHub.getToken();
      const ghNote = repo && ghTok ? `<div class="muted small" style="margin-bottom:8px">⌥ Saved to your GitHub repository <b>${esc(repo)}</b> — on another PC open <a href="#" id="projGh">⌥ GitHub</a> → Load all designs, then Sync to keep them the same.</div>`
        : `<div class="muted small" style="margin-bottom:8px">${window.CPStatic && CPStatic.mode === 'static' ? 'Web version: projects are saved in this browser. ' : 'Projects are saved on this PC. '}<a href="#" id="projGh">⌥ Connect GitHub</a> to keep every project in your own repository and open them on any PC.</div>`;
      const note = signed ? `<div class="muted small" style="margin-bottom:8px">☁ Synced with the Google Drive of ${esc(Cloud.email)} — open CircuitPilot on any PC and sign in to get them.</div>` : ghNote;
      list.innerHTML = goneNote + note + dupNote + (rows.length ? rows.map(p => `<div class="proj${p.id === Model.S.id ? ' cur' : ''}" data-id="${esc(p.id)}">
        <div class="pinfo"><div class="pname">${esc(p.name || 'Untitled')}${p.locked ? ' <span class="badge" title="Locked: no edits, renaming or delete until unlocked">🔒 locked</span>' : ''}${p.id === Model.S.id ? ' <span class="badge basic">open</span>' : ''}${dupOf.get(p.id) === 'newest' ? ' <span class="badge basic" title="This name is here more than once: this copy was edited last">newest copy</span>' : dupOf.get(p.id) === 'older' ? ' <span class="badge" title="This name is here more than once: another copy was edited later">older copy</span>' : ''}</div>
        ${revNote(p)}<div class="muted small">${p.code ? `<span title="Board code printed on the PCB (search it to find this design)">${esc(p.code)}</span> · ` : ''}${p.parts} parts · ${p.nets} nets${p.pcb ? ' · PCB' : ''} · last edited <b title="${esc(new Date(editedOf(p) * 1000).toLocaleString())}">${stamp(editedOf(p))}</b> (${ago(editedOf(p))})${createdOf(p) ? ` · created ${stamp(createdOf(p))}` : ''}${IT[p.id] ? ` <span class="muted" title="Dates from the project list ${esc(IT[p.id].src.join(' and '))} (the same on every PC that syncs)">⇅</span>` : ''}</div></div>
        <div class="pact"><button data-a="open" class="primary">Open</button><button data-a="dup" title="Duplicate">⧉</button>${hasHistory ? '<button data-a="hist" title="Earlier versions (restore)">⟲</button>' : ''}<button data-a="lock" title="${p.locked ? 'Unlock: allow edits and delete again' : 'Lock: no edits, renaming or delete (a finished / ordered design)'}">${p.locked ? '🔓' : '🔒'}</button><button data-a="ren" title="${p.locked ? 'Locked — unlock to rename' : 'Rename'}" ${p.locked ? 'disabled' : ''}>✎</button><button data-a="del" class="danger" title="${p.locked ? 'Locked — unlock to delete' : 'Delete'}" ${p.locked ? 'disabled' : ''}>🗑</button></div></div>`).join('')
        : '<div class="muted">No projects yet.</div>') + (hasHistory ? '<div class="proj"><div class="pinfo muted small">Every project keeps earlier versions (⟲). </div><div class="pact"><button data-a="deleted">Deleted projects…</button></div></div>' : '');
      if ($('#projGh')) $('#projGh').onclick = e => { e.preventDefault(); close(); const b = $('#ghBtn'); if (b) b.click(); };
    } catch (e) { list.innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
  }
  // ids seen in the list last time (per browser): ones missing now that were not deleted from this list are reported
  const KNOWN = 'cp.knownProjects';
  const forget = id => { try { const k = JSON.parse(localStorage.getItem(KNOWN) || '{}'); delete k[id]; localStorage.setItem(KNOWN, JSON.stringify(k)); } catch (e) { } };
  function vanished(ps) {
    let k = {}; try { k = JSON.parse(localStorage.getItem(KNOWN) || '{}'); } catch (e) { }
    const now = new Set(ps.map(p => p.id)), gone = Object.entries(k).filter(([id]) => !now.has(id));
    const next = {}; for (const p of ps) next[p.id] = p.name || 'Untitled';
    try { localStorage.setItem(KNOWN, JSON.stringify(next)); } catch (e) { }
    if (!gone.length || !Object.keys(k).length) return '';
    return `<div class="row-h" style="margin-bottom:8px;padding:6px 8px;border:1px solid var(--bad, #c44);border-radius:6px"><span class="small"><b class="bad">${gone.length} project${gone.length > 1 ? 's were' : ' was'} removed since you last looked</b> (not from this list — a sync or another tool): ${gone.slice(0, 8).map(([, n]) => esc(n)).join(', ')}${gone.length > 8 ? ' …' : ''}.</span>${hasHistory ? '<button data-a="deleted">Restore…</button>' : ''}</div>`;
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

  // a Claude job (route_pcb, reroute …) works on this project: editing pauses, and its result loads when it is done
  let jobLock = null, lockToast = 0;
  function setLock(tool) {
    if (jobLock === tool) return; jobLock = tool;
    Model.setLock(tool, t => { if (!t) return lockedToast(); if (Date.now() - lockToast > 4000) { lockToast = Date.now(); App.toast('⏳ Claude is running ' + t + ' on this project — wait until it finishes', 4000); } });
    setStatus('error', 'Claude is running ' + tool + ' on this project');
    const el = $('#saveState'); if (el) el.textContent = '⏳ Claude: ' + tool;
    App.toast('⏳ Claude is running ' + tool + ' on this project — editing is paused until it finishes, then its result loads here', 8000);
  }
  async function endLock() {
    jobLock = null; Model.setLock(null);
    try {
      const d = await api('GET', '/api/projects/' + Model.S.id), m = await api('GET', '/api/projects/' + Model.S.id + '/meta');
      const lost = Model.snapshot() !== lastSaved;
      serverUpdated = m.updated; Model.load(d, true); lastSaved = Model.snapshot(); remember(); setStatus('saved');
      App.toast('✓ Claude finished — its result is loaded' + (lost ? ' (it replaced this tab’s unsaved changes from before it started)' : ''), 7000);
    } catch (e) { setStatus('error', e.message); }
  }
  function lockedToast() { if (Date.now() - lockNote > 4000) { lockNote = Date.now(); App.toast('🔒 This project is locked — unlock it in ▤ Projects (🔓) to edit it', 4000); } }
  async function poll() {
    if (!online || !Model.S.id || saving || document.hidden) return;
    try { const m = await api('GET', '/api/projects/' + Model.S.id + '/meta'); if (m.job) { setLock(m.job); return; } if (jobLock) { await endLock(); return; } } catch (e) { }
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
      if (job.args && job.args.kind === 'github') {   // Claude asked to save to GitHub: done with this tab's sign-in (js/app.js)
        let res; try { res = window.CPGitHubFromClaude ? await window.CPGitHubFromClaude(job.args) : { error: 'This app has no GitHub support' }; } catch (e) { res = { error: e.message || String(e) }; }
        try { await fetch('/api/render/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id: job.id }, res)) }); } catch (e) { }
        continue;
      }
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
      Model.setLock(null, t => { if (!t) lockedToast(); });   // an edit on a locked project: say why nothing happens
      setInterval(poll, 2500);
      if (!(window.CPStatic && CPStatic.mode === 'static')) renderLoop();   // screenshots for Claude: start before opening
      if (want && want !== Model.S.id) { try { await open(want); } catch (e) { } history.replaceState(null, '', location.pathname); }
    } else setStatus('local');
    $('#projClose').onclick = close;
    $('#projSearch').oninput = render;
    if ($('#projSort')) { try { $('#projSort').value = localStorage.getItem('cp.projSort') || 'edited-desc'; } catch (e) { } $('#projSort').onchange = () => { try { localStorage.setItem('cp.projSort', $('#projSort').value); } catch (e) { } render(); }; }
    $('#projNew').onclick = () => { const n = prompt('Project name', 'New project'); if (n !== null) create(n.trim() || 'Untitled'); };
    $('#projImport').onclick = () => $('#fileIn').click();
    $('#projList').onclick = async e => {
      const b = e.target.closest('button[data-a]'), row = e.target.closest('.proj');
      if (b && b.dataset.a === 'back') return render();
      if (b && b.dataset.a === 'deleted') return showDeleted().catch(err => App.toast(err.message));
      if (b && b.dataset.a === 'merge') return mergeDuplicates().catch(err => App.toast(err.message));
      if (!b || !row) return;
      const id = row.dataset.id, name = row.querySelector('.pname').firstChild.textContent;
      try {
        if (b.dataset.a === 'open') await open(id);
        if (b.dataset.a === 'dup') await duplicate(id);
        if (b.dataset.a === 'rev') await openRevision(id, +b.dataset.pcb, +b.dataset.rev);
        if (b.dataset.a === 'lock') await setLocked(id, !b.textContent.includes('🔓') );
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
  return { init, show, close, saveNow, saveAs, create, nameKey, setIndexTimes, openId: open, pause: v => { paused = !!v; if (paused) clearTimeout(timer); }, get online() { return online; }, get myLib() { return myLib; }, loadLibrary, savePart, deletePart, markLoaded: () => { lastSaved = ''; } };
})();
