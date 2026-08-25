# สัญญาความตรงกับ Design — TCL v4.0

> **ไฟล์ต้นแบบ (authoritative):** `Mobile Stock Check System/Stock Scan Mobile.dc.html`
> เอกสารนี้คือ "fidelity contract" — ทุกค่าที่ระบุที่นี่ **ต้อง** ตรงกับที่ implement ใน Flutter
> v1–v3 และโฟลเดอร์ `_ds/` (Industry design system สีอ่อน) เป็น **historical เท่านั้น** — ห้ามนำ visual มาใช้

---

## 1. Design Tokens

รวบเป็น Dart class เดียว: `TclTokens` (ThemeExtension) — **ห้าม widget ใดฮาร์ดโค้ดสี/รัศมี/เงา**

### 1.1 สีพื้นและพื้นผิว

| Token | ค่า | ใช้ที่ |
|---|---|---|
| `screenBg` | `linear-gradient(#22303F → #18232F @42%)` | พื้นหลังจอทั้งแอป |
| `cameraViewportBg` | `#121C27` | กรอบกล้อง |
| `scanCardBg` | `linear-gradient(#2A3846 → #1E2A36)` | การ์ดผลสแกน |
| `listCardBg` | `linear-gradient(#2A3846 → #212D3A)` | การ์ดค้นหา / นับ / สมาชิก |
| `sheetBg` | `linear-gradient(#28374A → #1E2A36)` | bottom sheet เพิ่มสมาชิก |
| `toastBg` | `rgba(34,48,63,.96)` | toast |
| `scrim` | `rgba(10,17,25,.62)` | ฉากหลัง sheet |
| `camPillBg` | `rgba(12,20,29,.55)` | ป้ายสถานะกล้อง + FAB บนกล้อง |

**Surface overlays (ขาวโปร่ง):** `.07` ปุ่มรอง/keypad · `.075` การ์ด login/stat tiles · `.085` input/chip · `.09` แถบแท็บ · `.10` ช่องกรอกนับ/pill กลาง · `.11` แทร็ก progress
**Border (ขาวโปร่ง):** `.10 / .11 / .13 / .15 / .16 / .18 / .20 / .26` ตามตำแหน่งใน token sheet — border error ของช่อง PIN: `rgba(255,131,119,.7)`

### 1.2 Text ramp

| Token | ค่า | ใช้ที่ |
|---|---|---|
| `brightest` | `#FBFDFF` | หัวเรื่อง, ชื่อสินค้า, ตัวอักษรใน input |
| `body` | `#F3F7FB` | ตัวเนื้อความ, ปุ่มบนพื้นเข้ม |
| `soft` | `#DCE6F0` | ค่ารอง, นาฬิกา |
| `softAlt` | `#E6EEF6` | สถานะกล้อง, ค่าใน spec rows |
| `muted` | `#A4B2C0` | label, kicker, แท็บ inactive |
| `faint` | `#8492A0` | hint, meta, placeholder |
| `onAccent` | `#07121B` | ตัวอักษรบนปุ่ม gradient และแท็บ active |

### 1.3 Accent และสถานะ

| Token | ค่า |
|---|---|
| `accent` | `#84BAF3` — ลิงก์, ไอคอน, บรรทัด SKU, PIN fill, focus border, จุด toast |
| `accentHover` | `#BBDBFC` · `accentBright` `#A6D2FB` (กรอบมุม + เส้นเลเซอร์สแกน) |
| `primaryGradient` | `linear-gradient(140deg, #95C6F7 → #5A96D6)` — CTA หลักทุกปุ่ม |
| `activeTabGradient` | `linear-gradient(140deg, #A2CEF9 → #6EA8E8)` |
| `logoGradient` | `linear-gradient(150deg, #84BAF3 → #5A96D6)` |
| `countProgressGradient` | `linear-gradient(90deg, #95C6F7 → #6FE7AC)` |
| `OK` | `#6FE7AC` — พร้อมจ่าย / ตรงกับระบบ / จุด pulse กล้อง (tint `.14/.16/.40`, staff fg `#A6F0C8`) |
| `WARN` | `#FFBA5C` — ใกล้หมด / เกิน / ขาด (tint `.14`) |
| `BAD` | `#FF8377` — หมดสต็อก / login error |
| accent tints | `.12 .16 .18 .26 .28 .30 .35 .40 .45` ตามตำแหน่ง (demo btn → expanded border) |

