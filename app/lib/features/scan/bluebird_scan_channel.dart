import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// รับบาร์โค้ดจาก **intent broadcast** ของ Bluebird BBAPI (ฝั่ง Dart)
///
/// คู่ของ `MainActivity.kt` — อ่านเหตุผลทั้งหมดของเส้นทางนี้ที่นั่น สรุปสั้น ๆ:
/// Bluebird S20 หน้างานถูกตั้งให้ส่งผลอ่านเป็น broadcast ไม่ใช่คีย์บอร์ด
/// เหนี่ยวไกแล้วบี๊บแต่ไม่มีคีย์เข้าแอปเลย [HandheldScanBuffer] จึงไม่มีอะไรให้ฟัง
///
/// **เส้นทางที่สอง ไม่ใช่ตัวแทน** — เครื่องที่ตั้งเป็น keyboard wedge ยังต้องยิงได้
/// เหมือนเดิม ทั้งสองทางเปิดพร้อมกันได้ (จอสแกนมีด่านดีดัพข้ามแหล่งกันฉลากใบเดียว
/// ถูกนับสองครั้ง)
///
/// ── ถอยกลับเงียบ ๆ เมื่อไม่มีฝั่ง native ──────────────────────────────
/// บน macOS · Chrome · เทสต์ · Android ที่ไม่ใช่ Bluebird จะไม่มีใครรับช่องนี้
/// คลาสนี้จึง **ไม่โยนอะไรออกไปเลย**: [start] กลืน `MissingPluginException`
/// ทิ้ง และ [barcodes] ก็แค่เป็นสตรีมที่ไม่มีอะไรไหลมาตลอดกาล — พฤติกรรมของแอป
/// เท่าเดิมเป๊ะกับก่อนมีไฟล์นี้
///
/// ⚠️ **ห้ามเปลี่ยนไปใช้ `EventChannel`** ถึงจะดูเป็นเครื่องมือที่ตรงงานกว่า:
/// `receiveBroadcastStream()` ต้องโทรหาฝั่ง native ตอนเริ่มฟัง ซึ่งบนเครื่องที่
/// ไม่มีฝั่ง native จะไม่มีใครรับสาย — วัดจริงในเทสต์แล้ว **ค้างจนหมดเวลา
/// 10 นาที** ไม่ใช่แค่โยน error ให้จับ · MethodChannel ฝั่ง native เป็นคนเรียก
/// เข้ามา เราไม่ต้องโทรออกเลยตอนติดตั้งตัวรับ จึงไม่มีสายค้าง
class BluebirdScanChannel {
  BluebirdScanChannel();

  /// ชื่อช่อง — ต้องตรงกับ `MainActivity.CHANNEL` เป๊ะ ๆ
  ///
  /// เปิดเป็น public เพื่อให้เทสต์ปลอม **ฝั่ง native** ได้ด้วยชื่อเดียวกันนี้
  /// (ส่งข้อความขาเข้าผ่าน binary messenger เหมือนที่เอนจิน Android ทำจริง)
  /// — จงใจไม่รับ `MethodChannel` เข้าทางคอนสตรัคเตอร์: การฉีดตัวปลอมเข้ามา
  /// จะทดสอบ "ช่องที่ไม่มีวันมีอยู่จริง" แทนที่จะทดสอบช่องที่แอปใช้จริง
  static const String channelName = 'tcl/bluebird_scan';

  /// เมธอดที่ฝั่ง native เรียกเข้ามาเมื่ออ่านฉลากได้หนึ่งใบ
  static const String _onBarcode = 'barcode';

  final MethodChannel _channel = const MethodChannel(channelName);
  final StreamController<String> _codes = StreamController<String>.broadcast();

  /// กำลังฟังอยู่หรือไม่ — กันสั่ง native ซ้ำเมื่อจอเรียก [start] สองรอบ
  bool _listening = false;

