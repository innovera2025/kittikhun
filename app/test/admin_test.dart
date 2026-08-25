import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/core/theme/tcl_tokens.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/data/stock_repository.dart';
import 'package:tcl_stock/features/admin/admin_screen.dart';
import 'package:tcl_stock/state/app_state.dart';

/// เทสต์จอผู้ดูแลรอบนับ
///
/// จอนี้เป็นจอเดียวที่ **เปลี่ยนสถานะระดับรอบ** (เปิด/ปิด/ตัดสิน) ความผิดพลาด
/// ที่นี่ทำให้ตัวเลขสต็อกทั้งคลังผิด เทสต์จึงเน้นกฎที่ห้ามพัง:
///   - null (ยังไม่นับ / นอกรายการ) ต้องไม่ถูกอ่านเป็น 0
///   - สถานะที่แอปไม่รู้จักต้องไม่เดาเป็น 'ตรงกับระบบ'
///   - ตัวเลือกของ conflict ต้องมีคีย์ต่างกันและระบุค่าที่ระบบใช้อยู่ได้
///   - ไม่มี backend → จอบอกตรง ๆ ไม่แสดงปุ่มที่กดแล้วพัง
///
/// กฎ "ปิดรอบไม่ได้ถ้ายังมี conflict ค้าง" บังคับที่ server และมีเทสต์อยู่ใน
/// `server/test/count-cycle.spec.ts` — ฝั่งแอปเป็นแค่การซ่อนปุ่มไว้ล่วงหน้า

const _wh = 'WH01';

ActiveSession _session({bool stale = false, int rows = 3}) => ActiveSession(
      id: 'CS-TEST-1',
      voucherNo: 'CC-2408',
      zone: 'A-01',
      warehouseCode: _wh,
      openedAt: DateTime(2026, 8, 19, 8),
      staleCache: stale,
      rows: List.generate(
        rows,
        (i) => CountRow(
          sku: 'SKU-$i',
          name: 'สินค้า $i',
          systemQty: 10,
          unit: 'ชิ้น',
          warehouse: _wh,
        ),
      ),
    );

ConflictRow _conflict({bool resolved = false}) => ConflictRow(
      sku: 'A-001',
      name: 'น็อต 3 นิ้ว',
      frozenOnHand: 100,
      unit: 'ชิ้น',
      deviceCount: 2,
      submissionCount: 2,
      resolved: resolved,
      resolvedBy: resolved ? '52104' : null,
      chosenSubmission: resolved ? 'sub-a' : null,
      submissions: [
        ConflictSubmission(
          idempotencyKey: 'sub-a',
          empId: '52105',
          deviceId: 'dev-A',
          deviceSeq: 1,
          countedQty: 98,
          countedAt: DateTime(2026, 8, 19, 9, 30),
          isLatest: false,
        ),
        ConflictSubmission(
          idempotencyKey: 'sub-b',
          empId: '52106',
          deviceId: 'dev-B',
          deviceSeq: 1,
          countedQty: 95,
          countedAt: DateTime(2026, 8, 19, 9, 45),
          isLatest: true,
        ),
      ],
    );

/// ครอบจอด้วย MaterialApp + ธีมมืดเหมือน shell จริง
Widget _host(Widget child) => ProviderScope(
      child: MaterialApp(
        home: Scaffold(
          backgroundColor: TclTokens.canvasBg,
          body: child,
        ),
      ),
    );

