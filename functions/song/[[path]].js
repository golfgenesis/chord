// Edge SSR for public song pages — Cloudflare Pages Function.
//
// WHY this exists (and why it's NOT 70k static HTML files): Cloudflare Pages
// caps a deployment at 20,000 files (Free) / 100,000 (Paid). One Function file
// renders ANY song's page on demand instead, so the catalogue can grow past
// those limits with zero extra files. See MARKETING.md.
//
// Route: this file matches /song/* only (file-based routing: functions/song/
// [[path]].js). Everything else — the SPA at /, room URLs /<6-digits>, all the
// hashed assets, songs.bin — is served as a normal static asset, UNTOUCHED.
//
// Flow for /song/<id>/<slug>:
//   1. Look up the song by <id> in the decoded songs payload (cached per isolate).
//   2. If <slug> isn't the canonical slug → 301 to the canonical URL (SEO dedup).
//   3. Fetch the real index.html, swap the <!-- seo:start … seo:end --> block for
//      per-song <title>/description/canonical/OG + JSON-LD, and inject the rendered
//      chord sheet into <!-- ssr --> so crawlers (and the first paint) see real text.
//   4. The SPA then boots normally and — via the /song/<id> handling added to
//      store.ts — opens that song in the existing clean fullscreen view. The app
//      UI is never modified; this is a separate crawl/landing layer.
//
// The rendered HTML is edge-cached (caches.default) so Googlebot hammering 70k
// pages mostly hits cache, and the payload decode happens only on a cold isolate.

const XOR_KEY_HEX = "9c4f1d6a3e80b5b27cdb1f24a8e6b35a2710f87c4d65e3b9af8c01d72e64b395";
const SITE_NAME = "Chord";

// ---- decode + cache the songs payload (once per isolate) --------------------
let SONGS = null; // Map<id, {id,name,cp?}>

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const KEY = hexToBytes(XOR_KEY_HEX);

async function loadSongs(env, origin) {
  if (SONGS) return SONGS;
  const res = await env.ASSETS.fetch(new Request(`${origin}/songs.bin`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= KEY[i % KEY.length];
  const ds = new DecompressionStream("gzip");
  const text = await new Response(new Response(bytes).body.pipeThrough(ds)).text();
  const arr = JSON.parse(text);
  const map = new Map();
  for (const s of arr) map.set(s.id, s);
  SONGS = map;
  return SONGS;
}

// ---- pure helpers (exported for node smoke-tests) ---------------------------

/** MUST stay byte-identical to scripts/build-sitemap.mjs:slugify(). */
export function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^\p{L}\p{N}-]+/gu, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "song"
  );
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DIRECTIVE_RE = /^\{\s*([a-z_]+)\s*:\s*([^}]*)\}\s*$/i;
const SECTION_LABEL_RE =
  /\b(intro|verse|chorus|prechorus|bridge|outro|ending|coda|solo|interlude|instru(?:mental)?|hook|tag|riff)\b/i;

/**
 * Parse the inline-bracket ChordPro `cp` into a plain-text chord sheet (chords
 * on a line above the lyric, monospace) + metadata + the set of chords used.
 * A minimal, dependency-free mirror of src/lib/chordpro.ts — enough for a
 * crawlable text representation; the live app still does the rich rendering.
 */
