# CircuitPilot MCP tools – problems met while building the HBC boards, and suggested fixes

Written 2026-10-23 after building about 20 boards (TX/TXRX options A/B/C, ESP32-C3, RP2040, LIR2032 rectangular and round).
Ordered by how much time each problem cost.

## 1. Must fix (they cost the most time)

### 1.1 The current project gets lost after a timeout
**What happens:** any call over about 45 s times out. After that, the next tool call can work on a different project. I had to call `open_project` after every timeout, and once a project was overwritten with a 7-part stub (round TX B).
**Cause:** `mcp/circuitpilot-mcp.mjs` keeps `currentId` in the MCP process memory. When the client restarts that process after a timeout, `ensureProject()` falls back to `resolveProject(process.env.CP_PROJECT)`, which with no ref returns `ps[0]`, the most recently updated project.
**Fix:**
- Add an optional `project` (id) argument to every tool, so each call says which project it acts on.
- Save the current project id where it survives a restart, for example in a small file next to projects.db or in the server (`/api/session/current`), and restore it in `ensureProject()`.
- Never create or pick `ps[0]` silently. If no current project is known, return an error that says "call open_project".

### 1.2 Tools silently switch to the other database
**What happens:** when the CircuitPilot.exe window is closed, the tools start `python server.py`, which uses `D:\PCB_Copilot\projects.db` instead of `%LOCALAPPDATA%\CircuitPilot\projects.db`. Projects then appear to be missing, or new work lands in the wrong database.
**Cause:** `ensureApp()` starts the exe only when `CP_APP_EXE` is set. `.mcp.json` sets only `CP_URL`.
**Fix:**
- Add `"CP_APP_EXE": "D:\\PCB_Copilot\\dist\\CircuitPilot\\CircuitPilot.exe"` to `.mcp.json`, or set `CP_DATA_DIR` for server.py to the AppData folder, so both servers use one database.
- Have `/api/version` return the database path, and show it in `start_here` and `list_projects`. Then a switch can be seen at once.
- Make `CP_DATA_DIR` the default in both, so there is only one projects.db.

### 1.3 Long operations time out (generate_pcb, route_pcb with pours, export_project with images/pdf)
**What happens:**
- `generate_pcb` with 54 parts on a polygon outline always timed out. Workaround: set a rectangle outline, generate, place the parts, then set the polygon again.
- Routing with copper pours present is many times slower than without them.
- `export_project` with pdf or images needs small `include` batches.
**Fix (pick one):**
- Run them as jobs: the tool returns a `job_id` at once, and `job_status(job_id)` returns progress or the result. This is the cleanest fix.
- Or make the tool return before 40 s with "still running" and let the work finish in the background.
- Quick help on the client side: Claude Code reads the `MCP_TOOL_TIMEOUT` environment variable (in ms). Set it to 300000 in the environment that starts Claude Code, or in the `env` block of the settings file.
**Speed-ups:**
- `generate_pcb`: when parts already have x/y (or are passed in), skip auto-placement. Test the polygon outline with a bounding box first.
- `route_pcb`: ignore pours while routing, then refill them once at the end (`pours: "refill_after"`).

## 2. Routing and DRC features that would remove most hand work

### 2.1 Keep-out zones (biggest single gain)
I needed these on every board and drew around them by hand.
- XIAO antenna end: no copper or parts.
- Under the coin cell: no signal tracks on the bottom layer, because the cell's negative face lies on the bottom and the tracks are insulated only by solder mask.
- Under the LIR holder on the top layer.

Proposed tool: `add_keepout {shape: rect|circle|polygon, layers: [top, bottom], forbid: [tracks, vias, pour, parts], nets_allowed: ["GND"]}`. The router and placer should respect it, and DRC should report what is inside it. Also add a built-in "antenna keep-out" to the XIAO / ESP32 module footprints, so it applies automatically.

### 2.2 No vias in pads
The router put vias inside XIAO castellation pads, electrode pads and 0603 pads (for example C10.2), and I replaced them by hand.
Proposed fix: add a design rule `viaInPad: forbid | allow_tented | allow` (default forbid), followed by the router and checked by DRC.

