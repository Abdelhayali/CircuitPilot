'use strict';
// Google sign-in, and every project + My Library kept in the user's own Google Drive (the hidden app-data folder: only
// CircuitPilot sees it, it does not show in Drive, it counts against the user's free Drive space). No CircuitPilot
// server is involved: the browser talks to Google directly — on pcbgo.site and in the desktop app (http://localhost:5173).
// Sync: the first sign-in on a PC merges both ways; after that every autosave uploads, and other PCs pick it up. When
// both sides changed, the newer one wins — the desktop app keeps the other as a project version, Drive keeps revisions.
const Cloud = (() => {
  const $ = s => document.querySelector(s);
  // drive.file: only files this app creates (the visible project list CircuitPilot-projects.csv); the projects themselves
  // stay in the hidden app-data folder
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file openid email profile';
  const FILE = 'https://www.googleapis.com/auth/drive.file', INDEX_NAME = 'CircuitPilot-projects.csv';
  let fileOk = false;
  const API = 'https://www.googleapis.com/drive/v3/files', UP = 'https://www.googleapis.com/upload/drive/v3/files';
  const clientId = () => { try { return localStorage.getItem('cp.googleClientId') || (window.CP_CONFIG && CP_CONFIG.googleClientId) || ''; } catch (e) { return (window.CP_CONFIG && CP_CONFIG.googleClientId) || ''; } };
  // what was synced last: per project the Drive file, its modifiedTime and the local `updated` it matched
  // The record belongs to ONE local project store. The desktop app and server.py both serve http://localhost:5173 (the
  // same browser storage) but use different projects.db files: with one shared record, projects of the other store
  // looked "deleted here" and were marked deleted in Drive. Each store (its data folder) now keeps its own record.
  const blank = () => ({ email: '', name: '', picture: '', map: {}, lib: null, last: 0 });
  let st = blank(), KEY = 'cp.cloud', storeDir = '', ready = null, full = false;
  const readState = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { } };
  async function pickStore() {
    let dir = '';
    try { const r = await fetch('/api/version', { cache: 'no-store' }); if (r.ok) dir = String((await r.json()).data_dir || ''); } catch (e) { }
    if (!dir) { st = Object.assign(blank(), readState(KEY) || {}); return; }   // pcbgo.site: one store per browser
    storeDir = dir; KEY = 'cp.cloud@' + dir.toLowerCase().replace(/\\/g, '/');
    const mine = readState(KEY);
    if (mine) { st = Object.assign(blank(), mine); return; }
    // first time for this store: the same Google account, but nothing is known about what THIS store synced, so the
    // first sync merges both ways (newer wins, nothing is taken as deleted)
    const legacy = readState('cp.cloud') || {};
    st = Object.assign(blank(), { email: legacy.email || '', name: legacy.name || '', picture: legacy.picture || '' }); keep();
  }
  let token = null, tokenExp = 0, tc = null, pending = null, busy = null, status = 'off', statusMsg = '', pushT = null, askConsent = false;
  const DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
  const NEED = 'CircuitPilot did not get the Google Drive permission. Click Sync now and, on the Google page, tick “See, create and delete its own configuration data in your Google Drive”.';

  // ---------- Google sign-in (Google Identity Services: a token for Drive app data, from Google's own window) ----------
  let gisP = null;
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    return gisP || (gisP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = res; s.onerror = () => { gisP = null; rej(new Error('Could not reach Google (offline?)')); }; document.head.appendChild(s); }));
  }
  // interactive: from a click (the browser blocks Google's window otherwise). prompt '' = no account picker when the
  // user already agreed once (the window opens and closes by itself)
  async function getToken(interactive) {
    if (token && Date.now() < tokenExp - 60000) return token;
    if (!interactive) throw new Error('not connected');   // Google's window may only open from a click
    if (!clientId()) throw new Error('Google sign-in is not set up for this copy of CircuitPilot (no client ID)');
    await loadGis();
    return new Promise((res, rej) => {
      tc = google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: SCOPE, prompt: askConsent ? 'consent' : interactive === 'pick' ? 'select_account' : '', login_hint: st.email || undefined,
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          // Google lets the user untick single permissions: without Drive the token is useless here
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE)) { token = null; askConsent = true; setStatus('reconnect', NEED); return rej(new Error(NEED)); }
          fileOk = google.accounts.oauth2.hasGrantedAllScopes(r, FILE);
          askConsent = false; token = r.access_token; tokenExp = Date.now() + (+r.expires_in || 3600) * 1000; res(token);
        },
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in window closed' : e && e.type === 'popup_failed_to_open' ? 'The browser blocked the Google window — allow pop-ups for this site' : (e && e.message) || 'Sign-in failed')),
      });
      tc.requestAccessToken();
    });
  }
  async function g(method, url, body, headers = {}) {
    const t = await getToken(false).catch(() => null);
    if (!t) { setStatus('reconnect', 'Click ☁ to reconnect to Google Drive'); throw new Error('not connected'); }
    const r = await fetch(url, { method, headers: Object.assign({ authorization: 'Bearer ' + t }, headers), body });
    if (r.status === 401) { token = null; setStatus('reconnect', 'Google sign-in expired — click ☁ to reconnect'); throw new Error('Google sign-in expired'); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({})), msg = (j.error && j.error.message) || r.statusText;
      if (r.status === 403 && /insufficient.*scope|scope/i.test(msg)) { token = null; askConsent = true; setStatus('reconnect', NEED); throw new Error('not connected: ' + NEED); }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.headers.get('content-type') && r.headers.get('content-type').includes('json') ? r.json() : r.text();
  }
  async function signIn() {
    try {
      setStatus('busy', 'Signing in…');
      await getToken('pick');
      const u = await g('GET', 'https://www.googleapis.com/oauth2/v3/userinfo').catch(() => ({ email: st.email || 'Google account', name: st.name || '' }));
      if (st.email && st.email !== u.email) st.map = {}, st.lib = null;   // another account: its Drive has other files
      Object.assign(st, { email: u.email, name: u.name || u.email, picture: u.picture || '' }); keep();
      App.toast(`Signed in as ${u.email} — syncing your projects with your Google Drive…`, 5000);
      await sync(true);
    } catch (e) { setStatus(st.email ? 'reconnect' : 'off', e.message); App.toast(e.message, 7000); }
    render();
  }
  function signOut() {
    if (token && window.google && google.accounts) try { google.accounts.oauth2.revoke(token, () => { }); } catch (e) { }
    token = null; st = blank(); keep(); setStatus('off');
    App.toast('Signed out. Your projects stay on this PC and in your Google Drive.', 6000); render();
  }

  // ---------- Drive files: one per project (cp-project-<id>.json) + My Library (cp-library.json) ----------
  async function listRemote() {
    const out = []; let page = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,modifiedTime,appProperties)' }); if (page) q.set('pageToken', page);
      const r = await g('GET', API + '?' + q); out.push(...r.files); page = r.nextPageToken || '';
    } while (page);
    return out;
  }
  async function upload(fileId, name, data, props) {
    const meta = fileId ? { name, appProperties: props } : { name, parents: ['appDataFolder'], appProperties: props };
    const b = 'cp' + Math.random().toString(36).slice(2), body = `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${b}--`;
    return g(fileId ? 'PATCH' : 'POST', `${UP}${fileId ? '/' + fileId : ''}?uploadType=multipart&fields=id,modifiedTime,appProperties`, body, { 'content-type': 'multipart/related; boundary=' + b });
  }
  const download = id => g('GET', `${API}/${id}?alt=media`);
  const setProps = (id, props) => g('PATCH', `${API}/${id}?fields=id,modifiedTime,appProperties`, JSON.stringify({ appProperties: props }), { 'content-type': 'application/json' });
  // the app's own project store (desktop: projects.db, web: this browser's IndexedDB) through the same /api the app uses
  async function local(method, path, body, user) {
    const h = body ? { 'content-type': 'application/json' } : {}; if (user) h['X-CircuitPilot-User'] = '1';
    const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
  }
  const props = (p, extra = {}) => Object.assign({ kind: 'project', pid: p.id, name: String(p.name || 'Untitled').slice(0, 100), updated: String(p.updated || 0), edited: String(p.edited || p.updated || 0), deleted: '0' }, extra);

  // ---------- sync ----------
  function sync(all) { if (busy) return busy; busy = run(all).finally(() => { busy = null; }); return busy; }
  async function run() {
    await ready;
    if (!st.email) return;
    setStatus('busy', 'Syncing with Google Drive…');
    let up = 0, down = 0, del = 0, gone = 0;
    try {
      const [mine, remote] = await Promise.all([local('GET', '/api/projects'), listRemote()]);
      const byPid = new Map(), L = new Map(mine.map(p => [p.id, p]));
      let libFile = null;
      for (const f of remote) { const a = f.appProperties || {}; if (a.kind === 'library') libFile = f; else if (a.kind === 'project' && a.pid) byPid.set(a.pid, f); }
      // the same design under another id (same name: a copy from another PC or from GitHub): one design. The copy edited
      // last wins (into the id this PC has), the other Drive copy is retired, so no duplicate comes down on any PC.
      let merged = 0;
      {
        const nk = typeof Projects !== 'undefined' && Projects.nameKey ? Projects.nameKey : () => '', tOf = a => +(a.edited || a.updated) || 0;
        const localBy = new Map(); for (const p of mine) { const k = nk(p.name); if (k && (!localBy.has(k) || tOf(p) > tOf(localBy.get(k)))) localBy.set(k, p); }
        const remoteBy = new Map();
        for (const [pid, f] of byPid) {
          const a = f.appProperties || {}, k = nk(a.name); if (!k || a.deleted === '1' || L.has(pid)) continue;
          const keep = localBy.get(k);
          if (keep && keep.id !== pid) {
            if (tOf(a) > tOf(keep) + 1) { const d = await download(f.id); d.id = keep.id; await local('PUT', '/api/projects/' + keep.id, d); down++; }
            await setProps(f.id, Object.assign({}, a, { deleted: '1' })); byPid.delete(pid); delete st.map[pid]; merged++; continue;
          }
          const o = remoteBy.get(k);   // two Drive copies, neither here: only the last edited comes down
          if (!o) { remoteBy.set(k, { pid, f }); continue; }
          const [win, lose] = tOf(a) > tOf(o.f.appProperties || {}) ? [{ pid, f }, o] : [o, { pid, f }];
          await setProps(lose.f.id, Object.assign({}, lose.f.appProperties, { deleted: '1' })); byPid.delete(lose.pid); delete st.map[lose.pid]; remoteBy.set(k, win); merged++;
        }
        if (merged) { const fresh = await local('GET', '/api/projects'); L.clear(); for (const p of fresh) L.set(p.id, p); }
      }
      const ids = new Set([...L.keys(), ...byPid.keys()]), delAsk = [];
      for (const id of ids) {
        const p = L.get(id), f = byPid.get(id), s = st.map[id], a = f ? f.appProperties || {} : {};
        try {
          if (p && f) {
            const lc = !s || p.updated > s.lup + 0.5, rc = !s || f.modifiedTime !== s.rmod;
            if (a.deleted === '1') {   // deleted on another PC: delete here too (asked first), unless it was edited here since
              if (!lc) { delAsk.push({ id, name: p.name }); continue; }
              const r = await upload(f.id, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p)); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++; continue;
            }
            if (!lc && !rc) continue;
            // both changed (or first sync on this PC): the newer one wins
            const remoteWins = rc && (!lc || (+a.edited || +a.updated || 0) > (+p.edited || +p.updated || 0));
            if (remoteWins) { const d = await download(f.id); const r = await local('PUT', '/api/projects/' + id, d); st.map[id] = { rid: f.id, rmod: f.modifiedTime, lup: r.updated }; down++; }
            else { const r = await upload(f.id, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p)); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++; }
          } else if (f) {
            if (a.deleted === '1') { gone++; continue; }
            if (s) { await setProps(f.id, Object.assign({}, a, { deleted: '1' })); delete st.map[id]; del++; continue; }   // deleted here since the last sync
            const d = await download(f.id); const r = await local('PUT', '/api/projects/' + id, d); st.map[id] = { rid: f.id, rmod: f.modifiedTime, lup: r.updated }; down++;
          } else if (p) {
            const r = await upload(null, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p, { created: String(p.created || 0) })); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++;
          }
        } catch (e) { if (/not connected|expired/.test(e.message)) throw e; console.warn('sync', id, e); }
        keep();
      }
      // deleted on another PC: never silently — ask once for all of them (Cancel keeps them; they stay as they are)
      if (delAsk.length && confirm(`Google Drive says ${delAsk.length} project${delAsk.length > 1 ? 's were' : ' was'} deleted on another PC:\n\n${delAsk.slice(0, 15).map(x => '• ' + (x.name || 'Untitled')).join('\n')}${delAsk.length > 15 ? '\n…' : ''}\n\nDelete ${delAsk.length > 1 ? 'them' : 'it'} here too? (Cancel keeps ${delAsk.length > 1 ? 'them' : 'it'} on this PC; deleted projects can be restored from Projects → Deleted projects.)`)) {
        for (const x of delAsk) { try { await local('DELETE', '/api/projects/' + x.id, undefined, true); delete st.map[x.id]; del++; } catch (e) { console.warn('sync delete', x.id, e); } }
      }
      // the dates: created = the one Drive keeps for the project (the PC that first uploaded it), else this PC's
      const createdAt = new Map(); for (const [pid, f] of byPid) { const c = +((f.appProperties || {}).created) || 0; if (c) createdAt.set(pid, c); }
      try { const times = {}; for (const p of await local('GET', '/api/projects')) times[p.id] = { created: createdAt.get(p.id) || +p.created || 0, edited: +(p.edited || p.updated) || 0 }; if (typeof Projects !== 'undefined' && Projects.setIndexTimes) Projects.setIndexTimes('in Google Drive', times); } catch (e) { }
      // the project list in My Drive (opens in Excel / Google Sheets): what every PC that syncs now holds
      try { await writeIndex(createdAt); } catch (e) { if (/not connected|expired/.test(e.message)) throw e; console.warn('project list', e); }
      // My Library: the union of both sides (parts are added far more often than removed)
      try {
        const mineLib = await local('GET', '/api/library'), theirs = libFile ? await download(libFile.id) : [];
        const have = new Set(mineLib.map(x => x.key)), add = (Array.isArray(theirs) ? theirs : []).filter(x => x && x.key && !have.has(x.key));
        for (const x of add) await local('PUT', '/api/library/' + encodeURIComponent(x.key), x);
        const merged = mineLib.concat(add), keys = (Array.isArray(theirs) ? theirs : []).map(x => x.key).sort().join('|');
        if (!libFile || merged.map(x => x.key).sort().join('|') !== keys) { const r = await upload(libFile && libFile.id, 'cp-library.json', merged, { kind: 'library', parts: String(merged.length) }); st.lib = { rid: r.id }; }
        if (add.length) { await Projects.loadLibrary(); if (window.App && App.renderAll) App.renderAll(); }
      } catch (e) { if (/not connected|expired/.test(e.message)) throw e; console.warn('library sync', e); }
      st.last = Date.now(); keep();
      setStatus('ok', `Synced ${new Date().toLocaleTimeString()}${up || down || del ? ` · ${up} up, ${down} down${del ? `, ${del} deleted` : ''}` : ''}${merged ? ` · ${merged} repeated design${merged > 1 ? 's' : ''} merged` : ''}${full && gone ? ` · ${gone} project${gone > 1 ? 's' : ''} deleted earlier stay deleted` : ''}`);
      if (full) App.toast(`This PC and your Google Drive now hold the same projects: ${up} uploaded, ${down} downloaded${gone ? `, ${gone} deleted earlier left deleted` : ''}`, 8000);
      if (down || del) App.toast(`Google Drive: ${down ? down + ' project' + (down > 1 ? 's' : '') + ' updated from your other devices' : ''}${down && del ? ', ' : ''}${del ? del + ' deleted' : ''}`, 6000);
    } catch (e) { if (status !== 'reconnect') setStatus('error', e.message); }
    render();
  }
  // CircuitPilot-projects.csv in My Drive: name, project id, created, last modified (UTC), parts — rewritten when it changes
  const isoUtc = t => t > 0 ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
  function indexText(list, createdAt = new Map()) {
    const cell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = list.slice().sort((a, b) => (+(b.edited || b.updated) || 0) - (+(a.edited || a.updated) || 0)).map(p => [p.name || 'Untitled', p.id, isoUtc(createdAt.get(p.id) || +p.created), isoUtc(+(p.edited || p.updated)), p.parts || 0]);
    return '\ufeff' + [['Name', 'Project ID', 'Created (UTC)', 'Last modified (UTC)', 'Parts']].concat(rows).map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  async function writeIndex(createdAt) {
    if (!fileOk) return;
    const text = indexText(await local('GET', '/api/projects'), createdAt);
    if (st.indexText === text && st.indexId) return;
    let id = st.indexId;
    if (!id) {   // this app's own file in My Drive (drive.file only sees files the app made)
      const q = new URLSearchParams({ q: "name='" + INDEX_NAME + "' and trashed=false", spaces: 'drive', fields: 'files(id)' });
      const r = await g('GET', API + '?' + q); id = r.files && r.files[0] && r.files[0].id;
    }
    if (id) await g('PATCH', UP + '/' + id + '?uploadType=media&fields=id', text, { 'content-type': 'text/csv; charset=UTF-8' });
    else {
      const b = 'cp' + Math.random().toString(36).slice(2), meta = { name: INDEX_NAME, mimeType: 'text/csv', description: 'CircuitPilot: every project kept in this Google account (name, created, last modified). Written by CircuitPilot on each sync.' };
      const body = '--' + b + '\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\ncontent-type: text/csv; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
      id = (await g('POST', UP + '?uploadType=multipart&fields=id', body, { 'content-type': 'multipart/related; boundary=' + b })).id;
    }
    st.indexId = id; st.indexText = text; keep();
  }
  // after an autosave: upload this project (a few seconds later, so a burst of edits is one upload)
  function saved(id) {
    if (!st.email || !id) return;
    clearTimeout(pushT); pushT = setTimeout(() => push(id), 4000);
  }
  async function push(id) {
    await ready;
    if (busy) { await busy; }
    try {
      const m = await local('GET', '/api/projects/' + id + '/meta'), s = st.map[id];
      if (s && Math.abs(m.updated - s.lup) < 0.5) return;
      setStatus('busy', 'Saving to Google Drive…');
      const d = await local('GET', '/api/projects/' + id), r = await upload(s && s.rid, `cp-project-${id}.json`, d, props(m));
      st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: m.updated }; keep(); setStatus('ok', `Saved to Google Drive ${new Date().toLocaleTimeString()}`);
    } catch (e) { if (status !== 'reconnect') setStatus('error', e.message); }
  }

  // forget what this store synced and merge both ways: every project ends up on both sides (newer copy wins)
  async function fullSync() {
    try { await getToken(true); } catch (e) { App.toast(e.message, 6000); return; }
    await ready; st.map = {}; st.lib = null; keep();
    full = true; try { await sync(true); } finally { full = false; render(); }
  }
  // ---------- top-bar button + panel ----------
  function setStatus(s, msg = '') { status = s; statusMsg = msg; const b = $('#cloudBtn'); if (b) paintBtn(b); }
  function paintBtn(b) {
    const icon = { off: '☁', ok: '☁✓', busy: '☁↻', error: '☁⚠', reconnect: '☁!' }[status] || '☁';
    b.textContent = st.email ? `${icon} ${st.name.split(' ')[0] || st.email}` : '☁ Sign in';
    b.title = st.email ? `${st.email} — projects synced with your Google Drive${statusMsg ? '\n' + statusMsg : ''}` : 'Sign in with Google: your projects are kept in your Google Drive and open on any PC';
    b.className = 'cloudbtn ' + status;
  }
  function render() {
    const b = $('#cloudBtn'); if (b) paintBtn(b);
    const p = $('#cloudPanel'); if (!p || p.classList.contains('hidden')) return;
    const id = clientId();
    p.innerHTML = !id ? `<b>Google sign-in is not set up yet</b><p class="muted small">This copy of CircuitPilot has no Google client ID. The owner of the site sets it once in <code>js/config.js</code> (<code>googleClientId</code>), or you can paste one here (⚙ Settings → Google sign-in).</p>`
      : !st.email ? `<b>Your projects on every PC</b><p class="muted small">Sign in with Google and CircuitPilot keeps all your projects and My Library in your own Google Drive — in a hidden folder only CircuitPilot can see (it does not show among your files). On another PC, sign in and everything is there. CircuitPilot only asks for access to that folder: not your other files, not your e-mail beyond your address.</p><button id="cloudIn" class="primary">Sign in with Google</button>`
      : `<div class="cloudme">${st.picture ? `<img src="${esc(st.picture)}" alt="" referrerpolicy="no-referrer">` : ''}<div><b>${esc(st.name)}</b><div class="muted small">${esc(st.email)}</div></div></div>
         <p class="small ${status === 'error' || status === 'reconnect' ? 'bad' : 'muted'}">${esc(statusMsg || (st.last ? 'Last synced ' + new Date(st.last).toLocaleString() : 'Not synced yet'))}</p>
         <p class="muted small">${Object.keys(st.map).length} projects in your Google Drive. Edits upload a few seconds after each save; other PCs get them when they open CircuitPilot or press Sync.${storeDir ? ` Projects on this PC: <code>${esc(storeDir)}</code>.` : ''}</p>
         <p class="muted small">${st.indexId ? `Project list (name, created, last modified): <a href="https://drive.google.com/file/d/${esc(st.indexId)}/view" target="_blank" rel="noopener">${INDEX_NAME}</a> in your Google Drive — opens in Excel or Google Sheets.` : fileOk ? `The project list ${INDEX_NAME} appears in your Google Drive after the next sync.` : `For the project list ${INDEX_NAME} in your Google Drive, press Sync now and allow CircuitPilot to create its own files in your Drive.`}</p>
         <div class="row"><button id="cloudSync" class="primary">${status === 'reconnect' ? 'Reconnect and sync' : '↻ Sync now'}</button><button id="cloudAll" title="Every project on this PC goes to your Google Drive and every project in Drive comes to this PC; where both have one, the newer copy wins">⇄ Make this PC and Drive the same</button><button id="cloudOut">Sign out</button></div>`;
    if ($('#cloudIn')) $('#cloudIn').onclick = () => signIn();
    if ($('#cloudSync')) $('#cloudSync').onclick = async () => { try { await getToken(true); await sync(true); } catch (e) { App.toast(e.message, 6000); } };
    if ($('#cloudAll')) $('#cloudAll').onclick = fullSync;
    if ($('#cloudOut')) $('#cloudOut').onclick = signOut;
  }
  async function init() {
    ready = pickStore(); await ready;
    const b = $('#cloudBtn'), p = $('#cloudPanel'); if (!b || !p) return;
    // no Google client ID in this copy (js/config.js / ⚙ Settings): the feature is not offered at all
    b.parentElement.classList.toggle('hidden', !clientId()); if (!clientId()) return;
    paintBtn(b);
    b.onclick = e => { e.stopPropagation(); p.classList.toggle('hidden'); render(); };
    document.addEventListener('click', e => { if (!p.classList.contains('hidden') && !p.contains(e.target) && e.target !== b) p.classList.add('hidden'); });
    if (!st.email) { setStatus('off'); return; }
    // signed in before: Google gives a new token only from a click (pop-up rules), so the first click on the page
    // reconnects — the Google window opens and closes by itself — and the sync runs
    setStatus('reconnect', 'Click anywhere to reconnect to Google Drive');
    const once = () => { document.removeEventListener('pointerdown', once, true); if (!token && clientId()) getToken(true).then(() => sync(true)).catch(err => setStatus('reconnect', err.message + ' — click ☁ to reconnect')); };
    document.addEventListener('pointerdown', once, true);
    setInterval(() => { if (token && !busy && !document.hidden) sync(); }, 120000);   // pick up other PCs' edits
  }
  return { init, signIn, signOut, sync, saved, get email() { return clientId() ? st.email : ''; },   // Google sign-in switched off (no client ID): not signed in
    get enabled() { return !!clientId(); }, get status() { return status; } };
})();
