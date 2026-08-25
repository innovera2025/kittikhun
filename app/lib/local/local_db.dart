/// SQLite บนเครื่อง (drift) — **replica ฝั่งอ่าน + คิวงานฝั่งเขียน (outbox)**
///
/// คลังมีจุดอับสัญญาณ WiFi: สแกน / ค้นหา / นับ ต้องทำงานได้ 100% โดยไม่มีเน็ต
/// → อ่านจากตารางในไฟล์นี้เท่านั้น · เขียนลง [Outbox] แล้วให้ sync engine ส่งทีหลัง
/// (architecture.md §4.2 + §6)
///
/// กติกาของไฟล์นี้:
/// - **งานของพนักงานต้องไม่หายเงียบ ๆ** — แถวที่ถูก server ปฏิเสธ (`rejectCode != null`)
///   ค้างไว้ให้จอ pending-review ตัดสิน ไม่ลบอัตโนมัติ (design-fidelity.md §7 ข้อ 1)
/// - **ห้ามแปลง null เป็น 0** ในฟิลด์ยอด (`onHand` / `reserved` / `rop`):
///   null = ไม่มีข้อมูล ≠ นับได้ศูนย์
/// - **ลำดับงานใช้ `deviceSeq` จาก counter ใน [KvMeta] เท่านั้น** — นาฬิกาเครื่องคลัง
///   ตั้งเองได้/เพี้ยนได้ ห้ามใช้เวลาเป็นลำดับ (architecture.md §6.2)
/// - ทุก method ที่แตะหลายตารางอยู่ใน `transaction` เดียว
/// - ⚠️ ห้าม log บาร์โค้ด / ผลนับ / PIN / token (เครื่องใช้ร่วมกันหลายกะ)
///
/// codegen: `dart run build_runner build --delete-conflicting-outputs`
library;

import 'dart:convert';
import 'dart:math';

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models.dart';
import '../data/stock_repository.dart';

part 'local_db.g.dart';

// ════════════════════════════════════════════════════════════════════
// คำศัพท์คงที่ของคิวงาน
// ════════════════════════════════════════════════════════════════════

/// ประเภทงานใน [Outbox] — payload ของแต่ละประเภทดูที่ [LocalDb.enqueueCountLine]
/// และ [LocalDb.enqueueScanEvent]
abstract final class OutboxType {
  /// ผลนับ 1 บรรทัด → `POST /count-sessions/:id/submissions` (payload = [SubmitLine])
  static const String countLine = 'count_line';

  /// สถิติการสแกน → `POST /items/scan-events` (payload = [ScanEventInput])
  static const String scanEvent = 'scan_event';
}

/// สถานะแถวใน [Outbox] — `queued → inflight → acked | failed` (architecture.md §6.2)
///
/// หมายเหตุ 2 ข้อที่ต่างจากชื่อสถานะแบบผิวเผิน:
/// - **retry ไม่เปลี่ยนสถานะ**: [LocalDb.markRetry] คงไว้ที่ [queued] แล้วเลื่อน
///   `nextRetryAt` เท่านั้น → badge จำนวนงานค้างไม่หล่นเป็น 0 ตอนเน็ตล่ม
/// - [failed] จึงหมายถึง **terminal** (server ปฏิเสธ) เท่านั้น และมาคู่กับ `rejectCode`
abstract final class OutboxStatus {
  static const String queued = 'queued';
  static const String inflight = 'inflight';

  /// server รับแล้ว — ในทางปฏิบัติแถวถูกลบทิ้ง (ตารางไม่โต) ดู [LocalDb.markAcked]
  static const String acked = 'acked';

  /// `failed_terminal` — รอคนตัดสินที่จอ pending-review
  static const String failed = 'failed';
}

/// คีย์ใน [KvMeta] — เก็บ cursor / อายุข้อมูล / counter ที่ไม่ควรมีตารางเป็นของตัวเอง
abstract final class MetaKeys {
  /// `rowVersion` ล่าสุดที่ sync สำเร็จ (`GET /items?since=`)
  static const String itemsCursor = 'items.cursor';

  /// เวลาที่ดึงจาก ERP สำเร็จครั้งล่าสุด — ป้าย "ข้อมูล ณ HH:MM"
  /// (ISO-8601; **sync engine เป็นคนเขียน** ไฟล์นี้แค่ประกาศคีย์ให้ตรงกัน)
  static const String stockAsOf = 'items.stockAsOf';

  /// counter ของ [Outbox.deviceSeq] — monotonic ต่อเครื่อง
  static const String deviceSeq = 'outbox.deviceSeq';
}

// ════════════════════════════════════════════════════════════════════
// Tables
// ════════════════════════════════════════════════════════════════════

/// replica ของ item master (5–50k แถว) — สแกน/ค้นหาอ่านจากตารางนี้เท่านั้น
@DataClassName('LocalItem')
class LocalItems extends Table {
  /// `InventoryItem.ItemCode`
  TextColumn get sku => text()();

  TextColumn get name => text()();
  TextColumn get nameEn => text().nullable()();
  TextColumn get loc => text().nullable()();

  /// `MainUnits` — nullable ในตาราง แต่ [Item.unit] เป็น String → map '' ↔ null
  TextColumn get unit => text().nullable()();

