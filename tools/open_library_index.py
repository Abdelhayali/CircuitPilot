"""Build data/open-parts.txt: the parts of open KiCad-format libraries that have a symbol AND a footprint, for the
parts search. One part per line, tab separated:
    source  library  name  footprint(lib:name)  description  keywords  mpn
Sources (licences allow use in your own designs):
    kicad    gitlab.com/kicad/libraries/kicad-symbols  (+ kicad-footprints)  CC-BY-SA 4.0 with design exception
    sparkfun github.com/sparkfun/SparkFun-KiCad-Libraries                      CC-BY 4.0
    digikey  github.com/Digi-Key/digikey-kicad-library                        CC-BY-SA 4.0 with design exception
The app downloads a part's symbol and footprint from these repositories only when it is used (js/openlib.js).

    python tools/open_library_index.py [path to a local clone of kicad-symbols]
Without a local clone the KiCad symbols are skipped (they are ~20 000 files: clone with
git clone --depth 1 https://gitlab.com/kicad/libraries/kicad-symbols.git).
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "open-parts.txt")
UA = {"User-Agent": "CircuitPilot"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8", "replace")


# ---- KiCad 6+ s-expression symbols: only the properties we index
PROP = re.compile(r'\(property\s+"([^"]+)"\s+"((?:[^"\\]|\\.)*)"')
SYM = re.compile(r'^\s*\(symbol\s+"([^"]+)"', re.M)


def props_of(block):
    return {k: v for k, v in PROP.findall(block)}


def top_symbols(text):
    """split a .kicad_sym into its top-level symbols: [(name, block text)] (unit sub-symbols stay inside)"""
    out, depth, start, name, i, n = [], 0, None, None, 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            if ch == '\\':
                i += 2; continue
            if ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == '(':
            depth += 1
            if depth == 2 and text.startswith('(symbol', i):
                m = re.match(r'\(symbol\s+"([^"]+)"', text[i:i + 300])
                start, name = i, m.group(1) if m else None
        elif ch == ')':
            if depth == 2 and start is not None:
                out.append((name, text[start:i + 1])); start = None
            depth -= 1
        i += 1
    return out


def clean(s):
    return re.sub(r'[\t\r\n]+', ' ', s or '').strip()[:200]


def kicad_rows(clone):
    rows, base = [], os.path.join(clone)
    parents = {}
    for d in sorted(os.listdir(base)):
        if not d.endswith('.kicad_symdir'):
            continue
        lib = d[:-len('.kicad_symdir')]
        for f in sorted(os.listdir(os.path.join(base, d))):
            if not f.endswith('.kicad_sym'):
                continue
            text = open(os.path.join(base, d, f), encoding='utf-8', errors='replace').read()
            for name, block in top_symbols(text):
                p = props_of(block)
                m = re.search(r'\(extends\s+"([^"]+)"', block[:400])
                parents[(lib, name)] = (p, m.group(1) if m else None)
    for (lib, name), (p, ext) in parents.items():
        q = dict(parents.get((lib, ext), ({}, None))[0]) if ext else {}
        q.update({k: v for k, v in p.items() if v})
        fp = q.get('Footprint', '')
        if not fp or ':' not in fp:
            continue
        rows.append(('kicad', lib, name, fp, clean(q.get('Description') or q.get('ki_description')), clean(q.get('ki_keywords')), ''))
    return rows


def sparkfun_rows():
    rows = []
    tree = json.loads(get('https://api.github.com/repos/sparkfun/SparkFun-KiCad-Libraries/git/trees/main?recursive=1'))['tree']
    for t in tree:
        p = t['path']
        if not (p.startswith('symbols/') and p.endswith('.kicad_sym')):
            continue
        lib = p[len('symbols/'):-len('.kicad_sym')]
        text = get('https://raw.githubusercontent.com/sparkfun/SparkFun-KiCad-Libraries/main/' + p)
        syms = top_symbols(text)
        props = {n: props_of(b) for n, b in syms}
        for name, block in syms:
            q = dict(props.get((re.search(r'\(extends\s+"([^"]+)"', block[:400]) or [None, None])[1], {}))
            q.update({k: v for k, v in props[name].items() if v})
            fp = q.get('Footprint', '')
            if fp and ':' in fp:
                rows.append(('sparkfun', lib, name, fp, clean(q.get('Description') or q.get('ki_description')), clean(q.get('ki_keywords')), clean(q.get('PROD_ID') or q.get('MPN') or '')))
        print(f'\r  sparkfun {lib:40}', end='', flush=True)
    print()
    return rows


def digikey_rows():
    """KiCad 5 libraries (.lib + .dcm): DEF name … F2 "footprint" … ENDDEF; descriptions in the .dcm"""
    rows = []
    tree = json.loads(get('https://api.github.com/repos/Digi-Key/digikey-kicad-library/git/trees/master?recursive=1'))['tree']
    libs = [t['path'] for t in tree if t['path'].startswith('digikey-symbols/') and t['path'].endswith('.lib')]
    for p in libs:
        lib = p.rsplit('/', 1)[1][:-4]
        text = get('https://raw.githubusercontent.com/Digi-Key/digikey-kicad-library/master/' + p)
        try:
            dcm = get('https://raw.githubusercontent.com/Digi-Key/digikey-kicad-library/master/' + p[:-4] + '.dcm')
        except Exception:
            dcm = ''
        desc = {}
        for m in re.finditer(r'^\$CMP\s+(\S+)\s*\n(.*?)^\$ENDCMP', dcm, re.M | re.S):
            d = re.search(r'^D\s+(.*)$', m.group(2), re.M); k = re.search(r'^K\s+(.*)$', m.group(2), re.M)
            desc[m.group(1)] = (d.group(1) if d else '', k.group(1) if k else '')
        for m in re.finditer(r'^DEF\s+(\S+)\s.*?^ENDDEF', text, re.M | re.S):
            name, block = m.group(1), m.group(0)
            f2 = re.search(r'^F2\s+"([^"]*)"', block, re.M)
            fp = f2.group(1) if f2 else ''
            if not fp or ':' not in fp:
                continue
            mpn = ''
            for f in re.finditer(r'^F\d+\s+"([^"]*)".*?"([^"]+)"\s*$', block, re.M):
                if f.group(2).upper() in ('MPN', 'MFR PART #', 'MANUFACTURER PART NUMBER'):
                    mpn = f.group(1)
            d, k = desc.get(name, ('', ''))
            rows.append(('digikey', lib, name, fp, clean(d), clean(k), clean(mpn)))
        print(f'\r  digikey {lib:50}', end='', flush=True)
    print()
    return rows


def main():
    rows = []
    if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
        rows += kicad_rows(sys.argv[1]); print('kicad', len(rows))
    n = len(rows); rows += sparkfun_rows(); print('sparkfun', len(rows) - n)
    n = len(rows); rows += digikey_rows(); print('digikey', len(rows) - n)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join('\t'.join(r) for r in rows) + '\n')
    print('wrote', OUT, len(rows), 'parts')


if __name__ == '__main__':
    main()
