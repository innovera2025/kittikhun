/// Repository ชั้น catalog / count / sync — ต่อ backend NestJS (ไม่มี global prefix)
///
/// `GET /items?since=&limit=` · `GET /items/by-barcode/:code` · `GET /items/search?q=&limit=`
/// `POST /items/scan-events` · `GET /count-sessions/active`
/// `POST /count-sessions/:id/submissions` · `GET /count-sessions/:id/variance`
/// `GET /sync/status`
///
/// กติกาของไฟล์นี้:
/// - **ห้ามแปลง null เป็น 0** ในฟิลด์ยอด/ส่วนต่าง: `not_counted` / `off_list` มี
///   `diff = NULL` จริง ๆ ("ยังไม่ได้นับ" ต่างจาก "นับได้เท่ากับระบบ" — ดู architecture.md)
/// - numeric จาก Postgres `numeric(18,3)` มาได้ทั้ง number และ string ('3.000')
///   → [_asNum] รับทั้งสองแบบ
/// - ไม่แปลข้อความ error เอง: backend ส่ง `message` ไทยตาม design มาแล้ว
///   ปล่อย [ApiException] ขึ้นไปให้ UI แสดง (ยกเว้น 404 ของ by-barcode → คืน null)
/// - ⚠️ ห้าม log บาร์โค้ด / ผลนับ / deviceId (เครื่องคลังใช้ร่วมกันหลายกะ)
library;

import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'models.dart';

// ════════════════════════════════════════════════════════════════════
// UUIDv7 — คีย์ idempotency ของ outbox
// ════════════════════════════════════════════════════════════════════

/// UUID v7 (RFC 9562): 48-bit unix ms (big-endian) + version 7 + random
///
/// time-ordered จึงเรียงตามเวลาที่สร้างได้โดยไม่ต้องมีคอลัมน์เวลา และ
/// เป็น index-friendly ฝั่ง Postgres (`count_submissions.idempotency_key`)
///
/// ⚠️ ลำดับ**ภายในมิลลิวินาทีเดียวกัน**เป็นสุ่ม — ลำดับการนับจริงใช้
/// `SubmitLine.deviceSeq` เท่านั้น (นาฬิกาเครื่องคลังเชื่อไม่ได้)
///
/// ใช้ `Random.secure()` ให้ค่าชนกันไม่ได้จริงข้ามเครื่อง (ไม่พึ่ง package เพิ่ม)
String newUuidV7() {
  final ms = DateTime.now().millisecondsSinceEpoch;
  final rnd = Random.secure();
  final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
  bytes[0] = (ms >> 40) & 0xff;
  bytes[1] = (ms >> 32) & 0xff;
  bytes[2] = (ms >> 24) & 0xff;
  bytes[3] = (ms >> 16) & 0xff;
  bytes[4] = (ms >> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  String hex(int start, int end) => bytes
      .sublist(start, end)
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}

// ════════════════════════════════════════════════════════════════════
// Models ของชั้น catalog
// ════════════════════════════════════════════════════════════════════

/// หนึ่งหน้าของ delta sync — วนเรียกจนกว่า [hasMore] จะเป็น false
///
/// [tombstones] คือ SKU ที่ถูกลบ/ปิดใช้งานฝั่ง ERP → ต้องลบจาก DB บนเครื่องด้วย
@immutable
class DeltaPage {
  const DeltaPage({
    required this.items,
    required this.tombstones,
    required this.nextCursor,
    required this.hasMore,
  });

  final List<Item> items;
  final List<String> tombstones;

  /// `rowVersion` สูงสุดของหน้านี้ — ส่งเป็น `since` ของรอบถัดไป (เก็บถาวรบนเครื่อง)
  final String nextCursor;
  final bool hasMore;

  bool get isEmpty => items.isEmpty && tombstones.isEmpty;
}

/// ผลค้นหา — [truncated] = ผลจริงมีมากกว่าที่ส่งกลับ (UI แสดง "แสดง n จาก total")
@immutable
class SearchResult {
  const SearchResult({
    required this.items,
    required this.total,
    required this.truncated,
  });

  final List<Item> items;
  final int total;
  final bool truncated;
}

/// เหตุการณ์สแกน 1 ครั้ง — ส่งขึ้น backend แบบ fire-and-forget (สถิติ/ops)
///
/// [sku] เป็น null ได้เมื่อบาร์โค้ดนั้นไม่รู้จัก (ยังต้องบันทึกไว้ให้ ops เห็นว่ามี
/// บาร์โค้ดที่แอปอ่านได้แต่แม็ปกับสินค้าไม่ได้)
@immutable
class ScanEventInput {
  const ScanEventInput({
    required this.barcode,
    required this.scannedAt,
    this.sku,
  });

  final String barcode;
  final String? sku;
  final DateTime scannedAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'barcode': barcode,
        if (sku != null && sku!.isNotEmpty) 'sku': sku,
        'scannedAt': _toIso8601Utc(scannedAt),
      };
}

