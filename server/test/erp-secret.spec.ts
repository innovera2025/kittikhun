import { inspect } from 'node:util';

import { Logger } from '@nestjs/common';

import { ErpSecret } from '../src/erp/erp-secret';

/**
 * `ErpSecret` — ด่านสุดท้ายที่กัน plaintext ของ ERP ไม่ให้หลุดออกไปโดยไม่ตั้งใจ
 *
 * 🚫 กฎเหล็กของแผนล็อกอิน ERP: plaintext ห้ามถูกเก็บ ห้าม log ห้ามอยู่ในข้อความ error
 *    ห้ามอยู่ใน exception trace / แถว `sync_runs` / แถว `audit_log` / fixture ของเทสต์
 *
 * ทำไมต้องมีเทสต์ชุดนี้แยกต่างหาก: `audit_log` เป็น **append-only ที่ระดับ engine**
 * (trigger `deny_mutation()`) — รั่วเข้าไปแล้ว **ลบคืนไม่ได้เลย** ไม่มีโอกาสแก้ตัว
 * ด่านจึงต้องอยู่ที่ตัวค่า ไม่ใช่ที่วินัยของคนเขียนโค้ดแต่ละจุดเรียก
 *
 * ทุกเคสข้างล่างคือ "ทางที่ค่าพิมพ์ตัวเองออกมาได้" ที่ JS/Node/Nest มีจริง
 */
describe('ErpSecret — plaintext ต้องไม่หลุดออกทางไหนเลย', () => {
  const PLAINTEXT = 'ปลาทอง-2569!Warehouse';
  const MASK = '[ErpSecret]';
  const secret = ErpSecret.of(PLAINTEXT);

  it('template literal — จุดที่พลาดง่ายที่สุดใน log บรรทัดเดียว', () => {
    // จงใจเขียนสิ่งที่ lint ห้าม: eslint คือด่านแรก (จับตอน CI) เทสต์นี้พิสูจน์ด่านที่สอง
    // ว่าถ้าด่านแรกถูกข้าม/ปิด ค่าจริงก็ยังไม่หลุดอยู่ดี
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`รหัสผ่านคือ ${secret}`).toBe(`รหัสผ่านคือ ${MASK}`);
  });

  it('String() / .toString()', () => {
    expect(String(secret)).toBe(MASK);
    expect(secret.toString()).toBe(MASK);
  });

  it('⭐ JSON.stringify — เส้นทางที่ payload ของ audit_log/sync_runs.anomalies วิ่งผ่าน', () => {
    expect(JSON.stringify(secret)).toBe(`"${MASK}"`);
    expect(JSON.stringify({ password: secret })).not.toContain(PLAINTEXT);
    // ห่ออยู่ลึกในอ็อบเจ็กต์แบบที่ anomaly จริงเป็น ก็ยังต้องไม่หลุด
    expect(
      JSON.stringify({ type: 'rejected_row', row: { password: secret } }),
    ).not.toContain(PLAINTEXT);
  });

  it('⭐ util.inspect / console.log — เส้นทางของ Nest Logger และ debug dump', () => {
    expect(inspect(secret)).toBe(MASK);
    expect(inspect({ password: secret }, { depth: 5 })).not.toContain(PLAINTEXT);
  });

  it('⭐ Logger ของ Nest พิมพ์ออกไปแล้วต้องไม่มี plaintext ติดไป', () => {
    const written: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        written.push(args.map((a) => inspect(a)).join(' '));
      });
    try {
      const logger = new Logger('ทดสอบ');
      // จงใจเขียนสิ่งที่ lint ห้าม: eslint คือด่านแรก (จับตอน CI) เทสต์นี้พิสูจน์ด่านที่สอง
      // ว่าถ้าด่านแรกถูกข้าม/ปิด ค่าจริงก็ยังไม่หลุดอยู่ดี
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      logger.warn(`แถวผิดรูปแบบ: ${secret}`);
      logger.warn({ password: secret });
    } finally {
      spy.mockRestore();
    }
    expect(written.join('\n')).not.toContain(PLAINTEXT);
    expect(written.join('\n')).toContain(MASK);
  });

  it('⭐ spread / Object.keys / Object.values ไม่เห็นค่าเลย (ต้องเป็น #private ของภาษา)', () => {
    // `private` ของ TypeScript หายไปตอน compile แล้วโผล่กลับมาใน spread —
    // เคสนี้คือตัวที่จับได้ว่ามีใครเปลี่ยน `#value` กลับไปเป็น `private value`
    expect(Object.keys(secret)).toHaveLength(0);
    expect(Object.values(secret)).toHaveLength(0);
    expect(JSON.stringify({ ...secret })).not.toContain(PLAINTEXT);
    expect(inspect({ ...secret })).not.toContain(PLAINTEXT);
  });

  it('ข้อความ error / stack ที่เผลอฝังค่าไว้ ก็ยังถูกบัง', () => {
    // จงใจเขียนสิ่งที่ lint ห้าม: eslint คือด่านแรก (จับตอน CI) เทสต์นี้พิสูจน์ด่านที่สอง
    // ว่าถ้าด่านแรกถูกข้าม/ปิด ค่าจริงก็ยังไม่หลุดอยู่ดี
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const err = new Error(`hash ไม่สำเร็จ: ${secret}`);
    expect(err.message).not.toContain(PLAINTEXT);
    expect(String(err.stack)).not.toContain(PLAINTEXT);
  });

  it('.expose() คือจุดเดียวที่ได้ค่าจริง — ต้องคืนค่าเป๊ะ ไม่ trim ไม่แปลง', () => {
    // ERP เทียบ a_Password แบบ string เป๊ะ ช่องว่างท้ายมีความหมาย (constraint A4)
    const padded = ErpSecret.of('  ยังมีช่องว่างท้าย  ');
    expect(secret.expose()).toBe(PLAINTEXT);
    expect(padded.expose()).toBe('  ยังมีช่องว่างท้าย  ');
    expect(ErpSecret.of('').expose()).toBe('');
  });
});
