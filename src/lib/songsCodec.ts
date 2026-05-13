// Client-side decoder for the obfuscated songs payload (public/songs.bin).
//
// The wire format is:  XOR(gzip(JSON), KEY)
//
// This is OBFUSCATION, not encryption — the key sits in the bundled JS and
// anyone reading the source can derive it. The goal is just to stop the
// trivial `curl chord.you.com/songs.bin | jq` and casual scrapers. For real
// protection, layer on a Cloudflare Worker that checks Referer/Origin.
//
// The same XOR_KEY_HEX must live in scripts/build-data.mjs — if you change
// one, change both, otherwise existing clients won't be able to decode the
// new bundle until they hard-refresh.
import type { Song } from "../types";

const XOR_KEY_HEX =
  "9c4f1d6a3e80b5b27cdb1f24a8e6b35a2710f87c4d65e3b9af8c01d72e64b395";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const KEY = hexToBytes(XOR_KEY_HEX);

function xorInPlace(bytes: Uint8Array): Uint8Array {
  const k = KEY;
  const klen = k.length;
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= k[i % klen];
  return bytes;
}

export async function decodeSongs(buf: ArrayBuffer): Promise<Song[]> {
  const xored = xorInPlace(new Uint8Array(buf));
  // Feed the decompression stream directly — avoids Blob, which under
  // strict TS lib types refuses Uint8Array<ArrayBufferLike>.
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  // TS lib types insist on Uint8Array<ArrayBuffer>; the cast is safe because
  // we constructed `xored` from a fresh ArrayBuffer above.
  writer.write(xored as unknown as BufferSource);
  writer.close();
  const text = await new Response(ds.readable).text();
  return JSON.parse(text) as Song[];
}
