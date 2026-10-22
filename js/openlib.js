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
  return api;
})();
if (typeof module !== 'undefined') module.exports = OpenLib;
