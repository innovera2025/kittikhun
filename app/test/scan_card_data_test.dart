import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/data/fixtures.dart';
import 'package:tcl_stock/data/models.dart';
import 'package:tcl_stock/state/app_state.dart';

/// การ์ดสแกนเคยค้นสินค้าจาก `Fixtures.items` ตรง ๆ → รหัสจริงจาก ERP
/// (เช่น 2010201) ไม่มีในข้อมูลตัวอย่าง การ์ดจึงคืนกล่องเปล่า
/// ผลคือตัวนับขึ้น "สแกนแล้ว 1 รายการ" แต่จอว่าง — ของหายต่อหน้าพนักงาน
void main() {
  const erpSku = '2010201';

  Item erpItem() => const Item(
        sku: erpSku,
        name: 'สินค้าจาก ERP จริง',
        unit: 'ชิ้น',
        onHand: 73,
      );

  late ProviderContainer container;
  AppController ctl() => container.read(appProvider.notifier);

  setUp(() => container = ProviderContainer());
  tearDown(() => container.dispose());

  group('การ์ดสแกนต้องหาข้อมูลสินค้าจริงเจอ', () {
    test('⭐ รหัสจาก ERP ที่ไม่มีในข้อมูลตัวอย่าง ต้องหาเจอผ่าน itemFor', () {
      expect(
        Fixtures.items.where((i) => i.sku == erpSku),
        isEmpty,
        reason: 'ตั้งใจใช้รหัสที่ไม่มีในข้อมูลตัวอย่าง เพื่อจำลองของจริงจาก ERP',
      );

      ctl().rememberScannedItem(erpItem());
      expect(ctl().itemFor(erpSku)?.name, 'สินค้าจาก ERP จริง');
    });

    test('ไม่มีทั้งใน replica และตัวอย่าง → คืน null (การ์ดซ่อนตัวเอง)', () {
      expect(ctl().itemFor('ไม่มีรหัสนี้'), isNull);
    });

    test('⭐ แตะผลค้นหาแล้วเข้าการ์ดสแกน ต้องพาข้อมูลสินค้าไปด้วย', () {
      ctl().setSearchHits([erpItem()]);
      ctl().openFromSearch(erpSku);

      expect(ctl().itemFor(erpSku)?.onHand, 73);
      expect(container.read(appProvider).tab, AppTab.scan);
      expect(container.read(appProvider).expandedSku, erpSku);
    });

    test('ข้อมูลตัวอย่างยังใช้ได้ตามเดิมในโหมดไม่มี backend', () {
      final sample = Fixtures.items.first.sku;
      expect(ctl().itemFor(sample), isNotNull);
    });
  });
}
