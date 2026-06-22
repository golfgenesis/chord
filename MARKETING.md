# MARKETING.md — going public + monetizing chord.golfchairat.com

The app was built as a **private tool** (noindex, `Disallow: /`, obfuscated payload).
This doc covers flipping it to a **public, search-indexed, monetized** site — modeled on
the owner's `tetono` project playbook, adapted for a 70k-song chord catalogue.

## 🚫 The one hard rule (read first)

> **NEVER touch the in-app song-viewing UI.** [src/components/Fullscreen.tsx](src/components/Fullscreen.tsx)
> and [src/components/ChordSheet.tsx](src/components/ChordSheet.tsx) stay **clean, exactly as they are** —
> no ads, no affiliate CTAs, no marketing widgets inside the chord view.
>
> All SEO/marketing/monetization is a **separate, additive layer**:
> - **SEO** = edge-rendered landing pages for crawlers (a different code path; see below).
> - **Money** (ads / affiliate) = only on **home / list / landing** surfaces, never the fullscreen sheet.
>
> The chord-viewing experience is the product. Keep it pristine.

## Architecture: why edge SSR, not 70k static files

Cloudflare Pages caps a deployment at **20,000 files (Free) / 100,000 (Paid)**. 70k static
HTML pages is impossible on Free and wasteful on Paid (minutes-long deploys, full rebuild on
any edit). Instead **one** Pages Function renders any song page on demand:

```
functions/song/[[path]].js     ← matches /song/* ONLY (1 file, not 70k)
```

Request flow for `/song/<id>/<slug>`:
1. Decode `songs.bin` once per isolate → `Map<id, {name, cp}>` (module-cached).
2. Wrong/missing slug → **301** to the canonical `/song/<id>/<slug>` (SEO dedup).
3. Fetch the real `index.html` via `env.ASSETS`, swap the `<!-- seo:start … seo:end -->`
   block for per-song `<title>`/description/canonical/OG + JSON-LD
   (`MusicComposition` + `BreadcrumbList` + `FAQPage`), and inject the rendered chord sheet
   into the `<!-- ssr -->` marker so **crawlers see real text without running JS**.
4. The SPA then boots normally; [src/store.ts](src/store.ts) recognizes `/song/<id>` and opens
   that song in the **existing** fullscreen view (it normalizes the URL to `/<room>/<id>`).
5. The response is **edge-cached** (`caches.default`, `s-maxage=86400`) so Googlebot crawling
   70k pages mostly hits cache; the payload decode happens only on a cold isolate.

Everything else — `/`, room URLs `/<6-digits>`, hashed assets, `songs.bin` — is served as a
normal static asset, **untouched**. Room codes are strictly 6 digits, so `/song/` can never collide.

> ⚠️ The 3 HTML markers (`seo:start`, `seo:end`, `ssr`) in [index.html](index.html) are load-bearing.
> Vite's build preserves them (verified). If you edit the head, keep the markers byte-exact.

### Indexable set grows with the backfill
Only songs **with `cp` (ChordPro text)** are put in the sitemap and rendered as `index` — they're
the pages with real content. Image-only songs are served `noindex` (thin). Today **33 / 70,126**
have text; every `npm run chordpro:backfill` batch adds more. Re-run `npm run sitemap` to grow
the indexed set. No code change needed — it reads `songs.bin`.

## Commands (new)

```powershell
npm run data          # rebuild public/songs.bin from data/results.json (existing)
npm run sitemap       # ⭐ regenerate public/sitemap.xml + public/sitemaps/*.xml from songs.bin
                      #    RUN AFTER `npm run data`, BEFORE deploy. Only cp-songs are listed.
npm run seo:indexnow                       # ping Bing/Yandex/Naver/Seznam with EVERY sitemap URL
npm run seo:indexnow -- <url> [<url>…]     # ping just freshly-published pages (recommended)
npm run seo:social -- <url> "<title>" ["<summary>"]   # post a link to Telegram/FB/LINE/X
```

Deploy sequence when songs change: `npm run data` → `npm run sitemap` → `npm run build` →
deploy → `npm run seo:indexnow` (or ping only the new song URLs).

## ✅ Done — Phase 0 (public) + Phase 1 (SEO infra)
- [x] **Flipped public:** removed `noindex/nofollow`, real `<title>`/description/canonical/OG/Twitter
      + `WebSite`+`Organization` JSON-LD (with `SearchAction`) in [index.html](index.html);
      `referrer` → `strict-origin-when-cross-origin` (analytics/affiliate attribution).
- [x] **robots.txt** allows all + points to the sitemap.
- [x] **Edge SSR** per-song pages — [functions/song/[[path]].js](functions/song/%5B%5Bpath%5D%5D.js)
      (+ internal "คอร์ดเพลงอื่น ๆ" links per page: shared-word relevance then neighbour-wrap fill, so
      crawlers walk song→song and every indexable page is reachable — adds crawl depth + on-page content).
- [x] **Sitemap** index + chunked song sitemaps — [scripts/build-sitemap.mjs](scripts/build-sitemap.mjs).
- [x] **IndexNow** + **social-post** ops scripts (ported from tetono) +
      IndexNow key file `public/a3f8c1e94b7d2056e8f1a9c3d6b40572.txt`.
- [x] **store.ts** recognizes `/song/<id>` landings (additive; rooms + fullscreen UI unchanged).
- [x] Verified: `tsc -b` clean, smoke-tested render on real data, Vite build preserves markers.
- [x] **Google Analytics 4** (`G-4L5B190T45`) via [src/lib/analytics.ts](src/lib/analytics.ts) — **lazy**
      (requestIdleCallback, no first-paint cost), id fixed, **no-op in dev**, called from
      [src/main.tsx](src/main.tsx). NOT in `index.html` (deferred so it never competes with first paint).

