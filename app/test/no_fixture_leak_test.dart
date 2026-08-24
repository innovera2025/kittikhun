import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kittikhun_stock/data/api_client.dart';
import 'package:kittikhun_stock/data/fixtures.dart';
import 'package:kittikhun_stock/state/app_state.dart';

/// กฎ: ต่อ backend จริงแล้ว **ห้าม** มีข้อมูลตัวอย่างหลุดขึ้นจอ
///
/// เคสจริงที่เจอบนเครื่อง (24 ส.ค. 2569): แท็บนับสต็อกขึ้น SKU-40128 / SKU-77340
/// ทั้งที่ยังไม่มีรอบนับเปิดอยู่ พนักงานกรอกจำนวนแล้วกดส่งได้ — นับของที่ไม่มีจริง
///
/// เทสต์ชุดนี้รันในโหมด "ไม่มี backend" ได้อย่างเดียว จึงยืนยันฝั่งตรงข้าม:
/// ข้อมูลตัวอย่างต้องยังใช้ได้ตามเดิม และตัวคุมเงื่อนไขคือ ApiConfig.isConfigured
void main() {
  late ProviderContainer container;
  AppController ctl() => container.read(appProvider.notifier);

  setUp(() => container = ProviderContainer());
  tearDown(() => container.dispose());

  test('เทสต์ชุดนี้รันในโหมดไม่มี backend', () {
    expect(ApiConfig.isConfigured, isFalse);
  });

  group('โหมดไม่มี backend — ข้อมูลตัวอย่างต้องยังทำงาน', () {
    test('ไม่มีรอบนับ → ใช้รายการตัวอย่างได้', () {
      expect(ctl().countRows(), isNotEmpty);
    });

    test('ค้นหาด้วยคำว่าง → คืนรายการตัวอย่างทั้งหมด', () {
      expect(ctl().searchResults().length, Fixtures.items.length);
    });

    test('itemFor หาสินค้าตัวอย่างเจอ', () {
      expect(ctl().itemFor(Fixtures.items.first.sku), isNotNull);
    });
  });

  group('ตัวนับความคืบหน้าต้องผูกกับรอบจริง', () {
    test('⭐ ไม่มีรอบนับเปิดอยู่ → นับแล้ว 0 เสมอ แม้มีค่าค้างอยู่ใน counts', () {
      const state = AppState(
        signedIn: true,
        counts: {'SKU-40128': '99'},
      );
      expect(
        state.countedRows,
        0,
        reason: 'เดิมนับจาก Fixtures.countRows ทำให้ตัวเลขขึ้นทั้งที่ไม่มีรอบ',
      );
    });
  });
}