**ฟังก์ชัน tone (ใช้ร่วม scan/search/count — เป็น pure function ใน `TclTokens`):**
```
onHand <= 0        → BAD  "หมดสต็อก"     // ⚠️ production ใช้ <= 0 ไม่ใช่ === 0 (ERP ส่งค่าติดลบได้)
onHand <= rop      → WARN "ใกล้หมด"
มิฉะนั้น            → OK   "พร้อมจ่าย"
```

### 1.4 Typography

- **ฟอนต์ default ของ TextTheme = IBM Plex Sans Thai** (400/500/600) — สแต็ก body ใน design เป็นไทยนำ
- **Space Grotesk** (400/500/600/700) ใช้ **เฉพาะจุดที่ design ระบุ**: ตัวเลขจำนวน, บรรทัด SKU, แบรนด์ TCL, keypad, badge/role pill, นาฬิกา
- ⚠️ ห้ามตั้ง Space Grotesk เป็น default แล้ว fallback ไทย — จะทำให้คำละติน/ตัวเลขในเนื้อความไทย ("Employee ID", ชื่อ "Tcl S.") ผิดฟอนต์ทั้งแอป
- ⚠️ **ห้ามใส่ letterSpacing กับข้อความสคริปต์ไทย** (`.08–.14em` ใน design เป็นของ Latin/ตัวเลขเท่านั้น) — ทำ shaping ไทยพัง
- ฟอนต์ bundle ใน assets (ห้าม fetch runtime) + StrutStyle ต่อ scale step กัน baseline ไทย/ละตินเหลื่อมและวรรณยุกต์ (◌้ ◌์) โดนตัด
- **Golden tests ทุกจอด้วยสตริงวรรณยุกต์หนัก** เป็น CI gate

Type scale (px/weight): `30/700` เลขคงเหลือการ์ดสแกน (lh .95, ls -.02em) · `26/600` หัวเรื่อง (lh 1.2) · `24/700` เลขผลค้นหา + แบรนด์ · `23/600` หัว sheet · `21/500` keypad · `19/500` empId input (ls .14em) · `18/600` ค่า stat/ช่องนับ/เลขระบบ · `17/600` ชื่อสินค้า/สมาชิก (lh 1.25) · `16/600` CTA หลัก · `15` CTA รอง + input · `13.5–10` ตามตาราง token (toast 13, subtitle 12.5, label 12, meta 11.5, SKU 11 ls .08em, unit/tab 10.5, role header 10 uppercase ls .12em)

### 1.5 รัศมี (radius)

`28` sheet + กรอบกล้อง · `24` การ์ด login + container แถบแท็บ · `20` การ์ดทั้งหมด · `18` ปุ่มหลักใหญ่/แท็บ/ช่องค้นหา/toast · `17` logo ใหญ่ + ปุ่ม team · `16` input/keypad/ปุ่มการ์ด/FAB/stat tile · `15` avatar สมาชิก + role picker · `14` กรอบมุมสแกน/avatar header/stepper/ช่องนับ · `11` ปุ่ม demo + logo เล็ก · `6` ช่อง PIN · `999` pill · `50%` จุดวงกลม

### 1.6 เงา

| ใช้ที่ | ค่า |
|---|---|
| การ์ด login | `0 18px 40px rgba(0,0,0,.35)` |
| ปุ่ม sign-in | `0 14px 30px rgba(90,150,214,.38)` (submit `.34`, เพิ่มสมาชิก `.32`, logo `.4`) |
| การ์ดสแกน | `0 12px 26px rgba(0,0,0,.3)` (ค้นหา `.28`, นับ `.26`) |
| แถบแท็บ | `0 -6px 26px rgba(0,0,0,.35)` |
| sheet | `0 30px 60px rgba(0,0,0,.5)` · toast `0 18px 40px rgba(0,0,0,.5)` |
| เส้นเลเซอร์ | `0 0 22px rgba(166,210,251,.85)` |

