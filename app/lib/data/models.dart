import 'package:characters/characters.dart';
import 'package:flutter/foundation.dart';

/// สินค้า — map จาก ERP `InventoryItem` + ยอดจาก `tbl_CountDtl.MainQty`
///
/// ฟิลด์ที่ ERP จริง (db_TCL) ให้ไม่ครบ ถูกทำเป็น nullable:
/// `nameEn` (ว่าง 100%) · `loc` (Shelf ว่าง 100%) · `reserved` (PendingQTY ว่าง 100%)
/// `lot` (ว่าง 100%) · `rop` (MinStock มี ~29%) — ดู docs/erp-tcl-findings.md
@immutable
class Item {
  const Item({
    required this.sku,
    required this.name,
    required this.unit,
    this.barcodes = const [],
    this.nameEn,
    this.loc,
    this.warehouse,
    this.onHand,
    this.onHandIsLive = false,
    this.onHandAsOf,
    this.reserved,
    this.rop,
    this.updated,
    this.vendor,
    this.lot,
    this.lastCountDate,
  });

  /// `InventoryItem.ItemCode` — มีครบ 100%
  final String sku;

  /// `InventoryItem.ItemName` (ไทย) — มีครบ 100%
  final String name;

  /// `InventoryItem.MainUnits` — มีครบ 100%
  final String unit;

  /// บาร์โค้ดทั้งหมดของสินค้านี้ (1 SKU : N barcode)
  /// รวม Code128 ของ ItemCode และ EAN-13 จริงถ้ามี
  final List<String> barcodes;

  final String? nameEn;
  final String? loc;
  final String? warehouse;

  /// ยอดคงเหลือตามระบบ — null = ไม่มีข้อมูล (สินค้าไม่อยู่ในรอบนับ)
  final num? onHand;

  /// `true` = ยอดนี้ยิงสดจาก ERP ตอนที่ขอ · `false` = ยอดจากรอบ sync ล่าสุด
  ///
  /// ⚠️ ยอดเก่ากับยอดสดต้องแสดงให้ต่างกันเสมอ พนักงานตัดสินใจจากตัวเลขนี้
  /// (backend ส่งมาเป็น `onHandSource: 'erp' | 'cache'`)
  final bool onHandIsLive;

  /// เวลาที่ `onHand` เป็นจริง — ใช้ทำป้าย "ณ HH:mm" เมื่อ ERP ไม่ตอบ
  final DateTime? onHandAsOf;
  final num? reserved;
  final num? rop;

  /// ข้อความเวลาอัปเดต เช่น 'วันนี้ 09:42'
  final String? updated;
  final String? vendor;
  final String? lot;
  final String? lastCountDate;

  /// พร้อมขาย = onHand − reserved (clamp ที่ 0 — ERP oversell ได้)
  num? get free =>
      (onHand == null || reserved == null) ? null : (onHand! - reserved!).clamp(0, double.infinity);

  bool get hasQty => onHand != null;

  /// ป้ายบอกที่มาของยอดสำหรับแสดงข้างตัวเลข
  /// สด → 'สด' · ไม่สด → 'ณ HH:mm' · ไม่รู้เวลา → 'ยอดเก่า'
  String get onHandSourceLabel {
    if (onHandIsLive) return 'สด';
    final at = onHandAsOf;
    if (at == null) return 'ยอดเก่า';
    final local = at.toLocal();
    final hh = local.hour.toString().padLeft(2, '0');
    final mm = local.minute.toString().padLeft(2, '0');
    return 'ณ $hh:$mm';
  }
}

/// สมาชิกและสิทธิ์
@immutable
class Member {
  const Member({
    required this.name,
    required this.empId,
    required this.shift,
    required this.role,
  });

  final String name;
  final String empId;
  final String shift;
  final Role role;

  Member copyWith({Role? role}) =>
      Member(name: name, empId: empId, shift: shift, role: role ?? this.role);

