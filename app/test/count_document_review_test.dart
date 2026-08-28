import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/data/api_client.dart';
import 'package:tcl_stock/data/stock_repository.dart';
import 'package:tcl_stock/features/pending/pending_review_screen.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/local/sync_engine.dart';

/// เทสต์ข้อค้นพบจากการรีวิวเส้นทาง "นับแบบไม่มีรอบ → ส่งเอกสารเข้า ERP"
///
/// สิ่งที่ชุดนี้คุมไว้:
/// 1. เอกสารที่ถูกปฏิเสธต้องแสดง **รายการจริง** บนจอ pending-review และปุ่มทิ้ง
///    ต้องบอกจำนวนที่จะหาย (แตะ 2 ครั้งลบผลนับได้ถึง 200 บรรทัด)
/// 2. `erp.status` ทั้ง 4 ค่าต้องมีข้อความต่างกัน และแยก "บันทึกผลนับแล้ว"
///    ออกจาก "เข้า ERP แล้ว" — `disabled` ห้ามดูเหมือนสำเร็จ
/// 3. `POST /count-documents` ต้องได้ timeout ยาวกว่าค่า global (server ยิง ERP ต่อ)
/// 4. ซอร์ส Dart ต้องไม่มีไบต์ NUL
/// 5. `restoreDraftsFromDocument` ต้องแยก "ข้ามเพราะมีของใหม่กว่า" (ยอมได้)
///    ออกจาก "ข้ามเพราะข้อมูลหาย" (ยอมไม่ได้ → คืน null ห้ามลบแถวทิ้ง)
void main() {
  late LocalDb db;

  setUp(() => db = LocalDb(NativeDatabase.memory()));
  tearDown(() => db.close());

  Future<void> draft(
    String sku, {
    required num counted,
    num systemQty = 100,
    String? unit = 'ชิ้น',
    DateTime? at,
  }) {
    return db.upsertDraft(
      sku: sku,
      name: 'สินค้า $sku',
      unit: unit,
      warehouseCode: 'WHFG',
      systemQtyShown: systemQty,
      countedQty: counted,
      enteredBy: '52210',
      enteredAt: at,
    );
  }

  /// ปิดเอกสารจาก draft ที่คีย์ไว้ แล้วให้ backend ปฏิเสธถาวร
  Future<String> rejectedDocument({
    String code = CountRepository.codeDocumentPayloadMismatch,
  }) async {
    final doc = await db.enqueueCountDoc();
    await db.markRejectedAll([doc!.documentId], code: code);
    return doc.documentId;
  }

  // ══════════════════════════════════════════════════════════════════
  // HIGH-1 — RejectedRow ต้องรู้จัก payload แบบ count_doc
  // ══════════════════════════════════════════════════════════════════

  group('RejectedRow — เอกสารทั้งใบต้องไม่กลายเป็นการ์ดเปล่า', () {
    test('⭐ payload count_doc → แตกเป็น lines พร้อม sku/ชื่อ/หน่วย/จำนวน', () async {
      await draft('SKU-1', counted: 95);
      await draft('SKU-2', counted: 0);
      await draft('SKU-3', counted: 12);
      final id = await rejectedDocument();

      final rows = await db.rejectedForReview();
      final row = rows.single;

      expect(row.id, id);
      expect(row.isDocument, isTrue);
      expect(row.lines.length, 3, reason: 'ผู้ใช้ต้องรู้ว่ากำลังจะทิ้งกี่รายการ');
      expect(row.lines.map((l) => l.sku), ['SKU-1', 'SKU-2', 'SKU-3']);
      expect(row.lines.map((l) => l.countedQty), [95, 0, 12]);
      expect(row.lines.first.name, 'สินค้า SKU-1');
      expect(row.lines.first.unit, 'ชิ้น');
    });

    test('นับได้ 0 คงเป็น 0 · ไม่ใช่ "ไม่ทราบจำนวน"', () async {
      await draft('SKU-1', counted: 0);
      await rejectedDocument();

      final line = (await db.rejectedForReview()).single.lines.single;
      expect(line.countedQty, 0);
      expect(line.countedQty, isNotNull);
    });

    test('บรรทัดที่อ่าน countedQty ไม่ได้ → null (ห้ามเดาเป็น 0)', () async {
      await draft('SKU-1', counted: 95);
      final id = await rejectedDocument();
      final payload = jsonDecode(
        (await db.rejectedRows()).single.payloadJson,
      ) as Map<String, dynamic>;
      (payload['lines'] as List).first['countedQty'] = 'พัง';
      await db.customStatement(
        'UPDATE outbox SET payload_json = ? WHERE id = ?',
        [jsonEncode(payload), id],
      );

      final line = (await db.rejectedForReview()).single.lines.single;
      expect(line.sku, 'SKU-1', reason: 'sku ยังต้องเห็น');
      expect(line.countedQty, isNull);
    });

    test('งานแบบบรรทัดเดียว (count_line) ยังเป็นรูปเดิม — lines ว่าง', () async {
      await db.enqueueCountLine(
        sessionId: 'CS-1',
        sku: 'SKU-9',
        countedQty: 42,
      );
      final due = await db.dueForSync();
      await db.markRejectedAll([due.single.id], code: 'SESSION_CLOSED');

      final row = (await db.rejectedForReview()).single;
      expect(row.isDocument, isFalse);
      expect(row.lines, isEmpty);
      expect(row.sku, 'SKU-9');
      expect(row.countedQty, 42);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // HIGH-1 — จอ pending-review
  // ══════════════════════════════════════════════════════════════════

  group('จอ pending-review — การ์ดเอกสารต้องมีรายการจริง', () {
    Future<ProviderContainer> pump(WidgetTester tester) async {
      final container = ProviderContainer(
        overrides: [
          localDbProvider.overrideWithValue(db),
          // provider ตัวจริงคืนลิสต์ว่างในโหมดไม่มี backend — อ่านผ่านเส้นทางจริง
          // (`rejectedForReview` → `entryFrom`) เพื่อคุมทั้งสายตั้งแต่ payload
          pendingReviewProvider.overrideWith((ref) async {
            final rows = await db.rejectedForReview();
            return [for (final row in rows) entryFrom(row, null)];
          }),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: PendingReviewScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return container;
    }

    testWidgets('⭐ แสดง sku/ชื่อ/จำนวนของทุกบรรทัด + จำนวนรายการ', (tester) async {
      await draft('SKU-1', counted: 95);
      await draft('SKU-2', counted: 3);
      await rejectedDocument();
      await pump(tester);

      expect(find.text('เอกสารนับ · 2 รายการ'), findsOneWidget);
      expect(find.text('SKU-1'), findsOneWidget);
      expect(find.text('SKU-2'), findsOneWidget);
      expect(find.text('สินค้า SKU-1'), findsOneWidget);
      expect(find.text('95'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(
        find.text('มี 2 รายการที่ส่งไม่สำเร็จ'),
        findsOneWidget,
        reason: 'หัวจอต้องนับ "รายการ" จริง ไม่ใช่จำนวนการ์ด',
      );
    });

    testWidgets('⭐ ปุ่มทิ้งบอกจำนวนที่จะหาย ทั้งจังหวะแรกและจังหวะยืนยัน',
        (tester) async {
      for (var i = 1; i <= 4; i++) {
        await draft('SKU-$i', counted: i);
      }
      await rejectedDocument();
      await pump(tester);

      expect(find.text('ทิ้งทั้งใบ · 4 รายการ'), findsOneWidget);
      expect(find.text('ทิ้งรายการนี้'), findsNothing);

      await tester.tap(find.text('ทิ้งทั้งใบ · 4 รายการ'));
      await tester.pump();
      expect(find.text('ยืนยันทิ้ง 4 รายการ?'), findsOneWidget);

      await tester.tap(find.text('ยืนยันทิ้ง 4 รายการ?'));
      await tester.pumpAndSettle();
      expect(await db.rejectedForReview(), isEmpty);
    });

    testWidgets('ใบยาวเกินที่กางไหว → สรุปส่วนที่เหลือ ไม่ตัดทิ้งเงียบ ๆ',
        (tester) async {
      final base = DateTime(2026, 8, 28, 9);
      for (var i = 1; i <= 15; i++) {
        await draft('SKU-$i', counted: i, at: base.add(Duration(seconds: i)));
      }
      await rejectedDocument();
      await pump(tester);

      expect(find.text('เอกสารนับ · 15 รายการ'), findsOneWidget);
      expect(find.text('และอีก 3 รายการ'), findsOneWidget);
      expect(find.text('ทิ้งทั้งใบ · 15 รายการ'), findsOneWidget);
    });

    testWidgets('รายการเดี่ยวยังใช้ปุ่มเดิม', (tester) async {
      await db.enqueueCountLine(
        sessionId: 'CS-1',
        sku: 'SKU-9',
        countedQty: 42,
      );
      final due = await db.dueForSync();
      await db.markRejectedAll([due.single.id], code: 'SESSION_CLOSED');
      await pump(tester);

      expect(find.text('ทิ้งรายการนี้'), findsOneWidget);
      expect(find.text('รอบนับถูกปิดแล้ว'), findsOneWidget);
      expect(find.text('42'), findsOneWidget);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // HIGH-2 — erp.status ต้องถึงตาคน
  // ══════════════════════════════════════════════════════════════════

  group('erp.status — ข้อความต้องต่างกันทั้ง 4 ค่า', () {
    late _FakeCountRepository repo;
    late SyncEngine engine;
    late List<String> messages;

    setUp(() {
      messages = <String>[];
      repo = _FakeCountRepository();
      engine = SyncEngine(
        localDb: db,
        catalogRepository: _fakeCatalog,
        countRepository: repo,
        syncRepository: _fakeSync,
        onDocumentSubmitted: messages.add,
      );
    });

    Future<String> send(CountDocumentErp erp) async {
      await draft('SKU-1', counted: 95);
      await db.enqueueCountDoc();
      repo.erp = erp;
      final outcome = await engine.drainOutbox();
      expect(outcome.pushed, 1, reason: '200 = ผลนับถูกบันทึกแล้วเสมอ');
      return messages.last;
    }

    test('sent → บอกว่าเข้า ERP แล้ว พร้อมเลขเอกสาร', () async {
      final message = await send(
        const CountDocumentErp(
          status: CountDocumentErp.statusSent,
          voucherNo: 'VC-6808-0001',
        ),
      );
      expect(message, 'บันทึกผลนับแล้ว · เข้า ERP แล้ว · VC-6808-0001');
    });

    test('queued → รอเข้า ERP (ยังไม่ใช่ "เข้า ERP แล้ว")', () async {
      final message = await send(
        const CountDocumentErp(status: CountDocumentErp.statusQueued),
      );
      expect(message, 'บันทึกผลนับแล้ว · รอเข้า ERP');
      expect(message.contains('เข้า ERP แล้ว'), isFalse);
    });

    test('⭐ disabled → บอกตรง ๆ ว่ายังไม่ได้เปิดการส่งเข้า ERP', () async {
      final message = await send(
        const CountDocumentErp(status: CountDocumentErp.statusDisabled),
      );
      expect(message, 'บันทึกผลนับแล้ว · ยังไม่ได้เปิดการส่งเข้า ERP');
      expect(
        message.contains('เข้า ERP แล้ว'),
        isFalse,
        reason: 'ห้ามทำให้ดูเหมือนสำเร็จ',
      );
    });

    test('failed → ผลนับไม่หาย แต่บอกว่าส่งเข้า ERP ไม่สำเร็จ', () async {
      final message = await send(
        const CountDocumentErp(status: CountDocumentErp.statusFailed),
      );
      expect(message, 'บันทึกผลนับแล้ว · ส่งเข้า ERP ไม่สำเร็จ');
      expect(message.startsWith('บันทึกผลนับแล้ว'), isTrue);
    });

    test('สถานะที่ไม่รู้จัก → ไม่เดาว่าสำเร็จ', () {
      const erp = CountDocumentErp(status: 'weird');
      expect(erp.toastTh, 'บันทึกผลนับแล้ว · ไม่ทราบสถานะ ERP');
    });

    test('⭐ ทั้ง 4 ค่าให้ข้อความไม่ซ้ำกันเลย', () {
      final labels = <String>{
        for (final status in [
          CountDocumentErp.statusSent,
          CountDocumentErp.statusQueued,
          CountDocumentErp.statusDisabled,
          CountDocumentErp.statusFailed,
        ])
          CountDocumentErp(status: status).toastTh,
      };
      expect(labels.length, 4);
    });

    test('เอกสารถูกตีกลับ (409) → ไม่มีข้อความว่าบันทึกแล้ว', () async {
      await draft('SKU-1', counted: 95);
      await db.enqueueCountDoc();
      repo.error = const ApiException(
        code: CountRepository.codeDocumentPayloadMismatch,
        message: 'รหัสเอกสารนี้ถูกใช้ไปแล้ว',
        statusCode: 409,
      );

      await engine.drainOutbox();

      expect(messages, isEmpty);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // MEDIUM-7 — timeout ต่อ request
  // ══════════════════════════════════════════════════════════════════

  group('timeout ของ POST /count-documents', () {
    test('⭐ ยาวกว่าค่า global เพราะ server ยิง ERP ต่อแบบ synchronous', () async {
      final api = _RecordingApiClient();
      final repo = CountRepository(api: api, store: _FakeTokenStore());

      await repo.submitDocument(
        documentId: 'DOC-1',
        lines: [
          CountDocumentLine(
            entryKey: 'E-1',
            sku: 'SKU-1',
            systemQtyShown: 100,
            countedQty: 95,
            countedAt: DateTime.utc(2026, 8, 28, 2),
          ),
        ],
      );

      expect(api.lastPath, '/count-documents');
      expect(api.lastReceiveTimeout, ApiConfig.longWriteTimeout);
      expect(
        ApiConfig.longWriteTimeout,
        greaterThan(ApiConfig.receiveTimeout),
        reason: 'ค่า global 30 วิ สั้นกว่างานจริงของ endpoint นี้',
      );
    });

    test('ค่า global ไม่ถูกแก้ (endpoint อื่นต้องยังเหมือนเดิม)', () {
      expect(ApiConfig.receiveTimeout, const Duration(seconds: 30));
      expect(ApiConfig.connectTimeout, const Duration(seconds: 15));
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // LOW-8 — ไบต์ NUL ในซอร์ส
  // ══════════════════════════════════════════════════════════════════

  group('ซอร์ส Dart ต้องเป็นไฟล์ข้อความ', () {
    test('⭐ ไม่มีไบต์ NUL (0x00) — ไม่งั้น grep/diff มองเป็น binary', () {
      for (final path in const [
        'lib/local/sync_engine.dart',
        'lib/local/local_db.dart',
        'lib/data/api_client.dart',
        'lib/data/stock_repository.dart',
        'lib/features/pending/pending_review_screen.dart',
      ]) {
        expect(
          File(path).readAsBytesSync().contains(0),
          isFalse,
          reason: '$path มีไบต์ NUL ฝังอยู่',
        );
      }
    });

    test('คีย์จัดกลุ่มยังแยก session ออกจากกันเหมือนเดิม', () async {
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 1);
      await db.enqueueCountLine(sessionId: 'CS-2', sku: 'SKU-2', countedQty: 2);
      final repo = _FakeCountRepository();
      final engine = SyncEngine(
        localDb: db,
        catalogRepository: _fakeCatalog,
        countRepository: repo,
        syncRepository: _fakeSync,
      );

      await engine.drainOutbox();

      expect(
        repo.submittedSessions,
        ['CS-1', 'CS-2'],
        reason: 'คนละรอบนับต้องแยก request เหมือนเดิม',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // LOW-9 — ข้อมูลหาย ≠ มีของใหม่กว่า
  // ══════════════════════════════════════════════════════════════════

  group('restoreDraftsFromDocument — ข้อมูลหายต้องไม่ทำให้แถวถูกลบ', () {
    /// แก้ payload ของแถว outbox ที่ค้างอยู่
    Future<void> patchPayload(
      String id,
      void Function(Map<String, dynamic> payload) edit,
    ) async {
      final row = (await db.select(db.outbox).get()).single;
      final payload = jsonDecode(row.payloadJson) as Map<String, dynamic>;
      edit(payload);
      await db.customStatement(
        'UPDATE outbox SET payload_json = ? WHERE id = ?',
        [jsonEncode(payload), id],
      );
    }

    test('⭐ ไม่มี metadata ของบรรทัด → คืน null และแถวยังอยู่', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      await draft('SKU-2', counted: 5, systemQty: 5);
      final doc = await db.enqueueCountDoc();
      // metadata หายไป 1 บรรทัด = ประกอบ draft กลับไม่ครบ
      await patchPayload(doc!.documentId, (payload) {
        (payload['drafts'] as List).removeLast();
      });

      expect(await db.restoreDraftsFromDocument(doc.documentId), isNull);
      expect((await db.dueForSync()).length, 1, reason: 'ห้ามลบงานทิ้ง');
      expect(
        await db.allDrafts(),
        isEmpty,
        reason: 'ห้ามคืนได้ครึ่งใบแล้วบอกว่าอ่านไม่ได้',
      );
    });

    test('⭐ บรรทัดชนิดข้อมูลผิด → คืน null และแถวยังอยู่', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();
      await patchPayload(doc!.documentId, (payload) {
        (payload['lines'] as List).first['countedQty'] = 'พัง';
      });

      expect(await db.restoreDraftsFromDocument(doc.documentId), isNull);
      expect((await db.dueForSync()).length, 1);
      expect(await db.allDrafts(), isEmpty);
    });

    test('ข้ามเพราะมีของใหม่กว่า → ยังคืนสำเร็จ และลบแถวออกจากคิว', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      await draft('SKU-2', counted: 5, systemQty: 5);
      final doc = await db.enqueueCountDoc();
      await draft('SKU-1', counted: 30, systemQty: 20); // คีย์ทับระหว่างรอส่ง

      final restored = await db.restoreDraftsFromDocument(doc!.documentId);

      expect(restored, 1, reason: 'SKU-1 ถูกข้ามเพราะมีของใหม่กว่า');
      expect(await db.dueForSync(), isEmpty);
      final rows = {for (final r in await db.allDrafts()) r.sku: r};
      expect(rows['SKU-1']!.countedQty, 30);
      expect(rows['SKU-2']!.countedQty, 5);
    });

    test('SyncEngine: ข้อมูลหาย → เข้าจอ pending-review ไม่ใช่หายเงียบ', () async {
      await draft('SKU-1', counted: 18, systemQty: 20);
      final doc = await db.enqueueCountDoc();
      await patchPayload(doc!.documentId, (payload) {
        (payload['drafts'] as List).clear();
      });
      final repo = _FakeCountRepository();
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
      final engine = SyncEngine(
        localDb: db,
        catalogRepository: _fakeCatalog,
        countRepository: repo,
        syncRepository: _fakeSync,
      );

      final outcome = await engine.drainOutbox();

      expect(outcome.rejected, 1);
      final rejected = await db.rejectedForReview();
      expect(rejected.single.id, doc.documentId);
      expect(rejected.single.lines.length, 1, reason: 'ยังเห็นว่าค้างอะไรอยู่');
    });
  });
}

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

  /// สถานะ ERP ที่จะตอบกลับมากับ 200
  CountDocumentErp erp =
      const CountDocumentErp(status: CountDocumentErp.statusSent);

  /// error ที่จะโยนแทนการยิงจริง — null = สำเร็จ
  ApiException? error;

  /// รอบนับที่ถูกยิงจริง (เรียงตามลำดับ request)
  final List<String> submittedSessions = [];

  @override
  Future<CountDocumentResult> submitDocument({
    required String documentId,
    required List<CountDocumentLine> lines,
    bool acceptSystemQtyDrift = false,
  }) async {
    final failure = error;
    if (failure != null) throw failure;
    return CountDocumentResult(
      documentId: documentId,
      lineCount: lines.length,
      lines: const [],
      erp: erp,
    );
  }

  @override
  Future<List<SubmitResult>> submit({
    required String sessionId,
    required List<SubmitLine> lines,
    int? queueDepth,
  }) async {
    submittedSessions.add(sessionId);
    return [
      for (final line in lines)
        SubmitResult(idempotencyKey: line.idempotencyKey, status: 'accepted'),
    ];
  }
}

/// ApiClient ที่จดว่า request ถูกยิงด้วย timeout เท่าไร (ไม่ยิงเน็ตจริง)
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(tokenStore: _store);

  String? lastPath;
  Duration? lastReceiveTimeout;

  @override
  Future<T> post<T>(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
    Duration? receiveTimeout,
  }) async {
    lastPath = path;
    lastReceiveTimeout = receiveTimeout;
    return <String, dynamic>{
      'documentId': 'DOC-1',
      'lineCount': 1,
      'lines': const [],
      'erp': {'status': 'sent'},
    } as T;
  }
}

/// deviceId แบบไม่แตะ keychain (unit test ไม่มี platform channel)
class _FakeTokenStore extends TokenStore {
  @override
  Future<String> getDeviceId() async => 'device-test';
}