### 1.7 แอนิเมชัน

| ชื่อ | สเปค | Flutter mapping |
|---|---|---|
| `rise` | translateY 26px→0 + fade, `.22s cubic-bezier(.22,.9,.24,1)` (การ์ดสแกนเข้า), sheet `.24s`, toast `.2s ease-out` | SlideTransition + Fade ด้วย curve เดียวกัน |
| `nudge` | shake ±6px `.3s ease-in-out` (login error) | TweenSequence บน translateX |
| `pulse` | opacity .35↔1 + scale .9↔1, `1.5s infinite` (จุดเขียวสถานะกล้อง) | AnimationController repeat |
| `sweep` | เส้นเลเซอร์ `2.2s ease-in-out infinite alternate` — ⚠️ ตาม CSS ตรงตัวเส้นแทบไม่ขยับ (±44% ของสูง 2px) → **ตีความตาม intent: กวาดระหว่างกรอบมุม (26%→74% ของ viewport)** — deviation ที่บันทึกแล้ว |
| `glow` | วงแหวน `rgba(132,186,243,.35)` ขยาย 0→14px จาง, `2.4s ease-out infinite` (FAB กล้องตอนปิด) | ⚠️ Flutter animate box-shadow spread แบบนี้ไม่ได้ → **CustomPainter วาดวงแหวน** + เคารพ reduced-motion |
| keypad | `transition: background .14s` | AnimatedContainer |

**Interaction states:** hover ใน design ไม่มีบนจอสัมผัส — mapping ที่ตัดสินใจแล้ว: `style-active` → pressed state (keypad `rgba(132,186,243,.28)`, ปุ่มหลัก `brightness(.94)`), `style-hover` → ตัดทิ้งบน touch (ใช้ซ้ำเป็น focus state สำหรับ keyboard/hardware navigation ได้)

---

## 2. โครงหน้าจอและทุกสถานะ

### 2.1 Login "เข้าสู่ระบบ"

- โลโก้ tile 54×54 r17 gradient + แบรนด์ **TCL** (Space Grotesk 700 24) + ซับ "เข้าสู่ระบบด้วยรหัสพนักงานและ PIN"
- การ์ดแก้ว: ช่อง **รหัสพนักงาน · Employee ID** (h52 r16, ไอคอนคน `#84BAF3`, ตัวเลข ls .14em) → **รหัส PIN · 6 หลัก** + hint `{n}/6` → **ช่อง PIN 6 เซลล์** (h12 r6, เติม `#84BAF3` ซ้าย→ขวา) → keypad 12 ปุ่ม `1-9, C, 0, ⌫` (เมื่อ `loginLayout='keypad'`) → ปุ่ม **เข้าสู่ระบบ** gradient + ลูกศร → บรรทัดข้อความสถานะ
- Chips ล่าง: `WH-BKK-02` `v4.0` (ตัด chip `PIN 000000` — ดู §6)
- **สถานะ:** ปกติ / ไม่พบพนักงาน → shake + ข้อความ **"ไม่พบรหัสพนักงานนี้ · unknown employee ID"** สี BAD + ขอบเซลล์แดง / PIN ผิด → ล้าง PIN + **"PIN ไม่ถูกต้อง ลองอีกครั้ง"** / กดปุ่มใด ๆ ล้าง error
- สถานะเพิ่มของ production (ออกแบบเพิ่ม §7): โดน throttle, ต้องเปลี่ยน PIN ครั้งแรก, เครื่องนี้ต้องต่อเน็ตครั้งแรก

### 2.2 App shell + แถบแท็บ

