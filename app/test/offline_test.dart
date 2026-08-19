import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kittikhun_stock/data/models.dart';
import 'package:kittikhun_stock/data/stock_repository.dart';
import 'package:kittikhun_stock/local/local_db.dart';

/// เทสต์ offline layer — พิสูจน์ว่าคลังที่มีจุดอับสัญญาณยังทำงานได้
///
/// ถ้าเทสต์ชุดนี้ fail = งานนับของพนักงานอาจหายเมื่อไม่มีเน็ต = ห้าม deploy
void main() {
  late LocalDb db;

  setUp(() => db = LocalDb(NativeDatabase.memory()));
  tearDown(() => db.close());

  Item item(String sku, {String? name, List<String> barcodes = const []}) => Item(
        sku: sku,
        name: name ?? 'สินค้า $sku',
        unit: 'ชิ้น',
        barcodes: barcodes,
        onHand: 100,
        rop: 20,
        warehouse: 'WHFG',
      );

  group('replica — อ่านสินค้าแบบออฟไลน์', () {
    test('applyDelta เก็บสินค้า + บาร์โค้ด แล้วค้นด้วยบาร์โค้ดได้', () async {
      await db.applyDelta(
        items: [item('SKU-1', barcodes: ['8851234567890'])],
        tombstones: const [],
        nextCursor: '10',
      );

      final found = await db.itemByBarcode('8851234567890');
      expect(found?.sku, 'SKU-1');
      expect(await db.itemsCursor(), '10');
    });

    test('สแกน ItemCode (ฉลาก Code128) ได้แม้ไม่มีใน item_barcodes', () async {
      // ERP จริงมีบาร์โค้ดแค่ 1.9% → โปรเจคนี้พิมพ์ฉลาก Code128 จาก ItemCode
      await db.applyDelta(
        items: [item('SKU-40128')],
        tombstones: const [],
        nextCursor: '1',
      );

      final found = await db.itemByBarcode('SKU-40128');
      expect(found?.sku, 'SKU-40128');
    });

    test('tombstone ลบสินค้าที่ ERP เอาออกแล้ว', () async {
      await db.applyDelta(
        items: [item('SKU-1', barcodes: ['111']), item('SKU-2')],
        tombstones: const [],
        nextCursor: '2',
      );
      expect(await db.itemCount(), 2);

      await db.applyDelta(
        items: const [],
        tombstones: const ['SKU-1'],
        nextCursor: '3',
      );

      expect(await db.itemCount(), 1);
      // barcode ต้องหายไปด้วย ไม่งั้นสแกนแล้วเจอสินค้าที่ไม่มีอยู่
      expect(await db.itemByBarcode('111'), isNull);
    });

    test('ค้นหาชื่อไทยจาก replica', () async {
      await db.applyDelta(
        items: [
          item('SKU-1', name: 'สลักเกลียวหัวหกเหลี่ยม M12'),
          item('SKU-2', name: 'เทปพันสายไฟ PVC'),
        ],
        tombstones: const [],
        nextCursor: '2',
      );

      final hits = await db.searchItems('สลักเกลียว');
      expect(hits.length, 1);
      expect(hits.first.sku, 'SKU-1');
    });

    test('ค้นหาด้วย % ไม่กวาดทุกรายการ (escape LIKE)', () async {
      await db.applyDelta(
        items: [item('SKU-1'), item('SKU-2')],
        tombstones: const [],
        nextCursor: '2',
      );

      expect(await db.searchItems('%'), isEmpty);
    });
  });

  group('outbox — คิวผลนับที่ยังไม่ซิงค์', () {
    Future<void> seed() => db.applyDelta(
          items: [item('SKU-1'), item('SKU-2')],
          tombstones: const [],
          nextCursor: '2',
        );

    test('กรอกค่าที่นับได้ → เข้าคิวพร้อม idempotencyKey', () async {
      await seed();
      await db.enqueueCountLine(
        sessionId: 'CS-1',
        sku: 'SKU-1',
        countedQty: 95,
      );

      expect(await db.queueDepth(), 1);
      final due = await db.dueForSync();
      expect(due.length, 1);
      expect(due.first.sessionId, 'CS-1');
      // key ต้องเป็น UUID ที่ backend รับได้
      expect(due.first.id, matches(RegExp(r'^[0-9a-f-]{36}$')));
    });

    test('แก้ตัวเลขก่อนกดส่ง → แทนที่แถวเดิม ไม่ส่ง 2 รอบ', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 90);
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);

      expect(await db.queueDepth(), 1);
    });

    test('deviceSeq เพิ่มขึ้นเรื่อย ๆ (ลำดับการนับ ไม่ใช้นาฬิกาเครื่อง)', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 1);
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-2', countedQty: 2);

      final due = await db.dueForSync();
      final seqs = due.map((r) => r.deviceSeq).toList()..sort();
      expect(seqs[1], greaterThan(seqs[0]));
    });

    test('acked แล้วออกจากคิว', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);
      final due = await db.dueForSync();

      await db.markAcked(due.map((r) => r.id).toList());
      expect(await db.queueDepth(), 0);
    });

    test('rejected ค้างไว้ให้จอ pending-review — งานพนักงานต้องไม่หายเงียบ', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);
      final due = await db.dueForSync();

      await db.markRejectedAll(
        due.map((r) => r.id).toList(),
        code: 'SESSION_CLOSED',
      );

      // ต้องไม่กลับเข้าวงจร retry
      expect(await db.dueForSync(), isEmpty);
      // แต่ต้องยังเห็นในจอ pending-review พร้อมจำนวนที่นับได้
      final rejected = await db.rejectedForReview();
      expect(rejected.length, 1);
      expect(rejected.first.code, 'SESSION_CLOSED');
      expect(rejected.first.countedQty, 95);
      expect(rejected.first.sku, 'SKU-1');
    });

    test('ทิ้งรายการค้างตรวจได้ตามที่ผู้ใช้สั่ง', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);
      final due = await db.dueForSync();
      await db.markRejectedAll(due.map((r) => r.id).toList(), code: 'X');

      await db.discardRejected(due.first.id);
      expect(await db.rejectedForReview(), isEmpty);
    });

    test('retry ตั้งเวลาถัดไป (backoff) — ยังอยู่ในคิว', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);
      final due = await db.dueForSync();

      await db.markRetryAll(due.map((r) => r.id).toList(), error: 'เน็ตหลุด');

      // ยังนับเป็นงานค้าง (badge ต้องแสดง)
      expect(await db.queueDepth(), 1);
      // แต่ยังไม่ถึงเวลา retry
      expect(await db.dueForSync(), isEmpty);
    });

    test('inflight ที่ค้าง (แอปถูก kill กลางทาง) กู้กลับเข้าคิวได้', () async {
      await seed();
      await db.enqueueCountLine(sessionId: 'CS-1', sku: 'SKU-1', countedQty: 95);
      final due = await db.dueForSync();
      await db.markInflight(due.map((r) => r.id).toList());
      expect(await db.dueForSync(), isEmpty);

      await db.reclaimInflight();
      expect((await db.dueForSync()).length, 1);
    });

    test('scan event เข้าคิวได้ทั้งกรณีเจอและไม่เจอสินค้า', () async {
      await seed();
      await db.enqueueScanEvent(barcode: '8851234567890', sku: 'SKU-1');
      await db.enqueueScanEvent(barcode: '0000000000', sku: null);

      expect(await db.queueDepth(), 2);
    });
  });

  group('รอบนับ — นับต่อได้แม้ออฟไลน์', () {
    test('เก็บรอบนับ + ยอดระบบที่ freeze ไว้ในเครื่อง', () async {
      await db.applyDelta(
        items: [item('SKU-1')],
        tombstones: const [],
        nextCursor: '1',
      );

      await db.saveSession(ActiveSession(
        id: 'CS-1',
        voucherNo: 'CC-2408',
        zone: 'A',
        warehouseCode: 'WHFG',
        openedAt: DateTime(2026, 8, 17, 9),
        dataAsOf: DateTime(2026, 8, 17, 8, 30),
        rows: const [
          CountRow(sku: 'SKU-1', name: 'สินค้า SKU-1', systemQty: 100, unit: 'ชิ้น'),
        ],
      ));

      final s = await db.activeSession();
      expect(s?.id, 'CS-1');
      expect(s?.voucherNo, 'CC-2408');
      expect(s?.rows.length, 1);
      // ยอดระบบต้องนิ่ง (freeze) — ใช้เทียบกับที่พนักงานนับได้
      expect(s?.rows.first.systemQty, 100);
    });

    test('รอบนับถูกปิด → ลบออกจากเครื่อง', () async {
      await db.applyDelta(
        items: [item('SKU-1')],
        tombstones: const [],
        nextCursor: '1',
      );
      await db.saveSession(ActiveSession(
        id: 'CS-1',
        warehouseCode: 'WHFG',
        openedAt: DateTime(2026, 8, 17),
        rows: const [
          CountRow(sku: 'SKU-1', name: 'x', systemQty: 1, unit: 'ชิ้น'),
        ],
      ));

      await db.saveSession(null);
      expect(await db.activeSession(), isNull);
    });
  });

  group('newUuidV7 — idempotency key', () {
    test('ไม่ซ้ำกันแม้สร้างรวดเดียว 500 ตัว', () {
      final keys = List.generate(500, (_) => newUuidV7());
      expect(keys.toSet().length, 500);
    });

    test('เรียงตามเวลาข้าม millisecond', () async {
      // UUIDv7 มี timestamp 48-bit เป็น ms → ภายใน ms เดียวกันลำดับไม่ถูกรับประกัน
      // (ลำดับการนับจริงของระบบใช้ deviceSeq ใน outbox ไม่ใช่ UUID)
      final first = newUuidV7();
      await Future<void>.delayed(const Duration(milliseconds: 5));
      final later = newUuidV7();
      expect(later.compareTo(first), greaterThan(0));
    });

    test('รูปแบบตรงตามที่ backend (zod uuid) รับ', () {
      final k = newUuidV7();
      expect(
        k,
        matches(RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        )),
      );
    });
  });
}
