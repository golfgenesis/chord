// Diagnostic: confirms Cloudflare Pages Functions are deploying at all.
// Hit /api/test in the browser. If you see "ok", Functions work.
// If you see the chord SPA, Cloudflare isn't deploying functions/.
export const onRequest = () =>
  new Response("ok\nfunctions are deploying", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