- Header: logo เล็ก 34×34 + kicker/title ต่อแท็บ — scan: "คลัง WH-BKK-02 / **สแกนบาร์โค้ด**", search: "…/ **ค้นหาสินค้า**", count: "รอบตรวจนับ {sessionId} / **นับสต็อก**" (⚠️ CC-2408 ใน design คือข้อมูลตัวอย่าง — production ผูกกับ session จริง), team: "…/ **สมาชิกและสิทธิ์**" + บล็อกผู้ใช้ (ชื่อ, role ตัวพิมพ์ใหญ่ `#84BAF3`, avatar อักษรย่อ 42×42 r14)
- แถบแท็บ 4 ช่อง (grid, r24, เงาขึ้นบน): **สแกน / ค้นหา / นับสต็อก / สมาชิก** — active = `activeTabGradient` + ตัว `#07121B`, inactive = โปร่ง + `#A4B2C0`

### 2.3 แท็บสแกน

- กรอบกล้อง r28 บน `#121C27`: วิดีโอเต็มกรอบ, radial glow ฟ้า, **เส้นเลเซอร์กวาด** (`#A6D2FB` + เงาเรือง), **กรอบมุม 4 ชิ้น** 30×30 หนา 3px r14 (ตำแหน่ง: ซ้าย/ขวา 14%, บน/ล่าง 26% — ใช้เป็น `scanWindow` ROI ของ mobile_scanner ด้วย), **ป้ายสถานะ** มุมบนซ้าย (pill + จุดเขียว pulse + ข้อความ) , **FAB คอลัมน์** มุมล่างขวา: ปุ่มกล้อง (glow ตอนปิด) + ปุ่มค้นหา (→ แท็บค้นหา)
- ขนาดกล้อง (`scanLayout`): `sheet` = เต็มจอตอนยังไม่สแกน → หด 186px เมื่อมีรายการแรก; `split` = คงที่ 250px; min-height 190 ทุกกรณี
- แถบเครื่องมือ: ซ้าย **"ยังไม่มีรายการที่สแกน"** / **"สแกนแล้ว {n} รายการ"**; ขวา ปุ่ม **"ล้าง"** (เมื่อมีรายการ) — ปุ่มจำลอง 1/2/3 ของ demo แทนด้วยปุ่มกรอกบาร์โค้ดมือ (§6)
- **การ์ดผลสแกน** (เรียงใหม่สุดบน, สแกนซ้ำ = เด้งขึ้นบน + เวลาใหม่, เปิดขยายได้ทีละใบ):
  - แถบ tone 8×40 · `{SKU} · {HH:MM}` · ชื่อไทย 17/600 · `{สถานะ} · {ตำแหน่ง}` · ขวา: เลขคงเหลือ 30/700 สี tone + "{หน่วย} คงเหลือ"
  - ขยาย: แถบระดับสต็อก (สูตร `bar = clamp(3,100, round(onHand/(rop×3)×100))%` — ⚠️ production กัน `rop<=0` → ซ่อนแถบ) + 3 tiles **จอง / พร้อมขาย / จุดสั่งซื้อ** (พร้อมขาย = onHand−reserved, ⚠️ ติดลบ → แสดง 0 + flag) + spec rows (**ผู้ผลิต · Vendor / ล็อต · Lot / นับครั้งล่าสุด · Last count** — เมื่อ `itemCard='spec'`) + ปุ่ม **"นับสต็อกรายการนี้"** (gradient) / **"นำออก"** + ท้าย `{nameEn} · อัปเดต {เวลา}`
- Empty state: **"สแกนต่อเนื่องได้เรื่อย ๆ ทุกรายการที่อ่านได้จะเรียงไว้ด้านล่างพร้อมยอดคงเหลือ"** + **"แตะรายการเพื่อดูรายละเอียดเพิ่ม"**
- Role gate: viewer กด "นับสต็อกรายการนี้" → toast **"สิทธิ์ viewer นับสต็อกไม่ได้"** ไม่นำทาง

### 2.4 แท็บค้นหา

