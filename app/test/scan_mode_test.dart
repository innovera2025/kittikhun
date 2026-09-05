import 'dart:async';
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'package:tcl_stock/data/api_client.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/features/admin/admin_screen.dart';
import 'package:tcl_stock/features/scan/handheld_scan_buffer.dart';
import 'package:tcl_stock/features/scan/scan_screen.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เทสต์โหมดสแกน (เครื่องยิง/กล้อง) + ปุ่มฮาร์ดแวร์ที่ผูกกับการสลับโหมด
///
/// สี่เรื่องที่พลาดไม่ได้:
/// 1. ค่าเริ่มต้นต้องเป็นเครื่องยิงโดยไม่ต้องอ่านดิสก์ — เปิดแอปมาก็ยิงได้เลย
/// 2. โหมดเป็นคุณสมบัติของ**เครื่อง** ไม่ใช่ของคน → ต้องรอด sign-out และรอด
///    การปิด-เปิดแอป (เครื่องคลังใช้ร่วมกันหลายกะ)
/// 3. โหมดเครื่องยิง = ไม่มีกล้องทำงานจริง จอต้องไม่โกหกว่ามี (ไม่มีเลเซอร์/
///    กรอบมุม/ปุ่มกล้อง) และเครื่องยิงต้องทำงานได้ทั้งสองโหมดเสมอ
/// 4. ปุ่มที่ผูกได้ต้องไม่ใช่ปุ่มระบบ/ปุ่มยิงบาร์โค้ด — ปฏิเสธถาวร ไม่มี override
///    (ปุ่มที่ผูกทับจะใช้งานไม่ได้เงียบ ๆ ผู้ติดตั้งมองไม่เห็นผลเสียตอนกด)

/// widget ส่วนตัวของจอสแกน/จอผู้ดูแลหาไม่ได้ด้วย `find.byType` — เทียบชื่อชนิดแทน
Finder _byName(String type) =>
    find.byWidgetPredicate((w) => w.runtimeType.toString() == type);

/// กรอบมุม/ไอคอนเป็น `CustomPainter` ไม่ใช่ widget — ต้องมองผ่าน `CustomPaint`
Finder _byPainter(String type) => find.byWidgetPredicate(
      (w) => w is CustomPaint && w.painter.runtimeType.toString() == type,
    );

/// `ApiClient` ที่บอกว่าต่อ backend แล้ว — จอผู้ดูแลกันตัวเองด้วย `isConfigured`
/// ก่อนถึงแท็บใด ๆ ("โหมดดูตัวอย่าง UI") แท็บปุ่มเครื่องจึงเข้าไม่ถึงถ้าไม่ปลอมชั้นนี้
class _ConfiguredApi extends ApiClient {
  _ConfiguredApi() : super(tokenStore: TokenStore());

  @override
  bool get isConfigured => true;
}

