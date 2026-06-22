#!/usr/bin/env python3
"""
Parallel CPU backfill for the ChordPro OCR pipeline.

Fans `scripts/extract_chordpro.py` out across N worker processes (one slice of the
un-extracted song list each), shows a live progress/ETA line, then rebuilds
`public/songs.bin` once at the end. Resumable: re-run any time — already-extracted
ids (those with a `data/chordpro/<id>.txt`) are skipped, so a fresh run picks up
exactly where the last left off.

QUALITY: full by default (both detector passes — byte-for-byte the same result as the
serial `npm run chordpro`, just faster). `--fast` drops the 2nd (s=3) pass for ~2x speed
at the cost of some chord recall on hard songs; flag those later with
`npm run chordpro:check` and re-OCR them at full quality with
`py -3.11 scripts/extract_chordpro.py <ids> --force`.

  py -3.11 scripts/backfill.py                  # all missing, ~5 workers, full quality
  py -3.11 scripts/backfill.py --workers 4      # tune worker count
  py -3.11 scripts/backfill.py --fast           # ~2x faster, lower recall
  py -3.11 scripts/backfill.py --limit 200      # just the next 200 (smoke-test the loop)
  py -3.11 scripts/backfill.py --no-build       # skip the songs.bin rebuild at the end

Why parallel beats one big run: EasyOCR on CPU doesn't scale a single song past a few
cores, so N pinned workers (each capped to a couple of threads) gets far more total
throughput. On a 6-core/12-thread box this turns a ~36-day serial backfill into a few days.
"""
import argparse, json, os, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def missing_ids(out_dir, results):
    recs = json.load(open(results, encoding='utf-8'))
    have = ({int(f[:-4]) for f in os.listdir(out_dir) if f.endswith('.txt') and f[:-4].isdigit()}
            if os.path.exists(out_dir) else set())
    return [r['id'] for r in recs if r['id'] not in have]


def fmt_eta(seconds):
    if seconds == float('inf') or seconds != seconds: return '—'
    h = seconds / 3600
    return f'{h:.1f}h' if h < 48 else f'{h / 24:.1f}d'


def main():
    ap = argparse.ArgumentParser(description='Parallel CPU backfill of the ChordPro OCR pipeline.')
    ap.add_argument('--workers', type=int, default=5, help='worker processes (default 5). Tuned for THIS box: 6 physical cores + EasyOCR holds ~2.5 GB RAM per worker, so 8 workers exhausted RAM (→ swap → crawl). 5 fits in memory with headroom and leaves a core for the OS. Raise it only if you have spare RAM AND cores; watch the live ETA + free RAM and tune.')
    ap.add_argument('--threads', type=int, default=0, help='torch threads per worker (0=auto: logical_cores // workers, min 1)')
    ap.add_argument('--limit', type=int, help='cap total songs this run (default: ALL missing)')
    ap.add_argument('--fast', action='store_true', help='drop the 2nd detector pass — ~2x faster, lower recall')
    ap.add_argument('--out', default='data/chordpro', help='ChordPro output dir')
    ap.add_argument('--results', default='data/results.json', help='song list')
    ap.add_argument('--no-build', dest='build', action='store_false', help='skip rebuilding songs.bin at the end')
    args = ap.parse_args()

    for s in (sys.stdout, sys.stderr):                # Windows pipes default to cp1252 → can't encode → / ×
        try: s.reconfigure(encoding='utf-8', errors='replace')
        except Exception: pass
    os.chdir(ROOT)                                    # so the workers' relative paths resolve
    ids = missing_ids(args.out, args.results)
    if args.limit is not None: ids = ids[:max(0, args.limit)]
    if not ids:
        print('nothing to do — every song already has ChordPro.'); return

    W = max(1, min(args.workers, len(ids)))
    threads = args.threads or max(1, (os.cpu_count() or 2) // W)
    mode = 'FAST (1 detector pass)' if args.fast else 'full quality (2 passes)'
    print(f'backfill: {len(ids):,} songs → {W} workers × {threads} threads — {mode}', flush=True)

    tmpdir = tempfile.mkdtemp(prefix='chordpro_backfill_')
    procs, logs = [], []
    t0 = time.time()
    for i in range(W):
        shard = ids[i::W]                             # round-robin → even mix across workers
        if not shard: continue
        idf = os.path.join(tmpdir, f'shard{i}.txt')
        open(idf, 'w', encoding='utf-8').write('\n'.join(map(str, shard)))
        logp = os.path.join(tmpdir, f'worker{i}.log')
        env = dict(os.environ, OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads),
                   OPENBLAS_NUM_THREADS=str(threads), NUMEXPR_NUM_THREADS=str(threads),
                   PYTHONUTF8='1')                    # worker logs stay valid UTF-8 (Thai titles etc.)
        cmd = [sys.executable, 'scripts/extract_chordpro.py', '--ids-file', idf, '--cpu']
        if args.fast: cmd.append('--fast')
        lf = open(logp, 'w', encoding='utf-8')
        procs.append(subprocess.Popen(cmd, env=env, stdout=lf, stderr=subprocess.STDOUT))
        logs.append((logp, lf))
        time.sleep(2)                                 # stagger startup: spread first fetches + model-load IO
    print(f'  {len(procs)} workers running. logs: {tmpdir}', flush=True)

    try:
        while any(p.poll() is None for p in procs):
            time.sleep(20)
            done = sum(1 for sid in ids if os.path.exists(os.path.join(args.out, f'{sid}.txt')))
            el = time.time() - t0
            rate = done / el * 60 if el > 0 else 0    # songs/min
            eta = (len(ids) - done) / (done / el) if done > 0 else float('inf')
            print(f'  {done:,}/{len(ids):,} done | {rate:.1f}/min | ETA {fmt_eta(eta)}', flush=True)
    except KeyboardInterrupt:
        print('\ninterrupted — terminating workers (re-run later to resume) …', flush=True)
        for p in procs: p.terminate()
        for p in procs: p.wait()
        raise
    finally:
        for _, lf in logs: lf.close()

    rc = 0
    for p in procs: rc |= p.returncode or 0
    done = sum(1 for sid in ids if os.path.exists(os.path.join(args.out, f'{sid}.txt')))
    print(f'\nworkers finished in {(time.time() - t0) / 60:.1f} min — {done:,}/{len(ids):,} extracted (rc={rc}).', flush=True)
    if done < len(ids):
        print(f'  {len(ids) - done:,} not produced (no-lyrics or blocked) — re-run to retry the blocked ones. logs: {tmpdir}', flush=True)

    if args.build:
        print('rebuilding public/songs.bin …', flush=True)
        subprocess.run(['node', 'scripts/build-data.mjs'], cwd=ROOT, check=False)
        print('done — hard-refresh the browser (Ctrl+Shift+R).', flush=True)


if __name__ == '__main__':
    main()