### 2.3 Copper pour connectivity
The tool only treats a pour island as connected when its own check sees the join. Isolated GND pads (E2 under the coin) needed hand tracks and vias, and my independent checker (review_pcb.py) sometimes disagreed with the tool.
- Compute pour connectivity with a real flood fill: pour island ∩ pads/vias (with thermals) → union-find. Report each island with the pads it touches.
- Add `stitch_pour {net, max_spacing}`: put vias that join the top and bottom islands of a net.
- Add `remove_islands {min_area}`: delete floating pour pieces. Every round board had 5–10 slivers.

### 2.4 Outline check uses the part's bounding box, not its copper or courtyard
Electrode E6 (a round 2.5 mm pad) was reported as outside the round outline because the check used the 3.1 mm box. I had to make a smaller 2.0 mm part.
Fix: use the real pad shapes for copper-to-edge, and the courtyard polygon (a circle for round parts) for the body.

### 2.5 `set_board_shape` polygon moves the origin
The minimum x/y of the polygon is shifted to 0, which moves everything relative to the parts already placed.
Fix: add an option `keep_origin: true` (default), or return the offset that was applied. Better still, offer shapes directly: `{shape: "circle", d, flat: {side: "left", at_x}}` and `{shape: "rounded_rect", r}`.

### 2.6 Router corner and length control
- When a few nets fail, `route_pcb` should say why: blocked by which part or keep-out, or out of room on a layer.
- Add `route_pcb {nets: [...]}` to route only some nets, and `lock_tracks` so good hand-drawn tracks are never moved.

## 3. Placement helpers (I wrote my own Python planner for this)

- `place_in_region {refs, region (polygon), side, spacing}`: pack small parts into a free area, such as the crescent around a round coin or the area past the antenna, with courtyard checks. This is what a_fit.py / a_rx5.py did outside the tool.
- `check_placement`: a fast check (no routing) for courtyard overlaps, parts outside the outline, parts in keep-outs, and top/bottom conflicts. It should return a list in under a second.
- `copy_layout {from_project, refs | block}`: reuse the placement and tracks of a block (for example the AD8310 receiver or the option A transmitter) from another project. I rebuilt the same blocks about 10 times.
- `duplicate_project {name}`: copy a project (schematic + PCB + enclosure), then change it. Most variants started as a copy of another one.

## 4. Review and DRC

Add the checks from `review_pcb.py` (now in `V1\22-10-2025\review`) to `run_drc`, or as a `review_pcb` tool, so the two never disagree:
- shorts between different nets (copper polygon overlap)
- unconnected nets, including through pours
- floating copper
- vias in pads
- copper in the antenna keep-out
- signal tracks under batteries or metal parts on the opposite side

## 5. Enclosure

- The pod fit check falsely reports parts as "not enclosed" (Q2, C17, C20, R14, C21, C18 and the PCB on the option A round pod; C8/C9/C10/L1 on the TXRX round pods). The STL is fine.
  - Probable cause: the check ignores the board standoff or the bottom-side parts below the board, or it uses the bounding box against a curved (concave) floor.
  - Make the check use the real solids (the same CSG as the export), and report the clearance in mm.
- `envelope()` helper: an option to include only the parts on one side, plus the battery holder's real height.

## 6. Smaller things

- **Silkscreen:** an auto-arrange option for reference labels (move them off pads and other parts, or hide them when there is no room). I hid many labels by hand.
- **Library:** "My Library" is per database, so the electrode pad parts had to be created again in the AppData database. Use one shared library file, or `export_part` / `import_part`.
- **view_design needs a browser tab** open on the project. Draw the screenshots on the server instead (headless), so exports and checks also work with the window closed.
- **Batch edits:** `update_component` for many refs at once, for example to set the side or rotation of 20 parts.
- **pcb_status:** list unrouted nets with their pad positions, plus the reason the router gave up.
- **Port conflict:** the exe and the dev server both use port 5173. Give the dev server another default port (for example 5174), so the two can never be mixed up.

## Suggested order

1. 1.1 and 1.2. These are small code changes and give the most safety: no lost or overwritten work.
2. Set `MCP_TOOL_TIMEOUT`, then do 1.3 as job-style tools.
3. 2.1 keep-outs, 2.2 no via in pad, 2.3 pour connectivity and island removal.
4. 3 placement helpers and `duplicate_project` / `copy_layout`.
5. The rest.

---

## 7. Via changes: exact edits (line numbers as of 2026-10-23 17:16)

Someone is already editing `js/pcb.js`: it has `noViaInPad`, `pourMinArea`, keep-outs, `place_in_free_area` and `copy_block`. The edits below build on that version. Search for the quoted code if the line numbers have moved.