// ════════════════════════════════════════════════════════════════════
// CatalogRepository
// ════════════════════════════════════════════════════════════════════

/// สินค้า: delta sync, ค้นหา, ยิงบาร์โค้ด, ส่งสถิติการสแกน
class CatalogRepository {
  const CatalogRepository({required this.api, required this.store});

  final ApiClient api;
  final TokenStore store;

  /// code จาก backend เมื่อบาร์โค้ดไม่รู้จัก (404) — ชั้นนี้แปลงเป็น `null`
  static const String codeItemNotFound = 'ITEM_NOT_FOUND';

  /// จำนวนแถวต่อหน้าที่ใช้ตอน sync ครั้งแรก (full sync แบ่งหลายหน้า)
  static const int defaultPageSize = 500;

  /// cursor เริ่มต้น (ยังไม่เคย sync) — backend ตีความว่าเอาทั้งหมด
  static const String initialCursor = '';

  /// ดึงสินค้าที่เปลี่ยนหลัง [cursor] — `cursor` ว่าง = sync ครั้งแรก (ทั้งคลัง)
  Future<DeltaPage> fetchSince({
    required String cursor,
    int limit = defaultPageSize,
  }) async {
    final trimmed = cursor.trim();
    final json = _asMap(
      await api.get('/items', query: <String, dynamic>{
        if (trimmed.isNotEmpty) 'since': trimmed,
        'limit': limit,
      }),
      '/items',
    );
    final next = _asString(json['nextCursor']).trim();
    return DeltaPage(
      items: _mapList(json['items'], '/items.items', _itemFromJson),
      tombstones: _asStringList(json['tombstones']),
      // ไม่มี nextCursor = ไม่คืบหน้า → คง cursor เดิมไว้
      // (ห้าม fallback เป็น '' เพราะจะกลายเป็น full sync ใหม่ทุกรอบ)
      nextCursor: next.isEmpty ? trimmed : next,
      hasMore: _asBool(json['hasMore']),
    );
  }

  /// หาสินค้าจากบาร์โค้ด — **คืน `null` เมื่อไม่พบ (404) ไม่ throw**
  ///
  /// บาร์โค้ดที่ไม่รู้จักเป็นเรื่องปกติที่หน้าสแกน (สินค้าใหม่ / ฉลากคนละคลัง)
  /// ชั้น UI แสดง toast เอง · error อื่น (เน็ตหลุด / session หมด) โยนต่อ
  Future<Item?> findByBarcode(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) return null;
    try {
      return _itemFromJson(
        _asMap(
          await api.get('/items/by-barcode/${Uri.encodeComponent(trimmed)}'),
          '/items/by-barcode',
        ),
      );
    } on ApiException catch (error) {
      if (error.statusCode == 404 || error.code == codeItemNotFound) return null;
      rethrow;
    }
  }

  /// ค้นหาด้วยชื่อ/รหัส — คำค้นว่างคืนผลเปล่าโดยไม่ยิง request
  Future<SearchResult> search(String q, {int limit = 100}) async {
    final trimmed = q.trim();
    if (trimmed.isEmpty) {
      return const SearchResult(items: [], total: 0, truncated: false);
    }
    final json = _asMap(
      await api.get(
        '/items/search',
        query: <String, dynamic>{'q': trimmed, 'limit': limit},
      ),
      '/items/search',
    );
    final items = _mapList(json['items'], '/items/search.items', _itemFromJson);
    return SearchResult(
      items: items,
      // total หายไป = ถือว่าเท่าที่ส่งมา (ตัวเลขบน UI ต้องไม่น้อยกว่าที่แสดงจริง)
      total: _asInt(json['total'], items.length),
      truncated: _asBool(json['truncated']),
    );
  }

  /// ส่งสถิติการสแกน — คืนจำนวนบรรทัดที่ backend บันทึก
  ///
  /// เป็นข้อมูล ops ไม่ใช่ผลนับ: ผู้เรียกควรกลืน error ทิ้งได้ ไม่ต้อง retry
  Future<int> pushScanEvents(List<ScanEventInput> events) async {
    if (events.isEmpty) return 0;
    final deviceId = await store.getDeviceId();
    final json = _asMap(
      await api.post('/items/scan-events', body: <String, dynamic>{
        'deviceId': deviceId,
        'events': events.map((e) => e.toJson()).toList(growable: false),
      }),
      '/items/scan-events',
    );
    return _asInt(json['recorded']);
  }
}

