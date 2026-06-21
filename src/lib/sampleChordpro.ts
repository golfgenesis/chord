// Demo fixture — hand-authored ChordPro for a single song so the text
// renderer can be exercised inside the real app before the offline
// extraction pipeline (vision model → ChordPro) backfills the catalogue.
//
// Every song id that ISN'T in this map returns null, so the image + OCR
// path is byte-for-byte unchanged for the other 70k songs. Once the
// pipeline lands, this lookup gets replaced by a `chordpro` field on the
// Song payload (or a sidecar fetch) and this file goes away.
//
// Source: "อย่าเสียดาย — มาลีวัลย์ เจมีน่า" (id 11). Chords are written in
// C major (the printed key); the {note} preserves the sheet's tuning hint.
// Chord anchoring is a careful hand transcription of the printed positions —
// the offline vision pass is what will lock per-syllable placement exactly.
// Intro / Instru rows keep every "/" verbatim as printed.

const SHEETS: Record<number, string> = {
  11: `{title: อย่าเสียดาย}
{artist: มาลีวัลย์ เจมีน่า}
{key: C}
{note: Tune Down ½ tone to Eb}

Intro / [C] / [G] / [C] / [G] / ( 2 Times )

* ออกจากชีวิต[C]ฉัน[G]ไปได้ไหม อย่าอยู่อย่า[Am]เสียเวลากับฉันได้ไหม
[E]มีคนที่[F]เขายัง[C]ดี[G/B]กว่า[Am]ฉัน[F]มากมาย [G]เธอควรได้ใช้[C]ชีวิต[G]ดีๆ

ปิดฉากความ[C]รัก[G]ของเราได้ไหม คงยังไม่[Am]สายถ้ามันจบนับแต่นี้
[E]ควรลืม[F]ความฝัน[C]ลืม[G/B]คน[Am]อย่างฉัน[F]เสียที   [G]ลืมคนๆนี้แล้ว[C]ไปตามทาง

** ออกไปมอง[F]ฟ้า[G]ที่[Am]มัน[G/B]สด[C]ใส ให้ตาของเธอสว่าง [F]ให้[G]โอกาส[Am]หัวใจ[G/B]เธอสัก[C]ครั้ง เพื่อพบทางที่ดีกว่า
[F]สิ่งที่[G]เลว[Am]ร้าย[G/B]ทิ้ง[C]ไว้กับฉัน [G/B]ให้ฉันได้รับ [Am]รู้  [G]มัน  [F]แต่เพียงผู้เดียว
[C]อย่ามามัวเสียดายเลยอดีต [G]ที่มันไม่ได้อะไร [C]อย่ามามัวหวังลมๆกับสิ่ง ที่เคยฝังใจ
[F]ไม่ใช่[Em]ไม่รัก[Dm]หรือไม่[Fm]ต้องการ[C]แค่หวังให้เธอ [G]ไปเจอสิ่งที่ดีๆ สิ่งที่สวยงาม [C]เจอคนที่เขาดีๆ  [G]

Instru / [C] / [G] / [C] / [G] /

( ** )

[C]ไปเจอ[G]สิ่งที่ดีๆ   [C]ไปเจอ[G]สิ่งที่[C]ดีๆ`,
};

/** Returns the ChordPro source for a song, or null to use the image flow. */
export function getSampleChordpro(songId: number): string | null {
  return SHEETS[songId] ?? null;
}
