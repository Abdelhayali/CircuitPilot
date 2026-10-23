# CircuitPilot

An AI copilot for electronics design: describe a circuit in plain language and it picks **real parts from the JLCPCB/LCSC database**, draws the schematic, runs ERC, then places and autoroutes a 2-layer PCB you can export as Gerbers. Use Claude, any OpenAI-compatible model or a **local model**, from the browser, your phone, or **Claude Code via MCP**.

![CircuitPilot — ESP32-C3 board schematic](docs/media/schematic.png)

**▶ Try it online: [pcbgo.site](https://pcbgo.site)**: nothing to install. The **🔑 Connect AI** window walks you through getting a free Google Gemini or Ollama Cloud key in about a minute (Claude, OpenAI, OpenRouter and others work too). Your key stays in your browser. Then describe your circuit. Projects are saved in your browser. For local models, knowledge folders and Claude Code control, run the desktop version (below).

## See it in action

**From one prompt to a routed board and a 3D-printed case** — the copilot (Gemini Flash Lite) designs an ESP32 board from *"create PCB for ESP"*: real JLCPCB parts, schematic, placement, rip-up autorouting (21/21 nets, DRC 0 errors), GND pours, then a fitted enclosure and a Whoop-style wristband pod (sped up 5×).

[![Prompt to PCB to enclosure](docs/media/demo-esp32-board.gif)](docs/media/demo-esp32-board.mp4)

▶ [Watch the full-speed video (MP4)](docs/media/demo-esp32-board.mp4)

**A wearable sensor board, end to end** — with a local model (gpt-oss:120b) from *"Create ESP32-C3 with IMU BMI160 and ECG BMD101 in 4 cm × 4 cm"*: the copilot searches the JLCPCB catalogue and datasheets, wires the schematic (I²C IMU, UART ECG front-end, 3.3 V LDO, USB-C), places and routes the 40 × 40 mm board (all nets routed), shows it in 3D, builds an enclosure and an ECG electrode patch from the wearable templates, and generates the product datasheet PDF (sped up 5×).

[![ESP32-C3 + BMI160 + BMD101 wearable: prompt to datasheet](docs/media/demo-esp32-imu-ecg.gif)](docs/media/demo-esp32-imu-ecg.mp4)

▶ [Watch the video (MP4)](docs/media/demo-esp32-imu-ecg.mp4)

**AI copilot designing a circuit** (local Qwen 27B model, real tool calls, sped up)

![AI copilot building a circuit](docs/media/ai-copilot.gif)

The result, a fully routed board with a BOM and the design calculations, from a one-sentence prompt:

![AI copilot result](docs/media/ai-copilot.png)

| Generate & route the PCB | Search 600k+ real parts |
|---|---|
| ![PCB generation](docs/media/pcb.gif) | ![Parts database](docs/media/parts-database.gif) |

| Create symbols & footprints | Real footprints from the database |
|---|---|
| ![Part editor](docs/media/part-editor.gif) | ![Edit a database part](docs/media/part-editor.png) |

**PCB editor** — layers panel, PCB tools, hand routing with T/B layer switching (vias are added automatically)

![Hand routing with layer switching](docs/media/pcb-routing.gif)

| Layers panel (show / hide / colour / active layer) | Hand-routed tracks + vias |
|---|---|
| ![Layers](docs/media/pcb-layers.png) | ![PCB editor](docs/media/pcb-editor.png) |

**3D board view** — PCB toolbar **◈ 3D / ▦ 2D**: solder mask, copper, ENIG/HASL pads, silkscreen on both sides and 3D part models (Top / Bottom / Iso, mask colour, pad finish)

![3D PCB view](docs/media/pcb-3d.png)

**3D-printable enclosure fitted to the board** — STL + parametric OpenSCAD, editable by hand or by the AI

| Inside (X-ray, lid lifted) | Closed |
|---|---|
| ![Enclosure X-ray](docs/media/enclosure.png) | ![Enclosure](docs/media/enclosure-closed.png) |

| Design rules (JLCPCB defaults) | Autorouted 2-layer PCB |
|---|---|
| ![Design rules](docs/media/design-rules.png) | ![PCB](docs/media/pcb.png) |

| Projects | Project knowledge |
|---|---|
| ![Projects](docs/media/projects.png) | ![Knowledge](docs/media/knowledge.png) |


## Features

- **Model picker** — Claude (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) or any OpenAI-compatible endpoint (OpenAI, Gemini, Grok, OpenRouter, Ollama, **Ollama Cloud** (via the server proxy), LM Studio, llama.cpp, vLLM / ExLlama / TabbyAPI, local servers); the context window is detected from the server.
- **Three copilot modes** — **Agent** edits the design with tools, **Ask** is read-only review and Q&A, **Plan** writes a BOM + netlist plan you approve with **Execute plan**.
- **Every palette part is a real JLCPCB part** — the schematic keeps clean symbols while the footprint and pinout come from a specific LCSC part (Basic parts where possible, LEDs by colour); **⇄ JLCPCB parts** converts older designs and **Export → BOM for JLCPCB assembly** matches part numbers for every value.
- **Parts archives (keep working without JLCPCB)** — ⚙ Settings → *Parts archives* keeps your own copy of the JLCPCB parts catalogue: the **Basic Parts Archive** (Basic + Preferred parts, ~1.3 MB — fetched by itself the first time the live search fails) and the full **Parts Archive** (every JLCPCB part in stock, ~450 000 parts: on the web a compact ~19 MB copy that CircuitPilot rebuilds and publishes every day, on the desktop the ~360 MB database, indexed locally for millisecond search). Search uses them next to the live JLCPCB search and on their own when it is unavailable or you are offline; results are marked *Archive*. Daily snapshots by [CDFER/jlcpcb-parts-database](https://github.com/CDFER/jlcpcb-parts-database), built from [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts); press *Update* for a newer one.
- **Backup for the EasyEDA library** — if a part's symbol and footprint cannot be loaded from EasyEDA, CircuitPilot builds the part from the open libraries instead: the same part number in the KiCad / SparkFun / Digi-Key libraries (real pin names), otherwise the standard KiCad footprint for its package (0603, SOT-23, SOIC-8, QFN-32 5×5…, numbered pins). The LCSC number is kept for ordering and the part says where its footprint came from, so you can check it.
- **Open part libraries (KiCad format)** — search also finds about 20 000 ready parts (symbol + footprint) from the **KiCad official library** (18 000), **SparkFun** (700) and **Digi-Key** (1 000): they appear under *Open libraries* in the parts list and in the Library panel's *KiCad / open libs* tab, and the copilot gets them from `search_parts` (keys `OL:…`). The symbol and footprint are downloaded from the library's own repository when the part is placed; they are custom parts (no LCSC number — pick an LCSC part for JLCPCB assembly). The part list is `data/open-parts.txt`, rebuilt with `tools/open_library_index.py`.
- **Real component databases** — one search asks the **JLCPCB catalogue** (stock, price, Basic/Extended), the **EasyEDA official library** (about 1.6 million LCSC parts, including modules JLCPCB does not stock) and the **EasyEDA community library** (parts drawn by EasyEDA users — breakout boards, modules, rare chips; marked *community*, placed as custom parts, so check their footprint) at once, plus My Library. A database that is slow to answer is skipped after a few seconds and repeated searches come from memory. **Only parts that have a footprint are shown**: every result is checked against the EasyEDA library in one batch request (remembered locally), so whatever you pick can go straight onto the PCB. Exact pinouts and real footprints, cached locally; parts found only in the EasyEDA library are marked *EasyEDA lib*.
- **Library panel, like EasyEDA's** — **📚 Library** (or **Shift+F**) opens a floating window that searches every source at once (JLCPCB, EasyEDA library, community, My Library, built-in symbols; filter with the source tabs) and shows the **symbol and footprint** of the selected part beside the results, with pins, pads, package and datasheet. Place with **Place**, a double-click or Enter, or **drag a row onto the schematic**; it lands where you drop it. Parts in the left palette and its search results can be dragged onto the schematic too.
- **Part editor** — create or modify symbols and footprints (generators for SOIC/TSSOP/QFN/DIP/SOT…, draggable pads); saved to *My Library*. **KiCad library…** searches the official KiCad footprint library (15 000+ footprints, downloaded from gitlab.com/kicad on demand) and puts the chosen footprint on your part; *Pins from pads* then creates the missing pins.
- **Projects** — saved on the server with autosave; same projects on PC and phone.
- **Save in a folder on your PC** — **📁 Folder ▾ → Save to folder…** writes the project as `<name>.circuit.json` into a folder you choose, and from then on every save (and autosave, undo, redo) updates that file — easy to back up, put in Git or Dropbox, or move to another PC. **Open from folder…** opens a project file from a folder and keeps saving back to it; **Stop saving to folder** unlinks it (the file stays). The 📁 next to the save status shows where it goes; after a browser restart one click lets it continue. Needs Chrome or Edge (other browsers download the file instead).
- **Chat attachments** — 📎 attach photos, PDFs (datasheets), Word or any text file; paste or drag & drop too. Claude reads PDFs natively, other models get the extracted text; images go to vision models.
- **Chat controls** — 🌐 Web search toggle (on by default), 📁 folder for project docs, a context meter (used / window, % left), 🗜 Compress to summarise the chat, and automatic compression at 80% full.
- **Project knowledge** — point a project at a folder of docs, guides and datasheets (md/txt/pdf/docx) the AI follows.
- **Checkpoints** — every Agent message snapshots the design; restore with one click. Full undo/redo.
- **Schematic editor** — built-in parts plus database/custom parts, power symbols, click pin-to-pin wiring, drag, rotate (R), auto-layout.
- **Any AI provider, several at once** — save as many OpenAI-compatible providers as you like (Google Gemini, Ollama Cloud, NVIDIA, OpenAI, OpenRouter, Groq, your own vLLM / LM Studio / llama.cpp server…), each with its own URL and key, and pick any of their models from the menu above the chat. **🔑 Connect AI → Custom URL** adds one in a few seconds. Providers that refuse requests from web pages (e.g. NVIDIA) are reached automatically through `server.py` or, on pcbgo.site, the CircuitPilot relay (which stores nothing).
- **The AI can see its work** — `view_design` gives the copilot (and Claude Code) a screenshot of the schematic, the 2D PCB, the 3D board or the enclosure, so it can spot crowded symbols, odd placement or a part sticking out of the case and fix it. Screenshots appear in the chat; only the latest two are sent with each request, and text-only models are handled automatically. With Claude Code, the screenshots are drawn by the CircuitPilot tab open in your browser.
- **Move between EasyEDA and CircuitPilot** — **Projects → Import** opens an EasyEDA Pro project file (`.epro` / `.epro2`) with its schematic sheets *and* PCB (placement, tracks, vias, pours, outline, LCSC numbers), or an EasyEDA Standard PCB. **Export → EasyEDA project: schematic + PCB (.zip)** goes the other way: open it in EasyEDA Pro with *File → Import → EasyEDA (Standard)*.
- **Net highlight on the PCB** — click a track, via or pad: the whole route of that net glows (both layers), its pads and vias get rings, every part on the net is outlined, and a tag shows the net name, pads, parts and routed length; Properties lists the connected parts (click one to jump to it).
- **Cross-probing** — select a part or a net in the schematic and it is selected on the PCB, and the other way round (clicking a track highlights its whole net in the schematic). Switching tabs scrolls to the selection and opens the right schematic sheet.
- **Select, move, copy, paste** — in the schematic and on the PCB: drag a box on empty space to select several parts (Shift+click adds or removes), drag any of them to move the group, **Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D / Ctrl+A**, **R** rotates and **Del** deletes the selection. Right-click a part (or the selection) for a menu: Cut, Copy, Paste, Duplicate, Rotate, Delete, Properties, Edit symbol & footprint — plus Flip side and Lock position on the PCB. Pasted groups keep their power nets (GND, +3V3…) and their own wiring on new nets. Right- or middle-drag pans.
- **Professional schematic sheets** — an A-series drawing frame with zone markers and a title block (title, company/author, document, sheet *n of m*, date, revision, size) filled from the Documentation fields; toggle it with the *frame* checkbox. **Multi-page schematics**: add sheets with ＋ in the sheet bar (double-click a tab to rename it), move parts between sheets from Properties, and nets that continue on another sheet are drawn as net labels and connected by name. The copilot can use sheets too (`add_sheet`, `move_to_sheet`, `sheet` in `add_components`).
- **Readable spacing enforced** — after every copilot edit the layout is spaced out so that parts *and their net labels* never overlap, no matter where the model put them.
- **PCB** — rule-driven 2-layer autorouter (Web Worker) with vias and neck-down, ratsnest, draggable footprints; routed tracks are straightened into clean 0°/45°/90° runs with a clearance safety margin, so they pass DRC.
- **Routing that keeps trying** — negotiated rip-up and reroute: when a net is stuck, the router finds the nets in its way, rips them up, routes the stuck net and re-routes the others, learning which corridors are contested (history cost), with restarts — for up to the *Autorouter effort* time (Rules, default 90 s), stopping as soon as everything is routed. Progress shows the nets still unrouted; **Stop** keeps the best result so far. No vias on SMD pins (via-in-pad only as a flagged last resort).
- **Placement** — **Auto-place ▾ → Quick place**: annealing that pulls connected parts together (2-pin links like decoupling caps hardest), keeps connectors (USB, headers, jacks) on the board edges and the biggest IC in the centre, runs several tries and keeps the best; with Board size empty it finds the **minimum-area board** (tries three board shapes, shrinks width and height while the placement stays legal) — e.g. 555 example 1124 → ~340 mm². **✦ AI place** asks the model once for a floor plan (JSON mode, compact parts + nets list), then legalises, polishes and routes it — works with local models too.
- **✨ Optimize ▾** — moves parts (local re-arrangement around stuck nets and fresh global arrangements) and re-routes until every net is connected; **…and make the board as small as possible** then shrinks the outline step by step while everything still routes (e.g. 45×26 → 20.5×11.8 mm on the 555 example).
- **Silkscreen text** — every part's label (its reference) is placed automatically next to the part where it covers **no pad**, no other part and no other label (mirrored on the bottom side), and the board name goes in a free corner; the Gerber silkscreen, the 2D view and the 3D view show exactly the same text. **Drag a label** to move it (it then moves with its part), drag its corner square to resize it, **R** rotates it and **+ / −** change its size, or set text, size, rotation and visibility in Properties; **T (Text tool)** adds your own text on the top or bottom silkscreen (version, author, pin names, polarity marks). DRC warns when text covers pads. The copilot can do the same with `set_silk_label`, `add_pcb_text`, `update_pcb_text` and `remove_pcb_text`; `get_pcb_layout` lists every label with `covers_pads`.
- **Copper pours, arcs, bottom-side parts, curved boards** — GND (or any net) pours with clearance cut-outs; arc tracks; footprints on the bottom side (mirrored, bottom copper/silk/paste); rounded, round/elliptical or custom board outlines.
- **PCB drawing (PDF)** — **Export → PCB drawing (.pdf)**: vector pages for the top layer, the bottom layer, both layers (red top / blue bottom tracks, to check the routing), assembly drawings with every part's reference and value, a page at **actual size (1:1)** to lay real parts on the footprints, and the parts list (reference, value, footprint, LCSC, side, position, rotation). Each page has a title block and a 10 mm scale bar.
- **3D board view with real parts** — switch the PCB editor between 2D and a 3D render of the manufactured board (both sides, mask colour, pad finish). Parts are shown with their **real 3D models** from the JLCEDA/EasyEDA Official Library (chips, connectors, headers, passives — on the right pads, in their rotation, flipped on the bottom side); parts without a model get a simple shape. **Real models** toggles them; models are downloaded once and cached.
- **Enclosure** — a third tab builds a 3D-printable case around the PCB (follows the board outline, height from the tallest part, screw standoffs on PCB mounting holes, automatic openings for USB/jacks and holes above LEDs/buttons, snap-fit lid with vents); exports STL (base + lid) and parametric OpenSCAD.
- **Placement optimizer** — moves / rotates / swaps parts and re-routes until every net is connected (also available to the AI).
- **Gerber export with DRC check** — problems pop up with *Fix on board / Re-route / Optimize / Download anyway*.
- **PCB editor** — Layers panel (show/hide, colour, active layer, dim inactive), PCB Tools (Select, Track `W`, Via `V`, Measure `M`), interactive 45°/90°/any-angle routing with T/B layer switching and automatic vias, live clearance check, track/via properties, segment delete; the autorouter keeps hand-routed tracks.
- **Design rules & DRC** — JLCPCB 2-layer defaults, editable per project (trace/power widths, per-net widths, clearance, vias, edge clearance, layers); exact-geometry DRC with markers on the board.
- **Exports** — Gerber + Excellon drill (.zip), BOM (.csv), netlist (.net), schematic and PCB SVG, project JSON.
- **One-click ordering** — **Order at JLCPCB ↗** (PCB toolbar) runs DRC, matches LCSC parts, saves the Gerber zip plus the assembly BOM and pick-and-place (CPL) files, and opens the JLCPCB quote page: drop the zip on *Add gerber file*, and for assembly upload the two .csv files. **Order 3D print ↗** (Enclosure toolbar) builds high-resolution STLs and opens the JLC3DP quote page. (JLCPCB has no public upload link, so you drag the downloaded files in yourself.)
- **Internet access for the AI** — `web_search` and `web_fetch` let any model (Claude, Gemini, local Qwen …) look up datasheets, application notes, prices and anything else, reading web pages and PDF datasheets; private / local addresses are blocked. Toggle in ⚙ Settings (DuckDuckGo by default, optional Brave Search key).
- **Light / dark theme** — header button cycles 🖥 System → ☀ Light → 🌙 Dark (remembered per browser; the PCB canvas stays black for layer contrast).
- **Automation** — MCP server for Claude Code / Claude Desktop / Cursor, plus a REST + OpenAPI interface.

## Web version and desktop version

| | Web version (GitHub Pages) | Desktop version (`server.py`) |
|---|---|---|
| Install | none, open the link | Python 3, `python server.py 5173` |
| Projects and My Library | saved in your browser (export `.json` to back up) | `projects.db` on your PC, shared by all your devices |
| Part search, web search, Ollama Cloud | through the [CircuitPilot relay](relay/README.md) | direct from your PC |
| Cloud AI (Claude, OpenAI, Gemini, OpenRouter…) | yes | yes |
| Local models (llama.cpp, LM Studio, Ollama) | yes, with CORS enabled in the model server | yes, no setup |
| Chat attachments | PDF, images, text | PDF, Word, images, text |
| Knowledge folders, Claude Code (MCP) | no | yes |

The web version is the same app: when it is not served by `server.py`, `js/static-backend.js` answers the app's requests in the browser.

**Privacy:** API keys and designs stay in your browser. The public website (pcbgo.site) counts anonymous visits with [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/): no cookies, no personal data, only page views, country and referrer. Copies you run yourself (desktop version, forks) send nothing.

**Local models in the web version** need the model server to accept requests from the web page (CORS): Ollama with `OLLAMA_ORIGINS=https://pcbgo.site`, LM Studio with *Enable CORS* in the server settings, llama.cpp's `llama-server` allows it by default. Your browser may ask for permission to reach devices on your local network.

## Run

No build step and no dependencies. Start the bundled server (static files + a proxy for local model servers):

```bash
python server.py 5173
```

On Windows you can simply double-click **`start.bat`** (starts the server, shows the LAN address, optionally opens a public Cloudflare link). Open http://localhost:5173 (or `http://<your-PC-IP>:5173` from another device on your LAN), then open **⚙ Settings** and add an API key.

API keys are stored in your browser's localStorage and sent directly from the page to the provider you choose — fine for personal/local use, but don't host it publicly with keys baked in.

## Project layout

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | UI layout and theme |
| `js/lib.js` | Symbol and footprint library |
| `js/model.js` | Design state, nets, undo, ERC, schematic auto-layout |
| `js/schematic.js` | Schematic rendering and editing |
| `js/pcb.js` | Placement, autorouter, PCB view, Gerber/drill/zip export |
| `js/easyeda.js` | EasyEDA interchange: schematic export, PCB import |
| `js/easyedapro.js` | EasyEDA Pro project import (.epro / .epro2): schematic sheets + PCB |
| `js/kicad.js` | KiCad official footprint library for the part editor (index in `data/kicad-footprints.txt`, rebuilt with `tools/kicad_footprint_index.py`) |
| `js/enclosure.js`, `js/shape3d.js`, `js/shape-worker.js` | Parametric box enclosure, CSG kernel, custom 3D script modeller (+ sandboxed worker) |
| `js/ai.js` | Providers, tool definitions, agent loop |
| `js/app.js` | Panels, chat, settings, exports |
| `js/engine.js` | Design tools shared by the copilot, MCP server and REST API |
| `js/projects.js`, `js/editor.js` | Project manager / autosave, part editor |
| `server.py`, `store.py`, `partsdb.py`, `knowledge.py` | Server, project + library storage, parts database, knowledge folders |
| `mcp/circuitpilot-mcp.mjs` | MCP server (Claude Code) and REST API |
| `docs/capture.mjs` | Regenerates the README screenshots and GIFs (headless Chrome + ffmpeg) |

## Limitations

- Palette parts (resistor, capacitor, LED, diodes, transistors, MOSFETs, regulator, op-amp, crystal, fuse, inductor, potentiometer, buzzer) are backed by real JLCPCB parts — their footprints and pinouts come from the part library and pins are matched by name, so e.g. the AMS1117's IN/OUT/tab and each LED's cathode land on the right pads. Pin headers / generic connectors and the push button keep standard generated footprints (a 4-pin tact switch's internal pairs are not documented in the library); if you pick a generated footprint from the Footprint menu, verify its pin order against your part's datasheet.
- The router works on a grid; very dense boards can still leave a net unrouted within the time budget — run **✨ Optimize**, add a GND pour, or give it a bigger board.
- Touch editing (drag/pinch) on phones is not implemented yet.

## Local models (llama.cpp, TabbyAPI, LM Studio, Ollama…)

In **⚙ Settings → OpenAI-compatible**, enter the server URL (e.g. `http://localhost:8080/v1` or click the **Local :8080** preset). The model list is fetched automatically from `/v1/models` and appears in the model picker. The model must support OpenAI-style tool calling for Agent mode.

Requests to `localhost` servers are routed through `server.py` (`/llm-proxy/<port>/...`), so local models work even when they only listen on 127.0.0.1 or don't send CORS headers — including from a phone on your LAN.

## Public URL (Cloudflare tunnel)

```bash
python server.py 5173 --allow-ports 8080 --password YOUR_PASSWORD
cloudflared tunnel --url http://localhost:5173
```

Always set a password when exposing the app: the LLM proxy gives access to your local model. The proxy only forwards to ports listed in `--allow-ports` (default `8080`).

## Component database (JLCPCB / LCSC)

Type a part number in the Parts search box (e.g. `ESP32-C3`, `AMS1117`, `CH340C`, `USB-C`) to search the JLCPCB/LCSC catalogue (stock, price, Basic/Extended). Click a result to place it: the exact pinout and real PCB footprint are loaded from the part library (see *Data sources* below).

The AI copilot has the same database through the `search_parts` and `get_part` tools, so you can ask for e.g. *"ESP32-C3 board with USB-C, AMS1117 regulator and a status LED"* and it will pick real in-stock parts.

Everything fetched is cached in a local SQLite database (`parts.db`), so parts you've used keep working offline. Part definitions are also saved inside each design file.

## Projects

Projects are stored on the server (`projects.db`, SQLite) and saved automatically — the status next to the project name shows **✓ Saved**. Use **▤ Projects** to open, duplicate, rename, delete or import projects, **＋ New** to start one, and **Save as…** (`Ctrl+Shift+S`) to save the current design under a new name and continue in the copy. The same projects appear on every device that opens the app. **Export → Project file (.json)** downloads a portable copy.

**Import a whole folder**: **▤ Projects → Import folder…** (or the folder menu → *Import all projects in a folder…*) searches the folder and all its subfolders for CircuitPilot projects (`.json` / `.circuit.json`) and EasyEDA PCB files, lists what it found (projects already in CircuitPilot start unticked) and adds the ticked ones as new projects; the first one opens. Claude: `import_folder {path, dry_run?}`.

**Earlier versions**: the desktop server keeps earlier states of every project — about every 10 minutes while you edit, whenever many parts disappear in one save, before a restore and when a project is deleted (60 per project). **▤ Projects → ⟲** lists them with **Restore**; **Deleted projects…** brings back a deleted one. Claude: `list_project_versions`, `restore_project_version`, `copy_project`.

## Part editor (custom symbols & footprints)

- **＋ New part** (Parts panel) opens the editor: pins (number, name, side L/R/T/B, bulk edit), live symbol preview, and a footprint editor with generators (0805, SOT-23, SOT-223, SOIC-n, TSSOP-n, QFN-n(-EP), DIP-n, pin headers…), draggable pads (0.05 mm snap) and per-pad size/shape/drill.
- Select any placed part → **✎ Edit symbol & footprint** to fix a database part, or **✎ Make editable part** to turn a built-in part into a custom one.
- Saved parts go to **My Library** (shared across projects); every placed instance updates when you edit a part.
- The AI can do the same with the `create_part` / `update_part` tools.

## Project knowledge folder

Click **📚 Knowledge** in the copilot and enter a folder on the PC running the server. Design notes, requirements, coding/naming rules and datasheets (`.md .txt .pdf .docx .csv .json`, source code…) are given to the AI: small documents go straight into its context, the rest it searches and reads with `knowledge_search` / `knowledge_read`. Try it with [`examples/knowledge`](examples/knowledge).

Only document-type files inside the chosen folder are read (no `..` escapes, hidden folders and `.git`/`node_modules` are skipped). Anyone who can log in to the app can point it at a folder on the server PC, so keep the password private.

## Control from Claude Code (MCP) and other tools

`mcp/circuitpilot-mcp.mjs` exposes all 84 design tools — projects, parts database, schematic editing, ERC, custom parts, knowledge, PCB generation, Gerber export — through the **Model Context Protocol**. It runs the same engine as the browser app and talks to the running `server.py`, so every change shows up live in the browser.

**Claude Desktop (easiest)** — run once:

```bash
node mcp/install-claude-desktop.mjs
```

then quit Claude Desktop completely (also from the system tray) and open it again. Now just ask, e.g. *"Design a USB-C powered ESP32-C3 board with a BME280 sensor, 30 × 30 mm"*. Claude calls `start_here`, CircuitPilot starts `server.py` by itself if it isn't running, opens the project in your browser, and the open tab follows whichever project Claude works on. There's also a ready-made **Design a board with CircuitPilot** prompt in Claude Desktop's **+** menu.

**Claude Code** — this repo ships a `.mcp.json`, so just open the folder in Claude Code (with `server.py` running) and approve the `circuitpilot` server. Or add it globally:

```bash
claude mcp add circuitpilot -e CP_URL=http://localhost:5173 -- node /path/to/CircuitPilot/mcp/circuitpilot-mcp.mjs
```

Then ask e.g. *"Using circuitpilot, create a project 'ESP32 sensor board' with an ESP32-C3-MINI-1, AMS1117 and USB-C, then generate the PCB and export Gerbers to ./fab"*.

The password is read from `access-password.txt` (or set `CP_PASSWORD`). Other MCP clients (Claude Desktop, Cursor, VS Code…) use the same command.

**REST / OpenAPI** for anything else (scripts, n8n, OpenAI function calling…):

```bash
node mcp/circuitpilot-mcp.mjs --http 5174
curl -H "Authorization: Bearer <password>" http://127.0.0.1:5174/tools
curl -H "Authorization: Bearer <password>" -X POST http://127.0.0.1:5174/tools/search_parts -d '{"query":"CH340C"}'
```

`GET /openapi.json` returns an OpenAPI 3.1 spec of every tool. Add `"project": "<id or name>"` to any call to switch project. The REST server listens on 127.0.0.1 only (add `--public` to expose it).

**Working safely with several projects**
- Every tool takes `project` (id or exact name); the call works on that project. The current project is remembered in `%LOCALAPPDATA%\CircuitPilot\mcp-state.json`, so a restart of the MCP server (e.g. after a timeout) continues on the same project. Without a current project the tools ask for one — they never pick "the most recent project".
- One database: when no app is running, the MCP server starts `server.py` with the Windows app's projects folder (`%LOCALAPPDATA%\CircuitPilot`, or `CP_DATA_DIR`). `start_here` shows which projects folder the running app uses.
- **Background jobs**: `generate_pcb`, `route_pcb`, `optimize_pcb`, `place_footprints`, `update_pcb_from_schematic`, `auto_layout` and `export_project` run in a worker thread. They answer directly when done within ~40 s, otherwise they return a `job_id`; `job_status {job_id}` waits up to 55 s per call for the result, `cancel_job` stops one. While a job runs, its project is locked against edits (other projects stay usable). This repo's `.claude/settings.json` also sets `MCP_TOOL_TIMEOUT=300000` for Claude Code.
- Circuit blocks: `copy_block {refs, to_project?, keep_nets?, place: "free"}` copies a group of parts with its layout and inner tracks; `copy_project` copies a whole project.
- **Screenshots, PDFs and export images without a window**: when no CircuitPilot window shows the project, the MCP server opens it in a hidden (headless) Edge / Chrome, draws there and closes it after 10 idle minutes (with an app password it logs in with a one-time link).
- `batch {calls: [{tool, args}]}` runs many quick edits in one call (e.g. side / rotation of 20 parts); `export_parts` / `import_parts` move My Library parts between databases or PCs.
- `pcb_status` lists every unrouted net with its pad groups and the router's reason.

## Design rules (JLCPCB defaults) and DRC

**PCB → ⚙ Rules** edits the project's design rules. The autorouter follows them and **DRC** checks the finished board against them.

| Rule | JLCPCB standard preset | JLCPCB minimum |
|---|---|---|
| Trace width | 0.25 mm | 0.1 mm |
| Power / GND trace width (only with *Wider tracks for power / GND nets*) | 0.5 mm | — |
| Clearance (copper–copper) | 0.2 mm | 0.1 mm |
| Via diameter / drill | 0.6 / 0.3 mm | 0.25 / 0.15 mm (extra cost; free from 0.4 / 0.3 mm) |
| Copper to board edge | 0.3 mm | 0.2 mm |
| Hole to hole | — | 0.5 mm |
| Plated through-hole pad ring | — | 0.18 mm |

JLCPCB makes tracks / gaps down to 0.1 mm and vias down to 0.15 mm hole / 0.25 mm diameter, but on 1–2 layer boards **vias cost nothing extra only with a hole ≥ 0.3 mm and a diameter ≥ 0.4 mm** (0.2 mm holes are free only on multi-layer boards, at ≥ 0.45 mm diameter); the diameter must be ≥ hole + 0.1 mm (0.15 preferred) — the rules warn about that, DRC lists each extra-cost via size once, and Gerber exports / the datasheet say which via size the board uses.

- Presets: **JLCPCB smallest at no extra cost** (`jlcpcb_free_min`, the default: 0.2 mm tracks, 0.1 mm gaps, 0.45 / 0.3 mm vias — tracks can go down to 0.1 mm on tight boards, and *neck down* narrows them to that minimum only where 0.2 mm does not fit), **JLCPCB standard** (`jlcpcb`: 0.25 mm tracks, 0.6 / 0.3 mm vias), **JLCPCB 5/5 mil**, **JLCPCB power/robust**, **Home etching / CNC (1 layer)** — then tweak any value.
- **No via in pad** (default on): vias never go on SMD pads — not even as the router's last resort — and DRC reports one as an error, so the Gerber export refuses it. Only a real exposed pad (a QFN / DFN paddle among at least four pins) may take thermal vias; module edge pads (XIAO castellations), coin-cell contacts and big chip pads never do. `add_via` / `add_track` refuse a via that touches an SMD pad. When a net cannot be routed, `route_pcb` says why (`failed_reason`).
- **Keep-out areas** (**K** tool, or `add_keepout`): no tracks, vias or copper pour inside — each can be allowed again — and optionally no parts; on top, bottom or both. For the antenna end of a module, under a coin cell, around a crystal. The router and copper pours avoid them; DRC reports what is inside. Click the dashed border to edit or delete one.
- **Tracks under batteries / metal parts** (Rules checkbox, off by default; `warnUnderMetal`): DRC warns about tracks and vias of other nets on the same side under a coin cell, battery holder, shield can or magnet, where only solder mask insulates them.
- **Copper pours** drop dead copper: pieces that touch no copper of their net, and pieces smaller than *pourMinArea* (default 0.5 mm²) — in the view, the Gerbers and the connectivity check. `get_pcb_layout` lists the islands per pour.
- **Board outline**: `set_board_shape` keeps coordinates as they are (parts, tracks and keep-outs stay put; only an outline that reaches below 0 moves everything, by the returned offset), and makes round boards directly: `{shape: "circle", d: 30, flat: {side: "left", at: 3}}`, `rounded_rect`. A round single-pad part (electrode) counts by its circle, not its square box, for "outside the board".
- **Routing control**: `route_pcb {nets: [...]}` re-routes only those nets; `lock_tracks {net | tracks | all}` keeps good tracks through every re-route and optimisation; `generate_pcb {keep_placement: true}` only routes, without placing the parts again. `stitch_pour {net, max_spacing}` adds stitching vias between a net's top and bottom pours (and one into every piece that has none); `get_pcb_layout {pour_pieces: true}` lists each pour piece with the pads it touches.
- **Keep-out at a part's end**: `add_keepout {ref: "U1", end: "top", depth: 6, beyond: 5}` — the antenna end of a XIAO / ESP32 module.
- **Silkscreen**: `arrange_silk_labels {hide?}` puts every reference label back next to its part, off pads, smaller where needed, hidden where there is no room.
- **Editing**: dragging a via drags the tracks that end on it; parts on a hidden side (copper layer switched off) cannot be selected.
- **Placement helpers**: `check_placement` (overlaps, outside the outline, in a keep-out, on a mounting hole — in well under a second; SMD parts on opposite sides may overlap), `place_in_free_area` (nearest free board space, as a group or part by part).
- **One width by default**: every net is routed with the trace width; tick *Wider tracks for power / GND nets* in Rules to give power and ground the power width. **Per-net widths** (e.g. `+5V` 0.8 mm, `MOTOR` 1.2 mm) override both.
- **Changing widths after routing**: click a track — its whole net lights up (the rest is dimmed), the net name shows on the board, and Properties lists the net's tracks, vias and pins. Set the width for that track, the whole net, or every track (DRC reports at once if something no longer fits); *Reset wide tracks to rule width* brings wider tracks back to the rule.
- **Neck-down**: when a wide trace can't reach a fine-pitch pad, the router narrows it (power width → trace width → fab minimum) and reports which nets were necked down.
- Clearance is computed against the real pad shapes, so traces escape fine-pitch QFN/USB-C pads at JLCPCB clearances. Vias are allowed inside a net's own large pads (e.g. module ground pads).
- **DRC** uses exact geometry: shorts and clearance, trace width, via drill and annular ring, hole-to-hole spacing, copper-to-edge, unrouted nets, and rules set below the fab minimums. Click a violation to zoom to it.
- The AI and MCP/REST clients get `get_design_rules`, `set_design_rules` and `run_drc`; `generate_pcb` reports the DRC result.

Values follow JLCPCB's published capabilities; check [jlcpcb.com/capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) for the latest before ordering.

## PCB editor

**⟳ Update from schematic** loads schematic edits onto the board without placing or routing anything: new parts are lined up beside the board with their ratsnest for you to drag into place, changed footprints update in place, and tracks of deleted nets are removed. Schematic edits no longer wipe a net's routing — adding a part to GND keeps every GND track, and a footprint change or removed part only drops the tracks on that part's pads. (The copilot's `update_pcb_from_schematic` tool also places the new parts and routes what is missing.)

**Footprints for passives**: resistors, capacitors, inductors and LEDs can be switched between the JLCPCB part's own footprint (shown as e.g. *0603 · JLCPCB C25804*) and standard 0402 / 0603 / 0805 / 1206 / THT footprints in Properties; the assembly BOM then matches an LCSC part in the new package.

| Action | How |
|---|---|
| Layers | **Layers** panel: eye = show/hide, swatch = colour, click a copper layer = make it active; **All / None / Top / Bot** quick views; *Dim inactive copper* |
| Select / move | `S` or `Esc` — click a footprint, track segment or via; drag footprints and vias; double-click a track to select all of it; `R` rotates a footprint |
| Route a track | `W`, click a pad / via / track to start (net is taken from it), click to add corners, click a pad of the same net to finish |
| While routing | `T` / `B` / `L` / `V` switch layer (adds a via) · `Space` cycles 45° / 90° / any angle · `/` flips the bend · `+` / `-` width · `Backspace` removes the last corner · `Esc` or right-click finishes |
| Via | `V`, click to place (takes the net of what is under it) |
| Measure | `M`, click two points (mm and mil) |
| Delete | select, then `Del` (a segment splits its track) |
| Edit | select a track or via → change net, layer, width / diameter, drill, position in **Properties** |

Live feedback: the coordinate bar shows X/Y, layer, width, net, and warns when the track being drawn violates the clearance rule; vias placed while routing are checked too. **Route** (autorouter) keeps every hand-drawn track and re-routes the rest with rip-up; the ratsnest and the “routed” count follow the real copper.

### Connectors on the board edge

**Board size is kept**: once a board exists (or you type a size in Board W×H), Auto-place and Generate PCB fit the parts *inside* the existing outline — rectangle, rounded, round or custom — scaling the schematic arrangement to the board, keeping parts inside the edge clearance, rotating long parts and tightening spacing when crowded. The board is never enlarged on its own: if the parts cannot fit you get a message with how much of the board they need. Clear the Board W×H boxes to size the board to the parts instead. The ✨ Optimizer also keeps the board size.

**Generate PCB** puts connectors on the nearest board edge automatically: USB, DC jacks, RF and card connectors are rotated so the **opening faces outward, flush with the edge** (so a cable can plug in); pin headers and terminals sit just inside the edge. To choose the edge yourself, select the footprint on the PCB and click **⇤ Left / ⤒ Top / ⤓ Bottom / Right ⇥** in Properties — or ask the AI ("put the USB connector on the bottom edge"), which uses the `place_footprint` tool. The choice is remembered for later re-placements; press **Route** afterwards to reconnect.

### More PCB tools

| Feature | How |
|---|---|
| Copper pour | **⬛ Pour GND** (whole board, both layers) or the **Copper area** tool `E`: click corners, click the first corner to close; set net / layer / clearance in Properties. Other nets keep the clearance rule, same-net pads/tracks connect, the outline edge clearance is respected. Exported with clearance cut-outs. |
| Arc track | `A`: click start, click end, click to set the curve. |
| Drag tracks | Select tool: drag a segment (neighbours stay attached; a new corner is added at pads) or drag a corner. |
| Tracks drawn by the AI | The copilot / Claude can draw single tracks like you do with the Route tool: `add_track` from a pad through corner points to a pad (`{x, y, via: true}` changes layer, `corner: "45"` adds the knees), `add_via`, `get_tracks`, `remove_tracks` (by index, net, only autorouted or only hand-drawn). Each new track is checked against the design rules right away; **Route** keeps hand-drawn tracks and routes the rest around them. |
| Bottom side | Select a footprint → **▼ Bottom** in Properties (mirrored, SMD pads on BottomLayer, BottomSilk, bottom paste/mask). The AI: `place_footprint {side: "bottom"}`. |
| Board outline | **▭ Board**: rectangle, rounded rectangle, circle/ellipse, or **Draw outline** (custom polygon with rounded corners). Router, DRC, pours and the Edge_Cuts Gerber follow it. |
| Optimize | **✨ Optimize** moves, rotates and swaps parts (and can grow the board) and re-routes until everything connects, keeping the best result. Connectors on edges stay put. The AI: `optimize_pcb`, or `get_pcb_layout` + `place_footprint` + `route_pcb`. |
| Gerbers | **Gerbers ⤓** runs DRC first. If anything is wrong a window lists it (click to zoom) with **Fix on board · Re-route · Optimize placement · Download anyway**. Export includes copper, mask, paste, silkscreen (top + bottom), outline and drill. Via MCP, `export_gerbers` refuses on DRC errors unless `force: true`. |
| Export everything | **Export ▾ → Everything (.zip)** puts every file of the project in one zip: project file (.circuit.json), Gerbers + drill (also zipped for the fab), JLCPCB BOM + pick-and-place (CPL), BOM, netlist, schematic / PCB SVG, enclosure STL + OpenSCAD, EasyEDA schematic + PCB, PCB drawing PDF, datasheet PDF and images (schematic sheets, 2D PCB, 3D angled / top / bottom, enclosure). Claude Desktop / Claude Code: `export_project` writes the same files into `Documents/CircuitPilot exports/<project>/` (or `out_dir`), with a README listing them. `include` picks only some, e.g. `["gerbers", "jlcpcb"]`. PDFs and images are drawn by the CircuitPilot window, which is opened on the project if needed. |

## Enclosure (3D print)

The **Enclosure** tab builds a printable case around the current PCB and previews it in 3D (drag to orbit, right-drag to pan, wheel to zoom; *Explode*, *X-ray*, *Lid*, *PCB* toggles).

- **Fits the board**: the cavity follows the board outline (rectangle, rounded, round or custom) plus a clearance gap; the height comes from the tallest part (estimated per package — override any part height).
- **Board support**: click **＋ Add M3 mounting holes** (adds non-plated Ø3.2 mm holes to the PCB, kept clear of parts and copper, in the NPTH drill file) to get **screw standoffs**; without holes the board rests on corner supports. Standoffs rise automatically to clear parts on the bottom side.
- **Openings**: automatic for edge connectors (USB, DC jack…, at the right wall and height) and holes in the lid above LEDs and buttons; add your own rectangle / circle cutouts on any wall, the lid or the floor.
- **Lid**: snap-fit lip with an adjustable fit tolerance, optional vent slots.
- **Export**: **STL ⤓** (base + lid; the lid is already oriented for printing), **OpenSCAD ⤓** (parametric source of the same design), or **All (.zip)** with print notes.
- **AI**: "make the walls 3 mm, add a 6×4 mm cable slot on the right and more room above the board" → `set_enclosure`, `add_enclosure_cutout`, `add_mounting_holes`, `get_enclosure`; Claude Code can also `export_enclosure` straight to a folder.

### Custom 3D designs (wearables, patches, organic cases)

Switch the Enclosure tab to **Custom 3D** for anything that is not a box: a Whoop-style **wristband pod** with a curved underside and strap lugs, an **ECG chest patch** with snap-electrode holes, clips, mounts, rounded or organic housings. Just describe it to the AI:

> "Make a wristband pod like Whoop for this board: 22 mm strap, USB-C opening, as thin as possible"
> "ECG chest node with 3 snap-electrode holes 60 mm apart on the skin side and a window over the LED"

The AI writes a short **3D script** (`set_enclosure_script`): rounded boxes, convex hulls, extrude / revolve, union / difference / intersection, transforms — positioned relative to the PCB, whose outline, part boxes, heights and edge connectors it gets as context. Every build returns a **fit report** (printed parts colliding with the board or components, script errors with line numbers), so the AI iterates until it is clean.

- **35 tested templates**, all sized from your board: 10 wrist wearables (Whoop-style pod, round / square / hex / octagon watches with spring-bar lugs, capsules, slim bands, cuffs — concave wrist backs), 10 chest / ECG (3-lead oval, heart-rate strap pod, Holter 5-lead with belt clip, round and hex 3-electrode patches, adhesive patches with flange, lead-wire box, 4-electrode patch), 7 other body-worn (ankle, arm, headband, pendant, key fob, belt clip, badge) and 8 boxes. Every template is checked on real boards: the PCB and every part are inside, nothing collides, every printed part is watertight.
- **Enclosure kit** for the AI and for your own scripts: `envelope()` (board + every part), outlines that contain it (oval, circle, pill, hex, octagon, squircle), soft rounded bodies, wrist curves, strap lugs, snap-electrode holes, belt clips, loops, connector openings, LED / button windows, board posts, and a lid with a press-fit lip.
- **</> Script** opens the editor (Ctrl+Enter to build, templates: wristband pod, ECG patch, rounded box; **?** shows the API).
- Builds run in a sandboxed Web Worker (no network access) and produce **watertight meshes**.
- **Export**: one **STL per part** (lids/covers flipped for printing), equivalent **OpenSCAD** source, and the script itself in the zip.

The geometry engine (CSG with watertight-mesh repair) is self-contained JavaScript, so it runs in the browser and in the MCP server; only the 3D preview loads three.js from cdnjs.

Fit check: a part counts as *not enclosed* only when its centre, or most of a grid of points in its box, can see out of the enclosure; parts whose estimated box only touches a wall are listed under `near_wall` (set their real height with `set_enclosure {partHeights}`). Coin-cell holders are estimated at 4.4 mm with the cell. `envelope({side: 'top' | 'bottom', parts, exclude})` sizes a body from only some parts.

## Documentation (product datasheet PDF)

The **Documentation** tab turns the design into a product datasheet — previewed live, exported with **PDF ⤓**:

- cover with title, tagline, 3D render and key specifications; description, features and applications (**✦ Write with AI** drafts them from the design; edit them in the side panel, or let Claude Code write them with the `get_documentation` / `set_documentation` tools)
- main components and power rails, full schematic
- PCB: 3D renders of the top and bottom, copper layout, PCB / fabrication specifications (size, layers, track / space, vias, holes, routing, DRC / ERC)
- mechanical drawing with board dimensions, mounting holes and edge connectors; connector pinout tables
- enclosure renders (assembled and exploded) with dimensions; bill of materials with LCSC numbers; revision table

Enclosure **STL ⤓** files are always rebuilt at high resolution (≈0.4 mm curve segments) so they can go straight to a 3D-printing service; the on-screen preview stays fast.

## Windows app (CircuitPilot.exe)

**Download:** [CircuitPilot-Windows.zip](https://github.com/Abdelhayali/CircuitPilot/releases/latest/download/CircuitPilot-Windows.zip) from the [latest release](https://github.com/Abdelhayali/CircuitPilot/releases/latest) — unzip anywhere and double-click `CircuitPilot.exe` (Windows 10 / 11, 64-bit). Windows SmartScreen may warn because the app is not code-signed: **More info → Run anyway**.

`python desktop/build_windows.py` builds `dist/CircuitPilot/CircuitPilot.exe` (and `dist/CircuitPilot-Windows.zip`): the whole desktop version — server, AI, parts databases and archives, open libraries, Gerbers, 3D, enclosure — in one folder that needs no Python or Node.js installed. Double-click **CircuitPilot.exe**: it starts the server and opens the app in its own window (Microsoft Edge app mode). Projects and downloads are kept in `%LOCALAPPDATA%\CircuitPilot`.

**Claude Desktop:** ⚙ Settings → *Claude Desktop* → **Connect** (or `CircuitPilot.exe --connect-claude`), then quit Claude Desktop completely and open it again. The connection uses the Node.js bundled in the folder and starts CircuitPilot.exe by itself when Claude needs it.

Options: `--port 5173`, `--server-only` (no window), `--lan --password SECRET` (also serve phones on your network).

## EasyEDA interchange

- **Export → EasyEDA project: schematic + PCB (.zip)** puts both documents below in one zip, to continue the design in EasyEDA Pro (*File → Import → EasyEDA (Standard)*, choose the zip) or EasyEDA Standard. **Export → PCB for EasyEDA (.json)** writes only the PCB: every footprint with its pads (written in full, so no library lookup is needed), tracks, vias, holes, copper pours and the board outline, with the schematic's net names.
- **Export → Schematic for EasyEDA (.json)** writes the schematic as an EasyEDA Standard document (symbols, pins, net labels, LCSC part numbers). Open it in EasyEDA Standard with *File → Open → EasyEDA Source*, or in EasyEDA Pro with *File → Import → EasyEDA (Standard)*. Every part with an LCSC number is linked to its EasyEDA library symbol and footprint, so EasyEDA's *Footprints Verification* finds them (parts without an LCSC number get their footprint chosen in EasyEDA).
- **Projects → Import → EasyEDA Pro project** moves a whole EasyEDA Pro design here: in EasyEDA Pro use *File → Save As (Local)* / *File → Export → Project* to get a `.epro` or `.epro2` file (a `.zip` works too) and import it. You get the schematic (every sheet, parts placed where they were, real pin names, values, LCSC numbers) and the PCB (board outline, part placement on top and bottom, tracks, arcs, vias, copper pours). If the project holds several boards you choose one. Nets come from the PCB's netlist, or from the schematic wires, net labels and power ports when there is no PCB. CircuitPilot boards have 2 copper layers: tracks on inner layers of a 4+ layer board are skipped (the import says how many), so those nets show as unrouted; run the router or re-route them. Parts rotated at odd angles (e.g. 45°) keep their exact pad positions.
- **Projects → Import → EasyEDA Standard PCB** opens an EasyEDA Standard PCB (*File → Export → EasyEDA Source* in EasyEDA) as a new project: footprints become library parts (LCSC numbers kept), with placement (top/bottom, rotation), nets, tracks, vias, holes, copper areas and the board outline; a schematic is generated from the nets.

## License and credit

CircuitPilot is open source under the [Apache License 2.0](LICENSE), © 2026 Abdelhay Ali. You can use, change and share it, including commercially.

If you redistribute CircuitPilot or build on its code, keep the [NOTICE](NOTICE) file: it credits CircuitPilot by Abdelhay Ali, and the Apache License requires that credit to be passed on with your version (in your NOTICE file, documentation or "about" screen).

If CircuitPilot helps your project, please credit it too, for example:

> Designed with [CircuitPilot](https://github.com/Abdelhayali/CircuitPilot) by Abdelhay Ali

A link back, a star on GitHub or a mention when you share your board is much appreciated.

## Data sources & licenses

CircuitPilot's design, code and UI are original work. It uses third-party **data and libraries**, credited here as their terms require:

- **Component catalogue** (search, stock, price, LCSC numbers): JLCPCB / LCSC.
- **Open libraries**: KiCad symbols and footprints (gitlab.com/kicad/libraries, CC-BY-SA 4.0 with an exception for designs), SparkFun KiCad Libraries (github.com/sparkfun/SparkFun-KiCad-Libraries, CC-BY 4.0), Digi-Key KiCad Library (github.com/Digi-Key/digikey-kicad-library, CC-BY-SA 4.0 with an exception for designs).
- **Part symbols & footprints** for database parts: the **JLCEDA/EasyEDA official library** — https://easyeda.com · https://lceda.cn. Its terms require this source to be declared; parts are used here only to design boards to be made with these parts.
- **three.js** (MIT) for the 3D previews; the CSG algorithm in `js/enclosure.js` follows csg.js by Evan Wallace (MIT).
- Web search results come from DuckDuckGo (or Brave Search with your own key).
