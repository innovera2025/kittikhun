# ล็อกอินผ่าน ERP (`menuuser`) แทน PIN 6 หลัก — แผนลงมือ

> สร้าง 4 ก.ย. 2569 · สังเคราะห์จากดีไซน์ที่ชนะการประกวด (Credential-as-its-own-table) +
> ปะรันเนอร์อัพ (Sync-Then-Verify) + **ปิดข้อบกพร่องร้ายแรงทั้ง 9 ข้อที่คณะกรรมการตรวจพบ**
> หลังตรวจสอบซ้ำกับซอร์สจริงของ `server/` (auth, members, sync, erp, schema, deploy) —
> ทุกจุดยืนยันด้วยเลขบรรทัดจริง ไม่ใช่การเดา
>
> สถานะ: **ยังไม่ลงมือ — เอกสารนี้คือแผนก่อนเขียนโค้ด**
>
> ⚠️ **ต่างจากดีไซน์ที่ชนะการประกวดใน 6 จุดสำคัญ** (ทุกจุดมีเหตุผลผูกกับข้อบกพร่องที่พบ):
> 1. **ไม่เปลี่ยนชื่อฟิลด์ wire** `empId`/`pin` → คงไว้เป๊ะ (แก้ข้อบกพร่อง #1 fleet lockout)
> 2. **ยกเลิก "legacy-pin retirement" แบบ DELETE ทั้งก้อนไม่มีการ์ด** → รวมเป็น sweep เดียวกับ
>    การ deactivate ที่มี `ERP_USER_DEACTIVATE_MAX_PCT` และ `ERP_USER_MIN_EXPECTED_ROWS` คุมทั้งคู่
>    (แก้ข้อบกพร่อง #2, #6)
> 3. **backfill ใน schema.sql ปิดตัวเองอัตโนมัติ** หลัง sync ผู้ใช้สำเร็จครั้งแรก โดยอ่านจาก
>    `sync_runs` ตารางที่มีอยู่แล้ว ไม่ต้องสร้างตารางสถานะใหม่ (แก้ข้อบกพร่อง #3)
> 4. **ด่าน last-admin สามชั้น** + แก้บั๊ก `create-admin` รันในคอนเทนเนอร์ไม่ได้จริง (แก้ข้อบกพร่อง #4, #7)
> 5. **query ผู้ใช้เป็น allowlist ล้วน** — `user_level` ที่ไม่ได้ map ไว้ = ไม่ได้บัญชีเลย ไม่ fallback
>    เป็น viewer (แก้ข้อบกพร่อง #5)
> 6. **แก้บั๊กตรรกะ `RETURNING` ที่ทำให้การเพิกถอนสิทธิ์ไม่เคยทำงาน** ด้วย `SELECT ... FOR UPDATE`
>    รูปแบบเดียวกับ `MembersService.changeRole` ที่มีอยู่แล้ว (แก้ข้อบกพร่อง #8)
>
> ปุ่มฮาร์ดแวร์เครื่องยิง vs ช่องรหัสผ่านที่บดบัง (ข้อบกพร่อง #9) และการไม่มีแผนเทสต์ (ข้อบกพร่อง #10)
> ถูกแก้ในขั้นตอนกลุ่ม E และหัวข้อ "แผนเทสต์รวม" ตามลำดับ — ดูตาราง
> **"การแก้ข้อบกพร่องร้ายแรงจากการตรวจ"** ด้านล่างสำหรับสรุปครบทั้ง 9 ข้อ

---

## ข้อที่ยังไม่รู้ — บล็อกการลงมือจริงบางส่วน (ต้องตอบก่อนหรือระหว่างลงมือ)

**กติกาของหัวข้อนี้: ทุกข้อมีสมมติฐานที่แผนเดินต่อโดยไม่รอคำตอบ + สิ่งที่พังถ้าสมมติฐานผิด +
จุดที่คำตอบจะโผล่ออกมาเอง (ส่วนใหญ่คือ Phase 0 recon ก่อนลงมือ หรือ anomaly ของรอบ sync แรก)**

| # | คำถาม | สมมติฐานที่แผนเดินต่อ | พังยังไงถ้าสมมติฐานผิด | จุดที่ได้คำตอบจริง |
|---|---|---|---|---|
| **U1** | `menuuser.user_level` ค่าไหนแปลว่า admin/staff/viewer? (ถามเจ้าของโปรเจกต์แล้ว ยังไม่ตอบ) | เป็นค่า scalar เล็ก ๆ (ตัวเลข/รหัสสั้น) ที่ map เข้า `ERP_USER_LEVEL_ROLE_MAP` ได้ตรงไปตรงมา | ถ้าเป็น bitmask/permission string ต่อโมดูล: ด่าน allowlist (ข้อ 5 ด้านบน) จะทำให้แทบไม่มีใคร map ได้เลย — sync ปฏิเสธการรันเพราะ map ว่าง (Phase 0 gate) ไม่ใช่ import ผิดเงียบ ๆ | ขั้น F-1 (`npm run verify:erp-users`) พิมพ์ `user_level` ที่พบจริงทุกค่าพร้อมจำนวนแถว **ก่อน**เขียนโค้ดฝั่ง mapping |
| **U2** | `id_random` มีไว้ทำอะไร ในเมื่อ A4 บอกว่า verify เป็น string compare ตรง ๆ | ไม่มีบทบาทในการ verify — A4 สมบูรณ์ (ยืนยันจากโจทย์ผู้ใช้ตรง ๆ) | ถ้าจริง ๆ เป็น per-user salt ที่ front-end VFP ผสมก่อนเทียบ: ทุก hash ที่ sync สร้างจะ verify ไม่ผ่าน → **ล็อกอิน ERP ล้มเหลว 100%** ตั้งแต่ Phase 3 นัดแรก | เห็นทันทีที่ Phase 3 ทดสอบล็อกอิน ERP จริงครั้งแรก (ก่อน retire legacy PIN ใด ๆ — ยังย้อนกลับได้) |
| **U3** | `menuuser.emp_id` (คอลัมน์ join กับ `Employee`) คือรหัสเดียวกับ `users.emp_id` ของเราไหม และผ่าน `^[A-Za-z0-9._-]{1,32}$`ไหม | ใช่ทั้งสองข้อ | ถ้ารูปแบบไม่ตรง: แถวนั้นถูกปฏิเสธเป็น anomaly (`rejected_row`) ไม่ล้มทั้ง run — แต่ถ้ารหัสตรงรูปแบบแต่**ไม่ใช่คนเดียวกับพนักงานเดิม**: เกิดบุคคลซ้ำ (มีประวัตินับของเก่าติดอยู่ที่รหัสเดิม แยกจากบัญชีที่ล็อกอินได้ใหม่) — เป็นความเสียหายที่ sync เองมองไม่เห็น | ขั้น F-1 เทียบ `menuuser.emp_id` กับ `users.emp_id` ที่มีอยู่แล้ว รายงานจำนวนที่ตรงกัน — ถ้าตรงกันน้อยกว่า ~90% ให้ **หยุด** ก่อน Phase 3 |
| **U4 / U7** | ผู้ใช้ที่ sync มาควรได้ `warehouse_code` อะไร ในเมื่อ query ที่ให้มาไม่มีคอลัมน์คลังเลย และ `menuuser` ไม่มี `WHERE` กรองอะไรเลย (เป็นตาราง user ทั้ง ERP ไม่ใช่แค่คลัง) | deployment นี้เดินคลังเดียว (ตาม `WAREHOUSE_CODE` ที่ตั้งไว้แล้ว) ทุกบัญชีที่ sync มาได้รับค่าเดียวกันนี้ | ถ้า ERP instance นี้ให้บริการหลายคลังจริง: บัญชีฝ่ายบัญชี/ขาย/superuser ที่ไม่เกี่ยวกับคลังนี้เลยจะเห็นสต็อกคลังนี้ได้ถ้า `user_level` ของเขาบังเอิญ map มาเป็น staff/admin — **ด่าน allowlist (แก้ข้อบกพร่อง #5) ลดผลกระทบ**เพราะ level ที่ไม่ map ไว้จะไม่ได้บัญชีเลย แต่ไม่ได้แก้ปัญหาที่ต้นตอ | ต้องถามเจ้าของ ERP ตรง ๆ ก่อน Phase 3: "instance นี้เดินกี่คลัง มีคอลัมน์ site/dept ในตารางอื่นที่ join ได้ไหม" — **ไม่ใช่สิ่งที่ sync ตอบเองได้** ต้องเป็นการยืนยันจากคน |
| **U5** | `Employee.EmpPict` ควรใช้แสดงรูปโปรไฟล์ไหม | ไม่ใช้ — query ที่ sync ยิงจริงตัด `LEFT JOIN Employee` ทั้งก้อนทิ้ง | ไม่มี — เป็นฟีเจอร์ที่ไม่มีที่ลงในสัญญาปัจจุบันอยู่แล้ว (ไม่มีฟิลด์รูปใน `UserProfile`/`Member`) การไม่ทำจึงไม่มีต้นทุน | ปิดคำถามด้วยการไม่ทำ — บันทึกไว้เป็น future work ถ้ามีคนขอภายหลัง |
| **U6** | พนักงานที่ถูกลบ/ปิดใช้งานใน ERP แต่มีรอบนับค้างอยู่ (ผูก FK 9+ ตาราง) ควรเกิดอะไรขึ้น | ลบเฉพาะแถว `user_credentials` (ปิดล็อกอิน) **ไม่แตะ `users` เลย** — ประวัติ/FK ทั้งหมดอยู่ครบ | ถ้าออกแบบผิดไปลบ/แก้ `users.emp_id`: ชน `ON DELETE RESTRICT` ของ `count_submissions` ทันที (schema.sql:358) sync ทั้ง run ล้ม | พิสูจน์ด้วยเทสต์ "DEACTIVATION" ในแผนเทสต์รวม — ลบ credential แล้ว query `count_submissions` ต้องยังเห็นแถวเดิม |

**หมายเหตุ:** ไม่มีข้อไหนใน U1-U7 บล็อก**การเขียนโค้ด**ของแผนนี้ (ทุกกลไกออกแบบให้ fail-safe ต่อคำตอบผิด)
แต่ **U1, U3, U4/U7 บล็อก Phase 3** (การเปิดสวิตช์ `ERP_USER_SYNC_ENABLED=true` ของจริง) จนกว่าจะรัน
`npm run verify:erp-users` (ขั้น F-1) แล้วอ่านผลด้วยตา และจนกว่าเจ้าของ ERP จะยืนยัน U4/U7 ตรง ๆ


## การแก้ข้อบกพร่องร้ายแรงจากการตรวจ (ทั้ง 9 ข้อ — ต้องปิดครบก่อนถือว่าแผนนี้พร้อม)

| # | ข้อบกพร่องที่พบ | กลไกที่แก้ (อยู่ตรงไหนในแผนนี้) |
|---|---|---|
| 1 | เปลี่ยนชื่อฟิลด์ wire ล็อก fleet ที่ยังไม่อัปเดตออกทั้งหมด | **ไม่เปลี่ยนชื่อฟิลด์เลย** — คง `{empId, pin, deviceId, appVersion}` ทั้งคำขอและคง error code เดิม (`UNKNOWN_EMPLOYEE`/`INVALID_PIN`) เปลี่ยนแค่ regex ที่ผ่อนลง + ข้อความไทย ดู ขั้นตอนกลุ่ม B และ Cutover Phase 2 + ด่าน fleet-readiness ใหม่ (ขั้น F-2) ที่อิง `devices.app_version` ซึ่งมีข้อมูลจริงอยู่แล้ว |
| 2 | legacy-pin retirement ลบทั้งก้อนไม่มีการ์ด เสี่ยงล้างทั้งคลังจากไฟล์ SQL ที่ถูกตัดทอน | ยุบ "retirement" ให้เป็น**กรณีพิเศษของ deactivation sweep เดียวกัน** ผูกกับทั้ง `ERP_USER_DEACTIVATE_MAX_PCT` (สัดส่วน) และ `ERP_USER_MIN_EXPECTED_ROWS` (จำนวนแถวขั้นต่ำ) พร้อมกัน ดู ขั้นตอนกลุ่ม C ข้อ C-7 |
| 3 | schema.sql replay ชุบชีวิต credential ที่เพิ่ง deactivate กลับมา | backfill ใน migration เช็ค `NOT EXISTS (SELECT 1 FROM sync_runs WHERE kind='users' AND status='success')` ก่อนแทรกทุกครั้ง — ปิดตัวเองถาวรหลัง sync สำเร็จครั้งแรก ไม่ต้องสร้างตารางสถานะใหม่ ดู ขั้นตอนกลุ่ม A ข้อ A-4 |
| 4 | ไม่มีด่าน last-admin ระหว่าง sync ทำให้ role map ที่ผิดพลาดเพียงเล็กน้อยลดสิทธิ์ admin ทุกคนพร้อมกัน | ด่านสามชั้น: (ก) `create-admin` เขียน `user_credentials.source='local'` ที่ sync ห้ามแตะ (ข) sync ปฏิเสธทั้ง run ถ้าไม่มี local-admin credential อยู่เลย (ค) การลดสิทธิ์ admin→อื่นต่อแถวเช็คด้วย `SELECT ... FOR UPDATE` เหมือน `MembersService.changeRole` เป๊ะ ดู ขั้นตอนกลุ่ม C ข้อ C-5, C-6 และกลุ่ม D ข้อ D-3 |
| 5 | query ไม่มี `WHERE` เลย ดึงบัญชีทั้ง ERP (บัญชี, ขาย, superuser) เข้ามาเป็นผู้ใช้แอปคลัง | เปลี่ยนจาก "role-map-with-default-fallback" เป็น **allowlist ล้วน**: `user_level` ที่ไม่ได้ระบุใน `ERP_USER_LEVEL_ROLE_MAP` = ไม่ได้บัญชีเลย (ไม่ fallback เป็น viewer) ดู ขั้นตอนกลุ่ม C ข้อ C-4 และ Blocking Unknowns U4/U7 |
| 6 | deactivation guardrail คุมแค่ `source='erp'` แต่ retirement (แยกอีกทาง) ไม่มีการ์ดเลย | รวมเป็น sweep เดียวตามข้อ 2 — ไม่มี "อีกทาง" ที่ไม่มีการ์ดอีกต่อไป |
| 7 | `create-admin` เรียก `ts-node src/cli/...` แต่คอนเทนเนอร์จริงไม่มีทั้ง `ts-node` (ถูก prune) และไม่มี `src/` (ไม่ถูก COPY) — break-glass ใช้งานจริงไม่ได้ | แก้ script ใน `package.json` เป็น `node dist/cli/create-admin.js` (ตรงกับที่คอมเมนต์ในไฟล์เดิมคาดไว้อยู่แล้ว) ยืนยันว่า `nest build` คอมไพล์ไฟล์นี้จริงจาก `tsconfig.json` (`include: ["src/**/*"]`) ดู ขั้นตอนกลุ่ม D ข้อ D-2 |
| 8 | `... WHERE users.role IS DISTINCT FROM ... RETURNING role` ให้ role **ใหม่**เสมอ (เทียบกับตัวเองไม่มีทางต่าง) และ path ไม่เปลี่ยนอะไรเลยคืน 0 แถว — การเพิกถอน refresh token ไม่เคยทำงาน | เลิกพึ่ง `RETURNING` เปรียบเทียบ เปลี่ยนเป็น `SELECT emp_id, role FROM users WHERE emp_id=$1 OR role='admin' ORDER BY emp_id FOR UPDATE` อ่าน role เก่าไว้ในโค้ดแอปก่อน UPDATE แล้วเทียบเองใน JS — สำเนาจากรูปแบบเดียวกับ `MembersService.changeRole` (members.service.ts:200-220) เป๊ะ ดู ขั้นตอนกลุ่ม C ข้อ C-5 |
| 9 | เครื่องยิงบาร์โค้ดเป็น HID keyboard-wedge — ลั่นไกโดยไม่ตั้งใจขณะช่องรหัสผ่านโฟกัสจะพิมพ์บาร์โค้ดลงช่องที่บดบังไว้เงียบ ๆ แล้วโดน throttle โดยไม่มีคำอธิบาย | ห่อช่องรหัสผ่านด้วย `Focus`/`onKeyEvent` ใช้ `HandheldScanBuffer` ตัวเดิม (ของแผน scan-mode-selector) ตรวจจับ burst แล้ว**กลืนอักขระทั้งชุดไม่ให้ถึงช่อง** พร้อม toast อธิบาย ดู ขั้นตอนกลุ่ม E ข้อ E-6 |
| 10 | ไม่มีแผนเทสต์เลย โดยเฉพาะไม่มีเทสต์ยืนยันว่า plaintext ไม่รั่วไปที่ไหน (audit_log append-only แก้คืนไม่ได้) | หัวข้อ "แผนเทสต์รวม" ท้ายไฟล์นี้ระบุเทสต์ leak-check ชัดเจน (มิเรอร์ของเทสต์ที่มีอยู่แล้ว `auth-integration.spec.ts:98`) + เพิ่ม `user_credentials` เข้า `TABLES` ของ `test/support/test-db.ts:60-73` + ลบ `pin-policy.spec.ts` คู่กับไฟล์ต้นทาง |


## เป้าหมายและขอบเขต

**เป้าหมาย:** แทนที่การล็อกอินด้วย PIN 6 หลักของระบบเราเอง ด้วยข้อมูลรับรองตัวตนที่ sync มาจาก
ตาราง `menuuser` ของ ERP (query ที่ผู้ใช้ให้มา) โดย **plaintext password ของ ERP ต้องไม่ถูกเก็บไว้ที่ฝั่งเรา
เลยแม้ชั่วขณะเกินความจำเป็นของการ hash** และ **login ต้องทำงานได้แม้ ERP unreachable** (เพราะฐานคือ
Postgres ของเราเอง ไม่ใช่ query สด) และ **ต้องไม่มีใครถูกล็อกออกระหว่างการเปลี่ยนผ่าน**

**ขอบเขตที่ทำ:**
- ตาราง `user_credentials` ใหม่ + widen `sync_kind` enum
- sync job ใหม่ (`users`) ที่ดึงจาก `menuuser`, hash ด้วย argon2id เดิม, เขียน `users`/`user_credentials`
- `AuthService.login()` อ่านจาก `user_credentials` แทน `users.pin_hash` ตรง ๆ (wire ไม่เปลี่ยน)
- ลบเส้นทางที่ไม่มีความหมายอีกต่อไป: change-pin, member create, reset-pin, `pin-policy.ts`
- แก้ `PATCH /members/:empId/role` ให้ปฏิเสธเมื่อเป้าหมายเป็น `source='erp'`
- แก้บั๊ก `create-admin` ที่รันในคอนเทนเนอร์จริงไม่ได้ (ไม่เกี่ยวกับ ERP โดยตรง แต่เป็น precondition
  ของด่าน last-admin)
- หน้าล็อกอิน Flutter: เปลี่ยนจาก keypad 6 หลักเป็นฟอร์ม username/password ธรรมดา + ด่านกันเครื่องยิง
- เอกสาร: แก้ `docs/design-fidelity.md` §2.1/§6/§8, แก้คอมเมนต์ผิดเรื่อง "migration รันตอน boot"
  ใน `server/Dockerfile:24-25`, `server/docker-compose.yml:59,86`, `server/db/schema.sql:21`

**ขอบเขตที่ไม่ทำ (out of scope — บันทึกไว้ตรง ๆ ไม่ใช่ลืม):**
- ไม่ทำ session restore ฝั่งแอป (`restoreSession()`/`hasSession()` เป็น dead code อยู่แล้ว —
  ไม่ใช่งานของแผนนี้ที่จะไปทำให้มันมีชีวิต แม้จะช่วยกรณี "เครื่องไม่มี LAN" ก็ตาม)
- ไม่แสดงรูปโปรไฟล์จาก `Employee.EmpPict` (U5 — ตัด `LEFT JOIN Employee` ทั้งก้อน)
- ไม่รองรับ ERP หลายคลัง/หลาย instance ในรอบนี้ (U4/U7 — ยังต้องยืนยันจากคนก่อน Phase 3)
- ไม่เพิ่ม role ที่ 4 ให้ enum `user_role` (ยังคง admin/staff/viewer ตามเดิม — ถ้า U1 บังคับให้ต้องมี
  role ที่ 4 จริง ๆ เป็นแผนแยกต่างหาก)
- ไม่ทำ UI สำหรับตั้งค่า `ERP_USER_LEVEL_ROLE_MAP` (เป็น env var ที่ตั้งตอน deploy ไม่ใช่ตั้งจากแอป)
- ไม่ทำ telemetry ส่งขึ้น server เพิ่มเติมสำหรับวัด fleet readiness — ใช้ `devices.app_version` /
  `devices.last_seen_at` ที่มีข้อมูลจริงอยู่แล้วจากทุก login/heartbeat


## ภาพรวมสัญญา wire ที่ "ไม่เปลี่ยน" (อ่านก่อนเข้ารายละเอียด)

```
POST /auth/login
  body:  { empId: string, pin: string, deviceId: string, appVersion?: string }  ← ชื่อฟิลด์เดิมทุกตัว
  200:   LoginResponse { accessToken, refreshToken, expiresIn, user: UserProfile }
  401:   { code: 'UNKNOWN_EMPLOYEE' | 'INVALID_PIN', message } ← code string เดิมทุกตัว
  400:   { code: 'THROTTLED', message, retryAfterMs }
```

**สิ่งที่เปลี่ยนคือความหมาย ไม่ใช่รูปร่าง:** `empId` ที่ส่งมาตอนนี้คือ "ตัวระบุที่ใช้ล็อกอิน" (login
identifier) ไม่ใช่ "รหัสพนักงาน" เป๊ะ ๆ อีกต่อไป — สำหรับผู้ใช้ legacy/local ค่านี้ยังเท่ากับ
`lower(emp_id)` เหมือนเดิม (ใช้ค่าเดิมได้เป๊ะ) สำหรับผู้ใช้ที่ sync มาจาก ERP แล้ว ค่านี้คือ
`lower(menuuser.user_name)` — คนละค่ากับ `users.emp_id` (ซึ่งยังเป็น `menuuser.emp_id`/FK anchor
เดิมเสมอ ไม่เปลี่ยนความหมาย) เหตุผลของการ "เก็บชื่อฟิลด์แต่เปลี่ยนความหมาย" คือข้อบกพร่อง #1
(ดูตารางด้านบน) — ไม่มีทางเลี่ยงเพราะ **หน้าจอเดิมเป็น numeric keypad 6 หลัก พิมพ์ username จริงไม่ได้
อยู่แล้ว ไม่ว่าจะตั้งชื่อฟิลด์ wire ว่าอะไร** ปัญหาจึงอยู่ที่ระดับ UI ไม่ใช่ schema — ดู Cutover Phase 3
สำหรับด่าน fleet-readiness ที่คุมเรื่องนี้


## ตารางการตัดสินใจ

| # | ประเด็น | เลือก | เหตุผล | ตัดออก |
|---|---|---|---|---|
| 1 | credential อยู่ตารางไหน | ตารางใหม่ `user_credentials` (1:1 กับ `users.emp_id` ผ่าน UNIQUE) `users.pin_hash` เหลือไว้เฉยๆ (nullable) จนกว่าจะ cleanup | `count_submissions.emp_id` เป็น `ON DELETE RESTRICT` (ลบ `users` แถวที่เคยนับไม่ได้) แต่ credential ไม่มีใครอ้างอิงกลับ → ลบได้อิสระ = กลไก deactivate ตัวเดียวที่ทำได้จริงสำหรับ U6 | เขียนทับ `users.pin_hash` ตรง ๆ (พึ่งพากับตารางที่ 11 route `@RequireFreshRole` อ่านทุก request), ตารางแยกต่อ "แหล่งข้อมูล" (ซับซ้อนเกินจำเป็น) |
| 2 | `users.emp_id` ของผู้ใช้ ERP ควรเป็นอะไร | `menuuser.emp_id` (คอลัมน์ join กับ `Employee` — คือรหัสพนักงานจริง) | ปรากฏใน `count_submissions`/`closed_variance`/`audit_log` ที่มีอยู่แล้วและเป็น append-only — เปลี่ยนความหมายทีหลังจะพังประวัติ | `menuuser.user_name` (เป็น login handle ที่เปลี่ยนชื่อได้ ไม่เหมาะเป็น anchor ถาวร) |
| 3 | `user_level` → role | **Allowlist**: `ERP_USER_LEVEL_ROLE_MAP` ระบุ level→role ที่รู้จักเท่านั้น level อื่นไม่ได้บัญชีเลย (ไม่ fallback viewer) | แก้ข้อบกพร่อง #5 ตรง ๆ — `menuuser` ไม่มี WHERE กรองคลัง/แผนก การ fallback เป็น viewer เท่ากับให้ทุกบัญชี ERP (บัญชี, ขาย, ...) ล็อกอินอ่านสต็อกได้ | default เป็น viewer (ดีไซน์เดิม — ทำให้ query ที่ไม่มี WHERE นำเข้าทุกคนโดยไม่รู้ตัว) |
| 4 | sync ลบผู้ใช้ที่หายจาก ERP ไหม | ไม่แตะ `users` เลย — ลบเฉพาะแถว `user_credentials` | ลบ `users` ไม่ได้จริงถ้าเคยนับ (FK RESTRICT) การลบ credential พอสำหรับ "ล็อกอินไม่ได้" ซึ่งคือเป้าหมายจริงของ U6 | เพิ่มคอลัมน์ `disabled_at` ใหม่ (schema ใหญ่ขึ้นโดยไม่จำเป็น ในเมื่อ absence ของ credential สื่อความหมายเดียวกันอยู่แล้ว) |
| 5 | legacy-pin retirement | **ไม่มีขั้นตอนแยก** — เป็นกรณีพิเศษของ deactivation sweep เดียวกัน (ดูข้อ C-7) | ข้อบกพร่อง #2/#6 คือ retirement แยกจาก sweep แล้วไม่มีการ์ด รวมเป็นเส้นทางเดียวปิดช่องนั้นทั้งหมด | DELETE ท้าย run ที่สำเร็จ (ของเดิม — ไม่มีเพดานสัดส่วน ไม่มีเพดานจำนวนแถว) |
| 6 | detect รหัสผ่านเปลี่ยนไหมโดยไม่ rehash ทุกรอบ | `argon2.verify(existing_hash, erp_password)` ก่อนเสมอ — ตรงกันจริง = แตะแค่ `erp_last_seen_at` | argon2 hash มี salt เทียบ hash ตรง ๆ ไม่ได้ — verify คือวิธีเดียวที่ถูกต้อง และช่วยไม่ให้ revoke refresh token ทุกเครื่องทุกชั่วโมงโดยไม่จำเป็น | เก็บ HMAC fingerprint ไว้เทียบเร็ว ๆ (เป็น digest เร็วของ secret เอนโทรปีต่ำ ถ้า DB+key รั่วพร้อมกัน crack ได้เร็วกว่า argon2 มาก) |
| 7 | ตรวจ "ต้องมี admin เหลืออย่างน้อย 1" ระหว่าง sync อย่างไร | สามชั้น: create-admin เขียน `source='local'` ที่ sync ห้ามแตะ + sync ปฏิเสธทั้ง run ถ้าไม่มี local-admin เลย + ต่อแถวใช้ `SELECT...FOR UPDATE` เหมือน `changeRole` | ข้อบกพร่อง #4/#7 — เดิมไม่มีด่านนี้เลย และ break-glass ที่อ้างไว้ใช้งานจริงไม่ได้ (ts-node ไม่อยู่ใน runtime image) | เช็คแค่ "map ต้องไม่ว่าง" (ยังปล่อยให้ map ที่ผิดพลาดเล็กน้อยแต่ครบทุก key ลดสิทธิ์ admin ทุกคนพร้อมกันได้) |
| 8 | credential ที่มีอยู่แล้วตอน sync มาเจอ (มี emp_id ซ้ำ) | อัปเดตในที่ (`UPDATE ... WHERE emp_id=$1`) เปลี่ยน `login_name`/`source`/`secret_hash` ไปเลย ไม่ลบแล้วสร้างใหม่ | คนที่มี legacy_pin เดิมแล้วปรากฏใน ERP รอบแรก (ไม่ว่าจะใช้ user_name อะไร) ถูก "เปลี่ยนสัญชาติ" เป็น erp ในที่เดียว ไม่ทิ้งแถวเก่าให้ sweep ไปเจอทีหลัง (ผลข้างเคียงที่ถูกต้องคือ retirement เหลือแค่คนที่ไม่เคยโผล่ใน ERP เลย) | ลบแถวเก่าทิ้งแล้ว INSERT ใหม่ (เสีย `secret_rotated_at` history และเสี่ยง FK ชั่วครู่) |
| 9 | ฟิลด์ wire ของ login เปลี่ยนชื่อไหม | **ไม่เปลี่ยน** (`empId`/`pin`) เปลี่ยนแค่ zod schema ภายใน (คลาย regex) | ข้อบกพร่อง #1 — fleet ไม่ได้อัปเดตพร้อมกัน (sideload manual) เปลี่ยนชื่อฟิลด์ = APK เก่าได้ `400 VALIDATION` ทันทีที่ deploy โดยไม่มี escape hatch (`GET /meta` ไม่มีจริง, `APP_MIN_VERSION` ไม่เคยถูกบังคับใช้) | เปลี่ยนเป็น `{username, password}` (ของดีไซน์ที่ชนะเดิม — สวยกว่าแต่ทำลาย N-1 compatibility ที่ `docs/architecture.md:292` วางกฎไว้ชัดสำหรับเส้นทางวิกฤต) |
| 10 | error code ของ login เปลี่ยนไหม | **ไม่เปลี่ยน** (`UNKNOWN_EMPLOYEE`, `INVALID_PIN` เหมือนเดิมทุกตัว) เปลี่ยนแค่ข้อความไทย | เหตุผลเดียวกับข้อ 9 — แอปเก่าเช็ค `e.code == codeInvalidPin` เพื่อเคลียร์ช่อง ถ้าเปลี่ยน code ทั้งฟีเจอร์ "เคลียร์ช่องเมื่อผิด" หายไปเงียบ ๆ บนเครื่องที่ยังไม่อัปเดต | เปลี่ยนเป็น `UNKNOWN_USER`/`INVALID_CREDENTIALS` (ของดีไซน์เดิม) |
| 11 | fleet readiness ก่อนเปิด sync จริง (Phase 3) วัดยังไง ในเมื่อไม่มี telemetry version อยู่แล้ว | ใช้ `devices.app_version`/`devices.last_seen_at` ที่ถูกเขียนจริงทุก login (`touchDevice`) และทุก heartbeat (`count.service.ts:1241-1256`) อยู่แล้ว — ไม่ต้องสร้างกลไกใหม่ | ข้อบกพร่อง #1 ต้องการ "รอ telemetry บอกว่า fleet อัปเดตครบ" ตาม SOP ที่ `docs/architecture.md:292` เขียนไว้เอง — ข้อมูลนี้**มีอยู่แล้วจริง**เพียงแต่ไม่เคยถูกอ่านเพื่อจุดประสงค์นี้ | เพิ่มตาราง/endpoint version ใหม่ (ไม่จำเป็น — ของเดิมพอ), เชื่อใจ APK sideload ครบ 100% โดยไม่ตรวจ (เสี่ยงตรง ๆ) |
| 12 | บดบังเครื่องยิงบาร์โค้ดที่ช่องรหัสผ่าน | ห่อช่องด้วย `HandheldScanBuffer` เดิม (ของแผนสแกน) ตรวจจับ burst แล้วกลืนทั้งชุด ไม่ให้ถึงช่อง | ข้อบกพร่อง #9 — เครื่องยิงเป็น HID keyboard-wedge ยิงเผลอขณะช่องรหัสผ่านโฟกัสจะพิมพ์บาร์โค้ดใส่ช่องที่บดบังไว้ ตามด้วย throttle ที่อธิบายไม่ได้ | ไม่ทำอะไร (ความเสียหายที่รายงานไว้ตรง ๆ), ปิดคีย์บอร์ดฮาร์ดแวร์ทั้งหมดที่หน้านี้ (ปิดโอกาสพิมพ์จริงด้วย) |
| 13 | change-pin / สร้างสมาชิก / reset-pin | ลบทั้งสาม endpoint + `pin-policy.ts` ทั้งไฟล์ | credential ที่ ERP เป็นเจ้าของ ถูก sync รอบถัดไปเขียนทับอยู่ดี endpoint ที่ดูเหมือนทำงานแต่ผลถูกลบภายในไม่กี่นาทีถึงชั่วโมงแย่กว่าไม่มี endpoint | เก็บไว้เป็น "เปลี่ยนที่ ERP แทน" (endpoint ที่ทำหน้าที่เดียวคือฟ้องว่าใช้ไม่ได้ แย่กว่าไม่มีเลย) |


## ขั้นตอนกลุ่ม A — Schema (`server/db/schema.sql`)

ทุกขั้นในกลุ่มนี้แก้ไฟล์เดียว `server/db/schema.sql` เรียงตามตำแหน่งที่ต้องแทรกจริงในไฟล์
(enum → table → migration guard) ไม่มีการรันจริงจนกว่าจะ `npm run migrate` ตาม Cutover Phase 1

### A-1. เพิ่มค่า enum ให้ `sync_kind` (ใกล้ schema.sql:56)

แทรก**บรรทัดเดี่ยวระดับบนสุด** (ห้ามห่อด้วย `DO $do$ ... END $do$;` — `ALTER TYPE ... ADD VALUE`
รันในฟังก์ชัน/DO block ไม่ได้ และมี `IF NOT EXISTS` ในตัวอยู่แล้วจึงไม่ต้องดัก exception) วางไว้
**หลัง** บล็อก `CREATE TYPE sync_kind AS ENUM (...)` เดิม:

```sql
-- ค่าที่ 4 ของ sync_kind — ต้องเป็น statement เดี่ยวระดับบนสุด (ไม่ห่อ DO block)
ALTER TYPE sync_kind ADD VALUE IF NOT EXISTS 'users';
```

ปลอดภัยเพราะ `psql -f db/schema.sql -v ON_ERROR_STOP=1` (ทั้ง `npm run db:schema` และ
`deploy/update.sh` เรียกแบบนี้ ไม่มีแฟลก `-1`/`--single-transaction`) รันทีละ statement แบบ
autocommit — ค่าใหม่ commit ก่อนที่ statement ถัดไปในไฟล์เดียวกันจะอ้างถึงมัน

### A-2. ตาราง `user_credentials` ใหม่ (วางหลังตาราง `users`, ~schema.sql:131)

```sql
DO $do$ BEGIN
  -- erp = sync เป็นเจ้าของ (ห้ามแตะโดยมนุษย์) · local = break-glass จาก create-admin (sync ห้ามแตะ)
  -- legacy_pin = PIN เดิมที่ backfill มาตอน migrate — เก็บกวาดเองหลัง sync ผู้ใช้สำเร็จครั้งแรก
  CREATE TYPE user_credential_source AS ENUM ('erp', 'local', 'legacy_pin');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

CREATE TABLE IF NOT EXISTS user_credentials (
  login_name        text        PRIMARY KEY,
  emp_id            text        NOT NULL UNIQUE
                                 REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE CASCADE,
  secret_hash       text        NOT NULL,
  source            user_credential_source NOT NULL,
  secret_rotated_at timestamptz NOT NULL DEFAULT now(),
  erp_user_level    text,
  erp_last_seen_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_login_fmt CHECK (
    login_name = btrim(login_name) AND login_name = lower(login_name)
    AND length(login_name) BETWEEN 1 AND 64),
  CONSTRAINT user_credentials_hash_argon CHECK (secret_hash LIKE '$argon2id$%'),
  CONSTRAINT user_credentials_erp_fields CHECK (
    (source = 'erp') = (erp_user_level IS NOT NULL AND erp_last_seen_at IS NOT NULL))
);

COMMENT ON TABLE user_credentials IS
  'ตัวยืนยันตัวตน 1 แถวต่อคน แยกจาก users โดยตั้งใจ — sync เขียนที่นี่ authz อ่านที่ users '
  'ลบแถวนี้ = ปิดล็อกอินโดยไม่แตะ FK ของ users.emp_id เลย (ดู U6)';
COMMENT ON COLUMN user_credentials.erp_user_level IS
  'ค่าดิบจาก menuuser.user_level — เก็บไว้ตอบ U1 จากข้อมูลจริงได้ทุกเมื่อ';

DROP TRIGGER IF EXISTS trg_user_credentials_touch ON user_credentials;
CREATE TRIGGER trg_user_credentials_touch BEFORE UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

**ทำไมไม่ใช้ `emp_id` เป็น PRIMARY KEY แทน `login_name`:** เพราะ path ล็อกอินต้อง lookup ด้วยสิ่งที่
ผู้ใช้พิมพ์ (login handle) ซึ่งอาจไม่เท่ากับ `emp_id` แล้ว (ผู้ใช้ ERP ใช้ `menuuser.user_name`)
`login_name` เป็น PK เพราะเป็นสิ่งที่ query WHERE จริง ส่วน `emp_id UNIQUE` ทำให้ sync
lookup-by-emp_id ได้เร็วเท่ากันสำหรับ upsert

### A-3. ผ่อน `users.pin_hash` เป็น nullable (ไม่ลบข้อมูล)

```sql
-- idempotent no-op ถ้า replay ซ้ำ (คอลัมน์ nullable อยู่แล้วจะไม่มี error)
ALTER TABLE users ALTER COLUMN pin_hash DROP NOT NULL;
COMMENT ON COLUMN users.pin_hash IS
  'DEPRECATED — ย้ายไป user_credentials.secret_hash เก็บไว้ชั่วคราวเป็นทางถอยฉุกเฉิน '
  'ห้ามใช้เขียนใหม่ ลบคอลัมน์นี้ในคอมมิตแยกหลัง Phase 5 เท่านั้น (ดู Cutover)';
```

`CHECK users_pin_hash_argon` (`pin_hash LIKE '$argon2id$%'`) **ไม่ต้องแก้** — ใน Postgres `NULL LIKE
'...'` ประเมินเป็น `NULL` ซึ่ง CHECK ถือว่าผ่าน (fail เฉพาะที่ประเมินเป็น `FALSE` เท่านั้น)

### A-4. Backfill legacy PIN → `user_credentials` (ท้ายไฟล์ ในบล็อก idempotent-migration เดิม)

**หัวใจของการแก้ข้อบกพร่อง #3:** ผูก backfill กับ "ยังไม่เคยมี users-sync ที่สำเร็จ" โดยอ่านจาก
`sync_runs` ที่มีอยู่แล้ว ไม่สร้างตารางสถานะใหม่ ทำให้ปิดตัวเองถาวรหลัง cutover จริงครั้งแรก:

```sql
-- Pre-flight: lowercase(emp_id) ชนกันไหม — ถ้าชนแปลว่ามีคนล็อกอินไม่ได้แน่หลัง backfill
DO $do$
DECLARE dup text;
BEGIN
  IF EXISTS (SELECT 1 FROM sync_runs WHERE kind = 'users' AND status = 'success') THEN
    RETURN; -- cutover จริงเกิดแล้ว — ไม่มีความหมายจะเช็คซ้ำ (และ users อาจมีคนที่ถูก deactivate ไปแล้ว)
  END IF;
  SELECT string_agg(l, ', ') INTO dup
    FROM (SELECT lower(emp_id) AS l FROM users GROUP BY 1 HAVING count(*) > 1) t;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'emp_id ชนกันเมื่อทำเป็นตัวพิมพ์เล็ก (%) — แก้ก่อน migrate ไม่งั้นมีคน login ไม่ได้', dup;
  END IF;
END $do$;

-- Backfill — ปิดตัวเองอัตโนมัติหลัง sync ผู้ใช้สำเร็จครั้งแรก (แก้ข้อบกพร่อง #3)
INSERT INTO user_credentials (login_name, emp_id, secret_hash, source)
SELECT lower(u.emp_id), u.emp_id, u.pin_hash, 'legacy_pin'
  FROM users u
 WHERE u.pin_hash IS NOT NULL
   AND u.pin_hash LIKE '$argon2id$%'
   AND NOT EXISTS (SELECT 1 FROM sync_runs WHERE kind = 'users' AND status = 'success')
ON CONFLICT DO NOTHING;   -- ครอบคลุมทั้ง login_name PK และ emp_id UNIQUE

-- Post-flight: การันตีไม่มีใครหลุดจากการ backfill (เฉพาะก่อน cutover จริง)
DO $do$
DECLARE missing int;
BEGIN
  IF EXISTS (SELECT 1 FROM sync_runs WHERE kind = 'users' AND status = 'success') THEN
    RETURN; -- หลัง cutover ผู้ใช้ที่ไม่มี credential แล้วคือ "ถูก deactivate ตามดีไซน์" ไม่ใช่บั๊ก
  END IF;
  SELECT count(*) INTO missing FROM users u
   WHERE u.pin_hash IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.emp_id = u.emp_id);
  IF missing > 0 THEN
    RAISE EXCEPTION 'ผู้ใช้ % คนยังไม่มีแถวใน user_credentials — deploy ต่อจะทำให้ login ไม่ได้', missing;
  END IF;
END $do$;
```

**ข้อควรระวังตอน cleanup (Phase 5, คอมมิตแยก):** เมื่อจะลบ `users.pin_hash` จริง ต้องลบทั้ง 3 ก้อนนี้
(pre-flight guard, backfill INSERT, post-flight guard) พร้อมกันในคอมมิตเดียวกัน เพราะทั้งสามอ้างอิง
คอลัมน์ที่กำลังจะหาย และ `schema.sql` ถูก replay ตลอดไป — ลืมลบจะทำให้ replay ครั้งถัดไป error ที่
คอลัมน์ไม่มีอยู่

### A-5. เพิ่ม `user_credentials` เข้า REVOKE ท้าย `schema.sql` — **ไม่ต้องทำ**

บล็อก REVOKE UPDATE/DELETE (schema.sql:741-743) ใช้กับ `count_submissions`/`audit_log` เท่านั้น
เพราะสองตารางนั้น**ต้อง append-only ที่ระดับ engine** `user_credentials` เป็นตารางที่ sync ต้อง
UPDATE/DELETE ได้ตามปกติ (ไม่ใช่ audit trail) — จงใจไม่แตะบล็อกนี้ ระบุไว้เพื่อกันคนเข้าใจผิดว่า "ลืม"

### A-6. รัน schema.sql เพื่อยืนยัน replay ปลอดภัย (dev/staging เท่านั้น — ไม่ใช่ production)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql   # ครั้งที่ 1
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql   # ครั้งที่ 2 — ต้องไม่ error
```

เกณฑ์ผ่าน: ทั้งสองครั้งจบโดยไม่มี `ERROR`, `SELECT count(*) FROM user_credentials` เท่ากันทั้งสองรอบ


## ขั้นตอนกลุ่ม B — Server auth core (`server/src/auth/`)

### B-1. `auth.types.ts` — คลาย schema โดย**ไม่แตะชื่อฟิลด์**

`server/src/auth/auth.types.ts:17-35`:

```ts
/**
 * ตัวระบุที่ใช้ล็อกอิน (login identifier) — ชื่อฟิลด์ wire คือ `empId` ตามเดิมโดยตั้งใจ
 * (fleet ไม่อัปเดตพร้อมกัน เปลี่ยนชื่อฟิลด์ = APK เก่าได้ 400 ทันที) แต่ความหมายกว้างขึ้น:
 * สำหรับผู้ใช้ legacy/local ยังเท่ากับ lower(emp_id) เดิม สำหรับผู้ใช้ ERP คือ
 * lower(menuuser.user_name) ซึ่งอาจไม่เท่ากับ users.emp_id อีกต่อไป — lookup จริงอยู่ที่
 * user_credentials.login_name ไม่ใช่ users.emp_id ตรง ๆ
 */
export const EmpIdSchema = z
  .string()
  .trim()
  .min(1, 'ต้องกรอกชื่อผู้ใช้')
  .max(64, 'ชื่อผู้ใช้ยาวเกิน 64 ตัวอักษร'); // เดิม .max(32) + regex A-Za-z0-9._- (ตัดออก — ERP username ไม่รู้รูปแบบล่วงหน้า)

/**
 * secret ของการล็อกอิน — ชื่อฟิลด์ wire ยังเป็น `pin` ตามเดิมโดยตั้งใจ (เหตุผลเดียวกับ empId)
 * ⚠️ ห้าม .trim() — ERP เทียบ a_Password แบบ string เป๊ะ ช่องว่างท้ายมีความหมาย (A4)
 */
export const SecretSchema = z
  .string()
  .min(1, 'ต้องกรอกรหัสผ่าน')
  .max(128, 'รหัสผ่านยาวเกิน 128 ตัวอักษร'); // เดิม regex ^\d{6}$ (ตัดออก)

export const LoginRequestSchema = z.object({
  empId: EmpIdSchema,     // ← ชื่อคีย์ JSON ไม่เปลี่ยน
  pin: SecretSchema,      // ← ชื่อคีย์ JSON ไม่เปลี่ยน
  deviceId: z.string().trim().min(1).max(64),
  appVersion: z.string().trim().max(32).optional(),
});
```

**ลบทั้งหมด:** `PinSchema` (เดิม, ชื่อ export เปลี่ยนเป็น `SecretSchema` — ใช้ grep ยืนยันว่าไม่มีที่
อื่น import `PinSchema` แล้วค่อยลบชื่อเดิม), `ChangePinRequestSchema` (endpoint หายไปทั้งคู่)

`AuthErrorCode` (~auth.types.ts:107-123): **คง string value เดิมทั้งหมด** (`UNKNOWN_EMPLOYEE`,
`INVALID_PIN`, `THROTTLED`, `INVALID_REFRESH`, `REFRESH_REUSED`, `ROLE_CHANGED`) **ลบเฉพาะ**
`MUST_CHANGE_PIN` (ไม่เคยถูก throw ที่ไหนจริง — ยืนยันด้วย `grep -rn "MUST_CHANGE_PIN" server/src`)

`AUTH_ERROR_MESSAGE_TH` — แก้ข้อความไทยสองค่า (code เดิม ข้อความใหม่):
```ts
UNKNOWN_EMPLOYEE: 'ไม่พบชื่อผู้ใช้นี้ · unknown user',
INVALID_PIN: 'รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง',
```

`UserProfile` (~auth.types.ts:51-58): **คง `mustChangePin: boolean` ไว้ในสัญญา wire** (ไม่ลบฟิลด์)
— server จะส่ง `false` เสมอหลังการแก้ (ดู B-2) เหตุผล: `UserProfile.fromJson` ฝั่งแอปทำ
`json['mustChangePin'] == true` (ปลอดภัยกับ `null`) แต่การคงฟิลด์ไว้คือทางเลือกที่ความเสี่ยงต่ำที่สุด
เท่ากับศูนย์ ไม่ต้องพิสูจน์ความปลอดภัยของทุกจุดที่ deserialize

### B-2. `auth.service.ts` — เปลี่ยนแหล่งอ่าน credential (`server/src/auth/auth.service.ts:104-153`)

```ts
interface UserRow {
  emp_id: string;
  name: string;
  secret_hash: string;      // เดิมชื่อ pin_hash — มาจาก user_credentials.secret_hash แล้ว
  role: Role;
  shift: string | null;
  warehouse_code: string;
  role_version: number;
  failed_attempts: number;
  throttle_until: Date | number | null;
  // ตัด must_change_pin ออกจาก interface — ไม่อ่านจาก DB อีกต่อไป (toProfile หาร์ดโค้ด false)
}

async hashPin(pin: string): Promise<string> {           // ชื่อเมธอดคงเดิม (ลด churn) — public อยู่แล้ว
  return argon2.hash(pin + this.pepper, AuthService.ARGON_OPTS);
}

async verifyPin(hash: string, pin: string): Promise<boolean> {   // ⚠️ ลบ `private` — sync ต้องเรียกได้
  try {
    return await argon2.verify(hash, pin + this.pepper);
  } catch {
    return false;
  }
}

async login(req: LoginRequest): Promise<LoginResponse> {
  const loginName = req.empId.trim().toLowerCase();
  const user = await this.db.one<UserRow>(
    `SELECT u.emp_id, u.name, u.role, u.shift, u.warehouse_code, u.role_version,
            u.failed_attempts, u.throttle_until, c.secret_hash
       FROM user_credentials c
       JOIN users u ON u.emp_id = c.emp_id
      WHERE c.login_name = $1`,
    [loginName],
  );

  if (!user) {
    await this.dummyWork();
    this.logger.warn(`login ล้มเหลว: ไม่พบชื่อผู้ใช้ (device=${req.deviceId})`);
    throw new AuthError(AuthErrorCode.UNKNOWN_EMPLOYEE);   // code เดิม — ดู B-1
  }

  this.assertNotThrottled(user);                            // ← ไม่เปลี่ยน ยังรันก่อน verify เสมอ

  const ok = await this.verifyPin(user.secret_hash, req.pin);
  if (!ok) {
    const retryAfterMs = await this.registerFailure(user);
    throw new AuthError(AuthErrorCode.INVALID_PIN, undefined, retryAfterMs);  // code เดิม
  }

  await this.db.query(
    `UPDATE users SET failed_attempts = 0, throttle_until = NULL, updated_at = now()
      WHERE emp_id = $1`,
    [user.emp_id],
  );
  await this.touchDevice(req.deviceId, user.emp_id, req.appVersion);   // ← ไม่เปลี่ยน (สำคัญ: ขั้น F-2 ใช้ข้อมูลนี้)

  const tokens = await this.issueTokens(user, req.deviceId);
  return { ...tokens, user: AuthService.toProfile(user) };
}
```

`toProfile` (~auth.service.ts:452-461): ลบบรรทัด `mustChangePin: u.must_change_pin,` แทนด้วย
`mustChangePin: false,` ตรง ๆ (ดูเหตุผลที่ B-1)

**ทุกจุดที่ไม่เปลี่ยนเลย (ยืนยันแล้วว่าไม่ต้องแตะ):** `dummyWork()`, `assertNotThrottled()`,
`registerFailure()` (SQL คำนวณ delay แบบ atomic — คีย์ด้วย `emp_id` ซึ่งยังมาจาก JOIN เหมือนเดิม),
`throttleUntilMs()`, `issueTokens()`, refresh/rotation/reuse-detection ทั้งหมด (ไม่มีการพึ่งพา
credential shape เลย)

### B-3. `auth.service.ts` — ลบ `changePin()` และ import ที่ไม่ใช้แล้ว

ลบทั้งเมธอด `changePin()` (~auth.service.ts:360-395), ลบ `import { WEAK_PIN_MESSAGE_TH, isWeakPin }
from './pin-policy';` (บรรทัดบนสุดของไฟล์)

### B-4. `auth.controller.ts` — ลบ endpoint `change-pin`

ลบทั้งเมธอด `changePin()` (~auth.controller.ts:76-91) และ import `ChangePinRequestSchema`
ที่เหลือ `login`, `refresh`, `logout` เหมือนเดิมทุกบรรทัด (ไม่แตะ)

### B-5. ยืนยันด้วยเทสต์เดิมก่อนไปกลุ่มถัดไป

```bash
cd server && npm run build && npm run test:unit
```
เกณฑ์ผ่าน: build สะอาด เทสต์ที่ไม่แตะ DB (auth-crypto.spec.ts) ยังผ่านทั้งหมด — เทสต์ที่แตะ DB
(`auth-integration.spec.ts`) ยังไม่ต้องผ่านตอนนี้ (ยังไม่มีตาราง `user_credentials` ในเทสต์ setup —
แก้ในกลุ่มทดสอบท้ายไฟล์นี้)


## ขั้นตอนกลุ่ม C — ERP Sync (`server/src/erp/`, `server/src/sync/`, `server/src/config/`)

### C-1. `server/src/erp/erp-secret.ts` (ไฟล์ใหม่) — กันพลาดพิมพ์ plaintext รั่ว

```ts
/** ห่อ plaintext ของ ERP ไม่ให้หลุดผ่าน template literal / JSON.stringify / logger โดยไม่ตั้งใจ */
export class ErpSecret {
  private constructor(private readonly value: string) {}
  static of(value: string): ErpSecret {
    return new ErpSecret(value);
  }
  /** จุดเดียวที่ดึงค่าออกได้ — ผู้เรียกต้องส่งเข้า argon2 ทันที ห้ามเก็บผลลัพธ์ไว้เป็นตัวแปรแยก */
  expose(): string {
    return this.value;
  }
  toString(): string {
    return '[ErpSecret]';
  }
  toJSON(): string {
    return '[ErpSecret]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[ErpSecret]';
  }
}
```

### C-2. `erp-adapter.ts` — เพิ่ม `fetchUsers()` เข้า interface (server/src/erp/erp-adapter.ts:106-135)

```ts
export interface ErpUserRow {
  loginName: string;   // menuuser.user_name (ยังไม่ normalize)
  password: ErpSecret;  // menuuser.a_Password
  userLevel: string;    // menuuser.user_level (raw — เก็บไว้ตอบ U1)
  nameThai: string;     // menuuser.name_thai
  empCode: string;       // menuuser.emp_id (anchor ของ users.emp_id — ดู U3)
}

export interface ErpAdapter {
  // ...เดิมทั้งหมดไม่เปลี่ยน...

  /**
   * อ่านผู้ใช้ทั้งหมดจาก menuuser — ยังเป็น SELECT ล้วน ชื่อขึ้นต้น `fetch` ให้ผ่าน
   * WriteishMethodName (erp-adapter.ts:138) เหมือน fetchItemsBySku
   * คืนอาเรย์เดียว (ไม่ stream) — จำนวนผู้ใช้อยู่หลักร้อย และ deactivation sweep ต้องเห็นชุดครบ
   */
  fetchUsers(): Promise<ErpUserRow[]>;
}
```

เพิ่ม `abstract fetchUsers(): Promise<ErpUserRow[]>;` ใน `BaseErpDriver` (~erp-adapter.ts:408-410)

### C-3. `drivers/mssql.driver.ts` — implement `fetchUsers()`

```ts
private usersSqlCache?: string;

private static readonly DEFAULT_USERS_SQL = `
  SELECT user_name  AS login_name,
         a_Password AS password,
         user_level AS user_level,
         name_thai  AS name_thai,
         emp_id     AS emp_code
    FROM menuuser WITH (NOLOCK)
   ORDER BY user_name`;
// ⚠️ ตัด LEFT JOIN Employee + EmpPict ทั้งก้อนตามที่ query ต้นฉบับผู้ใช้ให้มา (U5 — ดูเหตุผลในแผน)
// ⚠️ ไม่มี WHERE กรองคลัง/แผนกเลย — เป็น known-tradeoff ที่แก้ด้วย allowlist ระดับ role map (C-4)
//    ไม่ใช่ด้วย SQL filter (U4/U7 ยังไม่มีคอลัมน์ให้กรอง)

async fetchUsers(): Promise<ErpUserRow[]> {
  const text = this.loadUsersSqlFile();  // ใช้ DEFAULT_USERS_SQL ถ้าไม่ตั้ง ERP_SQL_USERS_SQL_FILE
  const rows = await this.runQuery('users-script', text, {});
  return rows.map((row) => {
    const normalized = this.normalizeRow(row);  // ← decodeThai วิ่งผ่านทุกคอลัมน์เหมือน items
    return {
      loginName: String(normalized.login_name ?? ''),
      password: ErpSecret.of(String(normalized.password ?? '')),  // ห่อทันทีที่ข้าม boundary
      userLevel: String(normalized.user_level ?? ''),
      nameThai: String(normalized.name_thai ?? ''),
      empCode: String(normalized.emp_code ?? ''),
    };
  });
}

private loadUsersSqlFile(): string {
  if (this.usersSqlCache) return this.usersSqlCache;
  const path = this.sqlCfg.usersSqlFile;
  let text = path ? readFileSync(path, 'utf8').replace(/^﻿/, '').trim()
                   : MssqlErpDriver.DEFAULT_USERS_SQL.trim();
  if (text.length === 0) {
    throw new MssqlDriverError('ERP_CONFIG', `ไฟล์ ERP_SQL_USERS_SQL_FILE ว่างเปล่า: ${path}`);
  }
  assertReadOnlySql(text);   // ชั้นที่ 3 เดียวกับ items — บังคับแม้ override มาจากไฟล์ config
  this.usersSqlCache = text;
  return text;
}
```

### C-4. `drivers/mock.driver.ts` — implement `fetchUsers()` สำหรับเทสต์/dev

คืนอาเรย์ fixture คงที่ (เช่น 3-5 แถวจำลอง user_level ที่หลากหลาย รวมค่าที่ไม่ map ไว้เจตนา 1 ค่า
เพื่อให้เทสต์ allowlist มีอะไรให้ยืนยัน)

### C-5. `env.config.ts` — config keys ใหม่ (~server/src/config/env.config.ts, ใกล้ ERP_SQL_* บล็อก)

```ts
ERP_SQL_USERS_SQL_FILE: envStr('พาธไฟล์ .sql override สำหรับดึงผู้ใช้ เช่น /config/menuuser.sql', {
  max: 512, pattern: ABS_SQL_FILE_RE,
}).optional(),

ERP_USER_SYNC_ENABLED: envBool(false,
  'เปิด sync ผู้ใช้จาก ERP จริง — เปิดหลัง Phase 0-2 ผ่านเท่านั้น (ดู PLAN)'),

ERP_USER_SYNC_CRON: envStr('cron expression ของรอบ sync ผู้ใช้', { pattern: CRON_RE })
  .default('17 * * * *'),  // offset จาก items */30 กัน ERP_SQL_POOL_MAX=3 ชนกัน

/** "level=role,level=role" — level ที่ไม่ระบุ = ไม่ได้บัญชีเลย (allowlist, ไม่ fallback viewer) */
ERP_USER_LEVEL_ROLE_MAP: envStr('เช่น 9=admin,5=staff,1=viewer').optional(),

ERP_USER_DEACTIVATE_MAX_PCT: envInt({
  min: 1, max: 100, default: 10,
  hint: 'เพดาน % ของ credential (erp+legacy_pin) ที่ลบได้ต่อรอบ sync',
}),

/** ไม่มี default — บังคับตั้งเมื่อ ERP_USER_SYNC_ENABLED=true (ตรวจใน cross-field validator) */
ERP_USER_MIN_EXPECTED_ROWS: envInt({ min: 1, max: 100_000 }).optional(),
```

Cross-field validator (~env.config.ts, ใกล้ `checkSqlSource` เดิม):

```ts
if (config.ERP_USER_SYNC_ENABLED) {
  if (!config.ERP_USER_LEVEL_ROLE_MAP?.trim()) {
    addIssue('ERP_USER_LEVEL_ROLE_MAP',
      'ต้องตั้งเมื่อ ERP_USER_SYNC_ENABLED=true (ว่าง = sync ปฏิเสธการรันเสมอ — ตั้งใจ fail-safe)');
  }
  if (config.ERP_USER_MIN_EXPECTED_ROWS === undefined) {
    addIssue('ERP_USER_MIN_EXPECTED_ROWS',
      'ต้องตั้งเมื่อ ERP_USER_SYNC_ENABLED=true — ใช้ผลจาก npm run verify:erp-users (Phase 0)');
  }
}
```

**นี่คือด่านที่แข็งกว่า runtime check:** ถ้า map ว่างหรือไม่ตั้งเพดานแถวขั้นต่ำ **เซิร์ฟเวอร์บูตไม่ขึ้น
เลย** ไม่ใช่แค่ sync ข้ามรอบเงียบ ๆ

### C-6. `sync.module.ts` — widen `SyncKind` + `LOCK_KEY` (server/src/sync/sync.module.ts:66,105)

```ts
export type SyncKind = 'items' | 'users';   // เดิมมีแค่ 'items'

const LOCK_KEY: Readonly<Record<SyncKind, number>> = {
  items: 872_001,
  users: 872_002,   // คนละ key จาก items — รอบ users ไม่บล็อกรอบ items และกลับกัน
};
```

Import `AuthService` (จาก `AuthModule`) และ `ErpAdapter`/`ErpUserRow`/`ErpSecret` เข้า
`SyncModule`/`SyncService` — ต้องเพิ่ม `AuthModule` เข้า `imports` ของ `SyncModule` (ยืนยันด้วย
`grep -n "imports:" server/src/sync/sync.module.ts` ว่ายังไม่มีอยู่ก่อนแก้)

ลงทะเบียน cron ตัวที่สองใน `onModuleInit` มิเรอร์ของเดิม (~sync.module.ts:205-215) โดยอ่าน
`ERP_USER_SYNC_CRON` และ**ลงทะเบียนเฉพาะเมื่อ `ERP_USER_SYNC_ENABLED=true`** (ตรงข้ามกับ items
ที่ลงทะเบียนเสมอ — นี่คือสวิตช์คัตโอเวอร์ตัวจริง)

### C-7. `sync.module.ts` — `runUsers()` (เมธอดใหม่ มิเรอร์ `runItems()` ที่ ~sync.module.ts:244-315)

อัลกอริทึมต่อรอบ (pseudocode ระดับ SQL จริง — implement ตรงตามนี้):

```ts
private async runUsers(triggeredBy: string): Promise<SyncRunResult> {
  const runId = await this.startRun('users', triggeredBy);
  const anomalies: unknown[] = [];
  try {
    // ── ด่าน 0: ต้องมี break-glass admin อยู่แล้วก่อนแตะอะไรเลย (แก้ข้อบกพร่อง #4/#7) ──
    const hasLocalAdmin = await this.db.query(
      `SELECT 1 FROM user_credentials c JOIN users u ON u.emp_id = c.emp_id
        WHERE c.source = 'local' AND u.role = 'admin' LIMIT 1`,
    );
    if (hasLocalAdmin.rowCount === 0) {
      return this.finishRun(runId, {
        status: 'failed',
        error: 'ไม่มีบัญชี local admin (break-glass) เลย — รัน npm run create-admin ก่อน sync ผู้ใช้',
        rowsRead: 0, rowsUpserted: 0, rowsTombstoned: 0, anomalies,
      });
    }

    const roleMap = this.parseRoleMap(this.cfg.ERP_USER_LEVEL_ROLE_MAP); // Map<string, Role>
    const rows = await this.erp.fetchUsers();
    const minExpected = this.cfg.ERP_USER_MIN_EXPECTED_ROWS;
    const rowCountOk = rows.length >= minExpected;

    const seenEmpIds = new Set<string>();     // เฉพาะแถวที่ผ่าน validation + มี role mapped
    const seenLoginNames = new Set<string>(); // กันชนกันเองภายในรอบเดียว
    const unmappedLevelsSeen = new Set<string>();
    let upserted = 0;

    for (const row of rows) {
      const login = row.loginName.trim().toLowerCase();
      const empCode = row.empCode.trim();
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(empCode) || login.length === 0 || login.length > 64
          || row.password.expose().includes('�')) {
        anomalies.push({ type: 'rejected_row', empCode, login });
        continue;
      }
      if (seenLoginNames.has(login)) {
        anomalies.push({ type: 'duplicate_login', login });
        continue;
      }
      seenLoginNames.add(login);

      const mappedRole = roleMap.get(row.userLevel);
      if (!mappedRole) {
        // ── Allowlist ล้วน (แก้ข้อบกพร่อง #5) — ไม่ได้บัญชีเลย ไม่ fallback viewer ──
        if (!unmappedLevelsSeen.has(row.userLevel)) {
          unmappedLevelsSeen.add(row.userLevel);
          await this.audit('scheduler', 'users.erp_level_unmapped', { userLevel: row.userLevel });
        }
        continue;
      }
      seenEmpIds.add(empCode);

      await this.db.transaction(async (client) => {
        // ── ล็อกเป้าหมาย + admin ทุกคนพร้อมกัน เหมือน MembersService.changeRole เป๊ะ ──
        // (แก้ข้อบกพร่อง #8 — ไม่พึ่ง RETURNING เปรียบเทียบ role เก่า/ใหม่อีกต่อไป)
        const locked = await client.query<{ emp_id: string; role: Role }>(
          `SELECT emp_id, role FROM users WHERE emp_id = $1 OR role = 'admin'
            ORDER BY emp_id FOR UPDATE`,
          [empCode],
        );
        const current = locked.rows.find((r) => r.emp_id === empCode);
        const fromRole = current?.role ?? null;
        const adminCountExcluding = locked.rows.filter(
          (r) => r.role === 'admin' && r.emp_id !== empCode,
        ).length;

        // ── ด่าน last-admin ต่อแถว (แก้ข้อบกพร่อง #4) ──
        let effectiveRole = mappedRole;
        let blockedByFloor = false;
        if (fromRole === 'admin' && mappedRole !== 'admin' && adminCountExcluding === 0) {
          effectiveRole = 'admin';
          blockedByFloor = true;
        }

        if (!current) {
          await client.query(
            `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
             VALUES ($1, $2, $3::user_role, $4, $5, false)`,
            [empCode, row.nameThai, effectiveRole, DEFAULT_SHIFT, this.warehouseCode],
          );
        } else {
          await client.query(
            `UPDATE users SET name = $2, role = $3::user_role,
                    role_version = role_version + CASE WHEN role <> $3::user_role THEN 1 ELSE 0 END,
                    updated_at = now()
              WHERE emp_id = $1
                AND (name IS DISTINCT FROM $2 OR role IS DISTINCT FROM $3::user_role)`,
            [empCode, row.nameThai, effectiveRole],
          );
        }

        if (blockedByFloor) {
          await client.query(AUDIT_SQL,
            ['scheduler', 'users.erp_last_admin_floor_blocked',
             JSON.stringify({ empId: empCode, attemptedRole: mappedRole })]);
        } else if (fromRole && fromRole !== effectiveRole) {
          if (ROLE_RANK[effectiveRole] < ROLE_RANK[fromRole]) {
            await client.query(REVOKE_ALL_SQL, [empCode]);   // ← จุดที่บั๊กเดิมไม่เคยทำงาน
          }
          await client.query(AUDIT_SQL,
            ['scheduler', 'users.erp_role_changed',
             JSON.stringify({ empId: empCode, from: fromRole, to: effectiveRole })]);
        }

        // ── credential upsert (source='local' ห้ามแตะเด็ดขาด) ──
        const cred = await client.query<{ source: string; secret_hash: string }>(
          `SELECT source, secret_hash FROM user_credentials WHERE emp_id = $1 FOR UPDATE`,
          [empCode],
        );
        const existing = cred.rows[0];
        if (existing?.source === 'local') {
          // no-op — break-glass ไม่ถูก sync แตะ
        } else if (!existing) {
          const hash = await this.auth.hashPin(row.password.expose());
          await client.query(
            `INSERT INTO user_credentials
               (login_name, emp_id, secret_hash, source, erp_user_level, erp_last_seen_at)
             VALUES ($1, $2, $3, 'erp', $4, now())`,
            [login, empCode, hash, row.userLevel],
          );
          await client.query(AUDIT_SQL,
            ['scheduler', 'users.erp_created',
             JSON.stringify({ empId: empCode, loginName: login, userLevel: row.userLevel })]);
        } else {
          const ok = await this.auth.verifyPin(existing.secret_hash, row.password.expose());
          if (ok) {
            await client.query(
              `UPDATE user_credentials
                  SET login_name = $1, erp_user_level = $2, erp_last_seen_at = now(),
                      source = 'erp', updated_at = now()
                WHERE emp_id = $3`,
              [login, row.userLevel, empCode],
            );
          } else {
            const hash = await this.auth.hashPin(row.password.expose());
            await client.query(
              `UPDATE user_credentials
                  SET login_name = $1, secret_hash = $2, secret_rotated_at = now(),
                      erp_user_level = $3, erp_last_seen_at = now(), source = 'erp', updated_at = now()
                WHERE emp_id = $4`,
              [login, hash, row.userLevel, empCode],
            );
            await client.query(REVOKE_ALL_SQL, [empCode]);   // รหัสผ่านเปลี่ยนที่ ERP → ตัดเซสชันเก่าทั้งหมด
            await client.query(AUDIT_SQL,
              ['scheduler', 'users.erp_secret_rotated', JSON.stringify({ empId: empCode })]);
          }
        }
      });
      upserted++;
    }

    // ── Deactivation + legacy-pin retirement รวมเป็น sweep เดียว (แก้ข้อบกพร่อง #2/#6) ──
    let tombstoned = 0;
    if (rowCountOk) {
      const doomed = await this.db.query<{ login_name: string; emp_id: string }>(
        `SELECT login_name, emp_id FROM user_credentials
          WHERE source IN ('erp', 'legacy_pin') AND emp_id <> ALL($1::text[])`,
        [[...seenEmpIds]],
      );
      const live = await this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_credentials WHERE source IN ('erp', 'legacy_pin')`,
      );
      const ratio = live.n > 0 ? doomed.rowCount / live.n : 0;
      if (doomed.rowCount > 0 && ratio <= this.cfg.ERP_USER_DEACTIVATE_MAX_PCT / 100) {
        for (const d of doomed.rows) {
          await this.db.transaction(async (client) => {
            await client.query(`DELETE FROM user_credentials WHERE login_name = $1`, [d.login_name]);
            await client.query(REVOKE_ALL_SQL, [d.emp_id]);
            await client.query(AUDIT_SQL,
              ['scheduler', 'users.erp_deactivated',
               JSON.stringify({ empId: d.emp_id, loginName: d.login_name })]);
          });
          tombstoned++;
        }
      } else if (doomed.rowCount > 0) {
        anomalies.push({ type: 'deactivate_guardrail_blocked', doomed: doomed.rowCount, live: live.n, ratio });
      }
    } else {
      anomalies.push({ type: 'row_count_below_floor', rowsRead: rows.length, minExpected });
    }

    return this.finishRun(runId, {
      status: rowCountOk ? 'success' : 'partial',
      rowsRead: rows.length, rowsUpserted: upserted, rowsTombstoned: tombstoned, anomalies,
    }, { setStockAsOf: false });   // รอบ users ไม่แตะป้าย "ข้อมูล ณ HH:MM" ของสต็อก
  } catch (err) {
    return this.finishRun(runId, { status: 'failed', error: errorMessage(err), anomalies });
  }
}

private tick(kind: SyncKind): void {  // ของเดิมต้องแตกสาขาไปเรียก runUsers ด้วย
  if (kind === 'users') { void this.withLock('users', 'scheduler', (by) => this.runUsers(by)); return; }
  // ...ของเดิมสำหรับ 'items'...
}
```

`finishRun` ต้องรับพารามิเตอร์ตัวเลือกที่ 3 ใหม่ `{ setStockAsOf?: boolean }` (default `true` เพื่อไม่
กระทบ `runItems` เดิม) แล้ว**ข้าม**การเขียน `stock_as_of` เมื่อเป็น `false` — มิฉะนั้นป้าย
"ข้อมูล ณ HH:MM" ของ `GET /sync/status` จะโกหกว่าสต็อกเพิ่งอัปเดตทั้งที่รอบนี้คือรอบผู้ใช้

`parseRoleMap(raw)`: แยก `"9=admin,5=staff,1=viewer"` เป็น `Map<string, Role>` ด้วย
`RoleSchema.safeParse` ต่อค่า — ถ้า parse fail ให้โยน error ตั้งแต่ตอนอ่าน config ไม่ใช่ตอนรัน sync
(เสริมด่านที่ C-5 คุมไว้แล้วในชั้น boot)

### C-8. `POST /sync/users` — endpoint trigger มือ (มิเรอร์ items trigger ที่มีอยู่แล้วใน `sync.module.ts`)

`@Roles('admin')` + `@RequireFreshRole()` เหมือน endpoint items เดิม เรียก
`this.sync.withLock('users', user.empId, (by) => this.sync.runUsers(by))` คืนผลเป็น `SyncRunResult`
เดียวกับ items


## ขั้นตอนกลุ่ม D — Members / CLI / cleanup

### D-1. `members.module.ts` — ลบสอง endpoint, แก้หนึ่ง

ลบ `@Post() create(...)` ทั้งเมธอด (~members.module.ts:64-79) และ `@Post(':empId/reset-pin')`
ทั้งเมธอด (~members.module.ts:102-111) ลบ `MemberCreateSchema`/`MemberCreatedDto` export ที่ไม่มีใคร
ใช้แล้วออกจาก `members.service.ts`

แก้ `@Patch(':empId/role') changeRole(...)` (~members.module.ts:81-97): ก่อนเรียก
`this.members.changeRole(...)` เพิ่มเช็ค:

```ts
const credSource = await this.members.credentialSourceOf(empId);
if (credSource === 'erp') {
  throw new BadRequestException({
    code: 'ERP_MANAGED',
    message: 'บัญชีนี้ผูกกับ ERP — แก้สิทธิ์ที่ระบบ ERP แล้วรอ sync รอบถัดไป',
  });
}
```

### D-2. `members.service.ts` — เพิ่ม `credentialSourceOf`, ลบ `create`/`resetPin`/`randomPin`

```ts
async credentialSourceOf(empId: string): Promise<string | null> {
  const row = await this.db.query<{ source: string }>(
    `SELECT source FROM user_credentials WHERE emp_id = $1`, [empId],
  );
  return row.rows[0]?.source ?? null;
}
```

ลบ `create()` (~members.service.ts:140-170), `resetPin()` (~members.service.ts:261-300),
`randomPin()` (~members.service.ts:312-...) — `changeRole()`/`list()` **ไม่แตะ** (ยังทำงานกับ
`users` ตรง ๆ เหมือนเดิมทุกบรรทัด)

### D-3. `server/src/cli/create-admin.ts` — แก้บั๊ก runtime + เขียน `user_credentials`

**แก้บั๊กที่ทำให้ break-glass ใช้จริงไม่ได้ (ข้อบกพร่อง #7):** `server/package.json` scripts:
```diff
- "create-admin": "ts-node src/cli/create-admin.ts",
+ "create-admin": "node dist/cli/create-admin.js",
```
(ตรงกับที่คอมเมนต์ในไฟล์เดิมคาดไว้อยู่แล้วที่บรรทัด 4-5 ของ `create-admin.ts` — เป็นการแก้ไฟล์ที่
เขียนไม่ตรงกับ intent เดิม ไม่ใช่ฟีเจอร์ใหม่) ยืนยันว่า `nest build` คอมไพล์ไฟล์นี้จริงจาก
`tsconfig.json` (`include: ["src/**/*"]`, `nest-cli.json.sourceRoot: "src"` — ไม่มี exclude เจาะจง
ไฟล์ cli)

แก้ตัว logic ให้เขียนทั้งสองตาราง (แทนที่การเขียนแค่ `users.pin_hash`):

```ts
// ในทรานแซกชันเดียว: INSERT users (เหมือนเดิม) + INSERT user_credentials source='local'
await client.query(
  `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
   VALUES ($1, $2, 'admin', $3, $4, false)`,   // must_change_pin=false เสมอ (แนวคิดนี้ตายแล้ว)
  [empId, name, shift ?? null, config.WAREHOUSE_CODE],
);
const secretHash = await argon2.hash(pin + config.PIN_PEPPER, ARGON_OPTS);
await client.query(
  `INSERT INTO user_credentials (login_name, emp_id, secret_hash, source)
   VALUES ($1, $2, $3, 'local')
   ON CONFLICT (login_name) DO UPDATE
     SET secret_hash = EXCLUDED.secret_hash, secret_rotated_at = now(), source = 'local'`,
  [empId.toLowerCase(), empId, secretHash],
);
```

`isGuessablePin`/`USAGE` text แก้ถ้อยคำที่อ้างถึง "PIN" ให้ตรงกับความจริง (ยังเป็น secret ที่ operator
กำหนดเอง ไม่ผูกกับ 6 หลักอีกต่อไปในทางเทคนิค แต่ยังแนะนำ 6 หลักในคำแนะนำการใช้เพื่อไม่ต้องเปลี่ยน
`isGuessablePin`)

### D-4. ลบ `pin-policy.ts` และ spec คู่กัน

ลบ `server/src/auth/pin-policy.ts` ทั้งไฟล์ (ไม่มี caller เหลือหลัง B-3/D-3) และ
`server/test/pin-policy.spec.ts` ทั้งไฟล์


## ขั้นตอนกลุ่ม E — App (`app/lib/`)

### E-1. `app/lib/state/app_state.dart` — ปรับ field/method (ตัด keypad ทิ้ง)

```diff
- void setEmpId(String v) { final digits = v.replaceAll(RegExp(r'[^0-9]'), ''); ... }
+ void setEmpId(String v) { state = state.copyWith(empId: v.trim(), loginError: false); }
```
(ชื่อเมธอด/ฟิลด์ `empId` **คงเดิมทั้งคู่** — เปลี่ยนแค่ตัวกรอง ให้ตรงกับ B-1 ที่ wire ไม่เปลี่ยนชื่อ)

ลบ `pressKey()` (~app_state.dart:262-269) แทนด้วย:
```dart
void setPassword(String v) { state = state.copyWith(pin: v, loginError: false); }
```
(ชื่อฟิลด์ `pin` ใน `AppState` **คงเดิม** ด้วยเหตุผลเดียวกัน — เปลี่ยนแค่วิธีตั้งค่า)

Pre-flight ก่อนเรียก `signIn()` (~app_state.dart:284-298): แก้เงื่อนไข `pin.length < 6` →
`pin.isEmpty` (คงกติกา "ปฏิเสธ secret ว่างเสมอ" ตาม design-fidelity.md:234) แก้ข้อความ default/pre-
flight สามจุด (~:35, :284, :298) ให้พูดถึง "ชื่อผู้ใช้/รหัสผ่าน" แทน "รหัสพนักงาน/PIN"

ลบ `mustChangePin` field/`pinChanged()` (~:51,:108,:230,:389) — server ส่ง `false` เสมอแล้ว
(B-2) ฝั่งแอปไม่ต้องมี state สำหรับมันอีก

`_signInWithFixtures()` (~:349-377): เงื่อนไข PIN 6 หลักเปลี่ยนเป็นแค่ "ไม่ว่าง" (ไม่ผูกความยาว)
— ยังคง match `empId` กับ fixture roster เหมือนเดิม ไม่แตะ `warehouseCode` (คงพฤติกรรมเดิม)

### E-2. `app/lib/features/login/login_screen.dart` — แทนที่ keypad ด้วยฟอร์ม

ลบ `_Keypad`, `_KeypadKey`, `_PinCells`, ตัวนับ `${state.pin.length}/6`, ป้าย `'รหัส PIN · 6 หลัก'`
(~login_screen.dart:231-251, 279-386 — ประมาณ 100 บรรทัด) ลบ `keyboardType: TextInputType.number,
maxLength: 6,` ของช่อง empId (~:222-223) เปลี่ยนป้ายเป็น `'ชื่อผู้ใช้ · Username'`

เพิ่มช่องรหัสผ่านช่องใหม่ ใช้สแต็กเดิมทุกอย่าง (ไม่มีโทเคนใหม่):
```dart
FieldBox(
  height: TclTokens.hInput, radius: TclTokens.rInput, focused: passwordFocused,
  child: Focus(
    onKeyEvent: (node, event) => _onPasswordKey(event),   // ← ดู E-6 (กันเครื่องยิง)
    child: TokenTextField(
      controller: passwordCtrl, obscure: true, maxLength: 128,
      style: TclTokens.body15(), onChanged: controller.setPassword,
    ),
  ),
)
```
(`TokenTextField.obscure` มีอยู่แล้วที่ `common.dart:263,282` ไม่มี call site ใช้มาก่อน — ไม่ต้องแก้
widget ที่ใช้ร่วม)

ลบโทเคนที่กลายเป็นขยะจาก `tcl_tokens.dart`: `hPinCell`, `rPinCell`, `hKeypadKey`, `rKeypad`,
`keypadKey()` (ยืนยันด้วย grep ว่าไม่มีที่อื่นอ้างถึงก่อนลบ)

### E-3. `app/lib/core/widgets/common.dart` — `FieldBox` เพิ่ม error state

`FieldBox` เดิม border เป็น `focused ? accent : b15` (~common.dart:324-326) เพิ่มพารามิเตอร์
`error: bool = false` แล้วให้ `error ? TclTokens.errorBorder : (focused ? accent : b15)`
(`errorBorder` เดิมใช้กับ PIN cells ที่ถูกลบไปแล้ว — ย้ายมาที่นี่แทนที่จะทิ้ง)

### E-4. `app/lib/data/auth_repository.dart` — ตัด `mustChangePin` ออกจากโมเดล (ไม่ตัดจาก wire)

`UserProfile` (~:29-70): ลบ field `mustChangePin` ออกจาก **class ฝั่ง Dart** (ไม่ต้องอ่านอีกต่อไป)
`fromJson` เลิกอ่านคีย์นี้ (ปลอดภัย — server ยังส่งมา แต่ฝั่งแอปเลือกไม่ใช้) เพิ่ม guard ว่างของ
`warehouseCode`: `final wh = _asString(json['warehouseCode']); warehouseCode: wh.isEmpty ? null : wh,`
(กัน `'คลัง '` ที่มีช่องว่างค้าง — ดู U4/U7)

รวม `_kAppVersion` (auth_repository.dart:18) กับ `ApiConfig.appVersion` (api_client.dart:44-48) เป็น
ค่าเดียว **และบัมพ์ค่า** จาก `'4.0.0'` เป็น `'5.0.0'` (เวอร์ชันของฟอร์มล็อกอินใหม่นี้) — ค่านี้คือ
สิ่งที่ขั้น F-2 (fleet readiness) จะเทียบกับ `devices.app_version`

### E-5. `app/lib/data/api_client.dart` — ไม่แตะ error code constants

`codeUnknownEmployee`, `codeInvalidPin` (~:260-264) **คงชื่อ/ค่าเดิมทั้งคู่** (ตรงกับ B-1 — server ไม่
เปลี่ยน code string) ลบเฉพาะ `codeMustChangePin` ที่ไม่มีใครเช็คแล้ว (optional cleanup — ไม่ลบก็ไม่มี
ผลเสีย เพราะไม่มี branch ไหนอ่านมันอีก)

### E-6. `login_screen.dart` — ด่านกันเครื่องยิงบาร์โค้ดที่ช่องรหัสผ่าน (แก้ข้อบกพร่อง #9)

```dart
final _passwordScanBuffer = HandheldScanBuffer();  // import จาก handheld_scan_buffer.dart — ไม่แก้คลาสนั้นเลย

KeyEventResult _onPasswordKey(KeyEvent event) {
  final result = _passwordScanBuffer.feed(event, now: DateTime.now());
  if (result.swallow) {
    return KeyEventResult.handled;   // กันไม่ให้ตัวอักษรของเครื่องยิงถึงช่อง TextField เลย
  }
  if (result.code != null) {
    // burst จบแล้ว (มี Enter ปิดท้ายหรือครบเงื่อนไข) — ล้างช่องทั้งหมด ไม่เชื่อว่าเป็นรหัสผ่านจริง
    passwordCtrl.clear();
    controller.setPassword('');
    _toast('ตรวจพบการสแกนขณะกรอกรหัสผ่าน · กรุณาพิมพ์ด้วยตนเอง');
    return KeyEventResult.handled;
  }
  return KeyEventResult.ignored;   // จังหวะคน — ปล่อยให้ TextField รับตามปกติ
}
```
ไม่ต้องมีกลไก snapshot/restore แบบ `scan_screen.dart` เพราะช่องรหัสผ่านไม่มี "ค่าที่ถูกต้องให้กู้คืน" —
กลืนแล้วล้างคือพฤติกรรมที่ถูกต้องที่สุดสำหรับหน้านี้โดยเฉพาะ

### E-7. `app/lib/main.dart` — ลบ branch `mustChangePin`

`TclRoot` (~:122-133): ลบ `else if (mustChangePin) { screen = ChangePinScreen(...) }` เหลือแค่
`signedIn ? AppShell() : LoginScreen()`

### E-8. ลบ `app/lib/features/login/change_pin_screen.dart` ทั้งไฟล์ (506 บรรทัด)

### E-9. `docs/design-fidelity.md` — แก้ §2.1, §6 แถว 1-3, §8 แถว 2

§2.1 (บรรทัด ~108-112): แทนคำอธิบาย keypad 12 ปุ่มด้วยคำอธิบายฟอร์ม username/password + ด่าน
กันเครื่องยิง (E-6) §6 แถว 1-3 (~234-236): แก้ที่มาของค่าเริ่มต้นช่อง (ไม่มี pre-fill "52104" อีกแล้ว
— ตัด axis ทิ้งตามที่ §8 แถว 2 (~267) เปิดทางเลือกไว้แล้วว่า "ถ้าไม่ใช้จริง ตัด axis ทิ้งทั้งอัน")


## ขั้นตอนกลุ่ม F — Ops / Deploy / Recon scripts

### F-1. `server/scripts/verify-erp-users.ts` (ไฟล์ใหม่ — มิเรอร์ `verify-erp.ts` เดิม)

รันตรงกับ ERP (read-only) พิมพ์ผลตรง ๆ ให้คนอ่าน **ไม่เขียนอะไรลง Postgres ของเรา**:
- `user_level` ทุกค่าที่พบ + จำนวนแถวต่อค่า (ตอบ U1)
- `emp_id` กี่ % ที่ผ่าน `^[A-Za-z0-9._-]{1,32}$` และรายชื่อที่ไม่ผ่าน (ตอบ U3 ส่วนรูปแบบ)
- เทียบ `menuuser.emp_id` กับ `users.emp_id` ที่มีอยู่แล้วในเรา (ผ่าน `DATABASE_URL`) — พิมพ์ %
  ที่ตรงกัน (ตอบ U3 ส่วน identity)
- `user_name` ที่ชนกันแบบไม่สนตัวพิมพ์เล็ก-ใหญ่ (case-insensitive collision)
- จำนวนแถวที่ `a_Password` มี U+FFFD (สัญญาณ charset ผิด)
- จำนวนแถวรวม (ใช้ตั้งค่า `ERP_USER_MIN_EXPECTED_ROWS`)

Script `package.json`: `"verify:erp-users": "ts-node scripts/verify-erp-users.ts"`

### F-2. `server/scripts/verify-fleet-readiness.ts` (ไฟล์ใหม่ — คุม Phase 3, ไม่แตะ ERP เลย)

```ts
// ยิงตรงกับ Postgres ของเราเอง อ่าน devices ที่ยังทำงานอยู่ (14 วันล่าสุด)
const stale = await pool.query(
  `SELECT device_id, app_version, last_seen_at FROM devices
    WHERE last_seen_at > now() - interval '14 days'
      AND (app_version IS NULL OR app_version <> $1)`,
  [targetVersion],   // ค่าเริ่มต้นอ่านจาก APP_MIN_VERSION (ให้ config ที่เคยตายมีความหมายจริง)
);
if (stale.rowCount > 0) {
  console.log(`ยังไม่พร้อม — เครื่อง ${stale.rowCount} เครื่องยังไม่ขึ้น ${targetVersion}:`);
  console.table(stale.rows);
  process.exitCode = 1;
} else {
  console.log(`fleet พร้อม — ไม่มีเครื่องที่ active ใน 14 วันล่าสุดค้างเวอร์ชันเก่า`);
}
```
Script: `"verify:fleet-readiness": "ts-node scripts/verify-fleet-readiness.ts"` (`targetVersion`
รับจาก `APP_MIN_VERSION` env หรือ CLI arg แรก)

### F-3. `test/support/test-db.ts` — เพิ่มตารางเข้า TRUNCATE list

`server/test/support/test-db.ts:60-73`: เพิ่ม `'user_credentials'` เข้าอาเรย์ `TABLES` (ตำแหน่งไหนก็
ได้ — `TRUNCATE ... CASCADE` จัดลำดับ FK ให้เองในหนึ่ง statement)

### F-4. แก้คอมเมนต์ผิดเรื่อง "migration รันตอน boot" (ไม่เกี่ยวกับ ERP โดยตรง แต่ถูกพบระหว่างวิจัย)

`server/Dockerfile:24-25`, `server/docker-compose.yml:59,86`, `server/db/schema.sql:21` (ถ้ามี):
comment เดิมอ้างว่า "migration รันใน entrypoint ใต้ Postgres advisory lock" ซึ่ง**ไม่จริง**
(`main.ts` ไม่แตะ DB เลย ยืนยันจาก bootstrap function) แก้ข้อความให้ตรงกับกลไกจริง: "migration คือ
`npm run migrate` ที่มนุษย์รันเอง ก่อน build/swap container เสมอ (ดู `deploy/update.sh` ขั้น 4)"

### F-5. `deploy/update.sh` — เพิ่ม verify block ของ `user_credentials` (ท้ายขั้น 4 เดิม, ~บรรทัด 79-90)

```bash
psql_value <<'SQL' | sed 's/^/     /'
SELECT 'user_credentials ทั้งหมด : ' || count(*) FROM user_credentials;
SELECT 'users ไม่มี credential   : ' || count(*)
  FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.emp_id = u.emp_id);
SQL
```


## การขึ้นระบบจริง (Cutover) — ไม่มีใครถูกล็อกออกระหว่างทาง

**คุณสมบัติที่ต้องรักษาไว้ตลอด:** ระหว่าง "ระบบเดิมทำงานอยู่" ถึง "ล็อกอิน ERP ทำงานเต็มรูป" ต้องไม่มี
ช่วงเวลาไหนที่ใครเข้าระบบไม่ได้ คัตโอเวอร์อยู่ใต้การควบคุมของมนุษย์ ไม่ใช่ผลข้างเคียงของการ deploy

### Phase 0 — Recon (read-only, ก่อนเขียนโค้ดสักบรรทัด — เป็นด่านบังคับ ไม่ใช่ทางเลือก)

รัน `npm run verify:erp-users` (ขั้น F-1) ตอบ U1 (ค่า `user_level` จริง), U3 (รูปแบบ/ตรงกับ `users`
เท่าไร) จากข้อมูลจริง **ห้ามไปต่อ Phase 3 จนกว่า:**
- มีอย่างน้อย 1 ค่า `user_level` ที่ตั้งใจ map เป็น `admin` ใน `ERP_USER_LEVEL_ROLE_MAP`
- % ที่ `menuuser.emp_id` ตรงกับ `users.emp_id` เดิม อยู่ในระดับที่สมเหตุสมผล (ถ้าต่ำผิดปกติ ให้
  หยุดคุยกับเจ้าของ ERP ก่อน — นี่คือสัญญาณของ U3 ที่ผิดสมมติฐาน)
- เจ้าของ ERP ยืนยันตรง ๆ เรื่อง U4/U7 (กี่คลัง มีคอลัมน์กรองไหม)

### Phase 1 — Schema only (`deploy/update.sh` ขั้น 4, **ก่อน** สลับคอนเทนเนอร์ที่ขั้น 5)

`psql_run < db/schema.sql` สร้าง `user_credentials`, backfill legacy PIN (A-4), ผ่อน
`users.pin_hash` เป็น nullable **โค้ด API เดิมยังรันอยู่และยังอ่าน `users.pin_hash` ตรง ๆ** —
ไม่มีอะไรเปลี่ยนพฤติกรรมตอนนี้เลย

### Phase 2 — Code deploy (ขั้น 5-6: build, swap, healthz)

Server ใหม่อ่านจาก `user_credentials` แล้ว (B-2) `ERP_USER_SYNC_ENABLED=false` — ยังไม่แตะ ERP เลย
**ทุกคนล็อกอินด้วย emp_id/PIN 6 หลักเดิมได้เป๊ะเหมือนก่อนหน้านี้** เพราะ `login_name = lower(emp_id)`
จาก backfill ตรงกับสิ่งที่พวกเขาพิมพ์อยู่แล้ว และ `SecretSchema` ที่คลายแล้วยอมรับเลข 6 หลักสบาย ๆ
แช่ไว้ตรงนี้ได้นานเท่าที่ต้องการ — Phase นี้ **ไม่บังคับ redeploy APK ทันที**

### Phase 3 — เปิดสวิตช์ sync จริง (มือกดเอง, เลือกจังหวะเอง, ต้องผ่านด่านทั้งหมดนี้ก่อน)

**ด่านที่ 1 — Fleet readiness (แก้ข้อบกพร่อง #1):** รัน `npm run verify:fleet-readiness` (F-2)
เทียบ `devices.app_version` กับ `APP_MIN_VERSION=5.0.0` ที่ตั้งไว้ **ถ้ายังมีเครื่อง active ค้างเวอร์ชัน
เก่า ห้ามไปต่อ** — เหตุผล: หน้าจอเก่าเป็น numeric keypad พิมพ์ ERP username จริงไม่ได้เลย ไม่ว่า wire
จะ compat แค่ไหน

**ด่านที่ 2 — Break-glass admin:** ยืนยันมี `user_credentials.source='local'` ของ admin อย่างน้อย 1
คน (รัน `npm run create-admin` ถ้ายังไม่มี — D-3) — sync จะปฏิเสธรันทั้ง run ถ้าไม่มี (C-7 ด่าน 0)

**ด่านที่ 3 — Config ครบ:** `ERP_USER_LEVEL_ROLE_MAP` ตั้งจากผล Phase 0 แล้ว, `ERP_USER_MIN_EXPECTED_
ROWS` ตั้งจากจำนวนแถวที่ F-1 รายงาน (server บูตไม่ขึ้นถ้าไม่ตั้งทั้งคู่ — C-5)

**ผ่านทั้ง 3 ด่านแล้ว:** ตั้ง `ERP_USER_SYNC_ENABLED=true`, restart api, กด `POST /sync/users` ครั้ง
แรกด้วยมือ **อ่าน `GET /sync/runs` ก่อนทำอะไรต่อเสมอ**: เทียบ `rows_read` กับตัวเลขที่ F-1 รายงาน,
ดู `anomalies` ทุกตัว (`rejected_row`, `duplicate_login`, `erp_level_unmapped`,
`deactivate_guardrail_blocked`, `row_count_below_floor`)

ต่อคนที่มี `emp_id` ตรงกับแถวใน ERP: credential ของเขาถูกเปลี่ยนในที่ (ไม่ว่า `user_name` จะเป็นอะไร)
— **ตั้งแต่วินาทีนั้น PIN เดิมใช้ไม่ได้ รหัสผ่าน ERP ใช้ได้** เป็นคัตโอเวอร์ต่อคน อะตอมมิก ตรงกับ
constraint A2 (แทนที่ ไม่ใช่คู่ขนาน) คนที่ไม่เคยปรากฏใน ERP เลย (และไม่ใช่ local) ยังไม่ถูกแตะจนกว่า
รอบต่อ ๆ ไปจะยังไม่เห็นเขาต่อเนื่องหลายรอบ — แล้วถูก deactivate ผ่าน sweep เดียวที่มีการ์ด (C-7)

### Phase 4 — เปิด cron ต่อเนื่อง

ยืนยัน `ERP_USER_SYNC_ENABLED=true` คงอยู่, cron ทำงานตาม `ERP_USER_SYNC_CRON` ระยะยาว

### Phase 5 — Cleanup (คอมมิตแยก อย่างน้อย 1 สัปดาห์หลัง Phase 3 พิสูจน์แล้วว่านิ่ง)

ลบ `users.pin_hash`, constraint `users_pin_hash_argon` **พร้อมกับ**ลบ backfill INSERT + guard สอง
บล็อกใน A-4 (อ้างอิงคอลัมน์เดียวกัน — ต้องลบพร้อมกันในคอมมิตเดียว มิฉะนั้น replay ครั้งถัดไป error)


## ความปลอดภัยของ plaintext — ทุกจุดที่รั่วได้ + การ์ดที่ตรงกัน

| จุดเสี่ยง | การ์ด |
|---|---|
| `ErpUserRow.password` หลุดผ่าน template literal/`JSON.stringify`/logger | `ErpSecret` (C-1) — `toString`/`toJSON`/`inspect.custom` คืน `'[ErpSecret]'` เสมอ `.expose()` เป็นจุดเดียวที่ดึงค่าจริงได้ |
| `audit_log` (append-only แก้คืนไม่ได้ — `deny_mutation()` trigger) | ทุก `AUDIT_SQL` call ใน C-7 ส่ง `{empId, ...}` เท่านั้น ไม่มี call ไหนส่ง `row.password`/`hash`/`secret_hash` เลย — ตรวจด้วยเทสต์ leak-check |
| `sync_runs.anomalies` (jsonb) | `rejected_row` anomaly เก็บ `empCode`/`login` เท่านั้น ไม่เก็บ `password` |
| Log บรรทัดของ `Logger`/`console` ระหว่าง sync | `ErpSecret` containment ครอบคลุมแม้พลาดพิมพ์ `logger.debug(row)` |
| ตัวแปรกลาง JS ที่ถือ plaintext ไว้นานเกินจำเป็น | `row.password.expose()` ถูกเรียกแล้วส่งเข้า `hashPin`/`verifyPin` ทันทีในบรรทัดเดียว ไม่มีการ assign ผลลัพธ์ `.expose()` เก็บไว้เป็นตัวแปรแยกที่ไหนเลยในโค้ดที่ระบุ |
| `create-admin.ts` (D-3) | `--pin` ที่รับจาก CLI arg พิมพ์ออก stdout ครั้งเดียวตามของเดิม (เจตนา — ให้ operator แจ้งพนักงาน) ไม่ log ซ้ำที่ไหน (พฤติกรรมเดิมของไฟล์นี้ ไม่เปลี่ยน) |
| `PIN_PEPPER` | reuse ค่าเดิมทุกที่ (`hashPin`/`verifyPin` ใน `AuthService`) — **ห้ามสร้าง pepper แยกสำหรับ sync** เพราะ hash เดิมทั้งหมด (legacy_pin ที่ backfill มา) verify ผ่านด้วย pepper เดิมเท่านั้น |


## Touchpoints และ Blast Radius

**ไฟล์ server ที่แก้:**

| ไฟล์ | เหตุผลที่แตะ |
|---|---|
| `server/db/schema.sql` | enum `sync_kind`+`user_credential_source`, ตาราง `user_credentials`, ผ่อน `pin_hash`, backfill+guard ที่ปิดตัวเอง |
| `server/src/auth/auth.types.ts` | คลาย `EmpIdSchema`/`PinSchema`→`SecretSchema`, ลบ `ChangePinRequestSchema`, ลบ `MUST_CHANGE_PIN` |
| `server/src/auth/auth.service.ts` | `login()` อ่านจาก `user_credentials` JOIN `users`, `verifyPin` เป็น public, ลบ `changePin()` |
| `server/src/auth/auth.controller.ts` | ลบ endpoint `change-pin` |
| `server/src/auth/pin-policy.ts` | **ลบทั้งไฟล์** |
| `server/src/erp/erp-secret.ts` | **ไฟล์ใหม่** — `ErpSecret` |
| `server/src/erp/erp-adapter.ts` | เพิ่ม `fetchUsers()`/`ErpUserRow` เข้า interface |
| `server/src/erp/drivers/mssql.driver.ts` | implement `fetchUsers()` จริง |
| `server/src/erp/drivers/mock.driver.ts` | implement `fetchUsers()` fixture |
| `server/src/sync/sync.module.ts` | widen `SyncKind`/`LOCK_KEY`, `runUsers()`, cron ที่สอง, `POST /sync/users` |
| `server/src/config/env.config.ts` | config keys ใหม่ 5 ตัว + cross-field validator |
| `server/src/members/members.module.ts` | ลบ 2 endpoint, เพิ่มด่าน `credentialSourceOf` ที่ `PATCH role` |
| `server/src/members/members.service.ts` | ลบ `create`/`resetPin`/`randomPin`, เพิ่ม `credentialSourceOf` |
| `server/src/cli/create-admin.ts` | เขียน `user_credentials` เพิ่ม |
| `server/package.json` | แก้ script `create-admin` (D-3) เพิ่ม `verify:erp-users`/`verify:fleet-readiness` |
| `server/scripts/verify-erp-users.ts` | **ไฟล์ใหม่** |
| `server/scripts/verify-fleet-readiness.ts` | **ไฟล์ใหม่** |
| `server/test/support/test-db.ts` | เพิ่ม `user_credentials` เข้า `TABLES` |
| `server/test/pin-policy.spec.ts` | **ลบทั้งไฟล์** |
| `server/deploy/update.sh` | เพิ่ม verify block |
| `server/Dockerfile`, `server/docker-compose.yml` | แก้คอมเมนต์ผิดเรื่อง migration-at-boot |

**ไฟล์ app ที่แก้:**

| ไฟล์ | เหตุผลที่แตะ |
|---|---|
| `app/lib/state/app_state.dart` | `setEmpId`/`setPassword` (เดิม `pressKey`), ลบ `mustChangePin` |
| `app/lib/features/login/login_screen.dart` | ลบ keypad ~100 บรรทัด, เพิ่มช่องรหัสผ่าน + ด่านกันเครื่องยิง (E-6) |
| `app/lib/core/widgets/common.dart` | `FieldBox` เพิ่ม `error` bool |
| `app/lib/data/auth_repository.dart` | ลบ `mustChangePin` field, guard `warehouseCode` ว่าง, รวม `_kAppVersion` |
| `app/lib/data/api_client.dart` | ลบ `codeMustChangePin` (optional) |
| `app/lib/main.dart` | ลบ branch `mustChangePin` |
| `app/lib/features/login/change_pin_screen.dart` | **ลบทั้งไฟล์** (506 บรรทัด) |
| `app/lib/core/theme/tcl_tokens.dart` | ลบโทเคน keypad/PIN cell ที่กลายเป็นขยะ |
| `docs/design-fidelity.md` | แก้ §2.1, §6, §8 |

**ตารางที่มี FK อ้าง `users.emp_id` (ไม่มีตารางไหนถูกแตะ — ระบุไว้เพื่อยืนยันว่า blast radius ของ
`users`/`emp_id` **เป็นศูนย์**เพราะแผนนี้ไม่แก้ไข `emp_id` หรือลบแถว `users` เลย):**
`refresh_tokens` (CASCADE), `count_zone_assign` (CASCADE), `scan_events` (CASCADE),
`count_submissions` (**RESTRICT** — เหตุผลหลักที่ไม่ลบ `users`), `closed_variance`/`count_sessions`
(SET NULL ตามคอลัมน์ `closed_by`/`assigned_by`/...) — **ทั้งหมด ON UPDATE CASCADE** เช่นกัน ซึ่งไม่ถูก
กระตุ้นเลยเพราะ `users.emp_id` ไม่เปลี่ยนค่า


## Public Contracts (สัญญาที่เปลี่ยน)

| สัญญา | ก่อน | หลัง | Breaking ต่อ APK เก่า? |
|---|---|---|---|
| `POST /auth/login` body | `{empId, pin, deviceId, appVersion}` regex เข้ม | ฟิลด์เดิมทุกตัว **คลาย regex** เท่านั้น | **ไม่** — ค่าที่ APK เก่าส่งได้ (ตัวเลข ≤6/≤6) ยังผ่าน schema ใหม่สบาย |
| `AuthErrorCode` | 7 ค่า | 6 ค่า (ลบ `MUST_CHANGE_PIN` ที่ไม่เคยถูก throw) | ไม่ — ไม่มี client ไหน switch บนค่านี้ |
| `UserProfile.mustChangePin` (wire) | `boolean` จริง | ยังส่งมา แต่ **เป็น `false` เสมอ** | ไม่ |
| `POST /auth/change-pin` | มีอยู่ | **ลบ** | ไม่ (ไม่มีใครเรียกอัตโนมัติ เป็น user-initiated เท่านั้น — เครื่องเก่าแค่ไม่มีปุ่มนี้ให้กด เพราะฝั่งแอปก็ลบ UI ไปด้วย) |
| `POST /members`, `POST /members/:empId/reset-pin` | มีอยู่ | **ลบ** | ไม่ (เฉพาะ admin เรียกจาก UI ที่ถูกลบไปพร้อมกัน) |
| `PATCH /members/:empId/role` | ทำงานกับทุกคน | ปฏิเสธ `400 ERP_MANAGED` สำหรับ `source='erp'` | ไม่ breaking รูปแบบ แค่เพิ่ม error case ใหม่ |
| `ErpAdapter` interface | `fetchItems`, `fetchItemsBySku`, `capabilities`, `healthCheck` | เพิ่ม `fetchUsers()` | ไม่ breaking (เพิ่มเมธอด ไม่ลบ) — driver ทั้งสองต้อง implement |
| `SyncKind` (TS) | `'items'` | `'items' \| 'users'` | ไม่ breaking (widen) |
| `AuthService.verifyPin` | `private` | `public` (ชื่อ/ลอจิกเดิม) | ไม่ breaking (ขยาย visibility) |
| `AppState.pin`/`empId`/`setEmpId` | ใช้กับ PIN 6 หลัก | ความหมายกว้างขึ้น ชื่อคงเดิม | N/A (internal Dart) |
| `AppState.pressKey` | มีอยู่ | **ลบ** แทนด้วย `setPassword` | breaking เฉพาะโค้ดเทสต์ภายใน (ดูแผนเทสต์) |


## แผนเทสต์รวม

**Server — ไฟล์ที่แก้:**

- `server/test/auth-crypto.spec.ts`: ไม่ต้องแก้ (`hashPin`/`verifyPin` ยังพฤติกรรมเดิมเป๊ะ)
- `server/test/auth-integration.spec.ts`: `seedUser` helper (~:62-64) ต้องเปลี่ยนจาก INSERT
  `users.pin_hash` ตรง ๆ เป็น INSERT `users` + `user_credentials` คู่กัน (`source` เลือกได้ต่อเคส)
  ทุกเคสที่เรียก `POST /auth/login` เปลี่ยน body จาก PIN 6 หลักคงที่เป็นค่าที่ยาวกว่าได้ (ยืนยันว่า
  schema ใหม่ไม่ปฏิเสธของเดิม) ⭐ เคสเดิม `'คำตอบ login ไม่มี pin_hash / pepper หลุดออกไป'` (~:98)
  **ต้องเพิ่ม assertion ใหม่**: ไม่มี `secret_hash`/`erp_password` หลุดออกมาด้วย
- **ลบ** `server/test/pin-policy.spec.ts` ทั้งไฟล์ (D-4)
- `server/test/support/test-db.ts`: เพิ่ม `'user_credentials'` เข้า `TABLES` (F-3)

**Server — ไฟล์ใหม่:**

- `server/test/user-credentials.spec.ts` (ใหม่):
  - LOGIN ด้วย `source='legacy_pin'` (PIN 6 หลักเดิม) → 200 (พิสูจน์ no-lockout ของ Phase 2)
  - LOGIN ด้วย `source='erp'` (username/password ยาว) → 200
  - รหัสผิด → 401 `INVALID_PIN` + `failed_attempts`/`throttle_until` ทวีคูณเหมือนเดิมทุกกรณี (สำเนา
    เคส throttle escalation ทั้งชุดจาก `auth-integration.spec.ts` มาเทียบว่ายังพฤติกรรมเดิม)
  - ⭐ **THROTTLE ไม่ถูกแตะโดย sync**: ตั้ง `failed_attempts=3`+`throttle_until` อนาคต แล้วรัน
    `runUsers()` ที่เปลี่ยนชื่อ/role ของ user เดียวกัน → `failed_attempts`/`throttle_until` ต้องเท่าเดิม
    เป๊ะ (ปิดข้อกังวลที่รายงานไว้ตรง ๆ)
  - ORDER: user ที่ถูก throttle อยู่ ส่งรหัสผ่าน**ถูก** → ยังได้ `THROTTLED` (พิสูจน์
    `assertNotThrottled` ยังรันก่อน verify เสมอ)
  - DEACTIVATION: ลบ credential ของ emp_id ที่มี `count_submissions` อยู่แล้ว → login คืน
    `UNKNOWN_EMPLOYEE`, `SELECT * FROM count_submissions WHERE emp_id=...` ยังเห็นแถวเดิมครบ (U6)
  - REACTIVATION: sync เห็น emp_id เดิมอีกครั้ง → credential ถูกสร้างใหม่ ประวัติเดิมยังอยู่
- `server/test/erp-secret.spec.ts` (ใหม่): `${secret}`, `JSON.stringify({secret})`,
  `util.inspect(secret)`, `String(secret)`, `Logger.log(secret)` (mock) ทุกทางคืน `'[ErpSecret]'`
  เท่านั้น `.expose()` คืนค่าจริง
- `server/test/users-sync.spec.ts` (ใหม่ — ครอบ `runUsers()`):
  - **UNCHANGED PASSWORD**: รันสองครั้งด้วยข้อมูลเดิม → `secret_rotated_at` ไม่ขยับ,
    `refresh_tokens` ไม่ถูก revoke, `users.updated_at` ไม่ขยับ
  - **CHANGED PASSWORD**: รหัสผ่านเปลี่ยนใน mock ERP → `secret_hash` เปลี่ยน,
    `secret_rotated_at` ขยับ, **ทุก** refresh token ของ emp_id นั้นถูก revoke
  - **ROLE CHANGE — พิสูจน์บั๊ก RETURNING เดิมถูกแก้จริง**: user_level เปลี่ยนจาก map เป็น admin →
    map เป็น staff → `role_version` เพิ่ม 1 พอดี **และ** `refresh_tokens.revoked_at` ถูกตั้งค่าจริง
    (นี่คือเทสต์ที่ต้องพิสูจน์ว่า "แดง" ถ้าใช้ `RETURNING` แบบเดิมของดีไซน์ที่ชนะ ก่อนจะยอมรับว่าผ่าน)
  - **PROMOTION ไม่ revoke**: staff → admin ไม่ตัด refresh token
  - **LAST-ADMIN FLOOR — ต่อแถว**: admin คนเดียวที่เหลือ, ERP ส่ง user_level ที่ map เป็น staff มา →
    role ยังเป็น `admin` (ไม่ถูกลด) + anomaly `users.erp_last_admin_floor_blocked` ถูก audit
  - **NO LOCAL ADMIN → ปฏิเสธทั้ง run**: ลบ credential source='local' ทั้งหมดก่อนรัน → status
    `'failed'`, `rowsUpserted=0` (ไม่มีการเขียนอะไรเลยแม้แต่แถวเดียว)
  - **ALLOWLIST — user_level ไม่ map**: ERP ส่งแถวที่ user_level ไม่อยู่ใน map → ไม่มี `users`/
    `user_credentials` แถวใหม่ถูกสร้าง + anomaly `users.erp_level_unmapped` หนึ่งรายการต่อค่า level
    ที่ต่างกัน (ไม่ใช่ต่อแถว) แม้มี 50 แถวระดับเดียวกันที่ไม่ map
  - **ROW-COUNT FLOOR**: mock ERP คืนแถวน้อยกว่า `ERP_USER_MIN_EXPECTED_ROWS` → status `'partial'`,
    `rowsTombstoned=0` แน่นอน (ไม่ deactivate อะไรเลยแม้จะมี candidate ที่ "หายไป")
  - **DEACTIVATE GUARDRAIL**: mock ERP หาย 30% ของ credential ที่มีอยู่ (เกิน default 10%) →
    `rowsTombstoned=0`, anomaly `deactivate_guardrail_blocked`
  - **DEACTIVATE ปกติ**: หาย 1 คนจาก 50 (2%, ต่ำกว่าเพดาน) → credential ถูกลบจริง 1 แถว, refresh
    token ของเขาถูก revoke, `users` แถวเดิมยังอยู่
  - **LEGACY-PIN → ERP ในที่**: emp_id เดิมมี credential `source='legacy_pin'` ปรากฏใน ERP ด้วย
    user_name คนละค่ากับ `lower(emp_id)` เดิม → แถวเดิมถูก UPDATE (`login_name` เปลี่ยน,
    `source='erp'`) ไม่ใช่ลบสร้างใหม่ (ยืนยันด้วยการเช็ค `secret_rotated_at`/id เดิม)
  - **source='local' อยู่รอด**: ไม่ว่า mock ERP จะมีหรือไม่มี emp_id นั้น credential `source='local'`
    ต้องไม่ถูกแก้เลยแม้แต่คอลัมน์เดียว
  - **VALIDATION**: emp_id ผิดรูปแบบ / user_name ยาวเกิน 64 / U+FFFD ในรหัสผ่าน / user_name ชนกัน
    (ไม่สนตัวพิมพ์) → แต่ละกรณีได้ anomaly ที่ถูกต้อง ไม่ทำให้ run ทั้งก้อนล้ม
  - **CONCURRENCY**: เรียก `runUsers` สองครั้งพร้อมกัน → ครั้งที่สอง `skipped` (advisory lock)
  - **stock_as_of**: หลัง `runUsers()` สำเร็จ `sync_runs.stock_as_of` เป็น NULL เสมอ

**App — ไฟล์ที่แก้:**

- `app/test/widget_test.dart`: กลุ่ม `'AppController — พฤติกรรม login ตาม design'` (~:80-136)
  เขียนใหม่ทั้งกลุ่มให้ตรงกับ username/password (ไม่ใช่ empId/PIN keypad) — คงเจตนาเดิมของแต่ละเคส:
  unknown user, secret ว่างต้องถูกปฏิเสธ, สำเร็จเมื่อครบทั้งคู่ ⭐ **ลบ** เคส `'keypad: C ล้าง · ⌫
  ลบตัวท้าย · สูงสุด 6 หลัก'` ทั้งเคส (ไม่มี keypad ให้ทดสอบแล้ว) `signInAs()` helper (~:182-189)
  เปลี่ยนจาก `setEmpId` + 6× `pressKey` เป็น `setEmpId(empId); setPassword('any-secret');`
- `app/test/scan_mode_test.dart`, `app/test/count_document_test.dart`, `app/test/scan_count_test.dart`:
  แก้ `signInAs`-style helper เดียวกันทั้งสี่ไฟล์ (บรรทัดที่ระบุไว้แล้วในหัวข้อ RESEARCH FINDINGS ของ
  งานมอบหมายนี้) — เปลี่ยนกลไก ไม่เปลี่ยนเจตนาของเทสต์แต่ละตัว
- `app/test/api_contract_test.dart:63`: body คงเป็น `{'empId': ..., 'pin': ..., 'deviceId': ...}`
  **ไม่เปลี่ยนชื่อคีย์** — แค่ค่าตัวอย่างเปลี่ยนจาก `'111112'` เป็นสตริงที่ไม่ใช่ 6 หลักได้ (พิสูจน์ว่า
  contract คลายแล้วจริง)

**App — ไฟล์ใหม่:**

- `app/test/login_scanner_guard_test.dart` (ใหม่ — ครอบ E-6):
  - จำลอง burst คีย์เร็ว (< `burstGap`) ขณะช่องรหัสผ่านโฟกัส → ช่องว่างเปล่าหลัง burϮจบ ไม่มีตัวอักษร
    ไหนหลุดเข้าช่อง toast ข้อความเตือนถูกเรียก
  - จังหวะคนพิมพ์ปกติ (ช้ากว่า `burstGap`) → ทุกตัวอักษรถึงช่องปกติ ไม่มี toast


## หลักฐานยืนยัน (Verification Evidence)

**เกณฑ์ผ่านของแต่ละกลุ่ม — รันตามลำดับ ห้ามข้าม:**

```bash
# กลุ่ม A (schema) — replay สองรอบต้องไม่ error, จำนวนแถวเท่ากันทั้งสองรอบ
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM user_credentials;"

# กลุ่ม B (auth core) — build สะอาด + เทสต์ crypto ผ่าน (ยังไม่แตะ DB)
cd server && npm run build
npx jest test/auth-crypto.spec.ts

# กลุ่ม C+D (sync + members + cli) — เทสต์ integration เต็มชุด
npm run test:integration
node dist/cli/create-admin.js --help   # ← ต้องพิมพ์ USAGE ไม่ใช่ MODULE_NOT_FOUND (แก้ข้อบกพร่อง #7)

# กลุ่ม E (app)
cd app && flutter analyze
flutter test test/widget_test.dart
flutter test test/login_scanner_guard_test.dart
flutter test   # ทั้งชุด

# กลุ่ม F (ops)
npm run verify:erp-users        # ก่อน Phase 3 เท่านั้น — ต้องต่อ ERP จริงได้
npm run verify:fleet-readiness  # ก่อนเปิด ERP_USER_SYNC_ENABLED เท่านั้น
```

| คำสั่ง | เกณฑ์ผ่าน |
|---|---|
| `psql -f db/schema.sql` × 2 | ไม่มี `ERROR`, `count(*)` เท่ากันทั้งสองรอบ |
| `npm run build` (server) | ไม่มี TypeScript error รวมถึง `ERP_ADAPTER_IS_READ_ONLY` compile guard (ถ้า `fetchUsers` เผลอตั้งชื่อขึ้นต้นด้วยคำในกลุ่ม `WriteishMethodName` จะ error ตรงนี้ทันที) |
| `npm run test:integration` | ทุกเคสในหัวข้อแผนเทสต์ผ่าน โดยเฉพาะ **ROLE CHANGE** ต้องพิสูจน์ก่อนว่าถ้าใช้ `RETURNING` แบบเดิมเทสต์นี้แดง แล้วค่อยยืนยันว่าด้วยโค้ดตามแผนนี้เขียว |
| `node dist/cli/create-admin.js --help` | พิมพ์ `USAGE` ออก stdout ไม่ throw `Cannot find module` |
| `flutter analyze` | `No issues found!` |
| `flutter test` (ทั้งชุด) | เขียวทั้งหมด รวม `login_scanner_guard_test.dart` ใหม่ |
| `npm run verify:erp-users` | พิมพ์ตาราง `user_level` + % emp_id ตรงกัน — คนอ่านตัดสินใจ Phase 0 gate ด้วยตา |
| `npm run verify:fleet-readiness` | exit code 0 ก่อนเปิด `ERP_USER_SYNC_ENABLED=true` เท่านั้น |

**Mutation ที่ต้องทำจริงก่อนรับเทสต์ ROLE CHANGE (พิสูจน์ว่าเทสต์จับบั๊ก #8 ได้จริง ไม่ใช่ผ่านเฉย ๆ):**

| ทำให้พังอย่างไร (จำลองดีไซน์เดิมที่มีบั๊ก) | ต้องเห็นอะไร |
|---|---|
| เปลี่ยนกลับไปใช้ `UPDATE ... WHERE role IS DISTINCT FROM $3 RETURNING role` แล้วเทียบ `returned.role !== mappedRole` เพื่อตัดสิน demote | เทสต์ **ROLE CHANGE** ต้องแดง: `RETURNING` คืน role **ใหม่**เสมอ เงื่อนไขเทียบกับตัวเองไม่มีทางเป็นจริง → `REVOKE_ALL_SQL` ไม่ถูกเรียกเลย → assertion "refresh_tokens ถูก revoke" ล้มเหลว |


## Rollback สรุป

- **กลุ่ม A (schema):** ไม่มีขั้นไหนต้อง rollback แบบทำลายข้อมูล — `user_credentials` เป็นตารางใหม่
  (DROP ได้อิสระถ้ายกเลิกทั้งแผนก่อน Phase 3) `users.pin_hash` ยังอยู่ครบจนถึง Phase 5 คือ safety net
  หลักของทั้งแผน
- **กลุ่ม B (auth core):** revert `auth.service.ts`/`auth.types.ts` กลับเป็น query `users.pin_hash`
  ตรง ๆ ได้ทันทีถ้า `user_credentials` ยังว่างเปล่า (Phase 1 เสร็จแต่ยังไม่ deploy โค้ด) หลัง Phase 2
  deploy แล้ว การ revert โค้ดกลับไปอ่าน `users.pin_hash` ตรง ๆ ยังปลอดภัย **ตราบใดที่ Phase 5
  (ลบคอลัมน์) ยังไม่เกิด**
- **กลุ่ม C (sync):** ตั้ง `ERP_USER_SYNC_ENABLED=false` แล้ว restart คือ rollback ที่เร็วที่สุด —
  หยุด cron ทันที ไม่มีการเขียนอะไรอีก โค้ด `runUsers()` ที่ deploy ไว้แล้วเป็นโค้ดตายเฉย ๆ ไม่ต้อง
  revert ไฟล์เลย
- **กลุ่ม D (members/cli):** revert `members.module.ts`/`.service.ts` คืน 2 endpoint เดิมได้อิสระ
  (ไม่มีอะไรพึ่งพาการลบ) `create-admin.ts`/`package.json` แก้ไขแล้วไม่มีความเสี่ยงต้อง rollback (แก้
  บั๊กที่มีอยู่ก่อนแผนนี้)
- **กลุ่ม E (app):** ก่อน redistribute APK ใหม่ ไม่มีอะไรต้อง rollback (เครื่องเก่ายังใช้โค้ดเก่าอยู่)
  หลัง redistribute แล้วอยากถอย ต้องแจก APK เก่ากลับ (ไม่มีทาง rollback แบบ server-only เพราะเป็นการ
  เปลี่ยน UI ของเครื่อง)
- **คัตโอเวอร์ Phase 3:** ก่อน Phase 3 — ทุกคนยังใช้ PIN เดิมได้ ยกเลิกได้โดยไม่ทำอะไรต่อ หลัง Phase 3
  — rollback (revert โค้ด/ปิด sync) คืน**PIN เดิม**ของแต่ละคน **ไม่ใช่**รหัสผ่าน ERP เพราะ
  `users.pin_hash` ไม่เคยถูกลบ **ต้องเขียนลง runbook เป็นภาษาไทยชัด ๆ** ว่า operator จะไม่นึกออกเอง
  ตอนภาวะฉุกเฉิน
- **Phase 5 (cleanup):** เป็นจุดที่**ไม่มีทาง rollback แล้ว** ต้องรอให้ Phase 3 พิสูจน์นิ่งอย่างน้อย
  1 สัปดาห์ก่อนเท่านั้น ไม่มีเหตุผลใดที่ควรรีบทำ Phase 5 เร็วกว่านั้น


## Resume and Execution Handoff

**สถานะ ณ ตอนนี้: แผนเท่านั้น ยังไม่มีโค้ดถูกเขียน**

**ลำดับที่ EXECUTE ต้องทำ (ห้ามสลับ — แต่ละกลุ่มพึ่งกลุ่มก่อนหน้าตามที่ระบุ):**

1. กลุ่ม A (schema) → รันยืนยันตามหัวข้อหลักฐานยืนยัน ก่อนแตะกลุ่ม B
2. กลุ่ม B (auth core) → รันยืนยัน ก่อนแตะกลุ่ม C
3. กลุ่ม C (ERP sync) + กลุ่ม D (members/cli) — ทำคู่กันได้ (ไม่พึ่งกัน) แต่ทั้งคู่ต้องเสร็จก่อนเทสต์
   integration เต็มชุด
4. กลุ่ม F (ops scripts) — ทำคู่กับ C/D ได้เลย (เป็นเครื่องมือ ไม่ใช่โค้ด production path)
5. กลุ่ม E (app) — ทำคู่กับ C/D/F ได้ (ไม่พึ่ง sync ต้องรันจริงก่อน เพราะ wire ไม่เปลี่ยน) **แต่ต้อง
   เสร็จก่อน Phase 3 ของ Cutover** (ต้อง redistribute APK ก่อนเปิด sync จริง)
6. Cutover Phase 0 (recon ด้วยมือ, ต้องมีสิทธิ์เข้า ERP จริง) → **บล็อกไม่ให้ไปต่อ Phase 3** จนกว่าจะ
   ตอบ U1/U3/U4 ได้
7. Cutover Phase 1-2 (ทำได้ทันทีหลังกลุ่ม A-F เขียนเสร็จและเทสต์ผ่านหมด — ไม่ต้องรอ Phase 0)
8. Cutover Phase 3 (ต้องรอทั้ง Phase 0 ตอบครบ **และ** APK ใหม่ redistribute ครบ fleet ตาม
   `verify:fleet-readiness`)
9. Cutover Phase 4-5 ตามลำดับที่ระบุ

**คำสั่งเช็คสถานะระหว่างทาง (รันจากราก repo `/Users/innovera/Documents/TCL`):**

```bash
# ยืนยันว่ากลุ่ม A-D เสร็จและเขียวก่อนแตะ Cutover
cd server && npm run build && npm run test:unit && npm run test:integration
cd ../app && flutter analyze && flutter test

# ยืนยันก่อน Phase 3 เท่านั้น (ต้องมี ERP + Postgres จริงต่อได้)
cd ../server && npm run verify:erp-users && npm run verify:fleet-readiness
```

**ถ้าต้อง PAUSE กลางทาง:** กลุ่ม A-F เป็น additive ล้วน (ไม่มีขั้นไหนลบข้อมูลจริงก่อน Phase 5) — หยุด
ตรงไหนก็ได้ระหว่างกลุ่ม A-F โดยไม่มีความเสี่ยง ระบบเดิมยังทำงานปกติทุกจุดจนกว่าจะถึง Cutover Phase 3
ซึ่งเป็นจุดตัดสินใจที่ต้องมีมนุษย์กดปุ่มเองเสมอ (`ERP_USER_SYNC_ENABLED` ไม่มี default เป็น `true`)
