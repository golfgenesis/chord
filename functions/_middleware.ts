// Reverse-proxy Firebase Auth's reserved URLs (/__/auth/* and
// /__/firebase/*) from this app's origin (chord.golfchairat.com) to the
// Firebase Hosting default origin (chord-1a556.firebaseapp.com).
//
// Why this exists:
//   Firebase's `authDomain` defaults to `<project>.firebaseapp.com`, which
//   is a DIFFERENT origin from our app domain. The signInWithRedirect
//   flow + Firebase's hidden state-sync iframe both end up reading/writing
//   storage on `<project>.firebaseapp.com`. Safari's Intelligent Tracking
//   Prevention treats that as a third-party tracker and partitions /
//   blocks the storage, so after a successful OAuth round-trip the parent
//   app can't see the new auth state — user appears signed out despite
//   completing the Google sign-in.
//
// The fix:
//   Make the reserved Firebase paths appear under our own origin so the
//   entire auth flow is first-party. We change the SDK config
//   `authDomain` to `chord.golfchairat.com`; Firebase then issues every
//   internal request against /__/auth/* on OUR domain; this proxy
//   forwards each one to the real Firebase Hosting endpoint. From
//   Safari's perspective every request and Set-Cookie is first-party,
//   ITP no longer interferes.
//
// Why `_middleware.ts`:
//   - Cloudflare Pages silently skips function files under directories
//     whose name starts with `_` (the natural path `functions/__/...`
//     is dropped). So we can't host the function directly at /__/*.
//   - `_middleware.ts` is the documented Cloudflare Pages pattern for
//     "run this code on every request" — it intercepts all routes at
//     and below its directory level. We dispatch on pathname inside:
//     requests under `/__/` get proxied; anything else defers via
//     `context.next()` (falls through to static assets and the SPA
//     fallback in `_redirects`).
//
// CRITICAL PAIRING — Service Worker denylist:
//   This proxy ONLY runs if the request actually reaches Cloudflare.
//   The PWA service worker at `src/sw.ts` registers a NavigationRoute
//   that, by default, serves cached `index.html` for every navigation
//   — which means it would short-circuit `/__/auth/handler` etc. before
//   Cloudflare ever sees them. The SW therefore lists `/__/*` and
//   `/api/*` in its `denylist`. If you change either side, change both.
//
// Why a Cloudflare Pages Function instead of just _redirects:
//   _redirects supports cross-origin destinations only as 301/302
//   redirects, which would visibly change the URL bar (defeating the
//   point — Safari would still see firebaseapp.com as third-party
//   for the auth handler page). Functions can issue an outbound
//   fetch() and stream the response back, keeping the URL on our origin.

interface Context {
  request: Request;
  next: () => Promise<Response>;
}

// Cloudflare Pages provides this type at deploy time; declared minimally
// here so the file type-checks without pulling in @cloudflare/workers-types.
type PagesFn = (context: Context) => Promise<Response> | Response;

const UPSTREAM_HOST = "chord-1a556.firebaseapp.com";

// Headers Cloudflare injects on incoming requests that the upstream doesn't
// need (and can confuse it). Strip before forwarding.
const HEADERS_TO_STRIP = [
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-ew-via",
  "cf-worker",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-real-ip",
];

export const onRequest: PagesFn = async (context) => {
  const url = new URL(context.request.url);

  // Only intercept Firebase Auth's reserved paths. Everything else flows
  // through normally (static assets first, then SPA fallback via
  // _redirects). context.next() is Cloudflare Pages' "continue down the
  // request pipeline" primitive.
  if (!url.pathname.startsWith("/__/")) {
    return context.next();
  }

  const targetUrl = `https://${UPSTREAM_HOST}${url.pathname}${url.search}`;

  // Clone headers, strip Cloudflare-injected ones, keep everything else
  // (Accept, User-Agent, Cookie, etc.) so the upstream sees a normal req.
  const fwdHeaders = new Headers(context.request.headers);
  for (const h of HEADERS_TO_STRIP) fwdHeaders.delete(h);

  const init: RequestInit = {
    method: context.request.method,
    headers: fwdHeaders,
    redirect: "manual",
  };
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    init.body = context.request.body;
  }

  const upstream = await fetch(targetUrl, init);

  // Rewrite Set-Cookie headers: Firebase sets cookies with
  // `Domain=chord-1a556.firebaseapp.com` (or no Domain attribute, which the
  // browser interprets as the response host). Either way, the browser would
  // REJECT a Set-Cookie that claims a domain different from the request's
  // host. Strip the Domain attribute so cookies default to chord.golfchairat.com.
  const respHeaders = new Headers(upstream.headers);
  const setCookies: string[] =
    typeof (upstream.headers as Headers & {
      getSetCookie?: () => string[];
    }).getSetCookie === "function"
      ? (upstream.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];
  if (setCookies.length > 0) {
    respHeaders.delete("Set-Cookie");
    for (const c of setCookies) {
      const cleaned = c.replace(/;\s*Domain=[^;]+/i, "");
      respHeaders.append("Set-Cookie", cleaned);
    }
  }

  // Rewrite init.json to advertise OUR domain as the authDomain. The
  // upstream's init.json hard-codes `authDomain: "chord-1a556.firebaseapp.com"`
  // (Firebase's default). The auth handler page running on
  // chord.golfchairat.com refuses to operate when the configured
  // authDomain doesn't match window.location.host — it bails to a
  // "stop" state before any OAuth round-trip starts. Patch the JSON so
  // the handler sees its own host listed as the authDomain.
  if (url.pathname === "/__/firebase/init.json") {
    try {
      const json = (await upstream.clone().json()) as Record<string, unknown>;
      json.authDomain = url.host;
      const body = JSON.stringify(json);
      respHeaders.set("content-type", "application/json; charset=utf-8");
      respHeaders.delete("content-length"); // body length changed
      respHeaders.delete("content-encoding"); // we re-emit uncompressed
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch {
      // Fall through to verbatim response if upstream isn't JSON for any reason.
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
};
