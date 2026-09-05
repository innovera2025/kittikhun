import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/data/api_client.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/data/stock_repository.dart';
import 'package:tcl_stock/features/count/pending_counts_screen.dart';
import 'package:tcl_stock/features/count/submit_drafts.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/local/sync_engine.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เทสต์เส้นทาง "ปิดเอกสารนับแล้วส่งเข้า ERP" (ขั้น 9–11 ของแผน)
///
/// สามเรื่องที่พลาดไม่ได้:
/// 1. เอกสาร 1 ใบ = outbox 1 แถว = 1 request · ส่งซ้ำต้องใช้ documentId เดิมเสมอ
/// 2. แอปไม่คำนวณและไม่ส่ง `diff` ขึ้น server (จุดกลับเครื่องหมายอยู่ฝั่ง server จุดเดียว)
/// 3. ยอดระบบขยับ (409) = งานกลับมาเป็น draft ครบ **ห้ามหาย ห้ามเปลี่ยนเลขเงียบ ๆ**
void main() {
  late LocalDb db;

  setUp(() => db = LocalDb(NativeDatabase.memory()));
  tearDown(() => db.close());

  Future<void> draft(
    String sku, {
    required num counted,
    num systemQty = 100,
    DateTime? at,
  }) {
    return db.upsertDraft(
      sku: sku,
      name: 'สินค้า $sku',
      unit: 'ชิ้น',
      warehouseCode: 'WHFG',
      systemQtyShown: systemQty,
      countedQty: counted,
      enteredBy: '52210',
      enteredAt: at,
    );
  }

  Map<String, dynamic> payloadOf(OutboxRow row) =>
      jsonDecode(row.payloadJson) as Map<String, dynamic>;

  // ══════════════════════════════════════════════════════════════════
  // ขั้น 9 — enqueueCountDoc
  // ══════════════════════════════════════════════════════════════════

  group('enqueueCountDoc — 1 ใบ = outbox 1 แถว', () {
    test('draft 5 แถว → outbox 1 แถว และ count_drafts ว่าง (ทรานแซกชันเดียว)',
        () async {
      for (var i = 1; i <= 5; i++) {
        await draft('SKU-$i', counted: 90 + i);
      }

      final doc = await db.enqueueCountDoc();
      expect(doc, isNotNull);
      expect(doc!.lineCount, 5);
      expect(await db.allDrafts(), isEmpty);

      final rows = await db.dueForSync();
      expect(rows.length, 1);
      expect(rows.single.type, OutboxType.countDoc);
      expect(rows.single.id, doc.documentId, reason: 'outbox.id = documentId');
      expect(rows.single.sessionId, isNull, reason: 'เอกสารแบบนี้ไม่มีรอบนับ');
      expect((payloadOf(rows.single)['lines'] as List).length, 5);
    });

    test('⭐ payload ห้ามมีคีย์ชื่อ diff / DifQty', () async {
      await draft('SKU-1', counted: 95, systemQty: 100);
      await db.enqueueCountDoc();

      final raw = (await db.dueForSync()).single.payloadJson;
      expect(raw.contains('diff'), isFalse);
      expect(raw.contains('DifQty'), isFalse);

      final line = ((payloadOf((await db.dueForSync()).single)['lines'] as List)
          .single as Map)
          .cast<String, dynamic>();
      expect(
        line.keys.toSet(),
        {'entryKey', 'sku', 'systemQtyShown', 'countedQty', 'countedAt'},
        reason: 'คีย์ของบรรทัดต้องตรงสัญญา API เป๊ะ',
      );
      expect(line['systemQtyShown'], 100);
      expect(line['countedQty'], 95);
    });

    test('เอกสาร 200 บรรทัดอยู่ในแถวเดียว · ส่วนที่เกินยังคีย์ค้างไว้', () async {
      final base = DateTime(2026, 8, 28, 9);
      for (var i = 0; i < 250; i++) {
        await draft(
          'SKU-$i',
          counted: 1,
          at: base.add(Duration(seconds: i)),
        );
      }

      final doc = await db.enqueueCountDoc();
      expect(doc!.lineCount, 200);
      expect(doc.remaining, 50);
      final rows = await db.dueForSync();
      expect(rows.length, 1, reason: 'ห้ามแตกเอกสารเป็นหลายแถว/หลาย request');
      expect((payloadOf(rows.single)['lines'] as List).length, 200);
      expect((await db.allDrafts()).length, 50);
    });

    test('⭐ ล้มกลางทาง → ไม่มีสภาพ "ส่งแล้วและยังคีย์ค้าง" พร้อมกัน', () async {
      await draft('SKU-1', counted: 95);

      // ห่ออีกชั้นแล้วโยนหลัง enqueue = จำลองการล้มก่อน commit
      await expectLater(
        db.transaction(() async {
          await db.enqueueCountDoc();
          throw StateError('crash');
        }),
        throwsA(isA<StateError>()),
      );

      expect(await db.dueForSync(), isEmpty);
      expect((await db.allDrafts()).single.countedQty, 95);
    });

    test('ไม่มี draft → ไม่เกิดแถวในคิว', () async {
      expect(await db.enqueueCountDoc(), isNull);
      expect(await db.dueForSync(), isEmpty);
    });

    test('retry ไม่เปลี่ยน payload → documentId เดิมทุกครั้ง', () async {
      await draft('SKU-1', counted: 95);
      final doc = await db.enqueueCountDoc();

      for (var i = 0; i < 3; i++) {
        await db.markRetryAll([doc!.documentId], error: 'เน็ตหลุด');
      }
      final row = (await db.select(db.outbox).get()).single;
      expect(row.id, doc!.documentId);
      expect(row.attempts, 3);
      expect(payloadOf(row)['documentId'], doc.documentId);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ขั้น 9/11 — 409 SYSTEM_QTY_DRIFT
  // ══════════════════════════════════════════════════════════════════

  group('restoreDraftsFromDocument — ยอดระบบขยับหลังคีย์', () {
    test('คืน draft พร้อมยอดใหม่ + ป้ายยอดเก่า + documentId เดิม', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();

      final restored = await db.restoreDraftsFromDocument(
        doc!.documentId,
        actualBySku: const {'SKU-1': 25},
      );

      expect(restored, 1);
      expect(await db.dueForSync(), isEmpty, reason: 'ใบนั้นยังไม่เคยถูกเขียน');
      final row = (await db.allDrafts()).single;
      expect(row.countedQty, 18, reason: 'ผลนับของคนห้ามเปลี่ยน');
      expect(row.systemQtyShown, 25, reason: 'ยอดระบบใหม่จาก server');
      expect(row.systemQtyBefore, 20, reason: 'ยอดเก่าไว้ขึ้นป้าย 20 → 25');
      expect(row.documentId, doc.documentId);

      // ยืนยันอีกรอบ → ต้องส่งด้วย id เดิม ไม่ใช่ใบใหม่
      final again = await db.enqueueCountDoc();
      expect(again!.documentId, doc.documentId);
    });

    test('บรรทัดที่ยอดไม่ขยับ กลับมาโดยไม่มีป้ายเตือน', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      await draft('SKU-2', counted: 5, systemQty: 5);
      final doc = await db.enqueueCountDoc();

      await db.restoreDraftsFromDocument(
        doc!.documentId,
        actualBySku: const {'SKU-1': 25},
      );

      final rows = {for (final r in await db.allDrafts()) r.sku: r};
      expect(rows['SKU-1']!.systemQtyBefore, 20);
      expect(rows['SKU-2']!.systemQtyBefore, isNull);
      expect(rows['SKU-2']!.systemQtyShown, 5);
    });

    test('คีย์ใหม่ระหว่างรอผลส่ง → ค่าที่ใหม่กว่าชนะ', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();
      await draft('SKU-1', counted: 30, systemQty: 20);

      await db.restoreDraftsFromDocument(doc!.documentId);
      expect((await db.allDrafts()).single.countedQty, 30);
    });

    test('payload อ่านไม่ได้ → คืน null และไม่ลบแถว (งานต้องไม่หาย)', () async {
      await draft('SKU-1', counted: 18);
      final doc = await db.enqueueCountDoc();
      await db.customStatement(
        "UPDATE outbox SET payload_json = 'พัง' WHERE id = ?",
        [doc!.documentId],
      );

      expect(await db.restoreDraftsFromDocument(doc.documentId), isNull);
      expect((await db.dueForSync()).length, 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ขั้น 9 — สายส่งใน SyncEngine
  // ══════════════════════════════════════════════════════════════════

  group('SyncEngine — เอกสารนับ', () {
    late _FakeCountRepository repo;
    late SyncEngine engine;
    var restoredCalls = 0;

    setUp(() {
      restoredCalls = 0;
      repo = _FakeCountRepository();
      engine = SyncEngine(
        localDb: db,
        catalogRepository: _fakeCatalog,
        countRepository: repo,
        syncRepository: _fakeSync,
        onDraftsRestored: () => restoredCalls += 1,
      );
    });

    test('200 → แถวถูกลบออกจากคิว และส่งเป็น request เดียว', () async {
      await draft('SKU-1', counted: 95);
      await draft('SKU-2', counted: 3);
      final doc = await db.enqueueCountDoc();

      final outcome = await engine.drainOutbox();

      expect(outcome.ok, isTrue);
      expect(outcome.pushed, 1);
      expect(repo.calls.length, 1, reason: 'ห้ามแตกเป็นหลาย request');
      expect(repo.calls.single.documentId, doc!.documentId);
      expect(repo.calls.single.lines.length, 2);
      expect(await db.dueForSync(), isEmpty);
      expect(await db.rejectedRows(), isEmpty);
    });

    test('⭐ 409 SYSTEM_QTY_DRIFT → บรรทัดกลับเป็น draft พร้อมยอดใหม่', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();
      repo.error = const ApiException(
        code: CountRepository.codeSystemQtyDrift,
        message: 'ยอดระบบเปลี่ยน',
        statusCode: 409,
        details: {
          'drifted': [
            {'sku': 'SKU-1', 'shown': 20, 'actual': 25},
          ],
        },
      );

      await engine.drainOutbox();

      expect(await db.dueForSync(), isEmpty);
      expect(await db.rejectedRows(), isEmpty, reason: 'ไม่ใช่งานค้างตรวจ');
      final row = (await db.allDrafts()).single;
      expect(row.systemQtyShown, 25);
      expect(row.systemQtyBefore, 20);
      expect(row.documentId, doc!.documentId);
      expect(restoredCalls, 1, reason: 'ชั้น state ต้องรู้ว่ามี draft กลับมา');
    });

    test('409 DOCUMENT_PAYLOAD_MISMATCH → ค้างในคิวให้จอ pending-review',
        () async {
      await draft('SKU-1', counted: 95);
      final doc = await db.enqueueCountDoc();
      repo.error = const ApiException(
        code: CountRepository.codeDocumentPayloadMismatch,
        message: 'รหัสเอกสารนี้ถูกใช้ไปแล้ว',
        statusCode: 409,
      );

      final outcome = await engine.drainOutbox();

      expect(outcome.rejected, 1);
      final rejected = await db.rejectedRows();
      expect(rejected.single.id, doc!.documentId);
      expect(rejected.single.rejectCode,
          CountRepository.codeDocumentPayloadMismatch);
      expect(await db.allDrafts(), isEmpty, reason: 'ห้ามคืนเป็น draft เงียบ ๆ');
    });

    test('5xx → ไม่ mark rejected · ลองใหม่ด้วย documentId เดิม', () async {
      await draft('SKU-1', counted: 95);
      final doc = await db.enqueueCountDoc();
      repo.error = const ApiException(
        code: 'SERVER',
        message: 'server ล่ม',
        statusCode: 503,
      );

      final outcome = await engine.drainOutbox();

      expect(outcome.ok, isFalse);
      expect(await db.rejectedRows(), isEmpty);
      final rows = await (db.select(db.outbox)).get();
      expect(rows.single.id, doc!.documentId);
      expect(rows.single.status, OutboxStatus.queued);
    });

    test('SESSION_EXPIRED → ไม่ mark rejected (ไม่ใช่ความผิดของข้อมูล)', () async {
      await draft('SKU-1', counted: 95);
      await db.enqueueCountDoc();
      repo.error = ApiException.sessionExpired(statusCode: 401);

      final outcome = await engine.drainOutbox();

      expect(outcome.needsReauth, isTrue);
      expect(await db.rejectedRows(), isEmpty);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ขั้น 10 — sendDraftsToErp
  // ══════════════════════════════════════════════════════════════════

  group('sendDraftsToErp', () {
    late ProviderContainer container;
    late AppController c;

    setUp(() {
      container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
      c = container.read(appProvider.notifier);
    });
    tearDown(() => container.dispose());

    Future<void> signIn(String empId) async {
      c.setEmpId(empId);
      c.setPassword('any-secret');
      await c.signIn();
    }

    test('กดยืนยันรัว ๆ → เข้าคิวใบเดียว (busy)', () async {
      await c.setScanCount(_item(), '19');

      await Future.wait([c.sendDraftsToErp(), c.sendDraftsToErp()]);

      expect((await db.dueForSync()).length, 1);
      expect(container.read(appProvider).draftCount, 0);
      expect(container.read(appProvider).counts['SKU-1'], isNull);
      expect(container.read(appProvider).busy, isFalse);
    });

    test('viewer กดส่ง → ถูกปฏิเสธ ไม่มีแถวในคิว', () async {
      await c.setScanCount(_item(), '19'); // ตอนนี้ยังเป็น admin
      await signIn('52402'); // Nattaporn K. = viewer
      await c.loadDrafts();

      await c.sendDraftsToErp();

      expect(await db.dueForSync(), isEmpty);
      expect(container.read(appProvider).toast, 'สิทธิ์ viewer ส่งผลนับไม่ได้');
      expect((await db.allDrafts()).length, 1, reason: 'งานที่คีย์ไว้ต้องอยู่ครบ');
    });

    test('ไม่มี draft → ไม่เกิดเอกสารเปล่า', () async {
      await c.sendDraftsToErp();
      expect(await db.dueForSync(), isEmpty);
      expect(container.read(appProvider).toast, 'ยังไม่มีรายการที่คีย์ไว้');
    });

    test('ลบ draft รายแถว → หายจากลิสต์และจากแถบเตือน', () async {
      await c.setScanCount(_item(), '19');
      expect(container.read(appProvider).draftCount, 1);

      await c.deleteDraft('SKU-1');

      expect(container.read(appProvider).draftCount, 0);
      expect(await db.allDrafts(), isEmpty);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ขั้น 10/11 — จอ
  // ══════════════════════════════════════════════════════════════════

  group('จอ รอส่ง + popup ยืนยัน', () {
    Future<ProviderContainer> pump(
      WidgetTester tester, {
      String? signInAs,
    }) async {
      final container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
      addTearDown(container.dispose);
      final c = container.read(appProvider.notifier);
      if (signInAs != null) {
        c.setEmpId(signInAs);
        c.setPassword('any-secret');
        await c.signIn();
      }
      await c.loadDrafts();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: PendingCountsScreen()),
          ),
        ),
      );
      await tester.pump();
      return container;
    }

    testWidgets('แสดง draft ทุกแถว + ปุ่มส่งบอกจำนวน', (tester) async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      await draft('SKU-2', counted: 7, systemQty: 5);
      await pump(tester);

      expect(find.text('SKU-1'), findsOneWidget);
      expect(find.text('SKU-2'), findsOneWidget);
      expect(find.text('ขาด -2'), findsOneWidget);
      expect(find.text('เกิน +2'), findsOneWidget);
      expect(find.text('ส่งผลนับ · 2 รายการ'), findsOneWidget);
    });

    testWidgets('ไม่มี draft → ไม่มีปุ่มส่ง', (tester) async {
      await pump(tester);
      expect(find.byType(SubmitDraftsBar), findsOneWidget);
      expect(find.textContaining('ส่งผลนับ'), findsNothing);
    });

    testWidgets('⭐ admin เห็นปุ่มจอผู้ดูแล · staff ไม่เห็น', (tester) async {
      await pump(tester, signInAs: '52104'); // Tcl S. = admin
      expect(find.text('จอผู้ดูแล'), findsOneWidget);

      await pump(tester, signInAs: '52210'); // ปิยะนุช = staff
      expect(find.text('จอผู้ดูแล'), findsNothing);
    });

    testWidgets('⭐ ยอดระบบขยับ → ขึ้นป้าย 20 → 25 พร้อมผลต่างใหม่',
        (tester) async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();
      await db.restoreDraftsFromDocument(
        doc!.documentId,
        actualBySku: const {'SKU-1': 25},
      );
      await pump(tester);

      expect(find.textContaining('ยอดระบบเปลี่ยน (20 → 25)'), findsOneWidget);
      expect(find.text('ขาด -7'), findsOneWidget);
    });

    testWidgets('popup สรุป ขาด/เกิน/ตรง และรวมสุทธิ', (tester) async {
      await draft('SKU-1', counted: 18, systemQty: 20); // ขาด -2
      await draft('SKU-2', counted: 7, systemQty: 5); // เกิน +2
      await draft('SKU-3', counted: 5, systemQty: 5); // ตรง
      await pump(tester);

      await tester.tap(find.text('ส่งผลนับ · 3 รายการ'));
      await tester.pumpAndSettle();

      expect(find.text('ยืนยันส่งผลนับ'), findsOneWidget);
      expect(find.text('1 รายการ · รวม -2'), findsOneWidget);
      expect(find.text('1 รายการ · รวม +2'), findsOneWidget);
      expect(find.text('1 รายการ'), findsOneWidget); // ตรงกับระบบ
      expect(find.text('0'), findsWidgets); // รวมสุทธิ
      expect(
        find.textContaining('ลบใน ERP ไม่ได้'),
        findsOneWidget,
        reason: 'คำเตือนที่ห้ามหายไปจากจอนี้',
      );
    });

    testWidgets('⭐ มีรายการนับได้ 0 → ต้องติ๊กยืนยันก่อนกดส่งได้', (tester) async {
      await draft('SKU-1', counted: 0, systemQty: 20);
      final container = await pump(tester);

      await tester.tap(find.text('ส่งผลนับ · 1 รายการ'));
      await tester.pumpAndSettle();

      // ยังไม่ติ๊ก → ปุ่มยืนยันถูกปิด (กดแล้ว popup ไม่ปิด ไม่มีอะไรเข้าคิว)
      await tester.tap(find.text('ยืนยันส่ง'));
      await tester.pumpAndSettle();
      expect(find.text('ยืนยันส่งผลนับ'), findsOneWidget);
      expect(await db.dueForSync(), isEmpty);

      await tester.tap(find.textContaining('ยืนยันว่านับแล้วได้ 0 จริง'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('ยืนยันส่ง'));
      await tester.pumpAndSettle();

      expect((await db.dueForSync()).length, 1);
      expect(container.read(appProvider).draftCount, 0);
      // ปล่อย timer ของ toast ให้หมดอายุก่อนจบเทสต์
      await tester.pump(TclToastDuration.value);
    });
  });
}

Item _item({num? onHand = 20, String sku = 'SKU-1'}) => Item(
      sku: sku,
      name: 'สินค้า $sku',
      unit: 'ชิ้น',
      onHand: onHand,
    );

// ── fake ของชั้น repository ────────────────────────────────────────
//
// ApiClient/TokenStore ถูกสร้างแต่ไม่เคยถูกเรียก (เมธอดที่ใช้ถูก override หมด)

final TokenStore _store = TokenStore();
final ApiClient _api = ApiClient(tokenStore: _store);
final CatalogRepository _fakeCatalog =
    CatalogRepository(api: _api, store: _store);
final SyncRepository _fakeSync = SyncRepository(api: _api);

class _FakeCountRepository extends CountRepository {
  _FakeCountRepository() : super(api: _api, store: _store);

  final List<({String documentId, List<CountDocumentLine> lines})> calls = [];

  /// error ที่จะโยนแทนการยิงจริง — null = สำเร็จ
  ApiException? error;

  @override
  Future<CountDocumentResult> submitDocument({
    required String documentId,
    required List<CountDocumentLine> lines,
    bool acceptSystemQtyDrift = false,
  }) async {
    calls.add((documentId: documentId, lines: lines));
    final failure = error;
    if (failure != null) throw failure;
    return CountDocumentResult(
      documentId: documentId,
      lineCount: lines.length,
      lines: const [],
      erp: const CountDocumentErp(status: CountDocumentErp.statusDisabled),
    );
  }
}
