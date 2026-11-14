'use strict';
// Designs in the user's own GitHub account. Every design is a folder in one repository the user chooses (or creates):
// repo/<design>/ holds the project file, Gerbers, BOM and CPL, EasyEDA files, netlist, images, PDFs and a README.
// The browser calls the GitHub REST API directly. Sign-in: OAuth on pcbgo.site (the relay holds the client secret), or a
// classic personal access token (scope "repo") anywhere. The token is kept in this browser's localStorage and sent only
// to api.github.com. A save is one commit: only changed files are uploaded (blobs → tree → commit → branch).
const GitHub = (() => {
  const API = 'https://api.github.com', KEY = 'cp-github-token', BRANCH = 'main', REPO_KEY = 'cp.github.repo';
  const enc = new TextEncoder();
  const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const setToken = t => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) { } };
  const getRepo = () => { try { return localStorage.getItem(REPO_KEY) || ''; } catch (e) { return ''; } };
  const setRepo = r => { try { if (r) localStorage.setItem(REPO_KEY, r); else localStorage.removeItem(REPO_KEY); } catch (e) { } };

  async function api(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = r.status === 401 ? 'the sign-in expired or the token is not valid (sign in again)' : r.status === 403 ? 'the token may lack the repo scope, or GitHub is rate-limiting: ' + (j.message || '') : j.message || r.statusText;
      const err = new Error(`GitHub ${r.status}: ${why}`); err.status = r.status; throw err;
    }
    return j;
  }
  // a file as bytes (strings are UTF-8 encoded first)
  const bytesOf = d => typeof d === 'string' ? enc.encode(d) : d;
  function b64(d) {
    const bytes = bytesOf(d);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // git's blob id (SHA-1 of "blob <size>\0<content>"): lets an unchanged file be skipped without uploading it
  async function gitSha(d) {
    const bytes = bytesOf(d), head = enc.encode('blob ' + bytes.length + '\0'), all = new Uint8Array(head.length + bytes.length);
    all.set(head); all.set(bytes, head.length);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', all)), b => b.toString(16).padStart(2, '0')).join('');
  }
  const slug = (n, fb) => String(n || fb).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || fb;

  // the README of one design folder: what the files are and where they came from (paths relative to the folder)
  function readme(name, paths) {
    const groups = [['Design', p => /\.json$/.test(p)], ['Gerbers and drill (fabrication)', p => p.startsWith('gerbers/')], ['JLCPCB assembly (BOM + CPL)', p => p.startsWith('jlcpcb/')],
      ['EasyEDA (import in EasyEDA Pro / Standard)', p => p.startsWith('easyeda/')], ['Netlist and BOM', p => /\.(net|csv)$/.test(p) && !p.startsWith('jlcpcb/')],
      ['Enclosure (3D print / sheet metal)', p => p.startsWith('enclosure/')], ['Images', p => p.startsWith('images/') || /\.svg$/.test(p)], ['PDF drawings and datasheet', p => /\.pdf$/.test(p)]];
    const used = new Set(), rows = [];
    for (const [title, test] of groups) { const list = paths.filter(p => !used.has(p) && test(p)); list.forEach(p => used.add(p)); if (list.length) rows.push(`### ${title}\n\n` + list.map(p => `- \`${p}\``).join('\n')); }
    const rest = paths.filter(p => !used.has(p)); if (rest.length) rows.push('### Other\n\n' + rest.map(p => `- \`${p}\``).join('\n'));
    return `# ${name}\n\nCircuit design made with [CircuitPilot](https://pcbgo.site) (source: https://github.com/Abdelhayali/CircuitPilot).\n\nOpen the \`.circuit.json\` file in CircuitPilot to edit the design again.\n\n${rows.join('\n\n')}\n`;
  }

  // ---------- sign in (OAuth web flow on pcbgo.site; the relay holds the client secret) ----------
  // GitHub sends the user back to this page with ?code= and ?state=; the relay swaps the code for a token.
  // Needs an OAuth app whose callback URL is https://pcbgo.site/.
  const clientId = () => (window.CP_CONFIG && CP_CONFIG.githubClientId) || '';
  const relayUrl = () => (window.CP_CONFIG && CP_CONFIG.relay) || '';
  // GitHub only returns to the callback URL of the OAuth app. A page on localhost (server.py, the desktop version) is
  // sent through that callback: pcbgo.site hands the code on to the localhost page (state carries its address).
  const CALLBACK = 'https://pcbgo.site/';
  const localOrigin = o => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const onSite = () => /(^|\.)pcbgo\.site$/.test(location.hostname);
  const oauthAvailable = () => !!clientId() && (onSite() || localOrigin(location.origin)) && !!relayUrl();
  const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  function signIn() {
    if (!oauthAvailable()) throw new Error('GitHub sign-in is not set up for this site');
    const state = rnd() + (onSite() ? '' : '_' + encodeURIComponent(location.origin));
    try { sessionStorage.setItem('cp-github-state', state); } catch (e) { }
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: CALLBACK, scope: 'repo', state, allow_signup: 'true' });
    location.href = 'https://github.com/login/oauth/authorize?' + q;
  }
  // called when the page loads: if GitHub sent the user back with a code, finish the sign-in
  async function finishSignIn() {
    const u = new URL(location.href), code = u.searchParams.get('code'), state = u.searchParams.get('state');
    if (!code || !state || !oauthAvailable()) return null;
    // GitHub sent the code to pcbgo.site for a page on localhost: hand it on to that page, with the same query
    const back = /^[0-9a-f]{32}_(.+)$/.exec(state);
    if (onSite() && back) {
      let origin = ''; try { origin = decodeURIComponent(back[1]); } catch (e) { }
      if (localOrigin(origin)) { location.replace(origin + '/' + location.search + location.hash); return null; }
    }
    const want = (() => { try { return sessionStorage.getItem('cp-github-state'); } catch (e) { return null; } })();
    history.replaceState(null, '', location.pathname + location.hash);
    try { sessionStorage.removeItem('cp-github-state'); } catch (e) { }
    if (!want || want !== state) throw new Error('GitHub sign-in was cancelled or did not match (try again)');
    const r = await fetch(relayUrl().replace(/\/$/, '') + '/github/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, redirect_uri: CALLBACK }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('GitHub sign-in failed: ' + (j.error || r.statusText));
    setToken(j.access_token);
    return check();
  }
  const signOut = () => { setToken(''); setRepo(''); try { localStorage.removeItem('cp.github.login'); } catch (e) { } };

  // ---------- repositories ----------
  // the signed-in account's repositories (most recently updated first)
  async function listRepos() {
    const r = await api('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner');
    return r.map(x => ({ full: x.full_name, private: x.private }));
  }
  // a new private repository with a first commit (auto_init), named by the user
  async function createRepo(name, desc) {
    const rn = slug(name, 'circuitpilot-designs');
    let made;
    try { made = await api('POST', '/user/repos', { name: rn, private: true, auto_init: true, description: desc || 'CircuitPilot designs' }); }
    catch (e) { if (e.status === 422) throw new Error(`A repository named “${rn}” already exists in your account — choose it from the list, or type another name`); throw e; }
    const full = made.full_name, base = `/repos/${full}`;
    // auto_init creates the first commit a moment after the repository: wait for the branch
    for (let i = 0; i < 20; i++) { try { await api('GET', `${base}/git/ref/heads/${BRANCH}`); return full; } catch (e) { if (e.status !== 404) throw e; await new Promise(r => setTimeout(r, 700)); } }
    throw new Error('GitHub did not create the first commit in time (open the repository on GitHub, then try again)');
  }

  // ---------- save one design into its folder of the repository ----------
  // files: { 'name': string | Uint8Array } relative to the design folder. Returns { changed, folder, url }.
  // another device may have saved in between (GitHub answers 422 "not a fast forward"): read the branch again and retry
  async function saveDesign(o) {
    for (let attempt = 1; ; attempt++) {
      try { return await commitOnce(o); }
      catch (e) { if (e.status !== 422 || attempt >= 3) throw e; }
    }
  }
  async function commitOnce({ repo, folder, name, files, onStep = () => { } }) {
    const base = `/repos/${repo}`, prefix = folder ? folder + '/' : '';
    const head = await api('GET', `${base}/git/ref/heads/${BRANCH}`);
    const commit = await api('GET', `${base}/git/commits/${head.object.sha}`);
    const tree = await api('GET', `${base}/git/trees/${commit.tree.sha}?recursive=1`);
    const remote = new Map(tree.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix)).map(e => [e.path, e.sha]));
    const want = Object.assign({}, files, { 'README.md': readme(name || folder, Object.keys(files).concat(['README.md'])) });
    const todo = [];
    for (const rel of Object.keys(want)) {
      const path = prefix + rel, sha = await gitSha(want[rel]);
      if (remote.get(path) === sha) { remote.delete(path); continue; }
      todo.push([path, want[rel]]); remote.delete(path);
    }
    const gone = [...remote.keys()];   // files of this design that are no longer made: removed from the folder
    const url = `https://github.com/${repo}/tree/${BRANCH}/${folder}`;
    if (!todo.length && !gone.length) return { changed: 0, folder, url };
    const entries = [];
    // blobs, four at a time (GitHub asks clients not to hammer the API)
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < todo.length) {
        const [path, d] = todo[next++];
        const blob = await api('POST', `${base}/git/blobs`, { content: b64(d), encoding: 'base64' });
        entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        onStep(`Uploading ${++done}/${todo.length} changed files…`);
      }
    }));
    for (const path of gone) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    onStep('Saving one commit…');
    const nt = await api('POST', `${base}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
    const nc = await api('POST', `${base}/git/commits`, { message: `Save ${name || folder} (${todo.length} changed${gone.length ? ', ' + gone.length + ' removed' : ''})`, tree: nt.sha, parents: [head.object.sha] });
    await api('PATCH', `${base}/git/refs/heads/${BRANCH}`, { sha: nc.sha, force: false });
    return { changed: todo.length + gone.length, folder, url };
  }

  // ---------- load designs back from the repository ----------
  // every design folder: { folder, path, sha } for its .circuit.json (the project file)
  async function listDesigns(repo) {
    const base = `/repos/${repo}`, head = await api('GET', `${base}/git/ref/heads/${BRANCH}`);
    const commit = await api('GET', `${base}/git/commits/${head.object.sha}`);
    const tree = await api('GET', `${base}/git/trees/${commit.tree.sha}?recursive=1`);
    const out = new Map();
    for (const e of tree.tree) {
      const m = /^([^/]+)\/([^/]+\.circuit\.json)$/.exec(e.path);
      if (e.type === 'blob' && m && !out.has(m[1])) out.set(m[1], { folder: m[1], path: e.path, sha: e.sha });
    }
    return [...out.values()];
  }
  // the text of one file in the repository (by its blob id)
  async function readBlob(repo, sha) {
    const j = await api('GET', `/repos/${repo}/git/blobs/${sha}`);
    const bin = atob(String(j.content || '').replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  // Check the token; returns the account name (or throws)
  async function check() { const login = (await api('GET', '/user')).login; try { localStorage.setItem('cp.github.login', login); } catch (e) { } return login; }
  const account = () => { try { return localStorage.getItem('cp.github.login') || ''; } catch (e) { return ''; } };

  return { getToken, setToken, getRepo, setRepo, check, account, listRepos, createRepo, saveDesign, listDesigns, readBlob, gitSha, slug, oauthAvailable, signIn, finishSignIn, signOut };
})();
