import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tcl_stock/features/scan/handheld_scan_buffer.dart';

/// สร้างเหตุการณ์ "กดคีย์" หนึ่งตัว — ตัวอักษรธรรมดา
KeyDownEvent _char(String ch) => KeyDownEvent(
  physicalKey: PhysicalKeyboardKey.keyA,
  logicalKey: LogicalKeyboardKey.keyA,
  character: ch,
  timeStamp: Duration.zero,
);

KeyDownEvent _key(LogicalKeyboardKey key) => KeyDownEvent(
  physicalKey: PhysicalKeyboardKey.enter,
  logicalKey: key,
  timeStamp: Duration.zero,
);

KeyUpEvent _up(String ch) => KeyUpEvent(
  physicalKey: PhysicalKeyboardKey.keyA,
  logicalKey: LogicalKeyboardKey.keyA,
  timeStamp: Duration.zero,
);

/// ยิงหนึ่งครั้ง: พิมพ์รหัสรัว ๆ ห่างกัน 10ms แล้วปิดท้ายด้วย Enter
String? _shoot(
  HandheldScanBuffer buf,
  String code, {
  required DateTime start,
  Duration gap = const Duration(milliseconds: 10),
  bool enter = true,
}) {
  var t = start;
  for (final ch in code.split('')) {
    buf.feed(_char(ch), now: t);
    t = t.add(gap);
  }
  if (!enter) return null;
  return buf.feed(_key(LogicalKeyboardKey.enter), now: t);
}

void main() {
  final t0 = DateTime(2026, 8, 31, 9);

  group('HandheldScanBuffer', () {
    test('ยิงหนึ่งครั้ง → ได้รหัสเต็มตอนเจอ Enter', () {
      final buf = HandheldScanBuffer();
      expect(_shoot(buf, '8851234567890', start: t0), '8851234567890');
    });

    test('ยังไม่เจอ Enter → ยังไม่คืนรหัส', () {
      final buf = HandheldScanBuffer();
      expect(_shoot(buf, '2025012', start: t0, enter: false), isNull);
      expect(buf.pending, '2025012');
    });

    test('ยิงติดกันสองครั้ง → ได้สองรหัส ไม่ปนกัน', () {
      final buf = HandheldScanBuffer();
      expect(_shoot(buf, '2025012', start: t0), '2025012');
      expect(
        _shoot(buf, '2021001', start: t0.add(const Duration(milliseconds: 200))),
        '2021001',
      );
    });

    test('numpad Enter ก็จบรหัสได้ (บางรุ่นส่งตัวนี้)', () {
      final buf = HandheldScanBuffer();
      var t = t0;
      for (final ch in '2010404'.split('')) {
        buf.feed(_char(ch), now: t);
        t = t.add(const Duration(milliseconds: 10));
      }
      expect(buf.feed(_key(LogicalKeyboardKey.numpadEnter), now: t), '2010404');
    });

    test('Enter เปล่า ๆ → null ไม่ยิงคำค้นว่าง', () {
      final buf = HandheldScanBuffer();
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0), isNull);
    });

    test('⭐ ยิงค้างกลางคัน แล้วเว้นนาน → เศษเดิมไม่เกาะหน้ารหัสใหม่', () {
      final buf = HandheldScanBuffer(idleReset: const Duration(milliseconds: 500));
      _shoot(buf, '999', start: t0, enter: false); // ยิงไม่จบ เหลือ '999' ค้าง
      expect(buf.pending, '999');

      // เว้นไป 3 วินาที แล้วยิงใหม่ — ต้องได้รหัสใหม่ล้วน ไม่ใช่ '9992025012'
      expect(
        _shoot(buf, '2025012', start: t0.add(const Duration(seconds: 3))),
        '2025012',
      );
    });

    test('เว้นไม่ถึงเกณฑ์ → ถือว่าเป็นการยิงเดียวกัน ต่อกันตามปกติ', () {
      final buf = HandheldScanBuffer(idleReset: const Duration(milliseconds: 500));
      buf.feed(_char('2'), now: t0);
      buf.feed(_char('0'), now: t0.add(const Duration(milliseconds: 100)));
      expect(
        buf.feed(
          _key(LogicalKeyboardKey.enter),
          now: t0.add(const Duration(milliseconds: 200)),
        ),
        '20',
      );
    });

    test('KeyUpEvent ไม่ถูกนับ — ไม่งั้นได้อักขระซ้ำสองเท่า', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('7'), now: t0);
      buf.feed(_up('7'), now: t0);
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0), '7');
    });

    test('modifier / ลูกศร ที่ไม่มี character → ไม่เข้าบัฟเฟอร์', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('5'), now: t0);
      buf.feed(_key(LogicalKeyboardKey.shiftLeft), now: t0);
      buf.feed(_key(LogicalKeyboardKey.arrowDown), now: t0);
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0), '5');
    });

    test('อักขระควบคุมที่บางรุ่นแทรกมา → ถูกตัดทิ้ง', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char(''), now: t0); // STX prefix
      buf.feed(_char('4'), now: t0);
      buf.feed(_char(''), now: t0); // ETX suffix
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0), '4');
    });

    test('ยาวเกินเพดาน → ล้างทิ้ง ไม่ให้บัฟเฟอร์บวมไม่จบ', () {
      final buf = HandheldScanBuffer(maxLength: 4);
      _shoot(buf, '12345', start: t0, enter: false);
      expect(buf.pending.length, lessThanOrEqualTo(4));
    });

    test('reset() ล้างของค้างทั้งหมด', () {
      final buf = HandheldScanBuffer();
      _shoot(buf, '2025012', start: t0, enter: false);
      buf.reset();
      expect(buf.pending, isEmpty);
      expect(_shoot(buf, '111', start: t0.add(const Duration(seconds: 5))), '111');
    });
  });
}
