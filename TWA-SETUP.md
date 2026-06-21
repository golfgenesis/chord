# TWA → Play Store setup (Chord)

ห่อ PWA (`chord.golfchairat.com`) เป็นแอป Android จริงด้วย **TWA (Trusted Web Activity)** แล้วขึ้น Google Play

> TWA = แอปที่รัน Chrome engine เต็มตัวแบบ fullscreen ไม่มี address bar (ไม่ใช่ WebView) — ผ่าน performance test ของ Play ได้ ใช้ service worker / offline cache / web notification ของ PWA เดิมทั้งหมด

---

## สิ่งที่อยู่ใน repo แล้ว (เตรียมไว้ให้)

| ไฟล์ | หน้าที่ |
|---|---|
| `twa/twa-manifest.json` | config ของ Bubblewrap (packageId, สี, ไอคอน, notifications) |
| `public/.well-known/assetlinks.json` | Digital Asset Links — ต้องเติม SHA-256 fingerprint แล้ว deploy |
| `public/icon-512.png`, `icon-maskable-512.png`, `icon-192.png` | ไอคอน PNG ที่ Play/Bubblewrap ต้องใช้ (สร้างจาก `icon-1024.png`) |
| web manifest (`vite.config.ts`) | เพิ่ม PNG icons + `id` แล้ว |
| `src/lib/platform.ts` | **แก้แล้ว**: `isInstalledPWA()` detect TWA (`android-app://` referrer) + fullscreen/minimal-ui → OAuth ใช้ `signInWithRedirect` (popup พังในแอป) |

---

## ขั้นตอน

### 0. เตรียมเครื่อง (ครั้งเดียว)
- **JDK 17** + **Android SDK** — Bubblewrap ลงให้อัตโนมัติครั้งแรกที่รัน (เก็บใน `~/.bubblewrap`) แค่กด yes
- บัญชี **Google Play Console** (จ่ายครั้งเดียว **$25**)
- ติดตั้ง CLI:
  ```bash
  npm i -g @bubblewrap/cli
  ```

### 1. Deploy เว็บก่อน (สำคัญ)
ต้องให้ `https://chord.golfchairat.com/manifest.webmanifest` และ `/icon-512.png` เข้าถึงได้จริงก่อน เพราะ Bubblewrap จะ fetch จาก URL จริง:
```bash
npm run build         # หรือ build:full
# deploy dist/ ขึ้น Cloudflare Pages ตามปกติ
```
เช็คว่า manifest มี PNG icon: เปิด `https://chord.golfchairat.com/manifest.webmanifest`

### 2. สร้างโปรเจกต์ Android + build .aab
รันใน `twa/` (หรือโฟลเดอร์ใหม่นอก repo ก็ได้):

```bash
cd twa
bubblewrap init --manifest https://chord.golfchairat.com/manifest.webmanifest
```
ตอบ prompt ให้ตรงกับ `twa-manifest.json` ที่เตรียมไว้:
- **Application ID / package**: `com.golfchairat.chord`
- **App name**: `Chord` · **Launcher name**: `Chord`
- **Display mode**: `fullscreen`
- **Status bar / nav color**: `#08070d`
- **Include support for notification delegation?** → **Yes** (แอปใช้ web notification เวลามีคนเลือกเพลงในห้อง)
- **Signing key**: ให้สร้างใหม่ → จำ password ไว้ (เก็บ `android.keystore` ให้ดี — หายแล้วอัปเดตแอปไม่ได้)

> ทางเลือก: ถ้าอยากใช้ค่าจาก `twa/twa-manifest.json` ตรงๆ ให้ copy ไฟล์นั้นเข้าโฟลเดอร์ build แล้วรัน `bubblewrap update` (gen โปรเจกต์จาก config) ตามด้วย `bubblewrap build`

จากนั้น:
```bash
bubblewrap build
```
ได้ไฟล์ **`app-release-signed.aab`** (ตัวที่อัปขึ้น Play) + `app-release-signed.apk` (ทดสอบบนเครื่อง)

### 3. เอา SHA-256 fingerprint ไปใส่ assetlinks.json
```bash
bubblewrap fingerprint list
# หรือ
keytool -list -v -keystore android.keystore -alias android
```

⚠️ **กับดักที่ทุกคนพลาด — Play App Signing:**
เมื่ออัป `.aab` ขึ้น Play, Google จะ **re-sign ด้วย key ของ Google เอง** ดังนั้น fingerprint ที่ผู้ใช้จริงเห็นคือ **Play App Signing key ไม่ใช่ upload key ของคุณ**

