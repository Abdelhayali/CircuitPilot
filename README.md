# CircuitPilot

CircuitPilot is an AI-assisted schematic and PCB editor. Describe a circuit in plain language or design it by hand, choose real components, check the schematic, lay out and route the board, and export files for fabrication. The same project can include a fitted 3D-printable enclosure and a product datasheet.

## Quick features

| Tool | What you can do |
| --- | --- |
| AI Copilot | Use **Agent** to edit, **Ask** to review, or **Plan** to draft a design before applying it. Connect a cloud provider, a local model, or an external AI client through MCP. |
| Schematic editor | Organize multi-sheet schematics, wire named nets, run electrical rule checks (ERC), and cross-probe parts and nets on the PCB. |
| Parts and footprints | Search JLCPCB/LCSC, EasyEDA, KiCad-format libraries, and My Library. Preview symbols and footprints or create your own. |
| PCB layout | Use two-sided Quick place, rule-driven autorouting, manual tracks and vias, copper pours, and design rule checks (DRC). Choose a 1-, 2-, or 4-layer rule profile. |
| 3D and manufacturing | Preview the board, design and check enclosures, and export Gerber/drill files, BOM and pick-and-place data, CNC toolpaths, and product documentation. |
| Projects and interchange | Save portable project files, import EasyEDA or KiCad projects, and export schematic and PCB files for EasyEDA. |

## Get started

### Online

Open **[pcbgo.site](https://pcbgo.site)**, then choose **Connect AI** to use a supported provider or the shared AI where available. You can also use the editors manually. The website stores projects and My Library in the current browser by default. Use **Export → CircuitPilot project file** to save a portable copy.

To use a managed local model from the website, open the current CircuitPilot Windows app on the **same PC**, keep it running, and open **Connect AI → Local AI** on pcbgo.site. Allow local network access if your browser asks.

### Windows app

1. Download **[CircuitPilot-Windows.zip](https://github.com/Abdelhayali/CircuitPilot/releases/latest/download/CircuitPilot-Windows.zip)** and extract the whole archive.
2. Run **CircuitPilot.exe** on 64-bit Windows 10 or 11. The package includes the app, Node.js for MCP, and a llama.cpp runtime.
3. Choose **Connect AI** for a cloud provider or **Local AI** for a GGUF model. To work from another AI app, use **Settings → Codex → Connect to Codex** or **Settings → Claude Desktop → Connect**, then restart that client.

Projects and model downloads are stored under `%LOCALAPPDATA%\CircuitPilot`. See the [latest Windows release notes](https://github.com/Abdelhayali/CircuitPilot/releases/latest) for updates.

### Run from source

Install Python 3. Clone the repository, or use **Code → Download ZIP** on GitHub and extract it. The core editor runs without a build step or package installation.

```sh
git clone https://github.com/Abdelhayali/CircuitPilot.git
cd CircuitPilot
python server.py 5173
```

Use `python3` if that is your system’s Python command. Open [localhost:5173](http://localhost:5173) and stop the server with **Ctrl+C**. Node.js is needed for MCP when running from source. See the [local setup and automation guide](docs/USER_GUIDE.md#local-setup-and-automation) for configuration and REST examples.

## Your first board

1. Create a project and open **Schematic**. Place parts yourself or ask **Agent** to create a circuit with your supply voltage, connectors, and board dimensions.
2. Review component values, pinouts, and connections. Run **ERC**.
3. Open **PCB**, set the outline, then use **Auto-place → Quick place** and **Route**. Use **Update from schematic** when adding or removing parts from a board you’ve already routed.
4. Inspect unrouted nets, connector access, and both layers. Run **DRC** against your fabrication rules before exporting Gerbers and drill files.

New PCBs use the **EasyEDA Pro** preset with **0.1524 mm** copper clearance and **0.254 mm** routing width. Each PCB has its own rules, so choose a suitable preset or edit its limits in **Rules**.

## See it in action

[![CircuitPilot schematic editor showing an ESP32-C3 design](docs/media/schematic.png)](docs/media/schematic.png)

- [Prompt to routed PCB and enclosure](docs/media/demo-esp32-board.mp4)
- [Wearable sensor board, enclosure, and product datasheet](docs/media/demo-esp32-imu-ecg.mp4)
- [PCB editor and 3D board preview](docs/media/pcb-3d.png)

## Documentation and support

| Resource | What it covers |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | AI setup, parts, editing, manufacturing, file formats, project storage, and automation |
| [Illustrated tutorial (PDF)](docs/CircuitPilot-Tutorial.pdf) | Screenshot walkthroughs of the editors and common workflows |
| [CNC milling guide](docs/CNC_MILLING.md) | Single-sided design rules, isolation routing, preview, and G-code |
| [Local model training notes](finetune/README.md) | CircuitPilot-4B training, evaluation, export, and the Colab notebook |
| [PCB Bench](bench/README.md) · [Leaderboard](bench/results/LEADERBOARD.md) | Model evaluation on design and repair tasks |
| [Technical paper](docs/paper/CircuitPilot-Paper-v2.pdf) · [Citation](CITATION.cff) | Architecture, routing, CNC milling, and research citation |
| [GitHub Issues](https://github.com/Abdelhayali/CircuitPilot/issues) | Bug reports and feature requests |

## License

CircuitPilot is source-available under the [PolyForm Strict License 1.0.0](LICENSE). See the license for permitted uses and restrictions. For commercial licensing, contact [Abdelhay Ali](mailto:abdelhay@eng.aun.edu.eg). Copyright © 2026 Abdelhay Ali.

## Data sources & licenses

Third-party components and data retain their own terms. See [NOTICE](NOTICE), [three.js](js/vendor/three-LICENSE.txt), and [Manifold](js/vendor/manifold-LICENSE.txt).

- **Component data** comes from JLCPCB/LCSC and the JLCEDA/EasyEDA official library. Community entries are identified in the parts browser. [EasyEDA](https://easyeda.com) · [JLCEDA](https://lceda.cn)
- **KiCad-format libraries** include KiCad and DigiKey data under CC BY-SA 4.0 with a design exception, and SparkFun data under CC BY 4.0. [KiCad library terms](https://www.kicad.org/libraries/license/) · [DigiKey library terms](https://github.com/Digi-Key/digikey-kicad-library#license) · [SparkFun library terms](https://github.com/sparkfun/SparkFun-KiCad-Libraries#license)
- **Offline catalogue snapshots** are sourced from CDFER’s JLCPCB parts database and its upstream tools. [CDFER catalogue](https://github.com/CDFER/jlcpcb-parts-database) · [jlcparts](https://github.com/yaqwsx/jlcparts)
- **Web search** uses DuckDuckGo by default, with an optional Brave Search API key in the local server.
- **CSG fallback** follows Evan Wallace’s MIT-licensed solid geometry implementation. [csg.js](https://github.com/evanw/csg.js)
