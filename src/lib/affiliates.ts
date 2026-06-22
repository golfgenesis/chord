// Music-gear affiliate registry (Phase 2 monetization).
//
// Audience fit: people viewing guitar/ukulele chords are a natural market for
// gear (capo, tuner, picks, strings, instruments). This is the LOW-RISK revenue
// stream — unlike AdSense it doesn't put display ads over copyrighted lyrics.
//
// Each product builds a MARKETPLACE SEARCH link by default (works today, earns
// nothing). To start earning, paste a TRACKING DEEP-LINK (Involve Asia /
// AccessTrade / Shopee or Lazada affiliate) into `shopee` / `lazada` for that
// product — generate it ONCE, the app reuses it. Mirrors the tetono project's
// src/lib/affiliates.ts pattern.
//
// ⚠️ Per the project rule (MARKETING.md): these CTAs render ONLY on browse
// surfaces (the song list), NEVER inside the fullscreen chord view.

export interface GearProduct {
  key: string;
  /** Thai display name shown in the card. */
  name: string;
  /** Short benefit line. */
  blurb: string;
  /** Marketplace search keyword (used until a tracking deep-link is set). */
  keyword: string;
  emoji: string;
  /** Tracking deep-link — paste to earn; falls back to a search link. */
  shopee?: string;
  lazada?: string;
}

const shopeeSearch = (kw: string) =>
  `https://shopee.co.th/search?keyword=${encodeURIComponent(kw)}`;
const lazadaSearch = (kw: string) =>
  `https://www.lazada.co.th/catalog/?q=${encodeURIComponent(kw)}`;

export const GEAR: GearProduct[] = [
  { key: "capo", name: "คาโป้ (Capo)", blurb: "เปลี่ยนคีย์เพลงง่าย ๆ ไม่ต้องจับคอร์ดทาบ", keyword: "capo คาโป้ กีตาร์", emoji: "🎸" },
  { key: "tuner", name: "เครื่องตั้งสาย (Tuner)", blurb: "ตั้งสายแม่นยำ เสียงเพราะทุกครั้งที่เล่น", keyword: "เครื่องตั้งสายกีตาร์ clip tuner", emoji: "🎵" },
  { key: "picks", name: "ปิ๊กกีตาร์", blurb: "ปิ๊กดี ดีดลื่น คุมเสียงได้ดีขึ้น", keyword: "ปิ๊กกีตาร์ pick", emoji: "🔺" },
  { key: "acoustic", name: "กีตาร์โปร่ง", blurb: "เริ่มต้นเล่นคอร์ดได้เลย รุ่นยอดนิยม", keyword: "กีตาร์โปร่ง acoustic guitar", emoji: "🎸" },
  { key: "ukulele", name: "อูคูเลเล่", blurb: "ตัวเล็ก เล่นง่าย พกพาสะดวก", keyword: "อูคูเลเล่ ukulele", emoji: "🪕" },
  { key: "strings", name: "สายกีตาร์", blurb: "เปลี่ยนสายใหม่ เสียงสดใสขึ้นทันที", keyword: "สายกีตาร์โปร่ง guitar strings", emoji: "🎶" },
  { key: "capodi", name: "ขาตั้งโน้ต/ที่วางมือถือ", blurb: "วางจอดูคอร์ดสบายตา เล่นได้ยาว ๆ", keyword: "ขาตั้งโน้ตเพลง music stand", emoji: "🎼" },
];

export function shopeeUrl(p: GearProduct): string {
  return p.shopee ?? shopeeSearch(p.keyword);
}
export function lazadaUrl(p: GearProduct): string {
  return p.lazada ?? lazadaSearch(p.keyword);
}
