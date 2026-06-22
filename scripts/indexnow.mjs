// IndexNow ping — tells Bing / Yandex / Naver / Seznam / Yep to (re)crawl URLs
// instantly (white-hat, free, no account). One POST notifies every participating
// engine. Google does NOT use IndexNow for indexing decisions yet — for Google
// the levers stay: fresh sitemap + quality content + backlinks + Search Console.
//
// The key is a public token hosted at https://chord.golfchairat.com/<key>.txt
// (in /public), proving we own the domain we're pinging for. Keep KEY below in
// sync with that filename.
//
// Usage:
//   node scripts/indexnow.mjs                 → submit EVERY URL in the live sitemap
//   node scripts/indexnow.mjs <url> [<url>…]  → submit only those URLs (recommended
//                                               after publishing — ping just the new
//                                               page, e.g. a freshly-extracted song)
//
// Best-effort: never throws non-zero so it can't break a build/commit step.
//
// Ported from the tetono project.

import { SITE_URL } from "./_site.mjs";

const KEY = "a3f8c1e94b7d2056e8f1a9c3d6b40572";
const HOST = new URL(SITE_URL).host; // chord.golfchairat.com
const KEY_LOCATION = `${SITE_URL}/${KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/indexnow";

/** Pull every <loc> out of the live sitemap (sitemap index → child sitemaps). */
async function urlsFromSitemap() {
  const seen = new Set();
  async function collect(url) {
    const res = await fetch(url, {
      headers: { "user-agent": "ChordIndexNow/1.0 (+https://chord.golfchairat.com)" },
    });
    if (!res.ok) throw new Error(`sitemap fetch failed: HTTP ${res.status} (${url})`);
    const xml = await res.text();
    // A sitemap index lists <sitemap><loc>…</loc>; a urlset lists <url><loc>…</loc>.
    const isIndex = /<sitemapindex[\s>]/.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    if (isIndex) {
      for (const child of locs) await collect(child);
    } else {
      for (const u of locs) seen.add(u);
    }
  }
  await collect(`${SITE_URL}/sitemap.xml`);
  // Keep only our host (IndexNow rejects mixed hosts).
  return [...seen].filter((u) => {
    try {
      return new URL(u).host === HOST;
    } catch {
      return false;
    }
  });
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);

  let urlList;
  if (args.length) {
    urlList = args.filter((u) => {
      try {
        if (new URL(u).host === HOST) return true;
        console.warn(`indexnow: skipping off-host URL ${u}`);
        return false;
      } catch {
        console.warn(`indexnow: skipping invalid URL ${u}`);
        return false;
      }
    });
  } else {
    console.log("indexnow: no URLs passed — reading the live sitemap…");
    urlList = await urlsFromSitemap();
  }

  if (!urlList.length) {
    console.log("indexnow: nothing to submit.");
    return;
  }

  // IndexNow accepts up to 10,000 URLs per request — chunk to stay safe.
  for (let i = 0; i < urlList.length; i += 10000) {
    const chunk = urlList.slice(i, i + 10000);
    const body = { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: chunk };
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`indexnow: submitted ${chunk.length} URL(s) → HTTP ${res.status}`);
    } else {
      const text = await res.text().catch(() => "");
      console.warn(`indexnow: endpoint returned HTTP ${res.status} ${text}`.trim());
    }
  }
}

main().catch((err) => {
  // Best-effort only — log and exit 0 so a build/commit pipeline isn't blocked.
  console.warn("indexnow: skipped —", err.message);
});
