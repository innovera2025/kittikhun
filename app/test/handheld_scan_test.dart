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
  return buf.feed(_key(LogicalKeyboardKey.enter), now: t).code;
}

/// ป้อนลำดับคีย์ **ชุดเดียวกัน** ด้วยจังหวะที่กำหนด แล้วคืนผล `swallow` ทุกตัว
/// (อักขระทั้งรหัส แล้วปิดท้ายด้วย Enter) — ตัวแปรเดียวที่ต่างกันคือ [gap]
List<bool> _swallowsAt(
  String code, {
  required Duration gap,
  required DateTime start,
}) {
  final buf = HandheldScanBuffer();
  final out = <bool>[];
  var t = start;
  for (final ch in code.split('')) {
    out.add(buf.feed(_char(ch), now: t).swallow);
    t = t.add(gap);
  }
  out.add(buf.feed(_key(LogicalKeyboardKey.enter), now: t).swallow);
  return out;
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
      expect(
        buf.feed(_key(LogicalKeyboardKey.numpadEnter), now: t).code,
        '2010404',
      );
    });

    test('Enter เปล่า ๆ → null ไม่ยิงคำค้นว่าง', () {
      final buf = HandheldScanBuffer();
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0).code, isNull);
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
        buf
            .feed(
              _key(LogicalKeyboardKey.enter),
              now: t0.add(const Duration(milliseconds: 200)),
            )
            .code,
        '20',
      );
    });

    test('KeyUpEvent ไม่ถูกนับ — ไม่งั้นได้อักขระซ้ำสองเท่า', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('7'), now: t0);
      expect(
        buf.feed(_up('7'), now: t0).swallow,
        isFalse,
        reason: 'ปล่อยผ่านให้ช่องกรอกตามปกติ ไม่ใช่กลืนทิ้ง',
      );
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0).code, '7');
    });

    test('modifier / ลูกศร ที่ไม่มี character → ไม่เข้าบัฟเฟอร์ และไม่ถูกกลืน', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('5'), now: t0);
      expect(buf.feed(_key(LogicalKeyboardKey.shiftLeft), now: t0).swallow, isFalse);
      expect(buf.feed(_key(LogicalKeyboardKey.arrowDown), now: t0).swallow, isFalse);
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0).code, '5');
    });

    test('อักขระควบคุมที่บางรุ่นแทรกมา → ถูกตัดทิ้ง', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char(''), now: t0); // STX prefix
      buf.feed(_char('4'), now: t0);
      buf.feed(_char(''), now: t0); // ETX suffix
      expect(buf.feed(_key(LogicalKeyboardKey.enter), now: t0).code, '4');
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

    // ⚠️ เทสต์ข้างบนยิงทุกเหตุการณ์ที่ `t0` เดียวกันหมด side effect ของ `_lastAt`
    // จึงมองไม่เห็นเลย — สามเทสต์ล่างนี้ต้องใช้เวลาจริงที่ต่างกัน
    test('⭐ ปุ่มที่ไม่มี character (เช่นปุ่มฮาร์ดแวร์สลับโหมด) ไม่ยืดหน้าต่าง idle-reset', () {
      final buf = HandheldScanBuffer(idleReset: const Duration(milliseconds: 800));
      buf.feed(_char('8'), now: t0); // '8' ค้าง
      buf.feed(
        _key(LogicalKeyboardKey.f1), // ปุ่มไม่มี character
        now: t0.add(const Duration(milliseconds: 700)), // ก่อนแก้บั๊ก: ยืด _lastAt
      );
      // เว้นไปอีก 700ms (รวม 1400ms จาก '8') — เกิน idleReset 800ms นับจาก '8' จริง ๆ
      final r = buf.feed(_char('5'), now: t0.add(const Duration(milliseconds: 1400)));
      // ห่างจากตัวก่อนหน้าเกิน idleReset = เริ่มสายใหม่ ยังพิสูจน์สายรัวไม่ได้ →
      // ห้ามกลืน แต่ต้องสั่ง snapshot เพราะตัวนี้กำลังจะรั่วลงช่องที่โฟกัสอยู่
      expect(r.swallow, isFalse);
      expect(r.snapshotNow, isTrue);
      expect(
        buf.pending,
        '5',
        reason: 'ต้องล้าง "8" ทิ้งเพราะห่างเกิน idleReset '
            'นับจาก "8" — ถ้าปุ่ม f1 แอบยืด _lastAt ตอน 700ms จะเหลือ "85" แทน',
      );
    });

    test('Enter บนบัฟเฟอร์ว่าง → ไม่กลืน (อาจเป็น Enter จริงจากที่อื่น)', () {
      final buf = HandheldScanBuffer();
      final r = buf.feed(_key(LogicalKeyboardKey.enter), now: t0);
      expect(r.swallow, isFalse);
      expect(r.code, isNull);
    });

    test('Enter บนบัฟเฟอร์ไม่ว่าง → คืนรหัส · กลืนเฉพาะที่ปิดท้ายสายรัว', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('9'), now: t0);
      expect(
        buf.feed(_key(LogicalKeyboardKey.enter), now: t0),
        (swallow: false, snapshotNow: false, code: '9'),
        reason: 'อักขระตัวเดียวพิสูจน์สายรัวไม่ได้ — Enter จึงต้องไม่ถูกกลืน',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // กลืนตามความเร็ว (burstGap) — ตัวแยก "เครื่องยิง" ออกจาก "นิ้วคน"
  //
  // ทุกเคสในกลุ่มนี้เดินเวลาเอง เพราะ **ช่องไฟระหว่างคีย์คือสิ่งที่กำลังวัด**
  // ══════════════════════════════════════════════════════════════════

  group('HandheldScanBuffer · สายรัว (burst)', () {
    Duration ms(int n) => Duration(milliseconds: n);

    test('⭐ ลำดับคีย์ชุดเดียวกัน จังหวะเครื่องยิง vs จังหวะนิ้วคน → ตัดสินตรงข้ามกัน',
        () {
      const code = '2025012'; // 7 ตัว + Enter = 8 เหตุการณ์

      expect(
        _swallowsAt(code, gap: ms(10), start: t0),
        [false, ...List.filled(code.length, true)],
        reason: 'ห่าง 10ms = เครื่องจักร · ตัวแรกพิสูจน์สายรัวไม่ได้จึงรั่ว '
            'ที่เหลือรวม Enter ต้องถูกกลืนทั้งหมด',
      );

      expect(
        _swallowsAt(code, gap: ms(150), start: t0),
        List.filled(code.length + 1, false),
        reason: 'ห่าง 150ms = นิ้วคนแตะคีย์บอร์ดจอ · ห้ามกลืนสักตัว ไม่งั้น '
            'ยอดที่พนักงานคีย์หายเงียบ ๆ (ก่อนแก้: กลืนทุกตัวที่เข้าบัฟเฟอร์)',
      );
    });

    test('ค่าปริยายคือ 70ms (ตัวเลขที่ระยะขอบทั้งสองฝั่งคำนวณจาก)', () {
      expect(HandheldScanBuffer.defaultBurstGap, ms(70));
    });

    test('⭐ ค่าปริยาย — ต้องเหลือที่ทั้งฝั่งเครื่องยิงและฝั่งนิ้วคน', () {
      // ฝั่งเครื่อง: SE4710 ผ่าน HID wedge ส่งราว 10-30ms/อักขระ · **ขอบบน**
      // ต้องยังนับเป็นสายรัว ไม่งั้น `_burst` ไม่มีวันเป็น true แล้วตาข่ายกู้ยอด
      // ทั้งชุด (กลืนคีย์ + armBurstDeath + closeCountSnapshot) เปิดโล่งเงียบ ๆ
      for (final gap in [ms(10), ms(30)]) {
        final buf = HandheldScanBuffer();
        buf.feed(_char('1'), now: t0);
        expect(
          buf.feed(_char('2'), now: t0.add(gap)).swallow,
          isTrue,
          reason: 'ห่าง ${gap.inMilliseconds}ms อยู่ในช่วงของเครื่องยิงจริง — '
              'ตัดสินเป็นนิ้วคนเมื่อไหร่ บั๊กยอดเพี้ยนเดิมกลับมาทั้งดุ้น',
        );
      }

      // ฝั่งคน: แตะคีย์บอร์ดจอติด ๆ กันเร็วที่สุดแบบต่อเนื่องยังเกิน 100ms
      final human = HandheldScanBuffer();
      human.feed(_char('1'), now: t0);
      expect(
        human.feed(_char('9'), now: t0.add(ms(100))).swallow,
        isFalse,
        reason: 'ห่าง 100ms คือขอบล่างของนิ้วคน — กลืนเมื่อไหร่ ยอดที่พนักงาน'
            'แตะหายเงียบ ๆ แล้วเส้นตายยังถอยยอดกลับให้อีกดอก',
      );
    });

    test('เกณฑ์อยู่ที่ burstGap พอดี — เท่ากับ = สายรัว · เกินไป 1ms = นิ้วคน', () {
      final buf = HandheldScanBuffer(burstGap: ms(60));
      buf.feed(_char('1'), now: t0);
      expect(buf.feed(_char('2'), now: t0.add(ms(60))).swallow, isTrue);

      final slow = HandheldScanBuffer(burstGap: ms(60));
      slow.feed(_char('1'), now: t0);
      expect(slow.feed(_char('2'), now: t0.add(ms(61))).swallow, isFalse);
    });

    test('ตัวแรกสั่ง snapshot (กำลังจะรั่ว) · ตัวถัดไปในสายรัวไม่สั่งซ้ำ', () {
      final buf = HandheldScanBuffer();
      expect(
        buf.feed(_char('8'), now: t0),
        (swallow: false, snapshotNow: true, code: null),
        reason: 'snapshot ต้องเกิด **ก่อน** ตัวนี้รั่วลงช่อง ไม่ใช่หลัง',
      );
      expect(buf.inBurst, isFalse, reason: 'ตัวเดียวยังพิสูจน์สายรัวไม่ได้');
      expect(
        buf.feed(_char('8'), now: t0.add(ms(10))),
        (swallow: true, snapshotNow: false, code: null),
        reason: 'ถ้าสั่ง snapshot ตรงนี้ด้วย จะทับค่าดีด้วยค่าที่รั่วไปแล้ว',
      );
      expect(buf.inBurst, isTrue);
    });

    test('สะดุดกลางรหัส (เกิน burstGap แต่ไม่ถึง idleReset) → สายรัวไม่ขาด', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('2'), now: t0);
      buf.feed(_char('0'), now: t0.add(ms(10)));
      expect(
        buf.feed(_char('2'), now: t0.add(ms(80))),
        (swallow: true, snapshotNow: false, code: null),
        reason: 'เฟรมตก/GC สะดุดบนเครื่องจริงไม่ควรทำให้อักขระที่เหลือรั่ว '
            'และไม่ควรไปทับ snapshot ที่เก็บไว้ตอนตัวแรก',
      );
    });

    test('เว้นเกิน idleReset กลางรหัส → สายรัวตายพร้อมเศษ ตัวถัดไปเริ่มใหม่', () {
      final buf = HandheldScanBuffer(idleReset: ms(800));
      buf.feed(_char('2'), now: t0);
      buf.feed(_char('0'), now: t0.add(ms(10)));
      expect(buf.inBurst, isTrue);

      expect(
        buf.feed(_char('7'), now: t0.add(ms(900))),
        (swallow: false, snapshotNow: true, code: null),
        reason: 'ล้างเศษแล้วต้องล้างสถานะสายรัวด้วย — ไม่งั้นเลขตัวถัดไปที่คน '
            'แตะจะถูกกลืนทั้งที่ไม่มีเครื่องยิงเกี่ยวข้องแล้ว',
      );
      expect(buf.pending, '7');
    });

    test('ยาวเกินเพดานกลางสายรัว → ล้างเศษได้ แต่สายรัวเดิมยังไหลอยู่', () {
      final buf = HandheldScanBuffer(maxLength: 4);
      var t = t0;
      for (final ch in '12345'.split('')) {
        buf.feed(_char(ch), now: t);
        t = t.add(ms(10));
      }
      expect(buf.pending.length, lessThanOrEqualTo(4));
      expect(
        buf.inBurst,
        isTrue,
        reason: 'การยิงชุดเดิมยังไม่จบ — ล้างสายรัวตรงนี้ = อักขระที่เหลือรั่ว',
      );
    });

    test('อักขระควบคุมที่แทรกกลางสายรัว → ถูกกลืนเหมือนอักขระอื่น', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('4'), now: t0);
      expect(
        buf.feed(_char(''), now: t0.add(ms(10))).swallow, // ETX suffix
        isTrue,
      );
    });

    test('reset() ล้างสถานะสายรัว — สลับโหมดแล้วเลขที่คนแตะห้ามถูกกลืน', () {
      final buf = HandheldScanBuffer();
      buf.feed(_char('1'), now: t0);
      buf.feed(_char('2'), now: t0.add(ms(10)));
      expect(buf.inBurst, isTrue);

      buf.reset();
      expect(buf.inBurst, isFalse);
      expect(
        buf.feed(_char('9'), now: t0.add(ms(20))).swallow,
        isFalse,
        reason: 'สายรัวค้างข้ามการ reset = กลืนคีย์คนโดยไม่มีทางกู้',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // สมุดจดจังหวะ — ทำให้การวัด burstGap หน้างานเป็นการ "อ่านค่า" ไม่ใช่เดารอบสอง
  //
  // ⚠️ วินิจฉัยล้วน ๆ · ถอดทั้งชุดทิ้งแล้วพฤติกรรมสแกนต้องเท่าเดิมเป๊ะ
  // ══════════════════════════════════════════════════════════════════

  group('HandheldGapLog', () {
    Duration ms(int n) => Duration(milliseconds: n);

    test('จดช่องไฟระหว่างอักขระของการยิงหนึ่งชุด (Enter ไม่ใช่ช่องไฟของอักขระ)', () {
      final log = HandheldGapLog();
      final buf = HandheldScanBuffer(gapLog: log);
      _shoot(buf, '2025', start: t0, gap: ms(12));
      expect(log.gaps, [12, 12, 12], reason: 'อักขระ 4 ตัว = ช่องไฟ 3 ช่อง');
    });

    test('ช่องไฟข้ามการยิง (เกิน idleReset) ไม่ถูกจด — ไม่ใช่จังหวะของเครื่อง', () {
      final log = HandheldGapLog();
      final buf = HandheldScanBuffer(idleReset: ms(800), gapLog: log);
      _shoot(buf, '12', start: t0, gap: ms(12));
      _shoot(buf, '34', start: t0.add(const Duration(seconds: 5)), gap: ms(12));
      expect(
        log.gaps,
        [12, 12],
        reason: 'เวลาที่คนเดินไปหยิบของชิ้นถัดไปปนเข้ามา ค่าสูงสุดจะโป่งจนอ่าน'
            'ไม่ได้ความ แล้วช่างจะสรุปผิดว่าเกณฑ์เตี้ยไป',
      );
    });

    test('บัฟเฟอร์ที่ไม่ระบุเล่ม → จดลงเล่มกลางที่จอผู้ดูแลอ่าน', () {
      HandheldGapLog.shared.clear();
      addTearDown(HandheldGapLog.shared.clear);
      _shoot(HandheldScanBuffer(), '12', start: t0, gap: ms(11));
      expect(
        HandheldGapLog.shared.gaps,
        [11],
        reason: 'จอสแกนสร้างบัฟเฟอร์แบบไม่ระบุเล่ม — ต่อสายไม่ถึงเล่มกลาง '
            'แปลว่าจอผู้ดูแลอ่านค่าว่างตลอดทั้งที่ยิงมาแล้วสิบใบ',
      );
    });

    test('เก็บไม่เกิน capacity — ค่าล่าสุดชนะ ไม่บวมไม่รู้จบ', () {
      final log = HandheldGapLog();
      for (var i = 0; i < HandheldGapLog.capacity + 5; i++) {
        log.record(i);
      }
      expect(log.gaps, hasLength(HandheldGapLog.capacity));
      expect(log.gaps.first, 5);
      expect(log.gaps.last, HandheldGapLog.capacity + 4);
    });

    test('clear() เริ่มวัดรอบใหม่ได้ (ช่างกดก่อนยิงชุดที่จะใช้เป็นผลวัดจริง)', () {
      final log = HandheldGapLog()..record(99);
      log.clear();
      expect(log.gaps, isEmpty);
    });
  });
}
