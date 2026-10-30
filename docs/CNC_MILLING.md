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
| `preview.svg` | | Toolpaths: copper sheet, isolation (blue), cutout (red), tabs (yellow), holes, X0 Y0 (green) |
| `result-2d.svg` | | The finished board as it comes off the machine (copper side up, as milled): copper, grooves, holes, part names |
| `result-3d.html` | | The same board in 3D (open in a browser: drag to turn, Copper side / Angled / Other side). In the app: **Result 2D** / **Result 3D** tabs in the CNC dialog |
| `README-cnc.txt` | | Bit order, job size, set-up steps, warnings |

Every file: `G21 G90 G94`, `G0 Z5`, `M3 S1000`, `G4 P3` … `G0 Z5`, `M5`, `G0 X0 Y0`, `M2`.
**X0 Y0 = lower-left corner of the PCB** (default). The cutout reaches `cut_dia` (2 mm) left of and below it, so set X0 Y0 at least 3 mm inside the sheet edge. `origin: "job"` puts X0 Y0 on the job corner instead (every move at X, Y ≥ 0).
**Z0 = copper surface.**

## Settings (defaults)

| Option | Default | |
|---|---|---|
| `iso_depth` | 0.2 | mm. Copper is 0.035 mm thick: 0.2 mm still cuts through where the board sits ~0.15 mm low (0.08 left areas uncut) |
| `vbit_angle` / `vbit_tip` | 30 / 0.1 | the V-bit; the groove width follows from them |
| `iso_dia` | auto | groove width at the cut depth = tip + 2·depth·tan(angle/2) → 0.207 mm at 0.2 mm deep |
| `iso_passes` / `iso_overlap` | 2 / 0.3 | |
| `iso_feed` / `plunge_feed` / `drill_feed` / `cut_feed` | 120 / 60 / 40 / 100 | mm/min |
| `cut_dia` / `cut_step` | 2 / 0.3 | end mill, mm |
| `tabs` / `tab_width` / `tab_height` | 4 / 2 / 0.5 | |
| `board_thick` | design (1.6) | mm |
| `spindle` | 1000 | `S` value (GRBL `$30=1000` → full speed) |
| `parts_side` | auto | **Where the parts go** (dialog: *Parts go on*). `bare` = through-hole parts from the side without copper, soldered on the copper → milled mirrored. `copper` = all parts on the copper side → not mirrored. The AI asks you when it does not know |
| `mirror` | auto | auto = mirrored when the through-hole parts go on the bare side: bottom copper, through-hole only, or through-hole + 2-pad SMD parts (1206 …, soldered on the copper side). Not mirrored when an SMD IC sits on the copper (its pins would be reversed) |
| `origin` | board | `board` (PCB corner) or `job` |
| `drill_bits` | [0.8, 1.0] | the drill bits you have |
| `layer` | auto | the copper side with the tracks |
| `pad_relief` | auto | SMD pads on the GND pour: `on` = a milled gap all round with 4 spokes, so each pad is its own solder spot; `off` = plain pour; auto = design rule `smdPadRelief` (on in `cnc3018` and `home`). Dialog: *SMD pads on pour* |

## How it works

1. **Copper**: drawn on a grid (0.02 mm, coarser only for very large boards) the same way as the copper Gerber.
   - Pour fill and its clearance cut-outs come first.
   - Then come the edge band and the keep-outs.
   - Last come the tracks, pads (round / oval / rectangle) and vias.
2. **Distance field**: an exact Euclidean distance transform of that copper.
   - Isolation pass *k* is the contour of `max(distance − r_k, board inset 0.05 mm)`, found by marching squares with interpolation and simplified to 0.01 mm.
   - Where two nets are closer than the V-bit, the rings merge, and the cutter never enters either net's copper.
3. **Short check**: copper islands are labelled. If one island grown by `iso_dia/2` holds pads or tracks of two nets, a warning names them: they would stay shorted.
4. **Toolpath check**: the finished paths are cut out of a full copper sheet twice:
   - with a groove 0.6 × `iso_dia` (a shallow spot): every net must still be separate;
   - with a groove 1.5 × `iso_dia` (a worn bit, a low spot): no net may be cut in two.
   The result is `toolpath_check` in the tool result, plus warnings.
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
| Track width | 0.9 mm (3V3 / power 1.0), necked down to 0.5 mm at most | at 0.2 mm deep the groove is ~0.21 mm; wide tracks survive a worn bit and lift less when soldering |
| Clearance (tracks, pads, vias) | 0.4 mm | groove (~0.21 mm at 0.2 mm deep) + ~0.1 mm machine play |
| Pour clearance | 0.6 mm | the isolation passes fully separate the pour |
| Copper to edge | 1.5 mm | 2 mm end mill, tabs, burr |
| Smallest hole | 0.8 mm | 0.6 mm bits break on a 3018 |
| Hole to hole | 1.0 mm | drill wander |
| Ring around a through-hole pad | ≥ 0.35 mm (warning) | unplated pads lift, the drill can be off centre |
| Smallest pour piece | 2 mm² | slivers peel off |
| Pour under SMD parts | none (`pourUnderSmd: false`) | a pour strip between the pads of a 1206 bridges with solder; the G-code also mills that copper away (zig-zag with the V-bit), and the copper in keep-outs such as the antenna end |
| SMD pads on the pour | outlined, 4 spokes (`smdPadRelief: true`) | a pad inside plain pour cannot be seen on the milled board and the pour soaks up the iron's heat |
| Track corners | 45° | the V-bit cannot reach sharp inside corners |
| Vias | DRC error | nothing to join on a 1-sided board: use a wire jumper |
| Tracks on both layers | DRC error | |
| Pin pitch under 1.2 mm | DRC warning | SOIC 1.27 mm or bigger |
| Pads under 0.6 mm (0603 and smaller) | DRC warning | use 0805 / 1206 |

- Through-hole parts (XIAO on pin headers, adapters, connectors) go in from the bare side; 1206 parts are soldered on the copper side → mirror on (auto).
- SMD ICs on the copper side → not mirrored (auto), so their pins are not reversed.
- One copper layer with a GND pour: the router leaves GND to the pour and only adds tracks to pads the pour cannot reach (GND tracks would wall other nets in).
- A fine-pitch chip (AD8310 MSOP-8 …): solder it on an SOP/MSOP→DIP adapter and mill only the 2.54 mm DIP holes.
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
   - Copper left uncut in some areas: the board is not flat. Use the height map, flatten the sacrificial board, or cut deeper.
   - Copper strands left between tracks: `iso_depth` + 0.02.
   - Tracks too thin: go shallower, or use a finer V-bit.

## Limits

- One copper layer per job. Two-sided boards (flip, alignment pins) are not supported.
- Pads use the same shapes as the Gerber export: round, oval, and axis-aligned rectangles.
- Feeds and depths are safe starting values for a 3018 with the stock 775 spindle.
