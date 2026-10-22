'use strict';
// Open part libraries in KiCad format: KiCad official, SparkFun, Digi-Key. data/open-parts.txt lists every part that has
// a symbol and a footprint (tools/open_library_index.py); a part's symbol and footprint are downloaded from its
// repository when it is used and become a custom part (key "OL:<source>:<library>:<name>", no LCSC number).
// Works in the browser and in the MCP server (Node 18+: fetch); OpenLib.readIndex can be replaced (e.g. read from disk).
const OpenLib = (() => {
  const SOURCES = {
    kicad: { name: 'KiCad library', licence: 'CC-BY-SA 4.0 (design exception)', home: 'https://gitlab.com/kicad/libraries',
      symbol: (lib, name) => `https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/files/${encodeURIComponent(lib + '.kicad_symdir/' + name + '.kicad_sym')}/raw?ref=master` },
    sparkfun: { name: 'SparkFun library', licence: 'CC-BY 4.0', home: 'https://github.com/sparkfun/SparkFun-KiCad-Libraries',
      symbol: lib => `https://raw.githubusercontent.com/sparkfun/SparkFun-KiCad-Libraries/main/symbols/${encodeURIComponent(lib)}.kicad_sym` },
    digikey: { name: 'Digi-Key library', licence: 'CC-BY-SA 4.0 (design exception)', home: 'https://github.com/Digi-Key/digikey-kicad-library', legacy: true,
      symbol: lib => `https://raw.githubusercontent.com/Digi-Key/digikey-kicad-library/master/digikey-symbols/${encodeURIComponent(lib)}.lib` },
  };
  // footprint "Library:Name" → where it lives
  function footprintUrl(ref) {
    const i = ref.indexOf(':'), lib = ref.slice(0, i), name = ref.slice(i + 1);
    if (/^SparkFun-/i.test(lib)) return { url: `https://raw.githubusercontent.com/sparkfun/SparkFun-KiCad-Libraries/main/footprints/${encodeURIComponent(lib)}.pretty/${encodeURIComponent(name)}.kicad_mod`, name };
    if (/^digikey-footprints$/i.test(lib)) return { url: `https://raw.githubusercontent.com/Digi-Key/digikey-kicad-library/master/digikey-footprints.pretty/${encodeURIComponent(name)}.kicad_mod`, name };
    return { kicad: lib + '.pretty/' + name, name };
  }

  let rows = null, loading = null;
  const api = {
    readIndex: () => fetch('data/open-parts.txt').then(r => { if (!r.ok) throw new Error('Open library list not found (' + r.status + ')'); return r.text(); }),
    index, search, load, isKey: k => /^OL:(kicad|sparkfun|digikey):/.test(String(k || '')), SOURCES,
  };
  function index() {
    if (rows) return Promise.resolve(rows);
    if (!loading) loading = api.readIndex().then(t => (rows = t.split(/\r?\n/).filter(Boolean).map(l => { const [src, lib, name, fp, desc, kw, mpn] = l.split('\t'); return { src, lib, name, fp, desc: desc || '', kw: kw || '', mpn: mpn || '', text: `${name} ${mpn} ${lib} ${desc} ${kw} ${fp}`.toLowerCase() }; })))
      .finally(() => { loading = null; });
    return loading;
  }
  // every word must appear in name / part number / library / description / keywords / footprint; names first
  async function search(q, limit = 20) {
    const list = await index(), words = String(q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!words.length) return [];
    const hits = list.filter(r => words.every(w => r.text.includes(w)));
    const score = r => { const n = (r.name + ' ' + r.mpn).toLowerCase(); return (n.includes(words[0]) ? 0 : 2) + (n.startsWith(words[0]) ? 0 : 1); };
    hits.sort((a, b) => score(a) - score(b) || a.name.length - b.name.length);
    return hits.slice(0, limit).map(r => ({ key: `OL:${r.src}:${r.lib}:${r.name}`, source: r.src, sourceName: SOURCES[r.src].name, library: r.lib, name: r.name, mpn: r.mpn, footprint: r.fp, description: r.desc }));
  }
  const cache = {};
  async function text(url) { if (!cache[url]) cache[url] = fetch(url).then(r => { if (!r.ok) throw new Error('Download failed (' + r.status + '): ' + url); return r.text(); }).catch(e => { delete cache[url]; throw e; }); return cache[url]; }
  // the part as a library definition (like a database part): pins from the symbol, pads from its footprint
  async function load(key) {
    const m = /^OL:(kicad|sparkfun|digikey):([^:]+):(.+)$/.exec(String(key || '')); if (!m) throw new Error('Not an open-library part: ' + key);
    const [, src, lib, name] = m, S = SOURCES[src];
    let sym = S.legacy ? KiCad.parseLegacySymbol(await text(S.symbol(lib, name)), name) : KiCad.parseSymbol(await text(S.symbol(lib, name)), name);
    // derived symbols (extends): pins come from the parent (same library file, or its own file in KiCad's symbol folders)
    if (sym.extends) {
      const parent = KiCad.parseSymbol(await text(S.symbol(lib, sym.extends)), sym.extends);
      sym = { props: Object.assign({}, parent.props, Object.fromEntries(Object.entries(sym.props).filter(([, v]) => v))), pins: parent.pins.length ? parent.pins : sym.pins, extends: null };
    }
    const fpRef = sym.props.Footprint || ((await index()).find(r => r.src === src && r.lib === lib && r.name === name) || {}).fp;
    if (!fpRef || !fpRef.includes(':')) throw new Error(`${name} has no footprint in the ${S.name}`);
    const loc = footprintUrl(fpRef), fp = loc.kicad ? await KiCad.load(loc.kicad) : await KiCad.loadUrl(loc.url, loc.name);
    let pins = sym.pins.slice();
    // pins the footprint has but the symbol does not (e.g. exposed pad) get a pin, so every pad can be connected
    const have = new Set(pins.map(p => p.num));
    for (const p of fp.pads) if (p.num && !have.has(p.num)) { have.add(p.num); pins.push({ num: p.num, name: p.num, side: 'B' }); }
    if (!pins.length) throw new Error(`${name}: the symbol has no pins`);
    const ref = String(sym.props.Reference || 'U').replace(/[^A-Za-z]/g, '') || 'U', value = sym.props.Value || name;
    return {
      key, name, value, prefix: ref, pins: pins.map(({ num, name, side }) => ({ num, name, side })),
      footprint: { name: fp.name, pads: fp.pads, body: fp.body }, custom: true, lcsc: '',
      mfr_part: sym.props.MPN || sym.props['Manufacturer Part Number'] || sym.props.PROD_ID || ((await index()).find(r => r.src === src && r.lib === lib && r.name === name) || {}).mpn || '',
      manufacturer: sym.props.Manufacturer || '', datasheet: /^https?:/.test(sym.props.Datasheet || '') ? sym.props.Datasheet : '',
      description: sym.props.Description || sym.props.ki_description || '',
      source: `${S.name} (${S.licence}): ${lib}:${name} · footprint ${fpRef}`,
    };
  }
  // ---------- backup for the EasyEDA library ----------
  // When the EasyEDA library cannot give a part's symbol / footprint, build the part from open libraries instead:
  //  1. the same part number in the KiCad / SparkFun / Digi-Key libraries → its symbol (real pin names) and footprint
  //  2. otherwise a standard KiCad footprint for the package (0603, SOT-23, SOIC-8, QFN-32 5x5 …), pins numbered 1…n
  // The LCSC number is kept (BOM / assembly still work); the source says what was used, so the user checks it.
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  async function byPartNumber(mpn) {
    const n = norm(mpn); if (n.length < 3) return null;
    const hits = (await search(mpn, 40)).filter(r => norm(r.name) === n || norm(r.mpn) === n);
    return hits.sort((a, b) => (a.source === 'kicad' ? 0 : 1) - (b.source === 'kicad' ? 0 : 1))[0] || null;
  }
  // package text (LCSC / JLCPCB style) → KiCad footprint path "Library.pretty/Name"
  async function byPackage(pkg, category) {
    const P = String(pkg || '').toUpperCase().replace(/\s+/g, ''), cat = String(category || '').toLowerCase();
    let m;
    const chip = (m = /^(0201|0402|0603|0805|1206|1210|2010|2512)\b/.exec(P)) && m[1];
    if (chip) {
      const metric = { '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225', '2010': '5025', '2512': '6332' }[chip];
      const kind = /capacit/.test(cat) ? ['Capacitor_SMD', 'C'] : /led|light|diode.*emit/.test(cat) ? ['LED_SMD', 'LED'] : /induct|ferrite|bead/.test(cat) ? ['Inductor_SMD', 'L'] : /diode/.test(cat) ? ['Diode_SMD', 'D'] : ['Resistor_SMD', 'R'];
      return `${kind[0]}.pretty/${kind[1]}_${chip}_${metric}Metric`;
    }
    const list = await KiCad.index(), has = n => list.find(x => x === n);
    const fixed = { 'SOT-23': 'Package_TO_SOT_SMD.pretty/SOT-23', 'SOT-23-3': 'Package_TO_SOT_SMD.pretty/SOT-23', 'SOT-23-5': 'Package_TO_SOT_SMD.pretty/SOT-23-5', 'SOT-23-6': 'Package_TO_SOT_SMD.pretty/SOT-23-6',
      'SOT-223': 'Package_TO_SOT_SMD.pretty/SOT-223-3_TabPin2', 'SOT-89': 'Package_TO_SOT_SMD.pretty/SOT-89-3', 'SOT-89-3': 'Package_TO_SOT_SMD.pretty/SOT-89-3', 'SOD-123': 'Diode_SMD.pretty/D_SOD-123', 'SOD-323': 'Diode_SMD.pretty/D_SOD-323',
      'SMA': 'Diode_SMD.pretty/D_SMA', 'SMB': 'Diode_SMD.pretty/D_SMB', 'SMC': 'Diode_SMD.pretty/D_SMC', 'TO-252': 'Package_TO_SOT_SMD.pretty/TO-252-2', 'TO-263': 'Package_TO_SOT_SMD.pretty/TO-263-2', 'SOT-323': 'Package_TO_SOT_SMD.pretty/SOT-323_SC-70', 'SOT-363': 'Package_TO_SOT_SMD.pretty/SOT-363_SC-70-6' };
    const base = P.replace(/\(.*$/, '');
    if (fixed[base] && has(fixed[base])) return fixed[base];
    // SOIC / SOP / TSSOP / MSOP / QFN / LQFP / TQFP / DFN with pin count (and body size in brackets)
    if ((m = /^(SOIC|SOP|TSSOP|MSOP|SSOP|QFN|DFN|LQFP|TQFP|QFP)-?(\d+)/.exec(P))) {
      const fam = m[1] === 'SOP' ? 'SOIC' : m[1] === 'QFP' ? 'LQFP' : m[1], n = m[2], size = (/\((\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)\)/.exec(P) || []).slice(1).map(Number);
      const cands = list.filter(x => new RegExp(`/${fam}-${n}(-1EP)?_`).test(x));
      const bySize = size.length ? cands.filter(x => { const s = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/.exec(x); return s && Math.abs(+s[1] - size[0]) < 0.3 && Math.abs(+s[2] - size[1]) < 0.3; }) : cands;
      const pick = (bySize.length ? bySize : cands).sort((a, b) => a.length - b.length)[0];
      if (pick) return pick;
    }
    return null;
  }
  async function fallbackPart(code, info) {
    info = info || {};
    const hit = info.mfr_part && await byPartNumber(info.mfr_part).catch(() => null);
    if (hit) {
      const m = await load(hit.key);
      return Object.assign(m, { key: code, lcsc: code, custom: false, mfr_part: info.mfr_part, manufacturer: info.brand || m.manufacturer, datasheet: info.datasheet || m.datasheet,
        source: `EasyEDA library unavailable — symbol and footprint from the ${SOURCES[hit.source].name} (${hit.library}:${hit.name}); check the footprint`, fallback: true });
    }
    const path = await byPackage(info.package, info.category);
    if (!path) throw new Error(`The EasyEDA library is not reachable and no open-library footprint matches ${code} (${info.mfr_part || '?'}, package ${info.package || '?'})`);
    const fp = await KiCad.load(path), nums = [...new Set(fp.pads.map(p => p.num).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const half = Math.ceil(nums.length / 2), prefix = /resistor/i.test(info.category) ? 'R' : /capacit/i.test(info.category) ? 'C' : /induct/i.test(info.category) ? 'L' : /led|diode/i.test(info.category) ? 'D' : 'U';
    return { key: code, lcsc: code, custom: false, name: info.mfr_part || code, value: info.mfr_part || code, prefix, mfr_part: info.mfr_part || '', manufacturer: info.brand || '', datasheet: info.datasheet || '',
      pins: nums.map((n, i) => ({ num: n, name: n, side: i < half ? 'L' : 'R' })), footprint: { name: fp.name, pads: fp.pads, body: fp.body },
      source: `EasyEDA library unavailable — KiCad footprint ${path.replace('.pretty/', ':')} for package ${info.package}; pins are numbered only: check the datasheet`, fallback: true };
  }
  api.fallbackPart = fallbackPart;
  return api;
})();
if (typeof module !== 'undefined') module.exports = OpenLib;
