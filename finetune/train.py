"""LoRA fine-tune of Qwen3.5-4B on the CircuitPilot tool-use conversations (finetune/data/*.jsonl).

    python finetune/train.py --model finetune/models/Qwen3.5-4B --data finetune/data --out finetune/out/cp4b

Works on a 16 GB GPU without bf16 (V100: fp16 base, fp32 LoRA weights, loss scaling) and on Ampere+ (bf16).
Only the assistant's own tokens are trained (its text and tool calls); the system prompt, tools, user turns and tool
results are context. The loss is computed only at those positions, so the 248k-word vocabulary never has to be
materialised for the whole sequence (that alone is 4 GB at 4k tokens).
"""
import argparse, json, math, os, random, re, time
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model

ap = argparse.ArgumentParser()
ap.add_argument('--model', default='finetune/models/Qwen3.5-4B')
ap.add_argument('--data', default='finetune/data')
ap.add_argument('--out', default='finetune/out/cp4b')
ap.add_argument('--epochs', type=float, default=2)
ap.add_argument('--lr', type=float, default=1e-4)
ap.add_argument('--rank', type=int, default=32)
ap.add_argument('--accum', type=int, default=16)
ap.add_argument('--max_len', type=int, default=12288)
ap.add_argument('--limit', type=int, default=0, help='use only this many training examples (smoke test)')
ap.add_argument('--eval_every', type=int, default=40)
ap.add_argument('--bucket', type=int, default=512, help='pad lengths to a multiple of this (fewer kernel shapes to compile)')
ap.add_argument('--verbose', action='store_true')
ap.add_argument('--val_limit', type=int, default=40, help='validation examples used for the loss checks')
ap.add_argument('--qlora', action='store_true', help='base model in 4-bit (NF4): ~3 GB instead of 8.4 GB, for 16 GB GPUs')
ap.add_argument('--mem_fraction', type=float, default=0, help='cap this process at this share of the GPU (shared GPUs)')
args = ap.parse_args()

torch.manual_seed(0); random.seed(0)
dev = torch.device('cuda:0')
if args.mem_fraction: torch.cuda.set_per_process_memory_fraction(args.mem_fraction, 0)
bf16 = torch.cuda.get_device_capability(0)[0] >= 8
dtype = torch.bfloat16 if bf16 else torch.float16
print('GPU', torch.cuda.get_device_name(0), '| dtype', dtype, flush=True)

tok = AutoTokenizer.from_pretrained(args.model)
IM_END = tok.convert_tokens_to_ids('<|im_end|>')

# ---------- data: render with the model's own chat template, label the assistant spans ----------
# trained span: after "<|im_start|>assistant\n<think>\n" (so the model also learns to close an empty think block
# at once when the server leaves thinking on) or after "<|im_start|>assistant\n" for older turns, up to <|im_end|>
ASSIST = re.compile(r'<\|im_start\|>assistant\n(?:<think>\n)?', re.S)
def encode(ex):
    text = tok.apply_chat_template(ex['messages'], tools=ex['tools'], tokenize=False, enable_thinking=False)
    enc = tok(text, return_offsets_mapping=True, add_special_tokens=False)
    ids, offs = enc['input_ids'], enc['offset_mapping']
    spans = []
    for m in ASSIST.finditer(text):
        end = text.find('<|im_end|>', m.end())
        if end < 0: continue
        spans.append((m.end(), end + len('<|im_end|>')))
    labels = [-100] * len(ids)
    si = 0
    for i, (a, b) in enumerate(offs):
        while si < len(spans) and spans[si][1] <= a: si += 1
        if si < len(spans) and a >= spans[si][0] and b <= spans[si][1] and b > a: labels[i] = ids[i]
    return ids, labels

def load(name):
    out, skipped = [], 0
    with open(os.path.join(args.data, name), encoding='utf-8') as f:
        for line in f:
            ex = json.loads(line); ids, labels = encode(ex)
            if len(ids) > args.max_len or not any(l != -100 for l in labels): skipped += 1; continue
            out.append((ids, labels, ex['meta']['kind']))
    return out, skipped

t0 = time.time()
train, sk = load('train.jsonl'); val, skv = load('val.jsonl'); val = val[:args.val_limit]
if args.limit: train = train[:args.limit]
lens = sorted(len(x[0]) for x in train)
print(f'train {len(train)} (skipped {sk}), val {len(val)} (skipped {skv}); tokens median {lens[len(lens) // 2]}, max {lens[-1]}; '
      f'trained tokens {sum(sum(1 for l in x[1] if l != -100) for x in train)}; {time.time() - t0:.0f} s', flush=True)
