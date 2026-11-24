# CircuitPilot-4B — a small model fine-tuned to use CircuitPilot's tools

**Base model:** [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) (Apache-2.0). It has strong tool calling for its
size and runs on a free Colab T4, a laptop GPU or Ollama on any PC.

## How it fits the app
CircuitPilot's AI Copilot normally sends all ~100 tools (~23k tokens). For small models it has a **compact mode**
(`Engine.LITE` in `js/engine.js`): 30 core tools with short descriptions, a short system prompt, and tool results
cut to 3000 characters. It is used automatically for models named `circuitpilot-…`, or always / never with
**Settings → Compact tools for small models**. The fine-tune is trained on exactly that format.

## Files
| File | What it does |
|---|---|
| `make_dataset.mjs` | Makes the training conversations by **running the real CircuitPilot engine**: every tool result in the data is what the app really returns. Covers building circuits (LED, divider, RC, transistor / MOSFET switches, op-amp, button, LDO / I2C sensor / 555 from the real JLCPCB parts database), edits, PCB steps (generate, size, round board, pour, holes, 4-layer, placement), read-only questions, plans, plain answers, recovery from wrong pin names, and the user's own typing (typos). Only clean results are kept (ERC / DRC pass). |
| `train.py` | LoRA (r 32, all linear layers) on the assistant tokens only. Runs on a 16 GB GPU (fp16 on V100, bf16 on Ampere and newer). |
| `eval.mjs` | 31 hand-written tasks that are not in the training data, run through the same agent loop against any OpenAI-compatible server. The model's tool calls run on the real engine, and each task is scored by checking the resulting design. |
| `make_notebook.py` → `CircuitPilot_4B_Colab.ipynb` | Free hosting on Google Colab (Ollama + Cloudflare tunnel); paste the printed URL into CircuitPilot. |

## Re-make it
```bash
node finetune/make_dataset.mjs --n 3000 --workers 24            # needs the CircuitPilot app running (part searches; cached after)
python -m venv --system-site-packages finetune/.venv && finetune/.venv/Scripts/pip install peft trl datasets triton-windows flash-linear-attention
finetune/.venv/Scripts/python finetune/train.py --epochs 1        # CUDA_VISIBLE_DEVICES picks the GPU
node finetune/eval.mjs --base http://localhost:11434/v1 --model circuitpilot-4b --out finetune/out/eval.json
```
When `Engine.LITE` (tool list or prompt) changes, make the dataset again and retrain, so the model sees what the app sends.
