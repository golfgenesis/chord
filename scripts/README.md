# คู่มือคำสั่ง (npm scripts) — ภาษาไทย

อ้างอิงทุกคำสั่งใน `package.json` ว่าทำอะไร / ใช้ตอนไหน รันที่โฟลเดอร์ `f:\chord`
(รายละเอียดเชิงลึกของ ChordPro pipeline อยู่ที่ [CHORDPRO_PIPELINE.md](CHORDPRO_PIPELINE.md))

> **การส่ง argument ผ่าน npm ต้องมี `--` คั่น** เช่น `npm run chordpro:fix -- 19`
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
| `npm run data` | rebuild **`public/songs.bin`** อย่างเดียว (จาก `data/results.json` + `data/chordpro/*.txt`) |

---

## 2) ⭐ ดึงเพลงใหม่จากเว็บจริง → เข้าระบบเรา

เว็บต้นทาง `chordtabs.in.th` มีเพลงเพิ่มเรื่อยๆ — คำสั่งกลุ่มนี้ probe หา id ใหม่เอง
(เริ่มจาก id สูงสุดใน `results.json` + 1, หยุดเมื่อเจอ "ไม่มีรูป" ติดกัน 100 ครั้ง)

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run sync` | **เพลงใหม่ (เฉพาะรูป):** probe เว็บ → scrape หน้าใหม่ → โหลดรูป → แปลงเป็น WebP → อัป R2 → verify → rebuild `songs.bin` เพลงใหม่จะโผล่ในแอปเป็น**รูปภาพ**ทันที |
| `npm run sync:chordpro` | **⭐ เพลงใหม่ (รูป + ข้อความ ChordPro):** รัน `sync` (ไม่ build) แล้วต่อด้วย OCR แบบ parallel (`backfill`) เฉพาะเพลงที่ยังไม่มี ChordPro → rebuild นี่คือคำสั่ง "ดึงเพลงใหม่เข้าระบบให้ครบ" |
| `npm run sync:push` | เหมือน `sync` แล้ว `git add/commit/push public/songs.bin` (Cloudflare Pages redeploy ~60 วิ) |
| `npm run sync:dry` | พิมพ์ทุกคำสั่งของ pipeline ออกมาดูเฉยๆ ไม่รันจริง (ข้าม probe) |
| `npm run check` | cross-check `results.json` ↔ `images/` ↔ R2 bucket (รายงานกล่องสวยๆ) |
| `npm run check:clean` | ลบไฟล์ WebP กำพร้า ทั้ง local + R2 (ถามยืนยันก่อน) |

> **ลำดับที่แนะนำ:** ครั้งแรกรัน `chordpro:backfill` หนึ่งครั้ง (OCR ทั้งคลังให้ครบ) จากนั้น
> ใช้ `sync:chordpro` เป็นรอบๆ — มันจะ OCR เฉพาะ**เพลงใหม่**ที่ยังไม่มี ChordPro เท่านั้น
> (ถ้ายังไม่เคย backfill, `sync:chordpro` จะพยายาม OCR ทั้งคลัง = หลายวัน)
>
> ต้องมี: R2 creds ใน `.env.local`, `cwebp` ใน PATH (ดู [CHORDPRO_PIPELINE.md](CHORDPRO_PIPELINE.md) / `sync.py`)

---

## 3) ChordPro — แปลงรูปคอร์ด → ข้อความ (ให้แอป render เป็น text + เปลี่ยนคีย์ได้)

**สถาปัตยกรรม 2 ชั้น:** OCR (แพง ~50วิ/เพลง) เก็บผลดิบไว้ที่ `data/chordpro-raw/<id>.json`
ครั้งเดียว → จากนั้น `assemble` (ถูก, ระดับ ms) ประกอบเป็นข้อความ รันซ้ำได้เรื่อยๆ ด้วย `--regen`
**แก้กฎ 1 ที่ = regen ทั้ง 70k ได้ในไม่กี่นาที (ไม่ต้อง OCR ใหม่)**

| คำสั่ง | ทำอะไร | resume/หยุด |
|---|---|---|
| `npm run chordpro:backfill` | **⭐ OCR ทั้งคลังที่ยังไม่ทำ** แบบ parallel หลาย process + ETA สด แล้ว rebuild `songs.bin` | **กด Ctrl+C หยุดได้**, รันซ้ำ = ทำต่อ (ข้ามที่เสร็จแล้ว) |
| `npm run chordpro:check` | regen ทั้งหมดจาก cache + **flag เพลงที่น่าสงสัย** → `data/chordpro/_flagged.tsv` (ไม่ OCR ไม่ ship) | — |
| `npm run chordpro:fix -- 19` | **⭐ แก้รายเพลง:** regen เพลง 19 (ใส่ override) + rebuild `songs.bin` ในคำสั่งเดียว (ใส่หลาย id ได้ / ไม่ใส่ = ทั้งหมด) | instant |
| `npm run chordpro:build` | regen **ทั้งหมด**จาก cache + rebuild `songs.bin` (ใช้หลังแก้ **rule** ในโค้ด) | (70k ~1-2 ชม.) |
| `npm run chordpro:regen -- 19` | regen เพลง 19 อย่างเดียว **ไม่ build** (ดูข้อความเร็วๆ) ไม่ใส่ id = ทั้งหมด | instant |
| `npm run chordpro:next` | OCR เพลงถัดไป 50 เพลงที่ยังไม่มี ChordPro + build (รันซ้ำเพื่อไล่ไปเรื่อยๆ; ปรับ `-- --limit 100`) | resume |
| `npm run chordpro -- 48 100` | CLI ตรงๆ: OCR เฉพาะ id ที่ระบุ (หรือ `-- --range 1 200`) | — |

ตัวเลือก backfill: `-- --workers 4` (ลด process ถ้าโดน rate-limit), `-- --fast` (~2 เท่า แต่ recall ต่ำลง), `-- --limit 50` (ลองสั้นๆ)

---

## 4) Workflow ที่ใช้บ่อย

### A. ครั้งแรก — แปลงทั้งคลังเป็นข้อความ (รันทิ้งไว้ได้)
```powershell
npm run chordpro:backfill        # Ctrl+C หยุด, รันซ้ำทำต่อ; จบแล้ว rebuild ให้เอง
```

### B. มีเพลงใหม่บนเว็บ — ดึงเข้าระบบ
```powershell
npm run sync:chordpro            # probe เว็บ → scrape + รูป + R2 → OCR เฉพาะเพลงใหม่ → build
```

### C. เจอเพลงที่ render พัง — แก้
```powershell
npm run chordpro:check                       # 1. หา → _flagged.tsv (บอกเหตุผลแยกหมวด)
# เทียบข้อความกับรูปต้นฉบับที่ scripts\.chordpro_cache\<id>.png
# 2a. ถ้าเป็น "pattern" (พังหลายเพลงเหมือนกัน) → แก้กฎใน scripts\extract_chordpro.py แล้ว:
npm run chordpro:build
# 2b. ถ้าเป็นรายเพลง → เขียน data\chordpro-overrides\<id>.json แล้ว:
npm run chordpro:fix -- 19
# 3. ดูผล
npm run dev                                  # แล้ว Ctrl+Shift+R
```

**override (`data/chordpro-overrides/<id>.json`)** — แก้รายเพลงที่อยู่รอดทุกครั้งที่ regen:
```json
{ "replace": [ ["ข้อความผิด", "ข้อความถูก"] ], "rename": { "คอร์ดผิด": "คอร์ดถูก" },
  "title": "...", "note": "Tune down 1/2 tone to Eb" }
