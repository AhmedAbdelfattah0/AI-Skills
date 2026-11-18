# Mutation harness, round 6 (S-02a0b). A mutant is KILLED only when the run has the baseline test count and at least one
# failing test reports ERR_ASSERTION; a load or syntax error, a changed test count or a timeout is INVALID. Each run gets a
# copy of the whole skills/ tree (the vendor check scans every skill). Anchors are matched on LF-normalised text and must
# occur exactly once; a mutant may carry several (old, new) pairs, applied in order.
# Usage: python3 mutate6.py [--check | <mutant name>...]   (NODE env var selects the binary)
import hashlib, os, re, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutants6 import ALL
REPO = '/Users/ahmedabdelfatah/Documents/personal-projects/ais-s02b'
SKILLS = REPO + '/skills'
NODE = os.path.expanduser(os.environ.get('NODE', '~/.nvm/versions/node/v22.23.1/bin/node'))
T = 'git-exec.test.mjs'
UNDER_TEST = ['skills/ship-ticket/scripts/lib/git-exec.mjs', 'skills/ship-ticket/scripts/lib/git-capability.mjs', 'skills/ship-ticket/scripts/lib/' + T,
              'skills/ship-ticket/scripts/lib/git-capability.test.mjs', '.specs/reviews/S-02a0b/round-6/mutants6.py', '.specs/reviews/S-02a0b/round-6/mutate6.py']
def tree():
    d = tempfile.mkdtemp(prefix='mut6-')
    shutil.copytree(SKILLS, d + '/skills', ignore=shutil.ignore_patterns('node_modules', '.DS_Store'))
    return d
CAP_T = 'git-capability.test.mjs'
def run(d, t=T):
    try:
        r = subprocess.run([NODE, '--test', t], cwd=d + '/skills/ship-ticket/scripts/lib', capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return None, None, 'timeout'
    m = re.search(r'^# tests (\d+)$', r.stdout, re.M)
    return r, int(m.group(1)) if m else None, None
def verdict(r, n, why, n0):
    if why: return 'INVALID', why
    blocks = re.split(r'^(?=not ok |ok )', r.stdout, flags=re.M)
    failing = [b for b in blocks if b.startswith('not ok')]
    assertion = [b.split('\n', 1)[0][7:].split(' - ', 1)[-1] for b in failing if "code: 'ERR_ASSERTION'" in b]
    if n != n0: return 'INVALID', f'test count {n} != {n0} (load failure?)'
    if r.returncode == 0: return 'SURVIVED', ''
    if assertion: return 'KILLED', '; '.join(assertion[:3])
    return 'INVALID', 'failed without an assertion error'
def apply(text, pairs):
    for old, new in pairs:
        if text.count(old) != 1: return None, f'anchor x{text.count(old)}: {old[:70]!r}'
        text = text.replace(old, new)
    return text, None
SPECIAL = ['vendor: one byte of acorn.mjs changed', 'vendor: extra file in vendor/acorn']
if __name__ == '__main__':
    bad = 0
    for name, fname, pairs in ALL:
        s = open(os.path.join(REPO, fname), newline='').read().replace('\r\n', '\n')
        _, err = apply(s, pairs)
        if err: print(f'ANCHOR {name}: {err}'); bad += 1
    names = [n for n, _, _ in ALL] + SPECIAL
    assert len(names) == len(set(names)), 'duplicate mutant names'
    print(f'{len(ALL) + len(SPECIAL)} mutants; bad anchors: {bad}', flush=True)
    if sys.argv[1:] == ['--check']: sys.exit(1 if bad else 0)
    only = sys.argv[1:]
    for f in UNDER_TEST: print('sha256', hashlib.sha256(open(os.path.join(REPO, f), 'rb').read()).hexdigest(), f, flush=True)
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'skills'], cwd=REPO, capture_output=True, text=True).stdout.strip()
    print(f'head {head}; skills/ dirty: {dirty or "no"}; node {subprocess.run([NODE, "-v"], capture_output=True, text=True).stdout.strip()}', flush=True)
    d0 = tree(); r0, n0, _ = run(d0); rc, nc, _ = run(d0, CAP_T); shutil.rmtree(d0)
    assert r0.returncode == 0 and n0 and rc.returncode == 0 and nc, 'baseline must be green'
    print(f'baseline: {n0} tests green ({T}), {nc} ({CAP_T}); a git-capability.mjs mutant runs both files', flush=True)
    tally = {'KILLED': 0, 'SURVIVED': 0, 'INVALID': 0}
    for name, fname, pairs in ALL:
        if only and name not in only: continue
        d = tree(); p = os.path.join(d, fname); s = open(p, newline='').read().replace('\r\n', '\n')
        t, err = apply(s, pairs)
        if err: print(f'INVALID ({err}) {name}'); tally['INVALID'] += 1; shutil.rmtree(d); continue
        open(p, 'w', newline='').write(t)
        v, detail = verdict(*run(d), n0)
        if fname.endswith('/git-capability.mjs') and v == 'SURVIVED': v, detail = verdict(*run(d, CAP_T), nc)
        shutil.rmtree(d); tally[v] += 1
        print(f'{v} {name}' + (f' | {detail}' if detail else ''), flush=True)
    for name in SPECIAL:
        if only and name not in only: continue
        d = tree(); p = d + '/skills/ship-ticket/vendor/acorn/acorn.mjs'
        if name.startswith('vendor: one'):
            b = bytearray(open(p, 'rb').read()); i = b.index(b'var astralIdentifierCodes'); b[i] ^= 0x01; open(p, 'wb').write(bytes(b))
        else:
            open(d + '/skills/ship-ticket/vendor/acorn/extra.mjs', 'w').write('export {};\n')
        v, detail = verdict(*run(d), n0); shutil.rmtree(d); tally[v] += 1
        print(f'{v} {name}' + (f' | {detail}' if detail else ''), flush=True)
    print('TALLY', tally, flush=True)