ต้องใส่ใน `public/.well-known/assetlinks.json` ทั้งสองตัว:
1. **Play App Signing key** SHA-256 — เอาจาก **Play Console → Test and release → Setup → App integrity → App signing key certificate** (มีหลัง upload ครั้งแรก) ← ตัวนี้ที่ทำให้ address bar หายในแอป production
2. **Upload key** SHA-256 — สำหรับทดสอบ .apk บนเครื่องก่อนขึ้น Play

แก้ `package_name` ให้ตรง (`com.golfchairat.chord`) แล้วแทน `REPLACE_WITH_...` ด้วย fingerprint จริง (รูปแบบ `AA:BB:CC:...`)

> Play Console มีปุ่มแสดง assetlinks.json สำเร็จรูปให้ copy ได้เลยที่หน้า App integrity

### 4. Deploy assetlinks.json
```bash
npm run build && deploy
```
ยืนยันว่าเข้าถึงได้: `https://chord.golfchairat.com/.well-known/assetlinks.json`
(Cloudflare Pages เสิร์ฟ `public/.well-known/` ที่ root อยู่แล้ว — ไม่มี `_redirects` มาบัง เพราะ `/*` rewrite เป็น 200 ไม่ใช่ catch ไฟล์จริง)

ตรวจ Digital Asset Links:
```
https://developers.google.com/digital-asset-links/tools/generator
```

### 5. อัปขึ้น Play Console
1. สร้างแอปใหม่ → ใส่ package `com.golfchairat.chord`
2. **Internal testing** → upload `app-release-signed.aab`
3. กรอก store listing (ชื่อ, คำอธิบาย, screenshot, ไอคอน 512 — ใช้ `icon-512.png` ได้), Privacy Policy URL, Data safety form
4. หลัง upload ครั้งแรก → ไปเอา Play App Signing SHA-256 (ขั้นที่ 3) → เติม assetlinks.json → redeploy
5. ติดตั้งจาก Internal testing track → **เช็คว่าไม่มี address bar** (ถ้ายังมีแถบ URL = assetlinks ยังไม่ผ่าน → ตรวจ fingerprint/package_name)

---

## เช็คลิสต์หลังติดตั้งแอป (สำคัญ)
- [ ] **ไม่มี address bar** (asset links ผ่าน) — ถ้ามี = fingerprint ผิด/ยังไม่ deploy
- [ ] **Login Google/Facebook ได้** — แก้ `isInstalledPWA()` ให้ TWA ใช้ redirect แล้ว แต่ต้องเช็ค Facebook **Valid OAuth Redirect URIs** ต้องมี `https://auth.chord.golfchairat.com/__/auth/handler` (มีอยู่แล้วตาม CLAUDE.md)
- [ ] **Notification เด้ง** เวลาเพื่อนเลือกเพลง (เปิด `enableNotifications: true` แล้ว — Android 13+ จะถาม permission ครั้งแรก)
- [ ] เปิดลิงก์ห้อง/เพลงจาก notification แล้ว deep-link ถูกหน้า
- [ ] Offline: เปิดเพลงที่ favorite/playlist ตอนไม่มีเน็ตได้

## อัปเดตแอปรอบถัดไป
แค่ deploy เว็บใหม่ = ผู้ใช้ได้ของใหม่ทันที (TWA โหลดเว็บสด) — **ไม่ต้อง rebuild .aab**
rebuild .aab เฉพาะตอนเปลี่ยน: ไอคอน, ชื่อ, สี, package, permission ใหม่ — ตอนนั้นต้องเพิ่ม `appVersionCode` ใน `twa-manifest.json` (+1) แล้ว `bubblewrap update && bubblewrap build`

## หมายเหตุ
- `display: fullscreen` = immersive ไม่มี status bar เหมาะกับการอ่านคอร์ด ถ้าอยากให้เห็น status bar เปลี่ยนเป็น `standalone` ใน `twa-manifest.json` (และ web manifest) แล้ว rebuild
- **การ "เชื่อมต่อ provider เพิ่ม" (link Google/Facebook) ในหน้า Profile ขณะอยู่ในแอป** ใช้ `linkWithRedirect` ซึ่งผลลัพธ์หลัง redirect ยังไม่ refresh รายการ provider ในหน้า Profile อัตโนมัติ (ผู้ใช้ต้องปิด-เปิดชีตใหม่) — เป็น known limitation ระดับ minor, ไม่กระทบ login หลัก
- เก็บ `android.keystore` + password ไว้ให้ดีมาก (เช่น password manager) — ถ้าหาย จะ sign อัปเดตด้วย key เดิมไม่ได้