```

### D. deploy
```powershell
npm run build                    # หรือ build:full ถ้าข้อมูลเปลี่ยน
# push → Cloudflare Pages redeploy เอง  (หรือ npm run sync:push สำหรับเฉพาะ songs.bin)
```

---

## หมายเหตุสำคัญ

- **แก้ที่ต้นเหตุ ไม่ใช่รายเพลง:** OCR พังเป็น "แบบแผน" ซ้ำๆ ทั้ง 70k — แก้กฎ/detection ใน
  `extract_chordpro.py` แล้ว `--regen` ให้หายทั้งแบบแผน; `override` ไว้สำหรับเศษที่เหลือจริงๆ
- **`chordpro:check` แค่ flag ไม่ได้แก้** — มันบอกว่าเพลงไหน/หมวดไหนพัง (`instr leftover`,
  `N HTML line(s) not drawn in image`, `off-vocab`, ...) เพื่อให้รู้ว่าควร root-cause อะไร
- **GPU ใช้ไม่ได้บนเครื่องนี้** (AMD RX 6600 XT ไม่มี CUDA; EasyOCR LSTM รันบน DirectML ไม่ได้) → CPU only จึงต้อง backfill แบบ parallel
- **ปล่อย public ได้เลยระหว่าง backfill** — เพลงที่ยังไม่มี ChordPro แอป fallback เป็น**รูป**อัตโนมัติ
- **service worker cache `songs.bin` เก่า** — หลัง build/regen ต้อง **Ctrl+Shift+R** ถึงเห็นของใหม่