export function renderSheet(cp) {
  const meta = {};
  const blocks = [];
  const chordSet = new Set();

  for (const raw of String(cp).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const dir = line.match(DIRECTIVE_RE);
    if (dir) {
      const name = dir[1].toLowerCase();
      const value = dir[2].trim();
      if (name === "key") meta.key = value;
      else if (name === "note" || name === "comment" || name === "c") meta.note = value;
      else if (name === "title" || name === "t") meta.title = value;
      else if (name === "artist" || name === "subtitle" || name === "st") meta.artist = value;
      continue;
    }
    if (line.trim() === "") {
      blocks.push("");
      continue;
    }

    // Collect chords for the FAQ regardless of line type.
    for (const m of line.matchAll(/\[([^\]]*)\]/g)) if (m[1].trim()) chordSet.add(m[1].trim());

    // Chord-only row (Intro / Instru / header): just drop the brackets.
    const stripped = line
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(SECTION_LABEL_RE, " ")
      .replace(/[/|×x*:.,\-–—\d]/gi, " ")
      .trim();
    if (stripped.length === 0) {
      blocks.push(line.replace(/\[([^\]]*)\]/g, "$1").replace(/\s+/g, " ").trim());
      continue;
    }

    // Lyric row: build a chord line positioned above the lyric line.
    let lyric = "";
    let chords = "";
    const re = /\[([^\]]*)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      lyric += line.slice(last, m.index);
      if (chords.length < lyric.length) chords += " ".repeat(lyric.length - chords.length);
      const c = m[1].trim();
      if (c) chords += c + " ";
      last = re.lastIndex;
    }
    lyric += line.slice(last);
    const lyricTrim = lyric.replace(/\s+$/, "");
    const chordTrim = chords.replace(/\s+$/, "");
    blocks.push(chordTrim ? `${chordTrim}\n${lyricTrim}` : lyricTrim);
  }

  // Collapse 3+ blank lines, trim ends.
  const text = blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, meta, chords: [...chordSet] };
}

/** Build the per-song <head> tag block that replaces the seo:start…end region. */
export function buildHead(song, canonicalUrl, sheet, indexable) {
  const name = song.name;
  const chordList = sheet.chords.slice(0, 12).join(" ");
  const title = `คอร์ดเพลง ${name} | ${SITE_NAME}`;
  const desc = indexable
    ? `คอร์ดเพลง ${name} พร้อมเนื้อร้องครบทุกท่อน เปลี่ยนคีย์ (transpose) ได้ทันที${chordList ? ` · คอร์ดที่ใช้: ${chordList}` : ""}`
    : `คอร์ดเพลง ${name}`;
  const img = "https://chord.golfchairat.com/icon-512.png";

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "MusicComposition",
        name: name,
        url: canonicalUrl,
        inLanguage: "th-TH",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "หน้าแรก", item: "https://chord.golfchairat.com/" },
          { "@type": "ListItem", position: 2, name: `คอร์ดเพลง ${name}`, item: canonicalUrl },
        ],
      },
    ],
  };
  if (indexable && sheet.chords.length) {
    ld["@graph"].push({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: `คอร์ดเพลง ${name} มีคอร์ดอะไรบ้าง?`,
          acceptedAnswer: { "@type": "Answer", text: `เพลง ${name} ใช้คอร์ด ${sheet.chords.join(", ")}` },
        },
      ],
    });
  }

  const robots = indexable ? "" : '\n    <meta name="robots" content="noindex, follow" />';
  return (
    `<title>${esc(title)}</title>${robots}\n` +
    `    <meta name="description" content="${esc(desc)}" />\n` +
    `    <link rel="canonical" href="${esc(canonicalUrl)}" />\n` +
    `    <meta property="og:type" content="music.song" />\n` +
    `    <meta property="og:site_name" content="${SITE_NAME}" />\n` +
    `    <meta property="og:title" content="${esc(title)}" />\n` +
    `    <meta property="og:description" content="${esc(desc)}" />\n` +
    `    <meta property="og:url" content="${esc(canonicalUrl)}" />\n` +
    `    <meta property="og:image" content="${img}" />\n` +
    `    <meta property="og:locale" content="th_TH" />\n` +
    `    <meta name="twitter:card" content="summary" />\n` +
    `    <meta name="twitter:title" content="${esc(title)}" />\n` +
    `    <meta name="twitter:description" content="${esc(desc)}" />\n` +
    `    <meta name="twitter:image" content="${img}" />\n` +
    `    <script type="application/ld+json">${JSON.stringify(ld)}</script>`
  );
}

