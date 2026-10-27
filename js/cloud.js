'use strict';
// Google sign-in, and every project + My Library kept in the user's own Google Drive (the hidden app-data folder: only
// CircuitPilot sees it, it does not show in Drive, it counts against the user's free Drive space). No CircuitPilot
// server is involved: the browser talks to Google directly — on pcbgo.site and in the desktop app (http://localhost:5173).
// Sync: the first sign-in on a PC merges both ways; after that every autosave uploads, and other PCs pick it up. When
// both sides changed, the newer one wins — the desktop app keeps the other as a project version, Drive keeps revisions.
const Cloud = (() => {
  const $ = s => document.querySelector(s);
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email profile';
  const API = 'https://www.googleapis.com/drive/v3/files', UP = 'https://www.googleapis.com/upload/drive/v3/files';
  const clientId = () => { try { return localStorage.getItem('cp.googleClientId') || (window.CP_CONFIG && CP_CONFIG.googleClientId) || ''; } catch (e) { return (window.CP_CONFIG && CP_CONFIG.googleClientId) || ''; } };
  // what was synced last: per project the Drive file, its modifiedTime and the local `updated` it matched
  let st = { email: '', name: '', picture: '', map: {}, lib: null, last: 0 };
  try { st = Object.assign(st, JSON.parse(localStorage.getItem('cp.cloud') || '{}')); } catch (e) { }
  const keep = () => { try { localStorage.setItem('cp.cloud', JSON.stringify(st)); } catch (e) { } };
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
    token = null; st = { email: '', name: '', picture: '', map: {}, lib: null, last: 0 }; keep(); setStatus('off');
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
  async function local(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
  }
  const props = (p, extra = {}) => Object.assign({ kind: 'project', pid: p.id, name: String(p.name || 'Untitled').slice(0, 100), updated: String(p.updated || 0), deleted: '0' }, extra);

  // ---------- sync ----------
  function sync(all) { if (busy) return busy; busy = run(all).finally(() => { busy = null; }); return busy; }
  async function run() {
    if (!st.email) return;
    setStatus('busy', 'Syncing with Google Drive…');
    let up = 0, down = 0, del = 0;
    try {
      const [mine, remote] = await Promise.all([local('GET', '/api/projects'), listRemote()]);
      const byPid = new Map(), L = new Map(mine.map(p => [p.id, p]));
      let libFile = null;
      for (const f of remote) { const a = f.appProperties || {}; if (a.kind === 'library') libFile = f; else if (a.kind === 'project' && a.pid) byPid.set(a.pid, f); }
      const ids = new Set([...L.keys(), ...byPid.keys()]);
      for (const id of ids) {
        const p = L.get(id), f = byPid.get(id), s = st.map[id], a = f ? f.appProperties || {} : {};
        try {
          if (p && f) {
            const lc = !s || p.updated > s.lup + 0.5, rc = !s || f.modifiedTime !== s.rmod;
            if (a.deleted === '1') {   // deleted on another PC: delete here too, unless it was edited here since
              if (!lc) { await local('DELETE', '/api/projects/' + id); delete st.map[id]; del++; continue; }
              const r = await upload(f.id, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p)); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++; continue;
            }
            if (!lc && !rc) continue;
            // both changed (or first sync on this PC): the newer one wins
            const remoteWins = rc && (!lc || +a.updated > p.updated);
            if (remoteWins) { const d = await download(f.id); const r = await local('PUT', '/api/projects/' + id, d); st.map[id] = { rid: f.id, rmod: f.modifiedTime, lup: r.updated }; down++; }
            else { const r = await upload(f.id, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p)); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++; }
          } else if (f) {
            if (a.deleted === '1') continue;
            if (s) { await setProps(f.id, Object.assign({}, a, { deleted: '1' })); delete st.map[id]; del++; continue; }   // deleted here since the last sync
            const d = await download(f.id); const r = await local('PUT', '/api/projects/' + id, d); st.map[id] = { rid: f.id, rmod: f.modifiedTime, lup: r.updated }; down++;
          } else if (p) {
            const r = await upload(null, `cp-project-${id}.json`, await local('GET', '/api/projects/' + id), props(p)); st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: p.updated }; up++;
          }
        } catch (e) { if (/not connected|expired/.test(e.message)) throw e; console.warn('sync', id, e); }
        keep();
      }
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
      setStatus('ok', `Synced ${new Date().toLocaleTimeString()}${up || down || del ? ` · ${up} up, ${down} down${del ? `, ${del} deleted` : ''}` : ''}`);
      if (down || del) App.toast(`Google Drive: ${down ? down + ' project' + (down > 1 ? 's' : '') + ' updated from your other devices' : ''}${down && del ? ', ' : ''}${del ? del + ' deleted' : ''}`, 6000);
    } catch (e) { if (status !== 'reconnect') setStatus('error', e.message); }
    render();
  }
  // after an autosave: upload this project (a few seconds later, so a burst of edits is one upload)
  function saved(id) {
    if (!st.email || !id) return;
    clearTimeout(pushT); pushT = setTimeout(() => push(id), 4000);
  }
  async function push(id) {
    if (busy) { await busy; }
    try {
      const m = await local('GET', '/api/projects/' + id + '/meta'), s = st.map[id];
      if (s && Math.abs(m.updated - s.lup) < 0.5) return;
      setStatus('busy', 'Saving to Google Drive…');
      const d = await local('GET', '/api/projects/' + id), r = await upload(s && s.rid, `cp-project-${id}.json`, d, props(m));
      st.map[id] = { rid: r.id, rmod: r.modifiedTime, lup: m.updated }; keep(); setStatus('ok', `Saved to Google Drive ${new Date().toLocaleTimeString()}`);
    } catch (e) { if (status !== 'reconnect') setStatus('error', e.message); }
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
         <p class="muted small">${Object.keys(st.map).length} projects in your Google Drive. Edits upload a few seconds after each save; other PCs get them when they open CircuitPilot or press Sync.</p>
         <div class="row"><button id="cloudSync" class="primary">${status === 'reconnect' ? 'Reconnect and sync' : '↻ Sync now'}</button><button id="cloudOut">Sign out</button></div>`;
    if ($('#cloudIn')) $('#cloudIn').onclick = () => signIn();
    if ($('#cloudSync')) $('#cloudSync').onclick = async () => { try { await getToken(true); await sync(true); } catch (e) { App.toast(e.message, 6000); } };
    if ($('#cloudOut')) $('#cloudOut').onclick = signOut;
  }
  function init() {
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
  return { init, signIn, signOut, sync, saved, get email() { return st.email; }, get status() { return status; } };
})();
