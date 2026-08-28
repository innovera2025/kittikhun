import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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