// ════════════════════════════════════════════════════════════════════
// Models ของชั้น count
// ════════════════════════════════════════════════════════════════════

/// รอบนับที่เปิดอยู่ของคลังผู้ใช้ + ยอดระบบที่ freeze แล้ว
///
/// [staleCache] = admin เปิดรอบตอน ERP ล่ม โดยยืนยันจาก cache เก่า
/// → UI ต้องเตือนว่ายอดระบบอาจไม่ใช่ล่าสุด (erp-integration.md §5)
@immutable
class ActiveSession {
  const ActiveSession({
    required this.id,
    required this.warehouseCode,
    required this.openedAt,
    required this.rows,
    this.voucherNo,
    this.zone,
    this.dataAsOf,
    this.staleCache = false,
  });

  /// คีย์จริงของรอบนับ — ใช้ประกอบ path ของ submissions/variance
  /// (⚠️ `voucherNo` ซ้ำได้ ห้ามใช้เป็นคีย์)
  final String id;

  /// เลขที่เอกสารสำหรับแสดงบนหัวจอ เช่น 'CC-2408'
  final String? voucherNo;
  final String? zone;
  final String warehouseCode;
  final DateTime openedAt;

  /// อายุข้อมูลยอดระบบ ณ เวลาที่ freeze (`erpDataAsOf`)
  final DateTime? dataAsOf;
  final bool staleCache;
  final List<CountRow> rows;
}

/// ผลนับ 1 บรรทัดจากคิวของเครื่อง
///
/// [idempotencyKey] มาจาก [newUuidV7] ตอน**สร้างรายการในคิว** (ไม่ใช่ตอนส่ง)
/// → retry กี่ครั้งก็ไม่นับซ้ำ · [deviceSeq] คือลำดับการนับจริงของเครื่องนี้
@immutable
class SubmitLine {
  const SubmitLine({
    required this.idempotencyKey,
    required this.sku,
    required this.countedQty,
    required this.countedAt,
    required this.deviceSeq,
  });

  final String idempotencyKey;
  final String sku;
  final num countedQty;
  final DateTime countedAt;
  final int deviceSeq;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'idempotencyKey': idempotencyKey,
        'sku': sku,
        'countedQty': countedQty,
        'countedAt': _toIso8601Utc(countedAt),
        'deviceSeq': deviceSeq,
      };
}

/// ผลรายบรรทัดจาก `POST /count-sessions/:id/submissions` (HTTP 200 เสมอ)
///
/// `rejected` **ไม่ใช่** error ของ request: งานไม่หายเงียบ ๆ แต่เข้าจอ pending-review
/// (เช่น รอบปิดไปแล้ว / role เปลี่ยนกลางกะ — ดู [code])
@immutable
class SubmitResult {
  const SubmitResult({
    required this.idempotencyKey,
    required this.status,
    this.code,
  });

  final String idempotencyKey;

  /// 'accepted' | 'duplicate' | 'rejected'
  final String status;

  /// เหตุผลเมื่อ `rejected` เช่น `SESSION_CLOSED` `ROLE_CHANGED`
  final String? code;

  static const String statusAccepted = 'accepted';
  static const String statusDuplicate = 'duplicate';
  static const String statusRejected = 'rejected';

  bool get isAccepted => status == statusAccepted;

  /// ส่งซ้ำของบรรทัดที่ backend รับไปแล้ว — ถือว่าสำเร็จ ลบออกจากคิวได้
  bool get isDuplicate => status == statusDuplicate;
  bool get isRejected => status == statusRejected;

  /// ลบออกจาก outbox ได้ (accepted หรือ duplicate) — rejected ต้องเก็บให้คนดู
  bool get isSettled => isAccepted || isDuplicate;
}

