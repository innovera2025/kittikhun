import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/core/theme/tcl_tokens.dart';
import 'package:tcl_stock/features/scan/scan_screen.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เทสต์ของบั๊กที่พนักงานเจอหน้างาน 5 ก.ย. 2569
///
/// P1 "Clear text เพื่อกรอกใหม่ไม่ได้"
/// P2 "เมื่อ Scan หลายตัวไม่สามารถกรอกรายการตั้งแต่รายการที่สองได้"
///
/// สองกลุ่มแรก (P1 · P2) เขียนขึ้นเป็น **ตัวจำลองบั๊ก** ก่อนมีทางแก้ — ทั้งแปดตัว
/// แดงกับโค้ดวันนั้น และเป็นตัวชี้ขาดว่าทางแก้ถูกจุด ห้ามผ่อนเกณฑ์ตัวไหนเพื่อให้เขียว
///
/// กลุ่มที่สาม (ยอมรับงาน) เขียนขึ้นทีหลังจากประโยคที่เจ้าของสั่งไว้ตรง ๆ:
/// "ต้องสามารถสแกนแล้วมากรอกข้อมูลได้ทุกตัว และต้องส่งรายการได้มากกว่าหนึ่งรายการ"
/// — P1/P2 พิสูจน์ว่ากลไกที่พังถูกซ่อม ส่วนกลุ่มนี้พิสูจน์ว่า **งานที่เจ้าของขอ
/// ทำได้จริงตั้งแต่ต้นจนจบ** ซึ่งไม่มีเทสต์ตัวไหนก่อนหน้านี้ครอบ
///
/// ── ข้อจำกัดของ flutter_test ที่ทุกเทสต์ในไฟล์นี้เดินตาม ──────────────────
/// `sendKeyDownEvent()` ป้อนคีย์ดิบเข้า `KeyboardManager` จริง (จึงวิ่งผ่าน
/// `Focus.onKeyEvent` → `_onHandheldKey`) แต่ **ไม่มี InputConnectionAdaptor**
/// ให้พิมพ์ตัวอักษรลงช่องต่อ คีย์ที่ไม่ถูกกลืนจึงต้องจำลองการพิมพ์เองด้วย
/// `enterText()` — เขียนกำกับไว้ทุกจุดที่ทำ
void main() {
  late LocalDb db;
  setUp(() => db = LocalDb(NativeDatabase.memory()));
  tearDown(() => db.close());

  /// นาฬิกาที่ `_onHandheldKey` ใช้วัดช่องไฟระหว่างคีย์ (ดู `handheldNow`)
  late DateTime clock;
  setUp(() {
    clock = DateTime(2026, 9, 5, 10);
    handheldNow = () => clock;
  });
  tearDown(() => handheldNow = DateTime.now);

  const gun = Duration(milliseconds: 10); // เครื่องยิง HID
  const human = Duration(milliseconds: 150); // นิ้วคนแตะคีย์บอร์ดจอ
  const burstDies = Duration(milliseconds: 900); // เกิน idleReset 800ms

  const skuA = 'SKU-40128', barcodeA = '8851234567890';
  const nameA = 'สลักเกลียวหัวหกเหลี่ยม M12';
  const skuB = 'SKU-77340', barcodeB = '8859900112233';
  const nameB = 'เทปพันสายไฟ PVC 19 มม.';

  /// จอสแกนในกล่องเดียวกับของจริง — `TclRoot` ห่อทั้งแอปด้วย
  /// `Scaffold(body: SafeArea(...))` และ manifest ตั้ง `adjustResize`
  /// (สำคัญกับ P2-2: Scaffold กิน viewInsets ของ body ไปก่อน)
  Future<ProviderContainer> pumpScreen(WidgetTester tester) async {
    final container = ProviderContainer(
      overrides: [localDbProvider.overrideWithValue(db)],
    );
    addTearDown(container.dispose);
    tester.view.physicalSize = const Size(392, 846); // ขนาดที่ design อ้างอิง
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(
          home: Scaffold(body: SafeArea(child: ScanScreen())),
        ),
      ),
    );
    // pumpAndSettle ไม่ได้ — เส้นเลเซอร์/pulse ของจอสแกนวนไม่รู้จบ
    await tester.pump(const Duration(milliseconds: 400));
    return container;
  }

  /// ถอดจออย่างสงบ — ไล่ post-frame callback ที่ `dispose` นัดไว้ให้จบก่อน
  /// container ถูกทิ้ง ไม่งั้นเทสต์ **ตัวถัดไป** เป็นคนกินระเบิดแทน
  Future<void> closeScreen(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold()));
    await tester.pump();
    await tester.pump();
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();
  }

  /// กดหนึ่งคีย์หลังเลื่อนนาฬิกาไป [after] — คืน `true` เมื่อ **จอกลืนคีย์นั้น**
  /// (กลืน = บนเครื่องจริงเอนจินจะไม่พิมพ์อักขระตัวนี้ลงช่องที่โฟกัสอยู่)
  Future<bool> key(WidgetTester tester, String ch, Duration after) async {
    clock = clock.add(after);
    final handled = await tester.sendKeyDownEvent(
      LogicalKeyboardKey.digit0, // logicalKey ไม่สำคัญเท่า character
      character: ch,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.digit0);
    return handled;
  }

  Future<bool> enterKey(WidgetTester tester, Duration after) async {
    clock = clock.add(after);
    final handled = await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    return handled;
  }

  /// ยิงบาร์โค้ดหนึ่งใบแบบ keyboard wedge — อักขระห่าง 10ms + Enter ปิดท้าย
  /// [lead] = เว้นจาก **คีย์ก่อนหน้า** เท่าไรก่อนเริ่มยิง (คีย์ของใครก็ได้)
  Future<void> shoot(
    WidgetTester tester,
    String code, {
    bool enter = true,
    Duration lead = const Duration(seconds: 2),
  }) async {
    var first = true;
    for (final ch in code.split('')) {
      await key(tester, ch, first ? lead : gun);
      first = false;
    }
    if (enter) await enterKey(tester, gun);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  TextEditingController countCtrl(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!;

  /// กางการ์ดแล้วโฟกัสช่องจำนวน (ทางเดียวกับที่พนักงานแตะ)
  Future<void> openCount(WidgetTester tester, String cardName) async {
    await tester.tap(find.text(cardName));
    await tester.pump();
    await tester.tap(find.byType(TextField));
    await tester.pump();
  }

  Rect rectOf(WidgetTester tester, Finder f) {
    final box = tester.renderObject<RenderBox>(f.first);
    return box.localToGlobal(Offset.zero) & box.size;
  }

  // ══════════════════════════════════════════════════════════════════
  // P1 — "Clear text เพื่อกรอกใหม่ไม่ได้"
  //
  // `HandheldScanBuffer` ตัดสิน "สายรัวของเครื่องยิง" จาก **ช่องไฟระหว่างคีย์**
  // อย่างเดียว (`gap <= burstGap` = 70ms) ไม่ได้ดูว่าคีย์นั้นมาจากไหน และ
  // `_burst` **เหนียว**: ไม่มีอะไรล้างมันนอกจาก Enter บนบัฟเฟอร์ที่ไม่ว่าง /
  // ช่องไฟเกิน idleReset (800ms) / `reset()`
  //
  // ตาข่าย snapshot–restore ของจอแขวนอยู่บน `_burst` ทั้งชุด แต่ snapshot ถูก
  // เก็บจากคีย์ของ **คน** ด้วย (ตามดีไซน์) — พอ `_burst` เป็นจริงเพราะคน
  // ตาข่ายจึงกู้ค่าที่คนเพิ่งพิมพ์กลับเป็นค่าก่อนหน้า
  // ══════════════════════════════════════════════════════════════════

  group('P1 · ล้าง/กรอกใหม่ในช่องจำนวน', () {
    testWidgets('⭐ P1-1 คนแตะเลขสองตัวห่าง 60ms → ตัวที่สองถูกจอกลืนทิ้ง',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);

      expect(await key(tester, '7', const Duration(seconds: 2)), isFalse);
      await tester.enterText(find.byType(TextField), '7'); // จำลองเอนจินพิมพ์ลง

      expect(
        await key(tester, '5', const Duration(milliseconds: 60)),
        isFalse,
        reason: 'true = จอกลืนเลขที่นิ้วคนแตะ → `KeyboardManager.onUnhandled()` '
            'ไม่ถูกเรียก เลขหายจากช่องเงียบ ๆ · เกณฑ์ burstGap 70ms ตัดสินจาก'
            'ช่องไฟอย่างเดียว ไม่ได้ดูว่าใครเป็นคนกด',
      );
    });

    testWidgets('⭐ P1-2 ล้างช่องแล้วกรอกใหม่ → 0.8 วิต่อมาค่าที่เพิ่งกรอกหายไปเอง',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);

      // พนักงานเคยคีย์ 19 ไว้ แล้วล้างทิ้งเพื่อกรอกใหม่
      await tester.enterText(find.byType(TextField), '19');
      await settle(tester);
      expect(container.read(appProvider).counts[skuA], '19');
      await tester.enterText(find.byType(TextField), '');
      await settle(tester);
      expect(container.read(appProvider).counts[skuA], '');

      // กรอกใหม่เป็น 75 — ตัวแรกไหลลงช่องปกติ ตัวที่สองแตะเร็วไป 60ms
      await key(tester, '7', const Duration(seconds: 2));
      await tester.enterText(find.byType(TextField), '7');
      await settle(tester);
      expect(container.read(appProvider).counts[skuA], '7');
      await key(tester, '5', const Duration(milliseconds: 60)); // ถูกกลืน

      // พนักงานยกมือออกจากจอ (คิดเลข/ยกของ) นานกว่า `_burstDeath` 800ms
      await tester.pump(burstDies);
      await settle(tester);

      expect(
        countCtrl(tester).text,
        '7',
        reason: '`_armBurstDeath` ตั้งเส้นตายเพราะ `_burst` เป็นจริงจากนิ้วคน '
            'แล้ว `_restoreCountField` เอา snapshot ที่เก็บไว้ **ก่อน**พนักงาน'
            'แตะเลข (ตอนนั้นช่องว่าง) มาทับ — ช่องกลับไปว่างเอง',
      );
      expect(container.read(appProvider).counts[skuA], '7');
      expect(
        (await tester.runAsync(db.allDrafts))!.map((r) => r.countedQty),
        [7],
        reason: 'ไม่ได้กู้แค่ตัวหนังสือบนจอ — `setScanCount` ถูกเรียกซ้ำ '
            'แถว count_drafts ถูกลบไปด้วย งานที่พนักงานคีย์หายจาก SQLite',
      );
    });

    testWidgets('⭐ P1-3 ล้างค่าเก่าทิ้ง → 0.8 วิต่อมาค่าเก่ากลับมาเอง',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);

      await tester.enterText(find.byType(TextField), '19');
      await settle(tester);

      // พนักงานแตะเลขต่อท้ายสองตัวติด ๆ (เผลอ/รีบ) — ตัวที่สองห่างแค่ 60ms
      await key(tester, '7', const Duration(seconds: 2));
      await tester.enterText(find.byType(TextField), '197');
      await settle(tester);
      await key(tester, '5', const Duration(milliseconds: 60)); // ถูกกลืน

      // เห็นว่าเลขเพี้ยน จึงล้างช่องทิ้งทั้งหมดเพื่อกรอกใหม่
      await tester.enterText(find.byType(TextField), '');
      await settle(tester);
      expect(container.read(appProvider).counts[skuA], '');
      expect(await tester.runAsync(db.allDrafts), isEmpty);

      // ยังไม่ทันได้กรอกอะไร เส้นตายสายรัวก็มาถึง
      await tester.pump(burstDies);
      await settle(tester);

      expect(
        countCtrl(tester).text,
        '',
        reason: 'ล้างช่องแล้วค่าเก่าเด้งกลับมาเอง = "Clear text เพื่อกรอกใหม่'
            'ไม่ได้" ตรงตัว — `_restoreCountField` เขียน snapshot ที่เก็บจาก'
            'คีย์ของคนกลับลงช่อง',
      );
      expect(container.read(appProvider).counts[skuA], '');
      expect(
        await tester.runAsync(db.allDrafts),
        isEmpty,
        reason: 'แถว draft ที่พนักงานลบไปแล้วถูกเขียนกลับเข้า SQLite',
      );
    });

    testWidgets('⭐ P1-4 สลับแท็บหลังแตะเลขเร็ว → ยอดที่เพิ่งคีย์ถูกถอยกลับ',
        (tester) async {
      final container = await pumpScreen(tester);
      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);

      await key(tester, '7', const Duration(seconds: 2));
      await tester.enterText(find.byType(TextField), '7');
      await settle(tester);
      await key(tester, '5', const Duration(milliseconds: 60)); // ถูกกลืน
      expect(container.read(appProvider).counts[skuA], '7');

      // แตะแท็บอื่น = app shell ถอด ScanScreen ทิ้งจริง (ไม่มี IndexedStack)
      await closeScreen(tester);
      await settle(tester);

      expect(
        container.read(appProvider).counts[skuA],
        '7',
        reason: '`_closeCountSnapshot` กู้เมื่อ `inBurst` — แต่ `_burst` เป็นจริง'
            'เพราะนิ้วคน ไม่ใช่เพราะเครื่องยิง การกู้จึงเป็นการลบงานของพนักงาน',
      );
    });

    testWidgets(
        'P1-5 เครื่องที่ปิด suffix Enter → คีย์ของคนภายใน 800ms หลังยิงถูกกลืน',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);

      // BBSettings BARCODE_MODE_SUFFIX (parameter 501) ปิดได้ที่ตัวเครื่อง
      await shoot(tester, barcodeB, enter: false);

      expect(
        await key(tester, '7', const Duration(milliseconds: 300)),
        isFalse,
        reason: '`_burst` เหนียว: ล้างได้ทางเดียวคือ Enter บนบัฟเฟอร์ที่ไม่ว่าง '
            '/ ช่องไฟเกิน idleReset 800ms / reset() — คีย์ของคนที่มาถึงก่อน'
            'ครบ 800ms จึงถูกตัดสินว่าเป็นของเครื่องยิงแล้วกลืนทิ้ง',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P2 — "Scan หลายตัวแล้วกรอกไม่ได้ตั้งแต่รายการที่สอง"
  // ══════════════════════════════════════════════════════════════════

  group('P2 · สแกนหลายใบแล้วต้องกรอกได้ทุกใบ', () {
    testWidgets(
        '⭐ P2-1 คีย์จำนวนเสร็จแล้วเหนี่ยวไกใบถัดไปทันที → ใบที่สองไม่ขึ้นการ์ดเลย',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));

      await shoot(tester, barcodeA);
      expect(container.read(appProvider).scans, hasLength(1));
      await openCount(tester, nameA);

      // พนักงานแตะ 1 แล้ว 9 (จังหวะคน) ลงช่องจำนวนของใบแรก
      for (final e in {'1': '1', '9': '19'}.entries) {
        await key(tester, e.key, human);
        await tester.enterText(find.byType(TextField), e.value);
        await tester.pump();
      }
      await settle(tester);
      expect(container.read(appProvider).counts[skuA], '19');

      // แล้วเล็งฉลากใบถัดไปแล้วเหนี่ยวไกเลย — 400ms หลังคีย์ตัวสุดท้าย
      await shoot(tester, barcodeB, lead: const Duration(milliseconds: 400));
      await settle(tester);

      expect(
        container.read(appProvider).scans.map((s) => s.sku).toList(),
        [skuB, skuA],
        reason: '`idleReset` 800ms วัดจากคีย์ล่าสุด **ของใครก็ได้** — เลขที่'
            'พนักงานเพิ่งคีย์ยังค้างใน `_chars` แล้วไปเกาะหน้าบาร์โค้ด '
            'รหัสที่ยิงเข้า `_resolve` จึงเป็น "19$barcodeB" → ไม่พบสินค้า '
            'ใบที่สองไม่มีการ์ด ไม่มีช่องกรอก และส่งได้แค่รายการเดียว',
      );
    });

    testWidgets(
        '⭐ P2-2 คีย์บอร์ดจอขึ้น → hero 190px ต้องพับให้ลิสต์ (ตัวแก้ปัจจุบันไม่ทำงาน)',
        (tester) async {
      await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      addTearDown(() => tester.view.resetViewInsets());

      final closed = rectOf(tester, find.byType(Scrollable));

      // manifest ตั้ง android:windowSoftInputMode="adjustResize" → คีย์บอร์ด
      // ขึ้นมาแล้วหน้าต่างหดจริง เหมือนที่ตั้งค่านี้จำลอง
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final open = rectOf(tester, find.byType(Scrollable));

      expect(
        closed.top - open.top,
        greaterThanOrEqualTo(TclTokens.cameraMinHeight),
        reason: '`keyboardOpen` อ่าน `MediaQuery.viewInsetsOf(context).bottom` '
            'แต่ `Scaffold` ที่ resizeToAvoidBottomInset (ค่าปริยาย) **หัก '
            'viewInsets.bottom ออกจาก MediaQuery ของ body ไปแล้ว** — ค่านี้จึง'
            'เป็น 0 เสมอในจอสแกน hero ไม่เคยพับ ลิสต์ผลสแกนเหลือที่ไม่ถึง'
            'หนึ่งการ์ด (${open.height}px จาก ${closed.height}px)',
      );
    });

    testWidgets('⭐ P2-3 ยิงใบใหม่ขณะช่องจำนวนโฟกัส → การ์ดใบใหม่โผล่นอกกรอบที่มองเห็น',
        (tester) async {
      final container = await pumpScreen(tester);
      addTearDown(() => closeScreen(tester));
      addTearDown(() => tester.view.resetViewInsets());

      container.read(appProvider.notifier).resolveCode(barcodeA);
      await tester.pump();
      await openCount(tester, nameA);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      // ยิงใบที่สอง — `addScan` แทรกการ์ดใหม่ที่ **หัวลิสต์**
      container.read(appProvider.notifier).resolveCode(barcodeB);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      final viewport = rectOf(tester, find.byType(Scrollable));
      expect(
        find.text(nameB),
        findsOneWidget,
        reason: 'P2-3: ยิงใบที่สองแล้วต้องมีการ์ดให้เห็น',
      );
      final card = rectOf(tester, find.text(nameB));
      expect(
        card.top,
        greaterThanOrEqualTo(viewport.top),
        reason: 'การ์ดใหม่ถูกแทรกเหนือตำแหน่งที่ลิสต์เลื่อนค้างอยู่ และไม่มีใคร'
            'สั่งเลื่อนกลับขึ้นหัวลิสต์ — พนักงานยิงแล้วไม่เห็นอะไรเปลี่ยน '
            'จึงกรอกได้แต่ใบที่ค้างอยู่บนจอใบเดียว (card=$card viewport=$viewport)',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ยอมรับงาน — ประโยคของเจ้าของ (5 ก.ย. 2569)
  // "ต้องสามารถสแกนแล้วมากรอกข้อมูลได้ทุกตัว และต้องส่งรายการได้มากกว่าหนึ่งรายการ"
  // ══════════════════════════════════════════════════════════════════

  testWidgets('⭐ ยิงสามใบ → กรอกจำนวนได้ครบทุกใบ → ได้สามบรรทัดใน count_drafts',
      (tester) async {
    final container = await pumpScreen(tester);
    addTearDown(() => closeScreen(tester));

    // ยิงสามใบติดกันแบบหน้างาน: ยิง → กรอกจำนวน → เล็งใบถัดไปแล้วยิงต่อทันที
    // (จังหวะ 400ms หลังคีย์ตัวสุดท้าย คือจังหวะที่ทำให้ใบที่สองหายไปทั้งใบ)
    const job = [
      (barcodeA, nameA, skuA, '19'),
      (barcodeB, nameB, skuB, '7'),
      ('8850001456712', 'ถุงมือหนังนิรภัย เบอร์ 9', 'SKU-11902', '250'),
    ];

    var first = true;
    for (final (barcode, name, sku, qty) in job) {
      await shoot(
        tester,
        barcode,
        lead: first ? const Duration(seconds: 2) : const Duration(milliseconds: 400),
      );
      first = false;
      await settle(tester);
      expect(
        find.text(name),
        findsOneWidget,
        reason: 'ยิง $barcode แล้วต้องมีการ์ดของ $sku ให้กรอก',
      );

      await openCount(tester, name);
      // ⚠️ ต้องคีย์ผ่าน **คีย์ดิบ** ไม่ใช่ `enterText` ล้วน ๆ — เลขที่พนักงานแตะ
      //    ต้องไหลผ่าน `_onHandheldKey` เข้าบัฟเฟอร์เดียวกับที่เครื่องยิงใช้ นั่น
      //    คือจุดที่บั๊กอยู่ (คีย์ผ่าน enterText อย่างเดียว บัฟเฟอร์ไม่เคยเห็นเลข
      //    ของคน เทสต์จะเขียวทั้งที่ยังพังหน้างาน)
      var typed = '';
      for (final digit in qty.split('')) {
        expect(
          await key(tester, digit, human),
          isFalse,
          reason: 'จอกลืนเลข "$digit" ที่พนักงานแตะบนใบ $sku',
        );
        typed += digit;
        // จำลองสิ่งที่เอนจินทำกับคีย์ที่ไม่ถูกกลืน (flutter_test ทำเองไม่ได้)
        await tester.enterText(find.byType(TextField), typed);
        await tester.pump();
      }
      await settle(tester);
      expect(
        container.read(appProvider).counts[sku],
        qty,
        reason: 'กรอกใบที่ ${job.indexWhere((j) => j.$3 == sku) + 1} ไม่ติด',
      );
    }

    expect(container.read(appProvider).scans, hasLength(3));
    final rows = (await tester.runAsync(db.allDrafts))!;
    expect(
      {for (final r in rows) r.sku: r.countedQty},
      {skuA: 19, skuB: 7, 'SKU-11902': 250},
      reason: 'ส่งได้มากกว่าหนึ่งรายการ = ต้องมีครบทุกแถวใน count_drafts '
          'ไม่ใช่แค่ใบที่ค้างอยู่บนจอใบเดียว',
    );
  });
}
