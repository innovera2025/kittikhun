/**
 * กติกา PIN — **แหล่งความจริงเดียว**
 *
 * ก่อนหน้านี้กติกาถูกเขียนซ้ำสองที่ (`AuthService.changePin` และ
 * `MembersService.randomPin`) และ **ไม่ตรงกันจริง** ทั้งที่คอมเมนต์อ้างว่าตรงกัน:
 * ตัวสุ่มเลี่ยง `654321` แต่ `changePin` ยอมให้ผู้ใช้ตั้งเป็น `654321` ได้
 * → พนักงานตั้ง PIN ที่ระบบเองยังถือว่าอ่อนเกินกว่าจะสุ่มให้ได้
 *
 * ไฟล์นี้จึงเป็นจุดเดียวที่นิยาม "PIN แบบไหนเดาง่าย" ทั้งสองฝั่งต้องเรียกที่นี่
 *
 * ขอบเขต: PIN เป็นตัวเลข 6 หลัก (เอนโทรปีต่ำอยู่แล้ว) การกันจึงเน้นเฉพาะ
 * รูปแบบที่คนเดาเป็นอันดับแรกจริง ๆ ไม่ใช่ blacklist ยาว ๆ ที่ทำให้ตั้ง PIN ไม่ผ่านจนน่ารำคาญ
 * — ด่านกัน brute force ตัวจริงคือ throttle ทวีคูณใน AuthService
 */

/** รูปแบบที่ยอมรับ: ตัวเลข 6 หลักเท่านั้น (ตรงกับ PinSchema) */
const PIN_FORMAT = /^\d{6}$/;

/** เลขซ้ำทั้งหมด — 000000, 111111, … 999999 */
function isAllSameDigit(pin: string): boolean {
  return /^(\d)\1{5}$/.test(pin);
}

/**
 * เรียงเป็นชุดขึ้นหรือลงทีละ 1 — 123456, 234567, 654321, 098765
 * (คิดแบบวนหลัก 0↔9 ด้วย เพราะ 890123 ก็เดาง่ายพอกัน)
 */
function isSequentialRun(pin: string): boolean {
  const d = [...pin].map(Number);
  const step = (a: number, b: number) => (b - a + 10) % 10;
  const first = step(d[0], d[1]);
  if (first !== 1 && first !== 9) return false;
  for (let i = 1; i < d.length - 1; i++) {
    if (step(d[i], d[i + 1]) !== first) return false;
  }
  return true;
}

/** PIN นี้เดาง่ายเกินกว่าจะให้ใช้หรือไม่ (รูปแบบผิดก็ถือว่าใช้ไม่ได้) */
export function isWeakPin(pin: string): boolean {
  if (!PIN_FORMAT.test(pin)) return true;
  return isAllSameDigit(pin) || isSequentialRun(pin);
}

/** ข้อความไทยที่ส่งให้ผู้ใช้เมื่อ PIN ไม่ผ่านกติกา */
export const WEAK_PIN_MESSAGE_TH = 'PIN นี้เดาง่ายเกินไป';
