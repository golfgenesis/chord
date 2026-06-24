# คู่มือคำสั่ง (npm scripts) — ภาษาไทย

อ้างอิงทุกคำสั่งใน `package.json` ว่าทำอะไร / ใช้ตอนไหน รันที่โฟลเดอร์ `f:\chord`
(รายละเอียดสถาปัตยกรรม ChordPro pipeline อยู่ในหัวข้อ *ChordPro text pipeline* ของ [CLAUDE.md](../CLAUDE.md))

> **การส่ง argument ผ่าน npm ต้องมี `--` คั่น** เช่น `npm run chordpro:backfill -- --limit 50`
> (ทุกอย่างหลัง `--` จะถูกต่อท้ายคำสั่งจริง)

---

## 1) รัน / บิลด์แอป

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | บิลด์ `songs.bin` แล้วเปิด Vite dev server ที่ `:5173` (service worker เปิดอยู่ — แก้แล้วกด **Ctrl+Shift+R**) |
| `npm run build` | `tsc -b` + `vite build` → `dist/` (ของจริงสำหรับ deploy) |
| `npm run build:full` | rebuild `songs.bin` ก่อน แล้วค่อย build (ใช้เมื่อข้อมูลเพลงเปลี่ยน) |
| `npm run preview` | เสิร์ฟ `dist/` ไว้ลองของจริงก่อน deploy |
| `npm run lint` | eslint ทั้งโปรเจค |
| `npm run data` | rebuild **`public/songs.bin`** อย่างเดียว (จาก `data/results.json` + สแกน `data/songs-md/` เพื่อใส่ flag `t`) |

> `songs.bin` มีแค่ `{id, name}` (+ `t:1` ถ้าเพลงนั้นมีแผ่นคอร์ดข้อความ) — **ตัวข้อความ ChordPro ไม่ได้ถูกฝังใน `songs.bin`** เพื่อให้เล็กไว้ค้นหาเร็ว; ข้อความอยู่บน R2 ดึงตอนเปิดเพลง

---

## 2) ⭐ ดึงเพลงใหม่จากเว็บจริง → เข้าระบบเรา (รูปภาพ)

