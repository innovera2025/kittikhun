import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kittikhun_stock/data/models.dart';
import 'package:kittikhun_stock/main.dart';
import 'package:kittikhun_stock/state/app_state.dart';

void main() {
  group('Variance — ข้อความส่วนต่างต้องตรงตัวอักษรกับ design', () {
    test('ยังไม่กรอก → ยังไม่ได้นับ', () {
      final v = Variance.from(entered: '', systemQty: 100);
      expect(v.label, 'ยังไม่ได้นับ');
      expect(v.isCounted, isFalse);
    });

    test('ตรงกัน → ตรงกับระบบ', () {
      final v = Variance.from(entered: '100', systemQty: 100);
      expect(v.label, 'ตรงกับระบบ');
      expect(v.isMatch, isTrue);
    });

    test('นับได้มากกว่า → เกิน +n', () {
      expect(Variance.from(entered: '108', systemQty: 100).label, 'เกิน +8');
    });

    test('นับได้น้อยกว่า → ขาด -n (ตัวเลขติดลบในตัว)', () {
      expect(Variance.from(entered: '97', systemQty: 100).label, 'ขาด -3');
    });
  });

  group('สถานะสต็อก', () {
    test('ยอด 0 หรือติดลบ → หมดสต็อก', () {
      expect(Variance.from(entered: '0', systemQty: 0).isMatch, isTrue);
    });
  });

  group('Member.initials — grapheme-safe กับชื่อไทย', () {
    test('ชื่อไทยสองคำ', () {
      const m = Member(
        name: 'ปิยะนุช ศรีทอง',
        empId: '52210',
        shift: 'กะเช้า · A',
        role: Role.staff,
      );
      expect(m.initials, 'ปศ');
    });

    test('ชื่อคำเดียวไม่มีช่องว่างต่อท้าย', () {
      const m = Member(name: 'สมชาย', empId: '1', shift: '-', role: Role.staff);
      expect(m.initials, 'ส');
    });
  });

  group('Role', () {
    test('วนสิทธิ์ admin → staff → viewer → admin', () {
      expect(Role.admin.next, Role.staff);
      expect(Role.staff.next, Role.viewer);
      expect(Role.viewer.next, Role.admin);
    });

    test('viewer เขียนไม่ได้', () {
      expect(Role.viewer.canWrite, isFalse);
      expect(Role.staff.canWrite, isTrue);
    });
  });

  group('AppController — พฤติกรรม login ตาม design', () {
    late ProviderContainer container;

    setUp(() => container = ProviderContainer());
    tearDown(() => container.dispose());

    test('รหัสพนักงานไม่มีในระบบ → ข้อความตรงตาม design', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('99999');
      await c.signIn();
      final s = container.read(appProvider);
      expect(s.signedIn, isFalse);
      expect(s.loginError, isTrue);
      expect(s.loginMessage, 'ไม่พบรหัสพนักงานนี้ · unknown employee ID');
    });

    test('PIN ว่างต้องถูกปฏิเสธ (ต่างจาก demo ที่ยอมให้ผ่าน)', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('52104');
      await c.signIn();
      expect(container.read(appProvider).signedIn, isFalse);
    });

    test('รหัสถูกและ PIN ครบ 6 หลัก → เข้าสู่ระบบได้', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('52104');
      for (final k in ['1', '2', '3', '4', '5', '6']) {
        c.pressKey(k);
      }
      await c.signIn();
      final s = container.read(appProvider);
      expect(s.signedIn, isTrue);
      expect(s.me.empId, '52104');
    });

    test('keypad: C ล้าง · ⌫ ลบตัวท้าย · สูงสุด 6 หลัก', () {
      final c = container.read(appProvider.notifier);
      for (final k in ['1', '2', '3', '4', '5', '6', '7']) {
        c.pressKey(k);
      }
      expect(container.read(appProvider).pin, '123456');
      c.pressKey('⌫');
      expect(container.read(appProvider).pin, '12345');
      c.pressKey('C');
      expect(container.read(appProvider).pin, '');
    });
  });

  group('AppController — สแกน', () {
    late ProviderContainer container;

    setUp(() => container = ProviderContainer());
    tearDown(() => container.dispose());

    test('สแกนซ้ำรายการเดิม → เด้งขึ้นบนสุด ไม่เพิ่มซ้ำ', () {
      final c = container.read(appProvider.notifier);
      c.addScan('SKU-40128');
      c.addScan('SKU-77340');
      c.addScan('SKU-40128');
      final scans = container.read(appProvider).scans;
      expect(scans.length, 2);
      expect(scans.first.sku, 'SKU-40128');
    });

    test('บาร์โค้ดที่ไม่มีในคลัง → คืน false', () {
      final c = container.read(appProvider.notifier);
      expect(c.resolveCode('0000000000000'), isFalse);
    });

    test('สแกน ItemCode (Code128) ได้เหมือนบาร์โค้ด EAN-13', () {
      final c = container.read(appProvider.notifier);
      expect(c.resolveCode('SKU-40128'), isTrue);
      expect(c.resolveCode('8851234567890'), isTrue);
    });
  });

  group('AppController — สิทธิ์', () {
    late ProviderContainer container;

    setUp(() => container = ProviderContainer());
    tearDown(() => container.dispose());

    Future<void> signInAs(String empId) async {
      final c = container.read(appProvider.notifier);
      c.setEmpId(empId);
      for (final k in ['0', '0', '0', '0', '0', '0']) {
        c.pressKey(k);
      }
      await c.signIn();
    }

    test('viewer ส่งผลการนับไม่ได้', () async {
      await signInAs('52402'); // Nattaporn K. = viewer
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '10');
      c.submitCount();
      expect(container.read(appProvider).toast, 'สิทธิ์ viewer นับสต็อกไม่ได้');
    });

    test('ไม่ใช่ admin แก้สิทธิ์คนอื่นไม่ได้', () async {
      await signInAs('52210'); // staff
      await container.read(appProvider.notifier).cycleRole(1);
      expect(
        container.read(appProvider).toast,
        'ต้องมีสิทธิ์ผู้ดูแลเพื่อแก้ไขสิทธิ์',
      );
    });

    test('กันลดสิทธิ์จนไม่มี admin เหลือ', () async {
      await signInAs('52104'); // admin คนเดียวใน fixture
      await container.read(appProvider.notifier).cycleRole(0);
      expect(container.read(appProvider).toast, 'ต้องมีผู้ดูแลอย่างน้อย 1 คน');
      expect(container.read(appProvider).members[0].role, Role.admin);
    });
  });

  group('AppController — นับสต็อก', () {
    late ProviderContainer container;

    setUp(() => container = ProviderContainer());
    tearDown(() => container.dispose());

    test('กรอกได้เฉพาะตัวเลข', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '12a3ข');
      expect(container.read(appProvider).counts['SKU-40128'], '123');
    });

    test('ลดค่าไม่ต่ำกว่า 0', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '0');
      c.decCount('SKU-40128');
      expect(container.read(appProvider).counts['SKU-40128'], '0');
    });
  });

  testWidgets('แอปเปิดขึ้นมาที่หน้า Login และแสดงแบรนด์ KITTIKHUN',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: KittikhunApp()));
    await tester.pump();
    expect(find.text('KITTIKHUN'), findsOneWidget);
    expect(find.text('เข้าสู่ระบบ'), findsWidgets);
  });
}