  /// อักษรย่อจาก 2 คำแรก
  ///
  /// ใช้ grapheme cluster แรกแล้ว**ตัดสระ/วรรณยุกต์ที่เกาะออก** เหลือพยัญชนะต้น
  /// (ธรรมเนียมอักษรย่อไทย: 'ปิยะนุช ศรีทอง' → 'ปศ' ไม่ใช่ 'ปิศ')
  /// การใช้ grapheme cluster ก่อนตัด กันปัญหา combining mark เดี่ยวหลุดออกมา
  String get initials {
    final parts =
        name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '';
    if (parts.length == 1) return _baseChar(parts[0]);
    return _baseChar(parts[0]) + _baseChar(parts[1]);
  }

  /// สระบน/ล่างและวรรณยุกต์ไทยที่ต้องตัดออกจากอักษรย่อ
  static final RegExp _thaiCombining =
      RegExp(r'[ัิ-ฺ็-๎]');

  static String _baseChar(String s) {
    if (s.characters.isEmpty) return '';
    final stripped = s.characters.first.replaceAll(_thaiCombining, '');
    // ถ้าตัดแล้วว่าง (คำขึ้นต้นด้วย combining mark เดี่ยว) คืน cluster เดิม
    return stripped.isEmpty ? s.characters.first : stripped;
  }
}

enum Role {
  admin('ADMIN'),
  staff('STAFF'),
  viewer('VIEWER');

  const Role(this.label);
  final String label;

  /// วน admin → staff → viewer → admin
  Role get next => Role.values[(index + 1) % Role.values.length];

  /// viewer = ดูอย่างเดียว
  bool get canWrite => this != Role.viewer;
  bool get isAdmin => this == Role.admin;
}

/// รายการที่สแกนได้ (เรียงใหม่สุดบน · สแกนซ้ำเด้งขึ้นบนพร้อมเวลาใหม่)
@immutable
class ScanRecord {
  const ScanRecord({required this.sku, required this.at});
  final String sku;

  /// 'HH:MM' ณ เวลาที่สแกน
  final String at;
}

/// รอบนับ — mirror ของ `tbl_CountHdr` ใน ERP
@immutable
class CountSession {
  const CountSession({
    required this.transactionNo,
    required this.voucherNo,
    required this.countDate,
    required this.rows,
    this.zone,
    this.warehouse,
    this.dataAsOf,
  });

  /// คีย์จริงของรอบนับ — ⚠️ VoucherNo ซ้ำได้ ห้ามใช้เป็นคีย์
  final int transactionNo;
  final String voucherNo;
  final DateTime countDate;
  final List<CountRow> rows;
  final String? zone;
  final String? warehouse;

  /// อายุข้อมูลยอดระบบ ณ เวลาที่ freeze
  final DateTime? dataAsOf;
}

/// รายการในรอบนับ — mirror ของ `tbl_CountDtl`
@immutable
class CountRow {
  const CountRow({
    required this.sku,
    required this.name,
    required this.systemQty,
    required this.unit,
    this.loc,
    this.warehouse,
  });

  final String sku;
  final String name;

  /// `tbl_CountDtl.MainQty` — ยอดตามระบบ (freeze แล้ว) มีครบไม่มี NULL
  final num systemQty;
  final String unit;
  final String? loc;
  final String? warehouse;
}

/// ผลส่วนต่างของการนับ 1 รายการ
@immutable
class Variance {
  const Variance._(this.diff, this.label);

  /// ยังไม่ได้กรอก
  static const Variance notCounted = Variance._(null, 'ยังไม่ได้นับ');

  final num? diff;
  final String label;

  /// สร้างจากค่าที่กรอก (string ตัวเลข) เทียบยอดระบบ — ข้อความตรงตาม design
  factory Variance.from({required String entered, required num systemQty}) {
    if (entered.isEmpty) return notCounted;
    final counted = num.tryParse(entered);
    if (counted == null) return notCounted;
    final d = counted - systemQty;
    if (d == 0) return const Variance._(0, 'ตรงกับระบบ');
    if (d > 0) return Variance._(d, 'เกิน +$d');
    // diff ติดลบอยู่แล้ว → 'ขาด -3' ตาม design
    return Variance._(d, 'ขาด $d');
  }