/// ส่วนต่าง 1 รายการในรอบนับ
///
/// ⚠️ [frozenOnHand] / [countedQty] / [diff] เป็น `null` ได้จริง:
/// `not_counted` = ยังไม่มีใครนับ · `off_list` = นับเจอแต่ไม่อยู่ในรายการที่ freeze
/// → ห้ามแปลงเป็น 0 เพราะจะกลายเป็น "นับได้เท่ากับระบบ" ซึ่งผิดความหมาย
@immutable
class VarianceRow {
  const VarianceRow({
    required this.sku,
    required this.status,
    required this.deviceCount,
    required this.isConflict,
    this.frozenOnHand,
    this.countedQty,
    this.diff,
    this.countedBy,
    this.unit,
    this.zone,
  });

  final String sku;

  /// ยอดตามระบบที่ freeze ไว้ — null เมื่อ `off_list`
  final num? frozenOnHand;

  /// ยอดที่นับได้ — null เมื่อ `not_counted`
  final num? countedQty;

  /// countedQty − frozenOnHand — null เมื่อยังเทียบไม่ได้
  final num? diff;

  /// 'match' | 'over' | 'short' | 'not_counted' | 'off_list' | 'conflict'
  final String status;

  /// รหัส/ชื่อผู้นับ — null เมื่อยังไม่มีใครนับ
  final String? countedBy;

  /// จำนวนเครื่องที่ส่งผลของ SKU นี้ (>1 = ต้องให้ admin ตัดสิน)
  final int deviceCount;

  /// 2+ เครื่องนับ SKU เดียวกัน — ⚠️ ห้าม auto-resolve
  final bool isConflict;

  final String? unit;
  final String? zone;

  static const String statusMatch = 'match';
  static const String statusOver = 'over';
  static const String statusShort = 'short';
  static const String statusNotCounted = 'not_counted';
  static const String statusOffList = 'off_list';
  static const String statusConflict = 'conflict';

  /// ข้อความสถานะไทยตรงตาม design (ตรงกับ [Variance] ใน models.dart)
  ///
  /// 'ตรงกับระบบ' · 'เกิน +3' · 'ขาด -3' · 'ยังไม่ได้นับ' · 'นอกรายการ' · 'ขัดแย้ง'
  String get statusLabelTh {
    final d = diff;
    return switch (status.trim().toLowerCase()) {
      VarianceRow.statusMatch => 'ตรงกับระบบ',
      VarianceRow.statusOver =>
        d == null ? 'เกิน' : 'เกิน +${_formatQty(d.abs())}',
      VarianceRow.statusShort =>
        d == null ? 'ขาด' : 'ขาด -${_formatQty(d.abs())}',
      VarianceRow.statusNotCounted => 'ยังไม่ได้นับ',
      VarianceRow.statusOffList => 'นอกรายการ',
      VarianceRow.statusConflict => 'ขัดแย้ง',
      // สัญญา drift: ไม่เดาเป็น 0 หรือ 'ตรงกับระบบ' (จะปิดปัญหาจริงไปเงียบ ๆ)
      _ => isConflict ? 'ขัดแย้ง' : 'ไม่ทราบสถานะ',
    };
  }

  /// มีคนนับแล้วจริง (แยกจาก `countedQty == 0` ซึ่งคือ "นับได้ศูนย์")
  bool get isCounted => countedQty != null;
}

// ════════════════════════════════════════════════════════════════════
// CountRepository
// ════════════════════════════════════════════════════════════════════

/// รอบนับ: ดึงรอบที่เปิดอยู่, ส่งผลนับจากคิว, อ่านรายงานส่วนต่าง
class CountRepository {
  const CountRepository({required this.api, required this.store});

  final ApiClient api;
  final TokenStore store;

  /// เพดานของ backend (`MAX_BATCH_LINES`) — [submit] ตัดเป็นชุดให้เอง
  static const int maxLinesPerBatch = 200;

