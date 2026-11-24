"""Writes finetune/CircuitPilot_4B_Colab.ipynb (run free on Google Colab and connect CircuitPilot to it).

    python finetune/make_notebook.py --repo <hf-user>/circuitpilot-4b-GGUF
"""
import argparse, json, os

ap = argparse.ArgumentParser()
ap.add_argument('--repo', default='YOUR_HF_USER/circuitpilot-4b-GGUF')
ap.add_argument('--quant', default='Q4_K_M')
a = ap.parse_args()

md = lambda s: {'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n').splitlines(True)}
code = lambda s: {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n').splitlines(True)}

cells = [
    md(f"""
# CircuitPilot 4B — free AI copilot on Google Colab

This runs **CircuitPilot-4B** (Qwen3.5-4B fine-tuned to use CircuitPilot's design tools) on Colab's free GPU and gives
you a web address to paste into CircuitPilot.

1. **Runtime → Change runtime type → T4 GPU** (free), then **Runtime → Run all**.
2. Copy the `https://….trycloudflare.com/v1` address printed by the last cell.
3. In CircuitPilot: **🔑 Connect AI → Use your own API** — Base URL = that address, API key = `ollama` (any text),
   model = `circuitpilot-4b`. CircuitPilot switches to its compact tool set for this model by itself.

Keep this tab open while you use it (free Colab sessions end after a few idle hours; just run it again).
Model: [{a.repo}](https://huggingface.co/{a.repo}) · base model Qwen3.5-4B (Apache-2.0).
"""),
    code("""
# 1. Ollama (serves the model with an OpenAI-compatible API)
!curl -fsSL https://ollama.com/install.sh | sh > /dev/null
!nvidia-smi --query-gpu=name,memory.total --format=csv
"""),
    code("""
# 2. start Ollama in the background; CircuitPilot on pcbgo.site calls it straight from your browser, so allow any origin
import subprocess, os, time
env = dict(os.environ, OLLAMA_HOST='0.0.0.0:11434', OLLAMA_ORIGINS='*', OLLAMA_CONTEXT_LENGTH='16384', OLLAMA_KEEP_ALIVE='24h', OLLAMA_FLASH_ATTENTION='1')
ollama = subprocess.Popen(['ollama', 'serve'], env=env, stdout=open('ollama.log', 'w'), stderr=subprocess.STDOUT)
time.sleep(5); print(open('ollama.log').read()[-500:])
"""),
    code(f"""
# 3. the fine-tuned model from Hugging Face (about 2.7 GB), with Qwen3.5's own prompt format and tool-call parser
open('Modelfile', 'w').write('''FROM hf.co/{a.repo}:{a.quant}
RENDERER qwen3.5
PARSER qwen3.5
PARAMETER temperature 0.3
PARAMETER num_ctx 16384
''')
!ollama create circuitpilot-4b -f Modelfile
!ollama list
"""),
    code("""
# 4. quick test: one tool call, as CircuitPilot would send it
import json, urllib.request
req = {'model': 'circuitpilot-4b', 'messages': [{'role': 'user', 'content': 'change R1 to 470'}],
       'tools': [{'type': 'function', 'function': {'name': 'update_component', 'description': 'Change a component', 'parameters': {'type': 'object', 'required': ['ref'], 'properties': {'ref': {'type': 'string'}, 'value': {'type': 'string'}}}}}]}
r = urllib.request.urlopen(urllib.request.Request('http://localhost:11434/v1/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json'}))
print(json.loads(r.read())['choices'][0]['message'].get('tool_calls'))
"""),
    code("""
# 5. a public HTTPS address for CircuitPilot (Cloudflare quick tunnel, no account needed)
!wget -q -O cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared
import re
tun = subprocess.Popen(['./cloudflared', 'tunnel', '--url', 'http://localhost:11434', '--no-autoupdate'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for line in tun.stdout:
    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)
    if m:
        print('\\n' + '=' * 70 + '\\nCircuitPilot → 🔑 Connect AI → Use your own API\\n  Base URL: ' + m.group(0) + '/v1\\n  API key:  ollama\\n  Model:    circuitpilot-4b\\n' + '=' * 70)
        break
"""),
    md("""
**Keep this tab open.** The address changes each time you run cell 5.
Prefer your own PC? Install [Ollama](https://ollama.com), save the Modelfile from cell 3, run
`ollama create circuitpilot-4b -f Modelfile`, and use base URL `http://localhost:11434/v1` in CircuitPilot.
"""),
]
nb = {'cells': cells, 'metadata': {'accelerator': 'GPU', 'colab': {'gpuType': 'T4', 'provenance': []}, 'kernelspec': {'display_name': 'Python 3', 'name': 'python3'}, 'language_info': {'name': 'python'}}, 'nbformat': 4, 'nbformat_minor': 0}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'CircuitPilot_4B_Colab.ipynb')
json.dump(nb, open(out, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('wrote', out)