### 7.1 The bug: vias inside the XIAO pads pass both the router and DRC
- The XIAO footprint (C37327670) pads are SMD, 2.75 x 2.0 mm, with no drill.
- The "thermal via inside a large exposed pad" exception only checks size: `min(w, h) >= 2 * viaDiameter + 0.4`. With 0.6 mm vias that is 1.6 mm, and 2.0 ≥ 1.6, so every XIAO pad counts as an "exposed pad".
- Result on TXRX_ECG_OptionA_LIR2032_Round: vias at the centres of U1.5, U1.10, U1.12 and U1.13. Neither the router nor DRC complains, and `noViaInPad` does not help, because that exception applies before it.

### Edit 1: mark real exposed pads once per footprint (`pcb.js`, before `function padsOf`, about line 9)
```js
  // Exposed / thermal pad (QFN / DFN paddle, the tab under a power IC): a large SMD pad near the middle of the footprint
  // with pins on both sides of it. Edge pins of modules (XIAO castellations), connectors and big chip pads are never one.
  const epCache = new WeakMap();
  function exposedPads(fp) {
    let set = epCache.get(fp); if (set) return set;
    set = new Set(); const smd = fp.pads.filter(p => !p.drill), b = fp.box;   // box: [x0, y0, x1, y1]
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, hw = (b[2] - b[0]) / 2, hh = (b[3] - b[1]) / 2;
    for (const p of smd) {
      if (p.ep) { set.add(p.num); continue; }                          // footprint data can say so explicitly
      if (Math.min(p.w, p.h) < 1.5 || smd.length < 3) continue;
      if (Math.abs(p.x - cx) > 0.3 * hw || Math.abs(p.y - cy) > 0.3 * hh) continue;   // not near the middle
      const o = smd.filter(q => q !== p);
      const lr = o.some(q => q.x < p.x - p.w / 2) && o.some(q => q.x > p.x + p.w / 2);
      const ud = o.some(q => q.y < p.y - p.h / 2) && o.some(q => q.y > p.y + p.h / 2);
      if (lr || ud) set.add(p.num);                                    // pins on both sides: a centre paddle
    }
    epCache.set(fp, set); return set;
  }
```
In `padsOf`, add the flag to every pad:
```js
    const ep = exposedPads(fp);
    return fp.pads.map((p, i) => {
      ...
      return { ...p, ep: ep.has(p.num), x: c.pcb.x + x, y: c.pcb.y + y, /* rest unchanged */ };
```
Check: for the XIAO, pad 1 is at x = −8.08 and the box half-width is about 8.8 mm, so it is far from the middle and not exposed. A QFN paddle at (0, 0) with pins on four sides is exposed.

### Edit 2: router uses the flag (`pcb.js`, about line 971)
```diff
-            const big = Math.min(p.w, p.h) >= 2 * R.viaDiameter + 0.4, nr = p.near, last = vip.has(id);
+            const big = p.ep && Math.min(p.w, p.h) >= 2 * R.viaDiameter + 0.4, nr = p.near, last = vip.has(id);
```

### Edit 3: DRC uses the flag (`pcb.js`, about line 1394)
```diff
-        const big = Math.min(p.w, p.h) >= 2 * v.d + 0.4, depth = ...
+        const big = p.ep && Math.min(p.w, p.h) >= 2 * v.d + 0.4, depth = ...
```
Also make the `via-in-pad` entry an **error** (not a warning) when `R.noViaInPad` is on. `export_gerbers` (`mcp/circuitpilot-mcp.mjs:166`) then refuses to export without `force`.

### Edit 4: make "never" the default, and remove the dead option
- In `rules()` (about line 650), change the default `noViaInPad: false` to `noViaInPad: true`. Then the router never uses its "last resort" via-in-pad unless you ask for it.
- `opt.strictVias` (about lines 1278 and 1296) is never set anywhere, so delete it from both conditions:
```diff
-          if (!R.viaInPad && !opt.strictVias && !R.noViaInPad && !vip.has(F.id)) vip.add(F.id); else hard.add(F.net);
+          if (!R.viaInPad && !R.noViaInPad && !vip.has(F.id)) vip.add(F.id); else hard.add(F.net);
```
- When a net fails because of this, add the reason to the `route_pcb` result, for example `failed_reason: {"+3V3": "needs a via next to U1.12, no room"}`. Then it is clear what to move.
- Optional cleanup: replace the two booleans with one setting, `viaInPad: "never" | "last_resort" | "allow"`. In `setRules`, map the old values: `noViaInPad: true` → never, `viaInPad: true` → allow, otherwise last_resort.

