# Milling a PCB on a desktop CNC (CNC 3018 Pro, GRBL)

CircuitPilot writes the G-code itself: no FlatCAM, no Gerber conversion step.

- **App**: PCB tab → **CNC ⤓**. The dialog shows the settings and a preview; **Download G-code ⤓** saves a zip.
- **Claude / MCP**: `export_cnc_gcode {out_dir}` (same options as the dialog). The in-app AI has `export_cnc_gcode` too.

## Files

| File | Bit | What |
|---|---|---|
| `1_isolation.nc` | V-bit 20–30° | Rings around the copper at `iso_dia/2`, then `+ iso_dia·(1 − overlap)` for each extra pass, at `−iso_depth` |
| `2_drill_<d>mm.nc` | drill `<d>` | One file per bit you have (`drill_bits`, default 0.8 / 1.0 mm): each hole gets the smallest bit that fits; holes bigger than every bit and smaller than the end mill are drilled, then widened in a small circle, 0.4 mm deeper per turn at 30 mm/min |
| `3_cutout.nc` | flat end mill | Holes ≥ end mill + 0.1 mm milled as circles (G2), then the outline at `cut_dia/2` outside the board, `cut_step` per pass to `−(thickness + 0.1)`, with tabs |
| `preview.svg` | | Copper sheet, isolation (blue), cutout (red), tabs (yellow), holes, X0 Y0 (green) |
| `README-cnc.txt` | | Bit order, job size, set-up steps, warnings |

Every file: `G21 G90 G94`, `G0 Z5`, `M3 S1000`, `G4 P3` … `G0 Z5`, `M5`, `G0 X0 Y0`, `M2`.
**X0 Y0 = lower-left corner of the PCB** (default). The cutout reaches `cut_dia` (2 mm) left of and below it, so set X0 Y0 at least 3 mm inside the sheet edge. `origin: "job"` puts X0 Y0 on the job corner instead (every move at X, Y ≥ 0).
**Z0 = copper surface.**

## Settings (defaults)

| Option | Default | |
|---|---|---|
| `iso_dia` | 0.15 | V-bit cut width at the cut depth, mm |
| `iso_depth` | 0.08 | mm |
| `iso_passes` / `iso_overlap` | 2 / 0.3 | |
| `iso_feed` / `plunge_feed` / `drill_feed` / `cut_feed` | 120 / 60 / 40 / 100 | mm/min |
| `cut_dia` / `cut_step` | 2 / 0.3 | end mill, mm |
| `tabs` / `tab_width` / `tab_height` | 4 / 2 / 0.5 | |
| `board_thick` | design (1.6) | mm |
| `spindle` | 1000 | `S` value (GRBL `$30=1000` → full speed) |
| `mirror` | auto | auto = mirrored for bottom copper, or top copper with through-hole parts only (the parts go on the other side); `off` for SMD on the copper side |
| `origin` | board | `board` (PCB corner) or `job` |
| `drill_bits` | [0.8, 1.0] | the drill bits you have |
| `layer` | auto | the copper side with the tracks |

## How it works

1. **Copper**: drawn on a grid (0.02 mm, coarser only for very large boards) the same way as the copper Gerber.
   - Pour fill and its clearance cut-outs come first.
   - Then come the edge band and the keep-outs.
   - Last come the tracks, pads (round / oval / rectangle) and vias.
2. **Distance field**: an exact Euclidean distance transform of that copper.
   - Isolation pass *k* is the contour of `max(distance − r_k, board inset 0.05 mm)`, found by marching squares with interpolation and simplified to 0.01 mm.
   - Where two nets are closer than the V-bit, the rings merge, and the cutter never enters either net's copper.
3. **Short check**: copper islands are labelled. If one island grown by `iso_dia/2` holds pads or tracks of two nets, a warning names them: they would stay shorted.
4. **Outline**: the end mill path is the contour at `cut_dia/2` outside the board. Near that path, the distance is computed exactly from the outline edges.
   - Tabs are spread evenly along the perimeter.
   - On passes deeper than `−(total − tab_height)`, the tool rises to the tab top across each tab, `(tab_width + cut_dia)` long.
5. **Frame**:
   - lower-left of the board → (0, 0), Y up;
   - mirror `x → W − x` when mirrored;
   - shift by `cut_dia` for the job origin.
   - Paths keep the material on their left (conventional milling with M3).

Code: [`js/cnc.js`](../js/cnc.js).

## Design rules: preset `cnc3018` (⚙ Rules → CNC milling — 3018)

| Rule | Value | Why |
|---|---|---|
| Layers | 1 | one copper side |
| Track width | 0.5 mm, power nets 1.0 mm, never under 0.4 | the V-bit eats the edges; thin tracks lift when soldering |
| Clearance (tracks, pads, vias) | 0.4 mm | groove (~0.15 mm, more where the board is not flat) + ~0.1 mm machine play |
| Pour clearance | 0.6 mm | the isolation passes fully separate the pour |
| Copper to edge | 1.5 mm | 2 mm end mill, tabs, burr |
| Smallest hole | 0.8 mm | 0.6 mm bits break on a 3018 |
| Hole to hole | 1.0 mm | drill wander |
| Ring around a through-hole pad | ≥ 0.35 mm (warning) | unplated pads lift, the drill can be off centre |
| Smallest pour piece | 2 mm² | slivers peel off |
| Track corners | 45° | the V-bit cannot reach sharp inside corners |
| Vias | DRC error | nothing to join on a 1-sided board: use a wire jumper |
| Tracks on both layers | DRC error | |
| Pin pitch under 1.2 mm | DRC warning | SOIC 1.27 mm or bigger |
| Pads under 0.6 mm (0603 and smaller) | DRC warning | use 0805 / 1206 |

- Through-hole parts: copper on the bottom of the finished board → mirror on (auto).
- SMD on a single-sided board: the parts sit on the copper → not mirrored (auto when the top copper has SMD pads).
- Auto-size on one layer: if the packed board does not route, it is made 25 % bigger and routed again (twice at most).
- The `home` preset stays for chemical etching (0.4 mm tracks).

## Running the job (Candle or any GRBL sender, 115200 baud)

Tools: V-bit 20–30° (0.1 mm tip), drill bits for each `2_drill` file, 2 mm flat end mill, single-sided FR4, sacrificial board.

1. **Fix the board.** Put double-sided tape over the whole back, press it flat, copper up, edges along X / Y, clamps outside the job.
2. **Zero X/Y.** Jog the V-bit to the lower-left corner of the sheet, 1–2 mm inside the edge, and set **X0 Y0**. The sheet must reach the job size (in the README) to the right and up.
3. **Zero Z.** Put paper under the bit and step down 0.01 mm until it drags. Remove the paper, go 0.01 mm lower, and set **Z0**.
4. **Air run (first time).** Set Z0 5 mm higher and run `1_isolation.nc` to watch the moves.
5. **Order:** `1_isolation` → each `2_drill_*` → `3_cutout`.
   - At each bit change set **only Z0** again. Never touch X0 / Y0.
6. **Board not flat?** Use the sender's height map with a probe clip. The files have no height compensation.
7. **Tuning:**
   - Copper strands left between tracks: `iso_depth` + 0.02.
   - Tracks too thin: go shallower, or use a finer V-bit.

## Limits

- One copper layer per job. Two-sided boards (flip, alignment pins) are not supported.
- Pads use the same shapes as the Gerber export: round, oval, and axis-aligned rectangles.
- Feeds and depths are safe starting values for a 3018 with the stock 775 spindle.
