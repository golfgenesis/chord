// Cloudflare Pages Function: proxy R2 chord-image bucket at the SAME
// origin as the app.
//
// Why: when the browser fetches images from a different origin (e.g.
// r2-chord-images.golfchairat.com) the response is OPAQUE unless the
// origin returns `Access-Control-Allow-Origin`. R2's bucket-level CORS
// Policy doesn't apply through Cloudflare custom domains — so the only
// realistic ways to get CORS-clean responses are:
//
//   1. R2 Public Development URL (ugly URL, fine for dev)
//   2. Add CORS headers via Cloudflare Snippet at the custom domain
//   3. Serve images from the app's OWN origin so CORS doesn't apply  ← this file
//
// Option 3 is the cleanest in production: the app fetches /images/foo.png
// from its own origin, this function reads the corresponding object out
// of the bound R2 bucket, and the browser sees a same-origin response.
// No CORS, no opaque, no Chrome padding tax — viewing 70k songs offline
// uses ~3 GB instead of ~500 GB.
//
// Setup (one-time, in the Cloudflare Pages dashboard):
//   Settings → Functions → R2 bucket bindings
//   Variable name: IMAGES   Bucket: chord-images
//
// At build time set VITE_IMAGE_BASE to "" (or omit it) so the app uses
// the default relative "/images" path.

interface Env {
  IMAGES: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const segments = ctx.params.path;
  const key = Array.isArray(segments)
    ? segments.map(decodeURIComponent).join("/")
    : decodeURIComponent(segments ?? "");
  if (!key) return new Response("Bad request", { status: 400 });

  const object = await ctx.env.IMAGES.get(key);
  if (!object || !object.body) {
    return new Response("Not found", { status: 404 });
  }

  // R2 stores the Content-Type via httpMetadata when the uploader
  // (scripts/upload_r2.py) sets it; fall back to image/webp since that's
  // the only format we ship now.
  const contentType = object.httpMetadata?.contentType ?? "image/webp";

  // Aggressive immutable caching — chord sheets only change on rebuild,
  // and even then the URL stays the same (filename derives from song
  // name). The browser + SW handle invalidation.
  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": object.httpEtag,
    },
  });
};
