import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/local/local_db.dart';

/// เทสต์ตาราง `count_drafts` + การอัปเกรด schema v1 → v2
///
/// ข้อที่ห้ามพลาด: เครื่องที่อัปเกรดอาจมีงานค้างใน outbox ที่ยังไม่ถึง server
/// migration ที่ล้างข้อมูล = ผลนับของพนักงานหายเงียบ ๆ
void main() {
  group('count_drafts — บรรทัดที่คีย์ไว้แต่ยังไม่กดส่ง', () {
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
        warehouseCode: 'WHFG',
        systemQtyShown: systemQty,
        countedQty: counted,
        enteredBy: '52210',
        enteredAt: at,
      );
    }

    test('sku เดิมทับแถวเดิม — ค่าล่าสุดชนะ ไม่เกิดบรรทัดซ้ำ', () async {
      await draft('SKU-1', counted: 10);
      await draft('SKU-1', counted: 12);

      final rows = await db.allDrafts();
      expect(rows.length, 1);
      expect(rows.single.countedQty, 12);
    });

    test('นับได้ 0 ต้องเก็บเป็นแถวจริง (ของหาย ≠ ยังไม่ได้นับ)', () async {
      await draft('SKU-1', counted: 0);

      final rows = await db.allDrafts();
      expect(rows.single.countedQty, 0);
    });

    test('เก็บทศนิยมได้ตามที่คีย์', () async {
      await draft('SKU-1', counted: 20.5, systemQty: 20);
      expect((await db.allDrafts()).single.countedQty, 20.5);
    });

    test('allDrafts เรียงตาม enteredAt (เก่า → ใหม่)', () async {
      final base = DateTime(2026, 8, 27, 9);
      await draft('SKU-B', counted: 1, at: base.add(const Duration(minutes: 5)));
      await draft('SKU-A', counted: 1, at: base);
      await draft('SKU-C', counted: 1, at: base.add(const Duration(minutes: 9)));

      expect(
        (await db.allDrafts()).map((r) => r.sku).toList(),
        ['SKU-A', 'SKU-B', 'SKU-C'],
      );
    });

    test('deleteDraft → watchDraftCount ลดลง', () async {
      await draft('SKU-1', counted: 1);
      await draft('SKU-2', counted: 2);
      expect(await db.watchDraftCount().first, 2);

      await db.deleteDraft('SKU-1');
      expect(await db.watchDraftCount().first, 1);
      expect((await db.allDrafts()).single.sku, 'SKU-2');
    });

    test('clearDrafts ลบเฉพาะ sku ที่ส่งสำเร็จ — แถวที่คีย์เพิ่มยังอยู่', () async {
      await draft('SKU-1', counted: 1);
      await draft('SKU-2', counted: 2);
      await draft('SKU-3', counted: 3);

      await db.clearDrafts(['SKU-1', 'SKU-3']);
      expect((await db.allDrafts()).map((r) => r.sku).toList(), ['SKU-2']);

      // ลิสต์ว่าง = ไม่ทำอะไร (ห้ามตีความว่า "ล้างทั้งตาราง")
      await db.clearDrafts(const []);
      expect((await db.allDrafts()).length, 1);
    });

    test('systemQtyShown คือสแนปช็อตตอนคีย์ ไม่ใช่ยอดล่าสุด', () async {
      await draft('SKU-1', counted: 95, systemQty: 100);
      expect((await db.allDrafts()).single.systemQtyShown, 100);
    });
  });

  group('migration v1 → v2', () {
    test('อัปเกรดแล้วงานค้างใน outbox ครบเท่าเดิม และ count_drafts ว่าง', () async {
      final dir = Directory.systemTemp.createTempSync('tcl_db_test');
      final file = File('${dir.path}/tcl.sqlite');
      addTearDown(() => dir.deleteSync(recursive: true));

      // ── จำลองเครื่องที่ยังเป็น schema v1 (ยังไม่มี count_drafts)
      final v1 = LocalDb(NativeDatabase(file));
      await v1.enqueueScanEvent(barcode: '8851234567890', sku: 'SKU-1');
      await v1.enqueueCountLine(
        sessionId: 'sess-1',
        sku: 'SKU-1',
        countedQty: 7,
      );
      await v1.customStatement('DROP TABLE count_drafts');
      await v1.customStatement('PRAGMA user_version = 1');
      await v1.close();

      // ── เปิดใหม่ด้วยโค้ดปัจจุบัน → onUpgrade ต้องสร้างตารางให้เอง
      final v2 = LocalDb(NativeDatabase(file));
      addTearDown(v2.close);

      expect(await v2.queueDepth(), 2, reason: 'งานค้างห้ามหายตอน migrate');
      final pending = await v2.dueForSync();
      expect(pending.map((r) => r.type).toSet(), {
        OutboxType.scanEvent,
        OutboxType.countLine,
      });
      expect(await v2.allDrafts(), isEmpty);

      // ตารางใหม่ใช้งานได้จริงหลังอัปเกรด
      await v2.upsertDraft(
        sku: 'SKU-1',
        name: 'สินค้า SKU-1',
        warehouseCode: 'WHFG',
        systemQtyShown: 100,
        countedQty: 98,
        enteredBy: '52210',
      );
      expect((await v2.allDrafts()).single.countedQty, 98);
    });
  });
}
