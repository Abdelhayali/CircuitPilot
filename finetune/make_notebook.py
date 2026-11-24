"""Writes finetune/CircuitPilot_4B_Colab.ipynb (run free on Google Colab and connect CircuitPilot to it).

    python finetune/make_notebook.py --repo <hf-user>/pcbgo-v1-GGUF
"""
import argparse, json, os

ap = argparse.ArgumentParser()
ap.add_argument('--repo', default='abdelhayali91/pcbgo-v1')
ap.add_argument('--quant', default='Q4_K_M')
a = ap.parse_args()

md = lambda s: {'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n').splitlines(True)}
code = lambda s: {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n').splitlines(True)}

cells = [
    md(f"""
# pcbgo v1 — free AI copilot on Google Colab

This runs **pcbgo v1** (Qwen3.5-4B fine-tuned to use CircuitPilot's design tools) on Colab's free GPU and connects
[pcbgo.site](https://pcbgo.site) to it.

1. **Runtime → Change runtime type → T4 GPU** (free), then **Runtime → Run all** (3–5 minutes).
2. Click **Open pcbgo.site connected to this model** at the end — pcbgo.site opens with the AI set up.
   (Or paste the printed address in pcbgo.site → 🔑 Connect AI → *Run pcbgo-v1 free on Google Colab*.)

Keep this tab open while you use it (free Colab sessions end after a few idle hours; just run it again).
Model: [{a.repo}](https://huggingface.co/{a.repo}) · base model Qwen3.5-4B (Apache-2.0).
"""),
    code("""
# 1. Ollama (serves the model with an OpenAI-compatible API)
# (the installer needs zstd to unpack, which Colab does not have)
!apt-get -qq update > /dev/null && apt-get -qq install -y zstd pciutils lshw > /dev/null
!curl -fsSL https://ollama.com/install.sh | sh 2>&1 | tail -3
import shutil
assert shutil.which('ollama'), 'Ollama did not install - see the messages above, then run this cell again'
!ollama --version
!nvidia-smi --query-gpu=name,memory.total --format=csv
"""),
    code("""
# 2. start Ollama in the background; CircuitPilot on pcbgo.site calls it straight from your browser, so allow any origin
import subprocess, os, time
env = dict(os.environ, OLLAMA_HOST='0.0.0.0:11434', OLLAMA_ORIGINS='*', OLLAMA_CONTEXT_LENGTH='16384', OLLAMA_KEEP_ALIVE='24h', OLLAMA_FLASH_ATTENTION='1')
import shutil
ollama = subprocess.Popen([shutil.which('ollama') or '/usr/local/bin/ollama', 'serve'], env=env, stdout=open('ollama.log', 'w'), stderr=subprocess.STDOUT)
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
!ollama create pcbgo-v1 -f Modelfile
!ollama list
"""),
    code("""
# 4. quick test: one tool call, as CircuitPilot would send it
import json, urllib.request
req = {'model': 'pcbgo-v1', 'reasoning_effort': 'none', 'messages': [{'role': 'user', 'content': 'change R1 to 470'}],
       'tools': [{'type': 'function', 'function': {'name': 'update_component', 'description': 'Change a component', 'parameters': {'type': 'object', 'required': ['ref'], 'properties': {'ref': {'type': 'string'}, 'value': {'type': 'string'}}}}}]}
r = urllib.request.urlopen(urllib.request.Request('http://localhost:11434/v1/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json'}))
print(json.loads(r.read())['choices'][0]['message'].get('tool_calls'))
"""),
    code("""
# 5. a public HTTPS address for CircuitPilot (Cloudflare quick tunnel, no account needed)
!wget -q -O cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared
import re
tun = subprocess.Popen(['./cloudflared', 'tunnel', '--url', 'http://localhost:11434', '--http-host-header', 'localhost:11434', '--no-autoupdate'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for line in tun.stdout:
    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)
    if m:
        url = m.group(0)
        break
# keep reading the tunnel's log in the background (a full pipe would stop the tunnel)
import threading
threading.Thread(target=lambda: [None for _ in tun.stdout], daemon=True).start()
from IPython.display import HTML, display
link = 'https://pcbgo.site/#colab=' + url
display(HTML(f'<div style="font:16px sans-serif;margin:12px 0"><a href="{link}" target="_blank" style="background:#2563eb;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open pcbgo.site connected to this model ↗</a>'
             f'<p style="margin-top:14px">Or in pcbgo.site → 🔑 Connect AI → <b>Run pcbgo-v1 free on Google Colab</b> and paste: <code>{url}</code></p>'
             f'<p>Desktop app / other tools: Base URL <code>{url}/v1</code>, API key <code>ollama</code>, model <code>pcbgo-v1</code>.<br>Keep this tab open while you design.</p></div>'))
"""),
    md("""
**Keep this tab open.** The address changes each time you run cell 5.
Prefer your own PC? Install [Ollama](https://ollama.com), save the Modelfile from cell 3, run
`ollama create pcbgo-v1 -f Modelfile`, and use base URL `http://localhost:11434/v1` in CircuitPilot.
"""),
]
nb = {'cells': cells, 'metadata': {'accelerator': 'GPU', 'colab': {'gpuType': 'T4', 'provenance': []}, 'kernelspec': {'display_name': 'Python 3', 'name': 'python3'}, 'language_info': {'name': 'python'}}, 'nbformat': 4, 'nbformat_minor': 0}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'CircuitPilot_4B_Colab.ipynb')
json.dump(nb, open(out, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('wrote', out)
