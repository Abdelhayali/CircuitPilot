'use strict';
// Save projects in a folder on the PC (File System Access API: Chrome / Edge). "Save to folder…" links the current
// project to <name>.circuit.json in a folder you choose; after that every save also writes that file. "Open from
// folder…" opens a project file from a folder and keeps it linked. Links (folder handles) are kept in IndexedDB;
// after a restart the browser asks once for permission again (on the next click of Save or the 📁 indicator).
const Folder = (() => {
  const $ = s => document.querySelector(s);
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  let db = null, link = null, linkFor, timer = null, lastWritten = '', needsPermission = false, gen = 0;

  function idb() {
    if (db) return db;
    db = new Promise((res, rej) => { const r = indexedDB.open('circuitpilot-folders', 1); r.onupgradeneeded = () => r.result.createObjectStore('links'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return db;
  }
  const tx = async (mode, f) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('links', mode), st = t.objectStore('links'), q = f(st); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const getLink = id => tx('readonly', st => st.get(id)).catch(() => null);
  const setLink = (id, v) => tx('readwrite', st => v ? st.put(v, id) : st.delete(id)).catch(() => null);
  const fileName = name => String(name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) + '.circuit.json';
  const projectKey = () => Model.S.id || null;

  async function permitted(dir, ask) {
    const o = { mode: 'readwrite' };
    if ((await dir.queryPermission(o)) === 'granted') return true;
    return ask ? (await dir.requestPermission(o)) === 'granted' : false;
  }
  function status() {
    const el = $('#folderState'); if (!el) return;
    if (!link) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = needsPermission ? '📁 Allow folder access' : '📁 ' + link.dir.name;
    el.title = needsPermission ? 'Click to let CircuitPilot keep saving to ' + link.dir.name + '/' + link.file : 'Also saved to the folder ' + link.dir.name + ' as ' + link.file + ' — click for folder options';
    el.className = needsPermission ? 'warn folderstate' : 'muted folderstate';
    const stop = $('#fdStop'); if (stop) stop.classList.toggle('hidden', !link);
  }
  // the link of the project that is open now
  async function refresh() {
    const id = projectKey();
    if (id === linkFor) return;   // same project: keep the link we have
    const mine = ++gen; linkFor = id; link = null; lastWritten = '';
    const l = id ? await getLink(id) : null;
    if (mine !== gen || projectKey() !== id) return;   // switched again, or a folder was chosen meanwhile
    link = l;
    needsPermission = !!link && !(await permitted(link.dir, false).catch(() => false));
    status();
  }
  function setCurrent(l) { gen++; link = l; linkFor = projectKey(); needsPermission = false; }
  async function write(ask) {
    if (!link) return false;
    if (!(await permitted(link.dir, ask).catch(() => false))) { needsPermission = true; status(); return false; }
    needsPermission = false;
    const text = JSON.stringify(Model.S, null, 1);
    if (text === lastWritten) { status(); return true; }
    const fh = await link.dir.getFileHandle(link.file, { create: true }), w = await fh.createWritable();
    await w.write(text); await w.close();
    lastWritten = text; status();
    return true;
  }
  function schedule() { if (!link || needsPermission) return; clearTimeout(timer); timer = setTimeout(() => write(false).catch(e => App.toast('Could not save to the folder: ' + e.message, 6000)), 1500); }

  async function saveTo() {
    if (!supported) { App.toast('Saving to a PC folder needs Chrome or Edge — downloading the project file instead', 7000); App.exportProject(); return; }
    let dir; try { dir = await window.showDirectoryPicker({ id: 'circuitpilot-projects', mode: 'readwrite' }); } catch (e) { return; }   // cancelled
    if (!(await permitted(dir, true))) { App.toast('No permission to write in that folder'); return; }
    if (!projectKey()) await Projects.saveNow();
    const file = fileName(Model.S.name);
    let exists = false; try { await dir.getFileHandle(file); exists = true; } catch (e) { }
    if (exists && !confirm(`${file} already exists in ${dir.name}. Replace it with this project?`)) return;
    setCurrent({ dir, file }); lastWritten = '';
    if (linkFor) await setLink(linkFor, link);
    await write(true);
    App.toast(`Saved to ${dir.name}/${file} — every save now updates this file too`, 7000);
  }
  async function openFrom() {
    if (!supported) { App.toast('Opening from a PC folder needs Chrome or Edge — use Projects → Import instead', 7000); return; }
    let dir; try { dir = await window.showDirectoryPicker({ id: 'circuitpilot-projects', mode: 'readwrite' }); } catch (e) { return; }
    const files = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.json$/i.test(name)) files.push({ name, h });
    files.sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) { App.toast('No project files (.circuit.json) in ' + dir.name, 6000); return; }
    const pick = await choose(dir.name, files.map(f => f.name)); if (pick == null) return;
    const f = files[pick];
    let d; try { d = JSON.parse(await (await f.h.getFile()).text()); } catch (e) { App.toast('Not a CircuitPilot project file: ' + e.message); return; }
    if (!d || !Array.isArray(d.components)) { App.toast(f.name + ' is not a CircuitPilot project'); return; }
    await App.openProjectData(d, f.name.replace(/\.circuit\.json$|\.json$/i, ''));
    if (await permitted(dir, true).catch(() => false)) {
      setCurrent({ dir, file: f.name }); lastWritten = JSON.stringify(Model.S, null, 1);
      if (linkFor) await setLink(linkFor, link);
      App.toast(`Opened ${f.name} from ${dir.name} — saves go back to this file`, 7000);
    }
    status();
  }
  async function stop() {
    if (!link) return;
    const where = link.dir.name + '/' + link.file;
    if (linkFor) await setLink(linkFor, null);
    setCurrent(null); status(); App.toast('No longer saving to ' + where + ' (the file stays there)');
  }
  // small list dialog
  function choose(folder, names) {
    return new Promise(res => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = `<div class="dlg"><div class="row-h"><h2>Open from ${folder.replace(/[<>&]/g, '')}</h2><button data-x>✕</button></div><div class="fdlist">${names.map((n, i) => `<button data-i="${i}">${n.replace(/[<>&]/g, '')}</button>`).join('')}</div></div>`;
      const done = v => { m.remove(); res(v); };
      m.onclick = e => { const b = e.target.closest('[data-i]'); if (b) done(+b.dataset.i); else if (e.target.closest('[data-x]') || e.target === m) done(null); };
      document.body.appendChild(m);
    });
  }

  function init() {
    $('#fdSave').onclick = saveTo; $('#fdOpen').onclick = openFrom; $('#fdStop').onclick = stop;
    $('#folderState').onclick = async () => { if (needsPermission) { if (await write(true).catch(() => false)) App.toast('Saving to ' + link.dir.name + ' again'); } else saveTo(); };
    if (!supported) { $('#fdSave').title = 'Needs Chrome or Edge'; $('#fdOpen').title = 'Needs Chrome or Edge'; }
    // 'load' is also undo / redo: write those too; a project switch picks up that project's own link first
    Model.subscribe(kind => { if (kind === 'load' || kind === 'meta') refresh().then(schedule); else if (kind !== 'move') schedule(); });
    refresh();
  }
  // Save button / Ctrl+S: a user action, so permission can be asked again here
  const onSave = () => link ? write(true).catch(e => { App.toast('Could not save to the folder: ' + e.message, 6000); return false; }) : Promise.resolve(false);
  return { init, onSave, saveTo, openFrom, stop, get linked() { return link ? link.dir.name + '/' + link.file : null; }, supported };
})();