  /// รอบนับที่เปิดอยู่ของคลังผู้ใช้ — **คืน `null` เมื่อไม่มีรอบเปิด**
  ///
  /// backend ตอบ 200 พร้อม body `null` (ไม่ใช่ 404) จึงไม่ต้องแยก error path
  Future<ActiveSession?> fetchActive() async {
    final raw = await api.get('/count-sessions/active');
    if (raw == null) return null;
    final json = _asMap(raw, '/count-sessions/active');
    // เผื่อ backend ห่อ null มาเป็น {} — ไม่มี id = ไม่มีรอบเปิด
    final id = _asString(json['id']).trim();
    if (id.isEmpty) return null;

    final warehouseCode = _asString(json['warehouseCode']).trim();
    return ActiveSession(
      id: id,
      voucherNo: _asOptString(json['erpVoucherNo']),
      zone: _asOptString(json['zone']),
      warehouseCode: warehouseCode,
      openedAt: _requireDate(json['openedAt'], 'openedAt'),
      dataAsOf: _asDate(json['erpDataAsOf']),
      staleCache: _asBool(json['openedOnStaleCache']),
      rows: _mapList(
        json['rows'],
        '/count-sessions/active.rows',
        (row) => _countRowFromJson(row, warehouseCode),
      ),
    );
  }

  /// ส่งผลนับจากคิว — คืนผลรายบรรทัดตามลำดับที่ backend ตอบ
  ///
  /// เกิน [maxLinesPerBatch] บรรทัดจะถูกตัดเป็นหลายชุด (เครื่องที่ออฟไลน์ทั้งกะมี
  /// คิวยาวได้) — ทุกบรรทัดมี `idempotencyKey` อยู่แล้ว การส่งซ้ำจึงปลอดภัย
  Future<List<SubmitResult>> submit({
    required String sessionId,
    required List<SubmitLine> lines,
    int queueDepth = 0,
  }) async {
    if (lines.isEmpty) return const <SubmitResult>[];
    final deviceId = await store.getDeviceId();
    final path =
        '/count-sessions/${Uri.encodeComponent(sessionId)}/submissions';
    final results = <SubmitResult>[];
    for (var start = 0; start < lines.length; start += maxLinesPerBatch) {
      final end = min(start + maxLinesPerBatch, lines.length);
      final chunk = lines.sublist(start, end);
      final raw = await api.post(path, body: <String, dynamic>{
        'deviceId': deviceId,
        'queueDepth': queueDepth,
        'lines': chunk.map((l) => l.toJson()).toList(growable: false),
      });
      results.addAll(
        _mapList(raw, path, _submitResultFromJson),
      );
    }
    return List<SubmitResult>.unmodifiable(results);
  }

  /// รายงานส่วนต่างของรอบนับ (ระหว่างรอบอ่านสด · หลังปิดรอบอ่านค่าที่ materialize แล้ว)
  Future<List<VarianceRow>> fetchVariance(String sessionId) async {
    final path = '/count-sessions/${Uri.encodeComponent(sessionId)}/variance';
    return _mapList(await api.get(path), path, _varianceRowFromJson);
  }
}

// ════════════════════════════════════════════════════════════════════
// SyncRepository
// ════════════════════════════════════════════════════════════════════

/// อายุข้อมูลบนเครื่อง/ฝั่ง server + สุขภาพการต่อ ERP
@immutable
class SyncStatus {
  const SyncStatus({
    required this.erpOk,
    this.itemsStockAsOf,
    this.countSessionsAsOf,
  });

  /// เวลาที่ยอดสินค้าถูก sync จาก ERP ล่าสุด — null = ยังไม่เคย sync
  final DateTime? itemsStockAsOf;
  final DateTime? countSessionsAsOf;

  /// false = ต่อ ERP (SQL Server) ไม่ได้ → ยอดที่เห็นเป็นของ cache
  final bool erpOk;

  /// ป้ายอายุข้อมูลตาม design เช่น 'ข้อมูล ณ 09:42' — null เมื่อยังไม่เคย sync
  String? get dataAsOfLabel {
    final at = itemsStockAsOf;
    if (at == null) return null;
    return 'ข้อมูล ณ ${_hhmm(at)}';
  }

  /// ควรเตือนผู้ใช้ว่ายอดอาจไม่ใช่ล่าสุด
  bool get isStale => !erpOk || itemsStockAsOf == null;
}

class SyncRepository {
  const SyncRepository({required this.api});

  final ApiClient api;

