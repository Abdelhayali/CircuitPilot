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
  const TOOLS = [
    { name: 'search_parts', ro: true, description: 'Search real components by part number or keywords, e.g. "ESP32-C3", "AMS1117 3.3", "USB-C 16pin", "10k 0603". Searches the JLCPCB catalogue (stock, price, Basic/Extended), the EasyEDA official library (about 1.6 million LCSC parts incl. modules), the EasyEDA community library (user-made parts, keys EE-…), the open KiCad-format libraries — KiCad official, SparkFun, Digi-Key (keys OL:…; custom parts without LCSC number, check the footprint) — and My Library at once; only parts that have a footprint are returned. Returns LCSC codes (Cxxxx) / library keys. Prefer in-stock JLCPCB parts and Basic parts; source "easyeda" parts have no stock data (C99… codes are library placeholders, not orderable).', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 10, max 30' } } } },
    { name: 'get_part', ro: true, description: 'Load a database part (LCSC code) or a My Library part (key): returns its exact pin list (number:name) and PCB footprint. Call before adding it with add_components {lcsc}.', input_schema: { type: 'object', required: ['lcsc'], properties: { key: { type: 'string', description: 'a My Library part key instead of an LCSC code' },  lcsc: { type: 'string', description: 'LCSC code (e.g. C2838502) or library key (LIB_...)' } } } },
    { name: 'get_design', ro: true, description: 'Return the full current design: every component (type, value, position, footprint, pins as num:name=net) and all nets.', input_schema: { type: 'object', properties: {} } },
    { name: 'list_parts', ro: true, description: 'List the built-in component types with their pins (number:name), default value and footprints.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'add_components', description: 'Add one or more components to the schematic. Returns the assigned refs. Overlapping placements are nudged automatically.',
      input_schema: {
        type: 'object', required: ['components'], properties: {
          components: {
            type: 'array', items: {
              type: 'object', properties: {
                type: { type: 'string', enum: types, description: 'Built-in type. Omit when using lcsc.' },
                lcsc: { type: 'string', description: 'LCSC code of a database part, or key of a My Library / custom part. Gives the real pinout and footprint.' },
                ref: { type: 'string', description: 'Optional reference designator, e.g. R1. Auto-assigned if omitted.' },
                value: { type: 'string', description: 'Part value or part number, e.g. 10k, 100n, NE555' },
                x: { type: 'number', description: 'Schematic X (grid 10). Typical spacing between parts 80-160.' },
                y: { type: 'number', description: 'Schematic Y (down is positive).' },
                rot: { type: 'number', enum: [0, 90, 180, 270] },
                sheet: { type: 'number', description: 'schematic sheet number (1 = first sheet; see add_sheet)' },
                pins: { type: 'array', items: { type: 'string' }, description: 'ONLY for type "ic" or "connector": pin names in pin-number order (index 0 = pin 1).' },
                footprint: { type: 'string', description: 'Optional footprint: ' + Lib.FOOTPRINT_PATTERNS.join(', ') }
              }
            }
          }
        }
      }
    },
    { name: 'update_component', description: 'Change a component in the SCHEMATIC: value, schematic position/rotation, footprint, pins (ic/connector) or rename it. For PCB placement use place_footprint.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, value: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, footprint: { type: 'string' }, pins: { type: 'array', items: { type: 'string' } }, new_ref: { type: 'string' } } } },
    { name: 'remove_components', description: 'Delete components (and their connections).', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'connect', description: 'Create connections. Each entry puts the listed pins on the named net (created if needed). If a pin is already on another net, that net is merged in. Name ground "GND" and supply rails like "VCC", "+5V", "+3V3", "+12V", "VBAT" — these are drawn as power symbols.', input_schema: { type: 'object', required: ['connections'], properties: { connections: { type: 'array', items: { type: 'object', required: ['net', 'pins'], properties: { net: { type: 'string' }, pins: pinList } } } } } },
    { name: 'disconnect', description: 'Remove pins from whatever net they are on.', input_schema: { type: 'object', required: ['pins'], properties: { pins: pinList } } },
    { name: 'rename_net', description: 'Rename a net (merges if the new name exists).', input_schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'add_sheet', description: 'Add a schematic sheet (multi-page schematic), e.g. Power, MCU, Sensors, Connectors. Returns its number. Nets connect across sheets by name (shown as net labels).', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'move_to_sheet', description: 'Move components to a schematic sheet (1 = first). The sheet is re-arranged and spaced automatically.', input_schema: { type: 'object', required: ['refs', 'sheet'], properties: { refs: { type: 'array', items: { type: 'string' } }, sheet: { type: 'number' } } } },
    { name: 'auto_layout', description: 'Automatically arrange all schematic components based on connectivity.', input_schema: { type: 'object', properties: {} } },
    { name: 'run_erc', ro: true, description: 'Run the electrical rule check: unconnected pins, single-pin nets, missing ground, overlapping symbols.', input_schema: { type: 'object', properties: {} } },
    { name: 'clear_design', description: 'Delete everything in the current project and start an empty design.', input_schema: { type: 'object', properties: {} } },
    { name: 'generate_pcb', description: 'Create the PCB: place all footprints on a board (based on schematic positions) and autoroute with a 2-layer router. Returns routing statistics. keep_placement: true keeps the parts where they already are (only new parts are placed) and just routes — much faster on a custom outline.', input_schema: { type: 'object', properties: { keep_placement: { type: 'boolean' },  board_width: { type: 'number', description: 'mm, optional (auto-sized if omitted)' }, board_height: { type: 'number', description: 'mm, optional' }, auto_size: { type: 'boolean', description: 'size the board to the parts; by default an existing board outline is kept and parts are fitted inside it' }, route: { type: 'boolean', description: 'default true' }, time_limit_s: { type: 'number', description: 'autorouter effort in seconds (default 90)' } } } },
    { name: 'web_search', ro: true, web: true, description: 'Search the internet (datasheets, application notes, reference designs, prices, availability, how-tos, anything else you need). Returns titles, URLs and snippets; read pages with web_fetch.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max_results: { type: 'number', description: 'default 8, max 20' } } } },
    { name: 'web_fetch', ro: true, web: true, description: 'Read a web page or PDF (e.g. a datasheet) as text. Long documents are paged: call again with offset = previous offset + returned length while "more" is true.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, offset: { type: 'number' }, max_chars: { type: 'number', description: 'default 12000, max 40000' } } } },
    { name: 'use_database_parts', description: 'Give built-in schematic symbols (resistor, LED, transistor, regulator, ...) the footprint and pinout of a real JLCPCB part (Basic parts where possible). Without refs: every built-in part that still uses a generated footprint.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'match_jlcpcb_parts', description: 'Find JLCPCB/LCSC part numbers for every component value (e.g. 4.7k 0603, 22uF 0805) for an assembly BOM; prefers in-stock Basic parts with the same package.', input_schema: { type: 'object', properties: { overwrite: { type: 'boolean' } } } },
    { name: 'get_enclosure', ro: true, description: 'The 3D-printable enclosure fitted to the PCB: outer size, heights, standoffs, every cutout (automatic ones for edge connectors / LEDs / buttons and custom ones), estimated part heights and all parameters.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_enclosure', description: 'Change enclosure parameters (mm). mode: "box" (this parametric box) or "custom" (the free-form 3D script, see set_enclosure_script). Box parameters: wall, floor, lidThickness, clearance, pcbThickness, topClearance, extraHeight, standoffHeight, standoffDiameter, screwHole, lidFit, lipHeight, lipWidth, vents, ventWidth, ventLength, ventSpacing, autoConnectorCutouts, autoLidHoles, partHeights ({ref: mm}). Opens the Enclosure tab.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['box', 'custom'] }, wall: { type: 'number' }, floor: { type: 'number' }, lidThickness: { type: 'number' }, clearance: { type: 'number' }, pcbThickness: { type: 'number' }, topClearance: { type: 'number' }, extraHeight: { type: 'number' }, standoffHeight: { type: 'number' }, standoffDiameter: { type: 'number' }, screwHole: { type: 'number' }, lidFit: { type: 'number' }, lipHeight: { type: 'number' }, lipWidth: { type: 'number' }, vents: { type: 'boolean' }, ventWidth: { type: 'number' }, ventLength: { type: 'number' }, ventSpacing: { type: 'number' }, autoConnectorCutouts: { type: 'boolean' }, autoLidHoles: { type: 'boolean' }, partHeights: { type: 'object', additionalProperties: { type: 'number' } } } } },
    { name: 'add_enclosure_cutout', description: 'Add an opening to the enclosure. side = left | right | front | back (walls; u = mm along the wall from its centre, z = mm above the bed, default 4 mm above the PCB) or lid | floor (x, y in enclosure coordinates = board x, minus board y). shape rect or circle.', input_schema: { type: 'object', required: ['side', 'width'], properties: { side: { type: 'string', enum: ['left', 'right', 'front', 'back', 'lid', 'floor'] }, shape: { type: 'string', enum: ['rect', 'circle'] }, width: { type: 'number' }, height: { type: 'number' }, u: { type: 'number' }, z: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } } } },
    { name: 'remove_enclosure_cutout', description: 'Remove a custom enclosure cutout by index (see get_enclosure), or all custom cutouts when index is omitted.', input_schema: { type: 'object', properties: { index: { type: 'number' } } } },
    { name: 'enclosure_script_help', ro: true, description: 'Docs for custom 3D enclosures: the 3D script API and the enclosure kit (envelope, outlines, soft solids, wrist curve, strap lugs, electrodes, clips, loops, lid with lip…), coordinates relative to the PCB, the PCB context, and a catalogue of 35 tested templates (10 wrist, 10 chest/ECG, 7 other body-worn, 8 boxes). Pass template: <id> to get that script. Call this before writing set_enclosure_script.', input_schema: { type: 'object', properties: { example: { type: 'string' },  template: { type: 'string', description: 'template id from the catalogue, e.g. wrist-whoop, chest-ecg3' } } } },
    { name: 'set_enclosure_script', description: 'Design a free-form 3D-printable enclosure / housing / wearable (wristband pod, chest patch, clip, curved or organic case …) as a JavaScript 3D script (see enclosure_script_help). Saves the script in the project, switches the Enclosure tab to custom mode, builds it and returns each part (size, volume, watertightness) plus a fit report: collisions of the printed parts with the PCB or components (fix all of them) and script errors with line numbers. Exports: one STL per part + OpenSCAD source.', input_schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: 'the full 3D script' } } } },
    { name: 'add_mounting_holes', description: 'Add non-plated mounting holes to the PCB (default 4 × M3 Ø3.2 mm at the corners, nudged clear of parts) — the enclosure then gets screw standoffs. Re-run route_pcb afterwards.', input_schema: { type: 'object', properties: { diameter: { type: 'number' }, inset: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'explicit [[x,y],...] in board mm' } } } },
    { name: 'set_silk_label', description: 'Change the silkscreen label of a part (default: its reference, placed automatically next to the part where it covers no pad, part or other label), or of the board name (ref "board"). Give x / y (label centre, board mm) to place it by hand — it then moves with the part; auto:true puts it back to automatic placement. Labels must not cover pads: check covers_pads in get_pcb_layout.silk_labels or run_drc.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', description: 'part reference, or "board" for the board name' }, text: { type: 'string', description: 'label text (empty = the reference / project name)' }, size: { type: 'number', description: 'text height in mm (default 1.0; 1 mm is the smallest JLCPCB prints clearly)' }, hidden: { type: 'boolean' }, rotation: { type: 'number', description: 'degrees counter-clockwise' }, x: { type: 'number' }, y: { type: 'number' }, auto: { type: 'boolean' } } } },
    { name: 'batch', description: 'Run many quick edits in one call, in order: calls [{tool, args}] — e.g. update_component / place_footprint / set_silk_label / connect for 20 parts. Stops at the first error unless continue_on_error. Routing tools are allowed (the batch then runs as a background job); export_project, reroute and batch itself are not.', input_schema: { type: 'object', required: ['calls'], properties: { calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } }, continue_on_error: { type: 'boolean' } } } },
    { name: 'arrange_silk_labels', description: 'Tidy the silkscreen reference labels: every label (or refs) goes back to automatic placement next to its part, off pads, parts and other labels; labels that still cover pads are made smaller (down to min_size, default 0.8 mm) and, with hide: true, hidden when there is no room.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, hide: { type: 'boolean' }, min_size: { type: 'number' }, unhide: { type: 'boolean', description: 'show hidden labels again first' } } } },
    { name: 'add_pcb_text', description: 'Add free text to the PCB silkscreen (e.g. version, author, "5V IN", pin names next to a header, polarity marks). Drawn as strokes in the Gerber silkscreen and the 3D view; bottom-side text is mirrored. Keep it off pads.', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, x: { type: 'number', description: 'centre, board mm (default: board centre)' }, y: { type: 'number' }, size: { type: 'number', description: 'height in mm, default 1.2' }, rotation: { type: 'number', description: 'degrees counter-clockwise, e.g. 90 for vertical text' }, side: { type: 'string', enum: ['top', 'bottom'] } } } },
    { name: 'update_pcb_text', description: 'Change or move a free PCB text (index from get_pcb_layout.silk_labels / add_pcb_text).', input_schema: { type: 'object', required: ['index'], properties: { index: { type: 'number' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, rotation: { type: 'number' }, side: { type: 'string', enum: ['top', 'bottom'] } } } },
    { name: 'remove_pcb_text', description: 'Delete a free PCB text by index.', input_schema: { type: 'object', required: ['index'], properties: { index: { type: 'number' } } } },
    { name: 'export_project', ro: true, description: 'Export every file of the current project: project file (.circuit.json), Gerbers + drill, JLCPCB BOM + pick-and-place (CPL), BOM, netlist, enclosure STL / OpenSCAD, EasyEDA schematic + PCB, PCB drawing PDF, datasheet PDF and images (schematic sheets, 2D PCB, 3D top / bottom / angled, enclosure). In the app: one zip download. From Claude Desktop / Claude Code: written into a folder per project (out_dir). Use include to pick only some.', input_schema: { type: 'object', properties: { out_dir: { type: 'string', description: 'Claude Desktop / Code only: folder for the project folder (default: Documents/CircuitPilot exports)' }, include: { type: 'array', items: { type: 'string', enum: ['project', 'gerbers', 'jlcpcb', 'bom', 'netlist', 'enclosure', 'easyeda', 'pdf', 'images'] }, description: 'default: everything' } } } },
    { name: 'get_pcb_layout', ro: true, description: 'PCB layout for reasoning about placement: board size/shape, every footprint (ref, x, y, rotation, side, bounding box, edge lock, nets), unrouted nets with the pads that still need connecting, copper pours. Compact by default (no outline, pins, silk labels or unrouted lists): filter with refs / region / fields, add more with include.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' }, description: 'only these parts (then pins are included)' }, region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] mm: parts whose centre is inside' }, fields: { type: 'array', items: { type: 'string', enum: ['value', 'type', 'x', 'y', 'rot', 'side', 'box', 'size', 'edge', 'locked', 'nets', 'margin'] }, description: 'default x, y, rot, side, size (with refs also nets)' }, include: { type: 'array', items: { type: 'string', enum: ['pins', 'outline', 'unrouted', 'pours', 'keepouts', 'silk'] } }, pins: { type: 'boolean' }, pour_pieces: { type: 'boolean', description: 'list every piece of each copper pour with its area and the pads / vias it touches' } } } },
    { name: 'optimize_pcb', description: 'Placement optimiser: re-arranges parts (annealing on wire length with room around the parts of failing nets, plus fresh global arrangements) and re-routes with rip-up until every net is connected, keeping the best result. With shrink it then makes the board smaller step by step while everything still routes. Connectors on edges and locked parts stay put. Use when route_pcb leaves nets unrouted, or to make the PCB small. Locked parts never move; refs limits it to those parts.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' }, description: 'only these parts may move; the rest (and locked parts) stay put' },  time_limit_s: { type: 'number', description: 'default 120' }, shrink: { type: 'boolean', description: 'also shrink the board as far as it still routes (default false)' }, allow_grow: { type: 'boolean', description: 'may enlarge the board if it cannot be routed (default false)' }, allow_bottom: { type: 'boolean', description: 'may move parts to the bottom side (default false)' } } } },
    { name: 'place_footprints', description: 'Place many footprints in one call (your floor plan): [{ref, x, y, rot, side, edge}] in board mm (origin top-left, y down). Overlaps are resolved, connectors kept on their edges, and (refine, default true) a short local polish shortens connections without changing your arrangement. Clears tracks; pass route: true to route right away.', input_schema: { type: 'object', required: ['placements'], properties: { placements: { type: 'array', items: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, side: { type: 'string', enum: ['top', 'bottom'] }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } } } }, refine: { type: 'boolean', description: 'short annealing of the listed parts afterwards (default false)' }, move_others: { type: 'boolean', description: 'let overlap fixing move other parts too (default false)' }, route: { type: 'boolean' } } } },
    { name: 'add_copper_pour', description: 'Add a copper pour (copper area) for a net, usually GND, on top, bottom or both layers. Without points it covers the whole board and follows the outline. Other nets keep their clearance; same-net pads connect to it.', input_schema: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1]: the board outline cut to this rectangle' }, clip: { type: 'object', properties: { x_min: { type: 'number' }, x_max: { type: 'number' }, y_min: { type: 'number' }, y_max: { type: 'number' } }, description: 'the whole board cut at these limits, e.g. {x_max: 21.3} — no polygon to compute, follows outline changes' },  net: { type: 'string', description: 'default GND' }, layer: { type: 'string', enum: ['top', 'bottom', 'both'] }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'optional polygon [[x,y],...] in mm' }, clearance: { type: 'number' } } } },
    { name: 'add_track', description: 'Draw one track by hand, like the Route tool: from a pad through corner points to a pad (or a via / another track). points: "REF.PIN" pads (pin number or name, e.g. "U1.3", "U1.VIN") and [x, y] corners in board mm (origin top-left, y down; see get_pcb_layout for pad positions). {x, y, via: true} puts a via there and continues on the other layer ({x, y, layer: "bottom"} picks the layer). corner "45" / "90" adds a knee between points so you only give the main corners. Width defaults to the net width rule. Hand-drawn tracks are kept by route_pcb (it routes the remaining nets around them). Returns new DRC problems caused by the track and whether the net is now fully connected.', input_schema: { type: 'object', required: ['points'], properties: { points: { type: 'array', items: {}, description: 'e.g. ["U1.2", [12.5, 8], {"x": 15, "y": 8, "via": true}, "C3.1"]' }, net: { type: 'string', description: 'default: the net of the pads' }, layer: { type: 'string', enum: ['top', 'bottom'], description: 'layer at the start (default: the SMD pad layer, else top)' }, width: { type: 'number', description: 'mm' }, corner: { type: 'string', enum: ['none', '45', '90'] } } } },
    { name: 'add_via', description: 'Put a via (top ↔ bottom) on the PCB. Easiest: near: "U2.9" (a pad) — CircuitPilot finds the closest spot (within max_distance, default 3 mm) where a via passes every rule (clearances on both layers, hole to hole, board edge, keep-outs, no via in another pad) and draws a short track from the pad to it; with a pour of the net on the other layer it picks a spot whose via really joins the pad to that pour (returns pad_joined / net_complete). near: [x, y] (+ net) finds the closest legal spot to a point (layer changes, stitching). Or exact x, y (it warns when that spot breaks a rule). Use it when run_drc says "Net X is not routed" for a pad cut off from a pour, or to change layer.', input_schema: { type: 'object', properties: { near: { description: 'pad "REF.PIN" or point [x, y] (board mm)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] }, max_distance: { type: 'number', description: 'mm, default 3' }, x: { type: 'number' }, y: { type: 'number' }, net: { type: 'string', description: 'default: the net of the pad' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'connect_pads_to_pour', description: 'Join the pads of a pour net (default GND) that are cut off from the rest of it (run_drc: "Net GND is not routed"; pour copper cannot reach them with the full clearance; EasyEDA export warns about pads reached only through thin pour copper): for every cut-off pad group, a via at the closest legal spot + a short track from one of its pads to the pour on the other layer (as add_via near). Reports per group what was placed or why not, net_complete and new DRC problems. Needs a pour of the net (on both layers).', input_schema: { type: 'object', properties: { net: { type: 'string', description: 'default GND' }, max_distance: { type: 'number', description: 'mm from the pad, default 3' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'get_tracks', ro: true, description: 'Every track (index, net, layer, width, corner points, length, hand-drawn or autorouted) and via on the PCB, optionally only one net.', input_schema: { type: 'object', properties: { net: { type: 'string' }, layer: { type: 'string', enum: ['top', 'bottom'] }, region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] mm' }, near: { type: 'string', description: 'a pad "U2.9" or a part "U2": only copper touching it' }, vias_only: { type: 'boolean' }, summary: { type: 'boolean', description: 'counts and vias only' } } } },
    { name: 'remove_tracks', description: 'Delete tracks / vias: by index (from get_tracks / add_track), all of a net, only the autorouted ones (only: "auto") or only the hand-drawn ones (only: "manual"), or all: true.', input_schema: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1]: tracks / vias with a point inside' }, near: { type: 'string', description: 'a part "U2" or pad "U2.9": the copper touching it' },  tracks: { type: 'array', items: { type: 'number' } }, vias: { type: 'array', items: { type: 'number' } }, net: { type: 'string' }, only: { type: 'string', enum: ['auto', 'manual'] }, all: { type: 'boolean' } } } },
    { name: 'add_thermal_vias', description: 'Thermal vias in a part\'s exposed centre pad (QFN / DFN paddle): a grid at pitch (default 1.0 mm) at least 0.1 mm inside the pad, on the pad\'s net; replaces earlier thermal vias of that pad. Allowed also with the strict no-via-in-pad rule. count limits the number.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, pitch: { type: 'number' }, count: { type: 'number' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'set_flex', description: 'Flex PCB: flex true/false, thickness (mm, JLCPCB flex 0.11 / 0.12), stiffeners to add: [{rect: [x0, y0, x1, y1] | pts: [[x, y], …] | ref: "E1" (+ margin mm, the part area — e.g. the solder-pad end of a lead), side: "bottom" (default) | "top", material: "PI" | "FR4" | "steel", thickness}]; clear_stiffeners: true removes the old ones. Gerber export then adds board-Stiffener.gm2 and flex-notes.txt; the 3D view uses the flex thickness.', input_schema: { type: 'object', properties: { flex: { type: 'boolean' }, thickness: { type: 'number' }, clear_stiffeners: { type: 'boolean' }, stiffeners: { type: 'array', items: { type: 'object' } } } } },
    { name: 'stitch_pour', description: 'Stitching vias that join a net\'s top and bottom copper pours (default GND): one every max_spacing mm (default 3) wherever both pours are solid, plus one in every piece of either pour that has none, so pads cut off on one side reach the other side. Needs a pour of the net on both layers. Vias keep off SMD pads and keep-outs.', input_schema: { type: 'object', properties: { net: { type: 'string' }, max_spacing: { type: 'number' }, diameter: { type: 'number' }, drill: { type: 'number' } } } },
    { name: 'add_keepout', description: 'Add a keep-out area to the PCB: no tracks, vias or copper pour inside (each can be allowed again), optionally no parts. Use it for the antenna end of a radio module, under a coin cell / battery holder, around a crystal, under a magnet or reed switch, near mounting screws. Shape (board mm, origin top-left, y down): rect [x0, y0, x1, y1], circle {x, y, r}, points [[x, y], …] or ref (that footprint\'s box, + margin). The autorouter and copper pours avoid it; run_drc reports anything inside; route_pcb afterwards to re-route.', input_schema: { type: 'object', properties: { rect: { type: 'array', items: { type: 'number' } }, circle: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, r: { type: 'number' } } }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, ref: { type: 'string', description: 'keep out the area of this footprint (e.g. the coin-cell holder)' }, margin: { type: 'number', description: 'mm around ref' }, end: { type: 'string', enum: ['top', 'bottom', 'left', 'right'], description: 'with ref: only this end of the part (board view, y down) — e.g. the antenna end of a XIAO / ESP32 module (look at view_design to see which end has the antenna)' }, depth: { type: 'number', description: 'with end: mm into the part (default 6)' }, beyond: { type: 'number', description: 'with end: mm past the part edge (default 5)' }, layer: { type: 'string', enum: ['top', 'bottom', 'both'], description: 'default both' }, name: { type: 'string', description: 'e.g. "Antenna", "Under coin cell"' }, tracks: { type: 'boolean', description: 'false allows tracks inside' }, vias: { type: 'boolean', description: 'false allows vias inside' }, pours: { type: 'boolean', description: 'false allows copper pour inside' }, parts: { type: 'boolean', description: 'true: no parts inside either (DRC + place_in_free_area)' } } } },
    { name: 'remove_keepout', description: 'Remove a keep-out area (index or name from get_pcb_layout.keepouts, or all: true).', input_schema: { type: 'object', properties: { index: { type: 'number' }, name: { type: 'string' }, all: { type: 'boolean' } } } },
    { name: 'place_in_free_area', description: 'Move parts to free space on the board — no overlap with other parts, mounting holes or part keep-outs, inside the outline — as close as possible to near (a ref or [x, y]; default: the parts they connect to). group: true keeps their layout and moves them together (a circuit block); otherwise each part gets its own nearest free spot next to the parts it connects to (rotations tried, bigger parts first); parts that already overlap nothing stay where they are (only_overlapping: false moves them all). Then route_pcb.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, near: { description: 'ref like "U1" or [x, y] in mm' }, only_overlapping: { type: 'boolean', description: 'default true: move only the listed parts that overlap something or sit outside the board' }, group: { type: 'boolean' }, gap: { type: 'number', description: 'mm between parts (default 0.5)' }, side: { type: 'string', enum: ['top', 'bottom'], description: 'for parts not yet on the board' }, rotate: { type: 'boolean', description: 'false keeps the rotation' } } } },
    { name: 'reroute', description: 'The whole re-route recipe in one call: removes the copper pours and all autorouted copper (locked / hand-drawn tracks stay), routes the power nets first (first, default GND then +3V3), then the rest, puts the pours back (the saved pour template, else the pours that were there), adds stitching vias where a net is poured on both layers, tidies the silkscreen labels (hides those with no room) and runs DRC. Returns one summary line. Runs as a background job.', input_schema: { type: 'object', properties: { first: { type: 'array', items: { type: 'string' }, description: 'power nets to route before the rest (default ["GND", "+3V3"]): routed together in one pass with rip-up among them — keep it to the few supply nets; signal nets route better with the rest' }, time_limit_s: { type: 'number' }, stitch: { type: 'boolean', description: 'default true' }, stitch_spacing: { type: 'number' }, labels: { type: 'string', enum: ['hide', 'keep'], description: 'arrange labels and hide those with no room (default), or arrange without hiding' } } } },
    { name: 'transform_parts', description: 'Move, rotate or scale a group of parts: refs, everything in a region [x0, y0, x1, y1], or all. dx / dy in mm, rotate (90° steps) and scale (spacing factor) about the group centre or origin [x, y]. Tracks between the moved parts move along; tracks to parts that stay are removed (route_pcb). Locked parts stay unless include_locked. Returns each part\'s distance to the board edge; auto_fit nudges parts that end up too close inward.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, region: { type: 'array', items: { type: 'number' } }, all: { type: 'boolean' }, dx: { type: 'number' }, dy: { type: 'number' }, rotate: { type: 'number' }, scale: { type: 'number' }, origin: { type: 'array', items: { type: 'number' } }, auto_fit: { type: 'boolean' }, include_locked: { type: 'boolean' } } } },
    { name: 'edge_margins', ro: true, description: 'Distance of each part to the board edge (copper = its pads, body = its box / circle; negative = outside), smallest first, plus the parts closer than the edge rule.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean', description: 'every part, not only the 8 closest' } } } },
    { name: 'mark_overlap_ok', description: 'Accept known overlaps so check_placement stops reporting them (e.g. ["U1", "U2"]: a module over a part on the other side, a holder over the plates). remove: true un-accepts them.', input_schema: { type: 'object', required: ['pairs'], properties: { pairs: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, remove: { type: 'boolean' } } } },
    { name: 'save_pour_template', description: 'Save the current copper pours as the project\'s pour recipe (e.g. top GND clipped at x ≤ 21.3, bottom GND whole board). reroute re-applies it by itself; apply_pour_template puts it back after other changes. Pours defined as whole board / clip follow later outline changes.', input_schema: { type: 'object', properties: {} } },
    { name: 'apply_pour_template', description: 'Replace the copper pours by the saved pour template.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_project_notes', description: 'Notes kept with the project that tools show again (open_project, start_here, get_pcb_layout): a text and named values, e.g. values {"antenna_clip_x": 21.3, "holder": "B1 bottom centre", "pour_recipe": "top GND x<=21.3, bottom GND whole"}. append adds to the text; a value null removes it.', input_schema: { type: 'object', properties: { text: { type: 'string' }, append: { type: 'boolean' }, values: { type: 'object' } } } },
    { name: 'get_project_notes', ro: true, description: 'The project notes (text and named values).', input_schema: { type: 'object', properties: {} } },
    { name: 'check_placement', ro: true, description: 'Fast placement check without routing (well under a second): parts overlapping each other (SMD parts on opposite sides may overlap; through-hole parts block both sides), parts outside the board outline, parts inside a keep-out that forbids parts, parts on a mounting hole. refs: only problems involving these parts. Each overlap gives the overlap in mm and whether the pads are clear (courtyards only) or too close; outside gives how far.', input_schema: { type: 'object', properties: { show_accepted: { type: 'boolean', description: 'also list overlaps accepted with mark_overlap_ok' },  refs: { type: 'array', items: { type: 'string' } }, gap: { type: 'number', description: 'extra spacing in mm required between parts (default 0)' }, tolerance: { type: 'number', description: 'ignore box overlaps smaller than this, mm (default 0.25: footprint boxes include margins)' } } } },
    { name: 'copy_block', description: 'Copy a circuit block (a group of parts, e.g. a sensor with its decoupling caps and pull-ups, or a whole channel) in the current project: new references, the wiring inside the block on fresh nets, power nets (GND, +3V3 …) and keep_nets stay connected, nets to parts outside the block are left off (listed in not_connected). On the PCB the copy keeps the layout and the tracks inside the block; place: "free" puts it in the nearest free board area (default: right next to the original). To copy into another project use the MCP tool copy_block with to_project.', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } }, keep_nets: { type: 'array', items: { type: 'string' }, description: 'signal nets the copy stays connected to (e.g. a shared I2C bus: ["SDA", "SCL"])' }, suffix: { type: 'string', description: 'for renamed nets, e.g. "CH2" → ECG_IN_CH2' }, sch_offset: { type: 'array', items: { type: 'number' }, description: 'schematic offset [dx, dy] (default: to the right of the block)' }, pcb_offset: { type: 'array', items: { type: 'number' }, description: 'PCB offset in mm' }, place: { type: 'string', enum: ['next', 'free', 'none'], description: 'PCB placement of the copy (default next to the original)' }, sheet: { type: 'number', description: 'schematic sheet for the copy (1-based)' }, near: { description: 'with place "free": ref or [x, y]' } } } },
    { name: 'remove_copper_pour', description: 'Remove copper pours (all, or by index / net).', input_schema: { type: 'object', properties: { index: { type: 'number' }, net: { type: 'string' } } } },
    { name: 'set_board_shape', description: 'Board outline: rect, rounded / rounded_rect (corner_radius), ellipse, circle (d = diameter; flat {side: left|right|top|bottom, at: x or y of the flat edge} for a round board with a flat) or polygon (points [[x,y],...] in mm, corner_radius rounds every corner). Coordinates keep their meaning: parts, tracks and keep-outs stay where they are; only if the outline reaches below 0 is everything moved, by offset_applied.', input_schema: { type: 'object', required: ['shape'], properties: { auto_fit: { type: 'boolean', description: 'nudge parts that end up too close to the new edge inward' },  shape: { type: 'string', enum: ['rect', 'rounded', 'rounded_rect', 'ellipse', 'circle', 'polygon'] }, width: { type: 'number' }, height: { type: 'number' }, d: { type: 'number', description: 'circle diameter (mm)' }, cx: { type: 'number' }, cy: { type: 'number' }, flat: { type: 'object', properties: { side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, at: { type: 'number' } } }, corner_radius: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, keep_origin: { type: 'boolean', description: 'default true; false moves the outline (and everything) so it starts at 0, 0' } } } },
    { name: 'place_footprint', description: 'Move / rotate a footprint on the PCB, flip it to the bottom side (side = bottom), or put it on a board edge. edge = left | right | top | bottom puts connectors on that edge (USB / jacks / RF / SD: opening facing outward, flush with the edge; headers just inside) and is remembered for future generate_pcb runs. generate_pcb already puts connectors on the nearest edge automatically. Re-run route_pcb afterwards.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, side: { type: 'string', enum: ['top', 'bottom'], description: 'board side; bottom mirrors the part and puts its SMD pads on BottomLayer' }, lock: { type: 'boolean', description: 'keep optimize_pcb from moving it' }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, along: { type: 'number', description: 'mm along the edge (optional, with edge)' }, x: { type: 'number', description: 'mm' }, y: { type: 'number', description: 'mm' }, rot: { type: 'number', enum: [0, 90, 180, 270] } } } },
    { name: 'update_pcb_from_schematic', description: 'After schematic edits on a board that already exists (new parts, deleted parts or nets, changed footprints): keeps the placement and all still-valid tracks, places new parts next to what they connect to, moves parts that now overlap, removes copper of deleted nets, then routes only the incomplete nets. Prefer this over generate_pcb, which re-places everything.', input_schema: { type: 'object', properties: {} } },
    { name: 'route_pcb', description: 'Re-run the autorouter on the current placement (follows the design rules). It keeps ripping up and re-routing until every net is connected or the time budget runs out (design rule routeTime, default 90 s), keeping the best result. nets: route only these nets (their unlocked tracks are redone, all other copper stays). Hand-drawn and locked tracks (lock_tracks) are always kept. failed_reason says why a net could not be routed. If nets stay unrouted, use optimize_pcb (moves parts) rather than repeating route_pcb.', input_schema: { type: 'object', properties: { time_limit_s: { type: 'number', description: 'max seconds (default: design rule routeTime, 90)' }, nets: { type: 'array', items: { type: 'string' }, description: 'only these nets' } } } },
    { name: 'lock_tracks', description: 'Lock good tracks and vias so route_pcb, optimize_pcb and placement never move or remove them (like hand-drawn tracks). By net, by track indexes (get_tracks), or all: true. unlock: true makes them autorouted again.', input_schema: { type: 'object', properties: { net: { type: 'string' }, tracks: { type: 'array', items: { type: 'number' } }, all: { type: 'boolean' }, unlock: { type: 'boolean' } } } },
    { name: 'view_design', ro: true, description: 'Take a screenshot of the design and look at it: the schematic, the 2D PCB layout, the 3D board, or the 3D enclosure. Use it to check what you actually built (crowded or overlapping symbols, odd placement, tracks, how parts sit in the case) before and after changes. Images cost context, so ask for the view you need.', input_schema: { type: 'object', required: ['view'], properties: { size: { type: 'string', enum: ['small', 'normal', 'large'], description: 'small = 640 px JPEG for a quick check (few tokens); normal 1400 px; large 2000 px' },  view: { type: 'string', enum: ['schematic', 'pcb', 'pcb_3d', 'enclosure'], description: 'schematic | pcb (2D copper layout) | pcb_3d (rendered board with parts) | enclosure (3D case with the board)' }, sheet: { type: 'number', description: 'schematic sheet number (default: 1)' }, side: { type: 'string', enum: ['iso', 'top', 'bottom'], description: 'pcb_3d camera (default iso)' }, exploded: { type: 'boolean', description: 'enclosure: lift the lid / covers off to show the inside' } } } },
    { name: 'get_documentation', ro: true, description: 'Read the product datasheet text of the current project (Documentation tab: title, tagline, revision, company, description, features, applications, notes) plus the design facts to write it from (main parts, connectors, power rails, board size, BOM size). The title, company and revision also fill the schematic title block.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_documentation', description: 'Write or update the product datasheet text (Documentation tab; the PDF, specs, images and BOM are built from the design automatically). Only the fields you pass change. Base statements on the design — do not invent ratings. features / applications: an array of short lines (or one string with a line per item). title, company and version also appear in the schematic title block.', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Product name' }, subtitle: { type: 'string', description: 'One-line tagline' }, version: { type: 'string', description: 'Revision, e.g. 1.0' }, company: { type: 'string', description: 'Company or author' }, description: { type: 'string', description: '2-4 short paragraphs' }, features: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, applications: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, notes: { type: 'string', description: 'Optional usage / assembly notes' } } } },
    { name: 'get_design_rules', ro: true, description: 'Current PCB design rules (trace widths, clearance, vias, edge clearance, layers, per-net widths) and the fab minimums they are checked against. Defaults follow JLCPCB 2-layer capabilities. Lists available presets.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_design_rules', description: 'Change PCB design rules (mm). The autorouter follows them and DRC checks them. Use preset to load a profile, net_widths for per-net trace widths (0 removes an override). Returns warnings for values below the fab minimums, and when the via size costs extra at JLCPCB (1–2 layers: no extra charge only with hole ≥ 0.3 mm and diameter ≥ 0.4 mm, e.g. 0.45/0.3; diameter ≥ hole + 0.1, 0.15 preferred). JLCPCB minimums: 0.1 mm track / space, vias 0.15/0.25 mm (extra cost), copper 0.2 mm from the edge, through-hole pad ring 0.18 mm.', input_schema: { type: 'object', properties: { preset: { type: 'string', description: 'jlcpcb_free_min (default: 0.2 mm tracks, 0.1 mm gaps, 0.45/0.3 vias, no extra cost; traceWidth can go down to 0.1 mm on tight boards, and neck-down narrows to the 0.1 mm fab minimum where needed) | jlcpcb (standard: 0.25 mm tracks, 0.6/0.3 vias) | jlcpcb_min (5/5 mil) | jlcpcb_power | home' }, warnUnderMetal: { type: 'boolean', description: 'DRC warning for tracks / vias of other nets under batteries, coin cells and metal parts on the same side (default false)' }, minHoleSize: { type: 'number' }, minPthRing: { type: 'number', description: 'minimum copper ring of plated through-hole pads (mm, JLCPCB 0.18)' }, minHoleToTrack: { type: 'number', description: 'via drill hole to track (mm, JLCPCB 0.2) — the router keeps it' }, padClearance: { type: 'number', description: 'track / via to pad gap (mm; default 0.16 — EasyEDA Pro checks 0.152)' }, viaClearance: { type: 'number', description: 'track / pad / via to via gap (mm; default 0.16)' }, pourClearance: { type: 'number', description: 'copper pour to other copper (mm; default 0.26 — EasyEDA Pro checks 0.254)' }, epKeepout: { type: 'boolean', description: 'Keep-out under every exposed centre pad (QFN / DFN) on the other layer: no tracks or vias of other nets, pour allowed (default true)' }, partGap: { type: 'number', description: 'minimum gap between part outlines on the same side (mm, e.g. 0.3; 0 = off). DRC warns below it; generate_pcb, optimize_pcb, place_in_free_area and the overlap fix keep it' }, minPthToTrack: { type: 'number', description: 'plated through-hole to track (mm, JLCPCB 0.28)' }, traceWidth: { type: 'number' }, powerTraceWidth: { type: 'number', description: 'Width for power/ground nets (used only when powerWider is true)' }, powerWider: { type: 'boolean', description: 'Route power/ground nets with powerTraceWidth (default false: every net uses traceWidth)' }, clearance: { type: 'number' }, viaDiameter: { type: 'number' }, viaDrill: { type: 'number' }, edgeClearance: { type: 'number' }, layers: { type: 'number', enum: [1, 2] }, neckDown: { type: 'boolean', description: 'Allow narrowing a trace when the full width does not fit' }, routeTime: { type: 'number', description: 'Autorouter effort: max seconds of rip-up and reroute (default 90)' }, noViaInPad: { type: 'boolean', description: 'Strict (default true): never a via on an SMD pad, not even as the router\'s last resort (DRC error, so export_gerbers refuses it). Thermal vias deep inside a real exposed pad (QFN / DFN paddle) stay allowed; module edge pads (XIAO castellations) are not exposed pads.' }, pourMinArea: { type: 'number', description: 'Copper pour pieces smaller than this (mm², default 0.5) are removed, as are pieces that touch no copper of their net' }, trackStyle: { type: 'string', enum: ['45', '90'], description: 'Autorouter track corners: "45" (default: straight runs with 45° corners) or "90" (horizontal / vertical runs with 90° corners only, a little longer). Never odd angles.' }, viaInPad: { type: 'boolean', description: 'Allow vias on SMD pins (default false: vias go beside pins; thermal vias inside large exposed pads are always allowed)' }, net_widths: { type: 'object', additionalProperties: { type: 'number' }, description: 'e.g. {"+5V": 0.8, "MOTOR": 1.2}' } } } },
    { name: 'run_drc', ro: true, description: 'Design rule check of the PCB with exact geometry: clearances/shorts, trace widths, via size/annular ring, hole spacing, board-edge clearance and unrouted nets. Returns the counts per type and the first 5 violations (full: true for all).', input_schema: { type: 'object', properties: { full: { type: 'boolean', description: 'all violations with details (up to 80)' }, limit: { type: 'number', description: 'how many violations to list (default 5)' }, types: { type: 'array', items: { type: 'string' }, description: 'only these types, e.g. ["clearance", "via-in-pad", "keepout"]' } } } },
    { name: 'pcb_status', ro: true, description: 'Board size, number of placed parts, routed / unrouted nets, via count, trace length.', input_schema: { type: 'object', properties: { verbose: { type: 'boolean', description: 'also the board outline points' }, } } },
    { name: 'create_part', description: 'Create a NEW custom part (symbol pins + PCB footprint) when nothing suitable exists in the database. Saved to the design and to My Library; returns its key for add_components {lcsc: key}.', input_schema: { type: 'object', required: ['name', 'pins', 'footprint'], properties: { name: { type: 'string' }, prefix: { type: 'string', description: 'Reference prefix, default U' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, save_to_library: { type: 'boolean', description: 'default true' } } } },
    { name: 'update_part', description: 'Modify an existing part definition used in the design (database or custom): pins, footprint, name, prefix, value. All placed instances follow.', input_schema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'LCSC code or library key' }, name: { type: 'string' }, prefix: { type: 'string' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, save_to_library: { type: 'boolean', description: 'default true' } } } },
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
    if (!/^(C\d+|EE-[0-9A-F]{32})$/.test(up)) throw new Error(`Unknown part "${raw}" — use an LCSC code (C1234), an EasyEDA community key (EE-…), an open-library key (OL:…) or a My Library key`);
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
  function partSummary(m) {
    return {
      key: keyOf(m), name: m.name, manufacturer: m.manufacturer, mfr_part: m.mfr_part, package: m.package, ref_prefix: m.prefix,
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
  function shapeContext() { try { return Shape3D.context(Enclosure.layout()); } catch (e) { return { pcb: null }; } }
  // summary for the AI: sizes, fit report, errors with line numbers (meshes stay in the viewer)
  async function runShape(code) {
    let r;
    try { r = env.shape ? await env.shape(code) : Shape3D.run(code, shapeContext(), { mesh: false, stl: false }); }
    catch (e) { return { ok: false, error: e.message, line: e.line || null, logs: e.logs || [], hint: 'Fix the script and call set_enclosure_script again (enclosure_script_help has the API).' }; }
    const out = { ok: true, parts: r.parts.map(p => ({ name: p.name, size_mm: p.size_mm, bbox: p.bbox, volume_cm3: p.volume_cm3, triangles: p.triangles, watertight: !p.open_edges })), collisions: r.report.collisions, not_enclosed: r.report.outside || [], near_wall: r.report.near_wall, warnings: r.report.warnings, logs: r.logs, build_ms: r.ms };
    const fix = [];
    if (r.report.collisions.length) fix.push('Printed parts overlap the PCB/components listed in collisions: make the cavity bigger/taller or move the features.');
    if ((r.report.outside || []).length) fix.push('Not inside the enclosure: ' + r.report.outside.join(', ') + '. Size the body from envelope() so the board and all parts fit, and close the walls and lid around them.');
    if (fix.length) out.fix = fix.join(' ') + ' Then run set_enclosure_script again.';
    return out;
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
    if (!t) throw new Error('Unknown tool ' + name);
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
      case 'get_part': return partSummary(await loadPart(input.lcsc || input.key));
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
        const list = Array.isArray(input.components) ? input.components : [input];
        const libs = {};
        // built-in symbols get the real JLCPCB part behind them (unless a footprint was given)
        for (const s of list) if (s.type && !s.lcsc && !s.part && !s.footprint && Lib.dbDefault(s.type, s.value)) {
          try { s.dbPart = await loadPart(Lib.dbDefault(s.type, s.value).lcsc); } catch (e) { /* database unavailable → generated footprint */ }
        }
        for (const s of list) if (s.lcsc || s.part) { const m = await loadPart(s.lcsc || s.part); libs[keyOf(m)] = m; s.part = keyOf(m); delete s.lcsc; }
        // sheet numbers are 1-based for the AI; sheets are created on demand
        for (const s of list) if (s.sheet != null) { const n = Math.max(1, Math.round(+s.sheet) || 1); s.sheet = n - 1; }
        return Model.mutate(() => {
          const need = Math.max(0, ...list.map(s => (s.sheet || 0) + 1));
          if (need > 1) { const sh = (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]).slice(); while (sh.length < need) sh.push({ name: 'Sheet ' + (sh.length + 1) }); Model.S.sheets = sh; }
          for (const [k, m] of Object.entries(libs)) if (!Model.S.lib[k]) Model.setLibPart(k, m);
          const added = list.map(s => Model.addComponent(s));
          Model.spaceOut();   // keep room for net labels between parts, whatever coordinates were asked for
          return added.map(c => ({ ref: c.ref, type: c.type, value: c.value, x: c.x, y: c.y, sheet: Model.sheetOf(c) + 1, footprint: c.footprint, pins: Lib.type(c.type).pins(c).map(p => p.num + ':' + p.name).join(' ') }));
        });
      }
      case 'update_component': return Model.mutate(() => { const c = Model.updateComponent(input); Model.spaceOut(); return { ok: true, ref: c.ref }; });
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
      case 'clear_design': Model.mutate(() => Model.clear()); return { ok: true };
      case 'web_search': return api('/api/web/search?' + new URLSearchParams({ q: input.query || '', n: input.max_results || 8 }), { headers: env.searchKey && env.searchKey() ? { 'X-Brave-Key': env.searchKey() } : {} });
      case 'web_fetch': { const r = await api('/api/web/fetch?' + new URLSearchParams({ url: input.url || '', offset: input.offset || 0, length: input.max_chars || 12000 })); return r; }
      case 'use_database_parts': return useDatabaseParts(input.refs);
      case 'match_jlcpcb_parts': return matchJlcpcb(!!input.overwrite);
      case 'get_enclosure': {
        if (Enclosure.mode() === 'custom') { const r = await runShape(Enclosure.script()); env.ui('show-enc'); return Object.assign({ mode: 'custom', script: Enclosure.script() }, r); }
        const d = Enclosure.describe(); env.ui('show-enc'); return d;
      }
      case 'enclosure_script_help': {
        const ctx = shapeContext(), id = input.template || input.example;
        const t = id && (Shape3D.TEMPLATES.find(x => x.id === id) || (Shape3D.EXAMPLES[id] && { id, code: Shape3D.EXAMPLES[id] }));
        return { api: Shape3D.HELP, pcb: ctx.pcb, templates: Shape3D.TEMPLATES.map(x => ({ id: x.id, group: x.cat, name: x.name, about: x.desc })), template: t ? { id: t.id, code: t.code } : undefined, example: t ? undefined : { id: 'wrist-whoop', code: Shape3D.TEMPLATES[0].code } };
      }
      case 'set_enclosure_script': {
        const code = String(input.code || '');
        if (!code.trim()) throw new Error('code is empty');
        Model.mutate(() => Enclosure.setParams({ mode: 'custom', script: code }));
        const r = await runShape(code); env.ui('show-enc');
        return r;
      }
      case 'set_enclosure': { const r = Model.mutate(() => Enclosure.setParams(input)); env.ui('show-enc'); return { outer_mm: r.outer_mm, base_height: r.base_height, cutouts: r.cutouts.length, params: r.params }; }
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
      case 'optimize_pcb': {
        // refs: only these parts may move (all others are held like locked parts); locked parts never move
        const S = Model.S, hold = input.refs && input.refs.length ? Pcb.placed().filter(c => !input.refs.includes(c.ref) && !c.pcb.locked).map(c => c.ref) : [];
        const o = { time_limit_s: input.time_limit_s || 120, allow_grow: !!input.allow_grow && !hold.length, allow_bottom: !!input.allow_bottom, shrink: !!input.shrink && !hold.length };
        const setHold = on => { for (const r of hold) { const c = Model.comp(r); if (c && c.pcb) { if (on) c.pcb.locked = true; else delete c.pcb.locked; } } };
        let r;
        if (env.route) { Model.mutate(() => setHold(true)); try { r = (await env.route({ optimize: o })).optimized; } finally { Model.mutate(() => setHold(false)); } }
        else r = Model.mutate(() => { setHold(true); try { return Pcb.optimize(o); } finally { setHold(false); } });
        env.ui('show-pcb');
        return Object.assign({}, r, { history: (r.history || []).slice(-8), board: Pcb.boardBrief(), drc: Pcb.drc().summary, held: hold.length || undefined });
      }
      case 'add_copper_pour': return Model.mutate(() => Pcb.addPour({ net: input.net, layer: input.layer === 'bottom' ? 'B' : input.layer === 'both' ? 'both' : 'F', points: input.points, rect: input.rect, clip: input.clip, clearance: input.clearance }));
      case 'lock_tracks': return Model.mutate(() => {
        const P = Model.S.pcb, ix = new Set((input.tracks || []).map(Number));
        if (!input.net && !ix.size && !input.all) throw new Error('Give net, tracks (indexes) or all: true');
        const pick = (x, i) => input.all || (input.net && x.net === input.net) || (x.pts && ix.has(i));
        let n = 0;
        const set = x => { if (input.unlock) { if (x.locked) { delete x.locked; delete x.manual; n++; } } else if (!x.manual) { x.manual = true; x.locked = true; n++; } };
        P.traces.forEach((t, i) => { if (pick(t, i)) set(t); });
        P.vias.forEach(v => { if (input.all || (input.net && v.net === input.net)) set(v); });
        return { [input.unlock ? 'unlocked' : 'locked']: n, note: input.unlock ? undefined : 'Locked copper is kept by route_pcb / optimize_pcb; remove_tracks still deletes it' };
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
        const nearOk = pts => !nearPads || pts.some(q => nearPads.some(p => Pcb.geom.padDist(p, q[0], q[1]) <= 0.3));
        const layer = input.layer ? (/^b/i.test(input.layer) ? 'bottom' : 'top') : null;
        const tracks = input.vias_only ? [] : r.tracks.filter(t => (!layer || t.layer === layer) && t.points.some(q => inR(q[0], q[1])) && nearOk(t.points));
        const vias = r.vias.filter(v => inR(v.x, v.y) && nearOk([[v.x, v.y]]));
        return { tracks: input.summary ? undefined : tracks, vias: input.summary ? undefined : vias, counts: { tracks: tracks.length, vias: vias.length, length_mm: +tracks.reduce((a, t) => a + t.length_mm, 0).toFixed(1) } };
      }
      case 'remove_tracks': return Model.mutate(() => {
        if (input.rect || input.near) {   // area / part: resolve to indexes first
          const S = Model.S, rr = input.rect, idx = Model.pinIndex(), only = input.only;
          const inR = (x, y) => !rr || (x >= Math.min(rr[0], rr[2]) && x <= Math.max(rr[0], rr[2]) && y >= Math.min(rr[1], rr[3]) && y <= Math.max(rr[1], rr[3]));
          let pads = null; if (input.near) { const s0 = String(input.near), c = Model.comp(s0.split('.')[0]); if (!c || !c.pcb) throw new Error(`${s0.split('.')[0]} is not on the PCB`); pads = Pcb.padsOf(c, idx).filter(p => !s0.includes('.') || p.num === s0.split('.')[1]); }
          const near = pts => !pads || pts.some(q => pads.some(p => Pcb.geom.padDist(p, q[0], q[1]) <= 0.3));
          const okType = x => !only || (only === 'manual' ? !!x.manual : !x.manual), okNet = x => !input.net || x.net === input.net;
          const tracks = [], vias = [];
          S.pcb.traces.forEach((t, i) => { if (okType(t) && okNet(t) && t.pts.some(q => inR(q[0], q[1])) && near(t.pts)) tracks.push(i); });
          S.pcb.vias.forEach((v, i) => { if (okType(v) && okNet(v) && inR(v.x, v.y) && near([[v.x, v.y]])) vias.push(i); });
          if (!tracks.length && !vias.length) return { removed_tracks: 0, removed_vias: 0 };
          return Pcb.removeTracks({ tracks, vias });
        }
        return Pcb.removeTracks(input);
      });
      case 'stitch_pour': return Model.mutate(() => Pcb.stitchPour(input));
      case 'add_thermal_vias': return Model.mutate(() => Pcb.addThermalVias(input));
      case 'set_flex': { const r = Model.mutate(() => Pcb.setFlex(input)); env.ui('show-pcb'); return r; }
      case 'add_keepout': { const r = Model.mutate(() => Pcb.addKeepout(input)); env.ui('show-pcb'); return r; }
      case 'remove_keepout': return Model.mutate(() => Pcb.removeKeepout(input));
      case 'place_in_free_area': { const r = Model.mutate(() => Pcb.placeFree(input.refs, input)); env.ui('show-pcb'); return r; }
      case 'check_placement': { const r = Pcb.checkPlacement(input.refs, +input.gap || 0, input.tolerance != null ? +input.tolerance : 0.25, { show_accepted: !!input.show_accepted }); return { ok: !r.length, problems: r.slice(), accepted_overlaps: r.acceptedCount || undefined, accepted: r.accepted }; }
      case 'mark_overlap_ok': return Model.mutate(() => Pcb.markOverlapOk(input.pairs, !!input.remove));
      case 'edge_margins': return Pcb.edgeMargins({ refs: input.refs, all: !!input.all });
      case 'transform_parts': { const r = Model.mutate(() => Pcb.transformParts(input)); env.ui('show-pcb'); return r; }
      case 'save_pour_template': return Model.mutate(() => Pcb.savePourTemplate());
      case 'apply_pour_template': return Model.mutate(() => Pcb.applyPourTemplate());
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
      case 'generate_pcb': case 'route_pcb': {
        // keep_placement: the parts stay where they are (new parts go next to what they connect to), only routing runs
        const keepPl = name === 'generate_pcb' && input.keep_placement && Model.S.board.w > 0;
        if (keepPl) Model.mutate(() => Pcb.syncFromSchematic());
        const place = name === 'generate_pcb' && !keepPl ? { w: input.board_width, h: input.board_height, fit: !!input.auto_size } : null, noRoute = input.route === false;
        let r;
        const ropt = input.time_limit_s ? { time_limit_s: +input.time_limit_s } : {};
        // only some nets: their unlocked copper is ripped up and routed again, everything else stays as it is
        if (name === 'route_pcb' && Array.isArray(input.nets) && input.nets.length) {
          const bad = input.nets.filter(n => !Model.S.nets[n]); if (bad.length) throw new Error('No net ' + bad.join(', '));
          Model.mutate(() => { const P = Model.S.pcb, only = new Set(input.nets); P.traces = P.traces.filter(t => t.manual || !only.has(t.net)); P.vias = P.vias.filter(v => v.manual || !only.has(v.net)); });
          Object.assign(ropt, { onlyNets: input.nets.slice(), keep: true, keepAll: true });
        }
        // a full route runs with the copper pours off and puts them back afterwards (pours fill around the new tracks);
        // then the pads the pours no longer reach are joined by a short pass. Routing chosen nets keeps the pours:
        // that pass uses them to join cut-off pads
        const full = !noRoute && !ropt.onlyNets, pours0 = full ? (Model.S.pcb.pours || []).map(q => JSON.parse(JSON.stringify(q))) : [];
        if (pours0.length) Model.mutate(() => { Model.S.pcb.pours = []; });
        try {
          if (env.route) r = await env.route({ place, opt: Object.assign({ noRoute }, ropt) });
          else r = Model.mutate(() => ({ placement: place ? Pcb.autoPlace(place) : undefined, routing: noRoute ? null : Pcb.route(ropt) }));
        } finally { if (pours0.length) Model.mutate(() => { Model.S.pcb.pours = pours0.filter(q => Model.S.nets[q.net]); }); }
        if (pours0.length) {
          // stitching vias are automatic (the route replaced them): put them back where a net has pours on both layers
          if (input.stitch !== false) for (const net of [...new Set(pours0.map(q => q.net))]) if (pours0.some(q => q.net === net && q.layer === 'F') && pours0.some(q => q.net === net && q.layer === 'B')) { try { Model.mutate(() => Pcb.stitchPour({ net })); } catch (e) { } }
          const conn = Pcb.connectivity(), broken = Object.keys(conn).filter(n => !conn[n].complete);
          if (broken.length) { const o2 = { onlyNets: broken, keep: true, keepAll: true, time_limit_s: 20 }; if (env.route) await env.route({ place: null, opt: o2 }); else Model.mutate(() => Pcb.route(o2)); }
          if (r && r.routing) Object.assign(r.routing, { pours: 'removed while routing and put back', still_unrouted: Pcb.status().unrouted });
        }
        env.ui('show-pcb');
        const d = Pcb.drc();
        return Object.assign({}, r, { drc: { summary: d.summary, top: d.violations.filter(v => v.severity === 'error').slice(0, 8).map(v => v.msg) } });
      }
      case 'update_pcb_from_schematic': {
        const sync = Model.mutate(() => Pcb.syncFromSchematic()), todo = Pcb.status().unrouted;
        let r = null;
        const routeWith = async opt => env.route ? env.route({ place: null, opt }) : Model.mutate(() => ({ routing: Pcb.route(opt) }));
        if (todo.length) {
          r = await routeWith({ keep: true, keepAll: true, onlyNets: todo });
          if (Pcb.status().unrouted.length) { // boxed in by existing tracks: full re-route on the same placement, keep the better one
            const before = JSON.stringify(Model.S.pcb), n0 = Pcb.status().unrouted.length;
            r = await routeWith({});
            if (Pcb.status().unrouted.length > n0) Model.mutate(() => { Model.S.pcb = JSON.parse(before); });
          }
        }
        env.ui('show-pcb');
        const st = Pcb.status(), d = Pcb.drc();
        return Object.assign(sync, { rerouted: todo, routed: st.routed, total: st.nets, unrouted: st.unrouted, drc: d.summary });
      }
      case 'place_footprint': { const r = Model.mutate(() => Pcb.placeFootprint(input.ref, input)); env.ui('show-pcb'); return Object.assign(r, { note: 'Tracks are kept; run route_pcb to connect anything left unrouted.' }); }
      case 'view_design': {
        if (!env.render) throw new Error('Screenshots need the CircuitPilot app open in a browser.');
        const v = input.view;
        if (!['schematic', 'pcb', 'pcb_3d', 'enclosure'].includes(v)) throw new Error('view must be schematic, pcb, pcb_3d or enclosure');
        if (v !== 'schematic' && !(Model.S.board.w && Pcb.placed().length)) throw new Error('No PCB yet — run generate_pcb first');
        if (v === 'schematic' && !Model.S.components.length) throw new Error('The schematic is empty');
        const img = await env.render(input);
        if (!img || !img.data) throw new Error('Nothing to show for ' + v);
        const what = { schematic: `schematic sheet ${input.sheet || 1}`, pcb: `2D PCB layout (${Model.S.board.w} × ${Model.S.board.h} mm; red = top copper, blue = bottom, yellow = unrouted)`, pcb_3d: `3D board, ${input.side || 'iso'} view`, enclosure: `3D enclosure${input.exploded ? ', exploded' : ''}` }[v];
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
        return { rules: R, warnings: Pcb.ruleWarnings(R), presets: Object.fromEntries(Object.entries(Pcb.RULE_PRESETS).map(([k, v]) => [k, v.label])), note: 'JLCPCB defaults; check jlcpcb.com/capabilities for current limits' };
      }
      case 'set_design_rules': {
        const u = Object.assign({}, input); if (u.net_widths) { u.netWidths = u.net_widths; delete u.net_widths; }
        return Model.mutate(() => Pcb.setRules(u));
      }
      case 'run_drc': {
        // counts + the first violations; full: true lists up to 80, types filters
        const d = Pcb.drc(), by = {}; for (const v of d.violations) by[v.type] = (by[v.type] || 0) + 1;
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
        if (!old) def.custom = true;
        const dup = def.pins.map(p => p.num).find((n, i, a) => a.indexOf(n) !== i); if (dup) throw new Error(`Pin number ${dup} is used twice`);
        const used = Model.mutate(() => Model.setLibPart(def.key, def));
        let saved = false;
        if (input.save_to_library !== false) { try { await env.savePart(def); saved = true; } catch (e) { } }
        const padNums = new Set((def.footprint.pads || []).map(p => p.num));
        return { key: def.key, pins: def.pins.length, pads: def.footprint.pads.length, placed_instances_updated: used, saved_to_library: saved, pins_without_pad: def.pins.filter(p => !padNums.has(p.num)).map(p => p.num) };
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
    for (const c of S.components) {
      if (c.type === 'part') { out.push({ ref: c.ref, lcsc: Model.lcscOf(c) || null, source: 'database part' }); continue; }
      if (c.lcscPart && !overwrite) {
        const d = Lib.dbDefault(c.type, c.value);
        const same = d && d.lcsc === c.lcscPart && (d.byValue || String(c.value).toLowerCase() === String(d.value).toLowerCase());
        if (!d || d.lcsc !== c.lcscPart || same) { out.push({ ref: c.ref, value: c.value, lcsc: c.lcscPart, source: 'kept' }); continue; }
      }
      if (['connector', 'battery', 'ic'].includes(c.type)) { out.push({ ref: c.ref, lcsc: null, source: 'skipped (choose the exact part)' }); continue; }
      const pkg = pkgOf(c), q = `${norm(c.type, c.value)} ${pkg}`.trim();
      try {
        const j = await partsApi('search?q=' + encodeURIComponent(q) + '&limit=20');
        const ok = j.results.filter(r => r.stock > 0 && (!pkg || String(r.package || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(pkg.toUpperCase().replace(/[^A-Z0-9]/g, ''))));
        const best = ok.sort((a, b) => (b.basic - a.basic) || (b.stock - a.stock))[0];
        if (best) { Model.mutate(() => { Model.comp(c.ref).lcscPart = best.lcsc; }); out.push({ ref: c.ref, value: c.value, lcsc: best.lcsc, part: best.mfr_part, package: best.package, basic: !!best.basic, stock: best.stock }); }
        else out.push({ ref: c.ref, value: c.value, lcsc: null, source: `no in-stock match for "${q}"` });
      } catch (e) { out.push({ ref: c.ref, lcsc: null, source: e.message }); }
    }
    return { matched: out.filter(o => o.lcsc).length, total: out.length, parts: out };
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

  return { env, TOOLS, exec, useDatabaseParts, matchJlcpcb, loadPart, partsApi, api, designContext, knowledgeDigest, newKey };
})();
if (typeof module !== 'undefined') module.exports = Engine;
