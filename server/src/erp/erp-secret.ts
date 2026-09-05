/**
 * `ErpSecret` — ห่อ plaintext ของ ERP ไม่ให้หลุดผ่านเส้นทางที่พิมพ์ค่าออกมาโดยไม่ตั้งใจ
 *
 * 🚫 กฎเหล็กของแผนล็อกอิน ERP: **plaintext password ห้ามถูกเก็บ ห้าม log ห้ามอยู่ในข้อความ error
 *    ห้ามอยู่ใน exception trace / แถว sync_runs / แถว audit_log / fixture ของเทสต์**
 *    มันมีชีวิตอยู่ได้แค่ในหน่วยความจำระหว่างรอบ sync แล้วเข้า argon2id + PIN_PEPPER ทันที
 *
 * คลาสนี้ปิดทางรั่วทุกทางที่ "พิมพ์ค่าออกมาเอง" ได้:
 *   - template literal / `String(x)`           → `toString()`
 *   - `JSON.stringify(x)` (รวม audit payload)  → `toJSON()`
 *   - `util.inspect(x)` / `console.log(x)` / Nest `Logger` → `inspect.custom`
 *   - `{ ...x }` / `Object.keys(x)` / `Object.values(x)`   → ใช้ `#value` (private field ของ
 *     ตัวภาษาเอง ไม่ใช่ `private` ของ TypeScript ที่หายไปตอน compile แล้วโผล่ใน spread)
 *
 * จุดเดียวที่ดึงค่าจริงออกได้คือ `.expose()` — ผู้เรียกต้องส่งผลลัพธ์เข้า argon2 ทันทีในบรรทัดนั้น
 * ห้าม assign เก็บไว้เป็นตัวแปรแยก (ตัวแปรที่ถือ plaintext ค้างไว้คือจุดรั่วที่ตัวคลาสนี้ช่วยไม่ได้)
 */
export class ErpSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): ErpSecret {
    return new ErpSecret(value);
  }

  /** จุดเดียวที่ดึงค่าออกได้ — ผู้เรียกต้องส่งเข้า argon2 ทันที ห้ามเก็บผลลัพธ์ไว้เป็นตัวแปรแยก */
  expose(): string {
    return this.#value;
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