  Future<SyncStatus> status() async {
    final json = _asMap(await api.get('/sync/status'), '/sync/status');
    return SyncStatus(
      itemsStockAsOf: _asDate(json['itemsStockAsOf']),
      countSessionsAsOf: _asDate(json['countSessionsAsOf']),
      erpOk: _asBool(json['erpOk']),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// Mapping helpers
// ════════════════════════════════════════════════════════════════════

Item _itemFromJson(Map<String, dynamic> json) => Item(
      sku: _requireString(json['sku'], 'sku'),
      name: _asString(json['name']),
      // ERP `MainUnits` มีครบ 100% — '' เป็นเพียงกันพังเมื่อสัญญา drift
      unit: _asString(json['unit']),
      barcodes: _asStringList(json['barcodes']),
      nameEn: _asOptString(json['nameEn']),
      loc: _asOptString(json['loc']),
      warehouse: _asOptString(json['warehouseCode']),
      onHand: _asNum(json['onHand']),
      reserved: _asNum(json['reserved']),
      rop: _asNum(json['rop']),
      updated: _updatedLabel(_asDate(json['updatedAt'])),
    );

/// แถวในรอบนับ — `frozenOnHand` คือยอดระบบที่ freeze แล้ว (ERP ไม่ส่ง NULL)
CountRow _countRowFromJson(Map<String, dynamic> json, String warehouseCode) =>
    CountRow(
      sku: _requireString(json['sku'], 'rows[].sku'),
      name: _asString(json['name']),
      systemQty: _requireNum(json['frozenOnHand'], 'rows[].frozenOnHand'),
      unit: _asString(json['unit']),
      loc: _asOptString(json['loc']),
      warehouse: warehouseCode.isEmpty ? null : warehouseCode,
    );

SubmitResult _submitResultFromJson(Map<String, dynamic> json) => SubmitResult(
      idempotencyKey: _requireString(json['idempotencyKey'], 'idempotencyKey'),
      status: _asString(json['status']).trim().toLowerCase(),
      code: _asOptString(json['code']),
    );

VarianceRow _varianceRowFromJson(Map<String, dynamic> json) => VarianceRow(
      sku: _requireString(json['sku'], 'sku'),
      frozenOnHand: _asNum(json['frozenOnHand']),
      countedQty: _asNum(json['countedQty']),
      diff: _asNum(json['diff']),
      status: _asString(json['status']),
      countedBy: _asOptString(json['countedBy']),
      deviceCount: _asInt(json['deviceCount']),
      isConflict: _asBool(json['isConflict']),
      unit: _asOptString(json['unit']),
      zone: _asOptString(json['zone']),
    );

/// แปลง JSON array → list ของ model โดยข้าม element ที่ไม่ใช่ object
List<T> _mapList<T>(
  Object? raw,
  String where,
  T Function(Map<String, dynamic>) map,
) {
  if (raw == null) return const [];
  if (raw is! List) throw FormatException('expected JSON array at $where');
  final out = <T>[];
  for (final element in raw) {
    out.add(map(_asMap(element, '$where[]')));
  }
  return List<T>.unmodifiable(out);
}

/// ISO-8601 พร้อม timezone designator (`...Z`) — zod ฝั่ง backend บังคับให้มี
///
/// ส่งเป็น UTC เสมอ: นาฬิกาเครื่องคลังตั้งเองได้ การส่ง instant ที่ไม่กำกวม
/// ทำให้ backend ไม่ต้องเดา offset (เวลาที่แสดงบนจอ format จาก locale ของแอป)
String _toIso8601Utc(DateTime value) => value.toUtc().toIso8601String();

/// 'HH:MM' ตามเวลาเครื่อง
String _hhmm(DateTime value) {
  final local = value.toLocal();
  final h = local.hour.toString().padLeft(2, '0');
  final m = local.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// ป้ายเวลาอัปเดตตาม design: 'วันนี้ 09:42' · 'เมื่อวาน 17:20' · '12 ส.ค. 2569'
String? _updatedLabel(DateTime? value) {
  if (value == null) return null;
  final at = value.toLocal();
  final now = DateTime.now();
  final startOfToday = DateTime(now.year, now.month, now.day);
  final startOfDay = DateTime(at.year, at.month, at.day);
  final days = startOfToday.difference(startOfDay).inDays;
  if (days == 0) return 'วันนี้ ${_hhmm(at)}';
  if (days == 1) return 'เมื่อวาน ${_hhmm(at)}';
  // เก่ากว่านั้นแสดงเป็นวันที่แบบ พ.ศ. (รูปแบบเดียวกับ lastCountDate ใน design)
  final day = at.day.toString().padLeft(2, '0');
  return '$day ${_thaiMonthsShort[at.month - 1]} ${at.year + 543}';
}

const List<String> _thaiMonthsShort = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/// จำนวนสำหรับแสดงผล — `numeric(18,3)` ที่เป็นจำนวนเต็มต้องไม่โผล่ '.0'
/// (design เขียน 'เกิน +3' ไม่ใช่ 'เกิน +3.0')
String _formatQty(num value) {
  if (value is int) return value.toString();
  final d = value.toDouble();
  if (d == d.truncateToDouble() && d.abs() < 1e15) {
    return d.toInt().toString();
  }
  var text = d.toStringAsFixed(3);
  text = text.replaceFirst(RegExp(r'0+$'), '');
  if (text.endsWith('.')) text = text.substring(0, text.length - 1);
  return text;
}

/// numeric จาก Postgres มาได้ทั้ง number และ string ('3.000')
///
/// ⚠️ คืน `null` เมื่ออ่านไม่ได้ — **ห้ามคืน 0** (null = ไม่มีข้อมูล ไม่ใช่ศูนย์)
num? _asNum(Object? raw) {
  if (raw is num) return raw.isFinite ? raw : null;
  if (raw is String) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    final parsed = num.tryParse(trimmed);
    return (parsed != null && parsed.isFinite) ? parsed : null;
  }
  return null;
}

/// ฟิลด์ยอดที่ขาดไม่ได้ (เช่น `frozenOnHand` ของแถวในรอบนับ)
num _requireNum(Object? raw, String field) {
  final value = _asNum(raw);
  if (value == null) throw FormatException('missing field: $field');
  return value;
}

/// ตัวนับ/ผลรวม — ใช้ [fallback] ได้เพราะเป็น "จำนวนรายการ" ไม่ใช่ยอดสินค้า
int _asInt(Object? raw, [int fallback = 0]) => _asNum(raw)?.toInt() ?? fallback;

bool _asBool(Object? raw) {
  if (raw is bool) return raw;
  if (raw is num) return raw != 0;
  if (raw is String) {
    final trimmed = raw.trim().toLowerCase();
    return trimmed == 'true' || trimmed == '1';
  }
  return false;
}

String _asString(Object? raw) => raw is String ? raw : '';

/// string ที่ backend ให้ null/ว่างได้ → คง `null` ไว้ (UI แสดง '—' เอง)
String? _asOptString(Object? raw) {
  if (raw is! String) return null;
  final trimmed = raw.trim();
  return trimmed.isEmpty ? null : trimmed;
}

List<String> _asStringList(Object? raw) => raw is List
    ? List<String>.unmodifiable(
        raw.whereType<String>().where((s) => s.trim().isNotEmpty),
      )
    : const <String>[];

DateTime? _asDate(Object? raw) {
  if (raw is String) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    return DateTime.tryParse(trimmed)?.toLocal();
  }
  if (raw is int) {
    return DateTime.fromMillisecondsSinceEpoch(raw).toLocal();
  }
  return null;
}

DateTime _requireDate(Object? raw, String field) {
  final value = _asDate(raw);
  if (value == null) throw FormatException('missing field: $field');
  return value;
}

/// ฟิลด์ที่ขาดไม่ได้ — ผิดสัญญา backend ถือเป็นบั๊ก ไม่ใช่ error ที่ผู้ใช้แก้ได้
/// (ข้อความ dev-facing และไม่มีค่าของฟิลด์อยู่ในข้อความ — กันข้อมูลหลุดลง log)
String _requireString(Object? raw, String field) {
  final value = _asString(raw).trim();
  if (value.isEmpty) throw FormatException('missing field: $field');
  return value;
}

Map<String, dynamic> _asMap(Object? raw, [String where = 'response']) {
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return raw.cast<String, dynamic>();
  throw FormatException('expected JSON object at $where');
}

// ════════════════════════════════════════════════════════════════════
// Providers
// ════════════════════════════════════════════════════════════════════

final catalogRepositoryProvider = Provider<CatalogRepository>(
  (ref) => CatalogRepository(
    api: ref.watch(apiClientProvider),
    store: ref.watch(tokenStoreProvider),
  ),
);

final countRepositoryProvider = Provider<CountRepository>(
  (ref) => CountRepository(
    api: ref.watch(apiClientProvider),
    store: ref.watch(tokenStoreProvider),
  ),
);

final syncRepositoryProvider = Provider<SyncRepository>(
  (ref) => SyncRepository(api: ref.watch(apiClientProvider)),
);
