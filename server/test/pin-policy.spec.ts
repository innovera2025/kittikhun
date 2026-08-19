import { isWeakPin } from '../src/auth/pin-policy';
import { PinSchema } from '../src/auth/auth.types';

/**
 * กติกา PIN — เทสต์ชุดนี้มีไว้ล็อกว่ากติกา "อยู่ที่เดียว" จริง
 *
 * บั๊กที่เคยมี: `AuthService.changePin` กับ `MembersService.randomPin` เขียนกติกาแยกกัน
 * ตัวสุ่มเลี่ยง 654321 แต่ผู้ใช้ตั้ง 654321 เองได้ → ระบบยอมรับ PIN ที่ตัวเองยังไม่กล้าสุ่มให้
 */
describe('กติกา PIN — แหล่งความจริงเดียว (pin-policy)', () => {
  describe('ปฏิเสธ PIN ที่เดาง่าย', () => {
    it.each(['000000', '111111', '555555', '999999'])('เลขซ้ำทั้งหมด: %s', (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    });

    it.each(['123456', '234567', '456789', '012345'])('เรียงขึ้นทีละ 1: %s', (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    });

    it.each(['654321', '987654', '543210', '210987'])('เรียงลงทีละ 1: %s', (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    });

    it('เรียงแบบวนหลัก 9→0 ก็ยังนับว่าเดาง่าย: 890123', () => {
      expect(isWeakPin('890123')).toBe(true);
    });

    it('654321 ถูกปฏิเสธ — เคสที่ changePin เคยปล่อยผ่านแต่ตัวสุ่มเลี่ยง', () => {
      expect(isWeakPin('654321')).toBe(true);
    });
  });

  describe('ยอมรับ PIN ที่ใช้ได้', () => {
    it.each(['520417', '839204', '100000', '918273', '112233', '135790'])(
      'PIN ปกติ: %s',
      (pin) => {
        expect(isWeakPin(pin)).toBe(false);
      },
    );

    it('เรียงทีละ 2 ไม่ถือว่าเดาง่าย (กันเข้มเกินจนตั้ง PIN ไม่ผ่าน)', () => {
      expect(isWeakPin('135791')).toBe(false);
    });
  });

  describe('รูปแบบผิด = ใช้ไม่ได้ (ไม่ throw ไม่ crash)', () => {
    it.each(['', '12345', '1234567', 'abcdef', '12345a', '12 456', '๑๒๓๔๕๖'])(
      'ปฏิเสธ: %s',
      (pin) => {
        expect(isWeakPin(pin)).toBe(true);
      },
    );
  });

  describe('สอดคล้องกับ PinSchema (ชั้นตรวจรูปแบบที่ controller ใช้)', () => {
    it('ทุก PIN ที่ผ่าน isWeakPin=false ต้องผ่าน PinSchema ด้วย', () => {
      for (const pin of ['520417', '839204', '112233']) {
        expect(PinSchema.safeParse(pin).success).toBe(true);
      }
    });

    it('PIN ที่ PinSchema ปฏิเสธ ต้องถูก isWeakPin ปฏิเสธด้วย (ไม่มีรูรั่วระหว่างสองชั้น)', () => {
      for (const pin of ['12345', 'abcdef', '']) {
        expect(PinSchema.safeParse(pin).success).toBe(false);
        expect(isWeakPin(pin)).toBe(true);
      }
    });
  });

  describe('ครอบคลุมช่องว่างทั้งชุด 000000–999999', () => {
    it('PIN ที่ถูกปฏิเสธมีจำนวนน้อยมาก — ไม่กันเข้มจนพนักงานตั้ง PIN ไม่ผ่าน', () => {
      let weak = 0;
      for (let n = 0; n < 1_000_000; n++) {
        if (isWeakPin(String(n).padStart(6, '0'))) weak++;
      }
      // เลขซ้ำ 10 ตัว + เรียงขึ้นวน 10 ตัว + เรียงลงวน 10 ตัว = 30
      expect(weak).toBe(30);
      expect(weak / 1_000_000).toBeLessThan(0.0001);
    });
  });
});
