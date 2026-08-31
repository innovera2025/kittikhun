import 'package:flutter/services.dart';

/// รวมคีย์จากเครื่องยิงบาร์โค้ด (handheld) ให้กลายเป็น "รหัสเดียว"
///
/// เครื่องยิงเกือบทุกรุ่นทำตัวเป็นคีย์บอร์ด (HID keyboard-wedge): ยิงหนึ่งครั้ง =
/// พิมพ์อักขระรหัสรัว ๆ แล้วปิดท้ายด้วย Enter — ไม่ใช่เหตุการณ์ "สแกน" ที่ Flutter
/// รู้จัก เราจึงต้องรวมคีย์เอง แล้วตัดสินว่าจบรหัสเมื่อเจอ Enter
///
/// แยกออกมาเป็นคลาสล้วน ๆ (ไม่พึ่ง widget) เพื่อให้เขียนเทสต์ครอบพฤติกรรมได้ตรง ๆ
/// โดยไม่ต้อง pump ทั้งจอ และเพื่อให้ **เวลา** ถูกส่งเข้ามาจากผู้เรียก ไม่ใช่อ่าน
/// นาฬิกาเอง — เทสต์จึงคุมจังหวะได้ 100%
class HandheldScanBuffer {
  HandheldScanBuffer({
    this.idleReset = const Duration(milliseconds: 800),
    this.maxLength = 64,
  });

  /// เว้นนานกว่านี้ = ถือว่าอักขระที่ค้างอยู่เป็นเศษของการยิงครั้งก่อนที่ไม่จบ
  ///
  /// เครื่องยิงส่งอักขระห่างกันระดับสิบมิลลิวินาที ส่วนคนพิมพ์ช้ากว่านั้นมาก
  /// ถ้าไม่มีด่านนี้ เศษที่ค้างจะไปเกาะหน้ารหัสของครั้งถัดไป → ค้นไม่เจอทั้งที่ยิงถูก
  final Duration idleReset;

  /// กันบัฟเฟอร์บวมเมื่อมีอะไรพิมพ์รัวเข้ามาโดยไม่มี Enter สักที
  /// บาร์โค้ดจริงยาวไม่เกินนี้ (EAN-13 = 13 · Code128 ทั่วไป < 30)
  final int maxLength;

  final StringBuffer _chars = StringBuffer();
  DateTime? _lastAt;

  /// อักขระที่ค้างอยู่ตอนนี้ — มีไว้ให้เทสต์และ debug ตรวจสถานะ
  String get pending => _chars.toString();

  /// ป้อนหนึ่งเหตุการณ์คีย์ · คืน **รหัสที่จบแล้ว** เมื่อเจอ Enter · `null` = ยังไม่จบ
  ///
  /// [now] ส่งเข้ามาจากผู้เรียกเสมอ (ดูเหตุผลที่หัวคลาส)
  String? feed(KeyEvent event, {required DateTime now}) {
    // สนใจเฉพาะตอนกดลง — KeyUpEvent/KeyRepeatEvent จะทำให้ได้อักขระซ้ำสองเท่า
    if (event is! KeyDownEvent) return null;

    final last = _lastAt;
    if (last != null && now.difference(last) > idleReset) _chars.clear();
    _lastAt = now;

    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) {
      final code = _chars.toString().trim();
      _chars.clear();
      return code.isEmpty ? null : code;
    }

    // อักขระพิมพ์ได้เท่านั้น — ตัด modifier/ลูกศร/ฟังก์ชันคีย์ที่ character เป็น null
    // และตัดอักขระควบคุม (< 0x20) ที่บางรุ่นแทรกมาเป็น prefix/suffix
    final ch = event.character;
    if (ch == null || ch.length != 1) return null;
    if (ch.codeUnitAt(0) < 0x20) return null;

    if (_chars.length >= maxLength) _chars.clear();
    _chars.write(ch);
    return null;
  }

  /// ทิ้งอักขระที่ค้าง — เรียกเมื่อออกจากจอหรือสลับโหมด
  void reset() {
    _chars.clear();
    _lastAt = null;
  }
}
