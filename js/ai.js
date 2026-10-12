'use strict';
// AI Copilot: multi-provider model calls, tool definitions, agent loop (Agent / Ask / Plan modes).
const AI = (() => {
  const MODELS = [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  ];
  const PRESETS = {
    'OpenAI': 'https://api.openai.com/v1',
    'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta/openai',
    'xAI Grok': 'https://api.x.ai/v1',
    'OpenRouter': 'https://openrouter.ai/api/v1',
    'Local :8080': 'http://localhost:8080/v1',
    'Ollama (local)': 'http://localhost:11434/v1',
    'Ollama Cloud': 'https://ollama.com/v1',
    'LM Studio (local)': 'http://localhost:1234/v1',
  };
  // no model is preselected: the user connects a provider first (🔑 Connect AI)
  const defaults = { anthropicKey: '', oaiBase: '', oaiKey: '', oaiModels: '', model: '', maxTokens: 8192, includeContext: true, webAccess: true, braveKey: '' };
  let settings = Object.assign({}, defaults);
  try { Object.assign(settings, JSON.parse(localStorage.getItem('cp.settings') || '{}')); } catch (e) { }
  const saveSettings = s => { settings = Object.assign(settings, s); try { localStorage.setItem('cp.settings', JSON.stringify(settings)); } catch (e) { } };
  // Local model servers (localhost / this PC) are reached through server.py's /llm-proxy/<port>/,
  // which works from phones on the LAN and sidesteps missing CORS headers.
  let proxyOk = null;
  async function hasProxy() {
    if (proxyOk !== null) return proxyOk;
    try { const r = await fetch('/llm-proxy/_ping'); proxyOk = r.ok && (await r.json()).ok === true; } catch (e) { proxyOk = false; }
    return proxyOk;
  }
  async function resolveBase(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    let u; try { u = new URL(base); } catch (e) { throw new Error('Invalid base URL: ' + base); }
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', location.hostname].includes(u.hostname);
    if (local && u.protocol === 'http:' && await hasProxy()) return `${location.origin}/llm-proxy/${u.port || 80}${u.pathname.replace(/\/+$/, '')}`;
    // cloud APIs that don't allow browser (CORS) calls go through server.py's fixed-destination proxy
    if (/(^|\.)ollama\.com$/.test(u.hostname) && (await hasProxy() || (window.CPStatic && await CPStatic.detect() === 'static'))) return `${location.origin}/llm-cloud/ollama${u.pathname.replace(/\/+$/, '')}`;
    return base;
  }
  async function fetchModels(base, key) {
    const headers = {}; if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(await resolveBase(base) + '/models', { headers, signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(friendlyError(res.status, (Array.isArray(j) ? j[0] : j)?.error?.message || res.statusText));
    const ids = (j.data || j.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    if (!ids.length) throw new Error('Server returned no models');
    return ids;
  }
  // the provider's error plus what to do about it
  function friendlyError(status, msg) {
    msg = String(msg || '').trim() || 'request failed';
    const hint = status === 401 || /api.?key not valid|invalid api.?key|valid api.?key|incorrect api.?key|unauthori[sz]ed|authentication/i.test(msg) ? 'The API key was not accepted. Check that you pasted the whole key (⚙ Settings or 🔑 Connect AI).'
      : status === 402 || status === 403 || /subscription|upgrade|paid plan|billing|permission/i.test(msg) ? 'Your plan may not include this model. Pick another model in the menu above the chat.'
      : status === 404 || /model .*not found|no such model|does not exist/i.test(msg) ? 'This model is not available with this key. Pick another model in the menu above the chat.'
      : status === 429 || /rate limit|quota|too many requests|resource.?exhausted/i.test(msg) ? 'The provider\'s rate limit was reached (free plans allow a limited number of requests per minute or day). Wait a minute and try again, or pick a smaller model.'
      : /tool/i.test(msg) ? 'This model does not support tool calling, which the copilot needs. Pick another model (e.g. gpt-oss:120b on Ollama Cloud or a Gemini Flash model).'
      : '';
    return `API ${status}: ${msg}${hint ? ' — ' + hint : ''}`;
  }
  const allModels = () => [...(settings.anthropicKey ? MODELS : []), ...settings.oaiModels.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, label: id, provider: 'openai' }))];

  // Tools live in engine.js (shared with the MCP server / REST API).
  const TOOLS = Engine.TOOLS, execTool = Engine.exec;

  // ---------- prompts ----------
  const BASE = `You are CircuitPilot, an expert electronics engineer embedded in a schematic + PCB design app. You design circuits by calling tools that edit the live schematic, then lay out the PCB.

DESIGN MODEL
- Components: ref (R1, C1, U1, Q1, D1, J1 ...), library type, value, schematic x/y (grid 10; a resistor is 60 wide; signal flows left→right, supply at top, ground at bottom), rotation 0/90/180/270, and footprint.
- SCHEMATIC SPACING: keep parts well apart so net labels never collide — at least 120 units between small parts and 250+ units between ICs / modules (their pins carry long net labels); put each functional block in its own area. The app also pushes overlapping parts apart after every edit, but plan the spacing yourself.
- MULTI-SHEET: for designs with more than ~15 parts or several blocks, split the schematic into sheets (add_sheet, or sheet: n in add_components): e.g. 1 Power, 2 MCU, 3 Sensors / IO, 4 Connectors. Nets connect across sheets by name.
- Connectivity is by named nets. Pins are referenced "REF.PIN" with the pin number or name ("R1.1", "Q1.B", "U1.VCC"). A name shared by several pins (e.g. "U1.GND") connects all of them.
- Nets named GND or supply names (VCC, VDD, +5V, +3V3, +12V, VBAT, VIN ...) render as power symbols. Give meaningful names to important signals (OUT, LED_K, SDA, TRIG ...); otherwise any name is fine.
- Pin numbering: resistor/capacitor/inductor 1,2; electrolytic 1=+ 2=-; diode/LED/zener/schottky 1=K(cathode) 2=A(anode); npn/pnp 1=B 2=E 3=C; nmos/pmos 1=G 2=S 3=D; regulator 1=IN 2=GND 3=OUT; opamp 2=IN- 3=IN+ 4=V- 6=OUT 7=V+; potentiometer 1, 2=W(wiper), 3; battery 1=+ 2=-.
- COMPONENT DATABASE: for real ICs, modules, regulators, connectors (ESP32, STM32, AMS1117, CH340, USB-C, etc.) use search_parts → pick an in-stock part (prefer Basic parts) → get_part → add_components with {"lcsc": "Cxxxx"}. This gives the exact pinout and real footprint; connect using the pin names returned by get_part. Built-in types (resistor, capacitor, LED, diode, transistor, regulator, …) automatically get a real JLCPCB part's footprint and pinout (pins matched by name); match_jlcpcb_parts fills in part numbers per value for assembly.
- CUSTOM PARTS: if a part is not in the database (or the user asks), create it with create_part (pins + footprint generator or explicit pads), then add_components {lcsc: <returned key>}. Fix wrong pinouts/footprints with update_part.
- PROJECT KNOWLEDGE: when the project has a knowledge folder, follow its requirements, conventions and guides. Use knowledge_search / knowledge_read for details not included below.
- PCB WORKFLOW: generate_pcb (connectors go on the board edge automatically; placement is annealed for short connections; the router rips up and re-routes for up to the routeTime budget) → if anything is unrouted, call optimize_pcb (moves parts and re-routes; shrink: true also makes the board as small as it still routes) → optionally add_copper_pour GND on both layers (frees routing space and replaces long GND traces) → run_drc and fix errors. Don't just repeat route_pcb on the same placement. Use set_board_shape for rounded / round / custom outlines. When the board already exists and the user edits the schematic (adds/removes parts, rewires, changes footprints), call update_pcb_from_schematic instead of generate_pcb — it keeps the layout and tracks and only places/routes what changed.
- PCB PLACEMENT (when asked to place / auto-place, or when routing struggles): read get_pcb_layout (part sizes, pins with their nets and positions), then decide a floor plan like an experienced layout engineer: connectors on the board edges facing out; the main IC central with room (1–2 mm) around fine-pitch sides for fan-out; each decoupling capacitor within ~1–2 mm of the power pin it serves, on the same side; crystal and its caps right next to the MCU clock pins; regulator and bulk caps near the power input; USB / differential pairs short and straight from connector to IC; group parts by function along the signal flow; avoid placing parts where they block the straight path between an IC and its connector. Apply it in ONE place_footprints call (all parts), then route_pcb; if nets stay unrouted, move the parts around them (another place_footprints) or call optimize_pcb.
- CUSTOM 3D DESIGNS: for anything beyond a plain box — wearables (wristband / watch pods like Whoop, rings, clips), ECG / EEG / EMG patches with electrode holes, curved, rounded or organic housings, mounts, brackets — call enclosure_script_help (it lists 35 tested templates — 10 wrist, 10 chest/ECG, 7 body-worn, 8 boxes; fetch the closest with template: id and adapt it rather than starting from zero), then write the 3D script with set_enclosure_script (rounded boxes, hulls, extrude/revolve, booleans; coordinates relative to the PCB). Read the fit report: fix every collision with the PCB/components and any script error, and call set_enclosure_script again until it is clean. Ask about key dimensions you cannot infer (wrist size, strap width, electrode type/spacing) only if they matter; otherwise use sensible defaults and say which you chose.
- LOOK AT YOUR WORK: view_design returns a screenshot of the schematic, the 2D PCB, the 3D board or the enclosure. After building or changing something, look at it (e.g. crowded or overlapping symbols, parts far apart, odd placement, a connector not on the edge, a part sticking out of the case) and fix what you see. Ask only for the view you need; each image uses context.
- DOCUMENTATION: the Documentation tab makes a product datasheet PDF. Read it with get_documentation and write the text with set_documentation (title, tagline, description, features, applications, notes; title/company/version also fill the schematic title block). Base every claim on the design. Specs, images and BOM are automatic.
- ENCLOSURE: the Enclosure tab builds a 3D-printable case fitted to the PCB (STL + OpenSCAD). Use add_mounting_holes for screw standoffs (then route_pcb), set_enclosure for wall/lid/heights/vents, add_enclosure_cutout for extra openings (switches, cables, displays), get_enclosure to check sizes. Connector openings and LED/button lid holes are automatic.
- INTERNET: you can use web_search and web_fetch for anything you need — datasheets (pinouts, absolute maximum ratings, reference/application circuits, recommended layouts), application notes, part availability and prices, calculations or standards. Read the relevant datasheet before choosing values for unfamiliar chips. Cite the URLs you relied on.
- If the database is unavailable, use type "ic" with "pins" = the exact datasheet pin names in pin-number order (e.g. NE555: ["GND","TRIG","OUT","RESET","CTRL","THR","DIS","VCC"]) and an appropriate footprint (DIP-8, SOIC-8, ...). Use "connector" for headers/terminals with descriptive pin names.

Use real, purchasable part values and show key calculations briefly (e.g. LED resistor = (Vs - Vf)/I). Keep replies concise and well formatted (markdown).`;

  const MODE = {
    agent: `MODE: AGENT — you can edit the design.
Workflow: 1) one or two sentences on the approach + key values; 2) add_components in ONE batch with sensible x/y; 3) connect ALL nets in ONE batch (every pin connected unless intentionally unused); 4) run_erc and fix real problems; 5) if the user wants a board/PCB, call generate_pcb and report routed/unrouted nets; 6) finish with a short summary (BOM highlights, things to double-check). If the design already has parts, modify it rather than starting over unless asked.`,
    ask: `MODE: ASK — read-only. You may inspect the design with get_design / run_erc / pcb_status / list_parts, but you cannot modify anything. Answer questions, review the design, explain circuit theory, suggest components and point out bugs.`,
    plan: `MODE: PLAN — do NOT modify the design. Produce a clear implementation plan in markdown:
## Goal  ## Key decisions & calculations  ## Bill of materials (table: Ref | Type | Value | Footprint | Purpose)  ## Connections (table: Net | Pins)  ## Steps
Use refs and pin names exactly as they will be used with the tools. End by telling the user to press **Execute plan** to build it.`
  };

  const designContext = Engine.designContext;

  // ---------- provider adapters (neutral history -> provider format) ----------
  // Attachments on a user message: {name, kind: 'image'|'pdf'|'text', mime, data (base64, images/PDFs), text (extracted)}
  const fileText = f => `\n\n[Attached file: ${f.name}${f.pages ? ` (${f.pages} pages)` : ''}]\n` + (f.text ? f.text : f.data ? '' : '(content not available — the file was attached in an earlier session; ask the user to attach it again if needed)');
  function anthropicUser(m) {
    const b = [];
    for (const f of m.files || []) {
      if (f.kind === 'image' && f.data) b.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } });
      else if (f.kind === 'pdf' && f.data) b.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name });
    }
    const extra = (m.files || []).filter(f => !((f.kind === 'image' || f.kind === 'pdf') && f.data)).map(fileText).join('');
    b.push({ type: 'text', text: (m.text || '') + extra || '(see attachment)' });
    return b;
  }
  function openaiUser(m) {
    const files = m.files || [];
    const text = (m.text || '') + files.filter(f => !(f.kind === 'image' && f.data)).map(fileText).join('');
    const imgs = files.filter(f => f.kind === 'image' && f.data);
    if (!imgs.length) return text;
    return [{ type: 'text', text: text || '(see image)' }, ...imgs.map(f => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } }))];
  }
  // Screenshots from view_design: only the two most recent are sent to the model (older ones would just re-cost
  // context on every request); models that refuse images get a short note instead (noVision).
  const noVision = new Set();
  function liveShots(hist) {
    const ids = []; for (const m of hist) if (m.role === 'tool') for (const r of m.results || []) if (r.image && r.image.data) ids.push(r.id);
    return new Set(ids.slice(-2));
  }
  const shotNote = (r, live, vision) => !r.image ? '' : !vision ? '\n(The screenshot was not sent: this model cannot read images.)' : !live.has(r.id) ? '\n(Earlier screenshot omitted; call view_design again to look at the current design.)' : '';
  function toAnthropic(hist, vision = true) {
    const out = [], live = liveShots(hist);
    const push = (role, blocks) => { const last = out[out.length - 1]; if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks }); };
    for (const m of hist) {
      if (m.role === 'user') push('user', anthropicUser(m));
      else if (m.role === 'assistant') {
        const b = []; if (m.text) b.push({ type: 'text', text: m.text });
        for (const t of m.toolCalls || []) b.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
        if (b.length) push('assistant', b);
      } else if (m.role === 'tool') push('user', m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, is_error: !!r.error,
        content: vision && live.has(r.id) ? [{ type: 'text', text: r.content }, { type: 'image', source: { type: 'base64', media_type: r.image.mime, data: r.image.data } }] : r.content + shotNote(r, live, vision) })));
    }
    return out;
  }
  function toOpenAI(hist, system, vision = true) {
    const out = [{ role: 'system', content: system }], live = liveShots(hist);
    for (const m of hist) {
      if (m.role === 'user') out.push({ role: 'user', content: openaiUser(m) });
      else if (m.role === 'assistant') {
        const o = { role: 'assistant', content: m.text || '' };
        // Gemini "thinking" models require each tool call's thought_signature to be sent back unchanged.
        // Calls recorded before this fix (or from another provider) get Google's documented bypass value.
        const gem = /generativelanguage\.googleapis\.com/.test(settings.oaiBase);
        // In a parallel batch Gemini signs only the first call — replay exactly what it sent; batches recorded with no
        // signature at all (older history) get the bypass value on their first call.
        const signed = (m.toolCalls || []).some(t => t.extra);
        if (m.toolCalls && m.toolCalls.length) o.tool_calls = m.toolCalls.map((t, k) => Object.assign({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } },
          t.extra ? { extra_content: t.extra } : (gem && !signed && k === 0) ? { extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } } : {}));
        out.push(o);
      } else if (m.role === 'tool') {
        // tool messages are text-only for OpenAI-compatible APIs: the screenshot follows as a user message
        for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content + shotNote(r, live, vision) });
        const shots = vision ? m.results.filter(r => live.has(r.id)) : [];
        if (shots.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot' + (shots.length > 1 ? 's' : '') + ' from view_design:' }, ...shots.map(r => ({ type: 'image_url', image_url: { url: `data:${r.image.mime};base64,${r.image.data}` } }))] });
      }
    }
    return out;
  }
  // a model that rejects image input is retried once without screenshots (and remembered for this session)
  async function callModel(model, system, hist, tools, signal, extra = {}) {
    const shots = hist.some(m => m.role === 'tool' && (m.results || []).some(r => r.image && r.image.data));
    try { return await callModelOnce(model, system, hist, tools, signal, extra, !noVision.has(model.id)); }
    catch (e) {
      if (!shots || noVision.has(model.id) || signal && signal.aborted || !/image|vision|multimodal|modalit|content.?part|content.?type|unsupported|invalid.*(content|message)/i.test(e.message)) throw e;
      noVision.add(model.id);
      return callModelOnce(model, system, hist, tools, signal, extra, false);
    }
  }
  async function callModelOnce(model, system, hist, tools, signal, extra = {}, vision = true) {
    if (model.provider === 'none') throw new Error('No AI model is connected yet. Click 🔑 Connect AI above the chat: a free Google Gemini or Ollama Cloud key takes about a minute.');
    if (model.provider === 'anthropic') {
      if (!settings.anthropicKey) throw new Error('No Anthropic API key — open ⚙ Settings to add one.');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(Object.assign({ model: model.id, max_tokens: extra.maxTokens || +settings.maxTokens || 8192, system, messages: toAnthropic(hist, vision) }, tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })) } : {}))
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${j.error?.message || res.statusText}`);
      return {
        text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        toolCalls: j.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
        usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null
      };
    }
    const base = await resolveBase(settings.oaiBase);
    const headers = { 'content-type': 'application/json' };
    if (settings.oaiKey) headers.authorization = 'Bearer ' + settings.oaiKey;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST', signal, headers,
      body: JSON.stringify(Object.assign({ model: model.id, messages: toOpenAI(hist, system, vision) }, extra.body || {}, tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}))
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(friendlyError(res.status, (Array.isArray(j) ? j[0] : j)?.error?.message || JSON.stringify(j).slice(0, 300) || res.statusText));
    const m = j.choices?.[0]?.message || {};
    return {
      text: (m.content || '').trim(),
      toolCalls: (m.tool_calls || []).map((t, i) => {
        let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch (e) { input = { __parse_error: t.function.arguments }; }
        return Object.assign({ id: t.id || 'call_' + Date.now() + '_' + i, name: t.function.name, input }, t.extra_content ? { extra: t.extra_content } : {});
      }),
      usage: j.usage ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens } : null
    };
  }

  // ---------- agent loop ----------
  let history = [], controller = null;
  try { history = JSON.parse(localStorage.getItem('cp.chat') || '[]'); } catch (e) { }
  // Attachment bytes are big: browser storage keeps them for the latest messages only (the text is always kept).
  const persist = () => {
    const keep = history.slice(-200), withData = keep.map((m, i) => (m.files || []).some(f => f.data) || (m.results || []).some(r => r.image) ? i : -1).filter(i => i >= 0);
    const strip = n => keep.map((m, i) => withData.indexOf(i) >= 0 && withData.indexOf(i) < withData.length - n ? Object.assign({}, m,
      m.files ? { files: m.files.map(f => Object.assign({}, f, { data: undefined })) } : {},
      m.results ? { results: m.results.map(r => r.image ? Object.assign({}, r, { image: undefined }) : r) } : {}) : m);
    for (const n of [3, 1, 0]) { try { localStorage.setItem('cp.chat', JSON.stringify(strip(n))); return; } catch (e) { } }
    try { localStorage.setItem('cp.chat', JSON.stringify(strip(0).map(m => m.checkpoint ? Object.assign({}, m, { checkpoint: undefined }) : m))); } catch (e) { }
  };
  const NO_MODEL = { id: '', label: 'No model', provider: 'none' };
  const currentModel = () => allModels().find(m => m.id === settings.model) || NO_MODEL;

  // ---------- context window, usage estimate, compression ----------
  const ctxCache = {};
  function contextWindow(model = currentModel()) {
    if (+settings.contextWindow > 0) return +settings.contextWindow;
    if (ctxCache[model.id]) return ctxCache[model.id];
    const id = model.id.toLowerCase();
    if (model.provider === 'anthropic') return 200000;
    if (/gemini/.test(id)) return 1000000;
    if (/gpt-4\.1/.test(id)) return 1000000;
    if (/gpt-5/.test(id)) return 400000;
    if (/grok/.test(id)) return 256000;
    if (/gpt-4o|^o\d/.test(id)) return 128000;
    return 32768;
  }
  // Ask the server for its real context size (llama.cpp /props, LM Studio, OpenRouter-style model lists).
  async function probeContext(model = currentModel()) {
    if (model.provider === 'anthropic' || ctxCache[model.id]) return contextWindow(model);
    try {
      const base = await resolveBase(settings.oaiBase), root = base.replace(/\/v1$/, '');
      const headers = settings.oaiKey ? { authorization: 'Bearer ' + settings.oaiKey } : {};
      const get = async u => { const r = await fetch(u, { headers, signal: AbortSignal.timeout(4000) }); return r.ok ? r.json() : null; };
      const props = await get(root + '/props').catch(() => null);
      const n = props && (props.default_generation_settings?.n_ctx || props.n_ctx);
      if (n > 0) return (ctxCache[model.id] = n);
      const list = await get(base + '/models').catch(() => null);
      const m = list && (list.data || list.models || []).find(x => (x.id || x.name) === model.id);
      // vLLM / ExLlama / TabbyAPI report max_model_len or max_seq_len, LM Studio max_context_length, OpenRouter context_length
      const c = m && (m.max_model_len || m.max_seq_len || m.context_length || m.max_context_length || m.loaded_context_length || m.context_window || m.top_provider?.context_length || m.meta?.n_ctx || m.meta?.n_ctx_train);
      if (c > 0) return (ctxCache[model.id] = c);
      const tabby = await get(base + '/model').catch(() => null);   // TabbyAPI: the loaded model
      const ct = tabby && (tabby.parameters?.max_seq_len || tabby.max_seq_len);
      if (ct > 0) return (ctxCache[model.id] = ct);
      // Ollama (local or cloud): /api/show → num_ctx if the model sets it, else the model's context length
      const show = await fetch(root + '/api/show', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify({ model: model.id }), signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (show) {
        const num = /num_ctx\s+(\d+)/.exec(show.parameters || ''), key = Object.keys(show.model_info || {}).find(k => k.endsWith('.context_length'));
        const v = num ? +num[1] : key ? +show.model_info[key] : 0;
        if (v > 0) return (ctxCache[model.id] = v);
      }
    } catch (e) { }
    return contextWindow(model);
  }
  let systemChars = 16000, lastIn = null; // lastIn = real prompt tokens reported by the provider for history[0..len)
  const toolChars = JSON.stringify(TOOLS).length;
  function estimateMsgs(msgs) {
    let chars = 0, extra = 0;
    for (const m of msgs) {
      chars += (m.text || '').length;
      for (const t of m.toolCalls || []) chars += t.name.length + JSON.stringify(t.input || {}).length + 20;
      for (const r of m.results || []) { chars += (r.content || '').length + 20; if (r.image && r.image.data) extra += 1600; }
      for (const f of m.files || []) { if (f.kind === 'image' && f.data) extra += 1600; else if (f.kind === 'pdf' && f.data) extra += (f.pages || 5) * 2000; else chars += (f.text || '').length + 60; }
    }
    return Math.round(chars / 3.5) + extra;
  }
  function contextInfo() {
    const win = contextWindow();
    let used;
    if (lastIn && lastIn.len <= history.length) used = lastIn.tokens + estimateMsgs(history.slice(lastIn.len));
    else used = Math.round((systemChars + toolChars) / 3.5) + estimateMsgs(history);
    return { used, window: win, pct: Math.min(100, Math.round(used / win * 100)), auto: settings.autoCompress !== false };
  }
  function transcriptOf(msgs) {
    const clip = (s, n) => (s = String(s || '')).length > n ? s.slice(0, n) + ' …' : s;
    return msgs.map(m => {
      if (m.role === 'user') return 'USER: ' + (m.text || '') + (m.files || []).map(f => `\n[attached ${f.name}]` + (f.text ? '\n' + clip(f.text, 3000) : '')).join('');
      if (m.role === 'assistant') return 'ASSISTANT: ' + (m.text || '') + (m.toolCalls || []).map(t => `\n→ ${t.name}(${clip(JSON.stringify(t.input || {}), 400)})`).join('');
      return (m.results || []).map(r => `RESULT ${r.name}${r.error ? ' (error)' : ''}: ${clip(r.content, 700)}`).join('\n');
    }).join('\n\n');
  }
  // Replace history[0..keepFrom) by a model-written summary. Returns true when something was compressed.
  async function compress(opt = {}) {
    const keepFrom = Math.min(opt.keepFrom ?? history.length, history.length);
    const old = history.slice(0, keepFrom);
    if (old.filter(m => m.role !== 'tool').length < 2) return false;
    const model = currentModel(), win = contextWindow(model);
    let t = transcriptOf(old); const cap = Math.max(20000, Math.floor(win * 0.5 * 3.5));
    if (t.length > cap) t = t.slice(0, 4000) + '\n\n[… middle of the conversation omitted …]\n\n' + t.slice(-(cap - 4000));
    const sys = 'You compress a conversation between a user and CircuitPilot (an AI electronics design copilot) so the work can continue with less context.';
    const ask = `Summarise the conversation below so it can replace it. Keep everything needed to continue: the user's goals and requirements; decisions and their reasons; exact values, part numbers (LCSC), refs, net names and calculations; what was changed in the design and the PCB; attached files (names and the key facts taken from them); web sources used; problems found and open tasks / next steps. Drop chit-chat and raw tool output. Use concise markdown bullets.\n\n<conversation>\n${t}\n</conversation>`;
    const own = !controller; if (own) controller = new AbortController();
    try {
      const r = await callModel(model, sys, [{ role: 'user', text: ask }], [], controller.signal);
      if (!r.text) throw new Error('the model returned an empty summary');
      const before = estimateMsgs(old);
      history = [{ role: 'user', text: r.text, summary: true, compressed: old.filter(m => m.role === 'user').length, saved: Math.max(0, before - estimateMsgs([{ text: r.text }])) },
        { role: 'assistant', text: 'Understood — continuing from this summary.', model: model.label, summaryAck: true }, ...history.slice(keepFrom)];
      lastIn = null; persist();
      return true;
    } finally { if (own) controller = null; }
  }
  // Last resort inside one long turn: shorten big tool results that the model has already seen.
  function trimToolResults(from) {
    for (let i = from; i < history.length - 1; i++) for (const r of history[i].results || []) if (r.content && r.content.length > 1500) r.content = r.content.slice(0, 1500) + ' …(trimmed to save context)';
    lastIn = null;
  }

  async function run(text, mode, hooks) {
    const model = currentModel();
    const tools = TOOLS.filter(t => (mode === 'agent' || t.ro) && (settings.webAccess || !t.web));
    history.push(Object.assign({ role: 'user', text, mode, checkpoint: hooks.checkpoint }, hooks.files && hooks.files.length ? { files: hooks.files } : {}));
    persist();
    controller = new AbortController();
    await probeContext(model);
    try {
      for (let step = 0; step < 40; step++) {
        // auto-compress when the context is 80% full: summarise everything before this turn, then trim this turn's tool output
        if (settings.autoCompress !== false && contextInfo().pct >= 80) {
          const turn = history.map(m => m.role === 'user').lastIndexOf(true);
          hooks.onInfo && hooks.onInfo('Context 80% full — compressing the conversation…');
          let did = false;
          try { did = turn > 0 && await compress({ keepFrom: turn }); } catch (e) { if (e.name === 'AbortError') throw e; hooks.onInfo && hooks.onInfo('Auto-compress failed: ' + e.message); }
          if (contextInfo().pct >= 80) trimToolResults(did ? 2 : turn);
          hooks.onInfo && hooks.onInfo(null);
        }
        let know = '';
        try {
          const k = await Engine.knowledgeDigest();
          if (k) know = `\n\nPROJECT KNOWLEDGE FOLDER: ${k.folder} (${k.files} files)\nFiles:\n${k.index}\n` + (k.included ? `\nIncluded documents:\n${k.included}` : '') + '\n(Use knowledge_search / knowledge_read for anything not included.)';
        } catch (e) { know = '\n\nPROJECT KNOWLEDGE FOLDER: unavailable (' + e.message + ')'; }
        const system = BASE + '\n\n' + MODE[mode] + know + (settings.includeContext ? '\n\n' + designContext() : '');
        systemChars = system.length;
        const sentLen = history.length;
        const r = await callModel(model, system, history.map(({ role, text, toolCalls, results, files }) => ({ role, text, toolCalls, results, files })), tools, controller.signal);
        if (r.usage && r.usage.in > 0) lastIn = { tokens: r.usage.in, len: sentLen };
        const msg = { role: 'assistant', text: r.text, toolCalls: r.toolCalls, model: model.label, mode };
        history.push(msg); persist(); hooks.onAssistant(msg, r.usage);
        if (!r.toolCalls.length) break;
        const results = [];
        for (const tc of r.toolCalls) {
          let content, error = false, image = null;
          try {
            if (tc.input && tc.input.__parse_error) throw new Error('Could not parse tool arguments as JSON');
            const out = await execTool(tc.name, tc.input, mode);
            if (out && typeof out === 'object' && out.__image) { image = out.__image; const rest = Object.assign({}, out); delete rest.__image; content = JSON.stringify(rest); }
            else content = typeof out === 'string' ? out : JSON.stringify(out);
          } catch (e) { content = 'Error: ' + e.message; error = true; }
          results.push(Object.assign({ id: tc.id, name: tc.name, content, error }, image ? { image } : {}));
          hooks.onTool(tc, content, error);
          if (controller.signal.aborted) break;
        }
        for (const tc of r.toolCalls) if (!results.find(x => x.id === tc.id)) results.push({ id: tc.id, name: tc.name, content: 'Cancelled by user', error: true });
        history.push({ role: 'tool', results }); persist();
        if (controller.signal.aborted) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') hooks.onError('Stopped.');
      else hooks.onError(e.message);
    } finally { controller = null; }
  }
  // one plain request (no tools, no chat history) — used for quick structured jobs like AI placement
  async function complete(system, text, opts = {}) {
    const own = new AbortController(), t = setTimeout(() => own.abort(), opts.timeoutMs || 240000);
    if (opts.signal) opts.signal.addEventListener('abort', () => own.abort());
    // JSON mode + a generous output limit (some servers stop at a small default); retried without JSON mode if refused
    const json = opts.json && currentModel().provider !== 'anthropic';
    try {
      try { const r = await callModel(currentModel(), system, [{ role: 'user', text }], [], own.signal, { maxTokens: opts.maxTokens, body: Object.assign({ max_tokens: opts.maxTokens || 8192 }, json ? { response_format: { type: 'json_object' } } : {}) }); return r.text || ''; }
      catch (e) { if (!json || own.signal.aborted) throw e; const r = await callModel(currentModel(), system, [{ role: 'user', text }], [], own.signal, { body: { max_tokens: opts.maxTokens || 8192 } }); return r.text || ''; }
    }
    finally { clearTimeout(t); }
  }
  const stop = () => controller && controller.abort();
  const busy = () => !!controller;
  const reset = () => { history = []; lastIn = null; persist(); };
  // a message from an app feature (e.g. AI place) shown in the chat
  const note = (text, model) => { history.push({ role: 'assistant', text, model: model || currentModel().label, mode: 'agent' }); persist(); };
  const modelReady = () => { const m = currentModel(); if (m.provider === 'none') return false; return m.provider === 'anthropic' ? !!settings.anthropicKey : !!(settings.oaiBase && settings.oaiModels.split(',').map(s => s.trim()).includes(m.id)); };

  const partsApi = Engine.partsApi, loadPart = Engine.loadPart;
  return { MODELS, PRESETS, friendlyError, allModels, fetchModels, partsApi, loadPart, get settings() { return settings; }, saveSettings, run, complete, note, modelReady, currentModel, stop, busy, reset, get history() { return history; }, execTool, TOOLS, contextInfo, probeContext, compress };
})();