### Edit 5: check hand-placed vias right away (`addVia`, about line 1614)
`addTrack` already returns `new_drc_problems`, and after edits 1–3 it will list vias in pads. `addVia` checks nothing. Add:
```js
  function addVia(o = {}) {
    const S = Model.S, R = rules();
    ...
    const v = { net: o.net || null, x: +x.toFixed(4), y: +y.toFixed(4), d: +(o.diameter || R.viaDiameter), drill: +(o.drill || R.viaDrill), manual: true };
    const idx = Model.pinIndex(), onPads = [];
    for (const c of placed()) for (const p of padsOf(c, idx))
      if (!p.drill && !p.ep && padDist(p, v.x, v.y) < v.d / 2 + R.clearance) onPads.push(p.key);
    if (onPads.length && !R.viaInPad) throw new Error(`Via at (${v.x}, ${v.y}) touches SMD pad ${onPads.join(', ')} — move it at least ${(v.d / 2 + R.clearance).toFixed(2)} mm from the pad edge`);
    S.pcb.vias.push(v);
    return { index: S.pcb.vias.length - 1, ...(costsExtra(v) ? { note: costNote(v) } : {}) };
  }
```
(`costsExtra` and `costNote` are defined in edit 7.) Apply the same test in `addTrack` to each layer-change via (about line 1601) before it is pushed.

### Edit 6: pad rotation in `padDist` (about line 704) — check only
`padsOf` swaps `w`/`h` for 90° and 270°, so rect pads are correct at those angles. Parts at 45° or other angles would be wrong. If you allow any angle, rotate (x, y) into the pad frame before measuring.

### Edit 7: JLCPCB limits, and "free" versus "costs extra" (about line 643)
JLCPCB capabilities page, checked 2026-10-23, 1–2 layers, 1 oz copper:

| | JLCPCB | Tool now |
|---|---|---|
| Track / space | 0.10 / 0.10 mm | 0.127 / 0.127 |
| Smallest via they can make | 0.15 mm hole / 0.25 mm diameter (extra cost) | 0.3 / 0.5 |
| Smallest via at **no extra cost** | **0.20 mm hole / 0.45 mm diameter** | not known |
| Via diameter − hole | ≥ 0.10 mm (0.15 preferred) | ring 0.13, so 0.26 |
| Plated through-hole pad ring | ≥ 0.18 mm (0.25 recommended) | uses the via ring 0.13 |
| Copper to routed edge | ≥ 0.20 mm | 0.30 |

Replace `JLC_MIN` and add a preset:
```js
  const JLC_MIN = { minTraceWidth: 0.1, minClearance: 0.1, minViaDrill: 0.15, minViaDiameter: 0.25, minAnnularRing: 0.05,
                    minPthRing: 0.18, minHoleToHole: 0.5, minEdgeClearance: 0.2, minHoleSize: 0.15 };
  // JLCPCB charges extra for a via hole < 0.2 mm, or a hole < 0.3 mm with a diameter < 0.45 mm
  const costsExtra = v => v.drill < 0.2 - 1e-9 || (v.drill < 0.3 - 1e-9 && v.d < 0.45 - 1e-9);
  const costNote = v => `Via ${v.d}/${v.drill} mm costs extra at JLCPCB (free: hole ≥ 0.2 mm with diameter ≥ 0.45 mm) — pick the matching via option when ordering`;
  const RULE_PRESETS = {
    jlcpcb: { /* unchanged */ },
    jlcpcb_free_min: { label: 'JLCPCB 2-layer — smallest at no extra cost', values: { traceWidth: 0.1, powerTraceWidth: 0.3, clearance: 0.1, viaDiameter: 0.45, viaDrill: 0.2, edgeClearance: 0.2, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_min: { /* ... */ },
```
- Rename `jlcpcb_min`'s label to "5/5 mil", or remove it; `jlcpcb_free_min` replaces it.
- Keep the `jlcpcb` preset values (0.6 / 0.3 vias): it stays the safe default. Only the minimums change.

