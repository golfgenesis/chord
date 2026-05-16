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
// Why a Cloudflare Pages Function instead of _redirects:
//   _redirects only supports same-origin rewrites; cross-origin proxy
//   isn't allowed there. Pages Functions can issue an outbound fetch()
//   and stream the response back, which is what we need here.
//
// Path layout — Cloudflare Pages routes file `functions/__/[[catchall]].ts`
// to URL pattern `/__/*`, so this single function handles both
// `/__/auth/handler`, `/__/auth/iframe`, `/__/firebase/init.json`, etc.

interface Context {
  request: Request;
}

// Cloudflare Pages provides this type at deploy time; we declare a minimal
// local type so the file type-checks without pulling in @cloudflare/workers-types
// (avoids adding a dependency just for a single ambient declaration).
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

export const onRequest: PagesFn = async ({ request }) => {
  const url = new URL(request.url);
  const targetUrl = `https://${UPSTREAM_HOST}${url.pathname}${url.search}`;

  // Clone headers, strip Cloudflare-injected ones, keep everything else
  // (Accept, User-Agent, Cookie, etc.) so the upstream sees a normal req.
  const fwdHeaders = new Headers(request.headers);
  for (const h of HEADERS_TO_STRIP) fwdHeaders.delete(h);

  const init: RequestInit = {
    method: request.method,
    headers: fwdHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
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

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
};