- ช่องค้นหา h52 r18 placeholder **"ชื่อสินค้า / SKU / บาร์โค้ด"** + บรรทัด **"{n} รายการ"**
- ค้น substring แบบ case-insensitive บน name+nameEn+sku+barcode — ⚠️ production: debounce + จำกัดผล (แสดง 100 จาก N) + `ListView.builder`
- การ์ดผลลัพธ์: แถบ tone · SKU · ตำแหน่ง · ชื่อไทย · ชื่ออังกฤษ · เลขคงเหลือ 24/700 สี tone + หน่วย
- แตะผลลัพธ์ → เข้ารายการสแกนแบบขยาย + สถานะกล้อง **"เลือกจากการค้นหา · {SKU}"** (พฤติกรรม handoff ตาม design เป๊ะ)
- Empty: **"ไม่พบสินค้าที่ตรงกับคำค้น"** / "No matching items"

### 2.5 แท็บนับสต็อก

- การ์ดรอบนับ: **"โซน {zone} · {sessionId}"** + **"นับแล้ว {done}/{total}"** + แถบ progress gradient ฟ้า→เขียว
- แถวนับ: SKU · ตำแหน่ง · ชื่อ · ขวา label **"ระบบ"** + เลข frozen qty · stepper **− [ช่องกรอก "นับได้"] +** (44×44 r14, ช่อง w88 focus ขอบ `#84BAF3`, ตัวเลขเท่านั้น, − ไม่ต่ำกว่า 0)
- **Pill variance (ข้อความเป๊ะตาม design):** ยังไม่กรอก → **"ยังไม่ได้นับ"** (เทา) · diff=0 → **"ตรงกับระบบ"** (OK) · diff>0 → **"เกิน +{diff}"** (WARN) · diff<0 → **"ขาด {diff}"** (WARN, ตัวเลขติดลบในตัว เช่น "ขาด -3")
- ปุ่ม **"ส่งผลการนับ"** เต็มกว้าง h54 gradient — ยังไม่นับ → toast **"ยังไม่มีรายการที่นับ"**; นับแล้ว → toast **"ส่งผลการนับ {n} รายการแล้ว"** (enqueue เข้า outbox — ดูข้อตัดสินใจ #4 ใน §6)

### 2.6 แท็บสมาชิก

- แถวสมาชิก: avatar สี role อักษรย่อ (grapheme-safe) · ชื่อ 17/600 · `{empId} · {กะ}` · **role pill** ADMIN (ฟ้า) / STAFF (เขียว) / VIEWER (เทา)
- แตะ pill = วน role admin→staff→viewer (admin เท่านั้น; ไม่ใช่ admin → toast **"ต้องมีสิทธิ์ผู้ดูแลเพื่อแก้ไขสิทธิ์"**) + กติกาเพิ่มของ production: กันลด role จนไม่มี admin เหลือ
- Hint: **"แตะที่สิทธิ์เพื่อสลับ admin / staff / viewer (เฉพาะผู้ดูแล)"**
- ปุ่มล่าง: **"เพิ่มสมาชิก"** (gradient, admin เท่านั้น — ไม่ใช่ → toast **"ต้องมีสิทธิ์ผู้ดูแลเพื่อเพิ่มสมาชิก"**) + **"ออกจากระบบ"**

### 2.7 Bottom sheet "เพิ่มสมาชิกใหม่"

- Scrim `rgba(10,17,25,.62)` + sheet r28 + grabber 42×4 + หัว **"เพิ่มสมาชิกใหม่"** / **"กำหนดชื่อ รหัสพนักงาน และสิทธิ์การใช้งาน"**
- ฟิลด์: **ชื่อ-สกุล** (placeholder "ชื่อพนักงาน") · **รหัสพนักงาน** (placeholder "52xxx", ตัวเลข ≤6) · **สิทธิ์** 3 ปุ่ม (default STAFF)
- ตรวจ: ชื่อว่าง/รหัส <3 หลัก → toast **"กรอกชื่อและรหัสพนักงานให้ครบ"** sheet ค้างไว้ · สำเร็จ → กะ "ยังไม่กำหนดกะ", toast **"เพิ่มสมาชิกแล้ว · member added"** + จอแสดง PIN เริ่มต้น (ออกแบบเพิ่ม §7)
- ⚠️ **implement เป็น Stack layer ในต้นไม้เดียวกัน (ไม่ใช้ `showModalBottomSheet`)** หรือ toast ผ่าน root Overlay — ไม่งั้น toast validation จะจมใต้ barrier มองไม่เห็น (มี widget test บังคับ)

### 2.8 Toast (global)

- ตำแหน่ง: ลอยเหนือแถบแท็บ (offset ล่าง 96 ใน design) · r18 · จุดนำ `#84BAF3` 8px · เข้าแบบ rise .2s · **แสดง 2400ms**, ข้อความใหม่แทนที่ทันที (ตัด timer เก่า)

---

## 3. Layout variants (config 3 แกนของ design)

| แกน | ค่า | ครอบคลุม |
|---|---|---|
| `loginLayout` | `keypad` (default) / `form` | ⚠️ `form` ใน demo ใช้ได้เพราะ bug PIN ว่างผ่าน — **production ตัดสินใจแล้ว: variant `form` ต้องมี TextField PIN แบบซ่อนตัวอักษร** (สไตล์ input token เดิม h52 r16 ls .14em) ขับเคลื่อน 6 เซลล์เดิม — มิฉะนั้นเปิด flag นี้ = ล็อคทั้ง fleet |
| `scanLayout` | `sheet` (default) / `split` | ขนาดกรอบกล้อง (ดู §2.3) |
| `itemCard` | `spec` (default) / `compact` | แสดง/ซ่อน spec rows ในการ์ดขยาย |

Governance: เก็บเป็น remote config ที่ **เปลี่ยนได้เมื่อ login ใหม่เท่านั้น** (ห้าม flip กลางกะ — กล้อง resize ใต้มือคนใช้งาน)

---

## 4. ข้อมูลตัวอย่าง (canonical fixture — ใช้ใน mock driver + golden tests)

สินค้า 5 รายการ (barcode EAN-13 จริง): สลักเกลียวหัวหกเหลี่ยม M12 (1240/180/400 ชิ้น, A-04-12) · เทปพันสายไฟ PVC 19 มม. (86/60/120 ม้วน — ใกล้หมด) · ถุงมือหนังนิรภัย เบอร์ 9 (0 — หมดสต็อก) · น้ำมันหล่อลื่นเกียร์ 20 ลิตร (34/6/10 ถัง) · แผ่นตัดเหล็ก 4 นิ้ว (512/24/150 แผ่น) — พร้อม vendor/lot/วันที่นับล่าสุดแบบ พ.ศ.
สมาชิก 4 คน: Tcl S. (52104 admin) · ปิยะนุช ศรีทอง (52210 staff) · ธนากร แสงทวี (52318 staff) · Nattaporn K. (52402 viewer)

ตัวเลขแสดงผ่าน `toLocaleString` (1,240) · วันที่ พ.ศ. ("12 ส.ค. 2569") · เวลาสัมพัทธ์ "วันนี้ HH:MM" / "เมื่อวาน HH:MM" (กติกาเกินเมื่อวาน: ออกแบบเพิ่ม §7)

---

## 5. กติกาแปลง mockup → อุปกรณ์จริง (chrome mapping)

### 5.1 สิ่งที่เป็น chrome ของ mockup — **ไม่สร้างในแอป**

- canvas radial + กรอบโทรศัพท์ 392×846 r46/38 + แถบสถานะปลอม (นาฬิกา 09:41, ไอคอน wifi/แบต SVG) + scrollbar web 5px
- แทนด้วย: `Scaffold` + `SafeArea` + `SystemUiOverlayStyle.light` บนพื้น `screenBg` gradient — นาฬิกา/แบตเป็นของ OS จริง

### 5.2 มิติที่เป็น token คงที่ vs ยืดหยุ่น

- **คงที่ (token):** ความสูงปุ่ม/ช่อง (56/54/52/50/48/46/44/34), รัศมี, ระยะ gutter 18 (แท็บ) / 26 (login), toast bottom 96, กล้อง 186/250/min190
- **ยืดหยุ่น:** ความกว้างทั้งหมด (ออกแบบที่ 392 → รองรับ 360–430), ความสูงรายการ scroll, กล้องใน sheet layout
- Keyboard avoidance: ช่องนับ + sheet ต้องเลื่อนพ้นคีย์บอร์ด (mockup 846px ไม่เคยแสดงคีย์บอร์ด)
- **Golden tests ที่ 360px และ 430px + text scale 1.3** เป็น CI gate

### 5.3 State machine `camStatus` (สตริงเป๊ะจาก design + เพิ่มของจริง)

| สถานะ | ข้อความ |
|---|---|
| ปิดอยู่ (เริ่มต้น/หลัง sign-out) | "กล้องปิดอยู่ · แตะไอคอนกล้อง" |
| ปิดเอง | "กล้องปิดอยู่ · camera off" |
| กำลังสแกน | "กำลังค้นหาบาร์โค้ด · scanning" |
| ไม่ได้รับ permission | "เปิดกล้องไม่ได้ · ใช้ปุ่มจำลอง" → ⚠️ ปรับท้ายเป็น "…ใช้การค้นหา/กรอกรหัส" (ปุ่มจำลองไม่ ship — ข้อความ 2 จุดนี้ต้องแก้ตาม §6) |
| decoder ใช้ไม่ได้ (เครื่องไม่มี GMS) | "เบราว์เซอร์นี้อ่านบาร์โค้ดไม่ได้ · …" → ปรับคำเป็น "เครื่องนี้…" |
| ไม่พบรหัส | "ไม่พบรหัส {code}" (+ toast "ไม่พบบาร์โค้ดนี้ในคลัง · not found") |
| เจอสินค้า | "พบสินค้า · {SKU}" / "เลือกจากการค้นหา · {SKU}" |
| เพิ่ม: resume จาก background | กลับสู่สถานะก่อนหน้า (`camOn` จำไว้) — นโยบาย lifecycle ดู architecture.md §9 |

พฤติกรรมสแกน: **สั่น (35ms-equivalent) ทุก decode ทั้งเจอและไม่เจอ** · dedup-prepend (สแกนซ้ำเด้งขึ้นบน + เวลาใหม่) · `DetectionSpeed.normal` + cooldown ต่อ code ~1.5–2 วิ (ห้าม `noDuplicates`)

---

## 6. Prototype artifacts — **ห้าม ship** (บัญชี deviation ที่ตัดสินใจแล้ว)

| # | ของใน demo | การจัดการ production |
|---|---|---|
| 1 | PIN กลาง `000000` + ตรวจ `pin && pin !== PIN` (**PIN ว่างผ่าน!**) | PIN รายคน hash argon2id, **ปฏิเสธ PIN ว่างเสมอ** |
| 2 | chip "PIN 000000" + ข้อความ "ใช้ PIN 000000 สำหรับตัวอย่างนี้" | ตัด chip; ข้อความ default เปลี่ยนเป็น hint กลาง เช่น "กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน" |
| 3 | empId เติมไว้ล่วงหน้า "52104" | ช่องว่าง (จำ empId ล่าสุดของเครื่องได้ใน kv_meta) |
| 4 | toast "ส่งผลการนับ {n} รายการแล้ว" ทั้งที่แค่เข้าคิว offline | **ใช้ copy เดิมตาม design + queue-depth badge เป็นกลไกความจริง** (ทางเลือก: "รอซิงค์ {n} รายการ" — ดูข้อเสนอตัดสินใจในรายงาน) |
| 5 | ปุ่มจำลองสแกน 1/2/3 (barcode ฝังใน title) | ตัดออกจาก production build (คงไว้เมื่อ `ERP_DRIVER=mock` สำหรับ demo/CI) — แทนด้วยช่องกรอกบาร์โค้ดมือ + แก้ 2 ข้อความ camStatus ที่ชี้ไปหามัน |
| 6 | sign-out คง counts/query/members ไว้ | **เคลียร์ counts + query ตอน sign-out** (เครื่องแชร์กัน — งานนับของ A ต้องไม่ถูก B ส่งในนาม B); members มาจาก replica อยู่แล้ว |
| 7 | state `history`, ค่า `simLabel`, `permNote` ที่คำนวณแต่ไม่แสดง | ไม่ implement (dead code ใน demo) |
| 8 | นาฬิกา mockup 09:41 + interval 20 วิ | ใช้ status bar ของ OS |

---

## 7. Design extensions ที่ต้องออกแบบเพิ่ม (สถานะที่ demo ไม่มีแต่ production ต้องมี)

ทำด้วยภาษา token ของ TCL เดิมทั้งหมด — ลำดับตามความจำเป็นก่อน implement:

1. **จอ pending-review** — งานที่ถูก reject ตอน sync (เช่น "สิทธิ์ถูกเปลี่ยน — รอผู้ดูแลตรวจสอบ", "รอบนับถูกปิดแล้ว") + ปุ่ม retry/ทิ้ง
2. **ตัวชี้สถานะซิงค์** — queue-depth badge, ป้าย "ข้อมูล ณ HH:MM" (พื้นที่ว่างบนกรอบกล้องจำกัด — เสนอวางในแถบเครื่องมือใต้กล้อง), สถานะ online/offline
3. **วงจรรอบนับ** — ไม่มีรอบ active ("ยังไม่มีรอบตรวจนับ — รอผู้ดูแลเปิดรอบ"), รอบถูกปิดระหว่างออฟไลน์, ใครนับล่าสุดต่อแถว, ตัวชี้ CONFLICT
4. **วงจร PIN** — เปลี่ยน PIN ครั้งแรก, admin reset, โดน throttle ("ลองใหม่ใน {n} วินาที"), "การเข้าสู่ระบบครั้งแรกต้องเชื่อมต่อเครือข่าย"
5. **จอแสดง PIN เริ่มต้น** หลังเพิ่มสมาชิกสำเร็จ (ให้ admin แจ้งพนักงานใหม่)
6. **First-run** — ดาวน์โหลด item master ครั้งแรก (progress/fail/partial)
7. **ช่องกรอกบาร์โค้ดมือ** — เมื่อกล้องใช้ไม่ได้/ฉลากเสีย
8. **จอ update APK** — prompt จาก `/meta` minVersion (blocking vs ข้ามได้)
9. **รายการนับขนาดจริง** — ค้นหาในรอบ + จัดกลุ่มโซน + virtualization

---

## 8. ประเด็นเปิดรอเจ้าของโปรเจคตัดสิน (มีค่า default แนะนำแล้ว)

| # | ประเด็น | ค่าแนะนำ (ใช้ถ้าไม่สั่งเปลี่ยน) |
|---|---|---|
| 1 | ปุ่มไฟฉาย (torch) — v1 เคยมี, ไฟล์สุดท้ายตัดออก แต่คลังจริงมืด | **เพิ่มเป็น FAB ที่ 3** ในคอลัมน์เดิม (46×46 token เดิม) — deviation ที่บันทึก |
| 2 | `loginLayout='form'` | คงไว้ + เพิ่ม PIN TextField (ตาม §3) — หรือถ้าไม่ใช้จริง ตัด axis ทิ้งทั้งอัน |
| 3 | copy ตอน submit offline (ข้อ 4 §6) | คง copy design + badge |
| 4 | ปุ่มจำลอง 1/2/3 | mock-mode เท่านั้น |
| 5 | คำใน 2 ข้อความ camStatus ที่อ้าง "ปุ่มจำลอง"/"เบราว์เซอร์" | ปรับคำตาม §5.3 |
