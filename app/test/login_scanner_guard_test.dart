import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/features/login/login_screen.dart';
import 'package:tcl_stock/features/scan/handheld_scan_buffer.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/state/app_state.dart';

/// ด่านกันเครื่องยิงบาร์โค้ดที่ช่องรหัสผ่าน (แผน ล็อกอินผ่าน ERP ขั้น E-6)
///
/// ปัญหาที่ด่านนี้กัน: เครื่องยิงของคลังเป็น HID keyboard-wedge — เหนี่ยวไกโดยไม่
/// ตั้งใจขณะช่องรหัสผ่านโฟกัสอยู่ = บาร์โค้ดถูก "พิมพ์" ลงช่องที่บดบังไว้เงียบ ๆ
/// คนกดเข้าสู่ระบบแล้วโดนปฏิเสธ ยิงซ้ำจนถูก throttle โดยไม่มีอะไรอธิบายเลย
/// (จอเดิมเป็น keypad 6 หลักจึงไม่เคยเจอปัญหานี้ ฟอร์มใหม่เจอเต็ม ๆ)
///
/// สองด้านที่ต้องถูกทั้งคู่ ไม่ใช่ด้านเดียว:
/// 1. เครื่องยิง (อักขระห่างกันระดับสิบมิลลิวินาที) → กลืนทั้งชุด ล้างช่อง เตือน
/// 2. **นิ้วคน** (ช้ากว่า `burstGap`) → ต้องผ่านไปถึงช่องตามปกติ ไม่ถูกกลืน ไม่มี toast
///    — ด้านนี้สำคัญไม่แพ้กัน: ถ้าเกณฑ์เพี้ยนไปทางกลืนคีย์คน คนจะพิมพ์รหัสผ่าน
///    ตัวเองไม่ได้เลย ซึ่งพังหนักกว่าบั๊กที่กำลังกันอยู่
void main() {
  late LocalDb db;
  late ProviderContainer container;

  /// นาฬิกาที่วัดจังหวะคีย์ — ต้องเดินตามที่เทสต์สั่ง ไม่ใช่ตามภาระของ runner
  /// (`tester.pump()` ไม่ขยับ `DateTime.now()` — เหตุผลเดียวกับ `handheldNow`
  ///  ของจอสแกน ดูคอมเมนต์ที่ `loginScanNow`)
  late DateTime clock;

  setUp(() {
    db = LocalDb(NativeDatabase.memory());
    container = ProviderContainer(
      overrides: [localDbProvider.overrideWithValue(db)],
    );
    clock = DateTime(2026, 9, 4, 10);
    loginScanNow = () => clock;
  });

  tearDown(() async {
    loginScanNow = DateTime.now;
    container.dispose();
    await db.close();
  });

  /// ช่องรหัสผ่านคือช่องเดียวในจอนี้ที่บดบังข้อความ — จับด้วยคุณสมบัตินั้น
  /// ไม่ใช่ลำดับ (ลำดับเปลี่ยนได้ทุกครั้งที่จัดหน้าใหม่ เทสต์จะเขียวผิดที่)
  final passwordField = find.byWidgetPredicate(
    (w) => w is TextField && w.obscureText,
  );

  Future<void> pumpLogin(WidgetTester tester) async {
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: Scaffold(body: LoginScreen())),
      ),
    );
    // โฟกัสช่องรหัสผ่าน — ด่านทำงานเฉพาะตอนช่องนี้ถือโฟกัสอยู่เท่านั้น
    await tester.tap(passwordField);
    await tester.pump();
  }

  /// ป้อนหนึ่งอักขระโดยคุมช่องไฟเอง · คืนค่าว่าคีย์นั้น**ถูกกลืน**หรือไม่
  /// (`handled == true` = ไม่มีทางถึง `TextField` ที่บดบังไว้)
  Future<bool> typeChar(
    WidgetTester tester,
    String ch, {
    required Duration after,
  }) async {
    clock = clock.add(after);
    final handled =
        await tester.sendKeyDownEvent(LogicalKeyboardKey.digit0, character: ch);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.digit0);
    return handled;
  }

  const notice = 'ตรวจพบการสแกนขณะกรอกรหัสผ่าน · กรุณาพิมพ์ด้วยตนเอง';
  const machineGap = Duration(milliseconds: 10); // เครื่องยิงจริง ~10-30ms
  const humanGap = Duration(milliseconds: 150); // นิ้วคนเร็วสุดยังเกิน 100ms

  group('เครื่องยิงลั่นใส่ช่องรหัสผ่าน', () {
    testWidgets('ยิงบาร์โค้ดหนึ่งชุด → ช่องว่างเปล่า + toast เตือนหนึ่งครั้ง',
        (tester) async {
      await pumpLogin(tester);
      // มีรหัสผ่านที่คนพิมพ์ค้างไว้ก่อน — ต้องถูกล้างด้วย เพราะแยกไม่ออกแล้วว่า
      // ตัวไหนคนพิมพ์ ตัวไหนเครื่องยิงพ่นเข้ามา
      container.read(appProvider.notifier).setPassword('รหัสที่พิมพ์เอง');
      await tester.pump();

      final swallowed = <bool>[];
      for (final ch in '8851234567890'.split('')) {
        swallowed.add(await typeChar(tester, ch, after: machineGap));
      }
      clock = clock.add(machineGap);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      // อักขระตัวแรกพิสูจน์สายรัวไม่ได้ (ยังไม่มีตัวที่สองมาเทียบช่องไฟ) —
      // ตั้งแต่ตัวที่สองเป็นต้นไปต้องถูกกลืนทุกตัว ไม่มีตัวไหนหลุด
      expect(swallowed.first, isFalse);
      expect(swallowed.skip(1), everyElement(isTrue));

      final s = container.read(appProvider);
      expect(s.pin, '', reason: 'กลืนแล้วต้องล้างทั้งช่อง ไม่ใช่กลืนเฉย ๆ');
      expect(s.toast, notice);

      await tester.pump(TclToastDuration.value); // ปล่อย timer ของ toast
    });

    testWidgets('⭐ เครื่องที่ปิด Enter ปิดท้าย → ยังถูกกลืนและล้างช่องเหมือนกัน',
        (tester) async {
      // ไม่รอ Enter โดยตั้งใจ: เครื่องที่ตั้งค่า suffix ว่างไม่ส่ง Enter เลย
      // ถ้าด่านรอรหัส "จบ" ก่อนล้าง อักขระที่รั่วไปแล้วจะค้างในช่องถาวร
      await pumpLogin(tester);
      container.read(appProvider.notifier).setPassword('เดิม');
      await tester.pump();

      for (final ch in '4901234'.split('')) {
        await typeChar(tester, ch, after: machineGap);
      }
      await tester.pump();

      final s = container.read(appProvider);
      expect(s.pin, '');
      expect(s.toast, notice);

      await tester.pump(TclToastDuration.value);
    });

    testWidgets('เตือนครั้งเดียวต่อการยิงหนึ่งใบ ไม่ใช่ทุกอักขระ',
        (tester) async {
      await pumpLogin(tester);
      var toasts = 0;
      container.listen<String?>(
        appProvider.select((s) => s.toast),
        (_, next) {
          if (next == notice) toasts++;
        },
      );

      for (final ch in '8851234567890'.split('')) {
        await typeChar(tester, ch, after: machineGap);
      }
      await tester.pump();

      expect(toasts, 1);
      await tester.pump(TclToastDuration.value);
    });
  });

  group('นิ้วคนพิมพ์รหัสผ่านเอง', () {
    testWidgets('⭐ จังหวะคน → ไม่ถูกกลืนสักตัว ไม่มี toast', (tester) async {
      await pumpLogin(tester);

      final swallowed = <bool>[];
      for (final ch in 'ปลาทอง2569'.split('')) {
        swallowed.add(await typeChar(tester, ch, after: humanGap));
      }
      await tester.pump();

      expect(
        swallowed,
        everyElement(isFalse),
        reason: 'กลืนคีย์คน = พิมพ์รหัสผ่านตัวเองไม่ได้ พังกว่าบั๊กที่กำลังกันอยู่',
      );
      expect(container.read(appProvider).toast, isNull);
    });

    testWidgets('พิมพ์เองแล้วกด Enter ปิดท้าย → ค่าที่พิมพ์ไว้ต้องไม่ถูกล้าง',
        (tester) async {
      // กับดักที่ `_onPasswordKey` เขียนกำกับไว้: บัฟเฟอร์คืน `code` ได้เหมือนกัน
      // เมื่อคนกด Enter — ถ้าด่านตัดสินที่ `code != null` แทน `swallow`
      // รหัสผ่านที่เพิ่งพิมพ์จะถูกลบทิ้งเงียบ ๆ
      await pumpLogin(tester);
      container.read(appProvider.notifier).setPassword('ปลาทอง2569');
      await tester.pump();

      for (final ch in 'ab'.split('')) {
        await typeChar(tester, ch, after: humanGap);
      }
      clock = clock.add(humanGap);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(container.read(appProvider).pin, 'ปลาทอง2569');
      expect(container.read(appProvider).toast, isNull);
    });

    testWidgets('พิมพ์ช้า แล้วเครื่องยิงลั่นทีหลัง → กลืนเฉพาะชุดหลัง',
        (tester) async {
      await pumpLogin(tester);
      container.read(appProvider.notifier).setPassword('รหัสจริง');
      await tester.pump();

      // ช่วงคนพิมพ์ — ผ่านหมด
      for (final ch in 'xy'.split('')) {
        expect(await typeChar(tester, ch, after: humanGap), isFalse);
      }
      expect(container.read(appProvider).pin, 'รหัสจริง');

      // เหนี่ยวไกเผลอ — ตั้งแต่ตัวที่สองของสายรัวถูกกลืนและล้างช่อง
      for (final ch in '885123'.split('')) {
        await typeChar(tester, ch, after: machineGap);
      }
      await tester.pump();

      expect(container.read(appProvider).pin, '');
      expect(container.read(appProvider).toast, notice);

      await tester.pump(TclToastDuration.value);
    });
  });

  testWidgets('ด่านใช้เกณฑ์เดียวกับจอสแกน (ไม่มีตัวเลขซ้ำที่สอง)', (tester) async {
    // ถ้ามีใครตั้ง burstGap ของช่องรหัสผ่านเป็นค่าอื่น เทสต์สองกลุ่มบนจะเขียว
    // ต่อไปได้แม้เกณฑ์จะเบี่ยงจากจอสแกนไปแล้ว — ยึดค่าเดียวไว้ตรงนี้
    expect(HandheldScanBuffer.defaultBurstGap, const Duration(milliseconds: 70));
    expect(machineGap, lessThan(HandheldScanBuffer.defaultBurstGap));
    expect(humanGap, greaterThan(HandheldScanBuffer.defaultBurstGap));
  });
}
