"""
Tiny dotenv loader so the Python scripts don't need their R2 credentials
re-typed (`$env:R2_ACCESS_KEY = ...`) in every shell session.

Reads `KEY=VALUE` lines from `<project_root>/.env.local` (and `.env` as a
backup) and pokes them into os.environ. Doesn't overwrite anything that
was already set — explicit env wins, so CI / scheduled jobs can still
inject overrides without editing the file.

Each Python script in this folder imports it once at the top:

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _env import load_env  # noqa: E402
    load_env()

Then the rest of the script just calls os.environ.get(...) as usual.
"""

from __future__ import annotations

import os
from pathlib import Path

# Look for env files at the project root (one level above scripts/). We
# probe `.env.local` first to match the Vite convention used by the rest
# of the codebase, then `.env` as a fallback for anyone who happens to
# have one but no `.env.local`.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILES = (
    _PROJECT_ROOT / ".env.local",
    _PROJECT_ROOT / ".env",
)


def load_env() -> None:
    """Populate os.environ from `.env.local` / `.env` (without overwriting)."""
    for env_path in _ENV_FILES:
        if not env_path.exists():
            continue
        try:
            text = env_path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # Strip matching surrounding quotes (`KEY="hello"` -> `hello`).
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            if not key:
                continue
            # `setdefault` — explicit env wins over the file.
            os.environ.setdefault(key, value)
