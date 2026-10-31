# CircuitPilot paper

IEEE double-column manuscript about CircuitPilot (`main.tex`, references in `refs.bib`, built PDF `CircuitPilot-Paper.pdf`).

Every number in the paper comes from the scripts in `bench/`, which run the same engine as the app (`mcp/engine-vm.mjs`):

| Script | Output | Measures |
|---|---|---|
| `bench/run-bench.mjs [seconds]` | `bench/results.json` | routing with and without the rip-up loop, DRC |
| `bench/run-cnc.mjs` | `bench/cnc.json` | isolation-milling jobs, toolpath check |
| `bench/run-tokens.mjs` | `bench/tokens.json` | size of tool answers against the raw project |
| `bench/make-figs.py` | `tables/*.tex`, `figs/routing.pdf`, `figs/tokens.pdf` | tables, charts and the headline numbers (`tables/stats.tex`) |

`bench/designs.json` holds the 15 benchmark designs.

Build (any TeX distribution with IEEEtran, or [Tectonic](https://tectonic-typesetting.github.io)):

```
node bench/run-bench.mjs 60 > bench/results.json
node bench/run-cnc.mjs > bench/cnc.json
node bench/run-tokens.mjs > bench/tokens.json
python bench/make-figs.py
tectonic main.tex
```