  /// ตัวที่ "ถือ" ช่องอยู่ตอนนี้ — ต้องเป็น static เพราะช่องเป็นของ**ทั้งโปรเซส**
  ///
  /// `setMethodCallHandler` มีสล็อตเดียวต่อชื่อช่อง ใครตั้งทีหลังทับคนก่อนเสมอ
  /// และ Flutter **สร้าง State ตัวใหม่ก่อนถอดตัวเก่าเสมอ** (`inflateWidget` มาก่อน
  /// `unmount` ในเฟรมเดียวกัน) ลำดับจริงตอนจอถูกสร้างใหม่จึงเป็น
  /// `ใหม่.start()` → `เก่า.stop()` · ถ้า `stop()` ล้างสล็อตกับสั่ง native ดื้อ ๆ
  /// จอใหม่ที่เพิ่งต่อสายเสร็จจะถูกจอเก่าตัดหูทิ้ง — **หูหนวกเงียบ ๆ** ยิงแล้วไม่มี
  /// อะไรเกิดขึ้น เหมือนบั๊กเดิมเป๊ะและหาสาเหตุยากกว่าเดิม
  ///
  /// กติกาจึงเป็น: **ถอนได้เฉพาะคนที่ยังถืออยู่จริง** ตัวที่ถูกแทนที่ไปแล้วเงียบ ๆ
  static BluebirdScanChannel? _owner;

  /// รหัสที่อ่านได้ ถูก trim แล้วและไม่มีสตริงว่าง
  ///
  /// broadcast stream: จอสแกนคือผู้ฟังเดียวในวันนี้ แต่การเป็น broadcast ทำให้
  /// การไม่มีผู้ฟัง (ระหว่างสลับแท็บ) ไม่ทำให้รหัสไปกองค้างในคิว
  Stream<String> get barcodes => _codes.stream;

  /// เริ่มฟัง — จอสแกนเรียกตอนเกิด และตอนแอปกลับมาอยู่หน้าจอ
  ///
  /// ติดตั้งตัวรับฝั่ง Dart **ก่อน** สั่ง native เสมอ: ถ้าสั่งก่อน ผลอ่านใบแรก
  /// อาจวิ่งกลับมาถึงตอนที่ยังไม่มีใครรับ แล้วหายไปเงียบ ๆ
  void start() {
    if (_listening) return;
    _listening = true;
    _owner = this;
    _channel.setMethodCallHandler(_onCall);
    unawaited(_invoke('startListening'));
  }

  /// หยุดฟัง — จอสแกนเรียกตอนถูกถอดทิ้ง และตอนแอปถูกพักไปเบื้องหลัง
  ///
  /// ฝั่ง native จะถอนตัวรับ broadcast ออก แต่ **ไม่ปิดโมดูลบาร์โค้ด** (เปิดใหม่
  /// กินเวลา 2-3 วินาที ไกจะรู้สึกเหมือนเสีย — เหตุผลเต็มอยู่ใน MainActivity.kt)
  ///
  /// ไม่แตะอะไรเลยถ้ามีคนอื่นถือช่องต่อไปแล้ว (ดู [_owner]) — ทั้งสล็อตฝั่ง Dart
  /// และคำสั่งฝั่ง native เพราะ `stopListening` ที่ส่งช้ากว่า `startListening`
  /// ของเจ้าของใหม่จะไปถอนตัวรับที่เขาเพิ่งลงทะเบียนไว้
  void stop() {
    if (!_listening) return;
    _listening = false;
    if (!identical(_owner, this)) return;
    _owner = null;
    _channel.setMethodCallHandler(null);
    unawaited(_invoke('stopListening'));
  }

  /// ปิดสตรีมถาวร — เรียกตอนจอถูกถอดทิ้งเท่านั้น
  void dispose() {
    stop();
    unawaited(_codes.close());
  }

  Future<void> _onCall(MethodCall call) async {
    if (call.method != _onBarcode) return;
    final raw = call.arguments;
    // ฝั่ง native trim มาให้แล้ว แต่ช่องนี้เป็นสัญญาข้ามภาษา — ตรวจซ้ำที่นี่
    // ถูกกว่าการเชื่อว่าอีกฝั่งจะไม่เปลี่ยนพฤติกรรมในอนาคต
    if (raw is! String) return;
    final code = raw.trim();
    if (code.isEmpty || _codes.isClosed) return;
    _codes.add(code);
  }

  Future<void> _invoke(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // ไม่มีฝั่ง native (macOS · Chrome · เทสต์ · Android ที่ไม่ใช่ Bluebird)
      // — เป็นเรื่องปกติ ไม่ใช่ความผิดพลาด ห้ามส่งเสียงใด ๆ
    } on PlatformException catch (e) {
      debugPrint('TCL: BBAPI $method ไม่สำเร็จ — $e');
    }
  }
}
