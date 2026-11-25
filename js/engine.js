'use strict';
// Design tool engine shared by the in-app AI copilot, the MCP server (Claude Code) and the REST API.
// Runs in the browser and in Node (see mcp/circuitpilot-mcp.mjs). UI side effects go through Engine.env hooks.
const Engine = (() => {
  const env = {
    base: '',                  // API base URL ('' = same origin)
    headers: {},               // e.g. { authorization: 'Bearer <password>' } for external clients
    fetch: (...a) => fetch(...a),
    myLib: () => [],           // user's saved parts
    savePart: async () => { }, // persist a part to My Library
    ui: () => { },             // ui('fit-sch') | ui('show-pcb')
    searchKey: null,           // optional Brave Search API key (else DuckDuckGo)
    route: null,               // optional async router (browser: Web Worker): ({ place, opt }) => { placement, routing }
    shape: null,               // optional async 3D-script runner (browser: Web Worker): code => Shape3D.run result
  };

  async function api(path, opts = {}) {
    const r = await env.fetch(env.base + path, Object.assign({}, opts, { headers: Object.assign({}, env.headers, opts.headers || {}) }));
    const j = await r.json().catch(() => ({ error: `Server returned ${r.status} — is server.py running?` }));
    if (!r.ok || (j && j.error && !j.results)) throw new Error((j && j.error) || r.statusText);
    return j;
  }
  const partsApi = (path, opts) => api('/api/parts/' + path, opts);

  // ---------- tool definitions ----------
  const types = Lib.types();
  const pinList = { type: 'array', items: { type: 'string' }, description: 'Pin references "REF.PIN" — PIN is a pin number or pin name, e.g. "R1.1", "Q1.B", "U1.VCC"' };
  const pinDefs = { type: 'array', items: { type: 'object', required: ['num', 'name'], properties: { num: { type: 'string' }, name: { type: 'string' }, side: { type: 'string', enum: ['L', 'R', 'T', 'B'], description: 'Symbol side (default alternates L/R)' } } } };
  const fpSpec = { description: 'Footprint: a generator name (' + Lib.FOOTPRINT_PATTERNS.join(', ') + ') or {"pads":[{"num","x","y","w","h","shape":"rect|round|oval","drill"?}]} in mm, centred on the part.', anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, pads: { type: 'array', items: { type: 'object' } } } }] };
  const addExample = '{"components":[{"ref":"U1","lcsc":"LIB_EXAMPLE"},{"ref":"R1","type":"resistor","value":"10k"}]}';
  const TOOLS = [
    { name: 'search_parts', ro: true, description: 'Search real components by part number or keywords, e.g. "ESP32-C3", "AMS1117 3.3", "USB-C 16pin", "10k 0603". Searches the JLCPCB catalogue (stock, price, Basic/Extended), the EasyEDA official library (about 1.6 million LCSC parts incl. modules), the EasyEDA community library (user-made parts, keys EE-…), the open KiCad-format libraries — KiCad official, SparkFun, Digi-Key (keys OL:…; custom parts without LCSC number, check the footprint) — and My Library at once; only parts that have a footprint are returned. Returns LCSC codes (Cxxxx) / library keys. Prefer in-stock JLCPCB parts and Basic parts; source "easyeda" parts have no stock data (C99… codes are library placeholders, not orderable).', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 10, max 30' } } } },
    { name: 'get_part', ro: true, description: 'Load an exact part. Returns its pins, a footprint label, and add_components_input ready to send to add_components.', input_schema: { type: 'object', required: ['lcsc'], properties: { key: { type: 'string', description: 'a My Library part key instead of an LCSC code' },  lcsc: { type: 'string', description: 'LCSC code (e.g. C2838502) or library key (LIB_...)' } } } },
    { name: 'get_design', ro: true, description: 'Return the full current design: every component (type, value, position, footprint, pins as num:name=net) and all nets.', input_schema: { type: 'object', properties: {} } },
    { name: 'list_parts', ro: true, description: 'List the built-in component types with their pins (number:name), default value and footprints.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'add_components', description: 'Add parts. Example: ' + addExample + ' Replace LIB_EXAMPLE with the key from get_part. For an lcsc entry omit type and footprint.',
      input_schema: {
        type: 'object', required: ['components'], properties: {
          components: {
            type: 'array', items: {
              type: 'object', properties: {
                type: { type: 'string', enum: types, description: 'Built-in type (use "connector" for headers). Omit only when using lcsc.' },
                lcsc: { type: 'string', description: 'Exact key from get_part or create_part. Example: "LIB_EXAMPLE". Omit footprint.' },
                ref: { type: 'string', description: 'Optional reference designator, e.g. R1. Auto-assigned if omitted.' },
                value: { type: 'string', description: 'Part value or part number, e.g. 10k, 100n, NE555' },
                x: { type: 'number', description: 'Schematic X (grid 10). Typical spacing between parts 80-160.' },
                y: { type: 'number', description: 'Schematic Y (down is positive).' },
                rot: { type: 'number', enum: [0, 90, 180, 270] },
                sheet: { type: 'number', description: 'schematic sheet number (1 = first sheet; see add_sheet)' },
                pins: { type: 'array', items: { type: 'string' }, description: 'ONLY for type "ic" or "connector": pin names in pin-number order (index 0 = pin 1).' },
                footprint: { type: 'string', description: 'Built-in footprint only (e.g. 0603). Omit when using lcsc. Names: ' + Lib.FOOTPRINT_PATTERNS.join(', ') }
              }
            }
          }
        }
      }
    },
    { name: 'update_component', description: 'Change a component in the SCHEMATIC: value, schematic position/rotation, footprint, pins (ic/connector) or rename it. For PCB placement use place_footprint.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, value: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, footprint: { type: 'string' }, pins: { type: 'array', items: { type: 'string' } }, new_ref: { type: 'string' }, lcsc_part: { type: 'string', description: 'LCSC / JLCPCB part number for the assembly BOM, e.g. C25804 ("" clears it)' } } } },
    { name: 'remove_components', description: 'Delete components (and their connections).', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'connect', description: 'Create connections. Each entry puts the listed pins on the named net (created if needed). If a pin is already on another net, that net is merged in. Name ground "GND" and supply rails like "VCC", "+5V", "+3V3", "+12V", "VBAT" — these are drawn as power symbols.', input_schema: { type: 'object', required: ['connections'], properties: { connections: { type: 'array', items: { type: 'object', required: ['net', 'pins'], properties: { net: { type: 'string' }, pins: pinList } } } } } },
    { name: 'disconnect', description: 'Remove pins from whatever net they are on.', input_schema: { type: 'object', required: ['pins'], properties: { pins: pinList } } },
    { name: 'rename_net', description: 'Rename a net (merges if the new name exists).', input_schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'add_sheet', description: 'Add a schematic sheet (multi-page schematic), e.g. Power, MCU, Sensors, Connectors. Returns its number. Nets connect across sheets by name (shown as net labels).', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'move_to_sheet', description: 'Move components to a schematic sheet (1 = first). The sheet is re-arranged and spaced automatically.', input_schema: { type: 'object', required: ['refs', 'sheet'], properties: { refs: { type: 'array', items: { type: 'string' } }, sheet: { type: 'number' } } } },
    { name: 'auto_layout', description: 'Automatically arrange all schematic components based on connectivity.', input_schema: { type: 'object', properties: {} } },
    { name: 'organize_schematic', description: 'Make the schematic readable (the ✨ Organize button): ICs / modules in a row, every small part (R, C, L, LED, transistor) next to the IC pin it is wired to, chains continuing outward; parts on GND vertical with GND at the bottom, parts on a supply (3V3, VDD …) vertical with the supply on top, series parts horizontal; wires are routed around the symbols without running over each other. Prefer it over auto_layout. Use view_design {view: "schematic"} to check.', input_schema: { type: 'object', properties: {} } },
    { name: 'run_erc', ro: true, description: 'Run the electrical rule check: unconnected pins, single-pin nets, missing ground, overlapping symbols.', input_schema: { type: 'object', properties: {} } },
    { name: 'clear_design', description: 'Delete everything in the current project and start an empty design.', input_schema: { type: 'object', properties: {} } },
    { name: 'generate_pcb', description: 'Create the PCB: place all footprints on a board (based on schematic positions) and autoroute with a 2-layer router. Returns routing statistics. keep_placement: true keeps the parts where they already are (only new parts are placed) and just routes — much faster on a custom outline.', input_schema: { type: 'object', properties: { start_over: { type: 'boolean', description: 'throw away the current placement and tracks and make a new board (without it, a board that is already placed is updated from the schematic instead)' }, keep_placement: { type: 'boolean' },  board_width: { type: 'number', description: 'mm, optional (auto-sized if omitted)' }, board_height: { type: 'number', description: 'mm, optional' }, auto_size: { type: 'boolean', description: 'size the board to the parts; by default an existing board outline is kept and parts are fitted inside it' }, route: { type: 'boolean', description: 'default true' }, time_limit_s: { type: 'number', description: 'autorouter effort in seconds (default 90)' } } } },
    { name: 'web_search', ro: true, web: true, description: 'Search the internet (datasheets, application notes, reference designs, prices, availability, how-tos, anything else you need). Returns titles, URLs and snippets; read pages with web_fetch.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max_results: { type: 'number', description: 'default 8, max 20' } } } },
    { name: 'web_fetch', ro: true, web: true, description: 'Read a web page or PDF (e.g. a datasheet) as text. Long documents are paged: call again with offset = previous offset + returned length while "more" is true.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, offset: { type: 'number' }, max_chars: { type: 'number', description: 'default 12000, max 40000' } } } },
    { name: 'use_database_parts', description: 'Give built-in schematic symbols (resistor, LED, transistor, regulator, ...) the footprint and pinout of a real JLCPCB part (Basic parts where possible). Without refs: every built-in part that still uses a generated footprint.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'match_jlcpcb_parts', description: 'Find JLCPCB/LCSC part numbers for every component value (e.g. 4.7k 0603, 22uF 0805) for an assembly BOM; prefers in-stock Basic parts with the same package.', input_schema: { type: 'object', properties: { overwrite: { type: 'boolean' } } } },
    { name: 'get_enclosure', ro: true, description: 'The 3D-printable enclosure fitted to the PCB: outer size, heights, standoffs, every cutout (automatic ones for edge connectors / LEDs / buttons and custom ones), estimated part heights, the battery and all parameters. Custom 3D mode: the build result with the fit and manufacturability reports, and the script (script: false leaves it out).', input_schema: { type: 'object', properties: { script: { type: 'boolean', description: 'custom mode: include the script text (default true)' } } } },
    { name: 'jlc3dp_quote', ro: true, description: 'Before ordering 3D-printed enclosure parts at JLC3DP: what their site will say about each printed part, checked with the limits of the MATERIAL you will pick there (resin warns under 0.8 mm, MJF nylon under 1.2 mm and refuses under 1.0 mm …) — size against the process minimum (MJF / SLS 2 × 2 × 10 mm) and maximum, thin walls and edge lips (where, and the setting that fixes it) in JLC\'s own wording, knife edges, volume, and whether it will go to a manual quote. CircuitPilot\'s JLC API access covers PCBs only, so the price comes from the JLC3DP website (upload the STLs from export_enclosure).', input_schema: { type: 'object', properties: { material: { type: 'string', enum: ['pa12', 'pa11', 'sls-nylon', 'resin-9600', 'ledo-6060', 'black-resin', 'tpu', 'pla'], description: 'the material you will choose on JLC3DP (default: from the print process)' }, process: { type: 'string', enum: ['mjf', 'sls', 'sla', 'fdm'] } } } },
    { name: 'jlccnc_quote', ro: true, description: 'Before ordering sheet-metal parts (electrode plates…) at JLCCNC: per part and for the joined part (all plates on 5 mm bars, the one to order) — the outline size, DXF entities (true arcs / circles), STEP size, the narrowest material web (JLCCNC needs ≥ 5 mm: bridges, tabs, strips), the narrowest slot / hole against the sheet thickness, tiny segments and open contours; "automatic quote expected" only when all pass, else "manual review likely" with the reasons. Order settings: stainless 304 (the site starts on aluminium 5052), finish (none under 1 mm: JLCCNC brushes 1.0 mm and up). Price: on the JLCCNC website (upload STEP + DXF from export_enclosure).', input_schema: { type: 'object', properties: { thickness: { type: 'number', description: 'sheet mm (default: the parts\' own)' } } } },
    { name: 'export_cnc_gcode', description: 'G-code to mill this PCB on a desktop CNC with GRBL (CNC 3018 Pro and similar): 1_isolation.nc (V-bit rings around the copper; pours, clearances and keep-outs as in the Gerbers), 2_drill_<size>.nc (one file per bit), 3_cutout.nc (holes bigger than the end mill, then the outline in steps with holding tabs), preview.svg (toolpaths), result-2d.svg and result-3d.html (the finished board as milled, flat and in 3D) and a README with the bit order and set-up. One copper side only (route with set_design_rules {preset: "cnc3018"}); X0 Y0 = lower-left corner of the PCB, Z0 = copper surface. Checks its own toolpaths: no shorts with a narrower groove (shallow spots), no net cut in two with a wider one (worn bit); warns about vias (they need wire links). In the app the files download as a zip.', input_schema: { type: 'object', properties: { iso_dia: { type: 'number', description: 'groove width at the cut depth, mm (default: from the V-bit, tip + 2 x depth x tan(angle / 2) = 0.207 for 30 deg / 0.1 mm at 0.2 mm)' }, iso_depth: { type: 'number', description: 'isolation depth, mm (default 0.2: cuts through the copper even where the board is ~0.15 mm low)' }, vbit_angle: { type: 'number', description: 'V-bit angle, deg (default 30)' }, vbit_tip: { type: 'number', description: 'V-bit tip width, mm (default 0.1)' }, iso_passes: { type: 'number', description: 'rings around the copper (default 2)' }, iso_overlap: { type: 'number', description: 'overlap between rings, 0-0.9 (default 0.3)' }, iso_feed: { type: 'number', description: 'mm/min (default 120)' }, plunge_feed: { type: 'number', description: 'mm/min (default 60)' }, drill_feed: { type: 'number', description: 'mm/min (default 40)' }, cut_dia: { type: 'number', description: 'end mill for the outline, mm (default 2); holes of this size + 0.1 and bigger are milled with it instead of drilled' }, cut_step: { type: 'number', description: 'depth per outline pass, mm (default 0.3)' }, cut_feed: { type: 'number', description: 'mm/min (default 100)' }, tabs: { type: 'number', description: 'holding tabs on the outline (default 4, 0 = none)' }, tab_width: { type: 'number', description: 'mm (default 2)' }, tab_height: { type: 'number', description: 'mm (default 0.5)' }, spindle: { type: 'number', description: 'S value (default 1000 = full speed with GRBL $30=1000)' }, board_thick: { type: 'number', description: 'copper board thickness, mm (default the design thickness, 1.6)' }, parts_side: { type: 'string', enum: ['auto', 'bare', 'copper'], description: 'Where the parts go — ask the user if it is not known. bare: through-hole parts go in from the side without copper and are soldered on the copper (the usual way; the board is milled MIRRORED so the pins match), 2-pad SMD parts are soldered on the copper side. copper: all parts sit on the copper side (SMD boards; not mirrored). auto (default): picked from the parts — bare when there are through-hole parts and the SMD parts are 2-pad, copper when an SMD IC is on the copper' }, mirror: { type: 'string', enum: ['auto', 'on', 'off'], description: 'the same choice as parts_side (on = bare, off = copper); parts_side wins' }, origin: { type: 'string', enum: ['board', 'job'], description: 'board (default): X0 Y0 = lower-left corner of the PCB (the cutout reaches cut_dia mm left of / below it); job: X0 Y0 = lower-left corner of the whole job, every move at X, Y >= 0' }, drill_bits: { type: 'array', items: { type: 'number' }, description: 'drill bits the user has, mm (default [0.8, 1.0]); each hole gets the smallest bit that fits, holes bigger than every bit are drilled and widened in a small circle' }, pad_relief: { type: 'string', enum: ['auto', 'on', 'off'], description: 'SMD pads on the GND pour: on = a milled gap all round with 4 spokes, so each pad is its own solder spot; off = plain pour; auto (default) = the design rule smdPadRelief (on in the cnc3018 preset)' }, layer: { type: 'string', enum: ['F', 'B'], description: 'copper side to mill (default: the side with the tracks)' } } } },
    { name: 'export_electrodes', description: 'The electrode() plates as gold (ENIG) PCB electrodes for JLCPCB (as: "pcb", default): one 0.6 mm 2-layer board with all plates joined by mouse-bite tabs — gold copper over the whole skin side (mask open, vias tented), a solder pad on the back over each pod wire hole, true-arc outline — Gerbers + drill files + an order README (ENIG 2U", Remove Mark, Single PCB) + an assembly guide picture. as: "sheet" gives the stainless sheet-metal set instead (joined part on 5 mm bars + snip guide). projects: more project ids to merge their plates into the same board / part (e.g. wrist + chest).', input_schema: { type: 'object', properties: { as: { type: 'string', enum: ['pcb', 'sheet'] }, projects: { type: 'array', items: { type: 'string' }, description: 'other projects whose plates join this order' }, thickness: { type: 'number', description: 'PCB mm (default 0.6) / sheet mm' }, out_dir: { type: 'string', description: 'folder to write into (MCP; default Documents/CircuitPilot exports/<project>-electrodes)' } } } },
    { name: 'check_enclosure', ro: true, description: 'Manufacturability check of the enclosure for a 3D-printing process (like the print service heatmap): walls thinner than the process minimum (MJF / SLS 1.0 mm, SLA 0.8, FDM 1.2), knife edges (faces meeting below 30°), slits that fuse shut, lid ↔ base clearance against the process tolerance, and openings in the case that no connector / window explains (wall breaches). Each finding has its position. Returns a heatmap picture. Every build already runs a lighter version of this check.', input_schema: { type: 'object', properties: { process: { type: 'string', enum: ['mjf', 'sls', 'sla', 'fdm'], description: 'default: the enclosure process setting (mjf)' }, preview: { type: 'boolean', description: 'default true: the result includes a picture of the finished enclosure (4 views: angled, exploded, cut in half, from below). false = no picture (saves context)' } } } },
    { name: 'list_batteries', ro: true, description: 'Batteries that can go loose in the enclosure (wired to the board), to choose one for the user: rechargeable LIR coin cells (LIR1220 … LIR2477), primary CR coins, LiPo pouches (301020 … 103450, with protection board) and cylindrical Li-ion (10440 … 21700) — or name any LiPo code (lipo-302020) or a custom size {t, w, l, mAh} in battery params with size, capacity, voltage, max current and — given avg_mA — the runtime. Filter by what the design allows (thickness, size) and needs (capacity, peak current). Then put it in the enclosure: set_enclosure {battery, batteryPlace} (box) or set_enclosure_script {template, params: {battery, batteryPlace}} (custom). Rechargeable cells need a Li-ion charger on the PCB (e.g. TP4054 / MCP73831).', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['coin', 'lipo', 'cyl'] }, rechargeable: { type: 'boolean' }, min_mAh: { type: 'number' }, max_thickness: { type: 'number', description: 'mm' }, max_width: { type: 'number', description: 'mm' }, max_length: { type: 'number', description: 'mm' }, avg_mA: { type: 'number', description: 'average current of the design → runtime_h' }, peak_mA: { type: 'number', description: 'peak current the cell must deliver (radio TX …)' }, charge_mA: { type: 'number', description: 'the charger current (XIAO nRF52840: 50 mA, TP4054 per PROG resistor) → charge_C per cell; above 1 C for LiPo / 0.5 C for LIR is flagged' }, notes: { type: 'boolean', description: 'include charging / safety notes' } } } },
    { name: 'set_enclosure', description: 'Change enclosure parameters (mm). process: mjf | sls | sla | fdm (the manufacturability check limits). mode: "box" (this parametric box) or "custom" (the free-form 3D script, see set_enclosure_script). Box parameters: wall, floor, lidThickness, clearance, pcbThickness, topClearance, extraHeight, standoffHeight, standoffDiameter, screwHole, lidFit, lipHeight, lipWidth, vents, ventWidth, ventLength, ventSpacing, autoConnectorCutouts, autoLidHoles, partHeights ({ref: mm}), battery (a loose cell in the box: id from list_batteries, "" = none) and batteryPlace (under the board | beside it | above the parts). Opens the Enclosure tab and returns a picture of the result.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['box', 'custom'] }, wall: { type: 'number' }, floor: { type: 'number' }, lidThickness: { type: 'number' }, clearance: { type: 'number' }, pcbThickness: { type: 'number' }, topClearance: { type: 'number' }, extraHeight: { type: 'number' }, standoffHeight: { type: 'number' }, standoffDiameter: { type: 'number' }, screwHole: { type: 'number' }, lidFit: { type: 'number' }, lipHeight: { type: 'number' }, lipWidth: { type: 'number' }, vents: { type: 'boolean' }, ventWidth: { type: 'number' }, ventLength: { type: 'number' }, ventSpacing: { type: 'number' }, autoConnectorCutouts: { type: 'boolean' }, autoLidHoles: { type: 'boolean' }, partHeights: { type: 'object', additionalProperties: { type: 'number' } }, battery: { description: 'battery id from list_batteries (lipo-502030, lir2032, 18650 …), any LiPo code (lipo-302020), or your own cell {t, w, l, mAh}; "" removes it' }, batteryPlace: { type: 'string', enum: ['under', 'beside', 'above'] }, process: { type: 'string', enum: ['mjf', 'sls', 'sla', 'fdm'] }, rules: { type: 'object', description: 'the project manufacturing rules the enclosure tools apply by default and the checks enforce (never looser than the process): minWall, fit, minRidge (engraving), minPart [a, b, c] (smallest part box). null removes one' }, partBodies: { type: 'object', description: '{ref: {body: {w, l, h}, connectors: [{type, side, w, h, z, out}]}} — real body / connector data for parts of this project (overrides the library)' }, shapes: { type: 'array', items: { type: 'object' }, description: 'Design shapes (custom mode, what the user places by hand in the Design editor — Tinkercad style), applied on top of the script: [{type: box | roundbox | cylinder | cone | sphere | hemisphere | torus | tube | wedge | pyramid | prism | stadium | text | slots | honeycomb | group, name, pos: [x, y, z] (centre, script coordinates), size: [x, y, z], rot: [ax, ay, az] (deg), hole: true = cuts, target: "new" (own part, solids default) | "all" (every printed part, holes default) | part name, r, sides, top, wall, text, n, cell, mirror: [0|1 ×3], array: {n: [nx, ny, nz], step: [dx, dy, dz]}, children: [...] (group, positions relative to its centre)}]. Replaces the whole list; get_enclosure returns it.' }, preview: { type: 'boolean', description: 'default true: the result includes a picture of the finished enclosure (4 views: angled, exploded, cut in half, from below). false = no picture (saves context)' } } } },
    { name: 'add_enclosure_cutout', description: 'Add an opening to the enclosure. side = left | right | front | back (walls; u = mm along the wall from its centre, z = mm above the bed, default 4 mm above the PCB) or lid | floor (x, y in enclosure coordinates = board x, minus board y). shape rect or circle.', input_schema: { type: 'object', required: ['side', 'width'], properties: { side: { type: 'string', enum: ['left', 'right', 'front', 'back', 'lid', 'floor'] }, shape: { type: 'string', enum: ['rect', 'circle'] }, width: { type: 'number' }, height: { type: 'number' }, u: { type: 'number' }, z: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } } } },
    { name: 'remove_enclosure_cutout', description: 'Remove a custom enclosure cutout by index (see get_enclosure), or all custom cutouts when index is omitted.', input_schema: { type: 'object', properties: { index: { type: 'number' } } } },
    { name: 'enclosure_script_help', ro: true, description: 'Docs for custom 3D enclosures: the 3D script API (primitives, booleans, hull, extrude / revolve, bend, smooth, text, honeycomb, screw bosses, measure) and the enclosure kit (envelope with batteries, outlines, soft solids, wrist curve, strap lugs, electrodes, clips, loops, lid with lip…), coordinates relative to the PCB, the PCB context, the 35 tested templates (10 wrist, 10 chest/ECG, 7 other body-worn, 8 boxes) and their parameters. Usually not needed: set_enclosure_script {template, params} builds a template without code. Pass template: <id> to get that script to edit.', input_schema: { type: 'object', properties: { example: { type: 'string' },  template: { type: 'string', description: 'template id from the catalogue, e.g. wrist-whoop, chest-ecg3' } } } },
    { name: 'set_enclosure_script', description: 'Design a free-form 3D-printable enclosure / housing / wearable (wristband pod, chest patch, clip, curved or organic case …). FAST WAY: {template, params}; SMALL CHANGES: {patch: [{find, replace}]} or {vars: {name: value}} edit the saved script in place (no need to resend it) — a tested template sized from the board, with changes (shape, wall, curve, strap, electrodes, battery, label …), no code. Or {code}: a JavaScript 3D script (see enclosure_script_help). Saves it in the project, switches the Enclosure tab to custom mode, builds it (about 1 s) and returns each part (size, volume, watertightness), a fit report — collisions of the printed parts with the PCB, components or battery (fix all of them) and script errors with line numbers — and a picture of the result. Exports: one STL per part + OpenSCAD source.', input_schema: { type: 'object', properties: { template: { type: 'string', description: 'template id (enclosure_script_help lists them), e.g. wrist-whoop, chest-ecg3, box-rounded, body-pendant' }, params: { type: 'object', description: 'template changes: shape (rect|oval|circle|pill|hex|octagon|squircle), wall, r, rTop, rBot, curve (underside radius, 0 = flat), axis (x|y), lugs (slot|pins|bar|none), strap, electrodes (none|3lead|2bar|5lead|4square|tri), studsTop, minW, minL, flange, clip, loop, ears, vents, headroom, margin, lipH, battery (id from list_batteries), batteryPlace (under|above|beside), label (engraved text), labelSize, res, c1, c2' }, code: { type: 'string', description: 'the full 3D script (instead of template)' }, patch: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } } }, description: 'exact-text replacements in the saved script' }, vars: { type: 'object', description: 'new values for const / let declarations, e.g. {fit: 0.3, t: 2.2}' }, preview: { type: 'boolean', description: 'default true: the result includes a picture of the finished enclosure (4 views: angled, exploded, cut in half, from below). false = no picture (saves context)' } } } },
    { name: 'add_mounting_holes', description: 'Add non-plated mounting holes to the PCB (default 4 × M3 Ø3.2 mm at the corners, nudged clear of parts) — the enclosure then gets screw standoffs. Re-run route_pcb afterwards.', input_schema: { type: 'object', properties: { diameter: { type: 'number' }, inset: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'explicit [[x,y],...] in board mm' } } } },
    { name: 'set_silk_label', description: 'Change the silkscreen label of a part (default: its reference, placed automatically next to the part where it covers no pad, part or other label), or of the board name (ref "board"). Give x / y (label centre, board mm) to place it by hand — it then moves with the part; auto:true puts it back to automatic placement. Labels must not cover pads: check covers_pads in get_pcb_layout.silk_labels or run_drc.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', description: 'part reference, or "board" for the board name' }, text: { type: 'string', description: 'label text (empty = the reference / project name)' }, size: { type: 'number', description: 'text height in mm (default 1.0; 1 mm is the smallest JLCPCB prints clearly)' }, hidden: { type: 'boolean' }, rotation: { type: 'number', description: 'degrees counter-clockwise' }, x: { type: 'number' }, y: { type: 'number' }, auto: { type: 'boolean' } } } },
    { name: 'batch', description: 'Run many quick edits in one call, in order: calls [{tool, args}] — e.g. update_component / place_footprint / set_silk_label / connect for 20 parts. Stops at the first error unless continue_on_error. Routing tools are allowed (the batch then runs as a background job); export_project, reroute and batch itself are not.', input_schema: { type: 'object', required: ['calls'], properties: { calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } }, continue_on_error: { type: 'boolean' } } } },
    { name: 'arrange_silk_labels', description: 'Tidy the silkscreen reference labels: every label (or refs) goes back to automatic placement next to its part, off pads, parts and other labels; labels that still cover pads are made smaller (down to min_size, default 0.8 mm) and, with hide: true, hidden when there is no room.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, hide: { type: 'boolean' }, min_size: { type: 'number' }, unhide: { type: 'boolean', description: 'show hidden labels again first' } } } },
    { name: 'add_pcb_text', description: 'Add free text to the PCB silkscreen (e.g. version, author, "5V IN", pin names next to a header, polarity marks). Drawn as strokes in the Gerber silkscreen and the 3D view; bottom-side text is mirrored. Keep it off pads.', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, x: { type: 'number', description: 'centre, board mm (default: board centre)' }, y: { type: 'number' }, size: { type: 'number', description: 'height in mm, default 1.2' }, rotation: { type: 'number', description: 'degrees counter-clockwise, e.g. 90 for vertical text' }, side: { type: 'string', enum: ['top', 'bottom'] } } } },
    { name: 'update_pcb_text', description: 'Change or move a free PCB text (index from get_pcb_layout.silk_labels / add_pcb_text).', input_schema: { type: 'object', required: ['index'], properties: { index: { type: 'number' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, rotation: { type: 'number' }, side: { type: 'string', enum: ['top', 'bottom'] } } } },
    { name: 'remove_pcb_text', description: 'Delete a free PCB text by index.', input_schema: { type: 'object', required: ['index'], properties: { index: { type: 'number' } } } },
    { name: 'export_project', ro: true, description: 'Export every file of the current project in one step (PCB, enclosure, flat parts, order README): project file (.circuit.json), Gerbers + drill, JLCPCB BOM + pick-and-place (CPL), BOM, netlist, enclosure STL / OpenSCAD, EasyEDA schematic + PCB, PCB drawing PDF, datasheet PDF and images (schematic sheets, 2D PCB, 3D top / bottom / angled, enclosure). In the app: one zip download. From Claude Desktop / Claude Code: written into a folder per project (out_dir). Use include to pick only some.', input_schema: { type: 'object', properties: { out_dir: { type: 'string', description: 'Claude Desktop / Code only: folder for the project folder (default: Documents/CircuitPilot exports)' }, include: { type: 'array', items: { type: 'string', enum: ['project', 'gerbers', 'jlcpcb', 'bom', 'netlist', 'enclosure', 'flat', 'order_readme', 'easyeda', 'pdf', 'images', 'firmware'] }, description: 'default: everything. firmware = design_pins.h and the code files. enclosure includes the printed parts (STL + STEP), the sheet-metal parts (DXF + STEP + panel) and the adhesive (DXF + PDF); flat = only the flat parts; order_readme = ORDER-README.md' }, dated: { type: 'boolean', description: 'Claude Desktop / Code: put the files in a folder named <project>-<date> (a dated snapshot)' } } } },
    { name: 'get_pcb_layout', ro: true, description: 'PCB layout for reasoning about placement: board size/shape, every footprint (ref, x, y, rotation, side, bounding box, edge lock, nets), unrouted nets with the pads that still need connecting, copper pours. Compact by default (no outline, pins, silk labels or unrouted lists): filter with refs / region / fields, add more with include.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' }, description: 'only these parts (then pins are included)' }, region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] mm: parts whose centre is inside' }, fields: { type: 'array', items: { type: 'string', enum: ['value', 'type', 'x', 'y', 'rot', 'side', 'box', 'size', 'edge', 'locked', 'nets', 'margin'] }, description: 'default x, y, rot, side, size (with refs also nets)' }, include: { type: 'array', items: { type: 'string', enum: ['pins', 'outline', 'unrouted', 'pours', 'keepouts', 'silk'] } }, pins: { type: 'boolean' }, pour_pieces: { type: 'boolean', description: 'list every piece of each copper pour with its area and the pads / vias it touches' } } } },
    { name: 'place_footprints', description: 'Place many footprints in one call (your floor plan): [{ref, x, y, rot, side, edge}] in board mm (origin top-left, y down). Overlaps are resolved, connectors kept on their edges, and (refine, default true) a short local polish shortens connections without changing your arrangement. Clears tracks; pass route: true to route right away.', input_schema: { type: 'object', required: ['placements'], properties: { placements: { type: 'array', items: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, side: { type: 'string', enum: ['top', 'bottom'] }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } } } }, refine: { type: 'boolean', description: 'short annealing of the listed parts afterwards (default false)' }, move_others: { type: 'boolean', description: 'let overlap fixing move other parts too (default false)' }, route: { type: 'boolean' } } } },
    { name: 'add_copper_pour', description: 'Add a copper pour (copper area) for a net, usually GND, on top, bottom or both layers. Without points it covers the whole board and follows the outline. Other nets keep their clearance; same-net pads connect to it.', input_schema: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1]: the board outline cut to this rectangle' }, clip: { type: 'object', properties: { x_min: { type: 'number' }, x_max: { type: 'number' }, y_min: { type: 'number' }, y_max: { type: 'number' } }, description: 'the whole board cut at these limits, e.g. {x_max: 21.3} — no polygon to compute, follows outline changes' },  net: { type: 'string', description: 'default GND' }, layer: { type: 'string', enum: ['top', 'bottom', 'both'] }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'optional polygon [[x,y],...] in mm' }, clearance: { type: 'number' } } } },
    { name: 'add_track', description: 'Draw one track by hand, like the Route tool: from a pad through corner points to a pad (or a via / another track). points: "REF.PIN" pads (pin number or name, e.g. "U1.3", "U1.VIN") and [x, y] corners in board mm (origin top-left, y down; see get_pcb_layout for pad positions). {x, y, via: true} puts a via there and continues on the other layer ({x, y, layer: "bottom"} picks the layer). corner "45" / "90" adds a knee between points so you only give the main corners. Width defaults to the net width rule. Hand-drawn tracks are kept by route_pcb (it routes the remaining nets around them). Returns new DRC problems caused by the track and whether the net is now fully connected.', input_schema: { type: 'object', required: ['points'], properties: { points: { type: 'array', items: {}, description: 'e.g. ["U1.2", [12.5, 8], {"x": 15, "y": 8, "via": true}, "C3.1"]' }, net: { type: 'string', description: 'default: the net of the pads' }, layer: { type: 'string', enum: ['top', 'bottom'], description: 'layer at the start (default: the SMD pad layer, else top)' }, width: { type: 'number', description: 'mm' }, corner: { type: 'string', enum: ['none', '45', '90'] } } } },
    { name: 'add_via', description: 'Put a via (top ↔ bottom) on the PCB. Easiest: near: "U2.9" (a pad) — CircuitPilot finds the closest spot (within max_distance, default 3 mm) where a via passes every rule (clearances on both layers, hole to hole, board edge, keep-outs, no via in another pad) and draws a short track from the pad to it; with a pour of the net on the other layer it picks a spot whose via really joins the pad to that pour (returns pad_joined / net_complete). near: [x, y] (+ net) finds the closest legal spot to a point (layer changes, stitching). Or exact x, y (it warns when that spot breaks a rule). Use it when run_drc says "Net X is not routed" for a pad cut off from a pour, or to change layer.', input_schema: { type: 'object', properties: { near: { description: 'pad "REF.PIN" or point [x, y] (board mm)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] }, max_distance: { type: 'number', description: 'mm, default 3' }, x: { type: 'number' }, y: { type: 'number' }, net: { type: 'string', description: 'default: the net of the pad' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'connect_pads_to_pour', description: 'Join the pads of a pour net (default GND) that are cut off from the rest of it (run_drc: "Net GND is not routed"; pour copper cannot reach them with the full clearance; EasyEDA export warns about pads reached only through thin pour copper): for every cut-off pad group, a via at the closest legal spot + a short track from one of its pads to the pour on the other layer (as add_via near). Reports per group what was placed or why not, net_complete and new DRC problems. Needs a pour of the net (on both layers). Stops after time_limit_s (default 45; each pad is tried once).', input_schema: { type: 'object', properties: { net: { type: 'string', description: 'default GND' }, time_limit_s: { type: 'number' }, max_distance: { type: 'number', description: 'mm from the pad, default 3' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'get_tracks', ro: true, description: 'Every track (index, net, layer, width, corner points, length, hand-drawn or autorouted) and via on the PCB, optionally only one net. Each has a stable id ("t12", "v3"): use ids with remove_tracks / lock_tracks — indexes shift after every removal, ids never do. near: only copper of the pad\'s own net that really touches it.', input_schema: { type: 'object', properties: { net: { type: 'string' }, layer: { type: 'string', enum: ['top', 'bottom'] }, region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] mm' }, near: { type: 'string', description: 'a pad "U2.9" or a part "U2": only copper touching it' }, vias_only: { type: 'boolean' }, summary: { type: 'boolean', description: 'counts and vias only' } } } },
    { name: 'remove_tracks', description: 'Delete tracks / vias: by id (from get_tracks / add_track — stable, preferred), by index (shifts after each removal), all of a net, only the autorouted ones (only: "auto") or only the hand-drawn ones (only: "manual"), dangling: true (vias that join nothing, e.g. left after a reroute), or all: true. near: only copper of that pad\'s own net that touches it. dry_run: true lists what would go without deleting. Returns the ids and nets removed.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'e.g. ["t12", "v3"]' }, dangling: { type: 'boolean' }, dry_run: { type: 'boolean' }, rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1]: tracks / vias with a point inside' }, near: { type: 'string', description: 'a part "U2" or pad "U2.9": the copper touching it' },  tracks: { type: 'array', items: { type: 'number' } }, vias: { type: 'array', items: { type: 'number' } }, net: { type: 'string' }, only: { type: 'string', enum: ['auto', 'manual'] }, all: { type: 'boolean' } } } },
    { name: 'add_thermal_vias', description: 'Thermal vias in a part\'s exposed centre pad (QFN / DFN paddle): a grid at pitch (default 1.0 mm) at least 0.1 mm inside the pad, on the pad\'s net; replaces earlier thermal vias of that pad. Allowed also with the strict no-via-in-pad rule. count limits the number.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, pitch: { type: 'number' }, count: { type: 'number' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'set_flex', description: 'Flex PCB: flex true/false, thickness (mm, JLCPCB flex 0.11 / 0.12), stiffeners to add: [{rect: [x0, y0, x1, y1] | pts: [[x, y], …] | ref: "E1" (+ margin mm, the part area — e.g. the solder-pad end of a lead), side: "bottom" (default) | "top", material: "PI" | "FR4" | "steel", thickness}]; clear_stiffeners: true removes the old ones. Gerber export then adds board-Stiffener.gm2 and flex-notes.txt; the 3D view uses the flex thickness.', input_schema: { type: 'object', properties: { flex: { type: 'boolean' }, thickness: { type: 'number' }, clear_stiffeners: { type: 'boolean' }, stiffeners: { type: 'array', items: { type: 'object' } } } } },
    { name: 'jlcpcb_quote', ro: true, description: 'Live JLCPCB price for this board — or for any Gerber zip on this machine (gerber_zip: its path; size and layer count are read from it, e.g. gold electrodes from export_electrodes) — through the JLCPCB API: uploads the Gerbers and returns the PCB price, build-time options and shipping options with cost and days. qty (default 5), color (0 green, 1 red, 2 yellow, 3 blue, 4 white, 5 black, 6 purple), finish (0 HASL, 1 lead-free HASL (default), 2 ENIG, 3 OSP), thickness (mm, default 1.6; flex boards use their flex thickness), country (ISO code, default the saved address, else EG). It does not order: the user places the order with the Order at JLCPCB button.', input_schema: { type: 'object', properties: { gerber_zip: { type: 'string', description: 'path of a Gerber zip to price instead of this project\'s board (MCP)' }, width: { type: 'number', description: 'board mm (gerber_zip: read from the outline when left out)' }, height: { type: 'number' }, layers: { type: 'number' }, qty: { type: 'number' }, color: { type: 'number' }, finish: { type: 'number' }, thickness: { type: 'number' }, country: { type: 'string' } } } },
    { name: 'jlcpcb_parts', ro: true, description: 'Live JLCPCB / LCSC data for parts: stock, price breaks, Basic or Extended library, datasheet. codes: LCSC numbers like ["C25804"]; without codes: every part of this design that has one.', input_schema: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } } } } },
    { name: 'stitch_pour', description: 'Stitching vias that join a net\'s top and bottom copper pours (default GND): one every max_spacing mm (default 3) wherever both pours are solid, plus one in every piece of either pour that has none, so pads cut off on one side reach the other side. Needs a pour of the net on both layers. Vias keep off SMD pads and keep-outs.', input_schema: { type: 'object', properties: { net: { type: 'string' }, max_spacing: { type: 'number' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'add_keepout', description: 'Add a keep-out area to the PCB: no tracks, vias or copper pour inside (each can be allowed again), optionally no parts. Use it for the antenna end of a radio module, under a coin cell / battery holder, around a crystal, under a magnet or reed switch, near mounting screws. Shape (board mm, origin top-left, y down): rect [x0, y0, x1, y1], circle {x, y, r}, points [[x, y], …] or ref (that footprint\'s box, + margin). The autorouter and copper pours avoid it; run_drc reports anything inside; route_pcb afterwards to re-route.', input_schema: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' } }, circle: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, r: { type: 'number' } } }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, ref: { type: 'string', description: 'keep out the area of this footprint (e.g. the coin-cell holder)' }, margin: { type: 'number', description: 'mm around ref' }, end: { type: 'string', enum: ['top', 'bottom', 'left', 'right'], description: 'with ref: only this end of the part (board view, y down) — e.g. the antenna end of a XIAO / ESP32 module (look at view_design to see which end has the antenna)' }, depth: { type: 'number', description: 'with end: mm into the part (default 6)' }, beyond: { type: 'number', description: 'with end: mm past the part edge (default 5)' }, layer: { type: 'string', enum: ['top', 'bottom', 'both', 'In1', 'In2', 'inner', 'all'], description: 'default both (top + bottom). 4-layer boards: In1 / In2 / inner (both inner planes) / all (every layer) — the inner planes get no copper there (e.g. under a break-off tab or an antenna)' }, name: { type: 'string', description: 'e.g. "Antenna", "Under coin cell"' }, tracks: { type: 'boolean', description: 'false allows tracks inside' }, vias: { type: 'boolean', description: 'false allows vias inside' }, pours: { type: 'boolean', description: 'false allows copper pour inside' }, parts: { type: 'boolean', description: 'true: no parts inside either (DRC + place_in_free_area)' } } } },
    { name: 'remove_keepout', description: 'Remove a keep-out area (index or name from get_pcb_layout.keepouts, or all: true).', input_schema: { type: 'object', properties: { index: { type: 'number' }, name: { type: 'string' }, all: { type: 'boolean' } } } },
    { name: 'place_in_free_area', description: 'Move parts to free space on the board — no overlap with other parts, mounting holes, part keep-outs or tracks / vias of other nets, inside the outline — as close as possible to near (a ref or [x, y]; default: the parts they connect to). group: true keeps their layout and moves them together (a circuit block); otherwise each part gets its own nearest free spot next to the parts it connects to (rotations tried, bigger parts first, either side for eligible parts unless side is given); parts that already overlap nothing stay where they are (only_overlapping: false moves them all). Then route_pcb.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, near: { description: 'ref like "U1" or [x, y] in mm' }, only_overlapping: { type: 'boolean', description: 'default true: move only the listed parts that overlap something or sit outside the board' }, group: { type: 'boolean' }, gap: { type: 'number', description: 'mm between parts (default 0.5)' }, side: { type: 'string', enum: ['top', 'bottom'], description: 'for parts not yet on the board' }, rotate: { type: 'boolean', description: 'false keeps the rotation' }, avoid_tracks: { type: 'boolean', description: 'default true: the pads keep the clearance from tracks and vias of other nets' }, avoid_pours: { type: 'boolean', description: 'also keep the pads off copper pours of other nets (default false: a pour flows around new pads; pour_split in the result warns when that cuts a pour in pieces)' } } } },
    { name: 'reroute', description: 'The whole re-route recipe in one call: removes the copper pours and all autorouted copper (locked / hand-drawn tracks stay), routes the power nets first (first, default GND then +3V3), then the rest, puts the pours back (the saved pour template, else the pours that were there), adds stitching vias where a net is poured on both layers, removes vias left joining nothing (also hand-placed ones; keep_dangling_vias: true keeps them), tidies the silkscreen labels (hides those with no room) and runs DRC. Returns one summary line. Runs as a background job.', input_schema: { type: 'object', properties: { first: { type: 'array', items: { type: 'string' }, description: 'power nets to route before the rest (default ["GND", "+3V3"]): routed together in one pass with rip-up among them — keep it to the few supply nets; signal nets route better with the rest' }, time_limit_s: { type: 'number' }, stitch: { type: 'boolean', description: 'default true' }, stitch_spacing: { type: 'number' }, labels: { type: 'string', enum: ['hide', 'keep'], description: 'arrange labels and hide those with no room (default), or arrange without hiding' }, keep_dangling_vias: { type: 'boolean' } } } },
    { name: 'transform_parts', description: 'Move, rotate or scale a group of parts: refs, everything in a region [x0, y0, x1, y1], or all. dx / dy in mm, rotate (90° steps) and scale (spacing factor) about the group centre or origin [x, y]. Tracks between the moved parts move along; tracks to parts that stay are removed (route_pcb). Locked parts stay unless include_locked. Returns each part\'s distance to the board edge; auto_fit nudges parts that end up too close inward.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, region: { type: 'array', items: { type: 'number' } }, all: { type: 'boolean' }, dx: { type: 'number' }, dy: { type: 'number' }, rotate: { type: 'number' }, scale: { type: 'number' }, origin: { type: 'array', items: { type: 'number' } }, auto_fit: { type: 'boolean' }, include_locked: { type: 'boolean' } } } },
    { name: 'edge_margins', ro: true, description: 'Distance of each part to the board edge (copper = its pads, body = its box / circle; negative = outside), smallest first, plus the parts closer than the edge rule.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean', description: 'every part, not only the 8 closest' } } } },
    { name: 'mark_overlap_ok', description: 'Accept known overlaps so check_placement stops reporting them (e.g. ["U1", "U2"]: a module over a part on the other side, a holder over the plates). remove: true un-accepts them.', input_schema: { type: 'object', required: ['pairs'], properties: { pairs: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, remove: { type: 'boolean' } } } },
    { name: 'save_pour_template', description: 'Save the current copper pours as the project\'s pour recipe (e.g. top GND clipped at x ≤ 21.3, bottom GND whole board). reroute re-applies it by itself; apply_pour_template puts it back after other changes. Pours defined as whole board / clip follow later outline changes.', input_schema: { type: 'object', properties: {} } },
    { name: 'apply_pour_template', description: 'Replace the copper pours by the saved pour template.', input_schema: { type: 'object', properties: {} } },
    { name: 'firmware_pins', ro: true, description: 'The MCU of the design and its pin names for code: design_pins.h (every connected signal pin as a PIN_ macro made from the schematic, e.g. #define PIN_HBC_TX 5 // U1.5 GPIO5 -> HBC_TX), the core and board it is, and warnings (code that uses a PIN_ name the header does not define, a pin with no number). Call it before writing firmware.', input_schema: { type: 'object', properties: {} } },
    { name: 'get_firmware', ro: true, description: 'The code files saved with the design (name -> text), the MCU chosen (or automatic) and the generated design_pins.h.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_firmware', description: 'Write a code file of the design (Arduino .ino / .h, C, MicroPython ...). Saved with the design and exported to firmware/<design>/. file: e.g. "HBC_node.ino" (an Arduino sketch file is named like its folder); text: the whole file; delete: true removes it. mcu: reference of the MCU part (e.g. "U1"), "" = automatic. Use the PIN_ names of design_pins.h with #include "design_pins.h"; no hard-coded pin numbers.', input_schema: { type: 'object', properties: { file: { type: 'string' }, text: { type: 'string' }, delete: { type: 'boolean' }, mcu: { type: 'string' } } } },
    { name: 'set_project_notes', description: 'Notes kept with the project that tools show again (open_project, start_here, get_pcb_layout): a text and named values, e.g. values {"antenna_clip_x": 21.3, "holder": "B1 bottom centre", "pour_recipe": "top GND x<=21.3, bottom GND whole"}. append adds to the text; a value null removes it.', input_schema: { type: 'object', properties: { text: { type: 'string' }, append: { type: 'boolean' }, values: { type: 'object' } } } },
    { name: 'get_project_notes', ro: true, description: 'The project notes (text and named values).', input_schema: { type: 'object', properties: {} } },
    { name: 'check_placement', ro: true, description: 'Fast placement check without routing (well under a second): parts overlapping each other (SMD parts on opposite sides may overlap; through-hole parts block both sides), parts outside the board outline, parts inside a keep-out that forbids parts, parts on a mounting hole. refs: only problems involving these parts. Each overlap gives the overlap in mm and whether the pads are clear (courtyards only) or too close; outside gives how far. Parts are compared by their real outlines (pads + body); courtyard: true adds the footprint margin (0.3 – 0.4 mm a side) like before.', input_schema: { type: 'object', properties: { courtyard: { type: 'boolean', description: 'compare with the courtyard margin around each footprint (stricter; default false)' }, show_accepted: { type: 'boolean', description: 'also list overlaps accepted with mark_overlap_ok' },  refs: { type: 'array', items: { type: 'string' } }, gap: { type: 'number', description: 'extra spacing in mm required between parts (default 0)' }, tolerance: { type: 'number', description: 'ignore overlaps smaller than this, mm (default 0.25)' } } } },
    { name: 'copy_block', description: 'Copy a circuit block (a group of parts, e.g. a sensor with its decoupling caps and pull-ups, or a whole channel) in the current project: new references, the wiring inside the block on fresh nets, power nets (GND, +3V3 …) and keep_nets stay connected, nets to parts outside the block are left off (listed in not_connected). On the PCB the copy keeps the layout and the tracks inside the block; place: "free" puts it in the nearest free board area (default: right next to the original). To copy into another project use the MCP tool copy_block with to_project.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, keep_nets: { type: 'array', items: { type: 'string' }, description: 'signal nets the copy stays connected to (e.g. a shared I2C bus: ["SDA", "SCL"])' }, suffix: { type: 'string', description: 'for renamed nets, e.g. "CH2" → ECG_IN_CH2' }, sch_offset: { type: 'array', items: { type: 'number' }, description: 'schematic offset [dx, dy] (default: to the right of the block)' }, pcb_offset: { type: 'array', items: { type: 'number' }, description: 'PCB offset in mm' }, place: { type: 'string', enum: ['next', 'free', 'none'], description: 'PCB placement of the copy (default next to the original)' }, sheet: { type: 'number', description: 'schematic sheet for the copy (1-based)' }, near: { description: 'with place "free": ref or [x, y]' } } } },
    { name: 'remove_copper_pour', description: 'Remove copper pours (all, or by index / net).', input_schema: { type: 'object', properties: { index: { type: 'number' }, net: { type: 'string' } } } },
    { name: 'add_pcb_line', description: 'Draw a free line (polyline) on one PCB layer: top / bottom copper (copper with no net: DRC keeps it clear of all other copper, it is in the Gerbers), top / bottom silkscreen (drawings, outlines, marks) or top / bottom solder mask (an opening). Points in board mm like every PCB position.', input_schema: { type: 'object', properties: { layer: { type: 'string', enum: ['top_copper', 'bottom_copper', 'top_silk', 'bottom_silk', 'top_mask', 'bottom_mask'] }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x, y], …] at least 2' }, width: { type: 'number', description: 'mm (default: track width on copper, 0.15 silkscreen, 0.3 mask)' } }, required: ['layer', 'points'] } },
    { name: 'remove_pcb_line', description: 'Delete a free line (its index from get_pcb_layout lines or add_pcb_line).', input_schema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
    { name: 'board_code', description: 'The board code + revision printed on the open PCB\'s silkscreen (e.g. "CP-K7Q2M R3"; with several PCBs "CP-K7Q2M-2 R1"): the code, the revisions made so far (a new one each time Gerbers go to a fab after the design changed) and whether the design is still the last revision. Optional: side (top / bottom), size (mm), x, y, hidden, auto (automatic position) move or change the printed label.', input_schema: { type: 'object', properties: { side: { type: 'string', enum: ['top', 'bottom'] }, size: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, hidden: { type: 'boolean' }, auto: { type: 'boolean' } } } },
    { name: 'list_pcbs', ro: true, description: 'The PCBs of this project (a project can have several PCBs, like it has several schematic sheets): number, name, which one is open (every PCB tool works on the open one), its schematic sheets, part count and board size.', input_schema: { type: 'object', properties: {} } },
    { name: 'add_pcb', description: 'Add a PCB to the project (like adding a schematic sheet) and open it. Then put schematic sheets on it with set_sheet_pcb, and generate_pcb places and routes only those sheets\' parts on it.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'e.g. "Main board", "Electrode board"' } } } },
    { name: 'select_pcb', description: 'Open one PCB of the project (number or name). Every PCB tool (generate_pcb, route_pcb, run_drc, get_pcb_layout, export_gerbers …) then works on that PCB.', input_schema: { type: 'object', properties: { pcb: { type: 'string', description: 'PCB number (1 = first) or name' } }, required: ['pcb'] } },
    { name: 'set_sheet_pcb', description: 'Put a schematic sheet on a PCB of the project: its parts are placed on that PCB (and leave the PCB they were on). Sheets without a PCB are on PCB 1.', input_schema: { type: 'object', properties: { sheet: { type: 'number', description: 'sheet number, 1 = first' }, pcb: { type: 'string', description: 'PCB number or name' } }, required: ['sheet', 'pcb'] } },
    { name: 'rename_pcb', description: 'Rename a PCB of the project.', input_schema: { type: 'object', properties: { pcb: { type: 'string' }, name: { type: 'string' } }, required: ['pcb', 'name'] } },
    { name: 'make_panel', description: 'Several boards on ONE PCB: boards side by side, each joined to the next by a break-off tab (cut off after delivery). Replaces the board outline with the panel (parts and tracks keep their coordinates). Then give each schematic sheet its board with set_sheet_board: placement puts every sheet\'s parts on its board and DRC warns about parts outside their board and nets that join two boards. The enclosure kit sees the same boards (placeBoard, { board: name }).', input_schema: { type: 'object', properties: { boards: { type: 'array', description: 'in order along the panel, e.g. [{name: "A", w: 30, h: 25}, {name: "B", w: 25, h: 25}]', items: { type: 'object', properties: { name: { type: 'string' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'h'] } }, gap: { type: 'number', description: 'cut between two boards, mm (default 2)' }, tab: { type: 'number', description: 'tab width, mm (default 3, at most 3.5)' }, corner_radius: { type: 'number', description: 'default 0.8' } }, required: ['boards'] } },
    { name: 'set_sheet_board', description: 'Put a schematic sheet on one board of the panel (make_panel, or a PCB whose outline has break-off tabs): its parts are placed on that board and DRC checks they stay there. board: "" takes the sheet off. Returns every sheet with its board and the boards of the PCB.', input_schema: { type: 'object', properties: { sheet: { type: 'number', description: 'sheet number, 1 = first' }, board: { type: 'string', description: 'board name, e.g. "A"; "" = any board' } }, required: ['sheet', 'board'] } },
    { name: 'set_board_shape', description: 'Board outline: rect, rounded / rounded_rect (corner_radius), ellipse, circle (d = diameter; flat {side: left|right|top|bottom, at: x or y of the flat edge} for a round board with a flat) or polygon (points [[x,y],...] in mm, corner_radius rounds every corner). Coordinates keep their meaning: parts, tracks and keep-outs stay where they are; only if the outline reaches below 0 is everything moved, by offset_applied.', input_schema: { type: 'object', required: ['shape'], properties: { auto_fit: { type: 'boolean', description: 'nudge parts that end up too close to the new edge inward' },  shape: { type: 'string', enum: ['rect', 'rounded', 'rounded_rect', 'ellipse', 'circle', 'polygon'] }, width: { type: 'number' }, height: { type: 'number' }, d: { type: 'number', description: 'circle diameter (mm)' }, cx: { type: 'number' }, cy: { type: 'number' }, flat: { type: 'object', properties: { side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, at: { type: 'number' } } }, corner_radius: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, keep_origin: { type: 'boolean', description: 'default true; false moves the outline (and everything) so it starts at 0, 0' } } } },
    { name: 'place_footprint', description: 'Move / rotate a footprint on the PCB, flip it to the bottom side (side = bottom), or put it on a board edge. edge = left | right | top | bottom puts connectors on that edge (USB / jacks / RF / SD: opening facing outward, flush with the edge; headers just inside) and is remembered for future generate_pcb runs. generate_pcb already puts connectors on the nearest edge automatically. Re-run route_pcb afterwards.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, side: { type: 'string', enum: ['top', 'bottom'], description: 'board side; bottom mirrors the part and puts its SMD pads on BottomLayer' }, lock: { type: 'boolean', description: 'keep automatic placement from moving it' }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, along: { type: 'number', description: 'mm along the edge (optional, with edge)' }, x: { type: 'number', description: 'mm' }, y: { type: 'number', description: 'mm' }, rot: { type: 'number', enum: [0, 90, 180, 270] } } } },
    { name: 'update_pcb_from_schematic', description: 'After schematic edits, auto-place new parts inside the existing PCB outline, using the bottom when suitable and the top is full. Keep existing placement and valid copper, then route incomplete nets. Reports any parts that cannot fit.', input_schema: { type: 'object', properties: { route: { type: 'boolean', description: 'false only updates placement and copper (default true)' }, time_limit_s: { type: 'number', description: 'autorouting time budget in seconds' } } } },
    { name: 'route_pcb', description: 'Re-run the autorouter on the current placement (follows the design rules). It keeps ripping up and re-routing until every net is connected or the time budget runs out (design rule routeTime, default 90 s), keeping the best result. nets: route only these nets (their unlocked tracks are redone, all other copper stays). Hand-drawn and locked tracks (lock_tracks) are always kept. Vias left joining nothing are removed afterwards (keep_dangling_vias: true keeps them). failed_reason says why a net could not be routed. If nets stay unrouted, inspect the failure and adjust the placement around the affected nets.', input_schema: { type: 'object', properties: { time_limit_s: { type: 'number', description: 'max seconds (default: design rule routeTime, 90)' }, nets: { type: 'array', items: { type: 'string' }, description: 'only these nets' }, keep_dangling_vias: { type: 'boolean' } } } },
    { name: 'lock_tracks', description: 'Lock good tracks and vias so routing and placement never move or remove them (like hand-drawn tracks). By net, by ids (get_tracks: "t12", "v3"), by track indexes, or all: true. unlock: true makes them autorouted again.', input_schema: { type: 'object', properties: { net: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, tracks: { type: 'array', items: { type: 'number' } }, all: { type: 'boolean' }, unlock: { type: 'boolean' } } } },
    { name: 'view_design', ro: true, description: 'Take a screenshot of the design and look at it: the schematic, the 2D PCB layout, the 3D board, or the 3D enclosure. Use it to check what you actually built (crowded or overlapping symbols, odd placement, tracks, how parts sit in the case) before and after changes. Images cost context, so ask for the view you need.', input_schema: { type: 'object', required: ['view'], properties: { size: { type: 'string', enum: ['small', 'normal', 'large'], description: 'small = 640 px JPEG for a quick check (few tokens); normal 1400 px; large 2000 px' },  view: { type: 'string', enum: ['schematic', 'pcb', 'pcb_3d', 'enclosure'], description: 'schematic | pcb (2D copper layout) | pcb_3d (rendered board with parts) | enclosure (3D case with the board)' }, sheet: { type: 'number', description: 'schematic sheet number (default: 1)' }, side: { type: 'string', enum: ['iso', 'top', 'bottom'], description: 'pcb_3d camera (default iso)' }, exploded: { type: 'boolean', description: 'enclosure: lift the lid / covers off to show the inside' }, angle: { type: 'string', enum: ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'], description: 'enclosure camera (default iso)' }, section: { type: 'string', enum: ['x', 'y'], description: 'enclosure: cut it open (x = the cut plane runs along X; look at the inside: walls, lid lip, board fit, battery)' }, at: { type: 'number', description: 'enclosure section: where the cut is, mm from the board centre along the other axis (default 0)' }, thickness: { type: 'boolean', description: 'enclosure: colour the walls by thickness (red = below the process minimum)' }, overview: { type: 'boolean', description: 'enclosure: 4 views in one picture — angled, exploded, cut in half, from below (best single check)' } } } },
    { name: 'get_documentation', ro: true, description: 'Read the product datasheet text of the current project (Documentation tab: title, tagline, revision, company, description, features, applications, notes) plus the design facts to write it from (main parts, connectors, power rails, board size, BOM size). The title, company and revision also fill the schematic title block.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_documentation', description: 'Write or update the product datasheet text (Documentation tab; the PDF, specs, images and BOM are built from the design automatically). Only the fields you pass change. Base statements on the design — do not invent ratings. features / applications: an array of short lines (or one string with a line per item). title, company and version also appear in the schematic title block.', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Product name' }, subtitle: { type: 'string', description: 'One-line tagline' }, version: { type: 'string', description: 'Revision, e.g. 1.0' }, company: { type: 'string', description: 'Company or author' }, description: { type: 'string', description: '2-4 short paragraphs' }, features: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, applications: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, notes: { type: 'string', description: 'Optional usage / assembly notes' } } } },
    { name: 'get_design_rules', ro: true, description: 'Design rules of the open PCB (each PCB of a project has its own: select_pcb first) (trace widths, clearance, vias, edge clearance, layers, per-net widths) and the fab minimums they are checked against. Defaults follow JLCPCB 2-layer capabilities. Lists available presets.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_design_rules', description: 'Change PCB design rules (mm) of the open PCB — each PCB of a project has its own rules (a 2-layer electrode PCB next to a 4-layer main PCB); all_pcbs: true changes every PCB. The autorouter follows them and DRC checks them. Use preset to load a profile, net_widths for per-net trace widths (0 removes an override). Returns warnings for values below the fab minimums, and when the via size costs extra at JLCPCB (1–2 layers: no extra charge only with hole ≥ 0.3 mm and diameter ≥ 0.4 mm, e.g. 0.45/0.3; diameter ≥ hole + 0.1, 0.15 preferred). JLCPCB minimums: 0.1 mm track / space and pad to track, 0.15 mm SMD pad to SMD pad of another net, 0.2 mm via hole to track, 0.28 mm plated hole to track, 0.2 mm copper to board edge, vias 0.15/0.25 mm (extra cost), copper 0.2 mm from the edge, through-hole pad ring 0.18 mm.', input_schema: { type: 'object', properties: { all_pcbs: { type: 'boolean', description: 'apply this change to every PCB of the project (default: only the open PCB)' }, maskExpansion: { type: 'number', description: 'solder-mask opening around each pad, mm per side (default 0.05; lower it, e.g. 0.03, for fine pitch and tight tracks)' }, maskColor: { type: 'string', enum: ['green', 'black', 'white', 'blue', 'red', 'yellow', 'purple'], description: 'black / white mask needs 0.13 mm mask web between pads (others 0.10)' }, copperOz: { type: 'number', enum: [1, 2], description: 'copper weight; 2 oz needs 0.16 mm spacing at JLCPCB' }, minMaskBridge: { type: 'number', description: 'mm, JLCPCB 0.10' }, minMaskToTrack: { type: 'number', description: 'mask opening to track, mm, JLCPCB 0.09' }, minPadToPad: { type: 'number', description: 'SMD pad to SMD pad of another net, mm, JLCPCB 0.15' }, preset: { type: 'string', description: 'jlcpcb_free_min (default: 0.2 mm tracks, 0.1 mm gaps, 0.45/0.3 vias, no extra cost; traceWidth can go down to 0.1 mm on tight boards, and neck-down narrows to the 0.1 mm fab minimum where needed) | jlcpcb (standard: 0.25 mm tracks, 0.6/0.3 vias) | jlcpcb_min (5/5 mil) | jlcpcb_power | jlcpcb_4layer (4 layers: GND / power planes inside, 0.2 mm tracks, 0.105 / 0.16 mm gaps, vias 0.45/0.3, JLCPCB multilayer minimums 0.09 mm) | jlcpcb_4layer_tight (0.09 mm gaps) | home (chemical etching, 1 layer) | cnc3018 (milling on a desktop CNC: 1 layer, 0.9 mm tracks, 0.4 mm gaps, 0.8 / 1.0 mm drills, no vias)' }, warnUnderMetal: { type: 'boolean', description: 'DRC warning for tracks / vias of other nets under batteries, coin cells and metal parts on the same side (default false)' }, pourUnderSmd: { type: 'boolean', description: 'Copper pour under SMD parts (between the pads of a 1206 …). Default true; false in the cnc3018 preset: on a milled board a pour strip under a part bridges with solder' }, smdPadRelief: { type: 'boolean', description: 'SMD pads of the pour net get a gap all round with 4 spokes (thermal relief), so each pad is its own solder spot instead of plain pour. Default false; true in the cnc3018 and home presets' }, minHoleSize: { type: 'number' }, minPthRing: { type: 'number', description: 'minimum copper ring of plated through-hole pads (mm, JLCPCB 0.18)' }, minHoleToTrack: { type: 'number', description: 'via drill hole to track (mm, JLCPCB 0.2) — the router keeps it' }, padClearance: { type: 'number', description: 'track / via to pad gap (mm; default 0.16 — EasyEDA Pro checks 0.152)' }, viaClearance: { type: 'number', description: 'track / pad / via to via gap (mm; default 0.16)' }, pourClearance: { type: 'number', description: 'copper pour to other copper (mm; default 0.26 — EasyEDA Pro checks 0.254)' }, epKeepout: { type: 'boolean', description: 'Keep-out under every exposed centre pad (QFN / DFN) on the other layer: no tracks or vias of other nets, pour allowed (default true)' }, partGap: { type: 'number', description: 'minimum gap between part outlines on the same side (mm, e.g. 0.3; 0 = off). DRC warns below it; generate_pcb, place_in_free_area and the overlap fix keep it' }, minPthToTrack: { type: 'number', description: 'plated through-hole to track (mm, JLCPCB 0.28)' }, traceWidth: { type: 'number' }, powerTraceWidth: { type: 'number', description: 'Width for power/ground nets (used only when powerWider is true)' }, powerWider: { type: 'boolean', description: 'Route power/ground nets with powerTraceWidth (default false: every net uses traceWidth)' }, clearance: { type: 'number' }, viaDiameter: { type: 'number' }, viaDrill: { type: 'number' }, edgeClearance: { type: 'number' }, layers: { type: 'number', enum: [1, 2, 4], description: '4 = top, two inner copper planes (In1, In2), bottom: the plane nets are not routed as tracks, each of their pads gets a via to its plane' }, planes: { type: 'object', description: '4 layers: the plane nets, e.g. {In1: "GND", In2: "+3V3"} (default In1 = GND, In2 = the power net with the most pins)', properties: { In1: { type: 'string' }, In2: { type: 'string' } } }, neckDown: { type: 'boolean', description: 'Allow narrowing a trace when the full width does not fit' }, routeTime: { type: 'number', description: 'Autorouter effort: max seconds of rip-up and reroute (default 90)' }, noViaInPad: { type: 'boolean', description: 'Strict (default true): never a via on an SMD pad, not even as the router\'s last resort (DRC error, so export_gerbers refuses it). Thermal vias deep inside a real exposed pad (QFN / DFN paddle) stay allowed; module edge pads (XIAO castellations) are not exposed pads.' }, pourMinArea: { type: 'number', description: 'Copper pour pieces smaller than this (mm², default 0.5) are removed, as are pieces that touch no copper of their net' }, trackStyle: { type: 'string', enum: ['45', '90'], description: 'Autorouter track corners: "45" (default: straight runs with 45° corners) or "90" (horizontal / vertical runs with 90° corners only, a little longer). Never odd angles.' }, viaInPad: { type: 'boolean', description: 'Allow vias on SMD pins (default false: vias go beside pins; thermal vias inside large exposed pads are always allowed)' }, net_widths: { type: 'object', additionalProperties: { type: 'number' }, description: 'e.g. {"+5V": 0.8, "MOTOR": 1.2}' } } } },
    { name: 'run_drc', ro: true, description: 'Design rule check of the PCB with exact geometry: clearances/shorts, trace widths, via size/annular ring, hole spacing, board-edge clearance and unrouted nets. Returns the counts per type and the first 5 violations (full: true for all). as: "easyeda" checks with the numbers EasyEDA Pro uses (0.152 mm next to pads and vias, 0.254 mm pour gap) so the two lists match.', input_schema: { type: 'object', properties: { as: { type: 'string', enum: ['circuitpilot', 'easyeda'], description: 'easyeda: the spacing EasyEDA Pro checks instead of this board\'s rules' }, full: { type: 'boolean', description: 'all violations with details (up to 80)' }, limit: { type: 'number', description: 'how many violations to list (default 5)' }, types: { type: 'array', items: { type: 'string' }, description: 'only these types, e.g. ["clearance", "via-in-pad", "keepout"]' } } } },
    { name: 'pcb_status', ro: true, description: 'Board size, number of placed parts, routed / unrouted nets, via count, trace length.', input_schema: { type: 'object', properties: { verbose: { type: 'boolean', description: 'also the board outline points' }, } } },
    { name: 'create_part', description: 'Create a NEW custom part (symbol pins + PCB footprint) when nothing suitable exists in the database. Saved to the design and to My Library; returns its key for add_components {lcsc: key}.', input_schema: { type: 'object', required: ['name', 'pins', 'footprint'], properties: { name: { type: 'string' }, prefix: { type: 'string', description: 'Reference prefix, default U' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, mech: { type: 'object', description: 'mechanical data the enclosure uses: body {w, l, h} (mm, w along x and l along y as the footprint is drawn; h above the board) and connectors [{type: "usb-c", side: "pin1" (the short side next to pin 1) | left | right | top | bottom (board sides), w, h (opening size), z (centre height above the board), out (how far it sticks out past the body)}]' }, save_to_library: { type: 'boolean', description: 'default true' } } } },
    { name: 'update_part', description: 'Modify an existing part definition used in the design (database or custom): pins, footprint, name, prefix, value, mech (body size and connector positions for the enclosure). All placed instances follow.', input_schema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'LCSC code or library key' }, name: { type: 'string' }, prefix: { type: 'string' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, mech: { type: 'object', description: 'mechanical data the enclosure uses: body {w, l, h} (mm, w along x and l along y as the footprint is drawn; h above the board) and connectors [{type: "usb-c", side: "pin1" (the short side next to pin 1) | left | right | top | bottom (board sides), w, h (opening size), z (centre height above the board), out (how far it sticks out past the body)}]' }, save_to_library: { type: 'boolean', description: 'default true' } } } },
    { name: 'list_my_parts', ro: true, description: 'List the parts in My Library (custom and edited parts).', input_schema: { type: 'object', properties: {} } },
    { name: 'knowledge_list', ro: true, description: "List the documents in this project's knowledge folder (design notes, guides, datasheets, requirements).", input_schema: { type: 'object', properties: {} } },
    { name: 'knowledge_read', ro: true, description: 'Read a document from the project knowledge folder (paged; use offset for long files).', input_schema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, offset: { type: 'number' } } } },
    { name: 'knowledge_search', ro: true, description: 'Full-text search across the project knowledge folder; returns matching snippets with file and offset.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'set_knowledge_folder', description: 'Point this project at a knowledge folder (absolute path on the server PC) containing docs and guides to follow during design. Empty string clears it.', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  ];

  // ---------- parts ----------
  const partCache = {};
  async function loadPart(code) {
    const raw = String(code || '').trim(), up = raw.toUpperCase();
    for (const k of [raw, up]) if (Model.S.lib[k]) return Model.S.lib[k];
    const mine = env.myLib().find(p => p.key === raw || p.key === up);
    if (mine) return mine;
    if (typeof OpenLib !== 'undefined' && OpenLib.isKey(raw)) { if (!partCache[raw]) partCache[raw] = await OpenLib.load(raw).catch(e => { throw e; }); return partCache[raw]; }
    if (!/^(C\d+|EE-[0-9A-F]{32})$/.test(up)) {
      // a mistyped / invented key: name the closest My Library and design parts, so the model can correct itself
      const words = s => new Set(String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length > 1 && w !== 'LIB'));
      const want = words(raw), cands = [...env.myLib().map(p => ({ key: p.key, name: p.name })), ...Object.entries(Model.S.lib || {}).map(([key, p]) => ({ key, name: p && p.name }))];
      const near = cands.map(c => { const w = words(c.key + ' ' + (c.name || '')); let k = 0; for (const x of want) if (w.has(x)) k++; return Object.assign(c, { k }); })
        .filter(c => c.k > 0).sort((a, b) => b.k - a.k).filter((c, i, A) => A.findIndex(x => x.key === c.key) === i).slice(0, 3);
      throw new Error(`Unknown part "${raw}"` + (near.length ? ` — closest parts you have: ${near.map(c => `"${c.key}"${c.name ? ' (' + c.name + ')' : ''}`).join(', ')}; use one of these keys exactly as "lcsc"` : ' — no My Library part matches') + `, or find the part with search_parts (LCSC code C1234) / list_my_parts`);
    }
    if (!partCache[up]) {
      try { partCache[up] = await partsApi('get/' + encodeURIComponent(up)); }
      catch (e) {
        // EasyEDA library unavailable: build the part from the open libraries (same part number, or the package's KiCad footprint)
        if (!/^C\d+$/.test(up) || typeof OpenLib === 'undefined' || !OpenLib.fallbackPart) throw e;
        let info = null; try { info = ((await partsApi('search?q=' + up + '&limit=3')).results || []).find(r => r.lcsc === up) || null; } catch (e2) { }
        try { partCache[up] = await OpenLib.fallbackPart(up, info); } catch (e3) { throw new Error(e.message + ' — ' + e3.message); }
      }
    }
    return partCache[up];
  }
  const keyOf = m => m.key || m.lcsc;
  const partName = value => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  function knownPartFor(spec, parts) {
    const value = partName(spec.value), footprint = String(spec.footprint || '').trim();
    if (!value) return [];
    const label = /^(.*?)\s+\((\d+) pads?\)$/i.exec(footprint);
    const packageName = partName(label ? label[1] : footprint);
    return parts.filter(p => p.pins?.length && p.footprint?.pads?.length
      && [p.name, p.mfr_part].some(name => partName(name) === value)
      && (!packageName || partName(p.footprint.name) === packageName)
      && (!label || p.footprint.pads.length === +label[2]));
  }
  function partSummary(m) {
    return {
      key: keyOf(m), name: m.name, manufacturer: m.manufacturer, mfr_part: m.mfr_part, package: m.package, ref_prefix: m.prefix,
      add_as: { lcsc: keyOf(m) },
      pins: (m.pins || []).map(p => p.num + ':' + p.name).join(' '),
      footprint: m.footprint ? `${m.footprint.name} (${m.footprint.pads.length} pads)` : 'none', datasheet: m.datasheet || undefined
    };
  }
  function partsInfo() {
    return Lib.types().map(t => {
      const d = Lib.type(t), c = { type: t, pins: null };
      const pins = d.generic ? '(custom pin list via "pins")' : d.pins(c).map(p => p.num + ':' + p.name).join(' ');
      return `${t} [${d.prefix}] default=${d.value} pins: ${pins} footprints: ${d.generic ? (t === 'ic' ? 'SOIC-<n> | DIP-<n>' : 'PinHeader_1x<n>') : d.fps.join(' | ')}`;
    }).join('\n');
  }
  function buildFootprint(spec) {
    if (!spec) return { name: 'none', pads: [], body: null };
    if (typeof spec === 'string') {
      const fp = Lib.footprint(spec); if (!fp) throw new Error(`Unknown footprint "${spec}". Known: ${Lib.FOOTPRINT_PATTERNS.join(', ')}`);
      return { name: spec, pads: JSON.parse(JSON.stringify(fp.pads)), body: fp.body || null };
    }
    const pads = (spec.pads || []).map((p, i) => {
      const w = +p.w || +p.size || 1, h = +p.h || +p.size || w;
      const o = { num: String(p.num ?? i + 1), x: +p.x || 0, y: +p.y || 0, w, h, shape: ['rect', 'round', 'oval'].includes(p.shape) ? p.shape : 'rect' };
      if (+p.drill > 0) o.drill = +p.drill;
      return o;
    });
    if (!pads.length) throw new Error('footprint.pads is empty');
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pads) b = [Math.min(b[0], p.x - p.w / 2), Math.min(b[1], p.y - p.h / 2), Math.max(b[2], p.x + p.w / 2), Math.max(b[3], p.y + p.h / 2)];
    return { name: spec.name || 'custom', pads, body: b };
  }
  const normPins = pins => (pins || []).map((p, i) => ({ num: String(p.num ?? i + 1), name: String(p.name ?? p.num ?? i + 1), side: ['L', 'R', 'T', 'B'].includes(p.side) ? p.side : (i % 2 ? 'R' : 'L') }));
  const newKey = name => 'LIB_' + (String(name || 'PART').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'PART') + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  function withBody(fp) {
    if (!fp.pads.length) return fp;
    let b = fp.body ? fp.body.slice() : [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of fp.pads) b = [Math.min(b[0], p.x - p.w / 2), Math.min(b[1], p.y - p.h / 2), Math.max(b[2], p.x + p.w / 2), Math.max(b[3], p.y + p.h / 2)];
    return Object.assign({}, fp, { body: b });
  }

  // ---------- knowledge folder ----------
  const kPath = () => { const p = Model.S.knowledge && Model.S.knowledge.path; if (!p) throw new Error('No knowledge folder set for this project (use set_knowledge_folder or the 📚 button)'); return p; };
  const kApi = (op, q) => api('/api/knowledge/' + op + '?' + new URLSearchParams(Object.assign({ path: kPath() }, q)).toString());

  // ---------- executor ----------
  // ---------- custom 3D enclosure scripts ----------
  // the enclosure's files for printing and ordering. Custom: print parts (STL + STEP), sheet parts (DXF + STEP + one panel),
  // README with the order settings per service (service: all | jlc3dp | jlccnc). Box: base + lid STL + STEP + .scad.
  // the electrode plates of the current project's 3D script: [{name, flat, hole, face, sheet_mm, project}]
  function plates() {
    if (Enclosure.mode() !== 'custom') return [];
    const r = Shape3D.run(Enclosure.script(), shapeContext(), { mesh: false, stl: false, check: false, rules: Enclosure.params().rules, shapes: Enclosure.params().shapes });
    return r.parts.filter(p => p.kind === 'metal' && p.flat).map(p => ({ name: p.name, flat: p.flat, hole: p.hole || null, face: p.face || 'bottom', sheet_mm: p.sheet_mm || 0.5, project: Model.S.name || '' }));
  }
  const remembered = () => ((Model.S.enclosure || {}).platesExported) || {};
  function rememberPlates(list) { const S = Model.S; S.enclosure = Object.assign({}, S.enclosure || {}, { platesExported: Object.fromEntries(list.map(p => [p.name, { loops: p.flat.loops }])) }); }
  // electrode order files: gold PCB (Gerbers) or the stainless sheet set, from these plates (several projects may be merged)
  function electrodeFiles(list, o = {}) {
    const name = String(o.name || Model.S.name || 'electrodes').replace(/[^\w.-]+/g, '_') + '-electrodes';
    if (!list.length) throw new Error('No electrode plates — electrode({…}) in the 3D script makes them');
    const seen = new Set(); for (const p of list) { let n = p.name, k = 2; while (seen.has(n)) n = p.name + '_' + k++; seen.add(n); p.name = n; }
    if ((o.as || 'pcb') === 'pcb') { const E = Shape3D.electrodePcb(list, { name, thickness: o.thickness || 0.6 }); return { files: Object.assign({}, E.files, { [`${name}-assembly-guide.svg`]: E.guide }), info: { as: 'pcb', board_mm: E.size, plates: list.map(p => p.name), pads: E.pads } }; }
    const t = o.thickness || list[0].sheet_mm || 0.5, J = Shape3D.joinedSheet(list.map(p => p.flat), t), fl = { loops: J.loops, open: J.open }, files = {};
    files[`${name}-joined.dxf`] = Shape3D.dxfOfProfiles(J.loops, J.open); files[`${name}-joined.step`] = Shape3D.stepOfProfiles(name, J.loops, t);
    files[`${name}-joined-snip-guide.pdf`] = Shape3D.pdfOfFlat(name + ' (snip guide)', fl, `${t} mm stainless; snip at the red dashes.`, J.snips);
    files[`${name}-assembly-guide.svg`] = Shape3D.assemblyGuide(list, J, remembered(), name);
    const ck = Shape3D.sheetCheck(fl, t);
    files['README-JLCCNC.txt'] = [`${name}: ${list.length} plates as ONE sheet-metal part, ${J.size.join(' x ')} mm, ${t} mm`, '', 'JLCCNC: Sheet metal, laser cutting only. Material: Stainless steel 304 (the site starts on Aluminium 5052 — change it).',
      t < 1 ? 'Finish: none (brushing only from 1.0 mm). No coating.' : 'Finish: brushing or none. No coating.', 'Snip the 5 mm bars at the red dashes (snip guide PDF), file the stubs flush.', ...(ck.issues.length ? ['', 'Check:', ...ck.issues.map(x => '  - ' + x)] : []), ''].join('\n');
    return { files, info: { as: 'sheet', size_mm: J.size, bars: J.bars, check: ck, plates: list.map(p => p.name) } };
  }
  function enclosureFiles(o = {}) {
    const base = (Model.S.name || 'design').replace(/[^\w.-]+/g, '_');
    if (Enclosure.mode() !== 'custom') { Enclosure.setQuality('high'); try { const { files, info } = Enclosure.exportFiles(); return { files, info: Object.assign({ mode: 'box' }, info) }; } finally { Enclosure.setQuality('preview'); } }
    const sc = shapeContext(), proc = Enclosure.params().process;
    const r = o.result || Shape3D.run(Enclosure.script(), sc, { quality: 'high', mesh: false, step: true, process: proc, rules: Enclosure.params().rules, shapes: Enclosure.params().shapes, dfmCap: 6000, dfmOpenPts: 1 });
    const pk = Shape3D.exportPack(r, { base, service: o.service || 'all', process: proc, script: Enclosure.script(), shapes: Enclosure.params().shapes, pcb: sc.pcb, previous: remembered() });
    const metalNow = r.parts.filter(p => p.kind === 'metal' && p.flat); if (metalNow.length) rememberPlates(metalNow);
    return { files: pk.files, info: { mode: 'custom', process: proc, parts: r.parts.map(p => ({ name: p.name, kind: p.kind, size_mm: p.size_mm })), collisions: r.report.collisions, warnings: pk.warnings, cutouts: [] } };
  }
  // a picture of the finished enclosure for the AI (4 views in one small image); skipped when no app window can draw it
  async function encPicture(input = {}) {
    if (!env.render || input.preview === false) return null;
    try {
      const img = await Promise.race([env.render({ view: 'enclosure', overview: true, size: 'small', enc: Model.S.enclosure }), new Promise(res => setTimeout(() => res(null), 25000))]);
      return img && img.data ? { __image: { mime: img.mime, data: img.data }, picture: '4 views: angled · exploded (lid lifted) · cut in half through the board · from below' } : null;
    } catch (e) { return null; }
  }
  function shapeContext() { try { return Shape3D.context(Enclosure.layout()); } catch (e) { return { pcb: null }; } }
  // summary for the AI: sizes, fit report, errors with line numbers (meshes stay in the viewer)
  // the manufacturability report, short: the worst few of each kind (positions in script mm)
  function dfmSummary(d) {
    if (!d) return undefined;
    const top = (L, n = 6) => L.length > n ? L.slice(0, n).concat([`… ${L.length - n} more`]) : L;
    return { process: d.rules.name, limits: { min_wall_mm: d.rules.wall, min_hole_mm: d.rules.hole, min_slit_mm: d.rules.gap, fit_clearance_mm: d.rules.fit, min_part_mm: d.rules.minBox },
      too_small: d.too_small, thin_walls: top(d.thin), edge_lips: d.edge_lips && d.edge_lips.length ? top(d.edge_lips) : undefined, knife_edges: top(d.knife_edges), narrow_slits: top(d.narrow_gaps), fit: d.fit, openings: d.openings, note: d.note };
  }
  async function runShape(code, extra = {}) {
    let r;
    const o = Object.assign({ process: Enclosure.params().process, rules: Enclosure.params().rules, shapes: Enclosure.params().shapes }, extra);
    try { r = env.shape ? await env.shape(code, o) : Shape3D.run(code, shapeContext(), Object.assign({ mesh: false, stl: false }, o)); }
    catch (e) { return { ok: false, error: e.message, line: e.line || null, logs: e.logs || [], hint: 'Fix the script and call set_enclosure_script again (enclosure_script_help has the API).' }; }
    const out = { ok: true, parts: r.parts.map(p => ({ name: p.name, kind: p.kind !== 'print' ? p.kind : undefined, size_mm: p.size_mm, bbox: p.bbox, volume_cm3: p.volume_cm3, triangles: p.triangles, watertight: !p.open_edges, pieces: p.pieces, loose: p.loose || undefined })), manufacturability: dfmSummary(r.report.dfm), collisions: r.report.collisions, not_enclosed: r.report.outside || [], near_wall: r.report.near_wall, warnings: r.report.warnings, logs: r.logs, build_ms: r.ms };
    const bat = (r.extras || []).find(x => x.kind === 'battery');
    if (bat) out.battery = { id: bat.id, name: bat.name, mAh: bat.mAh, place: bat.place, box_mm: [bat.x0, bat.y0, bat.z0, bat.x1, bat.y1, bat.z1].map(v => +v.toFixed(2)) };
    const fix = [];
    if (r.report.collisions.length) fix.push('Printed parts overlap the PCB/components listed in collisions: make the cavity bigger/taller or move the features.');
    if ((r.report.outside || []).length) fix.push('Not inside the enclosure: ' + r.report.outside.join(', ') + '. Size the body from envelope() so the board and all parts fit, and close the walls and lid around them.');
    const d = r.report.dfm;
    if (d && ((d.too_small || []).length || d.thin.length || d.knife_edges.length || d.narrow_gaps.length || d.fit.some(x => !x.ok) || d.openings.some(x => !x.expected))) fix.push(`Manufacturability (${d.rules.name}): see manufacturability — thicken walls under ${d.rules.wall} mm, remove knife edges, widen slits, give fits ${d.rules.fit} mm, close openings nothing explains (or declare them with opening()).`);
    if (fix.length) out.fix = fix.join(' ') + ' Then run set_enclosure_script again (patch / vars change a few lines without resending the script).';
    return out;
  }
  // F6: change a few things in the current script instead of resending all of it
  function patchScript(code, input) {
    let c = code; const done = [];
    for (const [i, q] of (input.patch || []).entries()) {
      if (!q || typeof q.find !== 'string') throw new Error(`patch[${i}]: {find, replace} — find is the exact text to change`);
      const n = c.split(q.find).length - 1;
      if (!n) throw new Error(`patch[${i}]: text not found in the script: ${JSON.stringify(q.find.slice(0, 80))}`);
      if (n > 1 && !q.all) throw new Error(`patch[${i}]: the text appears ${n} times — make find longer, or all: true`);
      c = q.all ? c.split(q.find).join(q.replace ?? '') : c.replace(q.find, () => q.replace ?? ''); done.push(`patch ${i + 1}: ${n} place${n > 1 ? 's' : ''}`);
    }
    for (const [k, v] of Object.entries(input.vars || {})) {
      if (!/^[A-Za-z_$][\w$]*$/.test(k)) throw new Error(`vars: "${k}" is not a variable name`);
      const re = new RegExp(`((?:const|let|var)\\s+(?:[^;\\n]*?[,{\\s])?${k.replace(/\$/g, '\\$')}\\s*=\\s*)([^,;\\n]+)`);
      if (!re.test(c)) throw new Error(`vars: no "const ${k} = …" in the script`);
      c = c.replace(re, (m, a) => a + (typeof v === 'string' && !/^[-\d.]+$/.test(v) ? JSON.stringify(v) : String(v))); done.push(`${k} = ${JSON.stringify(v)}`);
    }
    return { code: c, done };
  }

  // other names for the same argument (a wrong name used to be ignored silently: place_footprint {rotation} kept the old angle)
  const ALIASES = { rotation: 'rot', angle: 'rot', rot: 'rotation', part: 'ref', component: 'ref', refs: 'ref', ref: 'refs', net_name: 'net', nets: 'net', net: 'nets', layers: 'layer', diameter_mm: 'diameter', width_mm: 'width' };
  const ALWAYS_OK = new Set(['project', 'verbose']);
  function checkArgs(t, input) {
    const props = (t.input_schema && t.input_schema.properties) || null; if (!props) return input;
    const out = Object.assign({}, input), bad = [];
    for (const k of Object.keys(input)) {
      if (k in props || ALWAYS_OK.has(k)) continue;
      const to = ALIASES[k];
      if (to && to in props && !(to in input)) { out[to] = to === 'refs' && !Array.isArray(input[k]) ? [input[k]] : to === 'ref' && Array.isArray(input[k]) ? input[k][0] : input[k]; delete out[k]; }
      else bad.push(k);
    }
    if (bad.length) throw new Error(`${t.name}: unknown argument${bad.length > 1 ? 's' : ''} ${bad.map(b => '"' + b + '"').join(', ')} — allowed: ${Object.keys(props).join(', ')}`);
    return out;
  }
  async function exec(name, input, mode = 'agent') {
    const t = TOOLS.find(t => t.name === name);
    if (!t) throw new Error(name === 'optimize_pcb'
      ? 'Optimize is unavailable. After schematic edits, call update_pcb_from_schematic to place new parts and route incomplete nets.'
      : 'Unknown tool ' + name);
    if (mode !== 'agent' && !t.ro) throw new Error(`"${name}" modifies the design and is not allowed in ${mode} mode`);
    input = checkArgs(t, input || {});
    switch (name) {
      case 'search_parts': {
        const q = String(input.query || '').toLowerCase();
        const mine = env.myLib().filter(p => q.split(/\s+/).every(w => `${p.name} ${p.value} ${p.key} ${p.mfr_part || ''}`.toLowerCase().includes(w))).slice(0, 5)
          .map(p => ({ lcsc: p.key, part: p.name, package: p.footprint && p.footprint.name, source: 'my-library' }));
        let j = { results: [], source: 'none' };
        // open KiCad-format libraries (KiCad official, SparkFun, Digi-Key): symbol + footprint, no LCSC number
        const open = typeof OpenLib !== 'undefined' ? OpenLib.search(input.query, 6).catch(() => []) : Promise.resolve([]);
        try { j = await partsApi('search?q=' + encodeURIComponent(input.query || '') + '&limit=' + Math.min(30, +input.limit || 10)); }
        catch (e) { if (!mine.length && !(await open).length) throw e; }
        const ol = (await open).map(r => ({ lcsc: r.key, part: r.name, mpn: r.mpn || undefined, footprint: r.footprint, source: r.source, desc: r.description.slice(0, 120), note: r.sourceName + ': custom part (no LCSC number), check the footprint' }));
        const db = j.results.slice().sort((a, b) => (b.stock > 0) - (a.stock > 0)).map(r => Object.assign({ lcsc: r.lcsc, part: r.mfr_part, brand: r.brand, package: r.package, footprint: r.footprint || undefined, stock: r.stock, basic: !!r.basic, price_usd: r.price, desc: (r.description || '').slice(0, 140) },
          r.sources && !r.sources.includes('jlcpcb') ? { source: r.sources[0], note: r.note } : {}));
        if (!mine.length && !db.length && !ol.length) return `No parts found for "${input.query}"` + (j.error ? ` (online search failed: ${j.error})` : '');
        return { source: j.source + (ol.length ? '+open' : ''), results: [...mine, ...db, ...ol] };
      }
      case 'get_part': {
        const part = partSummary(await loadPart(input.lcsc || input.key));
        return { add_components_input: { components: [part.add_as] }, ...part };
      }
      case 'get_design': return Model.summary();
      case 'list_parts': return partsInfo();
      case 'list_my_parts': return env.myLib().map(partSummary);
      case 'run_erc': { const r = Model.erc(); return r.length ? r : 'ERC passed: no issues'; }
      case 'pcb_status': {
        // unrouted nets with the pad groups that still need joining and the router's reason
        const st = Pcb.status(), conn = Pcb.connectivity(), notes = Model.S.pcb.routeNotes || {};
        st.unrouted_detail = st.unrouted.map(n => ({ net: n, pieces: (conn[n] ? conn[n].groups : []).map(g => g.map(p => `${p.key}@(${(+p.x).toFixed(2)},${(+p.y).toFixed(2)})`)), reason: notes[n] }));
        if (input.verbose) st.outline = Pcb.boardPoly().map(q => q.map(v => +v.toFixed(3)));
        return st;
      }
      case 'export_project': {
        if (!env.exportAll) throw new Error('Exporting needs the CircuitPilot app');
        const inc = input.include && input.include.length ? input.include : null;
        return env.exportAll({ images: !inc || inc.includes('images'), pdf: !inc || inc.includes('pdf') });
      }
      case 'set_silk_label': return Model.mutate(() => { Pcb.setSilkLabel(input.ref, input); const i = Pcb.silkInfo().find(l => /^board$/i.test(input.ref) ? l.kind === 'board' : l.kind === 'part' && l.ref === input.ref); return i || { ref: input.ref, hidden: true }; });
      case 'batch': {
        const NO = new Set(['batch', 'export_project', 'reroute']);
        const calls = Array.isArray(input.calls) ? input.calls : []; if (!calls.length) throw new Error('calls is empty');
        const results = []; let failed = 0;
        for (const [i, c] of calls.entries()) {
          const tool = c && (c.tool || c.name);
          try {
            if (NO.has(tool)) throw new Error(`${tool} cannot run inside batch — call it on its own`);
            const r = await exec(tool, c.args || c.input || {}, mode), txt = JSON.stringify(r);
            results.push({ i, tool, ok: true, result: txt && txt.length > 4000 ? txt.slice(0, 400) + ' … (shortened)' : r });
          } catch (e) { failed++; results.push({ i, tool, ok: false, error: e.message }); if (!input.continue_on_error) break; }
        }
        return { done: results.filter(r => r.ok).length, failed, of: calls.length, results };
      }
      case 'arrange_silk_labels': return Model.mutate(() => Pcb.arrangeSilk(input));
      case 'add_pcb_text': return Model.mutate(() => { const t = Pcb.addText(input); const i = Pcb.silkInfo().find(l => l.kind === 'text' && l.index === t.index); return Object.assign({ index: t.index }, i || t); });
      case 'update_pcb_text': return Model.mutate(() => Pcb.updateText(+input.index, input));
      case 'remove_pcb_text': return Model.mutate(() => Pcb.removeText(+input.index));
      case 'add_components': {
        const known = new Map();
        for (const p of [...Object.values(partCache), ...env.myLib(), ...Object.values(Model.S.lib)]) {
          if (p && keyOf(p)) known.set(keyOf(p), p);
        }
        const knownParts = [...known.values()];
        const lookupHint = s => {
          const matches = knownPartFor({ value: s.value }, knownParts);
          if (matches.length === 1) return 'Use this entry and omit footprint: '
            + JSON.stringify({ ref: s.ref, lcsc: keyOf(matches[0]) }) + '.';
          return 'Call search_parts ' + JSON.stringify({ query: s.value || s.ref || '', limit: 3 })
            + ', then get_part and use its add_components_input.';
        };
        const problems = new Map(), libs = {}, notes = [];
        const list = (Array.isArray(input.components) ? input.components : [input]).map((s, i) => {
          const spec = { ...s };
          if (!spec.type && !spec.lcsc && !spec.part) {
            const id = /^(?:LIB:(\S+)|LCSC:(C\d+))$/i.exec(String(spec.footprint || '').trim());
            if (id) {
              spec.part = id[1] || id[2];
            } else {
              const matches = knownPartFor(spec, knownParts);
              if (matches.length === 1) {
                spec.part = keyOf(matches[0]);
                notes.push(`${spec.ref || spec.value}: used the previously loaded part ${spec.part}`);
              } else if (matches.length > 1) {
                problems.set(i, `choose one exact "lcsc" key: ${matches.map(keyOf).slice(0, 5).join(', ')}`);
              } else if (/^TP\d+$/i.test(spec.ref || '') && /^PinHeader_1x1$/i.test(spec.footprint || '') && spec.pins == null) {
                Object.assign(spec, { type: 'connector', footprint: 'PinHeader_1x1', pins: ['1'] });
              }
            }
          }
          return spec;
        });
        // simple built-in parts (their pins do not depend on the part number): a wrong "lcsc" must not block them —
        // small models put values (104 = 100 nF) or references (C1) there
        const SIMPLE = ['resistor', 'capacitor', 'capacitor_polarized', 'inductor', 'potentiometer', 'fuse', 'crystal', 'diode', 'schottky', 'zener', 'led', 'npn', 'pnp', 'nmos', 'pmos', 'switch', 'battery', 'buzzer'];
        for (const [i, s] of list.entries()) if (s.lcsc || s.part) {
          const code = String(s.lcsc || s.part).trim(), simple = SIMPLE.includes(s.type) && s.value;
          if (simple && (/^[A-Z]{1,2}\d{1,3}$/i.test(code) || code.toUpperCase() === String(s.ref || '').toUpperCase())) {
            notes.push(`${s.ref || s.type} ${s.value}: ignored "${code}" — that is a value code or a reference, not an LCSC part number; added a built-in ${s.type}`);
            delete s.lcsc; delete s.part; continue;
          }
          try { const m = known.get(code) || await loadPart(code); libs[keyOf(m)] = m; s.part = keyOf(m); delete s.lcsc; }
          catch (e) {
            if (simple) { notes.push(`${s.ref || s.type} ${s.value}: could not load "${code}" — added a built-in ${s.type} instead`); delete s.lcsc; delete s.part; continue; }
            problems.set(i, e.message);
          }
        }
        // built-in symbols get the real JLCPCB part behind them (unless a footprint was given)
        for (const [i, s] of list.entries()) if (!problems.has(i) && s.type && !s.lcsc && !s.part && !s.footprint && Lib.dbDefault(s.type, s.value)) {
          try { s.dbPart = await loadPart(Lib.dbDefault(s.type, s.value).lcsc); } catch (e) { /* database unavailable → generated footprint */ }
        }
        // sheet numbers are 1-based for the AI; sheets are created on demand
        for (const s of list) if (s.sheet != null) { const n = Math.max(1, Math.round(+s.sheet) || 1); s.sheet = n - 1; }
        return Model.mutate(() => {
          const need = Math.max(0, ...list.map(s => (s.sheet || 0) + 1));
          if (need > 1) { const sh = (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]).slice(); while (sh.length < need) sh.push({ name: 'Sheet ' + (sh.length + 1) }); Model.S.sheets = sh; }
          for (const [k, m] of Object.entries(libs)) if (!Model.S.lib[k]) Model.setLibPart(k, m);
          const added = [];
          for (const [i, s] of list.entries()) {
            if (problems.has(i)) continue;
            const header = /^PinHeader_1x([1-9]\d*)$/i.exec(s.footprint || '');
            if (header && Array.isArray(s.pins) && s.pins.length) s.footprint = 'PinHeader_1x' + header[1];
            if (!s.part && s.footprint && !Lib.footprint(s.footprint)) {
              problems.set(i, `unknown footprint "${s.footprint}". ${lookupHint(s)}`);
              continue;
            }
            if (!s.part && header && +header[1] === 1 && (s.type === 'battery' || /^B(?:T)?\d+$/i.test(s.ref || ''))) {
              problems.set(i, 'a battery needs both terminals. Use a verified part key, or for a generic two-pin connection use '
                + JSON.stringify({ ref: s.ref, type: 'battery', footprint: 'PinHeader_1x2' }) + '.');
              continue;
            }
            try { added.push(Model.addComponent(s)); }
            catch (e) {
              const needsKey = !s.type && !s.part && e.message.includes('give a built-in "type"');
              const prefix = s.ref ? s.ref + ': ' : '';
              problems.set(i, needsKey ? 'missing "type" or "lcsc". ' + lookupHint(s)
                : prefix && e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message);
            }
          }
          if (problems.size) {
            const details = [...problems].sort(([a], [b]) => a - b).slice(0, 10)
              .map(([i, error]) => `${list[i].ref || 'Component ' + (i + 1)}: ${error}`);
            if (problems.size > details.length) details.push(`… and ${problems.size - details.length} more component errors.`);
            throw new Error('No components were added. Exact add_components JSON shape (use a real key):\n' + addExample
              + '\nFor lcsc entries, omit type and footprint. Fix these entries:\n' + details.join('\n'));
          }
          Model.spaceOut();   // keep room for net labels between parts, whatever coordinates were asked for
          const out = added.map(c => ({ ref: c.ref, type: c.type, value: c.value, x: c.x, y: c.y, sheet: Model.sheetOf(c) + 1, footprint: c.footprint, pins: Lib.type(c.type).pins(c).map(p => p.num + ':' + p.name).join(' ') }));
          return notes.length ? out.concat([{ note: notes.join('; ') }]) : out;
        });
      }
      case 'update_component': return Model.mutate(() => {
        const u = Object.assign({}, input); delete u.lcsc_part;
        const c = Object.keys(u).some(k => k !== 'ref') ? Model.updateComponent(u) : Model.comp(input.ref); if (!c) throw new Error('No component ' + input.ref);
        if (input.lcsc_part != null) { const v = String(input.lcsc_part).trim().toUpperCase(); if (v && !/^C\d+$/.test(v)) throw new Error('lcsc_part is an LCSC number like C25804 ("" clears it)'); if (v) c.lcscPart = v; else delete c.lcscPart; }
        Model.spaceOut(); return { ok: true, ref: c.ref, lcsc: Model.lcscOf(c) || undefined };
      });
      case 'remove_components': return Model.mutate(() => { (input.refs || []).forEach(Model.removeComponent); return { ok: true }; });
      case 'connect': {
        const list = Array.isArray(input.connections) ? input.connections : [input];
        return Model.mutate(() => { const r = list.map(cn => ({ net: Model.connect(cn.net, cn.pins || []), pins: (cn.pins || []).length })); Model.spaceOut(); return r; });
      }
      case 'add_sheet': return Model.mutate(() => { const sh = (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]).slice(); sh.push({ name: String(input.name || 'Sheet ' + (sh.length + 1)) }); Model.S.sheets = sh; return { sheet: sh.length, sheets: sh.map((s, i) => `${i + 1}: ${s.name}`) }; });
      case 'move_to_sheet': return Model.mutate(() => {
        const n = Math.max(1, Math.round(+input.sheet) || 1), sh = (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]).slice();
        while (sh.length < n) sh.push({ name: 'Sheet ' + (sh.length + 1) }); Model.S.sheets = sh;
        const moved = [];
        for (const r of input.refs || []) { const c = Model.comp(r); if (!c) continue; if (n > 1) c.sheet = n - 1; else delete c.sheet; moved.push(c.ref); }
        Model.autoLayout(n - 1); Model.spaceOut();
        return { moved, sheet: n, note: 'Nets that continue on another sheet are shown with net labels (connected by name).' };
      });
      case 'disconnect': return Model.mutate(() => { Model.disconnect(input.pins || []); return { ok: true }; });
      case 'rename_net': return Model.mutate(() => { Model.renameNet(input.from, input.to); return { ok: true }; });
      case 'auto_layout': Model.mutate(() => Model.autoLayout()); env.ui('fit-sch'); return { ok: true };
      case 'organize_schematic': Model.mutate(() => Model.organize()); env.ui('fit-sch'); return { ok: true, note: 'Check it with view_design {view: "schematic"}' };
      case 'clear_design': Model.mutate(() => Model.clear()); return { ok: true };
      case 'web_search': return api('/api/web/search?' + new URLSearchParams({ q: input.query || '', n: input.max_results || 8 }), { headers: env.searchKey && env.searchKey() ? { 'X-Brave-Key': env.searchKey() } : {} });
      case 'web_fetch': { const r = await api('/api/web/fetch?' + new URLSearchParams({ url: input.url || '', offset: input.offset || 0, length: input.max_chars || 12000 })); return r; }
      case 'use_database_parts': return useDatabaseParts(input.refs);
      case 'match_jlcpcb_parts': return matchJlcpcb(!!input.overwrite);
      case 'get_enclosure': {
        if (Enclosure.mode() === 'custom') { const r = await runShape(Enclosure.script()); env.ui('show-enc'); return Object.assign({ mode: 'custom', process: Enclosure.params().process, shapes: Enclosure.params().shapes.length ? Enclosure.params().shapes : undefined, script: input.script === false ? `(${Enclosure.script().length} characters, not shown)` : Enclosure.script() }, r); }
        const d = Enclosure.describe(); env.ui('show-enc'); return d;
      }
      case 'enclosure_script_help': {
        const ctx = shapeContext(), id = input.template || input.example;
        const t = id && (Shape3D.TEMPLATES.find(x => x.id === id) || (Shape3D.EXAMPLES[id] && { id, code: Shape3D.EXAMPLES[id] }));
        return { api: Shape3D.HELP, pcb: ctx.pcb, templates: Shape3D.TEMPLATES.map(x => ({ id: x.id, group: x.cat, name: x.name, about: x.desc })), template_params: Shape3D.PARAMS, batteries: Enclosure.BATTERIES.map(b => b.id).join(', '), fast_kernel: Shape3D.fast, template: t ? { id: t.id, code: t.code } : undefined, example: t ? undefined : { id: 'wrist-whoop', code: Shape3D.TEMPLATES[0].code } };
      }
      case 'set_enclosure_script': {
        let code = String(input.code || ''), changed = null;
        if (input.template) code = Shape3D.fromTemplate(input.template, input.params || {});
        else if (!code && (input.patch || input.vars)) { if (!Enclosure.script()) throw new Error('no script yet to patch — send code or a template first'); const r = patchScript(Enclosure.script(), input); code = r.code; changed = r.done; }
        else if (input.params && Object.keys(input.params).length) throw new Error('params go with template (e.g. {template: "wrist-whoop", params: {battery: "lipo-402030"}})');
        if (!code.trim()) throw new Error('give template (+ params) or code');
        Model.mutate(() => Enclosure.setParams({ mode: 'custom', script: code }));
        const r = await runShape(code); env.ui('show-enc');
        if (input.template) r.template = { id: input.template, params: input.params || {}, note: 'to change more: set_enclosure_script {patch: [{find, replace}]} or {vars: {name: value}} edits this script in place; enclosure_script_help {template} shows it' };
        if (changed) r.changed = changed;
        return r.ok ? Object.assign(r, await encPicture(input)) : r;
      }
      case 'jlc3dp_quote': case 'jlccnc_quote': {
        if (Enclosure.mode() !== 'custom') {
          if (name === 'jlccnc_quote') return { parts: [], note: 'Box mode has no sheet-metal parts. Custom 3D: electrode({…}) makes skin plates.' };
          const proc = input.process || Enclosure.params().process, d = Shape3D.checkBox(Enclosure.build(), shapeContext(), { process: proc, rules: Enclosure.params().rules, cap: 15000, openPts: 1 });
          return { site: 'https://jlc3dp.com/3d-printing-quote', parts: ['base', 'lid'].map(n => ({ name: n, too_small: (d.too_small || []).find(x => x.part === n) || null, thin: d.thin.filter(x => x.part === n).slice(0, 4) })), price: 'upload the STLs on the site' };
        }
        // the material picked on JLC3DP sets the limits its site warns with (and its wording)
        const MAT = { pa12: ['mjf', 'MJF PA12-HP Nylon', 1.2, 1.0], pa11: ['mjf', 'MJF PA11-HP Nylon', 1.2, 1.0], 'sls-nylon': ['sls', 'SLS Nylon', 1.2, 1.0], 'resin-9600': ['sla', 'SLA resin 9600', 0.8, 0.6], 'ledo-6060': ['sla', 'SLA LEDO 6060 resin', 0.8, 0.6], 'black-resin': ['sla', 'SLA Black resin', 0.8, 0.6], tpu: ['mjf', 'MJF TPU', 1.5, 1.2], pla: ['fdm', 'FDM PLA', 1.2, 0.8] };
        const mat = name === 'jlc3dp_quote' && input.material ? MAT[input.material] : null;
        if (name === 'jlc3dp_quote' && input.material && !mat) throw new Error('material: ' + Object.keys(MAT).join(', '));
        const proc = mat ? mat[0] : input.process || Enclosure.params().process, PR = Shape3D.PROCESSES[proc] || Shape3D.PROCESSES.mjf;
        const o = { process: proc, rules: Object.assign({}, Enclosure.params().rules, mat ? { minWall: Math.max(+(Enclosure.params().rules || {}).minWall || 0, mat[2]) } : {}), shapes: Enclosure.params().shapes, step: true, dfmCap: 20000, dfmOpenPts: 2000 };
        let r; try { r = env.shape ? await env.shape(Enclosure.script(), o) : Shape3D.run(Enclosure.script(), shapeContext(), Object.assign({ mesh: false }, o)); } catch (e) { return { ok: false, error: e.message }; }
        const d = r.report.dfm || { thin: [], knife_edges: [], too_small: [] };
        if (name === 'jlc3dp_quote') {
          const max = { mjf: [380, 284, 380], sls: [400, 400, 400], sla: [1000, 600, 500], fdm: [300, 300, 300] }[proc] || [380, 284, 380];
          const parts = r.parts.filter(p => (p.kind || 'print') === 'print').map(p => {
            const sz = p.size_mm.slice().sort((a, b) => a - b), mx = max.slice().sort((a, b) => a - b), small = (d.too_small || []).find(x => x.part === p.name), big = sz.some((v, k) => v > mx[k]);
            const thin = d.thin.filter(x => x.part === p.name), knives = d.knife_edges.filter(x => x.part === p.name), lips = (d.edge_lips || []).filter(x => x.part === p.name);
            const msgs = [], warnAt = mat ? mat[2] : PR.wall, refuseAt = mat ? mat[3] : PR.wall, all = thin.concat(lips), worst = all.length ? Math.min(...all.map(x => x.min_mm)) : null;
            if (small) msgs.push(`refused: ${sz.map(v => v.toFixed(1)).join(' × ')} mm is below the ${PR.name} minimum ${small.min_mm.join(' × ')} mm`);
            if (big) msgs.push(`larger than the ${PR.name} build volume ${max.join(' × ')} mm: manual quote or split it`);
            if (all.length) msgs.push(`JLC3DP will show "wall thickness < ${warnAt} mm"${mat ? ` for ${mat[1]}` : ''} on ${all.length} area(s), thinnest ${worst} mm${worst < refuseAt ? ` — under ${refuseAt} mm it may refuse the part` : ''}`);
            if (thin.length) msgs.push(`thin walls: ${thin.slice(0, 3).map(x => `${x.min_mm} mm at (${x.at.map(v => (+v).toFixed(1)).join(', ')})${x.feature ? ` under ${x.feature} — ${x.fix}` : ''}`).join('; ')}`);
            if (lips.length) msgs.push(`edge lips (thin strips along an open edge, e.g. where a curved underside meets an end cut): ${lips.slice(0, 3).map(x => `${x.min_mm} mm, ${x.area_mm2} mm² at (${x.at.join(', ')})`).join('; ')} — round or thicken that edge`);
            if (knives.length) msgs.push(`${knives.length} knife edge(s): they show red and may break`);
            return { name: p.name, size_mm: p.size_mm, volume_cm3: p.volume_cm3, status: small || big || (worst != null && worst < refuseAt) ? 'refused / manual' : all.length || knives.length ? 'accepted with warnings' : 'ok', messages: msgs };
          });
          return { process: PR.name, material: mat ? mat[1] : undefined, limits: { warns_under_mm: mat ? mat[2] : PR.wall, refuses_under_mm: mat ? mat[3] : PR.wall }, site: 'https://jlc3dp.com/3d-printing-quote', parts,
            material_advice: proc === 'sla' ? 'Resin: smooth and detailed but brittle, not for skin all day — LEDO 6060 to wear for testing, Black resin for display' : proc === 'fdm' ? 'PLA / PETG' : 'PA12-HP Nylon (or PA11-HP for skin-worn parts), Black, Dyeing — tough, slightly flexible, skin-safe',
            price: 'Upload the STLs (export_enclosure {for: "jlc3dp"}) on the site for the price — CircuitPilot\'s JLC API access covers PCBs only.' };
        }
        const metal = r.parts.filter(p => p.kind === 'metal');
        if (!metal.length) return { parts: [], note: 'No sheet-metal parts in this design (electrode({…}) makes skin plates).' };
        const verdict = (ck, ent, stepLen) => {
          const why = ck.issues.slice();
          if (ent && ent.LINE + ent.ARC + ent.CIRCLE > 300) why.push(`${ent.LINE + ent.ARC + ent.CIRCLE} outline pieces (keep arcs as arcs)`);
          if (stepLen > 1e6) why.push(`STEP ${(stepLen / 1e6).toFixed(1)} MB`);
          return { status: why.length ? 'manual review likely' : 'automatic quote expected', messages: why };
        };
        const ents = dxf => { const e = { LINE: 0, ARC: 0, CIRCLE: 0 }; for (const m of String(dxf || '').matchAll(/\n0\n(LINE|ARC|CIRCLE)\n/g)) e[m[1]]++; return e; };
        const parts = metal.map(p => {
          const tk = input.thickness || p.sheet_mm || 0.5, ck = input.thickness ? Shape3D.sheetCheck(p.flat, tk) : (p.check || Shape3D.sheetCheck(p.flat, tk)), ent = ents(p.dxf);
          return Object.assign({ name: p.name, size_mm: p.size_mm.slice(0, 2), sheet_mm: tk, dxf: ent, step_kb: +((p.step || '').length / 1024).toFixed(1), web_min_mm: ck.web_min_mm, slot_min_mm: ck.slot_min_mm, lanced_tab: !!(p.flat && (p.flat.open || []).length) }, verdict(ck, ent, (p.step || '').length));
        });
        const J = r.report.joined, tk0 = input.thickness || metal[0].sheet_mm || 0.5;
        const joined = J ? Object.assign({ size_mm: J.size, bars: J.bars, dxf: ents(J.dxf), step_kb: +(J.step.length / 1024).toFixed(1), web_min_mm: J.check.web_min_mm, slot_min_mm: J.check.slot_min_mm, note: 'ORDER THIS ONE: all plates as one part on 5 mm bars — one order line, even pricing; snip the bars at the red lines of the snip guide' }, verdict(input.thickness ? Shape3D.sheetCheck({ loops: J.loops, open: J.open }, tk0) : J.check, ents(J.dxf), J.step.length)) : null;
        return { site: 'https://jlccnc.com', joined_part: joined, parts,
          order: `Sheet metal, laser cutting only. Material: Stainless steel 304 (316 for long skin contact) — the site starts on Aluminium 5052: change it. Thickness ${tk0} mm. Finish: ${tk0 < 1 ? 'none (JLCCNC brushes only 1.0 mm and thicker)' : 'brushing or none'} — no powder coat / anodizing (it insulates the electrodes). Remark: "Laser cut only. Cut every line; no bend lines."`,
          gold_pcb: 'Or as gold PCB electrodes (solderable, skin-friendly ENIG): export_electrodes {as: "pcb"}',
          price: 'Upload the joined part\'s STEP + DXF (export_enclosure {for: "jlccnc"}) on the site for the price — CircuitPilot\'s JLC API access covers PCBs only.' };
      }
      case 'export_cnc_gcode': {
        const { files, info } = Cnc.job(input);
        if (env.saveFiles) await env.saveFiles(files, (Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-cnc.zip');
        return Object.assign({ ok: true }, info);
      }
      case 'export_electrodes': {
        const list = plates(); if (!list.length) return { ok: false, error: 'No electrode plates in this design — electrode({…}) in the 3D script makes them.' };
        if ((input.projects || []).length) return { ok: false, error: 'Merging projects works through the MCP tools (CircuitPilot tools in Claude Code / Desktop).' };
        const { files, info } = electrodeFiles(list, input);
        if (env.saveFiles) await env.saveFiles(files, (Model.S.name || 'design').replace(/[^\w.-]+/g, '_') + '-electrodes.zip');
        return Object.assign({ ok: true, files: Object.keys(files), readme: files['README-gold-electrodes.txt'] || files['README-JLCCNC.txt'] }, info);
      }
      case 'check_enclosure': {
        // the full check (finer than the one after every build) for one process, with the thickness heatmap
        if (input.process) Model.mutate(() => Enclosure.setParams({ process: input.process }));
        const proc = Enclosure.params().process;
        let d;
        if (Enclosure.mode() === 'custom') {
          if (!Enclosure.script()) throw new Error('No enclosure script yet');
          const r = await runShape(Enclosure.script(), { dfmCap: 40000, dfmOpenPts: 10000, dfmSpacing: 0.4, timeLimitMs: 110000 });
          if (!r.ok) return r; d = r.manufacturability;
        } else d = dfmSummary(Shape3D.checkBox(Enclosure.build(), shapeContext(), { process: proc, rules: Enclosure.params().rules, cap: 40000, openPts: 10000, spacing: 0.4 }));
        env.ui('show-enc');
        const out = { process: proc, manufacturability: d, ok: !!d && !d.thin_walls.length && !(d.edge_lips || []).length && !(d.too_small || []).length && !d.knife_edges.length && !d.narrow_slits.length && !d.fit.some(x => !x.ok) && !d.openings.some(x => !x.expected) };
        if (env.render && input.preview !== false) { try { const img = await env.render({ view: 'enclosure', overview: true, thickness: true, size: 'small', enc: Model.S.enclosure }); if (img && img.data) Object.assign(out, { __image: { mime: img.mime, data: img.data }, picture: 'wall thickness heatmap: red = below the minimum wall, orange = under 1.5 ×, grey = fine' }); } catch (e) { } }
        return out;
      }
      case 'list_batteries': {
        const L = Enclosure.batteries(Object.assign({}, input, { verbose: !!input.notes }));
        return { batteries: L, count: L.length, note: 'Capacities are typical market values — check the seller\'s datasheet. LiPo sizes: TTWWLL = thickness in 0.1 mm (10 = 10 mm), width, length (mm). Rechargeable cells need a Li-ion charger IC on the board (TP4054 / MCP73831, 4.2 V) — coin LIR cells at ≤ 0.5 C. Primary CR coins give only a few mA continuous.' };
      }
      case 'set_enclosure': {
        const { preview, ...u } = input;
        if (u.battery && typeof u.battery === 'string' && u.battery.trim().startsWith('{')) u.battery = JSON.parse(u.battery);
        const r = Model.mutate(() => Enclosure.setParams(u)); env.ui('show-enc');
        const out = { outer_mm: r.outer_mm, base_height: r.base_height, cutouts: r.cutouts ? r.cutouts.length : undefined, battery: r.battery || undefined, params: r.params };
        if (Enclosure.mode() === 'custom' && ('shapes' in u || 'rules' in u || 'process' in u)) return Object.assign({ mode: 'custom', shapes: Enclosure.params().shapes.length }, await runShape(Enclosure.script()), await encPicture(input));
        return (r.mode || 'box') === 'box' ? Object.assign(out, await encPicture(input)) : out;
      }
      case 'add_enclosure_cutout': { const r = Model.mutate(() => Enclosure.addCutout(input)); env.ui('show-enc'); return r; }
      case 'remove_enclosure_cutout': return Model.mutate(() => { const E = Object.assign({}, Model.S.enclosure || {}), c = (E.cutouts || []).slice(); const n = c.length; if (input.index != null) c.splice(+input.index, 1); else c.length = 0; E.cutouts = c; Model.S.enclosure = E; env.ui('show-enc'); return { removed: n - c.length }; });
      case 'add_mounting_holes': { const r = Model.mutate(() => Pcb.addMountingHoles(input)); return r; }
      case 'get_pcb_layout': {
        // compact by default: footprints with the chosen fields; outline, pins, labels, unrouted lists only when asked (include)
        const S = Model.S, idx = Model.pinIndex(), inc = new Set(input.include || []), want = input.refs && input.refs.length ? new Set(input.refs) : null, reg = input.region;
        const F = new Set(input.fields && input.fields.length ? input.fields : want ? ['x', 'y', 'rot', 'side', 'size', 'nets'] : ['x', 'y', 'rot', 'side', 'size']);
        if (input.pins === true || (want && input.pins !== false)) inc.add('pins');
        const inReg = c => !reg || (c.pcb.x >= Math.min(reg[0], reg[2]) && c.pcb.x <= Math.max(reg[0], reg[2]) && c.pcb.y >= Math.min(reg[1], reg[3]) && c.pcb.y <= Math.max(reg[1], reg[3]));
        const fp = Pcb.placed().filter(c => (!want || want.has(c.ref)) && inReg(c)).map(c => {
          const pads = Pcb.padsOf(c, idx), b = Pcb.fpBox(c), o = { ref: c.ref };
          const all = { value: c.value, type: c.type, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot || 0, side: Pcb.isBottom(c) ? 'bottom' : 'top', box: b.map(v => +v.toFixed(2)), size: [+(b[2] - b[0]).toFixed(2), +(b[3] - b[1]).toFixed(2)],
            edge: c.pcbEdge || (Pcb.edgeInfo(c) ? 'connector' : null), locked: !!c.pcb.locked, nets: [...new Set(pads.map(p => p.net).filter(Boolean))], margin: Pcb.partMargin(c) };
          for (const f of F) if (f in all) o[f] = all[f];
          if (inc.has('pins') && pads.length <= 80) o.pins = pads.filter(p => p.net).map(p => [p.num, p.net, +p.x.toFixed(2), +p.y.toFixed(2)]);
          return o;
        });
        const conn = Pcb.connectivity(), out = { board: Pcb.boardBrief(), footprints: fp, status: Pcb.status(conn) };
        if (inc.has('outline')) out.outline = Pcb.boardPoly().map(q => q.map(v => +v.toFixed(3)));
        if (inc.has('unrouted')) out.unrouted = Object.entries(conn).filter(([, v]) => !v.complete).map(([net, v]) => ({ net, islands: v.groups.map(g => g.map(p => `${p.key}@(${p.x.toFixed(1)},${p.y.toFixed(1)})`)) }));
        if (inc.has('pours') || input.pour_pieces) out.pours = (S.pcb.pours || []).map((p, i) => { const r = Pcb.pourInfo(p); return { index: i, net: p.net, layer: p.layer, what: Pcb.describePour(p), islands: r.islands, removed_islands: r.removed || undefined, pieces: input.pour_pieces ? Pcb.pourIslands(p) : undefined }; });
        if (inc.has('keepouts') || Pcb.keepouts().length && !input.include) out.keepouts = Pcb.keepouts().map((k, i) => ({ index: i, name: k.name, layer: k.layer === 'both' ? 'both' : k.layer === 'B' ? 'bottom' : 'top', box: [Math.min(...k.pts.map(q => q[0])), Math.min(...k.pts.map(q => q[1])), Math.max(...k.pts.map(q => q[0])), Math.max(...k.pts.map(q => q[1]))].map(v => +v.toFixed(2)), no: ['tracks', 'vias', 'pours', 'parts'].filter(f => k[f]), follows: k.ref || k.epRef || undefined, auto: k.auto || undefined }));
        if (inc.has('silk')) out.silk_labels = Pcb.silkInfo();
        if (S.notes) out.notes = S.notes;
        return out;
      }
      case 'place_footprints': {
        const list = Array.isArray(input.placements) ? input.placements : [];
        if (!list.length) throw new Error('placements is empty');
        const r = Model.mutate(() => {
          const errs = [];
          for (const p of list) { try { Pcb.placeFootprint(p.ref, p); } catch (e) { errs.push(`${p.ref}: ${e.message}`); } }
          // only the listed parts move (overlap fixes and refinement too); everything else is held where it is
          const mine = new Set(list.map(p => Model.comp(p.ref) && Model.comp(p.ref).ref)), held = Pcb.placed().filter(c => !mine.has(c.ref) && !c.pcb.locked && !input.move_others);
          for (const c of held) c.pcb.locked = true;
          let leg;
          try {
            leg = Pcb.legalisePlacement();
            if (input.refine) { Pcb.anneal({ time_s: 2, hot: 0.12, seed: 99 }); leg = Pcb.legalisePlacement(); }
          } finally { for (const c of held) delete c.pcb.locked; }
          // tracks of the moved parts' nets are removed (the rest stays)
          const idx = Model.pinIndex(), nets = new Set(); for (const r of mine) { const c = Model.comp(r); if (c && c.pcb) for (const p of Pcb.padsOf(c, idx)) if (p.net) nets.add(p.net); }
          Model.S.pcb = Object.assign({}, Model.S.pcb, { traces: Model.S.pcb.traces.filter(t => t.manual || !nets.has(t.net)), vias: Model.S.pcb.vias.filter(v => v.manual || !nets.has(v.net)), routed: {} });
          // real problems of the placed parts only: pads too close, copper off the board, keep-outs (courtyard touches are fine)
          const probs = Pcb.checkPlacement([...mine], 0, 0.25).filter(q => q.type !== 'overlap' || q.pads_clear === false).map(q => q.msg);
          return { placed: list.length - errs.length, errors: errs, problems: probs.length ? probs : undefined };
        });
        let routing = null;
        if (input.route) { const rr = env.route ? await env.route({ opt: {} }) : { routing: Model.mutate(() => Pcb.route()) }; routing = rr.routing; }
        env.ui('show-pcb');
        return Object.assign(r, routing ? { routing: { routed: routing.routed, total: routing.total, failed: routing.failed } } : { note: 'Tracks of the moved parts were removed — call route_pcb (or route_pcb {nets})' });
      }
      case 'add_copper_pour': return Model.mutate(() => Pcb.addPour({ net: input.net, layer: input.layer === 'bottom' ? 'B' : input.layer === 'both' ? 'both' : 'F', points: input.points, rect: input.rect, clip: input.clip, clearance: input.clearance }));
      case 'lock_tracks': return Model.mutate(() => {
        const P = Model.S.pcb, ix = new Set((input.tracks || []).map(Number)); Pcb.trackIds(); const ids = new Set((input.ids || []).map(x => String(x).toLowerCase()));
        if (!input.net && !ix.size && !ids.size && !input.all) throw new Error('Give net, ids, tracks (indexes) or all: true');
        const pick = (x, i) => input.all || (input.net && x.net === input.net) || ids.has(x.id) || (x.pts && ix.has(i));
        let n = 0;
        const set = x => { if (input.unlock) { if (x.locked) { delete x.locked; delete x.manual; n++; } } else if (!x.manual) { x.manual = true; x.locked = true; n++; } };
        P.traces.forEach((t, i) => { if (pick(t, i)) set(t); });
        P.vias.forEach(v => { if (input.all || (input.net && v.net === input.net) || ids.has(v.id)) set(v); });
        return { [input.unlock ? 'unlocked' : 'locked']: n, note: input.unlock ? undefined : 'Locked copper is kept by route_pcb; remove_tracks still deletes it' };
      });
      case 'add_track': { const r = Model.mutate(() => Pcb.addTrack(input)); env.ui('show-pcb'); return r; }
      case 'add_via': return Model.mutate(() => Pcb.addVia(input));
      case 'connect_pads_to_pour': return Model.mutate(() => Pcb.connectPadsToPour(input));
      case 'get_tracks': {
        // filters: net, layer, region [x0,y0,x1,y1], near (a pad "U2.9" or a part "U2"), vias_only
        const r = Pcb.trackList(input.net ? { net: input.net } : {}), reg = input.region, idx = Model.pinIndex();
        const inR = (x, y) => !reg || (x >= Math.min(reg[0], reg[2]) && x <= Math.max(reg[0], reg[2]) && y >= Math.min(reg[1], reg[3]) && y <= Math.max(reg[1], reg[3]));
        let nearPads = null;
        if (input.near) { const s0 = String(input.near), c = Model.comp(s0.split('.')[0]); if (!c || !c.pcb) throw new Error(`${s0.split('.')[0]} is not on the PCB`); nearPads = Pcb.padsOf(c, idx).filter(p => !s0.includes('.') || p.key === c.ref + '.' + s0.split('.')[1] || p.num === s0.split('.')[1]); }
        const nearOk = x => !nearPads || nearPads.some(p => Pcb.touchesPad(x, p));
        const layer = input.layer ? (/^b/i.test(input.layer) ? 'bottom' : 'top') : null;
        const tracks = input.vias_only ? [] : r.tracks.filter(t => (!layer || t.layer === layer) && t.points.some(q => inR(q[0], q[1])) && nearOk({ net: t.net, pts: t.points, w: t.width }));
        const vias = r.vias.filter(v => inR(v.x, v.y) && nearOk({ net: v.net, x: v.x, y: v.y, d: v.diameter }));
        return { tracks: input.summary ? undefined : tracks, vias: input.summary ? undefined : vias, counts: { tracks: tracks.length, vias: vias.length, length_mm: +tracks.reduce((a, t) => a + t.length_mm, 0).toFixed(1) } };
      }
      case 'remove_tracks': return Model.mutate(() => {
        if (input.rect || input.near) {   // area / part: resolve to indexes first
          const S = Model.S, rr = input.rect, idx = Model.pinIndex(), only = input.only;
          const inR = (x, y) => !rr || (x >= Math.min(rr[0], rr[2]) && x <= Math.max(rr[0], rr[2]) && y >= Math.min(rr[1], rr[3]) && y <= Math.max(rr[1], rr[3]));
          let pads = null; if (input.near) { const s0 = String(input.near), c = Model.comp(s0.split('.')[0]); if (!c || !c.pcb) throw new Error(`${s0.split('.')[0]} is not on the PCB`); pads = Pcb.padsOf(c, idx).filter(p => !s0.includes('.') || p.num === s0.split('.')[1]); }
          // near: only copper of the pad's own net that really touches it (not a neighbour's track passing close by)
          const near = x => !pads || pads.some(p => Pcb.touchesPad(x, p));
          const okType = x => !only || (only === 'manual' ? !!x.manual : !x.manual), okNet = x => !input.net || x.net === input.net;
          Pcb.trackIds(); const ids = [];
          S.pcb.traces.forEach(t => { if (okType(t) && okNet(t) && t.pts.some(q => inR(q[0], q[1])) && near(t)) ids.push(t.id); });
          S.pcb.vias.forEach(v => { if (okType(v) && okNet(v) && inR(v.x, v.y) && near(v)) ids.push(v.id); });
          if (!ids.length) return { removed_tracks: 0, removed_vias: 0 };
          return Pcb.removeTracks({ ids, dry_run: input.dry_run });
        }
        return Pcb.removeTracks(input);
      });
      case 'stitch_pour': return Model.mutate(() => Pcb.stitchPour(input));
      case 'add_thermal_vias': return Model.mutate(() => Pcb.addThermalVias(input));
      case 'jlcpcb_parts': {
        const codes = (Array.isArray(input.codes) && input.codes.length ? input.codes : [...new Set(Model.S.components.map(c => Model.lcscOf(c)).filter(Boolean))]).slice(0, 50);
        if (!codes.length) throw new Error('No LCSC part numbers (give codes, or add parts with LCSC numbers)');
        const r = await api('/api/jlc/parts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codes }) });
        if (r.code !== 200) throw new Error(`JLCPCB API ${r.code}: ${r.message || 'no answer'}`);
        return (r.data || []).map(p => ({ code: p.componentCode, part: p.componentModel, brand: p.componentBrandEn, package: p.componentSpecification, library: p.libraryType === 'base' ? 'Basic' : p.libraryType === 'expand' ? 'Extended' : p.libraryType, stock: p.stockCount ?? p.stock ?? p.componentStock, price: (p.priceRanges || []).slice(0, 4).map(x => `${x.startQuantity}+: $${x.unitPrice}`).join(', '), description: p.description }));
      }
      case 'jlcpcb_quote': {
        const S = Model.S;
        let ext = null;
        if (input.gerber_zip) {
          if (!env.readGerberZip) throw new Error('gerber_zip works through the MCP tools (a file on this machine)');
          ext = await env.readGerberZip(String(input.gerber_zip));
          const w = +input.width || ext.size[0], h = +input.height || ext.size[1];
          if (!(w > 0 && h > 0)) throw new Error('Could not read the board size from the zip (no outline layer) — pass width and height');
          ext.param = Object.assign(Pcb.jlcPcbParam(input), { width: +(+w).toFixed(2), length: +(+h).toFixed(2), layer: +input.layers || ext.layers || 2, plateType: 1 });
        } else if (!S.board.w || !Pcb.placed().length) throw new Error('No PCB yet — generate_pcb first');
        const name = ext ? String(input.gerber_zip).split(/[\\/]/).pop().replace(/[^\w.-]+/g, '_') : (S.name || 'board').replace(/[^\w.-]+/g, '_').slice(0, 60) + '-gerbers.zip';
        const up = await api('/api/jlc/pcb/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/zip' }, body: ext ? new Blob([ext.data], { type: 'application/zip' }) : makeZip(Pcb.gerbers()) });
        if (up.code !== 200 || !up.data) throw new Error(`JLCPCB did not accept the Gerbers (${up.code}: ${up.message || 'no file key'})`);
        let country = input.country; if (!country) { try { country = (await api('/api/jlc/address')).country; } catch (e) { } }
        const body = { orderType: 1, pcbParam: ext ? ext.param : Pcb.jlcPcbParam(input), achieveDate: 96, fileKey: up.data, country: String(country || 'EG').toUpperCase() };
        const q = await api('/api/jlc/pcb/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (q.code !== 200) throw new Error(`JLCPCB could not price it (${q.code}: ${q.message})`);
        const d = q.data || {};
        return { board: ext ? `${body.pcbParam.width} × ${body.pcbParam.length} mm, ${body.pcbParam.layer} layers (${name})` : `${S.board.w} × ${S.board.h} mm, ${body.pcbParam.layer} layers${body.pcbParam.plateType === 7 ? ', flex' : ''}`, qty: body.pcbParam.qty, pcb_price_usd: d.priceWithoutFreight, special_offer: !!(d.pcbCostInfo && d.pcbCostInfo.specialFlag),
          build_time: (d.achieveDateList || []).map(x => `${x.achieveName} (${x.achieveDate} h)${+x.achievePrice ? ' +$' + x.achievePrice : ''}`),
          shipping_to: body.country, shipping: (d.shipList || []).filter(x => x.day).map(x => `${x.showOptions}: $${(+x.cost).toFixed(2)}, ${x.day}`),
          note: 'To order: the user presses "Order at JLCPCB" in CircuitPilot (prices live, places the order, pays at JLCPCB).' };
      }
      case 'set_flex': { const r = Model.mutate(() => Pcb.setFlex(input)); env.ui('show-pcb'); return r; }
      case 'add_keepout': { const r = Model.mutate(() => Pcb.addKeepout(input)); env.ui('show-pcb'); return r; }
      case 'remove_keepout': return Model.mutate(() => Pcb.removeKeepout(input));
      case 'place_in_free_area': { const r = Model.mutate(() => Pcb.placeFree(input.refs, { ...input, try_other_side: !input.side, sheet_boards: true })); env.ui('show-pcb'); return r; }
      case 'check_placement': { const r = Pcb.checkPlacement(input.refs, +input.gap || 0, input.tolerance != null ? +input.tolerance : 0.25, { show_accepted: !!input.show_accepted, courtyard: !!input.courtyard }); return { ok: !r.length, problems: r.slice(), accepted_overlaps: r.acceptedCount || undefined, accepted: r.accepted }; }
      case 'mark_overlap_ok': return Model.mutate(() => Pcb.markOverlapOk(input.pairs, !!input.remove));
      case 'edge_margins': return Pcb.edgeMargins({ refs: input.refs, all: !!input.all });
      case 'transform_parts': { const r = Model.mutate(() => Pcb.transformParts(input)); env.ui('show-pcb'); return r; }
      case 'save_pour_template': return Model.mutate(() => Pcb.savePourTemplate());
      case 'apply_pour_template': return Model.mutate(() => Pcb.applyPourTemplate());
      case 'firmware_pins': return Firmware.info();
      case 'get_firmware': return Firmware.get();
      case 'set_firmware': return Firmware.set(input);
      case 'set_project_notes': return Model.mutate(() => {
        const S = Model.S, N = Object.assign({ text: '', values: {} }, S.notes || {});
        if (input.text != null) N.text = input.append && N.text ? N.text + '\n' + input.text : String(input.text);
        if (input.values) { N.values = Object.assign({}, N.values, input.values); for (const [k, v] of Object.entries(input.values)) if (v === null) delete N.values[k]; }
        S.notes = N; return N;
      });
      case 'get_project_notes': return Model.S.notes || { text: '', values: {} };
      case 'reroute': {
        // the whole recipe in one call: pours off → copper off → power nets first, then the rest → pours back → stitching vias → labels → DRC
        const S = Model.S, t0 = Date.now(), R = Pcb.rules(), log = [];
        if (!S.board.w || !Pcb.placed().length) throw new Error('No PCB yet — generate_pcb first');
        const pours = (S.pcb.pourTemplate && S.pcb.pourTemplate.length ? S.pcb.pourTemplate : S.pcb.pours || []).map(p => JSON.parse(JSON.stringify(p)));
        Model.mutate(() => { S.pcb.pours = []; S.pcb.traces = S.pcb.traces.filter(t => t.manual); S.pcb.vias = S.pcb.vias.filter(v => v.manual); S.pcb.routed = {}; });
        const routeWith = async opt => env.route ? (await env.route({ place: null, opt })).routing : Model.mutate(() => Pcb.route(opt));
        const first = (input.first || ['GND', '+3V3']).filter(n => S.nets[n]);
        const budget = +(input.time_limit_s || R.routeTime || 90);
        // the "first" nets are routed together (they negotiate with rip-up among themselves), before everything else
        if (first.length) { const r = await routeWith({ onlyNets: first, keep: true, keepAll: true, time_limit_s: Math.max(15, budget / 3) }); for (const n of first) log.push(`${n}: ${r && r.failed && r.failed.includes(n) ? 'failed' + (r.failed_reason && r.failed_reason[n] ? ' — ' + r.failed_reason[n] : '') : 'ok'}`); }
        const rest = await routeWith({ keep: true, keepAll: true, time_limit_s: budget });
        Model.mutate(() => { S.pcb.pours = pours.filter(p => S.nets[p.net]); });
        let stitched = 0;
        if (input.stitch !== false) for (const net of [...new Set(pours.map(p => p.net))]) if (pours.some(p => p.net === net && p.layer === 'F') && pours.some(p => p.net === net && p.layer === 'B')) { try { stitched += Model.mutate(() => Pcb.stitchPour({ net, max_spacing: input.stitch_spacing })).added; } catch (e) { log.push('stitch ' + net + ': ' + e.message); } }
        // joins pour pieces that the tracks cut off (the router's pour pass)
        const conn = Pcb.connectivity(), broken = Object.keys(conn).filter(n => !conn[n].complete);
        if (broken.length) await routeWith({ onlyNets: broken, keep: true, keepAll: true, time_limit_s: 20 });
        const stale = input.keep_dangling_vias ? [] : Model.mutate(() => Pcb.removeDanglingVias()); if (stale.length) log.push(`${stale.length} via${stale.length > 1 ? 's' : ''} that joined nothing removed (${[...new Set(stale.map(v => v.net))].join(', ')})`);
        const lab = input.labels === false ? null : Model.mutate(() => Pcb.arrangeSilk({ hide: input.labels !== 'keep' }));
        const st = Pcb.status(), d = Pcb.drc(), by = {}; for (const v of d.violations) by[v.type] = (by[v.type] || 0) + 1;
        env.ui('show-pcb');
        const line = `${st.routed}/${st.nets} nets routed, ${st.vias} vias (${stitched} stitching), ${st.trace_length_mm} mm of track · DRC ${d.summary} · ${((Date.now() - t0) / 1000).toFixed(0)} s`;
        return { summary: line, unrouted: st.unrouted.length ? st.unrouted : undefined, failed_reason: rest && rest.failed_reason, drc: by, labels: lab ? { hidden: lab.hidden.length, shrunk: lab.shrunk.length } : undefined, steps: log.length ? log : undefined };
      }
      case 'copy_block': {
        const r = Model.mutate(() => Blocks.insert(Blocks.extract(input.refs), input));
        return Object.assign(r, { erc: Model.erc().length ? Model.erc().slice(0, 10) : 'ok' });
      }
      case 'remove_copper_pour': return Model.mutate(() => { const P = Model.S.pcb.pours || []; const before = P.length; Model.S.pcb.pours = P.filter((p, i) => !(input.index != null ? i === +input.index : input.net ? p.net === input.net : true)); return { removed: before - Model.S.pcb.pours.length }; });
      case 'set_board_shape': return Model.mutate(() => Pcb.setBoardShape(input));
      case 'make_panel': return Model.mutate(() => Pcb.setPanel(input));
      case 'add_pcb_line': return Model.mutate(() => Pcb.addLine(input));
      case 'remove_pcb_line': return Model.mutate(() => Pcb.removeLine(Math.round(+input.index)));
      case 'board_code': return Model.mutate(() => {
        Pcb.ensureFabId();
        const o = {}; for (const k of ['size', 'x', 'y', 'hidden', 'auto']) if (input[k] != null) o[k] = input[k]; if (input.side) o.side = input.side === 'top' ? 'F' : 'B';
        if (Object.keys(o).length) Pcb.setSilkLabel('code', o);
        const revs = Pcb.fabRevisions().filter(r => r.code === Pcb.fabCode()), last = revs[revs.length - 1];
        return { printed: Pcb.fabLabelText(), code: Pcb.fabCode(), label: Model.S.pcb.fabLabel || {}, revisions: revs.map(r => ({ rev: r.rev, made: new Date(r.at * 1000).toISOString(), via: r.via, current: r.current })), next_export: last ? (last.current ? 'R' + last.rev + ' (design unchanged)' : 'R' + (last.rev + 1) + ' (design changed since R' + last.rev + ')') : 'R1' };
      });
      case 'list_pcbs': return { open: Pcb.activePcb() + 1, pcbs: Pcb.pcbList().map(p => ({ pcb: p.index + 1, name: p.name, open: p.active, sheets: p.sheets, parts: p.parts, board_mm: p.board, layers: p.layers, rules: p.preset })) };
      case 'add_pcb': return Model.mutate(() => { const k = Pcb.addPcb(input.name); Pcb.selectPcb(k + 1); return { opened: k + 1, pcbs: Pcb.pcbList().map(p => ({ pcb: p.index + 1, name: p.name, sheets: p.sheets })) }; });
      case 'select_pcb': return Model.mutate(() => { Pcb.selectPcb(input.pcb); const p = Pcb.pcbList()[Pcb.activePcb()]; return { open: p.index + 1, name: p.name, sheets: p.sheets, parts: p.parts, board_mm: p.board }; });
      case 'set_sheet_pcb': return Model.mutate(() => ({ pcbs: Pcb.setSheetPcb(input.sheet, input.pcb).map(p => ({ pcb: p.index + 1, name: p.name, sheets: p.sheets, parts: p.parts })) }));
      case 'rename_pcb': return Model.mutate(() => { Pcb.renamePcb(input.pcb, input.name); return { pcbs: Pcb.pcbList().map(p => ({ pcb: p.index + 1, name: p.name })) }; });
      case 'set_sheet_board': {
        const n = Math.round(+input.sheet) - 1, sh = (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]).map(x => Object.assign({}, x));
        if (!(n >= 0 && n < sh.length)) throw new Error('No sheet ' + input.sheet + ' (the design has ' + sh.length + ')');
        const regs = Pcb.boardRegions(), b = String(input.board || '').trim();
        if (b && regs.length && !regs.some(r => r.name === b)) throw new Error('No board ' + b + ' on the PCB (boards: ' + regs.map(r => r.name).join(', ') + ')');
        Model.mutate(() => { if (b) sh[n].board = b; else delete sh[n].board; Model.S.sheets = sh; });
        return { sheets: sh.map((x, i) => ({ sheet: i + 1, name: x.name || 'Sheet ' + (i + 1), board: x.board || null })), boards: regs.map(r => ({ name: r.name, box: [r.x0, r.y0, r.x1, r.y1].map(v => +v.toFixed(2)) })), note: regs.length < 2 ? 'The PCB has one board so far: make_panel (or an outline with break-off tabs) makes several' : undefined };
      }
      case 'generate_pcb': case 'route_pcb': {
        const S = Model.S, selectedNets = name === 'route_pcb' && Array.isArray(input.nets) && input.nets.length;
        const existingBoard = S.board.w > 0 && S.board.h > 0;
        const sameSize = (input.board_width == null || +input.board_width === S.board.w)
          && (input.board_height == null || +input.board_height === S.board.h);
        if ((name === 'generate_pcb' && existingBoard && (input.keep_placement || (!input.start_over && !input.auto_size && sameSize && Pcb.placed().length)))
            || (name === 'route_pcb' && !selectedNets && Pcb.pendingFootprints().length)) {
          return exec('update_pcb_from_schematic', { route: input.route, time_limit_s: input.time_limit_s }, mode);
        }
        const place = name === 'generate_pcb' ? { w: input.board_width, h: input.board_height, fit: !!input.auto_size } : null;
        const noRoute = input.route === false, ropt = input.time_limit_s ? { time_limit_s: +input.time_limit_s } : {};
        let r;
        // only some nets: their unlocked copper is ripped up and routed again, everything else stays as it is
        if (selectedNets) {
          const bad = input.nets.filter(n => !Model.S.nets[n]); if (bad.length) throw new Error('No net ' + bad.join(', '));
          if (Pcb.pendingFootprints().length) {
            const sync = Model.mutate(() => Pcb.syncFromSchematic());
            if (sync.no_room.length) return Object.assign(sync, { note: 'Make room for the unplaced parts before routing.' });
          }
          Model.mutate(() => { const P = Model.S.pcb, only = new Set(input.nets); P.traces = P.traces.filter(t => t.manual || !only.has(t.net)); P.vias = P.vias.filter(v => v.manual || !only.has(v.net)); });
          Object.assign(ropt, { onlyNets: input.nets.slice(), keep: true, keepAll: true });
        }
        // a full route runs with the copper pours off and puts them back afterwards (pours fill around the new tracks);
        // then the pads the pours no longer reach are joined by a short pass. Routing chosen nets keeps the pours:
        // that pass uses them to join cut-off pads
        const full = !noRoute && !ropt.onlyNets, pours0 = full ? (Model.S.pcb.pours || []).map(q => JSON.parse(JSON.stringify(q))) : [];
        if (pours0.length) Model.mutate(() => { Model.S.pcb.pours = []; });
        // one copper layer: a net with a pour on it is joined by the pour — its tracks would only wall the other nets
        // in. The other nets are routed first; the pass after the pours are back joins only the pads the pour misses
        const pourNets = full && Pcb.rules().layers === 1 ? [...new Set(pours0.map(q => q.net))].filter(n => Model.S.nets[n]) : [];
        if (pourNets.length) { Model.mutate(() => { const P = Model.S.pcb; P.traces = P.traces.filter(t => t.manual || !pourNets.includes(t.net)); }); ropt.onlyNets = Object.keys(Model.S.nets).filter(n => !pourNets.includes(n)); }
        const unroutedNow = () => Pcb.status().unrouted.filter(n => !pourNets.includes(n));
        try {
          if (env.route) r = await env.route({ place, opt: Object.assign({ noRoute }, ropt) });
          else r = Model.mutate(() => {
            const placement = place ? Pcb.autoPlace(place) : undefined;
            return { placement, routing: noRoute || placement?.fits === false ? null : Pcb.route(ropt) };
          });
          // auto-size on one copper layer: every track runs between the parts, so a board packed to the parts can be too
          // small to route — then 25 % bigger, placed and routed again (twice at most)
          for (let k = 0; place && place.fit && !noRoute && Pcb.rules().layers === 1 && k < 2 && (r.placement?.fits === false || unroutedNow().length); k++) {
            const was = [Model.S.board.w, Model.S.board.h], p2 = { w: +(was[0] * 1.25).toFixed(1), h: +(was[1] * 1.25).toFixed(1) };
            if (env.route) r = await env.route({ place: p2, opt: Object.assign({ noRoute }, ropt) });
            else r = Model.mutate(() => {
              const placement = Pcb.autoPlace(p2);
              return { placement, routing: placement.fits === false ? null : Pcb.route(ropt) };
            });
            if (r) r.grown = `1 layer: ${was.join(' x ')} mm did not route, board made ${p2.w} x ${p2.h} mm`;
          }
        } finally { if (pours0.length) Model.mutate(() => { Model.S.pcb.pours = pours0.filter(q => Model.S.nets[q.net]); }); }
        if (pours0.length && r.placement?.fits !== false) {
          // stitching vias are automatic (the route replaced them): put them back where a net has pours on both layers
          if (input.stitch !== false) for (const net of [...new Set(pours0.map(q => q.net))]) if (pours0.some(q => q.net === net && q.layer === 'F') && pours0.some(q => q.net === net && q.layer === 'B')) { try { Model.mutate(() => Pcb.stitchPour({ net })); } catch (e) { } }
          const conn = Pcb.connectivity(), broken = Object.keys(conn).filter(n => !conn[n].complete);
          if (broken.length) { const o2 = { onlyNets: broken, keep: true, keepAll: true, time_limit_s: 20 }; if (env.route) await env.route({ place: null, opt: o2 }); else Model.mutate(() => Pcb.route(o2)); }
          if (r && r.routing) Object.assign(r.routing, { pours: 'removed while routing and put back', still_unrouted: Pcb.status().unrouted });
        }
        let stale = [];
        if (!noRoute && !input.keep_dangling_vias) { stale = Model.mutate(() => Pcb.removeDanglingVias(ropt.onlyNets)); }
        env.ui('show-pcb');
        const d = Pcb.drc();
        return Object.assign({}, r, { dangling_vias_removed: stale.length ? stale : undefined, drc: { summary: d.summary, top: d.violations.filter(v => v.severity === 'error').slice(0, 8).map(v => v.msg) } });
      }
      case 'update_pcb_from_schematic': {
        const sync = Model.mutate(() => Pcb.syncFromSchematic()), todo = Pcb.status().unrouted;
        const routeWith = async opt => {
          if (input.time_limit_s) opt.time_limit_s = input.time_limit_s;
          return env.route ? env.route({ place: null, opt }) : Model.mutate(() => Pcb.route(opt));
        };
        const rerouted = input.route !== false && !sync.no_room.length && !sync.no_footprint.length ? todo : [];
        if (rerouted.length) await routeWith({ keep: true, keepAll: true, onlyNets: rerouted });
        env.ui('show-pcb');
        const st = Pcb.status(), d = Pcb.drc();
        const note = sync.no_room.length ? 'Make room for the unplaced parts before routing.'
          : sync.no_footprint.length ? 'Assign footprints before routing.' : undefined;
        return Object.assign(sync, { rerouted, routed: st.routed, total: st.nets, unrouted: st.unrouted, drc: d.summary, note });
      }
      case 'place_footprint': { const r = Model.mutate(() => Pcb.placeFootprint(input.ref, input)); env.ui('show-pcb'); return Object.assign(r, { note: 'Tracks are kept; run route_pcb to connect anything left unrouted.' }); }
      case 'view_design': {
        if (!env.render) throw new Error('Screenshots need the CircuitPilot app open in a browser.');
        const v = input.view;
        if (!['schematic', 'pcb', 'pcb_3d', 'enclosure'].includes(v)) throw new Error('view must be schematic, pcb, pcb_3d or enclosure');
        if (v !== 'schematic' && !(Model.S.board.w && Pcb.placed().length)) throw new Error('No PCB yet — run generate_pcb first');
        if (v === 'schematic' && !Model.S.components.length) throw new Error('The schematic is empty');
        const img = await env.render(v === 'enclosure' ? Object.assign({ enc: Model.S.enclosure }, input) : input);
        if (!img || !img.data) throw new Error('Nothing to show for ' + v);
        const what = { schematic: `schematic sheet ${input.sheet || 1}`, pcb: `2D PCB layout (${Model.S.board.w} × ${Model.S.board.h} mm; red = top copper, blue = bottom, yellow = unrouted)`, pcb_3d: `3D board, ${input.side || 'iso'} view`, enclosure: (input.overview ? '3D enclosure, 4 views: angled · exploded · cut in half · from below' : `3D enclosure${input.exploded ? ', exploded' : ''}${input.angle ? ', ' + input.angle + ' view' : ''}${input.section ? `, cut along ${input.section} at ${input.at || 0} mm` : ''}`) + (input.thickness ? ' · wall thickness heatmap (red = too thin)' : '') }[v];
        return { __image: { mime: img.mime, data: img.data }, shown: what, size_px: [img.w, img.h] };
      }
      case 'get_documentation': {
        const S = Model.S, d = Object.assign({ title: S.name || 'Untitled', subtitle: '', version: '1.0', company: '', description: '', features: '', applications: '', notes: '' }, S.doc || {});
        const lib = c => (c.lcsc && S.lib[c.lcsc]) || null, placed = S.components.filter(c => c.pcb);
        return {
          documentation: d,
          facts: {
            board: S.board.w ? `${S.board.w} x ${S.board.h} mm, ${Pcb.rules().layers}-layer` : 'no PCB yet',
            parts: S.components.length,
            main_parts: S.components.filter(c => ['part', 'ic', 'regulator', 'opamp'].includes(c.type)).map(c => `${c.ref}: ${c.value}${lib(c) ? ` (${[lib(c).manufacturer, lib(c).mfr_part || lib(c).name].filter(Boolean).join(' ')})` : ''}`),
            connectors: S.components.filter(c => c.type === 'connector' || /^(J|USB|CN|P)\d+$/i.test(c.ref)).map(c => `${c.ref}: ${c.value}`),
            power_rails: Object.keys(S.nets).filter(n => Model.isPower(n) && !Model.isGround(n)),
            routed: placed.length ? Pcb.status().routed + '/' + Pcb.status().nets + ' nets' : null,
          },
          note: 'Specifications, schematic, PCB renders, mechanical drawing, pinouts, enclosure and BOM are generated from the design. The PDF is made in the app: Documentation tab → PDF.',
        };
      }
      case 'set_documentation': {
        const keys = ['title', 'subtitle', 'version', 'company', 'description', 'features', 'applications', 'notes'], u = {};
        for (const k of keys) if (input[k] != null) u[k] = Array.isArray(input[k]) ? input[k].map(s => String(s).replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean).join('\n') : String(input[k]);
        if (!Object.keys(u).length) throw new Error('Pass at least one of: ' + keys.join(', '));
        Model.mutate(() => { Model.S.doc = Object.assign({}, Model.S.doc || {}, u); });
        env.ui('show-doc');
        return { ok: true, updated: Object.keys(u), note: 'Shown live in the Documentation tab; the PDF button there exports the datasheet.' };
      }
      case 'get_design_rules': {
        const R = Pcb.rules();
        const L = Pcb.pcbList();
        return { pcb: L.length > 1 ? L[Pcb.activePcb()].name : undefined, other_pcbs: L.length > 1 ? L.filter(p => !p.active).map(p => ({ pcb: p.index + 1, name: p.name, layers: p.layers, preset: p.preset })) : undefined, rules: R, warnings: Pcb.ruleWarnings(R), presets: Object.fromEntries(Object.entries(Pcb.RULE_PRESETS).map(([k, v]) => [k, v.label])), note: 'JLCPCB defaults; check jlcpcb.com/capabilities for current limits' };
      }
      case 'set_design_rules': {
        const u = Object.assign({}, input); if (u.net_widths) { u.netWidths = u.net_widths; delete u.net_widths; } delete u.all_pcbs;
        return Model.mutate(() => input.all_pcbs ? Pcb.setRulesAll(u) : Pcb.setRules(u));
      }
      case 'run_drc': {
        // counts + the first violations; full: true lists up to 80, types filters
        const d = Pcb.drc({ as: input.as }), by = {}; for (const v of d.violations) by[v.type] = (by[v.type] || 0) + 1;
        let v = d.violations.slice().sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
        if (input.types && input.types.length) v = v.filter(x => input.types.includes(x.type));
        const n = input.full ? 80 : +(input.limit || 5);
        return { summary: d.summary, errors: d.errors, warnings: d.warnings, by_type: by, violations: v.slice(0, n).map(x => input.full ? x : { type: x.type, severity: x.severity, msg: x.msg.split(' — ')[0], at: x.x != null ? [x.x, x.y] : undefined }), more: v.length > n ? v.length - n : undefined };
      }
      case 'create_part':
      case 'update_part': {
        const old = name === 'update_part' ? (Model.S.lib[input.key] || env.myLib().find(p => p.key === input.key)) : null;
        if (name === 'update_part' && !old) throw new Error(`No part "${input.key}" in this design or My Library`);
        const def = Object.assign({}, old || {}, {
          key: old ? old.key || input.key : newKey(input.name),
          name: input.name || (old && old.name) || 'Part',
          prefix: String(input.prefix || (old && old.prefix) || 'U').replace(/[^A-Za-z]/g, '') || 'U',
          value: input.value || (old && old.value) || input.name,
          pins: input.pins ? normPins(input.pins) : old.pins,
          footprint: input.footprint ? withBody(buildFootprint(input.footprint)) : old.footprint,
        });
        // mechanical data for the enclosure: body size / height and connector positions (F17)
        if (input.mech) { const m = input.mech; if (m.body && !(+m.body.w > 0 && +m.body.l > 0)) throw new Error('mech.body needs w and l (mm)'); def.mech = { body: m.body ? { w: +m.body.w, l: +m.body.l, h: +m.body.h || 0 } : undefined, connectors: (m.connectors || []).map(k => ({ type: String(k.type || 'connector'), side: k.side || 'pin1', w: +k.w || undefined, h: +k.h || undefined, z: k.z != null ? +k.z : undefined, out: k.out != null ? +k.out : undefined, at: k.at != null ? +k.at : undefined })) }; }
        if (!old) def.custom = true;
        const dup = def.pins.map(p => p.num).find((n, i, a) => a.indexOf(n) !== i); if (dup) throw new Error(`Pin number ${dup} is used twice`);
        const used = Model.mutate(() => Model.setLibPart(def.key, def));
        let saved = false;
        if (input.save_to_library !== false) { try { await env.savePart(def); saved = true; } catch (e) { } }
        const padNums = new Set((def.footprint.pads || []).map(p => p.num));
        return { ...(name === 'create_part' ? { add_components_input: { components: [{ lcsc: def.key }] } } : {}),
          key: def.key, pins: def.pins.length, pads: def.footprint.pads.length, placed_instances_updated: used, saved_to_library: saved, pins_without_pad: def.pins.filter(p => !padNums.has(p.num)).map(p => p.num) };
      }
      case 'set_knowledge_folder': {
        const path = String(input.path || '').trim();
        if (path) { const j = await api('/api/knowledge/list?' + new URLSearchParams({ path })); Model.mutate(() => { Model.S.knowledge = { path: j.folder }; }); return { folder: j.folder, files: j.files.map(f => f.file) }; }
        Model.mutate(() => { delete Model.S.knowledge; }); return { ok: true, cleared: true };
      }
      case 'knowledge_list': { const j = await kApi('list'); return { folder: j.folder, files: j.files }; }
      case 'knowledge_read': return kApi('read', { file: input.file, offset: input.offset || 0 });
      case 'knowledge_search': return kApi('search', { q: input.query, limit: input.limit || 12 });
    }
  }

  // ---------- database parts behind built-in symbols ----------
  async function useDatabaseParts(refs) {
    const S = Model.S, todo = S.components.filter(c => c.type !== 'part' && !c.pinMap && (!refs || refs.includes(c.ref)) && Lib.dbDefault(c.type, c.value));
    const done = [], failed = [];
    for (const c of todo) {
      try { const part = await loadPart(Lib.dbDefault(c.type, c.value).lcsc); const ok = Model.mutate(() => Model.attachDb(Model.comp(c.ref), part)); (ok ? done : failed).push(c.ref + (ok ? ' → ' + part.lcsc + ' ' + (part.footprint && part.footprint.name) : ' (pins did not match)')); }
      catch (e) { failed.push(c.ref + ': ' + e.message); }
    }
    return { converted: done, failed, skipped: S.components.filter(c => c.type !== 'part' && !c.pinMap && !Lib.dbDefault(c.type, c.value)).map(c => c.ref + ' (' + c.type + ', keeps its standard footprint)') };
  }
  // value → JLCPCB part number for the BOM (keeps the footprint; prefers in-stock Basic parts in the same package)
  async function matchJlcpcb(overwrite) {
    const S = Model.S, out = [];
    const pkgOf = c => { const l = c.dbfp && c.footprint === 'LCSC:' + c.dbfp && S.lib[c.dbfp]; const t = [(l && l.package) || '', (l && l.footprint && l.footprint.name) || '', c.footprint].join(' ').toUpperCase(); const m = t.match(/\b(0201|0402|0603|0805|1206|1210|2512|SOD-?123F?|SOD-?323|SMA|SMB|SOT-?23(-\d)?|SOT-?223|SOIC-?\d+|SOP-?\d+|TSSOP-?\d+|QFN-?\d+)\b/); return m ? m[1] : ''; };
    const norm = (t, v) => { v = String(v).trim(); if (t === 'resistor' && /^[\d.]+[kKmMR]?$/.test(v)) return v.replace(/R$/, '') + (/[kKmM]$/.test(v) ? 'Ω' : 'Ω'); if (/capacitor/.test(t) && /^[\d.]+[pnuμ]$/.test(v)) return v.replace('u', 'µ') + 'F'; if (t === 'inductor' && /^[\d.]+[nuμ]$/.test(v)) return v.replace('u', 'µ') + 'H'; return v; };
    // parts with a manufacturer part number but no LCSC number (own parts, connectors, ICs): an exact part-number match
    const squash = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    async function byMpn(c) {
      const l = c.type === 'part' ? S.lib[c.lcsc] || {} : {}, tries = [...new Set([l.mpn, l.mfr_part, l.part, l.name, c.mpn, c.value].filter(x => x && squash(x).length >= 4))];
      for (const t of tries) {
        const j = await partsApi('search?q=' + encodeURIComponent(t) + '&limit=20');
        const hit = (j.results || []).filter(r => squash(r.mfr_part) === squash(t)).sort((a, b) => (b.stock > 0) - (a.stock > 0) || (b.basic - a.basic) || (b.stock - a.stock))[0];
        if (hit) return hit;
      }
      return null;
    }
    for (const c of S.components) {
      if (c.type === 'part' || ['connector', 'battery', 'ic'].includes(c.type)) {
        const have = Model.lcscOf(c);
        if (have && !overwrite) { out.push({ ref: c.ref, lcsc: have, source: c.type === 'part' ? 'database part' : 'kept' }); continue; }
        try {
          const hit = await byMpn(c);
          if (hit) { Model.mutate(() => { Model.comp(c.ref).lcscPart = hit.lcsc; }); out.push({ ref: c.ref, value: c.value, lcsc: hit.lcsc, part: hit.mfr_part, package: hit.package, stock: hit.stock, source: 'exact part number' + (hit.stock > 0 ? '' : ' (out of stock)') }); }
          else out.push({ ref: c.ref, value: c.value, lcsc: null, source: 'no LCSC part with exactly this part number — choose it (search_parts) and set it with update_component {lcsc_part}' });
        } catch (e) { out.push({ ref: c.ref, lcsc: null, source: e.message }); }
        continue;
      }
      if (c.lcscPart && !overwrite) {
        const d = Lib.dbDefault(c.type, c.value);
        const same = d && d.lcsc === c.lcscPart && (d.byValue || String(c.value).toLowerCase() === String(d.value).toLowerCase());
        if (!d || d.lcsc !== c.lcscPart || same) { out.push({ ref: c.ref, value: c.value, lcsc: c.lcscPart, source: 'kept' }); continue; }
      }
      const pkg = pkgOf(c), q = `${norm(c.type, c.value)} ${pkg}`.trim();
      try {
        const j = await partsApi('search?q=' + encodeURIComponent(q) + '&limit=20');
        const ok = j.results.filter(r => r.stock > 0 && (!pkg || String(r.package || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(pkg.toUpperCase().replace(/[^A-Z0-9]/g, ''))));
        const best = ok.sort((a, b) => (b.basic - a.basic) || (b.stock - a.stock))[0];
        if (best) { Model.mutate(() => { Model.comp(c.ref).lcscPart = best.lcsc; }); out.push({ ref: c.ref, value: c.value, lcsc: best.lcsc, part: best.mfr_part, package: best.package, basic: !!best.basic, stock: best.stock }); }
        else out.push({ ref: c.ref, value: c.value, lcsc: null, source: `no in-stock match for "${q}"` });
      } catch (e) { out.push({ ref: c.ref, lcsc: null, source: e.message }); }
    }
    const miss = out.filter(o => !o.lcsc);
    return { matched: out.length - miss.length, total: out.length, missing: miss.length ? miss.map(o => o.ref) : undefined, parts: out };
  }

  // Knowledge digest for the AI system prompt (cached per folder).
  const digests = {};
  async function knowledgeDigest(force) {
    const p = Model.S.knowledge && Model.S.knowledge.path; if (!p) return null;
    if (!digests[p] || force) digests[p] = await api('/api/knowledge/digest?' + new URLSearchParams({ path: p, budget: 24000 }));
    return digests[p];
  }

  function designContext() {
    const S = Model.S;
    if (!S.components.length) return 'CURRENT DESIGN: empty.';
    const sum = Model.summary();
    const shs = S.sheets && S.sheets.length > 1 ? S.sheets : null, sheetOfRef = r => { const c = Model.comp(r); return c ? Model.sheetOf(c) + 1 : 1; };
    let txt = (S.notes && (S.notes.text || Object.keys(S.notes.values || {}).length) ? 'PROJECT NOTES (from the designer — follow them):\n' + (S.notes.text || '') + (Object.keys(S.notes.values || {}).length ? '\n' + JSON.stringify(S.notes.values) : '') + '\n' : '') + 'CURRENT DESIGN:\n' + (shs ? `Sheets: ${shs.map((s, i) => `${i + 1}=${s.name}`).join(', ')}\n` : '') + sum.components.map(c => `${c.ref} ${c.lcsc ? 'part ' + c.lcsc : c.type} "${c.value}" @(${c.x},${c.y})${shs ? ' sheet' + sheetOfRef(c.ref) : ''} rot${c.rot} fp=${c.footprint} | ${c.pins}`).join('\n');
    const st = Pcb.status();
    txt += `\nPCB: ${st.placed ? `board ${st.board.w}x${st.board.h}mm, ${st.routed}/${st.nets} nets routed` : 'not generated'}`;
    if (txt.length > 12000) txt = txt.slice(0, 12000) + '\n…(truncated — call get_design for the rest)';
    return txt;
  }

  // ---------- compact mode for small local models (the fine-tuned CircuitPilot 4B, or any 2–8B model) ----------
  // The full tool list is ~23k tokens — too much for a small model's context and speed. Compact mode sends the core
  // design tools with short descriptions and a short system prompt. The fine-tune data (finetune/) is made with exactly
  // this, so keep them in step: change LITE here, then make the dataset again.
  const LITE_NAMES = ['search_parts', 'get_part', 'get_design', 'add_components', 'create_part', 'update_component', 'remove_components', 'connect', 'disconnect', 'rename_net',
    'add_sheet', 'organize_schematic', 'run_erc', 'generate_pcb', 'update_pcb_from_schematic', 'route_pcb', 'pcb_status', 'run_drc', 'get_pcb_layout', 'place_footprint',
    'place_in_free_area', 'check_placement', 'set_board_shape', 'add_mounting_holes', 'add_copper_pour', 'add_track', 'add_via', 'remove_tracks',
    'get_design_rules', 'set_design_rules', 'match_jlcpcb_parts', 'web_search'];
  const LITE_SYSTEM = `You are CircuitPilot, an electronics engineer inside a schematic + PCB design app. You change the design only by calling tools.
- Pins are "REF.PIN" with the pin number or name ("R1.1", "Q1.B", "U1.VCC"). Built-in pin numbers: resistor / capacitor / inductor 1, 2; LED / diode 1 = K (cathode), 2 = A (anode); electrolytic 1 = +, 2 = -; npn / pnp 1 = B, 2 = E, 3 = C; nmos / pmos 1 = G, 2 = S, 3 = D; regulator 1 = IN, 2 = GND, 3 = OUT; opamp 2 = IN-, 3 = IN+, 4 = V-, 6 = OUT, 7 = V+; battery 1 = +, 2 = -; potentiometer 1, 2 = wiper, 3.
- Ground is the net GND; supplies are +3V3, +5V, +12V, VIN, VBAT. Give important signals clear names (OUT, LED_A, SDA, SCL).
- Real ICs, modules and connectors: search_parts, then get_part, then add_components with {"lcsc": "Cxxxx"}, and connect with the pin names get_part returned. Simple parts (resistor, capacitor, LED, diode, transistor) use the built-in types with a value and footprint (0603 by default).
- In add_components, give every part a type or lcsc. For a generic header use {"type":"connector","pins":["SIG","GND"],"footprint":"PinHeader_1x2"}. List pins in number order.
- Exact add_components JSON: ${addExample}. Replace LIB_EXAMPLE with the returned key. For a real part, use get_part.add_components_input and omit type and footprint. If a chip has no library entry, use create_part with verified pins and pads, then send its add_components_input to add_components.
- For a My Library part, use its exact key in "lcsc": if get_design shows "LIB:LIB_EXAMPLE", send {"lcsc":"LIB_EXAMPLE"}.
- Build in this order: add every part in ONE add_components call, connect every net in ONE connect call, then run_erc and fix what it reports.
- PCB: generate_pcb (once, for a new board), then run_drc. For routing failures, inspect the placement and adjust the parts around the affected nets.
- Schematic changed after the PCB exists (parts added / removed, nets or footprints changed): update_pcb_from_schematic — it auto-places new parts inside the outline on either usable side and routes incomplete nets. If a part cannot fit, make room or enlarge the outline.
- When a tool returns an error, read it and call again with the fix; do not repeat the same call.
- Questions about a chip, module or part number: answer only from what search_parts / get_part (or web_search) returned — never from memory. If they found nothing, say so.
- Use real values and show the key calculation in one line (e.g. R = (5 - 2.0) / 0.01 = 300 → 330 Ω). Keep replies short.`;
  const LITE_MODE = {
    agent: 'MODE: AGENT — you may change the design.',
    ask: 'MODE: ASK — read-only: inspect the design with the tools you have and answer; do not try to change anything.',
    plan: 'MODE: PLAN — do not change anything. Write a short plan: parts (ref, type, value, footprint), connections (net: pins), steps. End with: press **Execute plan** to build it.',
  };
  const short = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const cut = t.slice(0, n); const k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; ')); return (k > n * 0.45 ? cut.slice(0, k + 1) : cut.replace(/\s+\S*$/, '') + ' …'); };
  const shortSchema = s => {
    if (!s || typeof s !== 'object') return s;
    if (Array.isArray(s)) return s.map(shortSchema);
    const o = {}; for (const [k, v] of Object.entries(s)) o[k] = k === 'description' && typeof v === 'string' ? short(v, 90) : shortSchema(v);
    return o;
  };
  let liteCache = null;
  const liteTools = () => liteCache || (liteCache = LITE_NAMES.map(n => TOOLS.find(t => t.name === n)).filter(Boolean).map(t => Object.assign({ name: t.name, description: short(t.description, 230), input_schema: shortSchema(t.input_schema) }, t.ro ? { ro: true } : {}, t.web ? { web: true } : {})));
  const LITE = { names: LITE_NAMES, system: LITE_SYSTEM, mode: LITE_MODE, tools: liteTools };

  return { LITE, env, TOOLS, exec, enclosureFiles, plates, electrodeFiles, useDatabaseParts, matchJlcpcb, loadPart, partsApi, api, designContext, knowledgeDigest, newKey };
})();
if (typeof module !== 'undefined') module.exports = Engine;