In `ruleWarnings` (about line 657):
```js
    if (costsExtra({ d: R.viaDiameter, drill: R.viaDrill })) w.push(costNote({ d: R.viaDiameter, drill: R.viaDrill }));
    if (R.viaDiameter - R.viaDrill < 0.1 - 1e-9) w.push('Via diameter must be at least 0.1 mm larger than the hole (JLCPCB)');
```
In the DRC via loop (about line 1389), add one **warning** per via size that costs extra, not per via. Add a `minPthRing` check for through-hole pads:
```js
    for (const c of cs) for (const p of padsOf(c, idx)) if (p.drill && (Math.min(p.w, p.h) - p.drill) / 2 < R.minPthRing - 1e-6)
      add('pad', `Pad ${p.key} ring ${((Math.min(p.w, p.h) - p.drill) / 2).toFixed(2)} < ${R.minPthRing} mm`, p.x, p.y, 'warning');
```
Add `'minPthRing'` to `NUM_KEYS`.

### Edit 8: tool descriptions (`js/engine.js:106`, `set_design_rules`)
- In the `preset` description, add `jlcpcb_free_min (0.1 mm tracks, 0.2/0.45 vias: smallest at no extra cost)`.
- In the `noViaInPad` description, add "(default true)".
- Mention that `viaDrill < 0.2` or `viaDiameter < 0.45` costs extra.

### Edit 9: export notes
- `export_gerbers` / `export_project`: add a line to the result and to the README in the zip, for example `"Vias: 0.45 / 0.2 mm (JLCPCB standard, no extra cost)"`, or the cost note. Then you know which via option to pick when ordering.
- `js/docview.js:35` (datasheet rules table): show the same text.

### 7.2 How to test after the edits
1. Open TXRX_ECG_OptionA_LIR2032_Round and run `run_drc`. It should now report 4 `via-in-pad` errors (U1.5, U1.10, U1.12, U1.13). Before the edits it reported 0.
2. Run `route_pcb` again. Those nets should now get their vias beside the pads, or be reported as failed with a reason.
3. Run `set_design_rules {preset: "jlcpcb_free_min"}`, then `route_pcb`. There should be no rule warnings, and the router should have more room on the round boards.
4. Run `add_via` on a XIAO pad. It should return an error with the pad name.
5. On a board with a QFN exposed pad, GND thermal vias inside the pad must still be allowed.

## 8. Enclosure and electrode tools – found while building the XIAO_Size_RX_ECG wristband (2026-10-27)

The job: a thin curved wristband pod (board + LiPo tail, spring-bar lugs, strap GND wire), 5 skin/finger electrodes,
ordered from JLC3DP (MJF PA12) and JLCCNC (laser-cut 0.5 mm stainless). Everything below cost a rebuild or a
workaround outside CircuitPilot (Python + CadQuery + trimesh in a scratch venv).

### 8.1 Bugs