# show one rendered example with its trained part, to check the masking by eye
ids, labels, _ = train[0]
print('--- trained text of example 0 ---\n' + tok.decode([t for t, l in zip(ids, labels) if l != -100])[:1500] + '\n---', flush=True)

# ---------- model ----------
if args.qlora:
    from transformers import BitsAndBytesConfig
    from peft import prepare_model_for_kbit_training
    q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype, device_map={'': 0}, quantization_config=q)
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True, gradient_checkpointing_kwargs={'use_reentrant': False})
    # prepare_model_for_kbit_training puts every non-quantized weight in fp32; keep the big ones in the compute dtype
    for n, p in model.named_parameters():
        if p.dtype == torch.float32 and p.numel() > 1e6: p.data = p.data.to(dtype)
else:
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype, device_map={'': 0})
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    model.enable_input_require_grads()
model.config.use_cache = False
print('model on GPU:', round(torch.cuda.memory_allocated(0) / 1e9, 2), 'GB', flush=True)
cfg = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, bias='none', task_type='CAUSAL_LM', target_modules='all-linear')
model = get_peft_model(model, cfg)
for n, p in model.named_parameters():
    if p.requires_grad: p.data = p.data.float()      # LoRA weights in fp32 (stable with an fp16 base)
model.print_trainable_parameters()
inner = model.base_model.model                        # Qwen3_5ForCausalLM
lm_head = inner.get_output_embeddings()

PAD = tok.pad_token_id if tok.pad_token_id is not None else IM_END
def loss_of(ids, labels):
    # right padding to a bucket size: the model is causal, so padding at the end never changes earlier positions,
    # and the kernels see only a few different lengths (each new length is compiled again)
    n = -(-len(ids) // args.bucket) * args.bucket
    ids = ids + [PAD] * (n - len(ids)); labels = labels + [-100] * (n - len(labels))
    x = torch.tensor([ids], device=dev); y = torch.tensor(labels[1:] + [-100], device=dev)
    with torch.autocast('cuda', dtype=dtype):
        h = inner.model(input_ids=x).last_hidden_state[0]          # (T, H)
    sel = y != -100
    logits = lm_head(h[sel].to(lm_head.weight.dtype)).float()     # only the trained positions
    return torch.nn.functional.cross_entropy(logits, y[sel])

opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.0)
scaler = torch.amp.GradScaler('cuda', enabled=not bf16)
steps = math.ceil(len(train) * args.epochs / args.accum); warm = max(1, int(steps * 0.04))
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1, s / steps))))

@torch.no_grad()
def evaluate():
    model.eval(); tot = 0
    for ids, labels, _ in val: tot += loss_of(ids, labels).item()
    model.train(); return tot / len(val)

os.makedirs(args.out, exist_ok=True)
log = open(os.path.join(args.out, 'log.jsonl'), 'a')
print(f'{steps} optimizer steps ({args.epochs} epochs, accumulate {args.accum})', flush=True)
if not args.limit: print(f'val loss before: {evaluate():.4f}', flush=True)
model.train(); order = []; step = 0; t0 = time.time(); run = 0.0; best = 9e9
while step < steps:
    if not order: order = list(range(len(train))); random.shuffle(order)
    acc = 0.0
    for _ in range(args.accum):
        if not order: order = list(range(len(train))); random.shuffle(order)
        ids, labels, _ = train[order.pop()]
        t1 = time.time(); loss = loss_of(ids, labels) / args.accum
        scaler.scale(loss).backward(); acc += loss.item()
        if args.verbose: torch.cuda.synchronize(); print(f'  sample {len(ids)} tokens {time.time() - t1:.1f} s, peak {torch.cuda.max_memory_allocated(0) / 1e9:.1f} GB', flush=True)
    scaler.unscale_(opt); torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
    scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True); sched.step(); step += 1
    if step % 10 == 0: model.save_pretrained(os.path.join(args.out, 'lora-last'))   # resume point
    run = acc if step == 1 else 0.9 * run + 0.1 * acc
    el = time.time() - t0
    rec = {'step': step, 'loss': round(acc, 4), 'avg': round(run, 4), 'lr': sched.get_last_lr()[0], 'min': round(el / 60, 1), 'eta_min': round(el / step * (steps - step) / 60, 1), 'mem_gb': round(torch.cuda.max_memory_allocated(0) / 1e9, 1)}
    if step % args.eval_every == 0 or step == steps:
        rec['val'] = round(evaluate(), 4)
        if rec['val'] < best: best = rec['val']; model.save_pretrained(os.path.join(args.out, 'lora'))
    print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + '\n'); log.flush()
print('done, best val', best, flush=True)
