# CircuitPilot user guide

[Back to the README](../README.md) · [Illustrated tutorial (PDF)](CircuitPilot-Tutorial.pdf) · [Latest release notes](https://github.com/Abdelhayali/CircuitPilot/releases/latest)

- [Connect AI](#connect-ai)
- [Schematic and component library](#schematic-and-component-library)
- [PCB placement, routing, and checks](#pcb-placement-routing-and-checks)
- [Draw for AI](#draw-for-ai)
- [Bench tools](#bench-tools)
- [Advanced Route on Windows](#advanced-route-on-windows)
- [3D, fabrication, and documentation](#3d-fabrication-and-documentation)
- [Projects, backups, and file formats](#projects-backups-and-file-formats)
- [Local setup and automation](#local-setup-and-automation)
- [Privacy and data flow](#privacy-and-data-flow)
- [Troubleshooting](#troubleshooting)

## Connect AI

Use the model menu above the chat to switch providers. **Agent** can edit the current design, **Ask** can inspect it, and **Plan** proposes a design you can apply with **Execute plan**. Checkpoints let you restore the design from before an Agent message. The chat includes a context meter, optional conversation compression, and attachment support. Image inspection requires a vision-capable model. File support depends on the app and provider.

| Setup | What to select |
| --- | --- |
| Cloud provider | **Connect AI**, or add Claude credentials or an OpenAI-compatible base URL under **Settings**. The hosted website requires a provider that accepts browser requests. Use the local app for providers such as Ollama Cloud that need the desktop proxy. |
| GGUF model managed by CircuitPilot | In the Windows app, open **Connect AI → Local AI**, download or browse for a model, then choose **Start and connect**. The app can use its bundled llama.cpp or a configured external engine. |
| Managed local model from pcbgo.site | Run the current Windows app on the same computer as the browser and keep it open. Reload pcbgo.site and open **Local AI**. The site reaches the running model through the Windows app. Allow local network access if prompted. |
| Existing model server | In the local app, add an OpenAI-compatible endpoint in **Settings**, for example `http://localhost:8080/v1`. Choose **Fetch models**, save the provider, and select a model. Agent mode requires tool calling. |

For a managed local model, change the **Context** field in **Hardware and llama.cpp settings**, then click **Save settings → Restart model to apply settings**. The chat displays the context reported by the running model when it is available. The general chat context estimate in Settings is useful for unmanaged providers whose context cannot be detected. **Compact tools for small models** uses a shorter tool set and prompt. For a downloadable model tuned for CircuitPilot, see the [CircuitPilot-4B notes and Colab notebook](../finetune/README.md).

In a local server session, **Knowledge** lets you attach a folder of requirements, design notes, and datasheets to a project. The copilot can search and read the folder as it works. See the [example knowledge folder](../examples/knowledge).

## Schematic and component library

- **Library** searches JLCPCB/LCSC, EasyEDA’s official and community libraries, supported KiCad-format libraries, built-in parts, and My Library. Preview the symbol, pinout, and PCB footprint before placing a part. Review community footprints, fallback packages, and generated pin assignments against the datasheet.
- **My Library** stores custom symbols and footprints with editable pins and pads. Use the footprint generators for standard packages or draw a custom footprint. The copilot can create a reusable definition with `create_part`, then place an instance with `add_components` using the returned library key.
- **Parts archives** in Settings downloads offline JLCPCB catalogue snapshots. Some symbols, footprints, and 3D models are fetched on first use. The design file includes its saved part definitions.
- **Schematic sheets** support named nets across pages, drawing frames, power symbols, and cross-probing with the PCB. Use **Organize** to arrange a crowded sheet. Run **ERC** and review warnings, supply pins, and intentional unconnected pins before going to layout.

## PCB placement, routing, and checks

1. **Outline and rules.** Set the board dimensions and shape. On a single-board outline, use Select mode and drag an edge or handle to resize it with a grid-snapped preview. Set rules for each PCB, including copper layers, trace/via dimensions, clearances, pours, and per-net widths. The EasyEDA Pro preset is the default for new boards. JLCPCB, home-etching, and desktop-CNC profiles are also available.
2. **Quick place.** Use **Auto-place → Quick place** for a new layout. It uses both sides, leaves routing channels where space permits, and prefers to leave opposite-side pads clear. It tries tighter layouts before enlarging an undersized board. Lock parts that must stay put. Use **Update from schematic** after edits to an existing layout to preserve usable placement and routing and place new footprints inside the outline where possible.
3. **Inspect and route.** Use **Route** for the current placement. Review incomplete nets and adjust their local placement or use the Track and Via tools for critical connections. The autorouter preserves hand-routed tracks. The Layers panel controls visibility and the active copper side. Click the desired side to select overlapping footprints, or **Alt-click** to pick the other visible side.
4. **Review before export.** Run **DRC**, inspect both sides and connector access, and resolve the remaining routing or design-rule problems. The EasyEDA Pro comparison uses the supported preset limits. If you export to EasyEDA Pro, import the board’s rule file there when it uses a different profile, then run EasyEDA’s DRC. Verify the final fabrication limits with the manufacturer.

The PCB editor also supports copper pours and stitching vias, keep-outs, mounting holes, rotating silkscreen text, net highlighting, panel outlines with break-off tabs, and separate PCB layouts and rules within one project.

Use the **Track** tool for interactive routing. Start from a pad, use right-click or **V** to change layers with a via, and use **Space** to change the routing angle. In Select mode, **R** rotates the selected footprint or silkscreen label. The selected side and the available actions appear in the PCB tool panel.

## Draw for AI

In the **PCB** or **Enclosure** tab, select **Draw for AI**. Draw with the mouse, a pen, or your finger. Use **Circle**, **Arrow**, **Box**, or **Pen**, then click **Attach marks** to add the drawing to your chat. Type what to change and send it in **Agent** mode.

- In **PCB**, circle the part and draw an arrow from it to the destination. For overlapping parts, select the relevant copper side before drawing. You can also mark where a new part should go.
- In **Enclosure**, orient the model until the surface or feature is visible, then circle it. Give the hole size and, for a Custom 3D hole, the cut depth. You can also circle an editable shape and ask to remove it.
- The attachment includes the marked coordinates, part references, and surface details. Text-only models can use it. The drawing itself is a draft until you send an instruction. The normal Agent checkpoint can restore the project if you need to undo the edits.

## Advanced Route on Windows

In the Windows app, click **PCB → Advanced Route** after placing the parts. The progress dialog shows what the router is doing and how many connections it finished. If the bundled engine leaves nets open, CircuitPilot tries its built-in router with the same board rules and keeps the result that closes more connections. Click **Show DRC** in the results dialog to inspect any remaining issues. The router uses your selected via diameter and drill, track widths, copper and hole clearances, and **No via in pad**. With **Neck down when the full width does not fit** enabled, traces may narrow to the selected minimum. Undo restores the previous routing.

The bundled engine handles two-layer boards with 45° tracks. The **Advanced Route** button uses CircuitPilot's built-in router for other layer counts or 90° tracks. To route a coupled differential pair, click **Route pair…**, select two nets with two pads each, and enter the pair spacing and allowed difference in planar trace length. Hand-routed and locked copper is preserved.

## Bench tools

Open **Bench tools** beside the editor tabs.

- **Assembly guide.** Use the current PCB, then export an assembly file to open on your phone at pcbgo.site. Use the 2D map or print the selected side’s alignment sheet in colour at 100%. Check the 10 mm scale line and secure the board inside the printed outline. Start the rear camera and keep all four marks in view. The highlight shows the next footprint and orientation pads. Use **Placed**, **Skip**, and **Back** to navigate. Choose the other side and its printed sheet when flipping the board. Camera frames are processed on the phone.
- **Photo → schematic.** Add clear top and bottom photographs with the same board edge at the top. If needed, align each photo by tapping its four corners. **Analyze with vision** sends the photos to the selected vision model. Review or edit the proposed parts and nets, display suggested copper paths, and mark traces yourself where useful. Confirm connections individually before creating the new project. Unconfirmed nets are kept as review notes. Check component identities, pin assignments, and hidden connections before relying on the schematic.
- **Bring-up.** Open **Edit checklist for new runs**. Add instructions and, for voltage checks, enter the test point, a ground net or reference pin, and the minimum and maximum voltage. Save the checklist, then start a run with the board revision and board ID. Probe locations are highlighted on the PCB side views when a layout is available. Log readings in V or mV. Readings outside the configured range stay outstanding. Repeated readings are kept in the step history. Use **Compare with** to compare the latest results from two runs. Each run keeps the checklist and PCB probe map it started with.
- **Bench voice.** Start listening on a supported browser, or type a question such as “What’s on pin 3 of U5?” **Bench notes** stores expected voltages and simple instructions. With a bring-up run selected, say “next step” to hear the first outstanding check, “mark step complete” for an instruction, or “log 3.28 volts” followed by “confirm reading” to save a measurement. The browser may use a remote speech recognition service for microphone audio.

## 3D, fabrication, and documentation

| Task | Where to start |
| --- | --- |
| Inspect the assembled board | Use the PCB editor’s **3D** view for both sides, edge connections, and component models where available. |
| Inspect the layer stack | In **PCB → 3D**, use **X-ray** to see through the substrate, **Exploded** to separate copper, solder mask, silkscreen and paste, or **Cross-section** to move an X or Y cut through the board. Use **Board layers** to isolate individual layers, including the two inner copper layers on four-layer boards. |
| Design an enclosure | Open **Enclosure** for a board-fitted case with lid, posts, cutouts, and battery space. **Custom 3D** offers templates for wearables, patches, mounts, and other shapes, plus a script editor and manual geometry tools. |
| Check mechanical fit | Use the enclosure’s measurement, section, and fit views. Check wall thickness, clearances, openings, and the selected process before exporting. Exports include STL and OpenSCAD, with STEP or DXF where supported by the export type. |
| Fabricate and assemble | **Export** includes Gerber and drill files, a BOM, JLCPCB BOM and CPL, netlists, PCB drawings, and a complete project pack. The order controls prepare files and open the quote workflow where supported. |
| Mill a board on a desktop CNC | Use the CNC rules preset, inspect the isolation, drill, and cutout paths, and export G-code. [CNC milling guide](CNC_MILLING.md) |
| Produce product documentation | Use **Documentation** to draft and review a datasheet with schematic pages, board views, dimensions, connector pinouts, BOM, and revisions. Export a PDF. |

For mechanical fabrication, the enclosure tools also support sheet-metal plates and electrodes, fabrication checks, and separate printed-part or sheet-part export packs. Firmware pin mapping and project exports help carry the design into handoff and review.

## Projects, backups, and file formats

- **Storage.** The hosted editor uses the current browser by default. The Windows app and local Python server use a local SQLite database. Use **Projects** to open, duplicate, rename, import, or recover designs. The local server keeps project versions.
- **Backups and sync.** **Export → CircuitPilot project file** creates a portable `.circuit.json` with the design and its library definitions. **All projects** exports a collection. The **Folder** menu can keep a project linked to a local file on supported browsers. Optional Google sign-in syncs projects and My Library through your Google Drive app-data folder.
- **EasyEDA.** **Projects → Import** accepts supported EasyEDA Pro `.epro` / `.epro2` projects and EasyEDA Standard PCB JSON. To continue in EasyEDA, export the schematic and PCB bundle. In EasyEDA Pro, open it via **File → Import → EasyEDA (Standard)**. Import CircuitPilot’s exported design rules separately when needed.
- **KiCad.** **Projects → Import** accepts a supported KiCad project archive or a PCB file selected with its schematic sheets. Review the import report and validate layers, footprints, nets, and unsupported items before re-routing or manufacturing.

## Local setup and automation

### Windows and the Python server

The [README](../README.md#get-started) has the three setup paths. The packaged Windows app opens its own editor window. It accepts `--port`, `--server-only`, and `--lan --password YOUR_PASSWORD` when you need access from another device. A managed local model on pcbgo.site connects to the Windows app on its default port.

For a local source session, run `python server.py 5173` and open [localhost:5173](http://localhost:5173). The source server can also serve other devices on your local network. Use `--password` or `--password-file` when sharing access. The Windows `start.bat` launcher expects an `access-password.txt` file. Keep project databases, model files, and credentials out of the repository.

For an owner-operated remote session with Cloudflare Tunnel, start CircuitPilot with a password before pointing the tunnel at the local server. A tunnel exposes the editor and its local services to anyone who has access, including the project files and configured AI tools.

To build the Windows package from source, install PyInstaller and Pillow, then run `python desktop/build_windows.py` on Windows. The resulting ZIP is written to `dist/CircuitPilot-Windows.zip`.

### Codex, Claude, and other MCP clients

- **Codex.** In the Windows app, choose **Settings → Codex → Connect to Codex**. Restart Codex and open a new chat.
- **Claude Desktop.** Choose **Settings → Claude Desktop → Connect**. Quit Claude Desktop completely and reopen it. From a source checkout with Node.js installed, you can use `node mcp/install-claude-desktop.mjs`.
- **Claude Code.** Open the repository in Claude Code with the local server running, then approve the server configured in [`.mcp.json`](../.mcp.json).
- **Other MCP clients.** Run `node mcp/circuitpilot-mcp.mjs` from a source checkout. Use `CP_URL` for a different local server URL and `CP_PASSWORD` if the local server requires it.

The MCP tools share CircuitPilot’s design engine. Start with `start_here` and select the intended project before editing. Long operations may return a job ID. Use `job_status` to retrieve the result. See the [MCP server](../mcp/circuitpilot-mcp.mjs) for tool definitions.

### REST, project files, and development

```sh
node mcp/circuitpilot-mcp.mjs --http 5174
```

The REST server listens on loopback by default. Retrieve **`GET /tools`** for the tool list, **`GET /openapi.json`** for the schema, and use **`POST /tools/<name>`** with JSON for a call. For authenticated setups, supply the configured API password as a bearer token. If you specify the project in a call, use its ID or exact name.

| Path | Purpose |
| --- | --- |
| [`js/engine.js`](../js/engine.js) | Tool schemas and actions shared by the chat and automation clients |
| [`js/model.js`](../js/model.js) · [`js/pcb.js`](../js/pcb.js) | Design state, schematic connectivity, placement, routing, and DRC |
| [`server.py`](../server.py) · [`store.py`](../store.py) | Local server and SQLite project storage |
| [`desktop/build_windows.py`](../desktop/build_windows.py) | Builds the Windows app and ZIP package |
| [Relay notes](../relay/README.md) | Hosted parts, web-search, and shared services |
| [PCB Bench](../bench/README.md) · [Leaderboard](../bench/results/LEADERBOARD.md) | Design and repair evaluation, run configuration, and results |

## Privacy and data flow

- **AI requests.** Chat content and tool context are sent to the model you choose. User-supplied provider keys are kept in the browser or browser session according to its settings. The local app can proxy requests from that browser to the selected provider. The hosted managed Local AI route sends inference requests to the Windows app on your PC.
- **Optional network features.** Part lookup, web search, model downloads, cloud sync, and fabrication quotes contact their respective services when used. Turn off web access in Settings if you want the copilot to work from the project and its supplied references.
- **Account features.** Save to GitHub uses the account and repository you choose. The shared AI uses GitHub sign-in and a relay that tracks usage limits. Google Drive sync uses the project data stored by CircuitPilot in the signed-in account. See the [hosted relay notes](../relay/README.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| pcbgo.site sees the local app but chat fails | Update the Windows app, keep it open on the same computer, then reload pcbgo.site. Open **Local AI**, verify the model is ready, and allow local network access if asked. |
| The local context meter shows the previous size | Save the context under **Local AI → Hardware and llama.cpp settings** and use **Restart model to apply settings**. Check the reported size after the model is ready. |
| A net is still unrouted | Inspect its pads and track clearances, adjust parts or use hand routing, then run DRC again. |
| A part search has no result | Check My Library and the catalogue archives, then review supported public libraries or create a part from verified pins and pads. |

For a reproducible issue, include the app version, platform, steps, and the error message. [GitHub Issues](https://github.com/Abdelhayali/CircuitPilot/issues)
