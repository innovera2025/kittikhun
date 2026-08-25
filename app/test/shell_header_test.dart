import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/data/fixtures.dart';
import 'package:tcl_stock/data/stock_repository.dart';
import 'package:tcl_stock/features/shell/app_shell.dart';
import 'package:tcl_stock/state/app_state.dart';

/// หัวจอเคยอ่านจาก `Fixtures.heads` ตรง ๆ ซึ่งฝัง 'WH-BKK-02' และ 'CC-2408'
/// ไว้ตายตัว → แอปที่ต่อคลัง WHFG จริงยังขึ้นชื่อคลังตัวอย่าง
/// พนักงานอ่านหัวจอเพื่อยืนยันว่ากำลังนับคลังไหน ผิดคลัง = นับผิดทั้งรอบ
void main() {
  ActiveSession session({
    String warehouse = 'WHFG',
    String? voucherNo,
    String id = 'CS-20260824T075509-8d76',
  }) =>
      ActiveSession(
        id: id,
        warehouseCode: warehouse,
        openedAt: DateTime(2026, 8, 24, 7, 55),
        rows: const [],
        voucherNo: voucherNo,
      );

  group('หัวจอต้องบอกคลังและรอบนับจริง', () {
    test('⭐ ล็อกอินเข้าคลัง WHFG → ห้ามขึ้นคลังตัวอย่าง', () {
      const state = AppState(signedIn: true, warehouseCode: 'WHFG');
      expect(headForTest(state).$1, 'คลัง WHFG');
      expect(headForTest(state).$1, isNot(contains(Fixtures.warehouseCode)));
    });

    test('รอบนับที่เปิดอยู่ชนะโปรไฟล์ผู้ใช้', () {
      final state = AppState(
        signedIn: true,
        warehouseCode: 'WHFG',
        session: session(warehouse: 'WHRM'),
      );
      expect(headForTest(state).$1, 'คลัง WHRM');
    });

    test('แท็บนับสต็อก — มีรอบเปิดอยู่ ใช้เลขเอกสารจริง', () {
      final state = AppState(
        signedIn: true,
        tab: AppTab.count,
        session: session(voucherNo: 'CC-2609'),
      );
      expect(headForTest(state).$1, 'รอบตรวจนับ CC-2609');
    });

    test('เลขเอกสารว่าง → ใช้ id ของรอบซึ่งเป็นคีย์จริง', () {
      final state = AppState(
        signedIn: true,
        tab: AppTab.count,
        session: session(voucherNo: '   '),
      );
      expect(headForTest(state).$1, contains('CS-20260824T075509-8d76'));
    });

    test('⭐ ไม่มีรอบเปิดอยู่ → ห้ามขึ้นเลขรอบตัวอย่างให้เข้าใจผิดว่ามีรอบ', () {
      const state = AppState(signedIn: true, tab: AppTab.count);
      expect(headForTest(state).$1, 'ยังไม่เปิดรอบนับ');
      expect(headForTest(state).$1, isNot(contains(Fixtures.sessionVoucherNo)));
    });

    test('โหมดไม่มี backend ยังใช้ค่าตัวอย่างได้ตามเดิม', () {
      const state = AppState(signedIn: true);
      expect(headForTest(state).$1, 'คลัง ${Fixtures.warehouseCode}');
    });
  });
}
