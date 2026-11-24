"""PCB Bench chart: one panel per measure, one bar per model (bench/results -> docs/media/pcb-bench-chart.png).

    python bench/chart.py
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "bench", "results")
OUT = os.path.join(ROOT, "docs", "media", "pcb-bench-chart.png")
# models shown (result file → label); colours are the validated categorical slots, in fixed order
MODELS = [
    ("CircuitPilot-4B_v2_llama.cpp___compact_nothink.json", "pcbgo v1 (4B, fine-tuned)", "#2a78d6"),
    ("Qwen3.8-27B_llama.cpp___compact_nothink.json", "Qwen3.8-27B", "#eb6834"),
    ("Qwen3.6-27B_llama.cpp___compact_nothink.json", "Qwen3.6-27B", "#1baf7a"),
    ("Qwen3.5-4B_base_llama.cpp___compact_nothink.json", "Qwen3.5-4B (base)", "#eda100"),
]
frac = lambda s: 100 * int(s.split("/")[0]) / int(s.split("/")[1])
PANELS = [   # (title, subtitle, value from the summary, higher is better)
    ("Overall score", "all 14 tasks, 0–100", lambda s: s["score"], True),
    ("Design", "8 boards from a text prompt", lambda s: s["design"], True),
    ("Repair", "6 broken boards to fix", lambda s: s["repair"], True),
    ("Schematic", "parts, connections, values, ERC (%)", lambda s: s["schematic_pct"], True),
    ("PCB placement", "placed, no overlaps, board constraints (%)", lambda s: s["placement_pct"], True),
    ("Routing", "routed nets (%)", lambda s: s["routing_pct"], True),
    ("DRC clean", "PCB tasks with no DRC error (%)", lambda s: frac(s["drc_clean"]), True),
    ("Fully routed", "PCB tasks with no missing connection (%)", lambda s: frac(s["fully_routed"]), True),
    ("Tokens per task", "thousands sent to the model — lower is better", lambda s: s["tokens_in_task"] / 1000, False),
]

INK, MUTED, GRID = "#1f1f1e", "#6b6a64", "#e6e5e0"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
summ = [json.load(open(os.path.join(RES, f), encoding="utf-8"))["summary"] for f, _, _ in MODELS]
fig, axes = plt.subplots(3, 3, figsize=(15, 11.5), facecolor="#fcfcfb")
for ax, (title, sub, get, up) in zip(axes.flat, PANELS):
    vals = [get(s) for s in summ]
    ax.set_facecolor("#fcfcfb")
    bars = ax.bar(range(len(vals)), vals, width=0.78, color=[c for _, _, c in MODELS], edgecolor="#fcfcfb", linewidth=2, zorder=3)
    top = max(vals) * 1.18 if not up else 100 * 1.12
    ax.set_ylim(0, top)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + top * 0.015, f"{v:.0f}k" if not up else f"{v:.1f}", ha="center", va="bottom", fontsize=12, color=INK)
    ax.set_xticks([])
    ax.tick_params(axis="y", colors=MUTED, length=0, labelsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8, zorder=0)
    for sp in ax.spines.values():
        sp.set_visible(False)
    ax.set_title(f"{title}\n", loc="left", fontsize=14, fontweight="bold", color=INK, pad=2)
    ax.text(0, 1.035, sub, transform=ax.transAxes, fontsize=10.5, color=MUTED, va="bottom")
handles = [plt.Rectangle((0, 0), 1, 1, color=c) for _, _, c in MODELS]
fig.legend(handles, [l for _, l, _ in MODELS], loc="lower center", ncol=4, frameon=False, fontsize=12.5, handlelength=2.2, columnspacing=2.5)
fig.suptitle("CircuitPilot PCB Bench — AI models designing and repairing circuit boards with CircuitPilot's tools", x=0.012, ha="left", fontsize=16, fontweight="bold", color=INK)
fig.text(0.012, 0.945, "llama.cpp, Q4_K_M, thinking off, the same compact tool set · pcbgo v1 and base: 3 × 14 tasks, 27B models: 1 × 14 · github.com/Abdelhayali/CircuitPilot/tree/main/bench",
         fontsize=10.5, color=MUTED)
fig.tight_layout(rect=(0, 0.05, 1, 0.93), h_pad=3.2, w_pad=2.5)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
fig.savefig(OUT, dpi=110, facecolor=fig.get_facecolor())
print("wrote", OUT)