## ⏭️ Phase 2 — Monetization (NOT on the chord view)
Owner chose **all three**. Build order = lowest-risk first:
1. **Affiliate — music gear (best fit, low risk). ✅ STARTED.** Registry
    [src/lib/affiliates.ts](src/lib/affiliates.ts) (capo / tuner / picks / guitar / ukulele / strings /
    stand) + a dismissible, `rel="sponsored"`-labelled CTA [src/components/GearCTA.tsx](src/components/GearCTA.tsx)
    rendered as the **song-list footer only** (out of the way on the 70k list; shown after the last
    song on short favorites/search/playlist lists — never the chord view). Links are marketplace
    SEARCH urls now (earn ฿0); **paste Involve Asia / AccessTrade / Shopee-Lazada tracking deep-links**
    into `shopee`/`lazada` per product to start earning. *Placement is intentionally conservative —
    tell me if you want it more/less prominent.*
2. **Premium / remove-ads. ✅ BUILT — 🙈 HIDDEN FOR NOW.** Entitlement [src/lib/premium.ts](src/lib/premium.ts)
    (`usePremium()`) still gates the gear CTA + AdSense unit (premium = ad-free), but the **upsell entry
    point is removed**: the "Premium · ตัดโฆษณา" menu row + `<PremiumSheet>` render were taken out of
    [ProfileButton.tsx](src/components/ProfileButton.tsx). The sheet [src/components/PremiumSheet.tsx](src/components/PremiumSheet.tsx)
    is kept (orphaned) for later. **Re-enable:** re-add the MenuRow + `showPremium` state + `<PremiumSheet>`
    in ProfileButton. ⏳ Still **no payment processor** — wire **Omise** (Thai, %-per-sale) + sync the flag
    via the signed-in cloud doc when you turn it back on.
3. **Google AdSense. ✅ SCAFFOLDED (dormant).** Loader [src/lib/ads.ts](src/lib/ads.ts) +
    [src/components/AdUnit.tsx](src/components/AdUnit.tsx), placed in the list footer. Renders NOTHING
    until you set `ADSENSE_CLIENT` (after approval) — and is additionally gated on consent + non-premium.
    **Never** in the chord view. ⚠️ **Copyright risk:** chord/lyrics are derivative works scraped from
    chordtabs.in.th; AdSense may disapprove or DMCA may hit. Apply only after legal pages exist
    (About/Privacy/Contact); treat affiliate + premium as the primary revenue.

### PDPA consent — ✅ BUILT, 🙈 HIDDEN FOR NOW
Cookie-consent banner [src/components/ConsentBanner.tsx](src/components/ConsentBanner.tsx) +
[src/lib/consent.ts](src/lib/consent.ts) exist but are **not rendered** — `<ConsentBanner>` was removed
from [App.tsx](src/App.tsx), and GA's Consent Mode `default` block was removed from
[analytics.ts](src/lib/analytics.ts), so **GA currently collects normally (no banner)**.
**Re-enable for PDPA / before AdSense goes live:** render `<ConsentBanner />` in App.tsx again + restore
the `gtag("consent","default", … denied …)` block in analytics.ts (read `getStoredConsent()`).

## ⏭️ Phase 3 — Drive traffic (off-page, owner tasks)
SEO takes 3–6 months; do these in order (same playbook as tetono `SEO.md`):
1. **Google Search Console** — verify domain, submit `https://chord.golfchairat.com/sitemap.xml`,
    Request-Index the top songs. Add **Bing Webmaster** too.
2. **IndexNow** after each backfill batch: `npm run seo:indexnow -- <new song urls>`.
3. **Keyword reality check** before chasing a term: if Google page 1 is all Sanook/Chordtabs/big
    sites → skip; target long-tail ("คอร์ดเพลง <ชื่อเพลงเฉพาะ>") where small blogs rank.
4. **Social** — set Telegram (easiest) / FB Page / LINE OA tokens, then `npm run seo:social` a
    "song of the day" or new-feature link. Real readers + fresh links for crawlers. Never fake traffic.
5. **Backlinks** — answer real Pantip/FB-group threads with a genuinely helpful song link (no spam).
6. **Measure** in GSC: push keywords ranking 5–15 to top-3 (add content + internal links).

## Setup TODO (owner, needs accounts/secrets)
- [ ] Confirm **Cloudflare Pages Functions** is enabled for this project (it is by presence of `/functions`).
- [ ] After first deploy, verify `https://chord.golfchairat.com/song/1/...` renders SSR HTML
      (curl with no JS) and `/sitemap.xml` is reachable, THEN submit it to GSC.
- [ ] Proper **1200×630 OG image** (currently `og:image` = `/icon-512.png` stopgap).
- [ ] Social tokens in env (Telegram/FB/LINE/X) for `seo:social` — see [scripts/social-post.mjs](scripts/social-post.mjs).
- [ ] **Affiliate signup** (Shopee/Lazada via Involve Asia/AccessTrade) → paste tracking deep-links into [src/lib/affiliates.ts](src/lib/affiliates.ts).
- [ ] **AdSense**: apply → set `ADSENSE_CLIENT` in [src/lib/ads.ts](src/lib/ads.ts) + add the matching `public/ads.txt` line.
- [ ] **Privacy Policy / About / Contact** pages (required for AdSense; good for trust + PDPA).
- [ ] **Payment** for Premium (Omise) + sync the `premium` flag via the signed-in cloud doc.
- [ ] GA is live now (`G-4L5B190T45`, [src/lib/analytics.ts](src/lib/analytics.ts)) — add the property to GA dashboard, enable Enhanced Measurement.