void main() {
  late LocalDb db;

  setUp(() => db = LocalDb(NativeDatabase.memory()));
  tearDown(() async => db.close());

  ProviderContainer containerOf({bool withApi = false}) {
    final container = ProviderContainer(
      overrides: [
        localDbProvider.overrideWithValue(db),
        if (withApi) apiClientProvider.overrideWithValue(_ConfiguredApi()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  /// เข้าสู่ระบบโหมด fixture (เทสต์ไม่ได้ตั้ง `API_BASE_URL`)
  Future<void> signInAs(AppController c, String empId) async {
    c.setEmpId(empId);
    for (final k in ['0', '0', '0', '0', '0', '0']) {
      c.pressKey(k);
    }
    await c.signIn();
  }

  /// รอให้ `unawaited(_persistScanMode/_persistHotkey)` เขียนลง sqlite เสร็จ
  Future<void> settleWrites() => Future<void>.delayed(Duration.zero);

  // ══════════════════════════════════════════════════════════════════
  // 1. ค่าเริ่มต้นและข้อความสถานะ (ไม่แตะดิสก์เลย)
  // ══════════════════════════════════════════════════════════════════

  group('AppState — ค่าเริ่มต้นคือเครื่องยิง โดยไม่ต้องอ่านดิสก์', () {
    test('AppState() เปล่า → handheld + ข้อความพร้อมยิง', () {
      const s = AppState();
      expect(s.scanMode, ScanMode.handheld);
      expect(s.scanModeHotkey, isNull);
      expect(s.camStatusText, 'พร้อมยิงบาร์โค้ด · handheld');
    });

    test('โหมดกล้อง → ข้อความ camStatus เดิมกลับมาตามปกติ', () {
      const s = AppState();
      expect(
        s.copyWith(scanMode: ScanMode.camera).camStatusText,
        'กล้องปิดอยู่ · แตะไอคอนกล้อง',
      );
    });

    test('⭐ โหมดเครื่องยิง + กล้องขัดข้อง → บอกความจริง ไม่กลบด้วย "พร้อมยิง"', () {
      const s = AppState();
      expect(
        s.copyWith(camStatus: CamStatus.detectorUnavailable).camStatusText,
        CamStatus.detectorUnavailable.text,
        reason: 'กล้องที่สั่งปิดไม่ลงยังยึดเซ็นเซอร์ = เครื่องยิงพลอยอ่านไม่ได้ '
            'โหมดนี้ไม่มีปุ่มกล้อง/preview ให้ดู ป้ายสถานะคือทางเดียวที่เหลือ',
      );
      expect(
        s.copyWith(camStatus: CamStatus.permissionDenied).camStatusText,
        CamStatus.permissionDenied.text,
      );
      expect(
        s.copyWith(camStatus: CamStatus.offToggled).camStatusText,
        CamStatus.handheldReady.text,
        reason: 'กล้องที่แค่ปิดอยู่ไม่ใช่เรื่องขัดข้อง ยังต้องกลบตามเดิม',
      );
    });

    test('camStatusOverride ชนะทั้งสองโหมด (ผลสแกนต้องเห็นเสมอ)', () {
      const s = AppState(camStatusOverride: 'พบสินค้า · SKU-1');
      expect(s.camStatusText, 'พบสินค้า · SKU-1');
      expect(
        s.copyWith(scanMode: ScanMode.camera).camStatusText,
        'พบสินค้า · SKU-1',
      );
    });

    test('clearScanModeHotkey ถอนปุ่มได้จริง (null ผ่าน copyWith ไม่ได้)', () {
      const s = AppState(scanModeHotkey: 42);
      expect(s.copyWith().scanModeHotkey, 42, reason: 'ไม่ส่ง = ค่าเดิม');
      expect(s.copyWith(clearScanModeHotkey: true).scanModeHotkey, isNull);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. เก็บระดับเครื่องผ่าน KvMeta — R3 อยู่รอดข้ามปิด-เปิดแอปและข้าม sign-out
  // ══════════════════════════════════════════════════════════════════

  group('เก็บโหมดระดับเครื่อง — ไม่ใช่ของผู้ใช้คนใดคนหนึ่ง', () {
    test('setScanMode(camera) → เขียนลง KvMeta ทันที', () async {
      final container = containerOf();
      container.read(appProvider.notifier).setScanMode(ScanMode.camera);
      await settleWrites();

      expect(await db.meta(MetaKeys.scanMode), 'camera');
    });

    test('เปิดแอปใหม่บน DB เดิม → signIn() hydrate โหมดที่เลือกไว้กลับมา',
        () async {
      await db.setMeta(MetaKeys.scanMode, ScanMode.camera.name);
      await db.setMeta(MetaKeys.scanModeHotkey, '4294969345');

      // container คนละตัว = AppController คนละตัว (จำลองเปิดแอปรอบใหม่)
      final next = containerOf();
      await signInAs(next.read(appProvider.notifier), '52104');

      expect(next.read(appProvider).signedIn, isTrue);
      expect(next.read(appProvider).scanMode, ScanMode.camera);
      expect(next.read(appProvider).scanModeHotkey, 4294969345);
    });

    test('ค่าที่อ่านไม่ออกใน KvMeta → กลับเป็น handheld ไม่ทำให้ sign-in ล้ม',
        () async {
      await db.setMeta(MetaKeys.scanMode, 'xyz');
      await db.setMeta(MetaKeys.scanModeHotkey, 'ไม่ใช่ตัวเลข');

      final container = containerOf();
      await signInAs(container.read(appProvider.notifier), '52104');

      expect(container.read(appProvider).signedIn, isTrue);
      expect(container.read(appProvider).scanMode, ScanMode.handheld);
      expect(container.read(appProvider).scanModeHotkey, isNull);
    });

    test('sign-out ไม่ล้างโหมด/ปุ่มที่ผูกไว้ (กะถัดไปไม่ต้องตั้งใหม่)', () async {
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      await signInAs(c, '52104');
      c.setScanMode(ScanMode.camera);
      c.bindScanModeHotkey(4294969345);

      await c.signOut();

      expect(container.read(appProvider).signedIn, isFalse);
      expect(container.read(appProvider).scanMode, ScanMode.camera);
      expect(container.read(appProvider).scanModeHotkey, 4294969345);
    });

    test('ผูก/ถอนปุ่มฮาร์ดแวร์ → เขียน KvMeta ทั้งสองทาง', () async {
      final container = containerOf();
      final c = container.read(appProvider.notifier);

      c.bindScanModeHotkey(4294969345);
      await settleWrites();
      expect(container.read(appProvider).scanModeHotkey, 4294969345);
      expect(await db.meta(MetaKeys.scanModeHotkey), '4294969345');

      c.clearScanModeHotkey();
      await settleWrites();
      expect(container.read(appProvider).scanModeHotkey, isNull);
      expect(
        await db.meta(MetaKeys.scanModeHotkey),
        '',
        reason: 'สตริงว่าง = ถอนแล้ว (ต่างจากไม่มีแถว = ยังไม่เคยผูก)',
      );
    });

    test('setScanMode(handheld) บังคับปิดกล้อง — ปุ่มฮาร์ดแวร์กดเผลอได้', () {
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.setScanMode(ScanMode.camera);
      c.setCamOn(true);

      c.setScanMode(ScanMode.handheld);
      expect(container.read(appProvider).camOn, isFalse);
    });

    test('เข้าโหมดกล้อง → กล้องยังปิด รอผู้ใช้แตะ FAB เอง', () {
      final container = containerOf();
      container.read(appProvider.notifier).setScanMode(ScanMode.camera);

      expect(container.read(appProvider).camOn, isFalse);
      expect(
        container.read(appProvider).camStatusText,
        'กล้องปิดอยู่ · แตะไอคอนกล้อง',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. จอสแกน — กรอบกล้องกับแถบสลับโหมด
  // ══════════════════════════════════════════════════════════════════

  group('จอสแกน — กรอบกล้องบอกความจริงว่ากำลังใช้ตัวไหนอ่าน', () {
    Future<ProviderContainer> pumpScan(WidgetTester tester) async {
      final container = containerOf();
      // ขนาดอ้างอิงของ design (392×846) — เคสจอแคบ/ตัวอักษรใหญ่อยู่กลุ่มท้ายไฟล์
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

    testWidgets('เริ่มต้น: hero เครื่องยิง ไม่มีเลเซอร์/กรอบมุม/ปุ่มกล้อง',
        (tester) async {
      final container = await pumpScan(tester);

      expect(find.text('เครื่องยิง'), findsOneWidget);
      expect(find.text('กล้อง'), findsOneWidget);
      expect(find.text('ยิงบาร์โค้ดได้เลย'), findsOneWidget);
      expect(find.text('เล็งฉลากแล้วเหนี่ยวไก — ไม่ต้องแตะจอ'), findsOneWidget);
      expect(_byName('_SweepLine'), findsNothing);
      expect(_byPainter('_CornerBracketsPainter'), findsNothing);
      // เหลือแค่ปุ่มค้นหา — ปุ่มกล้องไม่ใช่แค่ดับ glow แต่ต้องไม่มีเลย
      expect(_byName('_CamFab'), findsOneWidget);
      expect(
        container.read(appProvider).camStatusText,
        'พร้อมยิงบาร์โค้ด · handheld',
      );
    });

    testWidgets('ช่องที่เลือกอยู่ประกาศ selected ให้โปรแกรมอ่านหน้าจอ',
        (tester) async {
      final handle = tester.ensureSemantics();
      await pumpScan(tester);

      expect(
        tester.getSemantics(find.bySemanticsLabel('โหมดเครื่องยิง')),
        isSemantics(isButton: true, isSelected: true, hasTapAction: true),
      );
      expect(
        tester.getSemantics(find.bySemanticsLabel('โหมดกล้อง')),
        isSemantics(isButton: true, isSelected: false),
      );
      // ⚠️ dispose ในบอดี้ ไม่ใช่ addTearDown — ด่านตรวจ SemanticsHandle
      // ของ flutter_test ทำงานก่อน tearDown
      handle.dispose();
    });

    testWidgets('แตะ "กล้อง" → กรอบมุม+ปุ่มกล้องกลับมา แต่กล้องยังไม่เปิดเอง',
        (tester) async {
      final container = await pumpScan(tester);

      await tester.tap(find.text('กล้อง'));
      await tester.pump(const Duration(milliseconds: 400));

      expect(container.read(appProvider).scanMode, ScanMode.camera);
      expect(container.read(appProvider).camOn, isFalse);
      expect(
        container.read(appProvider).camStatusText,
        'กล้องปิดอยู่ · แตะไอคอนกล้อง',
      );
      expect(_byName('_CamFab'), findsNWidgets(2));
      expect(_byPainter('_CornerBracketsPainter'), findsOneWidget);
      expect(find.text('ยิงบาร์โค้ดได้เลย'), findsNothing);
      // เลเซอร์เกทด้วย camOn ไม่ใช่โหมด — กล้องยังปิดจึงยังไม่กวาด
      expect(_byName('_SweepLine'), findsNothing);
    });

    testWidgets('⭐ แตะแถบโหมดรัว ๆ → คูลดาวน์กัน ไม่สั่งเปิด/ปิดกล้องซ้อนกัน',
        (tester) async {
      final container = await pumpScan(tester);

      await tester.tap(find.text('กล้อง'));
      await tester.pump();
      await tester.tap(find.text('เครื่องยิง')); // นิ้วรัว ภายใน 300ms จริง
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        container.read(appProvider).scanMode,
        ScanMode.camera,
        reason: 'แตะที่สองต้องตกคูลดาวน์ — ทุกครั้งที่สลับคือคำสั่งเปิด/ปิดกล้อง '
            'จริงหนึ่งชุด กดเร็วกว่าที่ native ทำเสร็จมีแต่ทำให้ต้องไล่สถานะย้อน',
      );
    });

    testWidgets('โหมดกล้อง: แตะ FAB → กล้องเปิด เลเซอร์เริ่มกวาด',
        (tester) async {
      final container = await pumpScan(tester);
      container.read(appProvider.notifier).setScanMode(ScanMode.camera);
      await tester.pump(const Duration(milliseconds: 400));

      await tester.tap(_byName('_CamFab').first);
      await tester.pump(const Duration(milliseconds: 400));

      expect(container.read(appProvider).camOn, isTrue);
      expect(_byName('_SweepLine'), findsOneWidget);
    });

    testWidgets('กลับมาโหมดเครื่องยิง → กล้องปิด ปุ่มกล้องหาย เลเซอร์ดับ',
        (tester) async {
      final container = await pumpScan(tester);
      container.read(appProvider.notifier).setScanMode(ScanMode.camera);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(_byName('_CamFab').first);
      await tester.pump(const Duration(milliseconds: 400));
      expect(container.read(appProvider).camOn, isTrue);

      await tester.tap(find.text('เครื่องยิง'));
      await tester.pump(const Duration(milliseconds: 400));

      expect(container.read(appProvider).scanMode, ScanMode.handheld);
      expect(container.read(appProvider).camOn, isFalse);
      expect(_byName('_CamFab'), findsOneWidget);
      expect(_byName('_SweepLine'), findsNothing);
      expect(find.text('ยิงบาร์โค้ดได้เลย'), findsOneWidget);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3.5 กล้อง native ต้องไปจบที่สถานะที่ "ขอไว้ล่าสุด" เสมอ
  //
  // เดิมทั้ง `_startCamera`/`_stopCamera` ขึ้นต้นด้วย `if (_busy) return;` แล้ว
  // ทิ้งคำสั่งนั้นทั้งดุ้น สลับโหมดเร็วกว่าที่ `start()` คืนค่า → กล้อง native
  // ค้างทำงานทั้งที่ `camOn == false` และปุ่มกล้องถูกถอดออกจากจอไปแล้ว
  // (Bluebird คืน BBAPI_ERROR_BARCODE_CAMERA_USED = -9 เมื่อกล้องถูกยึดแบบนี้)
  // ══════════════════════════════════════════════════════════════════

  group('กล้อง native vs camOn — คำสั่งที่สวนเข้ามาระหว่างทางต้องไม่ถูกทิ้ง', () {
    /// ตอบ method channel ของ mobile_scanner แทน native — ไม่มีของจริงในเทสต์
    /// `start` แขวนไว้ที่ [gate] ได้ เพื่อสร้างจังหวะ "สั่งเปิดค้างอยู่" ตรง ๆ
    /// แทนที่จะหวังว่า scheduler จะบังเอิญให้จังหวะนั้น
    const method =
        MethodChannel('dev.steenbakker.mobile_scanner/scanner/method');
    const events = EventChannel('dev.steenbakker.mobile_scanner/scanner/event');
    const orientation = EventChannel(
      'dev.steenbakker.mobile_scanner/scanner/deviceOrientation',
    );

    late List<String> calls;
    Completer<void>? gate;
    late String gateOn;

    /// สถานะกล้องฝั่ง native จริง ๆ — พลิกเฉพาะตอนคำสั่งไปถึงแล้ว**ไม่โยน**
    /// (ต่างจาก `controller.value.isRunning` ที่ปลั๊กอินตั้งเป็น false ไปก่อน
    ///  จะเรียก native ด้วยซ้ำ จึงโกหกทันทีที่ `stop` ล้มเหลว)
    late bool nativeRunning;

    /// ชื่อคำสั่งที่ให้ native โยนใส่ — `null` = ทำงานปกติ
    String? throwOn;

    setUp(() {
      calls = <String>[];
      gate = null;
      gateOn = 'start';
      nativeRunning = false;
      throwOn = null;
    });

    void mockPlugin(WidgetTester tester) {
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(method, (call) async {
        calls.add(call.method);
        if (gate != null && call.method == gateOn) await gate!.future;
        if (call.method == throwOn) {
          // Bluebird คืน BBAPI_ERROR_BARCODE_CAMERA_USED = -9 เมื่อกล้องถูกยึดอยู่
          throw PlatformException(
            code: 'MOBILE_SCANNER_GENERIC_ERROR',
            message: 'กล้องถูกยึดโดยกระบวนการอื่น (-9)',
          );
        }
        switch (call.method) {
          case 'state':
            return 1; // authorized
          case 'start':
            nativeRunning = true;
            // รูปร่างที่ MethodChannelMobileScanner.start() ต้องการครบชุด —
            // ขาดคีย์ไหนไปมันจะโยน genericError แล้วเทสต์จะวัดผิดเรื่อง
            return <String, Object?>{
              'textureId': 1,
              'cameraDirection': 1,
              'numberOfCameras': 1,
              'currentTorchState': 0,
              'size': <String, Object?>{'width': 640.0, 'height': 480.0},
              'handlesCropAndRotation': true,
              'naturalDeviceOrientation': 'PORTRAIT_UP',
              'sensorOrientation': 90,
            };
          case 'stop':
            nativeRunning = false;
            return null;
          default:
            return null;
        }
      });
      for (final ch in [events, orientation]) {
        tester.binding.defaultBinaryMessenger.setMockStreamHandler(
          ch,
          MockStreamHandler.inline(onListen: (_, _) {}),
        );
      }
      addTearDown(() {
        tester.binding.defaultBinaryMessenger
            .setMockMethodCallHandler(method, null);
        for (final ch in [events, orientation]) {
          tester.binding.defaultBinaryMessenger.setMockStreamHandler(ch, null);
        }
      });
    }

    /// สถานะที่ปลั๊กอินเชื่อว่ากล้องเป็นอยู่จริง — ตัวแทนของ "ฮาร์ดแวร์"
    bool cameraRunning(WidgetTester tester) => tester
        .widget<MobileScanner>(find.byType(MobileScanner))
        .controller!
        .value
        .isRunning;

    testWidgets('⭐ สลับโหมดสวนคำสั่งเปิดกล้องที่ยังไม่เสร็จ → กล้องต้องถูกปิดตาม',
        (tester) async {
      mockPlugin(tester);
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.bindScanModeHotkey(LogicalKeyboardKey.f1.keyId);
      c.setScanMode(ScanMode.camera);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      calls.clear();
      gate = Completer<void>();

      // แตะปุ่มกล้อง → _setCamera(true) ค้างรอ native ตอบ
      await tester.tap(_byName('_CamFab').first);
      await tester.pump();
      expect(calls, contains('start'), reason: 'คำสั่งเปิดต้องถึง native แล้ว');
      expect(cameraRunning(tester), isFalse, reason: 'ยังเปิดไม่เสร็จ');

      // กดปุ่มฮาร์ดแวร์สลับโหมดขณะ start() ยังไม่คืนค่า (setScanMode บังคับ camOn=false)
      await tester.sendKeyDownEvent(LogicalKeyboardKey.f1);
      await tester.pump();
      expect(container.read(appProvider).scanMode, ScanMode.handheld);
      expect(container.read(appProvider).camOn, isFalse);

      gate!.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        cameraRunning(tester),
        isFalse,
        reason: 'ก่อนแก้: คำสั่งปิดตกที่ `if (_busy) return;` แล้วหายไปเฉย ๆ '
            'เหลือกล้อง native ทำงานอยู่ทั้งที่ camOn=false และปุ่มกล้องถูกถอด '
            'ออกจากจอไปแล้ว — ไม่มีปุ่มไหนเหลือให้กดแก้',
      );
      expect(calls, containsAllInOrder(['start', 'stop']));
      await tester.pump(const Duration(milliseconds: 2500)); // ปล่อย toast หมดอายุ
    });

    testWidgets('สั่งปิดแล้วสั่งเปิดกลับระหว่างทาง → จบที่เปิด ไม่ใช่ปิดค้าง',
        (tester) async {
      mockPlugin(tester);
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.setScanMode(ScanMode.camera);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      // เปิดให้ติดจริงก่อน
      c.setCamOn(true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(cameraRunning(tester), isTrue);

      calls.clear();
      gateOn = 'stop';
      gate = Completer<void>();
      c.setCamOn(false); // สั่งปิด → ค้างรอ native
      await tester.pump();
      expect(calls, contains('stop'));
      c.setCamOn(true); // เปลี่ยนใจระหว่างที่คำสั่งปิดยังไม่จบ
      await tester.pump();
      gate!.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        cameraRunning(tester),
        isTrue,
        reason: 'ทิศกลับกันก็ต้องไล่ให้ถึงเป้าล่าสุด — ไล่รอบเดียวแล้วจบ '
            'จะเหลือกล้องปิดค้างทั้งที่ camOn=true (จอโชว์เลเซอร์กวาดบนภาพดำ)',
      );
      expect(container.read(appProvider).camOn, isTrue);
      expect(calls, containsAllInOrder(['stop', 'start']));
    });

    testWidgets('⭐ ปลุกแอปกลับมาระหว่าง stop() ที่กำลังจะล้ม → เจตนาเปิดต้องไม่ถูกกลืน',
        (tester) async {
      mockPlugin(tester);
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.setScanMode(ScanMode.camera);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      c.setCamOn(true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(nativeRunning, isTrue);

      // แอปถูกพับลง (สายเข้า/สลับแอป) → จอสั่งปิดกล้อง **โดยไม่แตะ camOn**
      // เพราะผู้ใช้ไม่ได้สั่งปิด ตั้งใจให้กลับมาแล้วเปิดต่อเอง
      calls.clear();
      gateOn = 'stop';
      gate = Completer<void>();
      throwOn = 'stop';
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(calls, contains('stop'), reason: 'คำสั่งปิดต้องถึง native แล้ว');
      expect(container.read(appProvider).camOn, isTrue, reason: 'pause ไม่แตะ camOn');

      // ผู้ใช้กลับเข้าแอปก่อนที่ stop() จะคืนค่า — คิวคำสั่งเปิดไว้แล้ว
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // แล้ว stop() ของรอบก่อนหน้าค่อยล้ม (กล้องถูกยึด BBAPI -9)
      gate!.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        container.read(appProvider).camOn,
        isTrue,
        reason: 'ก่อนแก้: ความล้มของ **เป้าเก่า** บังคับ camOn=false ทับเจตนา'
            'ที่ใหม่กว่า → `ref.listen` วิ่งกลับเข้า `_setCamera(false)` แล้วลบ'
            'คำสั่งเปิดที่คิวไว้ทิ้ง ผู้ใช้กลับมาเจอกล้องดับโดยไม่รู้ว่าต้องแตะ FAB ซ้ำ',
      );
      expect(
        nativeRunning,
        isTrue,
        reason: 'เป้าล่าสุดคือเปิด — `_setCamera` ต้องวนต่อไปสั่ง start() จริง',
      );
      expect(
        container.read(appProvider).camStatus,
        isNot(CamStatus.detectorUnavailable),
        reason: 'ป้าย "ตัวอ่านไม่พร้อม" ที่คร่อมกล้องซึ่งกลับมาทำงานแล้วคือคำโกหก',
      );
      expect(
        calls.where((m) => m == 'stop'),
        hasLength(1),
        reason: 'ไม่ลองเป้าเดิมซ้ำ — ปรองดอง ≠ retry loop',
      );
    });

    testWidgets('⭐ stop() ของ native โยน exception → ต้องปรองดองได้ ไม่ใช่ค้างสถานะโกหก',
        (tester) async {
      mockPlugin(tester);
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.setScanMode(ScanMode.camera);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      // เปิดให้ติดจริงก่อน
      c.setCamOn(true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(nativeRunning, isTrue);

      // กล้องถูกยึด → `stop()` โยน · ผู้ใช้สลับไปโหมดเครื่องยิงพอดี ซึ่งเป็นโหมด
      // ที่ **ไม่มีปุ่มกล้องบนจอเลย** ผู้ใช้จึงไม่มีทางสั่งแก้ด้วยตัวเอง
      calls.clear();
      throwOn = 'stop';
      c.setScanMode(ScanMode.handheld);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(calls, contains('stop'), reason: 'คำสั่งปิดต้องถึง native แล้ว');
      expect(container.read(appProvider).camOn, isFalse);
      expect(
        container.read(appProvider).camStatus,
        CamStatus.detectorUnavailable,
        reason: 'ก่อนแก้: ฝั่ง "ปิดไม่สำเร็จ" เงียบสนิท เหลือแค่ debugPrint — '
            'กล้องยังยึดเซ็นเซอร์อยู่ (เครื่องยิงก็พลอยอ่านไม่ได้) โดยไม่มีอะไร'
            'บอกผู้ใช้เลย ต้องรายงานผ่าน CamStatus เหมือนตอนเปิดไม่ได้',
      );
      expect(
        calls.where((m) => m == 'stop'),
        hasLength(lessThanOrEqualTo(2)),
        reason: 'ปรองดอง ≠ ไล่ยิงคำสั่งเดิมใส่ native ไม่รู้จบ',
      );

      // เหตุขัดข้องหาย (อีกแอปคืนเซ็นเซอร์ กล้องดับจริง) ผู้ใช้กลับมาโหมดกล้อง
      // แล้วแตะเปิด → ต้องเปิดติดจริง ไม่ใช่ติดแต่ในสถานะ
      throwOn = null;
      nativeRunning = false;
      calls.clear();
      c.setScanMode(ScanMode.camera);
      await tester.pump();
      await tester.tap(_byName('_CamFab').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(container.read(appProvider).camOn, isTrue);
      expect(
        nativeRunning,
        isTrue,
        reason: 'ก่อนแก้: `_appliedCamOn` ยังจำว่า "เปิดอยู่" จากรอบที่ stop() โยน '
            'คำสั่งเปิดรอบนี้จึงถูกมองว่าตรงเป้าอยู่แล้วและไม่ถึง native เลย — '
            'เหลือ camOn=true คร่อมกล้องที่ไม่ได้ทำงาน (เลเซอร์กวาดบนภาพดำถาวร) '
            'สถานะที่ไม่รู้ต้องเป็น null ไม่ใช่ค่าเดิม คำสั่งครั้งหน้าจึงถึง native',
      );
      expect(calls, contains('start'));
      await tester.pump(const Duration(milliseconds: 2500)); // ปล่อย toast หมดอายุ
    });

    testWidgets('⭐ กล้องปิดไม่ลงในโหมดเครื่องยิง → ป้าย+toast ต้องบอก ไม่ใช่ "พร้อมยิง"',
        (tester) async {
      mockPlugin(tester);
      final container = containerOf();
      final c = container.read(appProvider.notifier);
      c.setScanMode(ScanMode.camera);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      c.setCamOn(true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(nativeRunning, isTrue);

      // กล้องถูกยึด → `stop()` โยนตอนสลับไปโหมดเครื่องยิง ซึ่งเป็นโหมดที่ไม่มี
      // ปุ่มกล้อง ไม่มี preview ให้เห็นว่าดับไหม เหลือป้ายสถานะกับ toast เท่านั้น
      throwOn = 'stop';
      c.setScanMode(ScanMode.handheld);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(container.read(appProvider).camOn, isFalse);
      expect(nativeRunning, isTrue, reason: 'ฮาร์ดแวร์ยังยึดเซ็นเซอร์อยู่จริง');
      expect(
        container.read(appProvider).camStatusText,
        CamStatus.detectorUnavailable.text,
        reason: 'ก่อนแก้: camStatusText กลบ camStatus ทั้งก้อนด้วย '
            '"พร้อมยิงบาร์โค้ด · handheld" ในโหมดเครื่องยิง — camOn บอกว่าปิดแล้ว '
            'สวนทางกับกล้องที่ยังทำงานอยู่ โดยผู้ใช้ไม่มีทางรู้เลย '
            '(กล้องที่ยึดเซ็นเซอร์ = เครื่องยิงพลอยอ่านไม่ได้ BBAPI -9)',
      );
      expect(
        find.text(CamStatus.detectorUnavailable.text),
        findsWidgets,
        reason: 'ป้ายสถานะในกรอบสแกนต้องขึ้นข้อความนี้จริง ไม่ใช่แค่ใน state',
      );
      expect(
        container.read(appProvider).toast,
        CamStatus.detectorUnavailable.text,
        reason: 'คนที่กำลังเล็งฉลากอยู่ไม่ได้มองป้ายมุมกรอบ ต้องมี toast สะกิด',
      );
      await tester.pump(const Duration(milliseconds: 2500)); // ปล่อย toast หมดอายุ
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. ดีดัพข้ามแหล่งอ่าน — เครื่องยิงทำงานคู่กับกล้องเสมอทั้งสองโหมด
  // ══════════════════════════════════════════════════════════════════

  group('ดีดัพ 1500ms — ฉลากเดียวสองแหล่ง = 1 สแกน · แหล่งเดิมซ้ำ = ของสองชิ้น',
      () {
    /// ⚠️ นับจำนวน `_resolve` ที่ทำงานจริงจาก `HapticFeedback.mediumImpact()`
    ///    ไม่ใช่จาก `scans.length` — `addScan` ดีดัพตาม sku อยู่แล้ว (สแกนซ้ำ
    ///    เด้งขึ้นบนแทนที่จะเพิ่มแถว) ความยาวลิสต์จึงเป็น 1 ทั้งสองกรณี
    ///    แยกไม่ออกว่าด่านดีดัพทำงานหรือไม่
    Future<ProviderContainer> pumpWithHaptics(
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
      final container = containerOf();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      return container;
    }

    /// นาฬิกาที่วัดจังหวะคีย์ — ต้องเดินตามที่เทสต์สั่ง ไม่ใช่ตามภาระของ runner
    /// (ถ้าปล่อยให้เป็นเวลาจริง ช่องไฟระหว่างคีย์คือสัญญาณรบกวน สายรัวจะขาด
    ///  หรือไม่ขาดแล้วแต่เครื่องที่รัน)
    late DateTime clock;
    setUp(() {
      clock = DateTime(2026, 9, 3, 10);
      handheldNow = () => clock;
    });
    tearDown(() => handheldNow = DateTime.now);

    /// ยิงบาร์โค้ดหนึ่งชุดแบบเครื่องยิงจริง (อักขระห่างกัน 10ms + Enter ปิดท้าย)
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

    /// กล้องอ่านฉลากหนึ่งใบ — เรียก `onDetect` ตรง ๆ เพราะกล้องจริงไม่มีในเทสต์
    /// (`_onDetect` เกทด้วย `camOn` จึงต้องเปิดค้างไว้ก่อนยิง callback)
    void detect(WidgetTester tester, ProviderContainer c, String code) {
      c.read(appProvider.notifier).setCamOn(true);
      tester.widget<MobileScanner>(find.byType(MobileScanner)).onDetect!(
        BarcodeCapture(barcodes: [Barcode(rawValue: code)]),
      );
    }

    testWidgets('⭐ ยิงรหัสเดิมซ้ำด้วยเครื่องเดิม → resolve สองครั้ง (ของสองชิ้น)',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpWithHaptics(tester, haptics);

      await shoot(tester, '8851234567890');
      await shoot(tester, '8851234567890');

      expect(
        haptics,
        hasLength(2),
        reason: 'สินค้าไม่ซีเรียลสองชิ้นใช้บาร์โค้ดเดียวกัน ยิงติด ๆ กันคือของ '
            'สองชิ้นจริง — กลืนตัวที่สองทิ้ง = ไม่สั่น ไม่เด้งการ์ด ไม่มี scan_event',
      );
      // `addScan` ดีดัพตาม sku อยู่แล้ว (สแกนซ้ำเด้งขึ้นบน) ลิสต์จึงยาว 1 เท่าเดิม
      // — วัดด่านดีดัพจาก haptics เท่านั้น ความยาวลิสต์แยกสองกรณีนี้ไม่ออก
      expect(container.read(appProvider).scans, hasLength(1));
    });

    testWidgets('กล้องกับเครื่องยิงอ่านใบเดียวกันพร้อมกัน → resolve ครั้งเดียว',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpWithHaptics(tester, haptics);

      detect(tester, container, '8851234567890');
      await tester.pump();
      await shoot(tester, '8851234567890');

      expect(haptics, hasLength(1), reason: 'ฉลากใบเดียว อ่านสองแหล่ง = 1 สแกน');

      // แหล่งเดิมเจอรหัสเดิมอีกครั้ง = ชิ้นใหม่ ไม่ใช่เสียงสะท้อนของใบเดิม
      await shoot(tester, '8851234567890');
      expect(haptics, hasLength(2));
    });

    testWidgets('พ้น 1500ms แล้วอีกแหล่งอ่านรหัสเดิม → คนละใบ resolve ใหม่',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpWithHaptics(tester, haptics);

      detect(tester, container, '8851234567890');
      await tester.pump();
      // `_resolve` ใช้ DateTime.now() จริง ต้องหน่วงเวลาจริง ไม่ใช่ pump
      // ⚠️ ใช้ `sleep` ไม่ใช่ `runAsync` — `runAsync` ปล่อยให้ EventChannel ของ
      //    mobile_scanner (ที่ไม่มี native ในเทสต์) โยน MissingPluginException
      //    เข้ามาเป็น "unexpected exception" ทั้งที่ไม่เกี่ยวกับสิ่งที่เทสต์นี้วัด
      sleep(const Duration(milliseconds: 1600));
      await shoot(tester, '8851234567890');

      expect(haptics, hasLength(2));
    });

    testWidgets('⭐ ยิงแล้วพิมพ์รหัสเดิมด้วยมือทันที → ทางออกฉุกเฉินต้องไม่ถูกด่านกลืน',
        (tester) async {
      final haptics = <String>[];
      await pumpWithHaptics(tester, haptics);

      await shoot(tester, '8851234567890');
      expect(haptics, hasLength(1));

      // ปุ่ม "กรอกรหัสบาร์โค้ด" บนแถบเครื่องมือ (หา Semantics ตรง ๆ ไม่ต้องเปิด
      // semantics tree ทั้งจอ) → พิมพ์รหัสเดิม → ยืนยัน
      await tester.tap(
        find.byWidgetPredicate(
          (w) => w is Semantics && w.properties.label == 'กรอกรหัสบาร์โค้ด',
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(find.byType(TextField), '8851234567890');
      await tester.pump();
      await tester.tap(find.text('ยืนยัน'));
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        haptics,
        hasLength(2),
        reason: 'รหัสที่คนพิมพ์เอง = ความตั้งใจ ไม่ใช่ฉลากใบเดิมถูกอ่านซ้ำ — '
            'ถ้าไม่มี allowDuplicate ด่านจะเห็นว่าแหล่ง manual ยังไม่ได้อ่าน '
            'ใบนี้แล้วกลืนทิ้ง ทางออกตอนกล้อง/เครื่องยิงอ่านผิดจึงใช้ไม่ได้',
      );
    });

    testWidgets('สลับรหัสไปมา → ทุกฉลากใหม่ resolve ทันที ไม่ถูกกลืน',
        (tester) async {
      final haptics = <String>[];
      final container = await pumpWithHaptics(tester, haptics);

      await shoot(tester, '8851234567890');
      await shoot(tester, '8859900112233');

      expect(haptics, hasLength(2));
      expect(container.read(appProvider).scans, hasLength(2));
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. ปุ่มฮาร์ดแวร์สลับโหมด (R4)
  // ══════════════════════════════════════════════════════════════════

  group('ปุ่มฮาร์ดแวร์ที่ผูกไว้ — สลับโหมดโดยไม่ต้องแตะจอ', () {
    /// `f1` เป็นตัวแทนปุ่ม Programmable ของ S20: ไม่มี character ไม่ใช่ Enter
    /// ไม่อยู่ใน denylist — คุณสมบัติเดียวกับปุ่มที่แผนแนะนำให้ผูกจริง
    final hotkey = LogicalKeyboardKey.f1;

    Future<ProviderContainer> pumpBound(WidgetTester tester) async {
      final container = containerOf();
      container.read(appProvider.notifier).bindScanModeHotkey(hotkey.keyId);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      return container;
    }

    testWidgets('กดปุ่มที่ผูกไว้ → สลับโหมด + toast บอกว่าเปลี่ยนไปโหมดไหน',
        (tester) async {
      final container = await pumpBound(tester);

      final handled = await tester.sendKeyDownEvent(hotkey);
      await tester.pump(const Duration(milliseconds: 400));

      expect(handled, isTrue, reason: 'ต้องกลืนคีย์ ไม่ปล่อยไหลไปช่องกรอก');
      expect(container.read(appProvider).scanMode, ScanMode.camera);
      expect(container.read(appProvider).toast, 'โหมดกล้อง · camera');
      // toast ตั้ง Future.delayed 2400ms ไว้ — ปล่อยให้หมดอายุก่อนจบเทสต์
      await tester.pump(const Duration(milliseconds: 2500));
    });

    testWidgets('KeyUpEvent ของปุ่มเดียวกัน → ไม่สลับซ้ำ', (tester) async {
      final container = await pumpBound(tester);
      await tester.sendKeyDownEvent(hotkey);
      await tester.pump();

      await tester.sendKeyUpEvent(hotkey);
      await tester.pump();

      expect(container.read(appProvider).scanMode, ScanMode.camera);
      await tester.pump(const Duration(milliseconds: 2500));
    });

    testWidgets('กดรัวเร็วกว่า 300ms → คูลดาวน์กันหน้าสัมผัสเด้ง',
        (tester) async {
      final container = await pumpBound(tester);
      await tester.sendKeyDownEvent(hotkey);
      await tester.sendKeyUpEvent(hotkey);
      await tester.pump();
      expect(container.read(appProvider).scanMode, ScanMode.camera);

      await tester.sendKeyDownEvent(hotkey);
      await tester.pump();
      expect(
        container.read(appProvider).scanMode,
        ScanMode.camera,
        reason: 'ยังอยู่ในคูลดาวน์ — ห้ามสลับกลับ',
      );

      // พ้นคูลดาวน์ (เวลาจริง เพราะ `_handleHotkey` ใช้ DateTime.now())
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 350)),
      );
      await tester.sendKeyUpEvent(hotkey);
      await tester.sendKeyDownEvent(hotkey);
      await tester.pump();
      expect(container.read(appProvider).scanMode, ScanMode.handheld);
      await tester.pump(const Duration(milliseconds: 2500));
    });

    testWidgets('สลับโหมด → ทิ้งเศษรหัสที่ค้างในบัฟเฟอร์เครื่องยิง',
        (tester) async {
      final container = await pumpBound(tester);

      // ยิงค้างไว้ครึ่งรหัสแล้วสลับโหมด — Enter หลังจากนั้นต้องไม่ประกอบรหัสต่อ
      await tester.sendKeyDownEvent(
        LogicalKeyboardKey.digit8,
        character: '8',
      );
      await tester.sendKeyDownEvent(
        LogicalKeyboardKey.digit5,
        character: '5',
      );
      await tester.pump();
      await tester.tap(find.text('กล้อง'));
      await tester.pump(const Duration(milliseconds: 400));

      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(container.read(appProvider).scans, isEmpty);
    });

    testWidgets('ยังไม่ผูกปุ่ม → คีย์ที่ไม่มี character ไหลผ่านตามปกติ',
        (tester) async {
      final container = containerOf();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ScanScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      final handled = await tester.sendKeyDownEvent(hotkey);
      await tester.pump();

      expect(handled, isFalse);
      expect(container.read(appProvider).scanMode, ScanMode.handheld);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. จอผู้ดูแล — แท็บ "ปุ่มเครื่อง"
  // ══════════════════════════════════════════════════════════════════

  group('จอผู้ดูแล · ปุ่มเครื่อง — ด่านปฏิเสธถาวร ไม่มี override', () {
    Future<ProviderContainer> pumpPane(
      WidgetTester tester, {
      Size size = const Size(392, 846),
    }) async {
      final container = containerOf(withApi: true);
      container.read(adminViewProvider.notifier).select(AdminView.deviceKeys);
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: AdminScreen())),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      return container;
    }

    /// เว้นระยะเวลา**จริง**ให้พ้นหน้าต่าง burst 200ms — `_onProbeKey` ใช้
    /// `DateTime.now()` เทียบเวลาจริง `tester.pump(Duration)` จึงแยกคีย์ไม่ได้
    Future<void> gap(WidgetTester tester) => tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 300)),
        );

    testWidgets('มีแท็บที่ 4 และเข้าถึงแท็บปุ่มเครื่องได้', (tester) async {
      await pumpPane(tester);

      expect(find.text('ปุ่มเครื่อง'), findsOneWidget);
      expect(_byName('_DeviceKeysPane'), findsOneWidget);
      expect(find.text('ยังไม่ได้ผูกปุ่ม'), findsOneWidget);
      expect(
        find.text('ยังไม่มีปุ่มไหนส่งคีย์มาถึงแอป — กดปุ่มบนเครื่องได้เลย'),
        findsOneWidget,
      );
    });

    testWidgets('ปุ่มปรับเสียง → ปฏิเสธถาวร ไม่มีปุ่มให้ผูก', (tester) async {
      final container = await pumpPane(tester);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.audioVolumeDown);
      await tester.pump();

      expect(_byName('_CapturedKeyCard'), findsOneWidget);
      expect(
        find.textContaining('ปุ่มนี้เป็นปุ่มระบบของเครื่อง'),
        findsOneWidget,
      );
      expect(find.text('ตั้งเป็นปุ่มสลับโหมด'), findsNothing);
      expect(container.read(appProvider).scanModeHotkey, isNull);
    });

    testWidgets('ปุ่มที่พิมพ์อักขระได้ → ปฏิเสธ (เป็นเนื้อรหัสบาร์โค้ดได้)',
        (tester) async {
      await pumpPane(tester);

      await tester.sendKeyDownEvent(
        LogicalKeyboardKey.digit8,
        character: '8',
      );
      await tester.pump();

      expect(find.textContaining('ปุ่มนี้พิมพ์อักขระได้'), findsOneWidget);
      expect(find.text('ตั้งเป็นปุ่มสลับโหมด'), findsNothing);
    });

    testWidgets('Enter → ปฏิเสธ (ตัดรหัสที่กำลังยิงให้จบก่อนเวลา)',
        (tester) async {
      await pumpPane(tester);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(find.textContaining('ปุ่มนี้คือ Enter'), findsOneWidget);
      expect(find.text('ตั้งเป็นปุ่มสลับโหมด'), findsNothing);
    });

    testWidgets('คีย์ที่มาติดกันเป็นชุด → ปฏิเสธด้วยเหตุผล burst',
        (tester) async {
      await pumpPane(tester);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.f1);
      await tester.pump();
      expect(find.text('ตั้งเป็นปุ่มสลับโหมด'), findsOneWidget);

      // ตัวที่สองมาห่างไม่ถึง 200ms — ลายเซ็นของปุ่มยิงบาร์โค้ด
      await tester.sendKeyDownEvent(LogicalKeyboardKey.f2);
      await tester.pump();

      expect(find.textContaining('ปุ่มนี้มาเป็นชุดติดกันเร็ว ๆ'), findsOneWidget);
      expect(find.text('มาเป็นชุด'), findsOneWidget);
      expect(
        find.text('ตั้งเป็นปุ่มสลับโหมด'),
        findsOneWidget,
        reason: 'เหลือของ f1 ใบเดียว — f2 ที่มาเป็นชุดต้องไม่มีปุ่มผูก',
      );
    });

    testWidgets('ปุ่มเดี่ยวที่ผ่านทุกด่าน → ผูกได้ และถอนได้', (tester) async {
      final container = await pumpPane(tester);

      await gap(tester);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.f1);
      await tester.pump();

      await tester.tap(find.text('ตั้งเป็นปุ่มสลับโหมด'));
      await tester.pump();
      expect(
        container.read(appProvider).scanModeHotkey,
        LogicalKeyboardKey.f1.keyId,
      );
      // (การเขียนลง KvMeta ครอบไว้แล้วในกลุ่ม "เก็บโหมดระดับเครื่อง" —
      //  รอ write ในเทสต์ widget ไม่ได้ เพราะนาฬิกาเป็นของ fake async)

      await tester.tap(find.text('ล้างปุ่มที่ตั้งไว้'));
      await tester.pump();
      expect(container.read(appProvider).scanModeHotkey, isNull);
    });

    testWidgets('log เก็บไม่เกิน 8 แถว (จอไม่ยาวไม่รู้จบ)', (tester) async {
      // จอสูงพิเศษเพื่อให้ ListView สร้างการ์ดครบทุกใบในเฟรมเดียว
      await pumpPane(tester, size: const Size(392, 2600));

      for (final key in [
        LogicalKeyboardKey.f1,
        LogicalKeyboardKey.f2,
        LogicalKeyboardKey.f3,
        LogicalKeyboardKey.f4,
        LogicalKeyboardKey.f5,
        LogicalKeyboardKey.f6,
        LogicalKeyboardKey.f7,
        LogicalKeyboardKey.f8,
        LogicalKeyboardKey.f9,
        LogicalKeyboardKey.f10,
      ]) {
        await tester.sendKeyDownEvent(key);
      }
      await tester.pump();

      expect(_byName('_CapturedKeyCard'), findsNWidgets(8));
    });

    // ── ผลวัดจังหวะคีย์ — ทำให้การตั้ง burstGap หน้างานเป็นการ "อ่านค่า" ──
    //
    // burstGap ค้ำด่านป้องกันทั้งสองชั้นของจอสแกน แต่ยังไม่เคยวัดกับ S20 ตัวจริง
    // ถ้าเกณฑ์เตี้ยไป สายรัวจะพิสูจน์ไม่ได้เลย แล้วตาข่ายกู้ยอดหยุดทำงานเงียบ ๆ

    testWidgets('⭐ การ์ดผลวัด — อ่านค่าที่วัดได้ เทียบกับเกณฑ์ที่ใช้อยู่',
        (tester) async {
      HandheldGapLog.shared.clear();
      addTearDown(HandheldGapLog.shared.clear);
      for (final gap in [12, 14, 13]) {
        HandheldGapLog.shared.record(gap);
      }

      // จอสูงพิเศษ: การ์ดนี้อยู่ท้ายลิสต์ (ลิสต์คีย์ต้องอยู่บนสุดเสมอ)
      await pumpPane(tester, size: const Size(392, 2600));

      expect(
        find.text('70 ms'),
        findsOneWidget,
        reason: 'ต้องโชว์เกณฑ์ที่ใช้อยู่จริงจาก HandheldScanBuffer ไม่ใช่ตัวเลข'
            'ที่พิมพ์ซ้ำไว้ที่จอ — ปรับเกณฑ์แล้วจอบอกค่าเก่าคือกับดัก',
      );
      expect(find.text('12 / 13 / 14 ms · จาก 3 ค่า'), findsOneWidget);
      expect(
        find.text('12 · 14 · 13'),
        findsOneWidget,
        reason: 'เรียงตามเวลาจริง ช่างต้องเห็นรูปร่างของการยิงหนึ่งชุด',
      );

      await tester.tap(find.text('ล้างค่าที่วัดไว้'));
      await tester.pump();
      expect(HandheldGapLog.shared.gaps, isEmpty);
      expect(
        find.text('ยังไม่มีค่าที่วัดได้ — ยังไม่มีใครยิงบาร์โค้ดตั้งแต่เปิดแอป'),
        findsOneWidget,
      );
    });

    testWidgets('ค่าที่วัดได้ชนเกณฑ์ → เตือนว่าเกณฑ์เตี้ยไปสำหรับเครื่องรุ่นนี้',
        (tester) async {
      HandheldGapLog.shared.clear();
      addTearDown(HandheldGapLog.shared.clear);
      HandheldGapLog.shared.record(
        HandheldScanBuffer.defaultBurstGap.inMilliseconds,
      );

      await pumpPane(tester, size: const Size(392, 2600));

      expect(
        find.textContaining('ค่าสูงสุดที่วัดได้ (70 ms) ชนเกณฑ์ 70 ms'),
        findsOneWidget,
        reason: 'ตัวเลขดิบอย่างเดียวช่างต้องเทียบเอง — จอต้องบอกว่าค่าที่วัดได้'
            'แปลว่าอะไร ไม่งั้นการวัดก็ไม่ได้ตอบอะไร',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. ล้นแถวที่จอแคบ + ตัวอักษรใหญ่ (§5.2 — 360/430 × text scale 1.3)
  // ══════════════════════════════════════════════════════════════════

  group('ไม่ล้นแถวที่ 360/430 กับ text scale 1.3', () {
    Future<void> pumpAt(
      WidgetTester tester,
      Size size, {
      required Widget child,
      ProviderContainer? container,
    }) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container ?? containerOf(),
          child: MaterialApp(
            home: MediaQuery(
              data: const MediaQueryData(textScaler: TextScaler.linear(1.3)),
              child: Scaffold(body: child),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
    }

    for (final size in const [Size(360, 640), Size(430, 932)]) {
      testWidgets('แถบสลับโหมดที่ ${size.width.toInt()}px ทั้งสองโหมด',
          (tester) async {
        final container = containerOf();
        await pumpAt(
          tester,
          size,
          container: container,
          child: const ScanScreen(),
        );
        expect(tester.takeException(), isNull);

        container.read(appProvider.notifier).setScanMode(ScanMode.camera);
        await tester.pump(const Duration(milliseconds: 400));
        expect(tester.takeException(), isNull);

        // มีผลสแกนแล้ว = กรอบกล้องหด แถบโหมดยังต้องอยู่ครบ
        container.read(appProvider.notifier).addScan('SKU-40128');
        await tester.pump(const Duration(milliseconds: 400));
        expect(tester.takeException(), isNull);

        container.read(appProvider.notifier).setScanMode(ScanMode.handheld);
        await tester.pump(const Duration(milliseconds: 400));
        expect(tester.takeException(), isNull);
        expect(find.text('เครื่องยิง'), findsOneWidget);
      });
    }

    testWidgets('แท็บจอผู้ดูแล 4 ช่องที่ 360px ("ปุ่มเครื่อง" ยาวที่สุด)',
        (tester) async {
      final container = containerOf(withApi: true);
      await pumpAt(
        tester,
        const Size(360, 640),
        container: container,
        child: const AdminScreen(),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('ปุ่มเครื่อง'), findsOneWidget);
    });
  });
}
