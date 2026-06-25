// Per-song fix in one command: re-extract the given id(s) with the local
// Ollama vision model (overwriting their data/songs-md/<id>.md), overwrite
// those same files on R2, then rebuild songs.bin. Threads the id list into
// BOTH the backfill and the upload — which a chained npm script can't do,
// since `npm run x -- <args>` appends only to the LAST command in the chain.
//
//   npm run chordpro:fix -- 2 4 19          (space- or comma-separated)
//   npm run chordpro:fix -- 2,4,19
//   node scripts/fix.mjs 2 4 19

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Collect ids from argv (accepts "2 4", "2,4", or a mix), digits only.
const ids = process.argv
  .slice(2)
  .flatMap((a) => a.split(","))
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s));

if (ids.length === 0) {
  console.error("usage: npm run chordpro:fix -- <id> [<id> ...]    e.g.  npm run chordpro:fix -- 2 4 19");
  process.exit(1);
}
const list = ids.join(",");

// `py -3.11` on Windows, `python3` elsewhere (so this works on the Ubuntu server too).
const PY = process.platform === "win32" ? ["py", "-3.11"] : ["python3"];

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`\n✗ step failed (exit ${r.status ?? "?"}): ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

console.log(`chordpro:fix → re-extracting + overwriting on R2: ${list}`);
run("node", ["scripts/local-backfill.mjs", "--ids", list, "--force"]); // re-extract (overwrite local)
run(PY[0], [...PY.slice(1), "scripts/upload_md_r2.py", "--ids", list]); // overwrite those on R2
run("node", ["scripts/build-data.mjs"]); // refresh songs.bin (t-flags) — no-op diff for content-only fixes
console.log(`\n✓ done: ${list} re-extracted, uploaded to R2, songs.bin rebuilt.`);
