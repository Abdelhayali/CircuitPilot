# CircuitPilot PCB Bench — leaderboard

Each model designs and repairs boards with CircuitPilot's tools; the design it leaves behind is scored 0–100 per task (schematic 35, placement 15, routing 25, DRC 15, behaviour 10) and averaged. "Design" = the 8 tasks from an empty project, "Repair" = the 6 broken boards; DRC clean / fully routed count the PCB tasks. How to run: [bench/README.md](../README.md).

| Model | Tools | Runs | Score | Design | Repair | Schematic % | Placement % | Routing % | DRC clean | Fully routed | Tool errors | Date |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3.5-4B (base) | compact | 3 × 14 | **60.3** | 30.4 | 100 | 65.7 | 52.7 | 45.6 | 15/33 | 19/33 | 6/520 | 2026-11-24 |
