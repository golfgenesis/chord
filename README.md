# Chordtabs Dataset

Scraped chord-image dataset from chordtabs.in.th, plus the tooling to refresh and extend it.

## Layout

```
F:\chord\
├── data\
│   ├── results.json              # main dataset: [{id, src, alt}, ...] (70,107 records)
│   ├── results.jsonl             # raw line-per-record log (resumable scrape state)
│   └── archive\                  # one-shot artifacts from the build
│       ├── results.before_sync.json
│       ├── removed.json
│       ├── removed_with_names.json
│       ├── duplicates.json
│       ├── case_collisions.json
│       └── page2688_divlyric.html
├── images\                       # 70,107 PNG chord sheets, ~4.94 GB
├── scripts\
│   ├── scrape.py                 # fetch HTML + extract <img src/alt>
│   ├── download.py               # download images to images\
│   ├── sync_names.py             # keep alt <-> filename in sync
│   └── maintenance\              # one-off helpers, kept for reference
└── logs\
    ├── run.log, download.log
    └── *_errors.log
```

All scripts compute paths relative to `PROJECT_ROOT` (= `F:\chord`), so the whole folder can be moved or renamed without code changes.

## Routine tasks

### Scrape new pages (e.g. ids beyond 70569)

```powershell
$env:PYTHONIOENCODING = "utf-8"
python F:\chord\scripts\scrape.py --start 70570 --end 75000
```

The script appends to `data\results.jsonl` (resumable) and rewrites `data\results.json` at the end. It skips ids that are already done.

### Download newly-scraped images

```powershell
python F:\chord\scripts\download.py
```

Skips files that already exist on disk. Use `--test N` to dry-run on the first N records.

### Re-sync alt fields to filenames (after re-scrape)

```powershell
python F:\chord\scripts\sync_names.py --dry-run    # preview
python F:\chord\scripts\sync_names.py              # apply
```

Backs up the previous `results.json` to `data\archive\results.before_sync.json`.

## Dataset shape

Each record in `results.json`:
```json
{
  "id": 1,
  "src": "https://chordtabs.in.th/img/nm/c0000101.png",
  "alt": "คอร์ด คำสาป Playground"
}
```

Filename rule (used when downloading):
- Strip `"คอร์ด "` prefix from `alt`
- Sanitize for Windows (`< > : " / \ | ? *` → `_`)
- If the cleaned name collides case-insensitively with another record, append `_{id}`
- `.png` extension

After `sync_names.py`, every record's `alt` minus `"คอร์ด "` matches its filename on disk exactly (sans extension).

## Counts

| | |
|---|---|
| Pages scraped (1..70569)  | 70,569 |
| Records with a real image | 70,107 |
| Image files on disk       | 70,107 |
| Total image size          | 4.94 GB |
| Duplicate-name records    | 2,162 (use `_{id}` suffix) |

## Dependencies

```powershell
python -m pip install requests beautifulsoup4 lxml
```
