import 'models.dart';

/// ข้อมูลตัวอย่าง canonical จาก design ต้นแบบ (`Stock Scan Mobile.dc.html`)
///
/// ใช้สำหรับ: พัฒนา UI แบบตรง design ก่อนต่อ backend · demo · golden tests
/// ตรงกับ `ERP_DRIVER=mock` ฝั่ง backend
class Fixtures {
  const Fixtures._();

  static const List<Item> items = [
    Item(
      sku: 'SKU-40128',
      barcodes: ['8851234567890'],
      name: 'สลักเกลียวหัวหกเหลี่ยม M12',
      nameEn: 'Hex bolt M12 × 60 mm, zinc',
      loc: 'A-04-12',
      onHand: 1240,
      reserved: 180,
      rop: 400,
      unit: 'ชิ้น',
      updated: 'วันนี้ 09:42',
      vendor: 'Siam Fastener Co.',
      lot: 'LOT-24C-118',
      lastCountDate: '12 ส.ค. 2569',
    ),
    Item(
      sku: 'SKU-77340',
      barcodes: ['8859900112233'],
      name: 'เทปพันสายไฟ PVC 19 มม.',
      nameEn: 'PVC insulation tape 19 mm',
      loc: 'C-01-08',
      onHand: 86,
      reserved: 60,
      rop: 120,
      unit: 'ม้วน',
      updated: 'วันนี้ 08:15',
      vendor: 'Thai Poly Tape',
      lot: 'LOT-24A-902',
      lastCountDate: '02 ส.ค. 2569',
    ),
    Item(
      sku: 'SKU-11902',
      barcodes: ['8850001456712'],
      name: 'ถุงมือหนังนิรภัย เบอร์ 9',
      nameEn: 'Leather safety gloves, size 9',
      loc: 'B-07-03',
      onHand: 0,
      reserved: 0,
      rop: 50,
      unit: 'คู่',
      updated: 'เมื่อวาน 17:20',
      vendor: 'Protex Industrial',
      lot: '—',
      lastCountDate: '28 ก.ค. 2569',
    ),
    Item(
      sku: 'SKU-63015',
      barcodes: ['8851777090412'],
      name: 'น้ำมันหล่อลื่นเกียร์ 20 ลิตร',
      nameEn: 'Gear oil, 20 L drum',
      loc: 'D-02-01',
      onHand: 34,
      reserved: 6,
      rop: 10,
      unit: 'ถัง',
      updated: 'วันนี้ 07:55',
      vendor: 'PTT Lubricants',
      lot: 'LOT-24B-441',
      lastCountDate: '09 ส.ค. 2569',
    ),
    Item(
      sku: 'SKU-20887',
      barcodes: ['8853344556677'],
      name: 'แผ่นตัดเหล็ก 4 นิ้ว',
      nameEn: 'Steel cutting disc 4"',
      loc: 'A-09-05',
      onHand: 512,
      reserved: 24,
      rop: 150,
      unit: 'แผ่น',
      updated: 'วันนี้ 09:10',
      vendor: 'Nippon Abrasive',
      lot: 'LOT-24C-077',
      lastCountDate: '05 ส.ค. 2569',
    ),
  ];

  static const List<Member> members = [
    Member(name: 'Tcl S.', empId: '52104', shift: 'กะเช้า · A', role: Role.admin),
    Member(name: 'ปิยะนุช ศรีทอง', empId: '52210', shift: 'กะเช้า · A', role: Role.staff),
    Member(name: 'ธนากร แสงทวี', empId: '52318', shift: 'กะบ่าย · B', role: Role.staff),
    Member(name: 'Nattaporn K.', empId: '52402', shift: 'สำนักงาน', role: Role.viewer),
  ];

  /// รอบนับตัวอย่าง — 4 รายการแรกตาม design (โซน A · CC-2408)
  static const String sessionVoucherNo = 'CC-2408';
  static const String sessionZone = 'A';
  static const String warehouseCode = 'WH-BKK-02';
  static const String appVersion = 'v4.0';

  static List<CountRow> get countRows => items
      .take(4)
      .map((i) => CountRow(
            sku: i.sku,
            name: i.name,
            systemQty: i.onHand ?? 0,
            unit: i.unit,
            loc: i.loc,
          ))
      .toList();

  /// หัวเรื่องต่อแท็บ (kicker, title) — ตรงตาม HEADS map ใน design
  static const Map<AppTab, (String, String)> heads = {
    AppTab.scan: ('คลัง $warehouseCode', 'สแกนบาร์โค้ด'),
    AppTab.search: ('คลัง $warehouseCode', 'ค้นหาสินค้า'),
    AppTab.count: ('รายการที่คีย์ไว้', 'รอส่งเข้า ERP'),
    AppTab.team: ('คลัง $warehouseCode', 'สมาชิกและสิทธิ์'),
  };
}

/// แท็บล่าง 4 ช่องตาม design
enum AppTab {
  scan('สแกน'),
  search('ค้นหา'),
  count('รอส่ง'),
  team('สมาชิก');

  const AppTab(this.label);
  final String label;
}