| # | Bug | What happened | Fix |
|---|---|---|---|
| B1 | `part(ref)` clashes with `part(name, shape)` | Help says `part("E1") → that part`, but calling it throws "part(): expected a 3D shape" | Rename the lookup to `pcbPart(ref)` (keep `pad()`), or make `part()` with one string argument return the PCB part |
| B2 | Wire pads treated as edge connectors | `connectorCuts(e)` opened wall holes for J1 "Battery BAT+/BAT-" and J2 "ECG+/ECG-" (solder pads, `edge: left/right`) | Only cut for parts with `plug: true` (USB, JST, headers); never for pads / test points / wire pads |
| B3 | XIAO USB-C not detected | `e.plugs` was empty, so there was no USB opening; I placed it by hand and first got the height wrong (cut into the lid) | Give module footprints connector metadata (side, centre z, width, height). XIAO USB-C: centre about 1.65 mm below the module top, 9 × 3.2 mm |
| B4 | Part heights wrong | 0603 C1 / R1 estimated 1.6 mm (real 0.8 / 0.5), 5032 XO 1.6 (1.2), wire pads 1.6; the floor got 1 mm thicker | Height from the package (0402 / 0603 / 0805 / SOT / QFN / 5032 table) instead of from the value |
| B5 | Module box = carrier footprint | U1 box = 19.5 × 23.1 × 3.5 mm (whole board), real XIAO body 17.5 × 21. `splitLid` then had no room for a lip and **silently** made a flat 1.3 mm lid with nothing to locate it | Use the module body box; `splitLid` must warn "lip skipped (no room beside U1)" |
| B6 | Fit check misses wall breaches | A 5 mm outer corner radius around a square pocket cut through the wall at 4 corners; `not_enclosed` and `collisions` were empty | Add a leak check: smallest distance from every cavity to the outside, listed with position (I did it with `gap(outside, cavity)` in the script) |
| B7 | No thin-wall check | JLC's heatmap found real knife edges I could not see: 0.08 mm wedge between two pockets, 0.15 mm sliver over the USB cut, lid edge tapering to 0, a 12° tail tip, 0.1 mm between a wire channel and a pocket | See 8.2 F1 |
| B8 | Preview image stale | The first `set_enclosure_script` returned a picture of a plain box (the previous model) | Wait for the new build before the screenshot, or put a build id in the picture |
| B9 | Coplanar pieces count as 2 | A solid that only touches the base face to face (added with `union`) gave "base is 2 separate pieces"; it would print loose | Good that it warns. Say *where* the loose piece is (bbox), and suggest a 0.2 mm overlap |
| B10 | Metal parts reported as broken prints | The `electrode_plates` part (metal, not printed) warns "5 separate pieces" and is exported as an STL nobody should upload | A part flag `{ print: false, kind: 'metal' \| 'reference' }`: no print checks, not in the print STLs, exported as flat files (8.2 F3) |
| B11 | `export_project` skips the enclosure when the script uses `gap()` | "enclosure: gap() needs the fast 3D kernel (script line 72)" — `export_enclosure` worked with the same script | Use the same kernel in both exports (or skip `log`-only checks during export) |

### 8.2 Missing features (in order of value)

**F1. DFM / thin-wall check per process** (biggest gain; would have saved 4 rebuilds)
- `check_enclosure {process: 'mjf' | 'sla' | 'fdm' | 'sls'}` → min wall, min hole, min gap, fit clearance, from a process table:
  MJF wall 1.0, hole 1.0, tolerance ±0.3; SLA wall 0.8, ±0.2; FDM wall 1.2, ±0.3.
