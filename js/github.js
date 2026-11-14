'use strict';
// Upload a design to a new private GitHub repository in the user's own account. The browser calls the GitHub REST API
// directly with the user's personal access token (classic, scope "repo": GitHub only lets classic tokens create
// repositories). The token is kept in this browser's localStorage and sent to api.github.com and nowhere else.
// One commit holds every file: blobs → tree → commit → branch update (the Git Data API, so binary files work too).
const GitHub = (() => {
  const API = 'https://api.github.com', KEY = 'cp-github-token', BRANCH = 'main';
  const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const setToken = t => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) { } };

  async function api(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = r.status === 401 ? 'the token is not valid (create a new one)' : r.status === 403 ? 'the token may lack the repo scope, or GitHub is rate-limiting: ' + (j.message || '') : j.message || r.statusText;
      const err = new Error(`GitHub ${r.status}: ${why}`); err.status = r.status; throw err;
    }
    return j;
  }
  // a file as base64 (strings are UTF-8 encoded first; Uint8Array is taken as is)
  function b64(d) {
    const bytes = typeof d === 'string' ? new TextEncoder().encode(d) : d;
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const slugRepo = n => String(n || 'circuitpilot-design').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'circuitpilot-design';

  // the README that goes into the repository: what the files are and where they came from
  function readme(name, paths) {
    const groups = [['Design', p => /\.json$/.test(p)], ['Gerbers and drill (fabrication)', p => p.startsWith('gerbers/')], ['JLCPCB assembly (BOM + CPL)', p => p.startsWith('jlcpcb/')],
      ['Netlist and BOM', p => /\.(net|csv)$/.test(p) && !p.startsWith('jlcpcb/')], ['Enclosure (3D print / sheet metal)', p => p.startsWith('enclosure/')], ['EasyEDA', p => p.startsWith('easyeda/')],
      ['Images', p => p.startsWith('images/') || /\.svg$/.test(p)], ['PDF drawings and datasheet', p => /\.pdf$/.test(p)]];
    const used = new Set(), rows = [];
    for (const [title, test] of groups) { const list = paths.filter(p => !used.has(p) && test(p)); list.forEach(p => used.add(p)); if (list.length) rows.push(`### ${title}\n\n` + list.map(p => `- \`${p}\``).join('\n')); }
    const rest = paths.filter(p => !used.has(p)); if (rest.length) rows.push('### Other\n\n' + rest.map(p => `- \`${p}\``).join('\n'));
    return `# ${name}\n\nCircuit design made with [CircuitPilot](https://pcbgo.site) (source: https://github.com/Abdelhayali/CircuitPilot).\n\nOpen the \`.circuit.json\` file in CircuitPilot (Projects → Open, or Folder → Import) to edit the design again.\n\n${rows.join('\n\n')}\n`;
  }

  // Uploads { name, files: { 'path/in/repo': string | Uint8Array } } to a new private repository.
  // onStep(text) reports progress. Returns { url, repo, files }.
  async function uploadDesign({ name, files }, onStep = () => { }) {
    if (!getToken()) throw new Error('Paste your GitHub token first');
    onStep('Checking your GitHub account…');
    const me = await api('GET', '/user');
    let repo = slugRepo('circuitpilot-' + (name || 'design')), made = null;
    for (let n = 1; !made && n < 50; n++) {
      const rn = n === 1 ? repo : `${repo}-${n}`;
      try { made = await api('POST', '/user/repos', { name: rn, private: true, auto_init: true, description: `CircuitPilot design: ${name || rn}` }); repo = rn; }
      catch (e) { if (e.status !== 422) throw e; }   // 422: the name is taken, try the next one
    }
    if (!made) throw new Error('Could not find a free repository name');
    const owner = made.owner && made.owner.login || me.login, base = `/repos/${owner}/${repo}`;
    onStep('Creating the repository…');
    // auto_init creates the first commit a moment after the repository: wait for the branch
    let head = null;
    for (let i = 0; i < 20 && !head; i++) { try { head = await api('GET', `${base}/git/ref/heads/${BRANCH}`); } catch (e) { if (e.status !== 404) throw e; await new Promise(r => setTimeout(r, 700)); } }
    if (!head) throw new Error('GitHub did not create the first commit in time (open the repository and try again)');
    const parent = await api('GET', `${base}/git/commits/${head.object.sha}`);

    const paths = Object.keys(files), entries = [];
    const all = Object.assign({}, files, { 'README.md': readme(name || repo, paths.concat(['README.md'])) });
    const names = Object.keys(all), total = names.length;
    let done = 0;
    // blobs, four at a time (GitHub asks clients not to hammer the API)
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < names.length) {
        const p = names[next++], d = all[p];
        const blob = await api('POST', `${base}/git/blobs`, { content: b64(d), encoding: 'base64' });
        entries.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
        onStep(`Uploading files… ${++done}/${total}`);
      }
    }));
    onStep('Saving one commit…');
    const tree = await api('POST', `${base}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
    const commit = await api('POST', `${base}/git/commits`, { message: `CircuitPilot design: ${name || repo}`, tree: tree.sha, parents: [head.object.sha] });
    await api('PATCH', `${base}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
    return { url: made.html_url || `https://github.com/${owner}/${repo}`, repo: `${owner}/${repo}`, files: names.length };
  }

  // ---------- sign in with GitHub (OAuth web flow; pcbgo.site only, the relay holds the client secret) ----------
  // The page sends the user to github.com; GitHub returns to this page with ?code= and ?state=; the relay swaps the code
  // for an access token; the token is saved like a pasted one. Needs an OAuth app whose callback URL is https://pcbgo.site/.
  const clientId = () => (window.CP_CONFIG && CP_CONFIG.githubClientId) || '';
  const relayUrl = () => (window.CP_CONFIG && CP_CONFIG.relay) || '';
  const oauthAvailable = () => !!clientId() && /(^|\.)pcbgo\.site$/.test(location.hostname) && !!relayUrl();
  const callback = () => location.origin + '/';
  const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  function signIn() {
    if (!oauthAvailable()) throw new Error('GitHub sign-in is not set up for this site');
    const state = rnd();
    try { sessionStorage.setItem('cp-github-state', state); } catch (e) { }
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: callback(), scope: 'repo', state, allow_signup: 'true' });
    location.href = 'https://github.com/login/oauth/authorize?' + q;
  }
  // called when the page loads: if GitHub sent the user back with a code, finish the sign-in
  async function finishSignIn() {
    const u = new URL(location.href), code = u.searchParams.get('code'), state = u.searchParams.get('state');
    if (!code || !state || !oauthAvailable()) return null;
    const want = (() => { try { return sessionStorage.getItem('cp-github-state'); } catch (e) { return null; } })();
    history.replaceState(null, '', location.pathname + location.hash);
    try { sessionStorage.removeItem('cp-github-state'); } catch (e) { }
    if (!want || want !== state) throw new Error('GitHub sign-in was cancelled or did not match (try again)');
    const r = await fetch(relayUrl().replace(/\/$/, '') + '/github/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, redirect_uri: callback() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('GitHub sign-in failed: ' + (j.error || r.statusText));
    setToken(j.access_token);
    return check();
  }
  const signOut = () => setToken('');

  // Check the token; returns the account name (or throws)
  async function check() { return (await api('GET', '/user')).login; }

  return { getToken, setToken, uploadDesign, check, oauthAvailable, signIn, finishSignIn, signOut };
})();