/** Build the crawlable <article> injected into the #root <!-- ssr --> marker. */
export function buildArticle(song, sheet, indexable) {
  const name = song.name;
  const metaBits = [];
  if (sheet.meta.key) metaBits.push(`คีย์ ${esc(sheet.meta.key)}`);
  if (sheet.chords.length) metaBits.push(`คอร์ดที่ใช้: ${esc(sheet.chords.join(" "))}`);
  const note = sheet.meta.note ? `<p class="ssr-note">${esc(sheet.meta.note)}</p>` : "";
  const body = indexable
    ? `<pre class="ssr-sheet">${esc(sheet.text)}</pre>`
    : `<p>เปิดแอปเพื่อดูคอร์ดเพลงนี้</p>`;
  // Inline styles so it reads fine before the app's CSS loads, and stays out of
  // the app's way (React replaces #root on mount). aria-hidden NOT set — this is
  // the real content for crawlers.
  return (
    `<article class="ssr" style="max-width:760px;margin:0 auto;padding:24px;color:#e8e8ea;font-family:'IBM Plex Sans Thai',system-ui,sans-serif">` +
    `<nav style="font-size:13px;color:#8a8a8f"><a href="/" style="color:#a78bfa;text-decoration:none">หน้าแรก</a> › คอร์ดเพลง</nav>` +
    `<h1 style="font-size:24px;margin:12px 0 4px">คอร์ดเพลง ${esc(name)}</h1>` +
    (metaBits.length ? `<p style="font-size:13px;color:#8a8a8f;margin:0 0 12px">${metaBits.join(" · ")}</p>` : "") +
    note +
    `<div style="font-size:14px;color:#b8b8bd;margin:8px 0 16px">เนื้อร้องพร้อมคอร์ดกีตาร์/อูคูเลเล่ เปลี่ยนคีย์ได้ในแอป เล่นพร้อมวงแบบเรียลไทม์</div>` +
    body +
    `</article>`
  );
}

function notFound() {
  return (
    `<!doctype html><html lang="th"><head><meta charset="utf-8">` +
    `<meta name="robots" content="noindex"><title>ไม่พบเพลง | ${SITE_NAME}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="font-family:system-ui;background:#08070d;color:#fff;text-align:center;padding:80px 20px">` +
    `<h1>ไม่พบเพลงนี้</h1><p><a href="/" style="color:#a78bfa">กลับหน้าแรก</a></p></body></html>`
  );
}

// ---- the request handler ----------------------------------------------------
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = url.origin;

  const m = url.pathname.match(/^\/song\/(\d+)(?:\/([^/]*))?\/?$/);
  if (!m) {
    return new Response(notFound(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const id = Number(m[1]);
  const reqSlug = m[2] ? decodeURIComponent(m[2]) : "";

  // Edge cache hit?
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  let songs;
  try {
    songs = await loadSongs(env, origin);
  } catch (err) {
    // If the payload can't be decoded, fall back to the SPA so the page still works.
    return env.ASSETS.fetch(new Request(`${origin}/index.html`));
  }

  const song = songs.get(id);
  if (!song) {
    return new Response(notFound(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Canonical-slug redirect (SEO dedup): /song/123/wrong → /song/123/<canonical>.
  const slug = slugify(song.name);
  if (reqSlug !== slug) {
    return Response.redirect(`${origin}/song/${id}/${encodeURIComponent(slug)}`, 301);
  }

  const indexable = Boolean(song.cp);
  const sheet = song.cp ? renderSheet(song.cp) : { text: "", meta: {}, chords: [] };
  const canonicalUrl = `https://chord.golfchairat.com/song/${id}/${encodeURIComponent(slug)}`;

  let html = await (await env.ASSETS.fetch(new Request(`${origin}/index.html`))).text();
  const head = buildHead(song, canonicalUrl, sheet, indexable);
  const article = buildArticle(song, sheet, indexable);
  // Function replacers so `$` in lyrics/chords isn't treated as a backreference.
  html = html.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/, () => head);
  html = html.replace("<!-- ssr -->", () => article);

  const resp = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Browser short, edge long. Indexable pages cache; thin ones too (cheap).
      "cache-control": "public, max-age=3600, s-maxage=86400",
      "x-robots-tag": indexable ? "all" : "noindex",
    },
  });
  context.waitUntil(cache.put(request, resp.clone()));
  return resp;
}
