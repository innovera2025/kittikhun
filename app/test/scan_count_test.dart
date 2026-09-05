import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'package:tcl_stock/core/theme/tcl_tokens.dart';
import 'package:tcl_stock/core/widgets/common.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/features/scan/scan_screen.dart';
import 'package:tcl_stock/features/shell/sync_status_bar.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/local/sync_engine.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เทสต์เส้นทาง "นับจากการ์ดผลสแกน" (เอกสารแบบไม่มีรอบ)
///
/// สองเรื่องที่พลาดไม่ได้:
/// 1. ยอดที่พนักงานคีย์ต้องลงเครื่องทันทีทุก keystroke — ไม่มีปุ่มบันทึกคั่น
/// 2. ไม่มีทางที่การกดปุ่มบนจอ (ล้าง / นำออก) จะลบผลนับที่คีย์ไว้ทิ้ง
void main() {
  Item itemOf({num? onHand = 20, String sku = 'SKU-1'}) => Item(
    sku: sku,
    name: 'สินค้า $sku',
    unit: 'ชิ้น',
    onHand: onHand,
    onHandAsOf: DateTime(2026, 8, 27, 9, 30),
  );

  group('setScanCount — คีย์แล้วเขียนทะลุลง count_drafts ทันที', () {
    late LocalDb db;
    late ProviderContainer container;
    late AppController c;

    setUp(() {
      db = LocalDb(NativeDatabase.memory());
      container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
      c = container.read(appProvider.notifier);
    });
    tearDown(() async {
      container.dispose();
      await db.close();
    });

    test('คีย์ 19 บนยอดระบบ 20 → ผลต่าง -1 และมีแถวใน count_drafts', () async {
      await c.setScanCount(itemOf(), '19');

      expect(container.read(appProvider).counts['SKU-1'], '19');
      expect(
        Variance.from(entered: '19', systemQty: 20).signed,
        '-1',
        reason: 'ทิศบนจอคือ นับได้ − ยอดระบบ',
      );

      final row = (await db.allDrafts()).single;
      expect(row.countedQty, 19);
      expect(row.systemQtyShown, 20, reason: 'สแนปช็อตยอดที่จอโชว์ตอนคีย์');
      expect(container.read(appProvider).draftCount, 1);
    });

    test('คีย์ 21 → +1 · คีย์ 20 → 0', () {
      expect(Variance.from(entered: '21', systemQty: 20).signed, '+1');
      expect(Variance.from(entered: '20', systemQty: 20).signed, '0');
      expect(Variance.from(entered: '', systemQty: 20).signed, '—');
    });

    test('ล้างช่องกรอก → แถว draft ถูกถอนออก (ยังไม่ได้นับ ≠ นับได้ 0)', () async {
      await c.setScanCount(itemOf(), '19');
      expect((await db.allDrafts()).length, 1);

      await c.setScanCount(itemOf(), '');
      expect(await db.allDrafts(), isEmpty);
      expect(container.read(appProvider).draftCount, 0);
    });

    test('คีย์ 0 = นับแล้วได้ศูนย์ → ต้องเก็บเป็นแถวจริง', () async {
      await c.setScanCount(itemOf(), '0');
      expect((await db.allDrafts()).single.countedQty, 0);
    });

    test('onHand == null → ห้ามนับ ไม่เขียน draft และไม่รับค่าที่กรอก', () async {
      await c.setScanCount(itemOf(onHand: null), '5');

      expect(await db.allDrafts(), isEmpty);
      expect(container.read(appProvider).counts['SKU-1'] ?? '', '');
    });

    // ── ผู้ที่ลงมือนับ (actor) — หลักฐานของแถว count_drafts ────────────
    //
    // เส้นทางซ่อมยอดที่เครื่องยิงทำรั่ววิ่งใน post-frame callback **หลัง** จอถูก
    // ถอด และ sign-out รีเซ็ต state ไปก่อนหน้านั้นแล้ว ถ้าอ่าน `state.me` ตอนนั้น
    // จะได้ fallback (คนแรกในรายชื่อ = แอดมิน) ไปเข้าชื่อแทนคนที่นับจริง

    test('⭐ ระบุ actor → เขียนชื่อ/คลังของคนที่นับจริง ไม่ใช่ของ state ตอนนี้',
        () async {
      // ยังไม่มีใครล็อกอิน — `state.me` คือ fallback (52104 แอดมิน) และ
      // `warehouseCode` เป็น null คือสภาพเป๊ะ ๆ ที่การซ่อมหลัง sign-out เจอ
      expect(container.read(appProvider).me.empId, '52104');

      await c.setScanCount(
        itemOf(),
        '19',
        actor: (empId: '52318', warehouseCode: 'WHFG'),
      );

      final row = (await db.allDrafts()).single;
      expect(row.countedQty, 19);
      expect(row.enteredBy, '52318');
      expect(row.warehouseCode, 'WHFG');
    });

    test('actor ที่ไม่มีคลัง → ตกไปใช้คลังของสินค้าเหมือนเส้นทางปกติ', () async {
      await c.setScanCount(
        Item(
          sku: 'SKU-1',
          name: 'สินค้า SKU-1',
          unit: 'ชิ้น',
          warehouse: 'WH-ITEM',
          onHand: 20,
        ),
        '19',
        actor: (empId: '52318', warehouseCode: null),
      );
      expect((await db.allDrafts()).single.warehouseCode, 'WH-ITEM');
    });

    test('ไม่ระบุ actor → เขียนตามคนที่ล็อกอินอยู่ตอนนี้ (เส้นทางปกติ)', () async {
      c.setEmpId('52318');
      for (final k in ['0', '0', '0', '0', '0', '0']) {
        c.pressKey(k);
      }
      await c.signIn();

      expect(c.countActor.empId, '52318');
      await c.setScanCount(itemOf(), '19');
      expect((await db.allDrafts()).single.enteredBy, '52318');
    });

    test('viewer → setScanCount ไม่เขียน draft', () async {
      c.setEmpId('52402'); // Nattaporn K. = viewer
      for (final k in ['0', '0', '0', '0', '0', '0']) {
        c.pressKey(k);
      }
      await c.signIn();
      expect(container.read(appProvider).me.role, Role.viewer);

      await c.setScanCount(itemOf(), '19');
      expect(await db.allDrafts(), isEmpty);
    });

    test('ลดค่าบนช่องว่าง → ไม่เกิดแถว draft ที่ไม่มีใครนับ', () async {
      await c.decScanCount(itemOf());
      expect(await db.allDrafts(), isEmpty);
    });

    test('เพิ่ม/ลดบนทศนิยม → บวกลบจริง ไม่รีเซ็ต', () async {
      await c.setScanCount(itemOf(), '20.5');
      await c.incScanCount(itemOf());
      expect(container.read(appProvider).counts['SKU-1'], '21.5');
      await c.decScanCount(itemOf());
      expect((await db.allDrafts()).single.countedQty, 20.5);
    });

    test('setCount เดิม (เส้นรอบนับ) ห้ามแตะ count_drafts', () async {
      c.setCount('SKU-1', '19');
      expect(await db.allDrafts(), isEmpty);
      expect(container.read(appProvider).draftCount, 0);
    });

    test('นำออก/ล้าง แตะได้แค่รายการสแกน — ผลนับที่คีย์ไว้ต้องอยู่ครบ', () async {
      await c.setScanCount(itemOf(), '19');
      c.addScan('SKU-1');

      c.removeScan('SKU-1');
      expect(container.read(appProvider).scans, isEmpty);
      expect((await db.allDrafts()).length, 1);
      expect(
        container.read(appProvider).toast,
        'ยอดที่คีย์ไว้ยังอยู่ในรายการรอส่ง',
      );

      c.addScan('SKU-1');
      c.clearScans();
      expect((await db.allDrafts()).length, 1);
      expect(container.read(appProvider).draftCount, 1);
    });
  });

  test('ปิดแอปแล้วเปิดใหม่ — ยอดที่คีย์ยังอยู่และกลับเข้าช่องกรอก', () async {
    final dir = Directory.systemTemp.createTempSync('tcl_draft_test');
    addTearDown(() => dir.deleteSync(recursive: true));
    final file = File('${dir.path}/tcl.sqlite');

    final before = LocalDb(NativeDatabase(file));
    final c1 = ProviderContainer(
      overrides: [localDbProvider.overrideWithValue(before)],
    );
    await c1.read(appProvider.notifier).setScanCount(
      const Item(sku: 'SKU-1', name: 'สินค้า', unit: 'ชิ้น', onHand: 20),
      '19',
    );
    c1.dispose();
    await before.close();

    // เครื่องเดิม เปิดแอปใหม่ (state ในหน่วยความจำหายหมด)
    final after = LocalDb(NativeDatabase(file));
    addTearDown(after.close);
    final c2 = ProviderContainer(
      overrides: [localDbProvider.overrideWithValue(after)],
    );
    addTearDown(c2.dispose);

    await c2.read(appProvider.notifier).loadDrafts();
    expect(c2.read(appProvider).draftCount, 1);
    expect(
      c2.read(appProvider).counts['SKU-1'],
      '19',
      reason: 'ช่องกรอกต้องโชว์ค่าเดิม ไม่ใช่ 19.0',
    );
  });

  group('การ์ดผลสแกน — ช่องกรอกโผล่เฉพาะเมื่อนับได้จริง', () {
    late LocalDb db;

    setUp(() => db = LocalDb(NativeDatabase.memory()));
    tearDown(() => db.close());

    Future<ProviderContainer> pumpCard(
      WidgetTester tester, {
      required Item item,
      String? signInAs,
    }) async {
      // หมายเหตุ: ไม่ย่อจอเป็น 360px ในเทสต์ — flutter_test ไม่โหลดฟอนต์จริง
      // ตัวอักษรไทยจึงกว้าง 1em ต่อตัว ปุ่มยาว ๆ ล้นทั้งที่ของจริงไม่ล้น
      // (แถว stepper กว้าง 196px จากพื้นที่การ์ด 292px ที่จอ 360 — คำนวณตรง ๆ ได้)
      final container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
      addTearDown(container.dispose);
      final c = container.read(appProvider.notifier);
      if (signInAs != null) {
        c.setEmpId(signInAs);
        for (final k in ['0', '0', '0', '0', '0', '0']) {
          c.pressKey(k);
        }
        await c.signIn();
      }
      c.rememberScannedItem(item);
      c.addScan(item.sku);
      c.toggleExpanded(item.sku);

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

    testWidgets('มียอดระบบ + สิทธิ์เขียน → มีแถว stepper และหน่วยนับ',
        (tester) async {
      await pumpCard(tester, item: itemOf());

      expect(find.byType(CountField), findsOneWidget);
      expect(find.byType(StepperButton), findsNWidgets(2));
      expect(find.text('ยอดคงเหลือ'), findsOneWidget);
      expect(find.text('ผลต่าง'), findsOneWidget);
      // สามช่องเดิมที่ ERP ไม่เคยมีข้อมูลต้องหายไปแล้ว
      expect(find.text('จอง'), findsNothing);
      expect(find.text('พร้อมขาย'), findsNothing);
      expect(find.text('จุดสั่งซื้อ'), findsNothing);
    });

    testWidgets('คีย์ลงช่อง → ผลต่างบนการ์ดขยับตาม', (tester) async {
      await pumpCard(tester, item: itemOf());

      await tester.enterText(find.byType(TextField), '19');
      await tester.pump();
      expect(find.text('-1'), findsOneWidget);
    });

    testWidgets('onHand == null → ไม่มีช่องกรอก แสดงข้อความห้ามนับ',
        (tester) async {
      await pumpCard(tester, item: itemOf(onHand: null));

      expect(find.byType(CountField), findsNothing);
      expect(find.text('ไม่มียอดระบบ · นับรายการนี้ไม่ได้'), findsOneWidget);
    });

    testWidgets('viewer → ไม่มีช่องกรอกในการ์ด', (tester) async {
      await pumpCard(tester, item: itemOf(), signInAs: '52402');

      expect(find.byType(CountField), findsNothing);
      expect(find.text('ดูอย่างเดียว · viewer'), findsOneWidget);
    });

    testWidgets('โหมด handheld: onDetect ของกล้องต้องไม่ resolve แม้ callback ถูกยิงตรง',
        (tester) async {
      final container = await pumpCard(tester, item: itemOf()); // camOn=false ตามค่าเริ่มต้น
      final before = container.read(appProvider).scans.length;

      final onDetect =
          tester.widget<MobileScanner>(find.byType(MobileScanner)).onDetect!;
      // บาร์โค้ดที่มีในคลังจริง (SKU-77340) — ถ้า guard หลุด จะได้การ์ดใหม่เพิ่มมาทันที
      onDetect(
        const BarcodeCapture(barcodes: [Barcode(rawValue: '8859900112233')]),
      );
      await tester.pump();

      expect(
        container.read(appProvider).scans.length,
        before,
        reason: 'จำลอง _busy race: กล้อง native ยังส่งผลตรวจจับมาได้แม้ camOn=false '
            '— guard ใน _onDetect ต้องกันไว้',
      );
    });

    // ════════════════════════════════════════════════════════════════
    // เครื่องยิงยิงใส่จอขณะช่องจำนวนโฟกัสอยู่ (R6)
    //
    // ⚠️ ห้ามพิสูจน์เรื่องนี้ด้วย `tester.enterText()` — มันเขียนตรงเข้า
    //    text-input client ไม่เคยผ่าน `Focus.onKeyEvent` / `KeyboardManager`
    //    จึงให้ผลเหมือนกันทั้งก่อนและหลังแก้ (เทสต์แบบนั้นเคยหลุดขึ้น main มาแล้ว)
    //    ทางเดียวที่แตะกลไกจริงคือ **คีย์ดิบ** ผ่าน `sendKeyDownEvent()` แล้วอ่าน
    //    ค่าที่คืนมา = `isEventHandled` ของ FocusManager (true = ถูกกลืน)
    //
    // ⚠️ flutter_test ไม่มี InputConnectionAdaptor ให้จำลอง (`TestTextInput.
    //    _keyHandler` เป็น null เสมอ) คีย์ที่ **ไม่ถูกกลืน** จึงไม่ได้พิมพ์ลงช่อง
    //    จริงเหมือนบนเครื่อง — ตรงไหนที่ต้องมีตัวหนังสือรั่วลงไปจริง ๆ เทสต์จะ
    //    จำลองการรั่วด้วย `enterText()` และเขียนกำกับไว้ทุกจุด
    // ════════════════════════════════════════════════════════════════

    group('คีย์ดิบเข้าจอ — กลืนตามความเร็ว แล้วกู้ช่องจำนวนคืน', () {
      /// `_onHandheldKey` วัดจังหวะจาก `handheldNow()` ไม่ใช่นาฬิกาปลอมของ
      /// framework (`tester.pump()` ไม่ขยับ `DateTime.now()`) เทสต์จึงต้องถือ
      /// นาฬิกาเอง ไม่งั้นช่องไฟระหว่างคีย์กลายเป็นสัญญาณรบกวนของ runner
      late DateTime clock;
      setUp(() {
        clock = DateTime(2026, 9, 3, 10);
        handheldNow = () => clock;
      });
      tearDown(() => handheldNow = DateTime.now);

      /// กดหนึ่งคีย์หลังเลื่อนนาฬิกาไป [after] — คืน `true` เมื่อจอกลืนคีย์นั้น
      Future<bool> tap(WidgetTester tester, String ch, Duration after) async {
        clock = clock.add(after);
        final handled = await tester.sendKeyDownEvent(
          LogicalKeyboardKey.digit0, // logicalKey ไม่สำคัญเท่า character
          character: ch,
        );
        await tester.sendKeyUpEvent(LogicalKeyboardKey.digit0);
        return handled;
      }

      Future<bool> enter(WidgetTester tester, Duration after) async {
        clock = clock.add(after);
        final handled = await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
        return handled;
      }

      /// แตะนอกช่องกรอก = โฟกัสกลับไปที่โหนดของจอ
      ///
      /// ⚠️ ห้ามใช้ `primaryFocus?.unfocus()` แทน — โฟกัสจะไปตกที่ FocusScope
      /// ซึ่งอยู่ **เหนือ** โหนดของจอ คีย์จึงไม่วิ่งผ่าน `_onHandheldKey` อีกเลย
      /// เทสต์จะกลายเป็นสีเขียวเพราะไม่มีอะไรทำงาน ไม่ใช่เพราะโค้ดถูก
      Future<void> blurCountField(WidgetTester tester) async {
        tester
            .widgetList<Focus>(find.byType(Focus))
            .map((w) => w.focusNode)
            .whereType<FocusNode>()
            .firstWhere((n) => n.debugLabel == 'handheld-scan')
            .requestFocus();
        await tester.pump();
      }

      const human = Duration(milliseconds: 150); // นิ้วแตะคีย์บอร์ดจอ
      const gun = Duration(milliseconds: 10); // เครื่องยิง HID

      testWidgets('⭐ ลำดับคีย์ชุดเดียวกัน: นิ้วคนต้องไหลถึงช่อง · เครื่องยิงต้องถูกกลืน',
          (tester) async {
        await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();

        // (ก) จังหวะคน — ทุกตัวต้องคืน ignored ให้ engine เอาไปพิมพ์ลงช่อง
        for (final ch in ['1', '9']) {
          expect(
            await tap(tester, ch, human),
            isFalse,
            reason: 'true = จอกลืนเลข "$ch" ทิ้ง → บนเครื่องจริง '
                'KeyboardManager.onUnhandled() ไม่ถูกเรียก เลขที่พนักงานแตะ '
                'บนคีย์บอร์ดตัวเลขของ Android หายเงียบ ๆ จากยอดนับ',
          );
        }

        // (ข) จังหวะเครื่องยิง — ลำดับเดิม ต่างกันแค่ช่องไฟ ต้องได้ผลตรงข้าม
        //     ตัวแรกพิสูจน์สายรัวไม่ได้จึงยังรั่ว (นั่นคือเหตุผลของ snapshot)
        expect(await tap(tester, '1', const Duration(seconds: 2)), isFalse);
        expect(
          await tap(tester, '9', gun),
          isTrue,
          reason: 'false = ไม่กลืนอะไรเลย → อักขระที่เหลือของบาร์โค้ดรั่วลง '
              'ช่องจำนวนทั้งสาย ซึ่งเป็นบั๊กเดิมที่กลับด้าน',
        );
      });

      testWidgets('⭐ ยิงบาร์โค้ดขณะช่องจำนวนโฟกัส → จอ/state/SQLite กลับเป็นค่าเดิม',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(container.read(appProvider).counts['SKU-1'], '19');

        const barcode = '8851234567890'; // SKU-40128 ในคลังตัวอย่าง
        expect(await tap(tester, barcode[0], gun), isFalse);
        // จำลองสิ่งที่ engine ทำกับคีย์ที่ไม่ถูกกลืน (flutter_test ทำเองไม่ได้)
        await tester.enterText(find.byType(TextField), '198');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(
          container.read(appProvider).counts['SKU-1'],
          '198',
          reason: 'ยอดเพี้ยนจริงแล้วตรงนี้ — ถ้าไม่เพี้ยน เทสต์ที่เหลือก็ไม่ได้วัดอะไร',
        );

        for (final ch in barcode.substring(1).split('')) {
          expect(await tap(tester, ch, gun), isTrue);
        }
        expect(await enter(tester, gun), isTrue);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'ตัวหนังสือบนจอต้องกลับไปเป็นค่าก่อนรั่ว',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(
          rows!.single.countedQty,
          19,
          reason: 'กู้แค่ controller ไม่พอ — อักขระที่รั่วไหลผ่าน onChanged ลง '
              'count_drafts ไปแล้ว ถ้าไม่กู้ ยอด 198 จะถูกส่งขึ้น ERP',
        );
        expect(
          container.read(appProvider).scans.map((s) => s.sku),
          contains('SKU-40128'),
          reason: 'กู้ช่องแล้วต้องยังเดินเส้นทางสแกนปกติต่อ',
        );
      });

      // ══════════════════════════════════════════════════════════════
      // ยิงแบบ **ไม่มี Enter ปิดท้าย** — Enter เป็น suffix ที่ตั้งค่าได้ของ S20
      // (BBSettings BARCODE_MODE_SUFFIX / parameter 501) ไม่ใช่ของติดตัวเครื่อง
      // เครื่องที่ปิด suffix ไว้จะไม่มีคีย์ไหนมาบอกว่ารหัสจบ เส้นทางกู้ที่แขวนกับ
      // Enter จึงไม่ทำงานเลย ทั้งชุดนี้วัดเส้นทางกู้ตัวที่สอง: สายรัวเงียบไปเฉย ๆ
      //
      // ⚠️ เส้นตายนี้เป็น `Timer` จริง ซึ่งวิ่งบน FakeAsync ของ flutter_test อยู่แล้ว
      //    `tester.pump(d)` เดินให้ถึงได้ตรง ๆ — ไม่ต้อง sleep เวลาจริง และไม่ต้องมี
      //    ตะเข็บนาฬิกาตัวที่สอง (`handheldNow` คุมแค่ "ช่องไฟระหว่างคีย์" ที่บัฟเฟอร์
      //    ใช้ตัดสินสายรัว คนละนาฬิกากับเส้นตายของการกู้)
      // ══════════════════════════════════════════════════════════════

      /// เกิน `idleReset` (800ms) = สายรัวตายแน่ · ตัวเลขเดียวที่เทสต์ชุดนี้ใช้
      const afterBurstDies = Duration(milliseconds: 900);

      testWidgets('⭐ ยิงจนจบแต่ไม่มี Enter ปิดท้าย → พอเงียบพอ ต้องกู้จอ/state/SQLite เอง',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        const barcode = '8851234567890';
        expect(await tap(tester, barcode[0], gun), isFalse);
        // จำลองสิ่งที่ engine ทำกับคีย์ที่ไม่ถูกกลืน (flutter_test ทำเองไม่ได้)
        await tester.enterText(find.byType(TextField), '198');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(
          container.read(appProvider).counts['SKU-1'],
          '198',
          reason: 'ยอดเพี้ยนจริงแล้วตรงนี้ — ถ้าไม่เพี้ยน เทสต์ที่เหลือก็ไม่ได้วัดอะไร',
        );

        for (final ch in barcode.substring(1).split('')) {
          expect(await tap(tester, ch, gun), isTrue);
        }
        // ⚠️ ไม่มี Enter เด็ดขาด — นั่นคือทั้งหมดที่เทสต์นี้ต่างจากตัวข้างบน
        await tester.pump(afterBurstDies);
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'ผูกการกู้ไว้กับ Enter อย่างเดียว = เครื่องที่ปิด suffix จะเหลือ '
              '"198" ค้างบนจอถาวร บั๊กยอดเพี้ยนเดิมกลับมาทั้งดุ้น',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(
          rows!.single.countedQty,
          19,
          reason: 'กู้แค่ตัวหนังสือบนจอไม่พอ — ยอด 198 ที่รั่วลง count_drafts '
              'ไปแล้วจะรอดอยู่ใน SQLite แล้วถูกส่งขึ้น ERP',
        );
      });

      testWidgets('⭐ คนแตะเลขแล้วหยุดพิมพ์ → เส้นตายห้ามถอยยอดที่เพิ่งคีย์กลับ',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();

        // นิ้วคนแตะทีละตัว: ทุกตัวสั่ง snapshot (ยังพิสูจน์สายรัวไม่ได้สักตัว)
        // แล้วไหลลงช่องตามปกติ — จำลองสิ่งที่ engine ทำให้ทีละก้าว
        for (final entry in {'1': '1', '9': '19'}.entries) {
          expect(await tap(tester, entry.key, human), isFalse);
          await tester.enterText(find.byType(TextField), entry.value);
          await tester.pump();
        }
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(container.read(appProvider).counts['SKU-1'], '19');

        // แล้วคนก็หยุดพิมพ์ไปเฉย ๆ (คิดเลข ยกของ วางเครื่อง) นานกว่าเส้นตาย
        await tester.pump(afterBurstDies);
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'ตั้งเส้นตายทุกครั้งที่ snapshot (ไม่เช็คว่าพิสูจน์สายรัวแล้ว) '
              'คีย์ของคนก็โดนด้วย → หยุดพิมพ์ 800ms แล้วยอดถอยกลับเป็น "1" เงียบ ๆ',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(rows!.single.countedQty, 19);
      });

      testWidgets('การ์ดถูกยุบแล้วสายรัวตายทีหลัง → ไม่เขียน controller ที่ตายแล้ว แต่ยังกู้ state',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();

        const barcode = '8851234567890';
        await tap(tester, barcode[0], gun);
        await tester.enterText(find.byType(TextField), '198'); // จำลองการรั่ว
        await tester.pump();
        for (final ch in barcode.substring(1, 5).split('')) {
          await tap(tester, ch, gun);
        }

        container.read(appProvider.notifier).toggleExpanded('SKU-1');
        await tester.pump();
        expect(find.byType(TextField), findsNothing);

        await tester.pump(afterBurstDies); // เส้นตายมาถึงตอนช่องตายไปแล้ว
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.takeException(),
          isNull,
          reason: 'เขียน .value ลง TextEditingController ที่ dispose แล้ว = assert',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
      });

      testWidgets('ออกจากจอทั้งที่สายรัวยังค้าง → เส้นตายต้องถูกยกเลิกไปกับจอ',
          (tester) async {
        await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();

        for (final ch in '8851'.split('')) {
          await tap(tester, ch, gun);
        }

        // ทิ้งจอทั้งใบระหว่างที่เส้นตายยังไม่ถึง (ผู้ใช้สลับแท็บ/ปิดหน้า)
        await tester.pumpWidget(const MaterialApp(home: Scaffold()));
        await tester.pump(afterBurstDies);

        // ไม่ยกเลิกใน dispose() → Timer ยิงใส่ ref/controller ที่ตายแล้ว และ
        // flutter_test จะฟ้อง "A Timer is still pending" ตอนรื้อ tree ทุกเทสต์
        // ที่จบขณะสายรัวยังค้างอยู่ด้วย
        expect(tester.takeException(), isNull);
      });

      // ══════════════════════════════════════════════════════════════
      // ทางออกที่ **ไม่มีใครมาปิดท้ายให้** — โหมดถูกสลับ หรือจอถูกถอดทิ้ง
      // ทั้งที่สายรัวยังไหลอยู่
      //
      // ทั้งสองทางเคยแค่ "ทิ้ง snapshot" ซึ่งไม่ใช่การยกเลิกการกู้ แต่คือการ
      // **ยืนยันยอดที่เพี้ยน**: อักขระที่รั่วไปแล้วอยู่ทั้งบนจอ ใน AppState และ
      // ในแถว count_drafts ตั้งแต่วินาทีที่มันรั่ว ไม่มีใครถอนให้อีกเลย
      // ══════════════════════════════════════════════════════════════

      /// พาไปยืนที่จุดเดียวกันทุกครั้ง: ช่องมี '19' อยู่ แล้วเครื่องยิงเริ่มยิง
      /// อักขระตัวแรกรั่วลงไปเป็น '198' (ทั้งจอ/state/SQLite) และสายรัว
      /// **พิสูจน์ตัวเองแล้ว** ด้วยอักขระที่ตามมาติด ๆ — คือสภาพที่ทางออกทั้งสอง
      /// ทางต้องกู้ให้ ไม่ใช่ทิ้ง
      Future<void> leakMidBurst(
        WidgetTester tester,
        ProviderContainer container,
      ) async {
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(await tap(tester, '8', gun), isFalse);
        // จำลองสิ่งที่ engine ทำกับคีย์ที่ไม่ถูกกลืน (flutter_test ทำเองไม่ได้)
        await tester.enterText(find.byType(TextField), '198');
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(
          container.read(appProvider).counts['SKU-1'],
          '198',
          reason: 'ยอดเพี้ยนจริงแล้วตรงนี้ — ถ้าไม่เพี้ยน เทสต์ที่เหลือก็ไม่ได้วัดอะไร',
        );

        // อักขระที่ตามมาติด ๆ = สายรัวพิสูจน์แล้ว (เงื่อนไขเดียวกับที่อนุญาตให้กู้)
        for (final ch in '851'.split('')) {
          expect(await tap(tester, ch, gun), isTrue);
        }
      }

      testWidgets('⭐ สลับโหมดกลางสายรัว → ต้องกู้จอ/state/SQLite ไม่ใช่ทิ้ง snapshot',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await leakMidBurst(tester, container);

        // ปุ่มฮาร์ดแวร์ข้างเครื่องถูกกดกลางสายรัว (นิ้วเกี่ยว/กดผิด) — ปลายทาง
        // เดียวกับการแตะแถบสลับโหมด
        container.read(appProvider.notifier).setScanMode(ScanMode.camera);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'ก่อนแก้: ตัวรับ scanMode ทิ้ง snapshot ทิ้งเฉย ๆ ทุกครั้งที่โหมด'
              'เปลี่ยน — สลับโหมดกลางสายรัวจึงกลายเป็นการ "ยืนยัน" อักขระที่รั่ว',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(
          rows!.single.countedQty,
          19,
          reason: 'กู้แค่ตัวหนังสือบนจอไม่พอ — 198 ที่รั่วลง count_drafts แล้วจะ'
              'รอดอยู่ใน SQLite แล้วถูกส่งขึ้น ERP เป็นยอดที่นับได้',
        );
      });

      testWidgets('⭐ สลับแท็บกลางสายรัว → จอหายไปแล้ว แต่ state/SQLite ต้องถูกกู้',
          (tester) async {
        // ไม่ใช้ `pumpCard` เพราะเทสต์นี้ต้องมีวิดเจ็ตที่ watch AppState ค้างอยู่
        // **นอก** ScanScreen ตลอดทั้งเรื่อง เหมือนหัวจอ/แถบเตือนของ app shell
        // จริง — การกู้ที่ยิงผิดจังหวะจะเด้ง 'setState() called during build'
        // ใส่ตัวนั้น และเทสต์ที่ไม่มีใคร watch อยู่นอกจอจะมองไม่เห็นเลย
        final container = ProviderContainer(
          overrides: [localDbProvider.overrideWithValue(db)],
        );
        addTearDown(container.dispose);
        final c = container.read(appProvider.notifier);
        c.rememberScannedItem(itemOf());
        c.addScan('SKU-1');
        c.toggleExpanded('SKU-1');

        Widget shell({required bool showScan}) => UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(
              body: Consumer(
                builder: (_, ref, _) {
                  ref.watch(appProvider);
                  return showScan
                      ? const ScanScreen()
                      : const SizedBox.shrink();
                },
              ),
            ),
          ),
        );

        await tester.pumpWidget(shell(showScan: true));
        await tester.pump(const Duration(milliseconds: 400));
        await leakMidBurst(tester, container);

        // app shell ถอด ScanScreen ทิ้งจริงเมื่อสลับแท็บ (ไม่มี IndexedStack)
        // — เส้นทางเดียวกับ sign-out และการปิดจอ · ช่องกรอกหายไปกับจอ เหลือ
        // AppState กับแถว count_drafts ที่ต้องซ่อมให้ทัน
        await tester.pumpWidget(shell(showScan: false));
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(find.byType(TextField), findsNothing);
        expect(tester.takeException(), isNull);
        expect(
          container.read(appProvider).counts['SKU-1'],
          '19',
          reason: 'ก่อนแก้: จอตายพร้อม snapshot โดยไม่กู้อะไรเลย — 198 กลายเป็น'
              'ยอดที่นับได้ถาวร ทั้งที่พนักงานไม่เคยคีย์เลขนั้น',
        );
        final rows = await tester.runAsync(db.allDrafts);
        expect(rows!.single.countedQty, 19);
      });

      testWidgets('คนแตะเลขแล้วสลับโหมด → ห้ามถอยยอดที่เพิ่งคีย์กลับ',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();

        // นิ้วคนแตะทีละตัว: ทุกตัวสั่ง snapshot เหมือนกัน (ยังพิสูจน์สายรัวไม่ได้
        // สักตัว) แล้วไหลลงช่องตามปกติ
        for (final entry in {'1': '1', '9': '19'}.entries) {
          expect(await tap(tester, entry.key, human), isFalse);
          await tester.enterText(find.byType(TextField), entry.value);
          await tester.pump();
        }
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(container.read(appProvider).counts['SKU-1'], '19');

        container.read(appProvider.notifier).setScanMode(ScanMode.camera);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'กู้ทุก snapshot ที่ค้างโดยไม่ดูว่าพิสูจน์สายรัวแล้วหรือยัง = '
              'สลับโหมดหลังพนักงานคีย์เสร็จ แล้วยอดถอยกลับเป็น "1" เงียบ ๆ · '
              'พังหนักกว่าบั๊กที่กำลังแก้อยู่',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(rows!.single.countedQty, 19);
      });

      testWidgets('⭐ ออกจากระบบกลางสายรัว → ยอดต้องถูกซ่อมในชื่อคนที่นับจริง',
          (tester) async {
        // ไม่ใช้ `pumpCard` เพราะต้องคุมทั้งการ sign-in และจังหวะที่จอถูกถอด
        final container = ProviderContainer(
          overrides: [localDbProvider.overrideWithValue(db)],
        );
        addTearDown(container.dispose);
        final c = container.read(appProvider.notifier);
        c.setEmpId('52318'); // ธนากร (staff) — **ไม่ใช่**คนแรกในรายชื่อ
        for (final k in ['0', '0', '0', '0', '0', '0']) {
          c.pressKey(k);
        }
        await c.signIn();
        expect(container.read(appProvider).me.empId, '52318');
        c.rememberScannedItem(itemOf());
        c.addScan('SKU-1');
        c.toggleExpanded('SKU-1');

        // จอสแกนหายไปพร้อมการ sign-out — เหมือน app shell จริง
        Widget shell() => UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(
              body: Consumer(
                builder: (_, ref, _) =>
                    ref.watch(appProvider.select((s) => s.signedIn))
                    ? const ScanScreen()
                    : const SizedBox.shrink(),
              ),
            ),
          ),
        );

        await tester.pumpWidget(shell());
        await tester.pump(const Duration(milliseconds: 400));
        await leakMidBurst(tester, container);

        // กดออกจากระบบกลางสายรัว: AppState ถูกรีเซ็ต **ก่อน** จอถูกถอด และการ
        // ซ่อมยอดวิ่งใน post-frame callback หลังจากนั้นอีกที
        await c.signOut();
        await tester.pump();
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(find.byType(TextField), findsNothing);
        final row = (await tester.runAsync(db.allDrafts))!.single;
        expect(row.countedQty, 19, reason: 'ยอดต้องถูกซ่อมเหมือนทางออกอื่น');
        expect(
          row.enteredBy,
          '52318',
          reason: 'ก่อนแก้: การซ่อมอ่าน `state.me` ตอนที่ไม่มีใครล็อกอินแล้ว → '
              'ตกไปที่คนแรกในรายชื่อ (52104 แอดมิน) ยอดถูกซ่อมถูกแต่ไปเข้าชื่อ'
              'คนที่ไม่เคยนับ ซึ่งเป็นหลักฐานตรวจสอบของเอกสารตรวจนับ',
        );
      });

      testWidgets('⭐ คนพิมพ์เลขแล้วกด Enter จริง → ห้ามถอยยอดที่เพิ่งคีย์กลับ',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();

        // นิ้วคนแตะทีละตัว — ทุกตัวสั่ง snapshot (ยังพิสูจน์สายรัวไม่ได้สักตัว)
        for (final entry in {'1': '1', '9': '19'}.entries) {
          expect(await tap(tester, entry.key, human), isFalse);
          await tester.enterText(find.byType(TextField), entry.value);
          await tester.pump();
        }
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        expect(container.read(appProvider).counts['SKU-1'], '19');

        // แล้วกด Enter บนคีย์บอร์ด — บัฟเฟอร์สะสม '19' ไว้พอดี จึง "จบรหัส"
        // ให้ทั้งที่ไม่มีเครื่องยิงเกี่ยวข้องเลยสักนิด
        await enter(tester, human);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '19',
          reason: 'ก่อนแก้: เส้นทาง "รหัสจบ" กู้ทุกครั้งโดยไม่ดูว่ามาจากสายรัว'
              'ที่พิสูจน์แล้วหรือไม่ (ต่างจากอีกสามทางออกที่ด่านครบ) — พนักงาน'
              'คีย์ 19 แล้วกด Enter ยอดถอยกลับเป็น "1" เงียบ ๆ',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
        final rows = await tester.runAsync(db.allDrafts);
        expect(rows!.single.countedQty, 19);
        await tester.pump(const Duration(milliseconds: 2500)); // toast หมดอายุ
      });

      testWidgets('ช่องหลุดโฟกัสก่อนยิง → ห้ามกู้ค่าเก่าทับสิ่งที่คนพิมพ์ทีหลัง',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();

        // คีย์จังหวะคนหนึ่งตัว = สั่ง snapshot ('19') โดยยังไม่มีรหัสไหนจบ
        await tap(tester, '7', human);
        // แล้วคนพิมพ์ต่อจนเสร็จ ค่าจริงกลายเป็น 25
        await tester.enterText(find.byType(TextField), '25');
        await tester.pump();
        await blurCountField(tester);

        const barcode = '8851234567890';
        // เว้นเกิน idleReset ให้เศษ '7' ตายก่อน แล้วยิงเต็มชุดตอนไม่มีช่องโฟกัส
        expect(await tap(tester, barcode[0], const Duration(seconds: 2)), isFalse);
        for (final ch in barcode.substring(1).split('')) {
          await tap(tester, ch, gun);
        }
        await enter(tester, gun);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          container.read(appProvider).counts['SKU-1'],
          '25',
          reason: 'ไม่มีช่องไหนโฟกัส = ไม่มีอะไรจะรั่วใส่ → ต้องทิ้ง snapshot เก่า '
              'ไม่ใช่เก็บไว้แล้วเอามากู้ทับยอดที่คนพิมพ์ทีหลัง',
        );
        expect(
          container.read(appProvider).scans.map((s) => s.sku),
          contains('SKU-40128'),
          reason: 'ยิงตอนไม่มีช่องโฟกัสต้อง resolve ตามปกติ',
        );
      });

      testWidgets('การ์ดถูกยุบกลางสายรัว → ไม่เขียนลง controller ที่ตายแล้ว แต่ยังกู้ state',
          (tester) async {
        final container = await pumpCard(tester, item: itemOf());
        await tester.tap(find.byType(TextField));
        await tester.pump();
        await tester.enterText(find.byType(TextField), '19');
        await tester.pump();

        const barcode = '8851234567890';
        await tap(tester, barcode[0], gun);
        await tester.enterText(find.byType(TextField), '198'); // จำลองการรั่ว
        await tester.pump();

        container.read(appProvider.notifier).toggleExpanded('SKU-1');
        await tester.pump();
        expect(find.byType(TextField), findsNothing);

        for (final ch in barcode.substring(1).split('')) {
          await tap(tester, ch, gun);
        }
        await enter(tester, gun);
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));

        expect(
          tester.takeException(),
          isNull,
          reason: 'เขียน .value ลง TextEditingController ที่ dispose แล้ว = assert',
        );
        expect(container.read(appProvider).counts['SKU-1'], '19');
      });
    });
  });

  group('SyncStatusBar — แถบเตือนยอดที่คีย์ค้าง', () {
    late LocalDb db;

    setUp(() => db = LocalDb(NativeDatabase.memory()));
    tearDown(() => db.close());

    /// สีของจุดสถานะแต่ละเรื่อง เรียงซ้าย → ขวา
    List<Color?> dotColors(WidgetTester tester) => tester
        .widgetList<Container>(find.byType(Container))
        .map((w) => w.decoration)
        .whereType<BoxDecoration>()
        .where((d) => d.shape == BoxShape.circle)
        .map((d) => d.color)
        .toList();

    Future<ProviderContainer> pumpBar(
      WidgetTester tester, {
      int queued = 0,
      int drafts = 0,
    }) async {
      for (var i = 0; i < drafts; i++) {
        await db.upsertDraft(
          sku: 'SKU-$i',
          name: 'สินค้า $i',
          warehouseCode: 'WHFG',
          systemQtyShown: 100,
          countedQty: 99,
          enteredBy: '52210',
        );
      }
      final container = ProviderContainer(
        overrides: [
          localDbProvider.overrideWithValue(db),
          connStateProvider.overrideWith((_) => Stream.value(ConnState.online)),
          queueDepthProvider.overrideWith((_) => Stream.value(queued)),
        ],
      );
      addTearDown(container.dispose);
      await container.read(appProvider.notifier).loadDrafts();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: SyncStatusBar())),
        ),
      );
      await tester.pump();
      return container;
    }

    testWidgets('ไม่มีอะไรค้าง → แถบไม่กินพื้นที่จอ', (tester) async {
      await pumpBar(tester);
      expect(tester.getSize(find.byType(SyncStatusBar)).height, 0);
    });

    testWidgets('draft 3 แถว → คีย์แล้วยังไม่ส่ง 3 รายการ (จุดสี warn)',
        (tester) async {
      await pumpBar(tester, drafts: 3);

      expect(find.text('คีย์แล้วยังไม่ส่ง 3 รายการ'), findsOneWidget);
      expect(dotColors(tester), [TclTokens.warn]);
    });

    testWidgets('มีทั้ง draft และคิวซิงค์ → บรรทัด draft มาก่อนเสมอ',
        (tester) async {
      await pumpBar(tester, drafts: 2, queued: 1);

      final draftX =
          tester.getTopLeft(find.text('คีย์แล้วยังไม่ส่ง 2 รายการ')).dx;
      final queueX = tester.getTopLeft(find.text('รอซิงค์ 1 รายการ')).dx;
      expect(
        draftX,
        lessThan(queueX),
        reason: 'งานที่ยังไม่มีใครส่งให้ ต้องมาก่อนงานที่ระบบกำลังส่งเอง',
      );
      // แยกด้วยสี ไม่ใช่ลำดับคำอย่างเดียว
      expect(dotColors(tester), [TclTokens.warn, TclTokens.accent]);
    });
  });
}
