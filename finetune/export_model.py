"""Merge the trained LoRA into Qwen3.5-4B, convert to GGUF and register it in Ollama as circuitpilot-4b.

    python finetune/export_model.py --lora finetune/out/cp4b/lora --out finetune/out/export [--name circuitpilot-4b] [--quant q4_K_M]

Steps (each skipped when its output exists):
  1. merge   base (fp16) + LoRA            -> out/merged/          (Hugging Face safetensors, the model's own chat template)
  2. gguf    llama.cpp convert_hf_to_gguf  -> out/<name>-f16.gguf
  3. quant   llama-quantize (llama.cpp)     -> out/<name>-<QUANT>.gguf (for Ollama, Hugging Face, Colab)
  4. ollama  ollama create                -> Ollama model <name>   (Qwen3.5 renderer + tool-call parser, as the base model)
"""
import argparse, json, os, shutil, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='finetune/models/Qwen3.5-4B')
ap.add_argument('--lora', default='finetune/out/cp4b/lora')
ap.add_argument('--out', default='finetune/out/export')
ap.add_argument('--name', default='circuitpilot-4b')
ap.add_argument('--quant', default='q4_K_M')
ap.add_argument('--llama_cpp', default='finetune/tools-llama.cpp-ollama', help='llama.cpp checkout at 1a0b56ce (the GGUF layout Ollama loads)')
ap.add_argument('--ollama', default=os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'Ollama', 'ollama.exe'))
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
merged = os.path.join(a.out, 'merged'); f16 = os.path.join(a.out, f'{a.name}-f16.gguf')
ollama = a.ollama if os.path.exists(a.ollama) else 'ollama'

# 1. merge (on the CPU: needs ~10 GB RAM, leaves the GPU free)
if not os.path.exists(os.path.join(merged, 'config.json')):
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel
    print('merging', a.lora, 'into', a.base, flush=True)
    m = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float16, device_map={'': 'cpu'})
    m = PeftModel.from_pretrained(m, a.lora).merge_and_unload()
    m.save_pretrained(merged, safe_serialization=True, max_shard_size='5GB')
    AutoTokenizer.from_pretrained(a.base).save_pretrained(merged)
    for f in ('chat_template.jinja', 'generation_config.json', 'LICENSE'):     # the model's own prompt format
        if os.path.exists(os.path.join(a.base, f)): shutil.copy(os.path.join(a.base, f), merged)
    del m
# the multi-token-prediction layer (mtp.*): the text model drops it on load, the LoRA never touches it, and llama.cpp /
# Ollama expect it (an extra block) -> copy it unchanged from the base model
ix_path = os.path.join(merged, 'model.safetensors.index.json')
if os.path.exists(ix_path):
    ix = json.load(open(ix_path))
    if not any(k.startswith('mtp.') for k in ix['weight_map']):
        from safetensors import safe_open
        from safetensors.torch import save_file
        bix = json.load(open(os.path.join(a.base, 'model.safetensors.index.json')))['weight_map']
        mtp = {}
        for k, f in bix.items():
            if k.startswith('mtp.'):
                with safe_open(os.path.join(a.base, f), framework='pt') as t: mtp[k] = t.get_tensor(k).contiguous()
        if mtp:
            save_file(mtp, os.path.join(merged, 'model-mtp.safetensors'), metadata={'format': 'pt'})
            for k in mtp: ix['weight_map'][k] = 'model-mtp.safetensors'
            json.dump(ix, open(ix_path, 'w'), indent=2); print('added', len(mtp), 'mtp tensors from the base model', flush=True)
print('merged model:', merged, flush=True)

# 2. GGUF (f16)
if not os.path.exists(f16):
    conv = os.path.join(a.llama_cpp, 'convert_hf_to_gguf.py')
    if not os.path.exists(conv): sys.exit('llama.cpp converter missing: git clone https://github.com/ggml-org/llama.cpp ' + a.llama_cpp + ' && git -C ' + a.llama_cpp + ' checkout 1a0b56ce')
    env = dict(os.environ, PYTHONPATH=os.path.join(a.llama_cpp, 'gguf-py'))   # that version's own gguf library
    subprocess.run([sys.executable, conv, merged, '--outtype', 'f16', '--outfile', f16], check=True, env=env)
print('gguf:', f16, flush=True)

# 3. quantize with llama.cpp's llama-quantize (official ggml-org Windows CPU build, fetched once)
q = os.path.join(a.out, f'{a.name}-{a.quant.upper()}.gguf')
def llama_quantize():
    import glob, urllib.request, zipfile, io
    for c in glob.glob(os.path.join(a.llama_cpp + '-bin', '**', 'llama-quantize*'), recursive=True):
        if c.lower().endswith(('.exe', 'llama-quantize')): return c
    # the newest build release (tags bNNNNN) that has the prebuilt tools for this system
    rels = json.load(urllib.request.urlopen(urllib.request.Request('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20', headers={'User-Agent': 'circuitpilot-finetune'})))
    want = 'bin-win-cpu-x64.zip' if os.name == 'nt' else 'bin-ubuntu-x64.zip'
    rel, asset = next((r, x) for r in rels for x in r['assets'] if x['name'].endswith(want))
    print('llama.cpp', rel['tag_name'], asset['name'], flush=True)
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(asset['browser_download_url']).read())).extractall(a.llama_cpp + '-bin')
    return llama_quantize()
if not os.path.exists(q):
    subprocess.run([llama_quantize(), f16, q, a.quant.upper()], check=True)
print('quantized:', q, flush=True)

# 4. Ollama model from that file, with the Qwen3.5 renderer / tool-call parser (same format as qwen3.5:4b)
for mf, src in ((os.path.join(a.out, 'Modelfile'), os.path.abspath(q)), (os.path.join(a.out, 'Modelfile.publish'), './' + os.path.basename(q))):
    open(mf, 'w', encoding='utf-8').write(f'FROM {src}\nRENDERER qwen3.5\nPARSER qwen3.5\nPARAMETER temperature 0.3\nPARAMETER num_ctx 16384\n')
subprocess.run([ollama, 'create', a.name, '-f', os.path.join(a.out, 'Modelfile')], check=True)
print(f'ollama model: {a.name}\nquantized gguf: {q} ({os.path.getsize(q) / 1e9:.2f} GB)', flush=True)