  bool get isCounted => diff != null;
  bool get isMatch => diff == 0;

  /// ผลต่างพร้อมเครื่องหมายสำหรับแสดงบนการ์ด — ยังไม่ได้นับ = '—'
  ///
  /// ทิศเดียวกับ [diff] (นับได้ − ยอดระบบ): เกิน = '+n' · ขาด = '-n' · ตรง = '0'
  /// ⚠️ เป็นข้อความสำหรับ "จอ" เท่านั้น ห้ามส่งค่านี้ขึ้น server
  /// (การกลับเครื่องหมายให้ ERP มีจุดเดียวคือ `erpDifQty()` ฝั่ง server)
  String get signed {
    final d = diff;
    if (d == null) return '—';
    if (d == 0) return '0';
    return d > 0 ? '+$d' : '$d';
  }
}

/// สถานะกล้อง — ครอบคลุมสตริงไทยทั้งหมดใน design + สถานะจริงบนอุปกรณ์
enum CamStatus {
  offInitial('กล้องปิดอยู่ · แตะไอคอนกล้อง'),
  offToggled('กล้องปิดอยู่ · camera off'),
  scanning('กำลังค้นหาบาร์โค้ด · scanning'),
  permissionDenied('เปิดกล้องไม่ได้ · ใช้การค้นหาหรือกรอกรหัส'),
  detectorUnavailable('เครื่องนี้อ่านบาร์โค้ดไม่ได้ · ใช้การค้นหาหรือกรอกรหัส'),

  /// ⚠️ ค่านี้ไม่เคยถูกเขียนผ่าน `setCamStatus()` เลย — เป็นค่าที่ getter
  /// `camStatusText` คืนตรง ๆ เมื่อ `scanMode == ScanMode.handheld` และกล้อง
  /// **ไม่ได้ขัดข้อง** ทำให้ 'กล้องปิดอยู่ · แตะไอคอนกล้อง' เป็นสตริงที่ไปไม่ถึง
  /// ในโหมดเครื่องยิงโดยโครงสร้าง ไม่ใช่แค่ตั้งใจไม่เขียนมัน
  handheldReady('พร้อมยิงบาร์โค้ด · handheld');

  const CamStatus(this.text);
  final String text;

  /// กล้องขัดข้องจริง ๆ (ไม่ใช่แค่ปิดอยู่) — ป้ายสถานะต้องบอกทั้งสองโหมด
  ///
  /// โหมดเครื่องยิงกลบ `camStatus` ทิ้งด้วย [handheldReady] เป็นปกติ เพราะกล้อง
  /// ที่ปิดอยู่ไม่ใช่เรื่องที่ต้องรายงาน — แต่กล้องที่ **สั่งปิดไม่ลง** ยังยึด
  /// เซ็นเซอร์อยู่ และเครื่องยิงก็พลอยอ่านไม่ได้ (Bluebird คืน
  /// BBAPI_ERROR_BARCODE_CAMERA_USED = -9) กลบไว้ = ผู้ใช้ไม่มีทางรู้ว่าทำไม
  /// เหนี่ยวไกแล้วไม่มีอะไรเกิดขึ้น
  bool get isFailure =>
      this == CamStatus.permissionDenied ||
      this == CamStatus.detectorUnavailable;
}

/// โหมดสแกน — เครื่องยิงบาร์โค้ด (handheld) หรือกล้อง (camera)
///
/// ค่าเริ่มต้นคือ handheld (R2 — ไม่ต้องอ่านดิสก์) เก็บระดับเครื่องผ่าน KvMeta (R3)
/// เพราะเครื่องคลังใช้ร่วมกันหลายกะ (ดู api_client.dart:71)
enum ScanMode {
  handheld('เครื่องยิง'),
  camera('กล้อง');

  const ScanMode(this.label);
  final String label;
}
