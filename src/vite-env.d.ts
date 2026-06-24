/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_IMAGE_BASE?: string;
  /** Base URL for ChordPro .md sheets; defaults to `${VITE_IMAGE_BASE}/md`. */
  readonly VITE_TEXT_BASE?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_DB_URL?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The `brotli` package ships no type declarations. We import only the
// decode-only entry point (keeps the compressor + its tables out of the
// bundle). songs.bin is XOR(brotli(JSON)) — see src/lib/songsCodec.ts and
// scripts/build-data.mjs.
declare module "brotli/decompress" {
  export default function decompress(
    buffer: Uint8Array,
    outputSize?: number,
  ): Uint8Array;
}
