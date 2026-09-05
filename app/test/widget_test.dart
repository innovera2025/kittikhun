import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/core/theme/tcl_tokens.dart';
import 'package:tcl_stock/core/widgets/common.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/local/local_db.dart';
import 'package:tcl_stock/main.dart';
import 'package:tcl_stock/state/app_state.dart';

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

    test('signed — เครื่องหมายบนการ์ด (นับได้ − ยอดระบบ)', () {
      expect(Variance.from(entered: '19', systemQty: 20).signed, '-1');
      expect(Variance.from(entered: '21', systemQty: 20).signed, '+1');
      expect(Variance.from(entered: '20', systemQty: 20).signed, '0');
      expect(Variance.from(entered: '', systemQty: 20).signed, '—');
      expect(Variance.notCounted.signed, '—');
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
    late LocalDb db;
    late ProviderContainer container;

    // sign-in อ่านโหมดสแกนจาก KvMeta ทั้งโหมด fixture และโหมดต่อ backend
    // (ดู `_loadScanPrefs`) — เทสต์จึงต้องมี DB ในหน่วยความจำให้อ่าน
    setUp(() {
      db = LocalDb(NativeDatabase.memory());
      container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
    });
    tearDown(() async {
      container.dispose();
      await db.close();
    });

    test('ชื่อผู้ใช้ไม่มีในระบบ → ข้อความตรงตาม design', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('99999');
      await c.signIn();
      final s = container.read(appProvider);
      expect(s.signedIn, isFalse);
      expect(s.loginError, isTrue);
      // ⚠️ ต้องเป็นข้อความเดียวกับ AUTH_ERROR_MESSAGE_TH.UNKNOWN_EMPLOYEE ฝั่ง server
      expect(s.loginMessage, 'ไม่พบชื่อผู้ใช้นี้ · unknown user');
    });

    test('รหัสผ่านว่างต้องถูกปฏิเสธ (ต่างจาก demo ที่ยอมให้ผ่าน)', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('52104');
      await c.signIn();
      final s = container.read(appProvider);
      expect(s.signedIn, isFalse);
      expect(s.loginError, isTrue);
      expect(s.loginMessage, 'กรอกรหัสผ่านก่อนเข้าสู่ระบบ');
    });

    test('ชื่อผู้ใช้ถูกและมีรหัสผ่าน → เข้าสู่ระบบได้', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('52104');
      c.setPassword('123456');
      await c.signIn();
      final s = container.read(appProvider);
      expect(s.signedIn, isTrue);
      expect(s.me.empId, '52104');
    });

    test('⭐ รหัสผ่าน ERP ที่ไม่ใช่ 6 หลัก เข้าได้ — ความยาวไม่ใช่ด่านของแอปอีกต่อไป', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('52104');
      c.setPassword('ปลาทอง-2569!Warehouse');
      await c.signIn();
      expect(container.read(appProvider).signedIn, isTrue);
    });

    test('⭐ รหัสผ่านเก็บดิบ ไม่ถูก trim — ERP เทียบ string เป๊ะ ช่องว่างท้ายมีความหมาย', () {
      final c = container.read(appProvider.notifier);
      c.setPassword('  รหัส ผ่าน  ');
      expect(container.read(appProvider).pin, '  รหัส ผ่าน  ');
    });

    test('ชื่อผู้ใช้ถูก trim หัวท้าย แต่ไม่ถูกกรองอักขระ (ชื่อ ERP ไม่รู้รูปแบบล่วงหน้า)', () {
      final c = container.read(appProvider.notifier);
      c.setEmpId('  somchai.p  ');
      expect(container.read(appProvider).empId, 'somchai.p');
    });

    test('พิมพ์ต่อหลังถูกปฏิเสธ → ล้างสถานะ error ทั้งสองช่อง', () async {
      final c = container.read(appProvider.notifier);
      c.setEmpId('99999');
      await c.signIn();
      expect(container.read(appProvider).loginError, isTrue);

      c.setPassword('x');
      expect(container.read(appProvider).loginError, isFalse);

      c.setEmpId('99999');
      await c.signIn();
      expect(container.read(appProvider).loginError, isTrue);

      c.setEmpId('5');
      expect(container.read(appProvider).loginError, isFalse);
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
    late LocalDb db;
    late ProviderContainer container;

    setUp(() {
      db = LocalDb(NativeDatabase.memory());
      container = ProviderContainer(
        overrides: [localDbProvider.overrideWithValue(db)],
      );
    });
    tearDown(() async {
      container.dispose();
      await db.close();
    });

    Future<void> signInAs(String empId) async {
      final c = container.read(appProvider.notifier);
      c.setEmpId(empId);
      c.setPassword('any-secret');
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

    test('กรอกทศนิยมได้ — จุดไม่ใช่ตัวคั่นที่ต้องทิ้ง', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '20.5');
      expect(container.read(appProvider).counts['SKU-40128'], '20.5');
    });

    test('ทศนิยมเกิน 3 ตำแหน่งถูกตัด (ตรงกับ numeric(18,3))', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '20.5555');
      expect(container.read(appProvider).counts['SKU-40128'], '20.555');
    });

    test('ยอมจุดเดียว — จุดที่เกินถูกทิ้ง', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '1.2.3');
      expect(container.read(appProvider).counts['SKU-40128'], '1.23');
    });

    test('เพิ่มค่าบนทศนิยม → บวก 1 จริง ไม่รีเซ็ตเป็น 1', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '20.5');
      c.incCount('SKU-40128');
      expect(container.read(appProvider).counts['SKU-40128'], '21.5');
    });

    test('ลดค่าบนช่องที่ยังว่าง → ยังว่าง ห้ามกลายเป็น 0', () {
      final c = container.read(appProvider.notifier);
      c.decCount('SKU-40128');
      // ว่าง = ยังไม่ได้นับ · '0' = นับแล้วได้ศูนย์ → ต้องไม่ถูกสร้างขึ้นเอง
      expect(container.read(appProvider).counts['SKU-40128'] ?? '', '');
      expect(
        Variance.from(
          entered: container.read(appProvider).counts['SKU-40128'] ?? '',
          systemQty: 20,
        ).isCounted,
        isFalse,
      );
    });

    test('ลดค่าบน 1 → 0 (ศูนย์ที่ตั้งใจ ยังต้องได้)', () {
      final c = container.read(appProvider.notifier);
      c.setCount('SKU-40128', '1');
      c.decCount('SKU-40128');
      expect(container.read(appProvider).counts['SKU-40128'], '0');
    });
  });

  group('StepperButton / CountField — ยกออกจากจอนับแล้วต้องเหมือนเดิมทุกอย่าง', () {
    testWidgets('ปุ่ม +/− ขนาด 44 · semantics ไทยเดิม · กดแล้ว callback ยิง',
        (tester) async {
      final semantics = tester.ensureSemantics();
      var inc = 0;
      var dec = 0;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Row(
            children: [
              StepperButton(glyph: '−', onTap: () => dec++),
              StepperButton(glyph: '+', onTap: () => inc++),
            ],
          ),
        ),
      ));

      // label ถูก merge กับ glyph ('เพิ่มจำนวน\n+') → เทียบแบบ contains
      expect(tester.getSemantics(find.text('+')).label, contains('เพิ่มจำนวน'));
      expect(tester.getSemantics(find.text('−')).label, contains('ลดจำนวน'));
      expect(
        tester.getSize(find.byType(StepperButton).first),
        const Size(TclTokens.hStepper, TclTokens.hStepper),
      );

      await tester.tap(find.text('+'));
      await tester.tap(find.text('−'));
      expect(inc, 1);
      expect(dec, 1);
      semantics.dispose();
    });

    testWidgets('ช่องกรอกกว้าง 88 · hint "นับได้" · onChanged ส่งค่าที่พิมพ์',
        (tester) async {
      final ctrl = TextEditingController();
      addTearDown(ctrl.dispose);
      String? typed;

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CountField(
            controller: ctrl,
            focused: false,
            onFocusChange: (_) {},
            onChanged: (v) => typed = v,
          ),
        ),
      ));

      expect(find.text('นับได้'), findsOneWidget);
      expect(tester.getSize(find.byType(CountField)).width, 88);

      await tester.enterText(find.byType(TextField), '20.5');
      expect(typed, '20.5');
    });
  });

  testWidgets('แอปเปิดขึ้นมาที่หน้า Login และแสดงแบรนด์ TCL',
      (tester) async {
    await tester.pumpWidget(const ProviderScope(child: TclApp()));
    await tester.pump();
    expect(find.text('TCL'), findsOneWidget);
    expect(find.text('เข้าสู่ระบบ'), findsWidgets);
  });
}
