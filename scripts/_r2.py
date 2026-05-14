"""
Shared R2 connection details + client factory.

Centralises:
  * the Cloudflare R2 endpoint URL
  * the bucket name
  * the `R2_ACCESS_KEY` / `R2_SECRET_KEY` resolution (via `_env.load_env`,
    so values can live in `.env.local` and be picked up automatically)
  * a `boto3` S3 client with retry/pool config that works well for the
    70k-file bulk operations the scripts in this folder do

Usage:

    from _r2 import ENDPOINT, BUCKET, make_client
    s3 = make_client()
    s3.list_objects_v2(Bucket=BUCKET, ...)
"""

from __future__ import annotations

import os
import sys

# load_env runs once on import; subsequent calls are cheap no-ops.
from _env import load_env

load_env()

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("ERROR: boto3 not installed. Run: pip install boto3")
    sys.exit(1)


# Bucket / endpoint are stable for this project — no reason to over-engineer
# them into config files. Override via env vars if you ever need to (e.g.
# pointing scripts at a staging bucket).
ENDPOINT = os.environ.get(
    "R2_ENDPOINT",
    "https://10eeeb9ff10ab208fccf3479cdde6c19.r2.cloudflarestorage.com",
)
BUCKET = os.environ.get("R2_BUCKET", "chord-images")


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(
            f"ERROR: {name} is not set.\n"
            f"  Add it to <project_root>/.env.local (one line: {name}=...) or\n"
            f"  set it inline:  $env:{name} = '...'"
        )
    return value


def make_client(workers: int = 16) -> "boto3.client":  # type: ignore[name-defined]
    """Build a configured S3 client for the R2 bucket."""
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=_require("R2_ACCESS_KEY"),
        aws_secret_access_key=_require("R2_SECRET_KEY"),
        region_name="auto",
        config=Config(
            max_pool_connections=workers * 2,
            retries={"max_attempts": 5, "mode": "adaptive"},
            s3={"addressing_style": "path"},
        ),
    )
