# Tables and charts for the paper from the benchmark results (results.json, cnc.json, tokens.json, organize.json).
# Usage: python docs/paper/bench/make-figs.py   → docs/paper/tables/*.tex, docs/paper/figs/routing.pdf, tokens.pdf
import json, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
P = os.path.dirname(HERE)
TAB, FIG = os.path.join(P, 'tables'), os.path.join(P, 'figs')
os.makedirs(TAB, exist_ok=True)
R = json.load(open(os.path.join(HERE, 'results.json')))
C = json.load(open(os.path.join(HERE, 'cnc.json')))
T = json.load(open(os.path.join(HERE, 'tokens.json')))
plt.rcParams.update({'font.family': 'serif', 'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False})
BLUE, ORANGE, GREEN, RED, GREY = '#2563eb', '#f59e0b', '#16a34a', '#dc2626', '#64748b'

def esc(s): return s.replace('_', r'\_')
short = {}
for i, r in enumerate(R): short[r['name']] = f'D{i + 1}'

# ---- Table: benchmark designs and routing results ----
rows = []
for r in R:
    f, n = r['full'], r['noripup']
    fmt = lambda x: (r'\textbf{%d/%d}' if x['unrouted'] == 0 else '%d/%d') % (x['routed'], x['total'])
    rows.append(' & '.join([short[r['name']], str(r['parts']), str(r['nets']), str(r['pins']), str(r['layers']),
                            '%g$\\times$%g' % tuple(round(v, 1) for v in r['board_mm']), fmt(n), fmt(f), str(f['vias']),
                            '%.0f' % f['length_mm'], '%.1f' % f['seconds'], str(f['drc_errors'])]) + r' \\')
full_ok = sum(r['full']['unrouted'] == 0 for r in R); nr_ok = sum(r['noripup']['unrouted'] == 0 for r in R)
nets_full = sum(r['full']['routed'] for r in R); nets_nr = sum(r['noripup']['routed'] for r in R); nets_all = sum(r['full']['total'] for r in R)
with open(os.path.join(TAB, 'routing.tex'), 'w') as fo:
    fo.write('\n'.join(rows) + '\n\\midrule\n')
    fo.write(r'All & %d & %d & %d & & & %d/%d & %d/%d & %d & %.0f & %.1f & %d \\' % (
        sum(r['parts'] for r in R), sum(r['nets'] for r in R), sum(r['pins'] for r in R), nets_nr, nets_all, nets_full, nets_all,
        sum(r['full']['vias'] for r in R), sum(r['full']['length_mm'] for r in R), sum(r['full']['seconds'] for r in R),
        sum(r['full']['drc_errors'] for r in R)) + '\n')
with open(os.path.join(TAB, 'designs.tex'), 'w') as fo:
    fo.write('\n'.join(r'%s & %s \\' % (short[r['name']], esc(r['name'])) for r in R) + '\n')
stats = dict(designs=len(R), full_ok=full_ok, nr_ok=nr_ok, nets_full=nets_full, nets_nr=nets_nr, nets_all=nets_all,
             med_s=sorted(r['full']['seconds'] for r in R)[len(R) // 2], max_s=max(r['full']['seconds'] for r in R),
             parts=sum(r['parts'] for r in R))
json.dump(stats, open(os.path.join(HERE, 'stats.json'), 'w'), indent=1)
print(stats)

# ---- Chart: completion and run time per design ----
fig, ax = plt.subplots(1, 2, figsize=(7.0, 2.9))
x = range(len(R)); w = 0.38
ax[0].bar([i - w / 2 for i in x], [100 * r['noripup']['routed'] / r['noripup']['total'] for r in R], w, color=ORANGE, label='single pass (no rip-up)')
ax[0].bar([i + w / 2 for i in x], [100 * r['full']['routed'] / r['full']['total'] for r in R], w, color=BLUE, label='negotiated rip-up')
ax[0].set_ylim(75, 101); ax[0].set_ylabel('nets routed (%)'); ax[0].set_xticks(list(x)); ax[0].set_xticklabels([short[r['name']] for r in R], rotation=90)
ax[0].legend(loc='upper center', bbox_to_anchor=(0.5, -0.3), ncol=2, frameon=False, fontsize=9); ax[0].set_title('(a) Routing completion', fontsize=10)
nets = [r['nets'] for r in R]
ok = [r['full']['unrouted'] == 0 for r in R]
ax[1].scatter([n for n, o in zip(nets, ok) if o], [r['full']['seconds'] for r, o in zip(R, ok) if o], color=GREEN, s=18, label='all nets routed', zorder=3)
ax[1].scatter([n for n, o in zip(nets, ok) if not o], [r['full']['seconds'] for r, o in zip(R, ok) if not o], color=RED, marker='x', s=22, label='nets left open', zorder=3)
# labels only where they do not collide: the small boards D1-D6 share one label
small = [r for r in R if r['nets'] <= 26]
ax[1].annotate('D1-D6', (18, 11.9), fontsize=8, xytext=(-12, 8), textcoords='offset points', color=GREY)
offs = {'D7': (-14, 6), 'D8': (6, -10), 'D9': (5, 2), 'D12': (-22, 4), 'D10': (5, -4)}
for r in R:
    if r in small: continue
    k = short[r['name']]; ax[1].annotate(k, (r['nets'], r['full']['seconds']), fontsize=8, xytext=offs.get(k, (5, 2)), textcoords='offset points', color=GREY)
ax[1].set_xlabel('multi-pin nets'); ax[1].set_ylabel('router run time (s)'); ax[1].legend(loc='upper center', bbox_to_anchor=(0.5, -0.3), ncol=2, frameon=False, fontsize=9); ax[1].set_title('(b) Run time vs. design size', fontsize=10)
ax[1].grid(alpha=0.25)
plt.tight_layout(); plt.savefig(os.path.join(FIG, 'routing.pdf'), bbox_inches='tight'); plt.close()

# ---- Table: CNC ----
rows = []
for c in C:
    i = c['info']; iso = i['isolation']; tc = i['toolpath_check']
    rows.append(' & '.join([short.get(c['name'], c['name']), c['relief'], '%g$\\times$%g' % tuple(i['board_mm']), str(iso['rings']), '%d' % iso['length_mm'],
                            str(sum(d['holes'] for d in i['drills'])), str(c['gcode_lines']), str(i['est_minutes']), '%d/%d' % (tc['shorts_at_narrow_groove'], tc['nets_cut_at_wide_groove']), '%.1f' % (c['ms'] / 1000)]) + r' \\')
open(os.path.join(TAB, 'cnc.tex'), 'w').write('\n'.join(rows) + '\n')

# ---- Chart + table: compact tool answers vs raw project ----
rows = T['rows']
fig, ax = plt.subplots(figsize=(3.4, 2.0))
raw = [r['raw'] / 4 / 1000 for r in rows]
for key, col, lab in [('get_design', BLUE, 'get\\_design'), ('get_pcb_layout', GREEN, 'get\\_pcb\\_layout'), ('get_tracks', ORANGE, 'get\\_tracks')]:
    ax.scatter(raw, [r[key] / 4 / 1000 for r in rows], s=14, color=col, label=lab.replace('\\', ''), zorder=3)
m = max(raw); ax.plot([0, m], [0, m], color=GREY, lw=0.8, ls='--', label='raw project JSON')
ax.set_xlabel('raw project JSON (k tokens)'); ax.set_ylabel('tool answer (k tokens)'); ax.legend(frameon=False, fontsize=6.5); ax.grid(alpha=0.25)
plt.tight_layout(); plt.savefig(os.path.join(FIG, 'tokens.pdf')); plt.close()
ratio = lambda k: sum(r[k] for r in rows) / sum(r['raw'] for r in rows)
json.dump({'layout_ratio': ratio('get_pcb_layout'), 'design_ratio': ratio('get_design'), 'tracks_ratio': ratio('get_tracks'),
           'schema_tokens': T['tool_schema_chars'] / 4, 'max_raw_tokens': max(r['raw'] for r in rows) / 4,
           'max_layout_tokens': max(r['get_pcb_layout'] for r in rows) / 4}, open(os.path.join(HERE, 'tokstats.json'), 'w'), indent=1)
print(open(os.path.join(HERE, 'tokstats.json')).read())

# ---- LaTeX macros with the headline numbers (tables/stats.tex) ----
ts = json.load(open(os.path.join(HERE, 'tokstats.json')))
pct = lambda v: r'%d\,\%%' % round(100 * v)
thou = lambda v: '{:,}'.format(int(round(v, -2))).replace(',', '{,}')
mac = {'ToolCount': 105, 'ProjectCount': 65, 'DesignCount': stats['designs'], 'PartCount': stats['parts'], 'FullOk': stats['full_ok'],
       'NoRipOk': stats['nr_ok'], 'NetsFull': stats['nets_full'], 'NetsNr': stats['nets_nr'], 'NetsAll': stats['nets_all'],
       'MedSec': '%.1f' % stats['med_s'], 'LayoutPct': pct(ts['layout_ratio']), 'DesignPct': pct(ts['design_ratio']),
       'TracksPct': pct(ts['tracks_ratio']), 'MaxLayoutTok': thou(ts['max_layout_tokens']), 'MaxRawTok': thou(ts['max_raw_tokens']),
       'SchemaTok': thou(ts['schema_tokens'])}
note = os.path.join(HERE, 'routing-note.tex')
with open(os.path.join(TAB, 'stats.tex'), 'w', encoding='utf8') as fo:
    for k, v in mac.items(): fo.write('\\newcommand{\\%s}{%s}\n' % (k, v))
    fo.write('\\newcommand{\\RoutingNote}{%s}\n' % (open(note, encoding='utf8').read().strip() if os.path.exists(note) else ''))
print(open(os.path.join(TAB, 'stats.tex')).read())