  /// ⚠️ null = ไม่มีข้อมูลยอด (ห้าม default 0)
  RealColumn get onHand => real().nullable()();
  RealColumn get reserved => real().nullable()();
  RealColumn get rop => real().nullable()();

  /// ฟิลด์ผ่านทางที่ไม่มีคอลัมน์ของตัวเอง (JSON object):
  /// `updated` (ป้ายเวลาอัปเดตตาม design) · `vendor` · `lot` · `lastCountDate`
  TextColumn get specsJson => text().withDefault(const Constant('{}'))();

  /// '' = ไม่ระบุคลัง (map เป็น null ตอนคืนเป็น [Item])
  TextColumn get warehouseCode => text()();

  /// cursor ของแถว — เก็บเป็น string เพราะฝั่ง server เป็น bigint
  TextColumn get rowVersion => text()();

  /// เวลาที่เขียนแถวนี้ลง replica (ไม่ใช่เวลาที่ ERP แก้ข้อมูล — อันนั้นอยู่ใน
  /// `specsJson.updated` ซึ่งเป็นป้ายข้อความจาก server)
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {sku};
}

/// 1 SKU : N barcode — lookup ตอนสแกนเป็น exact match บน PK
@DataClassName('LocalBarcode')
@TableIndex(name: 'idx_local_barcodes_sku', columns: {#sku})
class LocalBarcodes extends Table {
  TextColumn get barcode => text()();
  TextColumn get sku => text()();

  @override
  Set<Column<Object>> get primaryKey => {barcode};
}

/// replica ของ roster — Team tab + role gate ต้องทำงานออฟไลน์ได้
@DataClassName('LocalMember')
class LocalMembers extends Table {
  TextColumn get empId => text()();
  TextColumn get name => text()();
  TextColumn get shift => text()();

  /// [Role.label] เช่น 'ADMIN' — ค่าที่อ่านไม่ออกถูก map เป็น viewer (fail-closed)
  TextColumn get role => text()();

  @override
  Set<Column<Object>> get primaryKey => {empId};
}

/// รอบนับที่เปิดอยู่ — **แถวเดียว** ([LocalDb.saveSession] ล้างก่อนเขียนทุกครั้ง)
@DataClassName('LocalSessionData')
class LocalSession extends Table {
  /// คีย์จริงของรอบนับ (⚠️ `voucherNo` ซ้ำได้ ห้ามใช้เป็นคีย์)
  TextColumn get id => text()();

  TextColumn get voucherNo => text().nullable()();
  TextColumn get zone => text().nullable()();
  TextColumn get warehouseCode => text()();
  DateTimeColumn get openedAt => dateTime()();

  /// อายุข้อมูลยอดระบบ ณ เวลาที่ freeze (`erpDataAsOf`)
  DateTimeColumn get dataAsOf => dateTime().nullable()();

  /// admin เปิดรอบตอน ERP ล่มโดยยืนยันจาก cache เก่า → UI ต้องเตือน
  BoolColumn get staleCache => boolean().withDefault(const Constant(false))();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

/// รายการในรอบนับ + ยอดระบบที่ freeze แล้ว (นับออฟไลน์ได้เต็มรูปแบบ)
@DataClassName('LocalSessionRow')
class LocalSessionRows extends Table {
  TextColumn get sessionId => text()();
  TextColumn get sku => text()();
  TextColumn get name => text()();

  /// ยอดตามระบบที่ freeze แล้ว — ERP ไม่ส่ง NULL จึง non-null
  RealColumn get systemQty => real()();

  TextColumn get unit => text().nullable()();
  TextColumn get loc => text().nullable()();

  /// โซนของแถว — ปัจจุบันเก็บโซนของรอบ ([CountRow] ยังไม่มีฟิลด์ zone รายแถว)
  TextColumn get zone => text().nullable()();

  @override
  Set<Column<Object>> get primaryKey => {sessionId, sku};
}

/// ⭐ คิวงานที่ยังไม่ซิงค์ — หัวใจของ offline-first ฝั่งเขียน
///
/// [id] = UUIDv7 = `idempotencyKey` ที่สร้าง**ตอนเข้าคิว** (ไม่ใช่ตอนส่ง)
/// → ส่งซ้ำกี่ครั้งก็ไม่นับซ้ำ (server ตอบ `duplicate`)
@DataClassName('OutboxRow')
@TableIndex(name: 'idx_outbox_due', columns: {#status, #nextRetryAt})
@TableIndex(name: 'idx_outbox_session_sku', columns: {#sessionId, #sku})
class Outbox extends Table {
  TextColumn get id => text()();

  /// ดู [OutboxType]
  TextColumn get type => text()();

  TextColumn get sessionId => text().nullable()();
  TextColumn get sku => text().nullable()();

  /// body ที่พร้อมส่งขึ้น server (JSON object)
  TextColumn get payloadJson => text()();

  /// ลำดับการนับจริงของเครื่องนี้ — monotonic, ไม่พึ่งนาฬิกา
  IntColumn get deviceSeq => integer()();

  DateTimeColumn get createdAt => dateTime()();

  /// ดู [OutboxStatus] — literal ต้องตรงกับ `OutboxStatus.queued`
  /// (เขียนตรง ๆ เพราะ `withDefault` ต้องเป็น const ที่ drift_dev อ่านออก)
  TextColumn get status => text().withDefault(const Constant('queued'))();

  IntColumn get attempts => integer().withDefault(const Constant(0))();

  /// null = ส่งได้ทันที · มีค่า = รอ backoff
  DateTimeColumn get nextRetryAt => dateTime().nullable()();

  /// ข้อความ error ล่าสุดแบบย่อ (เพื่อ debug — ไม่ใส่ข้อมูลผู้ใช้)
  TextColumn get lastError => text().nullable()();

  /// **มีค่า = terminal**: server ปฏิเสธ (เช่น `SESSION_CLOSED` / `ROLE_CHANGED`)
  /// → หลุดจากวงจร retry ไปรออยู่จอ pending-review
  TextColumn get rejectCode => text().nullable()();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

/// key-value ทั่วไป — ดูคีย์ที่ใช้ใน [MetaKeys]
@DataClassName('KvMetaRow')
class KvMeta extends Table {
  TextColumn get key => text()();
  TextColumn get value => text()();

  @override
  Set<Column<Object>> get primaryKey => {key};
}

// ════════════════════════════════════════════════════════════════════
// Database + DAO
// ════════════════════════════════════════════════════════════════════

@DriftDatabase(
  tables: [
    LocalItems,
    LocalBarcodes,
    LocalMembers,
    LocalSession,
    LocalSessionRows,
    Outbox,
    KvMeta,
  ],
)
class LocalDb extends _$LocalDb {
  /// รับ [QueryExecutor] ตรง ๆ เพื่อให้ test ใส่ `NativeDatabase.memory()` ได้
  LocalDb(super.executor);

  /// ฐานข้อมูลจริงบนเครื่อง (`tcl.sqlite` ใน application documents)
  factory LocalDb.open() => LocalDb(driftDatabase(name: databaseName));

  static const String databaseName = 'tcl';

  /// cursor ตอนยังไม่เคย sync — server ตีความว่าเอาทั้งคลัง
  static const String initialItemsCursor = '0';

  /// เพดานตัวแปรต่อ statement ของ SQLite เก่า (999) — ตัด `IN (...)` เป็นก้อน
  static const int _maxVariablesPerStatement = 400;

  static const Duration _retryBase = Duration(seconds: 2);
  static const Duration _retryCap = Duration(minutes: 5);

  /// jitter ของ backoff — ไม่ต้องใช้ `Random.secure()` (ไม่ใช่ค่าที่ต้องเดาไม่ได้)
  final Random _random = Random();

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        beforeOpen: (details) async {
          // WAL: อ่าน (สแกน/ค้นหา) ไม่ถูกบล็อกโดยการเขียนของ sync engine
          await customStatement('PRAGMA journal_mode = WAL');
        },
      );

  // ── replica: เขียน ────────────────────────────────────────────────

  /// เขียน 1 หน้าของ delta feed ลง replica แบบ atomic
  ///
  /// - upsert [items] + แทนที่ barcode ของ SKU ที่มาในหน้านี้ทั้งชุด
  ///   (barcode ที่ถูกถอดออกฝั่ง ERP ต้องหายจากเครื่องด้วย)
  /// - ลบ tombstone ทั้งใน `local_items` และ `local_barcodes`
  /// - SKU ที่มาทั้งใน [items] และ [tombstones] → ถือว่า "ยังมีอยู่" (items ชนะ)
  /// - เก็บ [nextCursor] ลง [MetaKeys.itemsCursor] (ว่าง = ไม่คืบหน้า คง cursor เดิม)
  Future<void> applyDelta({
    required List<Item> items,
    required List<String> tombstones,
    required String nextCursor,
  }) async {
    final syncedAt = DateTime.now();
    final cursor = nextCursor.trim();
    final dead = <String>{
      for (final sku in tombstones)
        if (sku.trim().isNotEmpty) sku.trim(),
    }..removeAll(items.map((item) => item.sku));

    await transaction(() async {
      for (final chunk in _chunks(dead.toList(growable: false))) {
        await (delete(localBarcodes)..where((t) => t.sku.isIn(chunk))).go();
        await (delete(localItems)..where((t) => t.sku.isIn(chunk))).go();
      }

      if (items.isNotEmpty) {
        final skus = items.map((item) => item.sku).toList(growable: false);
        await batch((b) {
          b.insertAllOnConflictUpdate(localItems, <LocalItemsCompanion>[
            for (final item in items)
              _itemCompanion(item, rowVersion: cursor, syncedAt: syncedAt),
          ]);
          for (final chunk in _chunks(skus)) {
            b.deleteWhere(localBarcodes, (t) => t.sku.isIn(chunk));
          }
          b.insertAll(
            localBarcodes,
            <LocalBarcodesCompanion>[
              for (final item in items)
                for (final code in _uniqueBarcodes(item))
                  LocalBarcodesCompanion.insert(barcode: code, sku: item.sku),
            ],
            // barcode ย้ายเจ้าของได้ (ฉลากพิมพ์ใหม่) → แถว PK เดิมต้องถูกทับ
            mode: InsertMode.insertOrReplace,
          );
        });
      }

      if (cursor.isNotEmpty) await setMeta(MetaKeys.itemsCursor, cursor);
    });
  }

  // ── replica: อ่าน ─────────────────────────────────────────────────

  /// หาสินค้าจากบาร์โค้ด — คืน `null` เมื่อไม่รู้จัก (เรื่องปกติที่หน้าสแกน)
  ///
  /// fallback: ถ้าไม่มีในตาราง barcode ให้ลองจับกับ `sku` ตรง ๆ — ฉลาก Code128
  /// ที่คลังพิมพ์เองมักเป็น `ItemCode` เปล่า ๆ (exact match, ไม่ ignore case)
  Future<Item?> itemByBarcode(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) return null;
    return transaction(() async {
      final hit = await (select(localBarcodes)
            ..where((t) => t.barcode.equals(trimmed))
            ..limit(1))
          .getSingleOrNull();
      final row = await _itemRow(hit?.sku ?? trimmed);
      if (row == null) return null;
      return _toItem(row, await _barcodesOf(row.sku));
    });
  }

  /// ค้นหาแบบ substring บน `name` / `nameEn` / `sku` (ค้นออฟไลน์)
  ///
  /// `%` และ `_` ที่ผู้ใช้พิมพ์ถูก escape → ไม่กลายเป็น wildcard
  Future<List<Item>> searchItems(String q, {int limit = 100}) async {
    final trimmed = q.trim();
    if (trimmed.isEmpty || limit <= 0) return const <Item>[];
    final pattern = '%${_escapeLike(trimmed)}%';
    return transaction(() async {
      final rows = await (select(localItems)
            ..where((t) =>
                t.name.like(pattern, escapeChar: _likeEscapeChar) |
                t.nameEn.like(pattern, escapeChar: _likeEscapeChar) |
                t.sku.like(pattern, escapeChar: _likeEscapeChar))
            ..orderBy([
              (t) => OrderingTerm.asc(t.name),
              (t) => OrderingTerm.asc(t.sku),
            ])
            ..limit(limit))
          .get();
      return _withBarcodes(rows);
    });
  }

  /// จำนวนสินค้าใน replica — 0 = ยังไม่เคยโหลด item master (จอ first-run)
  Future<int> itemCount() async {
    final total = localItems.sku.count();
    final row = await (selectOnly(localItems)..addColumns([total])).getSingle();
    return row.read(total) ?? 0;
  }

  // ── cursor / meta ─────────────────────────────────────────────────

  /// cursor สำหรับ `GET /items?since=` — [initialItemsCursor] เมื่อยังไม่เคย sync
  Future<String> itemsCursor() async {
    final value = (await meta(MetaKeys.itemsCursor))?.trim();
    return (value == null || value.isEmpty) ? initialItemsCursor : value;
  }

  Future<void> setMeta(String k, String v) async {
    await into(kvMeta).insertOnConflictUpdate(KvMetaRow(key: k, value: v));
  }

  Future<String?> meta(String k) async {
    final row = await (select(kvMeta)
          ..where((t) => t.key.equals(k))
          ..limit(1))
        .getSingleOrNull();
    return row?.value;
  }

  // ── รอบนับ ────────────────────────────────────────────────────────

  /// แทนที่รอบนับในเครื่องทั้งก้อน — `null` = ไม่มีรอบเปิด (ลบทั้งรอบ)
  ///
  /// ⚠️ **ไม่แตะ [Outbox]**: ผลนับที่ยังไม่ซิงค์ต้องอยู่รอดข้ามการปิด/เปลี่ยนรอบ
  /// (จบที่ pending-review ถ้า server ปฏิเสธ ไม่ใช่หายไปเงียบ ๆ)
  Future<void> saveSession(ActiveSession? s) async {
    final session = s;
    await transaction(() async {
      await delete(localSessionRows).go();
      await delete(localSession).go();
      if (session == null) return;
      await into(localSession).insert(LocalSessionCompanion.insert(
        id: session.id,
        warehouseCode: session.warehouseCode,
        openedAt: session.openedAt,
        voucherNo: Value(session.voucherNo),
        zone: Value(session.zone),
        dataAsOf: Value(session.dataAsOf),
        staleCache: Value(session.staleCache),
      ));
      if (session.rows.isEmpty) return;
      await batch((b) {
        b.insertAll(
          localSessionRows,
          <LocalSessionRowsCompanion>[
            for (final row in session.rows)
              LocalSessionRowsCompanion.insert(
                sessionId: session.id,
                sku: row.sku,
                name: row.name,
                systemQty: row.systemQty.toDouble(),
                unit: Value(_nullIfBlank(row.unit)),
                loc: Value(row.loc),
                zone: Value(session.zone),
              ),
          ],
          // SKU ซ้ำในรายการที่ server ส่งมา → แถวหลังทับแถวหน้า (ไม่ throw)
          mode: InsertMode.insertOrReplace,
        );
      });
    });
  }

  /// รอบนับที่เก็บไว้ในเครื่อง — เรียงแถวตาม `sku` ให้ผลเดิมทุกครั้ง
  Future<ActiveSession?> activeSession() async {
    return transaction(() async {
      final head = await (select(localSession)..limit(1)).getSingleOrNull();
      if (head == null) return null;
      final rows = await (select(localSessionRows)
            ..where((t) => t.sessionId.equals(head.id))
            ..orderBy([(t) => OrderingTerm.asc(t.sku)]))
          .get();
      final warehouse = _nullIfBlank(head.warehouseCode);
      return ActiveSession(
        id: head.id,
        voucherNo: head.voucherNo,
        zone: head.zone,
        warehouseCode: head.warehouseCode,
        openedAt: head.openedAt,
        dataAsOf: head.dataAsOf,
        staleCache: head.staleCache,
        rows: <CountRow>[
          for (final row in rows)
            CountRow(
              sku: row.sku,
              name: row.name,
              systemQty: row.systemQty,
              unit: row.unit ?? '',
              loc: row.loc,
              warehouse: warehouse,
            ),
        ],
      );
    });
  }

  // ── ⭐ outbox ─────────────────────────────────────────────────────

  /// เข้าคิวผลนับ 1 บรรทัด (optimistic — UI toast ได้ทันทีแม้ออฟไลน์)
  ///
  /// - `id` = UUIDv7 = `idempotencyKey` ที่ server ใช้กันนับซ้ำ
  /// - `deviceSeq` = ค่าถัดไปจาก counter ใน [KvMeta] (ไม่ใช่เวลาเครื่อง)
  /// - แถวที่ยัง [OutboxStatus.queued] ของ (`sessionId`, `sku`) เดิมถูก**แทนที่**
  ///   (ผู้ใช้แก้ตัวเลขก่อนกดส่ง → ส่งครั้งเดียว) แถวที่ inflight/terminal ไม่ถูกแตะ
  Future<void> enqueueCountLine({
    required String sessionId,
    required String sku,
    required num countedQty,
  }) async {
    final now = DateTime.now();
    await transaction(() async {
      await (delete(outbox)
            ..where((t) =>
                t.type.equals(OutboxType.countLine) &
                t.sessionId.equals(sessionId) &
                t.sku.equals(sku) &
                t.status.equals(OutboxStatus.queued) &
                t.rejectCode.isNull()))
          .go();
      final id = newUuidV7();
      final seq = await _nextDeviceSeq();
      final line = SubmitLine(
        idempotencyKey: id,
        sku: sku,
        countedQty: countedQty,
        countedAt: now,
        deviceSeq: seq,
      );
      await into(outbox).insert(OutboxCompanion.insert(
        id: id,
        type: OutboxType.countLine,
        payloadJson: jsonEncode(line.toJson()),
        deviceSeq: seq,
        createdAt: now,
        sessionId: Value(sessionId),
        sku: Value(sku),
      ));
    });
  }

  /// เข้าคิวสถิติการสแกน — ไม่ใช่ผลนับ ทิ้งได้ถ้า server ปฏิเสธ
  ///
  /// [sku] เป็น null ได้ (บาร์โค้ดที่แอปอ่านได้แต่แม็ปกับสินค้าไม่ได้ — ops ต้องเห็น)
  Future<void> enqueueScanEvent({
    required String barcode,
    String? sku,
  }) async {
    final trimmed = barcode.trim();
    if (trimmed.isEmpty) return;
    final now = DateTime.now();
    await transaction(() async {
      final id = newUuidV7();
      final seq = await _nextDeviceSeq();
      final event = ScanEventInput(barcode: trimmed, sku: sku, scannedAt: now);
      await into(outbox).insert(OutboxCompanion.insert(
        id: id,
        type: OutboxType.scanEvent,
        payloadJson: jsonEncode(event.toJson()),
        deviceSeq: seq,
        createdAt: now,
        sku: Value(sku),
      ));
    });
  }

  /// งานที่ถึงคิวส่ง — เรียงตาม [Outbox.deviceSeq] (ลำดับการนับจริง)
  ///
  /// ตัดแถว terminal (`rejectCode != null`) ออกเสมอ: งานนั้นรอคนตัดสิน ไม่ใช่รอ retry
  Future<List<OutboxRow>> dueForSync({int limit = 200}) {
    final now = DateTime.now();
    return (select(outbox)
          ..where((t) =>
              t.status.isIn([OutboxStatus.queued, OutboxStatus.failed]) &
              t.rejectCode.isNull() &
              (t.nextRetryAt.isNull() | t.nextRetryAt.isSmallerOrEqualValue(now)))
          ..orderBy([(t) => OrderingTerm.asc(t.deviceSeq)])
          ..limit(limit))
        .get();
  }

  /// จำนวนงานค้างส่งสำหรับ badge — queued + inflight
  /// (retry ยังนับอยู่เพราะ [markRetry] คงสถานะ queued)
  Future<int> queueDepth() async {
    final total = outbox.id.count();
    final row = await (selectOnly(outbox)
          ..addColumns([total])
          ..where(outbox.status
              .isIn([OutboxStatus.queued, OutboxStatus.inflight])))
        .getSingle();
    return row.read(total) ?? 0;
  }

  Future<void> markInflight(List<String> ids) async {
    if (ids.isEmpty) return;
    await transaction(() async {
      for (final chunk in _chunks(ids)) {
        await (update(outbox)..where((t) => t.id.isIn(chunk))).write(
          const OutboxCompanion(status: Value(OutboxStatus.inflight)),
        );
      }
    });
  }

  /// server รับแล้ว (`accepted` หรือ `duplicate`) → **ลบทิ้ง** ไม่ให้ตารางโต
  Future<void> markAcked(List<String> ids) async {
    if (ids.isEmpty) return;
    await transaction(() async {
      for (final chunk in _chunks(ids)) {
        await (delete(outbox)..where((t) => t.id.isIn(chunk))).go();
      }
    });
  }

  /// ส่งไม่สำเร็จแบบชั่วคราว (เน็ตหลุด / server ไม่ตอบ) → เลื่อนไปลองใหม่
  ///
  /// คงสถานะ [OutboxStatus.queued] ไว้ (งานยังค้างอยู่จริง badge ต้องไม่หล่นเป็น 0)
  /// backoff 2 วิ → เพดาน 5 นาที + jitter ±20% กันทุกเครื่องยิงพร้อมกันตอน WiFi กลับมา
  /// · ไม่แตะแถว terminal
  Future<void> markRetry(
    String id, {
    required String error,
    required int attempts,
  }) async {
    await (update(outbox)
          ..where((t) => t.id.equals(id) & t.rejectCode.isNull()))
        .write(OutboxCompanion(
      status: const Value(OutboxStatus.queued),
      attempts: Value(attempts),
      nextRetryAt: Value(DateTime.now().add(_backoff(attempts))),
      lastError: Value(_shortError(error)),
    ));
  }

  /// [markRetry] แบบหลายแถวใน transaction เดียว
  ///
  /// อ่าน `attempts` ปัจจุบันจาก DB แล้ว +1 เอง — caller (SyncEngine) ไม่ต้องถือค่านี้
  /// (ทั้งชุดกลับเข้าคิวได้อย่างปลอดภัยเพราะทุกแถวมี idempotencyKey แล้ว)
  Future<void> markRetryAll(List<String> ids, {String error = ''}) async {
    if (ids.isEmpty) return;
    await transaction(() async {
      final rows = await (select(outbox)..where((t) => t.id.isIn(ids))).get();
      for (final row in rows) {
        if (row.rejectCode != null) continue; // ถูกปฏิเสธถาวรแล้ว ไม่ต้อง retry
        await markRetry(row.id, error: error, attempts: row.attempts + 1);
      }
    });
  }

  /// [markRejected] แบบหลายแถวใน transaction เดียว
  Future<void> markRejectedAll(List<String> ids, {required String code}) async {
    if (ids.isEmpty) return;
    await transaction(() async {
      for (final id in ids) {
        await markRejected(id, code: code);
      }
    });
  }

  /// server ปฏิเสธถาวร (`SESSION_CLOSED` / `ROLE_CHANGED` / ...)
  ///
  /// ⚠️ **ห้ามลบ** — ค้างไว้ให้จอ pending-review ([rejectedRows]) งานพนักงานต้องไม่
  /// หายเงียบ ๆ · `rejectCode` ต้องไม่ว่างเพื่อให้หลุดจากวงจร retry จริง
  Future<void> markRejected(String id, {required String code}) async {
    final reason = code.trim();
    await (update(outbox)..where((t) => t.id.equals(id))).write(OutboxCompanion(
      status: const Value(OutboxStatus.failed),
      rejectCode: Value(reason.isEmpty ? 'REJECTED' : reason),
      nextRetryAt: const Value(null),
    ));
  }

  /// งานที่รอคนตัดสินที่จอ pending-review
  /// แถวที่ถูกปฏิเสธถาวร ในรูปที่จอ pending-review ใช้ได้ตรง ๆ
  ///
  /// แกะ `payloadJson` **ที่นี่จุดเดียว** — UI ไม่ต้องรู้รูปแบบ payload ของ outbox
  Future<List<RejectedRow>> rejectedForReview() async {
    final rows = await rejectedRows();
    return rows.map(RejectedRow.fromOutbox).toList(growable: false);
  }

  Future<List<OutboxRow>> rejectedRows() {
    return (select(outbox)
          ..where((t) => t.rejectCode.isNotNull())
          ..orderBy([(t) => OrderingTerm.asc(t.deviceSeq)]))
        .get();
  }

  /// ทิ้งงานที่ถูกปฏิเสธ — เฉพาะแถว terminal (กันลบงานที่ยังรอส่งอยู่)
  Future<void> discardRejected(String id) async {
    await (delete(outbox)
          ..where((t) => t.id.equals(id) & t.rejectCode.isNotNull()))
        .go();
  }

  /// คืนแถวที่ค้างสถานะ inflight กลับเป็น queued — เรียกตอนเริ่ม sync engine
  ///
  /// แอปถูก kill กลางการส่ง → แถวจะค้าง inflight และไม่เข้า [dueForSync] อีกเลย
  /// การส่งซ้ำปลอดภัยเพราะมี `idempotencyKey` (server ตอบ `duplicate`)
  Future<int> reclaimInflight() {
    return (update(outbox)
          ..where((t) => t.status.equals(OutboxStatus.inflight)))
        .write(const OutboxCompanion(
      status: Value(OutboxStatus.queued),
      nextRetryAt: Value(null),
    ));
  }

  /// badge จำนวนงานค้าง — drift ยิงค่าใหม่ทุกครั้งที่ตาราง outbox เปลี่ยน
  Stream<int> watchQueueDepth() {
    final total = outbox.id.count();
    final query = selectOnly(outbox)
      ..addColumns([total])
      ..where(
          outbox.status.isIn([OutboxStatus.queued, OutboxStatus.inflight]));
    return query.map((row) => row.read(total) ?? 0).watchSingle();
  }

  // ── roster ────────────────────────────────────────────────────────

  /// แทนที่ roster ทั้งชุด (delta ของ members มาทั้งก้อนต่อรอบ sync)
  Future<void> replaceMembers(List<Member> members) async {
    await transaction(() async {
      await delete(localMembers).go();
      if (members.isEmpty) return;
      await batch((b) {
        b.insertAll(
          localMembers,
          <LocalMembersCompanion>[
            for (final m in members)
              LocalMembersCompanion.insert(
                empId: m.empId,
                name: m.name,
                shift: m.shift,
                role: m.role.label,
              ),
          ],
          mode: InsertMode.insertOrReplace,
        );
      });
    });
  }

  Future<List<Member>> allMembers() async {
    final rows = await (select(localMembers)
          ..orderBy([(t) => OrderingTerm.asc(t.name)]))
        .get();
    return <Member>[
      for (final row in rows)
        Member(
          name: row.name,
          empId: row.empId,
          shift: row.shift,
          role: _roleFromLabel(row.role),
        ),
    ];
  }

  // ── internal ──────────────────────────────────────────────────────

  /// ค่าถัดไปของ counter — ต้องถูกเรียก**ภายใน** transaction ของผู้เรียก
  /// เพื่อให้ read-modify-write เป็น atomic (สแกนรัว ๆ ต้องไม่ได้ seq ซ้ำ)
  Future<int> _nextDeviceSeq() async {
    final current = int.tryParse((await meta(MetaKeys.deviceSeq)) ?? '') ?? 0;
    final next = current + 1;
    await setMeta(MetaKeys.deviceSeq, next.toString());
    return next;
  }

  Future<LocalItem?> _itemRow(String sku) {
    return (select(localItems)
          ..where((t) => t.sku.equals(sku))
          ..limit(1))
        .getSingleOrNull();
  }

  Future<List<String>> _barcodesOf(String sku) async {
    final rows = await (select(localBarcodes)
          ..where((t) => t.sku.equals(sku))
          ..orderBy([(t) => OrderingTerm.asc(t.barcode)]))
        .get();
    return <String>[for (final row in rows) row.barcode];
  }

  /// เติม barcode ให้หลายแถวด้วย query เดียวต่อก้อน (ไม่ยิงรายแถว)
  Future<List<Item>> _withBarcodes(List<LocalItem> rows) async {
    if (rows.isEmpty) return const <Item>[];
    final grouped = <String, List<String>>{};
    final skus = rows.map((row) => row.sku).toList(growable: false);
    for (final chunk in _chunks(skus)) {
      final found = await (select(localBarcodes)
            ..where((t) => t.sku.isIn(chunk))
            ..orderBy([(t) => OrderingTerm.asc(t.barcode)]))
          .get();
      for (final row in found) {
        (grouped[row.sku] ??= <String>[]).add(row.barcode);
      }
    }
    return <Item>[
      for (final row in rows) _toItem(row, grouped[row.sku] ?? const <String>[]),
    ];
  }

  Duration _backoff(int attempts) {
    final tries = attempts < 1 ? 1 : attempts;
    final cap = _retryCap.inMilliseconds;
    var ms = _retryBase.inMilliseconds;
    for (var i = 1; i < tries && ms < cap; i++) {
      ms *= 2;
    }
    if (ms > cap) ms = cap;
    final jitter = (ms * 0.2 * (_random.nextDouble() * 2 - 1)).round();
    final total = ms + jitter;
    return Duration(milliseconds: total < 500 ? 500 : total);
  }
}

// ════════════════════════════════════════════════════════════════════
// Mapping helpers
// ════════════════════════════════════════════════════════════════════

/// อักขระ escape ของ `LIKE` — ทำให้ `%` / `_` ที่ผู้ใช้พิมพ์เป็นตัวอักษรธรรมดา
const String _likeEscapeChar = r'\';

String _escapeLike(String value) => value
    .replaceAll(_likeEscapeChar, r'\\')
    .replaceAll('%', r'\%')
    .replaceAll('_', r'\_');

String? _nullIfBlank(String? value) {
  final trimmed = value?.trim();
  return (trimmed == null || trimmed.isEmpty) ? null : trimmed;
}

/// error ที่เก็บไว้ debug — ตัดสั้นและไม่มีข้อมูลผู้ใช้ (กติกา: ห้าม log/เก็บ PII)
String? _shortError(String error) {
  final trimmed = error.trim();
  if (trimmed.isEmpty) return null;
  return trimmed.length <= 200 ? trimmed : trimmed.substring(0, 200);
}

/// role ที่อ่านไม่ออก → viewer (fail-closed: ห้ามเดาเป็นสิทธิ์ที่เขียนได้)
Role _roleFromLabel(String label) {
  final normalized = label.trim().toUpperCase();
  for (final role in Role.values) {
    if (role.label == normalized) return role;
  }
  return Role.viewer;
}

/// barcode ของสินค้า 1 ตัว — trim, ตัดค่าว่าง, ตัดซ้ำ (คงลำดับเดิม)
List<String> _uniqueBarcodes(Item item) {
  final seen = <String>{};
  final out = <String>[];
  for (final raw in item.barcodes) {
    final code = raw.trim();
    if (code.isEmpty || !seen.add(code)) continue;
    out.add(code);
  }
  return out;
}

LocalItemsCompanion _itemCompanion(
  Item item, {
  required String rowVersion,
  required DateTime syncedAt,
}) {
  // ฟิลด์ที่ยังไม่มีคอลัมน์ของตัวเอง — เก็บผ่านทางไว้ให้ round-trip ครบ
  final specs = <String, String>{
    if (item.updated != null) 'updated': item.updated!,
    if (item.vendor != null) 'vendor': item.vendor!,
    if (item.lot != null) 'lot': item.lot!,
    if (item.lastCountDate != null) 'lastCountDate': item.lastCountDate!,
  };
  return LocalItemsCompanion.insert(
    sku: item.sku,
    name: item.name,
    nameEn: Value(item.nameEn),
    loc: Value(item.loc),
    unit: Value(_nullIfBlank(item.unit)),
    // ⚠️ null คงเป็น null — ห้ามเป็น 0 (ไม่มีข้อมูลยอด ≠ ยอดศูนย์)
    onHand: Value(item.onHand?.toDouble()),
    reserved: Value(item.reserved?.toDouble()),
    rop: Value(item.rop?.toDouble()),
    specsJson: Value(specs.isEmpty ? '{}' : jsonEncode(specs)),
    warehouseCode: item.warehouse ?? '',
    rowVersion: rowVersion,
    updatedAt: syncedAt,
  );
}

Item _toItem(LocalItem row, List<String> barcodes) {
  final specs = _decodeSpecs(row.specsJson);
  return Item(
    sku: row.sku,
    name: row.name,
    unit: row.unit ?? '',
    barcodes: barcodes,
    nameEn: row.nameEn,
    loc: row.loc,
    warehouse: _nullIfBlank(row.warehouseCode),
    onHand: row.onHand,
    reserved: row.reserved,
    rop: row.rop,
    updated: specs['updated'],
    vendor: specs['vendor'],
    lot: specs['lot'],
    lastCountDate: specs['lastCountDate'],
  );
}

Map<String, String> _decodeSpecs(String raw) {
  if (raw.trim().isEmpty) return const <String, String>{};
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map) {
      return <String, String>{
        for (final entry in decoded.entries)
          if (entry.key is String && entry.value is String)
            entry.key as String: entry.value as String,
      };
    }
  } on FormatException {
    // specsJson เสีย → ถือว่าไม่มีข้อมูลเสริม (ห้ามทำให้การสแกนพังทั้งจอ)
  }
  return const <String, String>{};
}

/// ตัด list เป็นก้อนไม่เกิน [LocalDb._maxVariablesPerStatement] ต่อ `IN (...)`
Iterable<List<T>> _chunks<T>(List<T> values) {
  return <List<T>>[
    for (var i = 0; i < values.length; i += LocalDb._maxVariablesPerStatement)
      values.sublist(
        i,
        min(i + LocalDb._maxVariablesPerStatement, values.length),
      ),
  ];
}

// ════════════════════════════════════════════════════════════════════
// Provider
// ════════════════════════════════════════════════════════════════════

/// งานในคิวที่ backend ปฏิเสธถาวร — รูปสำหรับจอ pending-review
///
/// ฟิลด์จำนวน/เวลาเป็น nullable: payload ที่พังหรือเก่าจะได้ null
/// **ห้ามแปลงเป็น 0** (จำนวนที่พนักงานนับไม่เท่ากับ "นับได้ 0")
class RejectedRow {
  const RejectedRow({
    required this.id,
    required this.sku,
    required this.code,
    this.countedQty,
    this.countedAt,
    this.sessionId,
    this.lastError,
  });

  factory RejectedRow.fromOutbox(OutboxRow row) {
    num? qty;
    DateTime? at;
    try {
      final decoded = jsonDecode(row.payloadJson);
      if (decoded is Map<String, dynamic>) {
        final raw = decoded['countedQty'];
        qty = raw is num ? raw : num.tryParse('$raw');
        final rawAt = decoded['countedAt'];
        if (rawAt is String) at = DateTime.tryParse(rawAt);
      }
    } on FormatException {
      // payload พัง — ยังต้องแสดงรายการให้ผู้ใช้เห็นว่ามีงานค้าง
    }
    return RejectedRow(
      id: row.id,
      sku: row.sku ?? '',
      code: row.rejectCode ?? 'REJECTED',
      countedQty: qty,
      countedAt: at ?? row.createdAt,
      sessionId: row.sessionId,
      lastError: row.lastError,
    );
  }

  final String id;
  final String sku;

  /// เหตุผลจาก backend: SESSION_CLOSED · ROLE_CHANGED · SKU_NOT_FOUND · ...
  final String code;
  final num? countedQty;
  final DateTime? countedAt;
  final String? sessionId;
  final String? lastError;
}

final localDbProvider = Provider<LocalDb>((ref) {
  final db = LocalDb.open();
  ref.onDispose(db.close);
  return db;
});
