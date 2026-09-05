import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/features/scan/bluebird_scan_channel.dart';
import 'package:tcl_stock/features/scan/scan_screen.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เส้นทางที่ **สอง** ของเครื่องยิง — intent broadcast ของ Bluebird BBAPI
///
/// ปัญหาที่วัดได้จากเครื่องจริง (Bluebird S20 / Android 13 / SE4710): เหนี่ยวไก
/// แล้ว **บี๊บ** คือเอนจินถอดรหัสสำเร็จแล้ว แต่ไม่มีอะไรถึงแอปเลย เพราะเครื่อง
/// ถูกตั้งให้ส่งผลอ่านเป็น broadcast ส่วนแอปฟังแต่ **คีย์** อย่างเดียว
///
/// สามเรื่องที่พลาดไม่ได้:
/// 1. รหัสจาก broadcast ต้องเข้า `_resolve` เส้นเดียวกับกล้อง/คีย์บอร์ด — สั่น
///    เด้งการ์ด บันทึกเหมือนกันหมด ไม่มีเส้นทางไหนพิเศษกว่าเส้นทางไหน
/// 2. เครื่องที่เปิดทั้งสองเส้นทางส่งฉลากใบเดียวมาสองรอบ → ต้องนับ **ครั้งเดียว**
/// 3. เครื่องที่ไม่มีฝั่ง native (macOS · Chrome · เทสต์นี้เอง) ต้องเงียบสนิท
///    ไม่โยน ไม่ toast ไม่ค้าง — พฤติกรรมเท่าเดิมเป๊ะกับตอนยังไม่มีเส้นทางนี้
void main() {
  /// ปลอมฝั่ง native: ยิง `barcode` เข้าช่องเดียวกับที่ `MainActivity` ใช้
  ///
  /// ไม่ได้ mock ตัวช่อง — ส่งข้อความ **ขาเข้า** จริง ๆ ผ่าน binary messenger
  /// เหมือนที่เอนจิน Android ทำ ตัวรับฝั่ง Dart จึงถูกทดสอบตามเส้นทางจริง
  Future<void> beam(String code) {
    return TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          BluebirdScanChannel.channelName,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('barcode', code),
          ),
          (_) {},
        );
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. ตัวรับฝั่ง Dart ล้วน ๆ (ไม่ต้องมีจอ)
  // ══════════════════════════════════════════════════════════════════

  group('BluebirdScanChannel', () {
    test('รหัสจากฝั่ง native ไหลออกทางสตรีม', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();

      await beam('8859126000508');
      await beam('2025012');

      expect(seen, ['8859126000508', '2025012']);
    });

    test('⭐ ไม่มีฝั่ง native → start/stop เงียบสนิท ไม่โยน ไม่ค้าง', () async {
      // เทสต์นี้ *คือ* เครื่องที่ไม่มีฝั่ง native — `invokeMethod` จะได้
      // MissingPluginException กลับมาเสมอ ถ้ามันหลุดออกมาได้ เทสต์จะพัง
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);

      ch.start();
      ch.stop();
      // ปล่อยให้ future ที่ `unawaited` ไว้เดินจนจบก่อนตัดสิน
      await Future<void>.delayed(Duration.zero);
    });

    test('ตัดช่องว่าง/ขึ้นบรรทัดที่บางรุ่นเติมท้ายทิ้ง', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();

      await beam('  8851234567890\r\n');

      expect(seen, ['8851234567890']);
    });

    test('รหัสว่าง / ชนิดผิด → ไม่ปล่อยออกไป (ไม่ยิงค้นคำว่าง)', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();

      await beam('   ');
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            BluebirdScanChannel.channelName,
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('barcode', 42),
            ),
            (_) {},
          );

      expect(seen, isEmpty);
    });

    test('เมธอดอื่นที่ไม่รู้จัก → ไม่พัง และไม่หลุดออกสตรีม', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();

      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            BluebirdScanChannel.channelName,
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('somethingElse', 'x'),
            ),
            (_) {},
          );

      expect(seen, isEmpty);
    });

    test('⭐ stop() แล้วรหัสที่ยิงตามมาต้องไม่เข้าลิสต์นับ', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();
      await beam('8859126000508');

      ch.stop();
      await beam('2025012');

      expect(
        seen,
        ['8859126000508'],
        reason: 'broadcast ของ BBAPI ถึงทุกแอปที่ลงทะเบียนไว้ ไม่ได้ดูว่าใครอยู่'
            'หน้าจอ — ถอนตัวรับแล้วต้องไม่มีอะไรไหลเข้ามาอีก',
      );
    });

    test('start() ซ้ำไม่สร้างตัวรับซ้อน — ยิงหนึ่งใบต้องได้หนึ่งครั้ง', () async {
      final ch = BluebirdScanChannel();
      addTearDown(ch.dispose);
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();
      ch.start();

      await beam('8859126000508');

      expect(seen, hasLength(1));
    });

    test('⭐ จอใหม่เกิดก่อนจอเก่าถูกถอด → จอใหม่ต้องยังได้ยิน ไม่ใช่หูหนวกเงียบ ๆ',
        () async {
      // ลำดับนี้คือลำดับจริงของ Flutter ตอนสร้าง State ตัวใหม่แทนตัวเก่า:
      // `inflateWidget` (→ initState → start) มาก่อน `unmount` (→ dispose → stop)
      // ในเฟรมเดียวกันเสมอ — ถ้า stop() ของตัวเก่าล้างสล็อตดื้อ ๆ ตัวใหม่จะเงียบ
      final old = BluebirdScanChannel();
      addTearDown(old.dispose);
      old.start();

      final fresh = BluebirdScanChannel();
      addTearDown(fresh.dispose);
      final seen = <String>[];
      fresh.barcodes.listen(seen.add);
      fresh.start(); // ตัวใหม่เกิดก่อน...
      old.dispose(); // ...แล้วตัวเก่าค่อยถูกถอด

      await beam('8859126000508');

      expect(
        seen,
        ['8859126000508'],
        reason: 'ยิงแล้วไม่มีอะไรเกิดขึ้นคือบั๊กเดิมเป๊ะ ๆ แต่หาสาเหตุยากกว่า',
      );
    });

    test('dispose() ปิดสตรีม — รหัสที่มาทีหลังไม่ทำให้ controller โยน', () async {
      final ch = BluebirdScanChannel();
      final seen = <String>[];
      ch.barcodes.listen(seen.add);
      ch.start();
      ch.dispose();

      await beam('8859126000508');

      expect(seen, isEmpty);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. ต่อเข้าจอสแกนจริง — เส้นทางเดียวกับกล้องและคีย์บอร์ด
  // ══════════════════════════════════════════════════════════════════

  group('จอสแกน — รหัสจาก intent เดินเส้นทางเดียวกับแหล่งอื่น', () {
    late LocalDb db;

    setUp(() => db = LocalDb(NativeDatabase.memory()));
    tearDown(() async => db.close());

    /// นาฬิกาที่วัดจังหวะคีย์ — ต้องเดินตามที่เทสต์สั่ง ไม่ใช่ตามภาระของ runner
    /// (เหตุผลเดียวกับ `handheldNow` ที่จอสแกนอธิบายไว้)
    late DateTime clock;
    setUp(() {
      clock = DateTime(2026, 9, 5, 10);
      handheldNow = () => clock;
    });
    tearDown(() => handheldNow = DateTime.now);

    /// ⚠️ นับจำนวน `_resolve` ที่ทำงานจริงจาก `HapticFeedback.mediumImpact()`
    ///    ไม่ใช่จาก `scans.length` — `addScan` ดีดัพตาม sku อยู่แล้ว (สแกนซ้ำ
    ///    เด้งขึ้นบนแทนที่จะเพิ่มแถว) ความยาวลิสต์จึงแยกสองกรณีนี้ไม่ออก
    Future<ProviderContainer> pumpScan(
      WidgetTester tester,
      List<String> haptics,
    ) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') {
            haptics.add('${call.arguments}');
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
      addTearDown(container.dispose);
      tester.view.physicalSize = const Size(392, 846);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      // pumpAndSettle ไม่ได้ — เส้นเลเซอร์/pulse ของจอสแกนวนไม่รู้จบ
      await tester.pump(const Duration(milliseconds: 400));
      return container;
    }

    /// ยิงบาร์โค้ดหนึ่งชุดแบบ keyboard wedge (อักขระห่าง 10ms + Enter ปิดท้าย)
    Future<void> shoot(WidgetTester tester, String code) async {
      for (final ch in code.split('')) {
        clock = clock.add(const Duration(milliseconds: 10));
        await tester.sendKeyDownEvent(
          LogicalKeyboardKey.digit0,
          character: ch,
        );
        await tester.sendKeyUpEvent(LogicalKeyboardKey.digit0);
      }
      clock = clock.add(const Duration(milliseconds: 10));
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pump();
    }

    testWidgets('⭐ ยิงผ่าน intent → สั่นและเด้งการ์ดเหมือนยิงผ่านคีย์บอร์ด',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpScan(tester, haptics);

      await beam('8851234567890');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        haptics,
        hasLength(1),
        reason: 'ไกดังบี๊บแล้วต้องมีอะไรเกิดขึ้นบนจอ — บั๊กเดิมคือเงียบสนิท',
      );
      expect(container.read(appProvider).scans, hasLength(1));
    });

    testWidgets(
        '⭐ เครื่องเปิดสองเส้นทาง ฉลากใบเดียวมาทั้งคีย์บอร์ดและ intent → 1 สแกน',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpScan(tester, haptics);

      await beam('8851234567890');
      await tester.pump();
      await shoot(tester, '8851234567890');

      expect(
        haptics,
        hasLength(1),
        reason: 'ฉลากใบเดียว อ่านสองเส้นทาง = 1 สแกน (ไม่ใช่ของสองชิ้น)',
      );

      // แหล่งเดิมเจอรหัสเดิมอีกครั้ง = ชิ้นใหม่ ไม่ใช่เสียงสะท้อนของใบเดิม
      await beam('8851234567890');
      await tester.pump();
      expect(haptics, hasLength(2));
      expect(container.read(appProvider).scans, hasLength(1));
    });

    testWidgets('ยิงรหัสเดิมซ้ำผ่าน intent เส้นทางเดียว → สองชิ้น สองครั้ง',
        (tester) async {
      final haptics = <String>[];
      await pumpScan(tester, haptics);

      await beam('8851234567890');
      await tester.pump();
      await beam('8851234567890');
      await tester.pump();

      expect(
        haptics,
        hasLength(2),
        reason: 'สินค้าไม่ซีเรียลสองชิ้นใช้บาร์โค้ดเดียวกัน ยิงติด ๆ กันคือของ '
            'สองชิ้นจริง — กลืนตัวที่สองทิ้ง = ไม่สั่น ไม่เด้งการ์ด',
      );
    });

    testWidgets('⭐ ถอดจอทิ้งแล้ว broadcast ที่ตามมาต้องไม่แตะ state ที่ตายแล้ว',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpScan(tester, haptics);

      await beam('8851234567890');
      await tester.pump();

      // สลับแท็บ = app shell ถอด ScanScreen ทิ้งจริง (ไม่มี IndexedStack คั่น)
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
        ),
      );
      await tester.pump();

      await beam('2025012');
      await tester.pump();

      expect(haptics, hasLength(1));
    });
  });
}