void main() {
  group('AdminView — ป้ายมุมมองเป็นภาษาไทยครบ', () {
    test('3 มุมมองตามลำดับการใช้งานจริง', () {
      expect(
        AdminView.values.map((v) => v.label).toList(),
        ['รอบนับ', 'ขัดแย้ง', 'ส่วนต่าง'],
      );
    });
  });

  group('ShowAdmin — จอชั่วคราวเหมือน pending-review', () {
    test('ค่าเริ่มต้นคือปิด · เปิด/ปิดได้', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(container.read(showAdminProvider), isFalse);
      container.read(showAdminProvider.notifier).show();
      expect(container.read(showAdminProvider), isTrue);
      container.read(showAdminProvider.notifier).hide();
      expect(container.read(showAdminProvider), isFalse);
    });
  });

  group('รายงานส่วนต่าง — null ห้ามกลายเป็น 0', () {
    test('VarianceRow ยังไม่ได้นับ → countedQty/diff เป็น null', () {
      const row = VarianceRow(
        sku: 'A-001',
        status: VarianceRow.statusNotCounted,
        deviceCount: 0,
        isConflict: false,
        frozenOnHand: 100,
      );
      expect(row.countedQty, isNull);
      expect(row.diff, isNull);
      expect(row.isCounted, isFalse);
      expect(row.statusLabelTh, 'ยังไม่ได้นับ');
    });

    test('นอกรายการ → ไม่มียอดระบบให้เทียบ', () {
      const row = VarianceRow(
        sku: 'A-999',
        status: VarianceRow.statusOffList,
        deviceCount: 1,
        isConflict: false,
        countedQty: 5,
      );
      expect(row.frozenOnHand, isNull);
      expect(row.diff, isNull);
      expect(row.statusLabelTh, 'นอกรายการ');
    });

    test('ขัดแย้ง → ป้ายไทยบอกชัด ไม่เดาเป็นตรงกับระบบ', () {
      const row = VarianceRow(
        sku: 'A-001',
        status: VarianceRow.statusConflict,
        deviceCount: 2,
        isConflict: true,
        frozenOnHand: 100,
      );
      expect(row.statusLabelTh, 'ขัดแย้ง');
    });

    test('สถานะที่ไม่รู้จัก → ไม่เดาเป็น "ตรงกับระบบ"', () {
      const row = VarianceRow(
        sku: 'A-001',
        status: 'สถานะใหม่ที่แอปยังไม่รู้จัก',
        deviceCount: 0,
        isConflict: false,
      );
      expect(row.statusLabelTh, 'ไม่ทราบสถานะ');
    });

    test('นับได้ 0 จริง ≠ ยังไม่ได้นับ', () {
      const counted = VarianceRow(
        sku: 'A-001',
        status: VarianceRow.statusShort,
        deviceCount: 1,
        isConflict: false,
        frozenOnHand: 100,
        countedQty: 0,
        diff: -100,
      );
      expect(counted.isCounted, isTrue);
      expect(counted.statusLabelTh, 'ขาด -100');
    });
  });

  group('ConflictRow — ข้อมูลที่ admin ต้องใช้ตัดสิน', () {
    test('ยังไม่ตัดสิน → ไม่มีผู้ตัดสินและตัวเลือกที่เลือกไว้', () {
      final row = _conflict();
      expect(row.resolved, isFalse);
      expect(row.resolvedBy, isNull);
      expect(row.chosenSubmission, isNull);
      expect(row.submissions, hasLength(2));
    });

    test('ตัวเลือกทุกตัวมี idempotencyKey ต่างกัน (ใช้เป็นคีย์ตัดสิน)', () {
      final keys = _conflict().submissions.map((s) => s.idempotencyKey).toSet();
      expect(keys, hasLength(2));
    });

    test('มีเพียงตัวเดียวที่เป็น "ค่าที่ระบบใช้อยู่"', () {
      expect(
        _conflict().submissions.where((s) => s.isLatest).length,
        1,
      );
    });

    test('ตัดสินแล้ว → บันทึกผู้ตัดสินไว้ตรวจย้อนได้', () {
      final row = _conflict(resolved: true);
      expect(row.resolved, isTrue);
      expect(row.resolvedBy, '52104');
      expect(row.chosenSubmission, 'sub-a');
    });
  });

  group('CloseSessionResult', () {
    test('อ่านค่าที่ server ตอบกลับได้ครบ', () {
      const r = CloseSessionResult(materialized: 120, conflicts: 2);
      expect(r.materialized, 120);
      expect(r.conflicts, 2);
    });
  });

  group('ActiveSession', () {
    test('รอบที่เปิดบน cache เก่าติดธง staleCache ไว้เตือน', () {
      expect(_session(stale: true).staleCache, isTrue);
      expect(_session().staleCache, isFalse);
    });

    test('id เป็นคีย์จริงของรอบ ไม่ใช่ voucherNo ที่ซ้ำได้', () {
      final s = _session();
      expect(s.id, 'CS-TEST-1');
      expect(s.voucherNo, isNot(s.id));
    });

    test('จำนวนแถวที่ freeze อ่านได้จาก rows', () {
      expect(_session(rows: 5).rows, hasLength(5));
    });
  });

  group('จอผู้ดูแล — โหมดไม่มี backend', () {
    testWidgets('ไม่ได้ตั้ง API_BASE_URL → บอกตรง ๆ ว่าเป็นโหมดดูตัวอย่าง',
        (tester) async {
      await tester.pumpWidget(_host(const AdminScreen()));
      await tester.pump();

      // ผู้ใช้ fixture เป็น admin และเทสต์รันโดยไม่มี API_BASE_URL
      expect(find.text('โหมดดูตัวอย่าง UI'), findsOneWidget);
    });

    testWidgets('ไม่มีปุ่มเปิด/ปิดรอบให้กดในโหมดดูตัวอย่าง', (tester) async {
      await tester.pumpWidget(_host(const AdminScreen()));
      await tester.pump();

      expect(find.text('เปิดรอบนับ'), findsNothing);
      expect(find.text('ปิดรอบนับ'), findsNothing);
    });
  });

  group('AppState — ทางเข้าจอผู้ดูแล', () {
    test('ผู้ใช้เริ่มต้นเป็นผู้ดูแล จึงเห็นปุ่มจัดการรอบนับ', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(appProvider).me.role.isAdmin, isTrue);
    });
  });
}