- Ray-cast per triangle along the inside normal (like JLC's heatmap). Skip hits within ~0.3 mm of an edge with
  an angle ≥ 70°, because they are not thin walls (recess rims, corners); I got 26 mm² of false hits without that.
- Return a list (thickness, position, part) and a heatmap view in `view_design`.
- Also flag acute edges (two faces meeting below 30°), the source of most of the real failures here.

**F2. STEP export** — JLCCNC needs a STEP file next to the DXF, and JLC3DP accepts STEP. Today only STL + .scad
come out, so I installed CadQuery in a venv. Use OCCT/replicad in the app, or at least export STEP for extruded
flat parts.

**F3. Flat metal parts: electrodes, plates, shims**
- `electrode({shape, at, curve, recess, plateT, hole, tab})`: makes the recess (following the wrist curve), the wire
  hole and the matching flat plate in one call.
- Export each flat part as DXF (cut lines only: no text, no bend lines, because shops cut every line they see) +
  STEP with the **same name**, plus a **panel**: all plates in one frame with 0.6 mm break-off bridges (JLCCNC
  quotes one part per file and the upload takes one file → zip of the STEP + DXF).
- A lanced wire tab (U-slot) option, rooted over the wire hole, because stainless cannot be soldered normally.
- Check: smallest gap between skin electrodes (the user saw them almost touching at 2.6 mm; sweat bridges below
  about 5 mm).

**F4. Batteries**
- Custom size `{t, w, l}`. Common cells are missing from `list_batteries`: 302020, 501520, 602025 (the user had
  these three), 402020, 502020.
- `batteryPlace`: also `-x`, `+y`, `-y`, a rotation, and `tilt` / `follow: 'curve'` (the cell in its own tilted
  tail pocket, as in this design). Today `beside` is +X only and flat.
- Add the charge rate to the result: the XIAO charges at 50 mA, which is 1.1C for a 45 mAh cell.

**F5. Wearable shaping helpers**
- `bandSegments({R, sections: [board, battery]})`: flat sections, each tangent to the wrist curve, so a flat board
  and flat cell wrap a wrist without the ends getting thick (`wristCurve` only cuts a concave underside, so the
  ends grow by the sag).
- Radial end cut (end face square to the wrist) to avoid the knife-edge tail tip.
- `springBarLugs({strap, bar: 1.5, contact: 'tube'})` with the GND contact tube and a wire channel kept inside solid
  wall (the strap-as-GND feature).
- `splitLid` with a region limit (end the lid where it is still full thickness; the rest stays on the base) and a
  stepped joint (`joint: 'rabbet'`, skirt / groove widths from the process table).

**F6. Script editing cost**
- `set_enclosure_script {patch: [{find, replace}]}` or `{vars: {fit: 0.3, tw: 2.3}}`. Every small change meant
  resending the whole 9 KB script (about 15 resends in this job).
- `get_enclosure {script: false}` to skip the script in the result.
- `view_design {section: 'x', at: 12.5}`: a section at a chosen position, not only the board centre.

**F7. Order helpers**
- `export_enclosure {for: 'jlc3dp' | 'jlccnc'}`: the files each service accepts (one part per file, matching
  names, zip) plus a README with the order settings: MJF → PA12-HP / PA11-HP, Black, Dyeing; lid paint
  "Exterior only"; sheet metal → stainless 304/316, 0.5 mm, Brushing, no powder coat (insulates electrodes),
  no threads; remark text about keeping bridges and tabs.
- Warn about choices that break the product: aluminium or powder coat on electrodes, metallic paint over the BLE
  antenna, resin for parts worn on skin.

### 8.4 Status (2026-10-28): all of 8.1 and 8.2 is in the tools

| Item | Now |
|---|---|
| B1 | `part("U1")` with one argument returns the PCB part; `pcbPart(ref)` too |
| B2 | `edge` is set only for parts that open to the outside (plugs, a module's USB port); other edge parts get `atEdge` — wire pads never get a wall hole |
| B3 | Module table (XIAO, Pico, Pro Micro, Nano, SuperMini, Zero): real body box + `port` {kind, side, x, y, z, w, h}; `connectorCuts` and the box cut-outs open it at the right height |
| B4 | Heights by package and type (0603 R 0.5 / C 0.8, SOT, QFN, MSOP, crystal sizes, EasyEDA `-H…`), pads 0.1 mm |
| B5 | Module body box instead of the footprint; `splitLid` warns when the lip is skipped or cut away |
| B6 / B7 / F1 | Manufacturability check after every build (process mjf / sls / sla / fdm): thin walls (ray per sample along the inward normal, rims and corners skipped within 0.3 mm of a ≥ 70° edge), knife edges, slits, lid fit, openings no connector explains (declare intended ones with `opening()`), sealed hollows; `check_enclosure` for the fine version; Thickness heatmap in the viewer |
| B8 | The picture is drawn from exactly the design that was saved (the app waits for it, else draws that version) |
| B9 | Loose pieces reported with their position and size, and the 0.2 mm overlap hint |
| B10 | `part(name, shape, {kind: 'metal' \| 'reference'})` (or `print: false`): no print checks, not in the print STLs, metal → DXF + STEP |
| F2 | STEP for every Custom 3D part (faceted solids, checked with OpenCascade: valid closed solids, same volume); the parametric box gets STEP only when its (older, BSP) mesh closes into a solid |
| F3 | `electrode({…})`, DXF (cut lines only), panel with 0.6 mm bridges and lanced U-tabs, electrode spacing check (5 mm) |
| F4 | Any LiPo code or `{t, w, l, mAh}`; 302020 / 501520 / 602025 / 402020 / 502020 added; `batterySide`, `batteryRotate`, `batteryTilt`; `charge_mA` → charge C and a flag |
| F5 | `radialEnds`, `wireChannel`, `strapLugs {barHole, contact}`, `splitLid {joint: 'rabbet', region}`; templates split where the walls are still straight and run USB openings through the split instead of leaving a sliver |
| F6 | `set_enclosure_script {patch \| vars}`, `get_enclosure {script: false}`, `view_design {section, at}` |
| F7 | `export_enclosure {for: jlc3dp \| jlccnc}` and the app's All (.zip): files per service + README with the order settings and warnings |

### 8.3 Suggested order
1. B2, B3, B4, B5: wrong geometry from the board data (each needs a manual workaround today).
2. F1 + B6 + B7: DFM / thin-wall and leak check (JLC rejects or flags the part otherwise).
3. F2 + F3 + B10: STEP export and flat metal parts (needed to order electrodes at all).
4. F6: patch editing (token cost).
5. F4, F5, F7.