เว็บต้นทาง `chordtabs.in.th` มีเพลงเพิ่มเรื่อยๆ — คำสั่งกลุ่มนี้ probe หา id ใหม่เอง
(เริ่มจาก id สูงสุดใน `results.json` + 1, หยุดเมื่อเจอ "ไม่มีรูป" ติดกันหลายครั้ง)

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run sync` | probe เว็บ → scrape หน้าใหม่ → โหลดรูป → แปลงเป็น WebP → อัป R2 → verify → rebuild `songs.bin` เพลงใหม่จะโผล่ในแอปเป็น**รูปภาพ**ทันที |
| `npm run sync:push` | เหมือน `sync` แล้ว `git add/commit/push public/songs.bin` (Cloudflare Pages redeploy ~60 วิ) |
| `npm run sync:dry` | พิมพ์ทุกคำสั่งของ pipeline ออกมาดูเฉยๆ ไม่รันจริง (ข้าม probe) |
| `npm run check` | cross-check `results.json` ↔ `images/` ↔ R2 bucket (รายงานกล่องสวยๆ) |
| `npm run check:clean` | ลบไฟล์ WebP กำพร้า ทั้ง local + R2 (ถามยืนยันก่อน) |

> ต้องมี: R2 creds ใน `.env.local`, `cwebp` ใน PATH

---

## 3) ChordPro — แปลงรูปคอร์ด → ข้อความ (ให้แอป render เป็น text + เปลี่ยนคีย์ได้)

ใช้ **Gemini 2.5 Flash** (ผ่าน `@google/genai`) อ่านรูปแผ่นคอร์ด → เขียนเป็น **Inline ChordPro**
เก็บไว้ที่ `data/songs-md/<id>.md` → อัปขึ้น **R2** (`md/<id>.md`) → แอปดึงตอนเปิดเพลง
(service worker cache แบบ stale-while-revalidate → เปิดเร็ว + ใช้ออฟไลน์ได้)
**ไม่ฝังข้อความใน `songs.bin`** — เก็บแค่ flag `t:1` ว่าเพลงนั้นมีแผ่นคอร์ด

ต้องมี key ฟรีจาก <https://aistudio.google.com/apikey> ใส่ใน `.env.local`: `GEMINI_API_KEY=...`

| คำสั่ง | ทำอะไร | resume/หยุด |
|---|---|---|
| `npm run chordpro:backfill` | **⭐ extract เพลงที่ยังไม่มี** → `data/songs-md/<id>.md` (เว้น 4 วิ/รูป ให้พ้น free-tier limit) | **กด Ctrl+C หยุดได้**, รันซ้ำ = ทำต่อ (ข้ามไฟล์ที่มีแล้ว) |
| `npm run chordpro:upload` | อัป `data/songs-md/*.md` → R2 `md/<id>.md` (resumable) | — |
| `npm run chordpro:ship` | backfill → `data` (rebuild `songs.bin` + flag) → upload ในคำสั่งเดียว | resume |

ตัวเลือก backfill (ใส่หลัง `--`):
`--limit 50` (ลองสั้นๆ) · `--start 70570` (เฉพาะ id ตั้งแต่นี้ขึ้นไป) · `--ids 11,19,42` (เฉพาะ id ที่ระบุ) · `--force` (ทำใหม่แม้มีไฟล์แล้ว) · `--delay 6000` (ช้าลง, ปลอดภัยขึ้น) · `--model <name>` (เปลี่ยนรุ่น)

---

## 4) Workflow ที่ใช้บ่อย

### A. ครั้งแรก — แปลงทั้งคลังเป็นข้อความ (รันทิ้งไว้ได้ ~หลายชั่วโมง)
```powershell
npm run chordpro:backfill        # Ctrl+C หยุด, รันซ้ำทำต่อ
npm run data                     # rebuild songs.bin (ใส่ flag t ให้เพลงที่มีข้อความ)
npm run chordpro:upload          # อัปข้อความขึ้น R2
```

### B. มีเพลงใหม่บนเว็บ — ดึงเข้าระบบ
```powershell
npm run sync                     # รูปภาพ + songs.bin
npm run chordpro:ship            # extract ข้อความเฉพาะเพลงใหม่ → build → อัป R2
```

### C. เจอเพลงที่ข้อความเพี้ยน — แก้รายเพลง
```powershell
# อ่านรูปผิด → ดึงใหม่เพลงเดียว
node scripts/gemini-backfill.mjs --ids 19 --force
npm run chordpro:upload
npm run data
npm run dev                      # แล้ว Ctrl+Shift+R
```
> ถ้าพังเป็น "แบบแผน" หลายเพลงเหมือนกัน → ปรับ **prompt** ใน `scripts/gemini-backfill.mjs` แล้ว `--force` ใหม่ทั้งกลุ่ม

### D. deploy
```powershell
npm run build                    # หรือ build:full ถ้าข้อมูลเปลี่ยน
# push → Cloudflare Pages redeploy เอง  (หรือ npm run sync:push สำหรับเฉพาะ songs.bin)
```

---

## หมายเหตุสำคัญ

- **ปล่อย public ได้เลยระหว่าง backfill** — เพลงที่ยังไม่มีข้อความ แอป fallback เป็น**รูป**อัตโนมัติ
- **`data/songs-md/` ถูก gitignore** (เหมือน `images/`) — แจกผ่าน R2; ที่ commit คือ `songs.bin` ที่ฝัง flag `t` ไว้
- **service worker cache `songs.bin`/`.md` เก่า** — หลัง build/upload ต้อง **Ctrl+Shift+R** ถึงเห็นของใหม่
- **เปลี่ยนคีย์ (transpose)** ทำฝั่ง client ด้วยทฤษฎีดนตรีจากข้อความ ChordPro — ไม่มี OCR ในเบราว์เซอร์อีกต่อไป
