/// SyncEngine — ตัวเชื่อม replica ในเครื่อง (drift) กับ backend
///
/// หน้าที่ 3 ทาง (architecture.md §6):
/// 1. **pull items** — delta feed `GET /items?since=` ทีละหน้าลง replica + tombstone
/// 2. **pull session** — รอบนับ active + frozen qty (นับออฟไลน์ได้เต็มรูปแบบ)
/// 3. **drain outbox** — ส่งคิวงานเขียนขึ้น backend แล้วอ่าน**ผลรายบรรทัด**
///
/// ⚠️ กติกาที่มาจากหน้างานจริง (คลังมีจุดอับสัญญาณ):
/// - **สถานะ WiFi ไม่ใช่คำตอบว่า server ถึงได้** — AP คลังแจก lease บน VLAN ที่
///   route ไม่ถึง server ได้ → `connectivity_plus` เป็นเพียง "คำใบ้" ก่อน sync ทุกครั้ง
///   ต้อง **probe** ด้วย `GET /sync/status` (timeout สั้น) ถ้าไม่ผ่าน = ถือว่าออฟไลน์
/// - **ห้าม throw** ออกจาก [pullItems] / [pullSession] / [drainOutbox] — ถูกเรียกจาก
///   timer / lifecycle ที่ไม่มีใครรับ error → คืน [SyncOutcome] เสมอ
/// - `duplicate` = **สำเร็จ** (ส่งซ้ำของบรรทัดที่ backend รับไปแล้ว) ไม่ใช่ error
/// - `rejected` = ค้างไว้ให้จอ pending-review ตัดสิน **ห้ามลบ** (งานต้องไม่หายเงียบ ๆ)
/// - `SESSION_EXPIRED` = หยุด drain ทั้งรอบแล้วคืน reason ให้ชั้น UI พาไป login
///   — **ห้าม mark rejected** เพราะไม่ใช่ความผิดของข้อมูลในคิว
/// - ห้ามแปลง null → 0 ในฟิลด์ยอด: payload ที่อ่าน `countedQty` ไม่ได้ถือว่า
///   malformed (เข้า pending-review) ไม่ใช่ "นับได้ 0"
/// - **เอกสารนับ (`count_doc`) ยิงทีละใบ 1 request เสมอ** — ห้ามรวมหลายใบ ห้ามแตกใบ
///   · 409 `SYSTEM_QTY_DRIFT` ไม่ใช่ terminal: server rollback ทั้งใบแล้ว จึงคืนบรรทัด
///   กลับเป็น draft พร้อมยอดระบบใหม่ให้คนยืนยันอีกรอบด้วย `documentId` เดิม
/// - ⚠️ ห้าม log บาร์โค้ด / ผลนับ / deviceId / token (เครื่องคลังใช้ร่วมกันหลายกะ)
///
/// **สัญญาที่ไฟล์นี้ใช้จาก `local_db.dart`** (ตรงตามสเปคของชั้น LocalDb):
/// ```dart
/// Future<String> readCursor();                       // sync cursor (row_version) จาก kv_meta
/// Future<void>   applyDelta({required List<Item> items,
///                            required List<String> tombstones,
///                            required String cursor});
/// Future<void>   saveSession(ActiveSession? session); // null = ลบรอบในเครื่อง
/// Future<List<OutboxRow>> dueForSync();              // row: id · type · sessionId · payload · deviceSeq
/// Future<void>   markInflight(List<String> ids);
/// Future<void>   markAcked(List<String> ids);
/// Future<void>   markRejected(List<String> ids, {String? code});
/// Future<void>   markRetryAll(List<String> ids);        // backoff + jitter คิดในชั้น LocalDb
/// Stream<int>    watchQueueDepth();
/// ```
/// ชนิดของแถว outbox ไม่ถูกอ้างชื่อในไฟล์นี้ (ใช้ type inference) — จึงผูกกับ
/// **ชื่อฟิลด์** เท่านั้น ไม่ผูกกับชื่อคลาส
library;

import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api_client.dart';
import '../data/stock_repository.dart';
import '../state/app_state.dart';
import 'local_db.dart';

// ════════════════════════════════════════════════════════════════════
// 1. ConnState + SyncOutcome
// ════════════════════════════════════════════════════════════════════

/// สถานะการเชื่อมต่อ **ที่ยืนยันด้วย probe แล้ว** (ไม่ใช่สถานะ link ของ WiFi)
///
/// [unknown] = ยังไม่เคย probe ในรอบชีวิตนี้ (UI แสดงป้ายกลาง ๆ ไม่ต้องเตือนแดง)
enum ConnState { online, offline, unknown }

/// ผลของ sync หนึ่งขา — ไม่โยน exception ออกไปไหน
@immutable
class SyncOutcome {
  const SyncOutcome({
    this.ok = true,
    this.reason,
    this.pushed = 0,
    this.rejected = 0,
    this.pulled = 0,
    this.hasMore = false,
  });

  /// true = ขานี้ทำงานจบตามปกติ (อาจไม่มีอะไรให้ทำก็ได้)
  final bool ok;

  /// เหตุผลเมื่อ [ok] = false — เป็น **code** ไม่ใช่ข้อความบนจอ
  /// (ชั้น UI แปลเป็นข้อความไทยตาม design เอง)
  final String? reason;

  /// บรรทัดที่ backend รับแล้ว (accepted + duplicate)
  final int pushed;

  /// บรรทัดที่ถูกปฏิเสธ → ค้างในคิวให้จอ pending-review
  final int rejected;

  /// แถวที่ดึงลงเครื่อง (item + tombstone หรือรายการในรอบนับ)
  final int pulled;

  /// ยังมีงานเหลือให้รอบถัดไปทำต่อ (delta feed ยังไม่หมด / ส่งไม่ครบ)
  final bool hasMore;

  // ── reason codes ──────────────────────────────────────────────────

  /// probe ไม่ผ่าน / transport พัง — ยังไม่ต้องเตือนผู้ใช้ว่างานพัง
  static const String reasonOffline = 'OFFLINE';

  /// ชั้น UI ต้องพาไป login (ใช้ code เดียวกับ [ApiException] เพื่อเทียบง่าย)
  static const String reasonSessionExpired = ApiException.codeSessionExpired;

  /// รอบก่อนยังไม่จบ — ข้ามรอบนี้ (ไม่ใช่ความผิดพลาด)
  static const String reasonBusy = 'BUSY';

  /// 5xx — ลองใหม่ได้
  static const String reasonServer = 'SERVER';

  /// สัญญาฝั่ง server เพี้ยน (เช่น cursor ไม่ขยับแต่บอกว่ายังมีต่อ) — เป็นบั๊ก ไม่ใช่เน็ต
  static const String reasonContract = 'CONTRACT';

  /// error ที่ไม่คาด (DB บนเครื่อง / รูปร่างข้อมูลผิด) — กันไม่ให้หลุดออกจาก background
  static const String reasonUnexpected = 'UNEXPECTED';

  /// ชั้น UI ต้องพาไปหน้า login
  bool get needsReauth => reason == reasonSessionExpired;

  /// ออฟไลน์อยู่ — แสดงป้ายสถานะเฉย ๆ ไม่ใช่ error ที่ต้องให้ผู้ใช้ทำอะไร
  bool get isOffline => reason == reasonOffline;
}

// ════════════════════════════════════════════════════════════════════
// 2. SyncEngine
// ════════════════════════════════════════════════════════════════════

/// ตัวขับ sync ทั้งหมด — มีอายุเท่ากับแอป (ดู [syncEngineProvider])
class SyncEngine with WidgetsBindingObserver {
  SyncEngine({
    required this.localDb,
    required this.catalogRepository,
    required this.countRepository,
    required this.syncRepository,
    Connectivity? connectivity,
    this.onDraftsRestored,
    this.onDocumentSubmitted,
  }) : _connectivity = connectivity ?? Connectivity();

  final LocalDb localDb;
  final CatalogRepository catalogRepository;
  final CountRepository countRepository;
  final SyncRepository syncRepository;
  final Connectivity _connectivity;

  /// เรียกเมื่อบรรทัดของเอกสารถูกคืนกลับเป็น draft (409 `SYSTEM_QTY_DRIFT`)
  ///
  /// ชั้น state ต้องอ่าน `count_drafts` ใหม่ ไม่งั้นแถบ 'คีย์แล้วยังไม่ส่ง'
  /// กับจอ 'รอส่ง' จะยังว่างทั้งที่งานกลับมาอยู่ในเครื่องแล้ว
  final void Function()? onDraftsRestored;

  /// เรียกเมื่อเอกสารนับ 1 ใบถูกบันทึกฝั่ง server สำเร็จ (200) — [message] คือ
  /// ข้อความไทยพร้อมโชว์ (`CountDocumentErp.toastTh`)
  ///
  /// ⚠️ การส่งเอกสารเกิดใน background: ถ้าไม่ส่งต่อออกไป **ไม่มีใครได้เห็น**
  /// `erp.status` เลย ทั้งที่ทั้งเส้นทางนี้มีขึ้นเพื่อให้พนักงานรู้ว่า "เข้า ERP แล้วหรือยัง"
  /// · ข้อความแยก "บันทึกผลนับแล้ว" (สำเร็จเสมอ) ออกจาก "เข้า ERP แล้ว" (ตาม status)
  final void Function(String message)? onDocumentSubmitted;

  // ── ชนิดงานในคิว (ตรงกับที่ฝั่ง enqueue เขียนลง outbox.type) ──
  static const String typeCountLine = 'count_line';
  static const String typeScanEvent = 'scan_event';

  /// เอกสารนับแบบไม่มีรอบทั้งใบ — **1 แถว = 1 request** ห้ามรวม/ห้ามแตก
  static const String typeCountDoc = 'count_doc';

  // ── code ที่ไฟล์นี้ตั้งเองตอน mark rejected ──
  /// payload ในคิวอ่านไม่ได้/ไม่ครบ — เป็นบั๊กฝั่งเรา แต่ต้องให้คนเห็น ไม่ใช่ลบทิ้ง
  static const String codeMalformedPayload = 'MALFORMED_PAYLOAD';

  /// บรรทัดผลนับที่ไม่มี sessionId — ส่งขึ้น backend ไม่ได้เลย
  static const String codeMissingSession = 'MISSING_SESSION';

  /// backend ตอบ rejected แต่ไม่บอก code
  static const String codeRejectedUnknown = 'REJECTED';

  /// HTTP status ที่ยิงซ้ำแล้วได้ผลเหมือนเดิม → terminal (เข้าจอ pending-review)
  ///
  /// 401 (session หมด) · 408 · 429 (throttle) · 5xx **ไม่อยู่ในกลุ่มนี้** — พวกนั้น
  /// ลองใหม่แล้วผ่านได้ การ mark terminal จะทำให้เอกสารไปกองรอคนโดยไม่จำเป็น
  static bool _isTerminalStatus(int? status) =>
      status != null &&
      status >= 400 &&
      status < 500 &&
      status != 401 &&
      status != 408 &&
      status != 429;

  /// timeout ของ probe — สั้นกว่า dio ทั้งก้อน เพราะคำถามคือ "ถึง server ไหม"
  /// ไม่ใช่ "โหลดข้อมูลเสร็จไหม" (จุดอับสัญญาณต้องรู้ผลเร็ว)
  static const Duration probeTimeout = Duration(seconds: 5);

  /// fallback timer — connectivity event ในคลังไม่ครบ (roaming ระหว่าง AP)
  static const Duration pollInterval = Duration(minutes: 2);

  /// เพดานหน้าต่อรอบ = 40 × 500 แถว (20k) — กัน loop ไม่จบบนเครื่องช้า
  /// เหลือให้รอบถัดไปทำต่อจาก cursor ที่ persist ไว้แล้ว
  static const int maxPagesPerRun = 40;

  /// เพดานแถว outbox ต่อรอบ drain (ที่เหลือรอรอบถัดไป)
  static const int maxRowsPerDrain = 1000;

  /// scan_event ต่อ 1 request (`POST /items/scan-events` ไม่ตัดชุดให้เอง)
  static const int scanEventsPerRequest = 200;

  final StreamController<ConnState> _connCtrl =
      StreamController<ConnState>.broadcast();

  ConnState _conn = ConnState.unknown;
  SyncStatus? _lastStatus;

  StreamSubscription<List<ConnectivityResult>>? _linkSub;
  Timer? _timer;
  Future<void>? _inFlight;
  bool _draining = false;
  bool _started = false;

  /// สถานะล่าสุดที่ยืนยันด้วย probe
  ConnState get connState => _conn;

  /// สตรีมสำหรับป้ายสถานะบน UI — ผู้ฟังใหม่ได้ค่าปัจจุบันทันที
  Stream<ConnState> get connStateStream async* {
    yield _conn;
    yield* _connCtrl.stream;
  }

  /// ผล `GET /sync/status` ครั้งล่าสุด — ใช้ทำป้าย 'ข้อมูล ณ HH:MM' / เตือน ERP ล่ม
  SyncStatus? get lastStatus => _lastStatus;

  // ── นโยบายการทำงาน ────────────────────────────────────────────────

  /// เริ่มจับสัญญาณ: lifecycle (กลับ foreground) + connectivity hint + timer
  void start() {
    if (_started) return;
    _started = true;
    WidgetsBinding.instance.addObserver(this);
    _linkSub = _connectivity.onConnectivityChanged
        .listen(_onLinkChanged, onError: _swallow);
    _timer = Timer.periodic(pollInterval, (_) => _kick(drainFirst: false));
    // รอบแรกทันทีตอนเปิดแอป — งานค้างจากกะก่อนต้องขึ้นก่อน
    _kick(drainFirst: true);
  }

  /// หยุดตัวจับสัญญาณ (รอบที่กำลังวิ่งอยู่ปล่อยให้จบเอง — ไม่ตัดกลางทาง
  /// เพราะแถว inflight ต้องได้ mark ปิดท้าย)
  void stop() {
    if (!_started) return;
    _started = false;
    WidgetsBinding.instance.removeObserver(this);
    _linkSub?.cancel();
    _linkSub = null;
    _timer?.cancel();
    _timer = null;
  }

  void dispose() {
    stop();
    _connCtrl.close();
  }

  /// พนักงานเดินออกจากจุดอับแล้วเปิดแอป = จังหวะที่ต้อง drain ทันที
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _kick(drainFirst: true);
  }

  /// sync ครบทุกขา — **items ก่อน session** เพราะแถวในรอบนับอ้าง sku
  ///
  /// กัน sync ซ้อน: ถ้ารอบก่อนยังไม่จบ จะได้ future เดิมกลับไป (ไม่เริ่มรอบใหม่)
  Future<void> syncAll() => _guarded(() => _run(drainFirst: false));

  // ── 3 ขาของ sync ──────────────────────────────────────────────────

  /// ดึง delta feed ทีละหน้าจนหมด หรือจนถึงเพดาน [maxPagesPerRun]
  Future<SyncOutcome> pullItems() async {
    var pulled = 0;
    var pages = 0;
    var hasMore = false;
    try {
      var cursor = await localDb.itemsCursor();
      while (pages < maxPagesPerRun) {
        final page = await catalogRepository.fetchSince(
          cursor: cursor,
          limit: CatalogRepository.defaultPageSize,
        );
        // applyDelta เขียน items + tombstone + cursor ใน transaction เดียว
        // (ล้มกลางทางแล้ว cursor ต้องไม่ขยับเกินข้อมูลที่ลงจริง)
        await localDb.applyDelta(
          items: page.items,
          tombstones: page.tombstones,
          nextCursor: page.nextCursor,
        );
        pulled += page.items.length + page.tombstones.length;
        pages += 1;
        hasMore = page.hasMore;
        if (!hasMore) break;
        if (page.nextCursor == cursor) {
          // cursor ไม่ขยับแต่บอกว่ายังมีต่อ = สัญญาฝั่ง server เพี้ยน
          // หยุดรอบนี้ทันที (ถ้าวนต่อคือ infinite loop กินแบตกลางคลัง)
          return SyncOutcome(
            ok: false,
            reason: SyncOutcome.reasonContract,
            pulled: pulled,
            hasMore: true,
          );
        }
        cursor = page.nextCursor;
      }
    } on ApiException catch (error) {
      return SyncOutcome(
        ok: false,
        reason: _reasonFor(error),
        pulled: pulled,
        hasMore: true,
      );
    } on Object catch (_) {
      return SyncOutcome(
        ok: false,
        reason: SyncOutcome.reasonUnexpected,
        pulled: pulled,
        hasMore: true,
      );
    }
    return SyncOutcome(ok: true, pulled: pulled, hasMore: hasMore);
  }

  /// ดึงรอบนับ active ลงเครื่อง — `null` = ไม่มีรอบเปิด → ลบรอบในเครื่อง
  ///
  /// (รอบถูกปิดตอนเราออฟไลน์อยู่ก็มาทางนี้ — ผลนับที่ค้างในคิวยังอยู่ครบ
  /// backend จะตอบ `rejected: SESSION_CLOSED` ให้เข้าจอ pending-review เอง)
  Future<SyncOutcome> pullSession() async {
    try {
      final session = await countRepository.fetchActive();
      await localDb.saveSession(session);
      return SyncOutcome(ok: true, pulled: session?.rows.length ?? 0);
    } on ApiException catch (error) {
      return SyncOutcome(ok: false, reason: _reasonFor(error));
    } on Object catch (_) {
      return SyncOutcome(ok: false, reason: SyncOutcome.reasonUnexpected);
    }
  }

  /// ส่งคิวขึ้น backend แล้ว mark ผลรายบรรทัด
  ///
  /// [probeFirst] = probe ก่อนยิง (ใช้เมื่อผู้ใช้กด "ส่งใหม่" เอง — เส้นที่มาจาก
  /// [syncAll] probe มาแล้วไม่ต้องซ้ำ)
  Future<SyncOutcome> drainOutbox({bool probeFirst = false}) async {
    if (_draining) {
      return const SyncOutcome(ok: false, reason: SyncOutcome.reasonBusy);
    }
    _draining = true;
    var pushed = 0;
    var rejected = 0;
    try {
      if (probeFirst && !await _probe()) {
        return const SyncOutcome(ok: false, reason: SyncOutcome.reasonOffline);
      }
      final due = await localDb.dueForSync();
      if (due.isEmpty) return const SyncOutcome();
      final rows =
          due.length > maxRowsPerDrain ? due.take(maxRowsPerDrain).toList() : due;
      // queueDepth = ความลึกจริงของคิว (ops ใช้ดูว่าเครื่องไหนค้างเยอะ)
      final queueDepth = due.length;

      // จัดกลุ่มตาม (type, sessionId): submissions ยิงต่อ session · scan events ยิงรวม
      final batches = _groupBy(
        rows,
        // \u0000 เขียนเป็น escape เสมอ — ไบต์ดิบทำให้เครื่องมือมองไฟล์นี้เป็น binary
        // (grep/diff/file หาไม่เจอ) · ตัวคั่นยังเป็นอักขระที่ไม่มีทางอยู่ใน type/sessionId
        (row) => '${row.type}\u0000${row.sessionId ?? ''}',
      );

      for (final batch in batches.values) {
        // ลำดับการนับจริงของเครื่องนี้ = deviceSeq (นาฬิกาเครื่องเชื่อไม่ได้)
        batch.sort((a, b) => a.deviceSeq.compareTo(b.deviceSeq));
        final type = batch.first.type.trim().toLowerCase();

        if (type == typeCountLine) {
          final ids = batch.map((row) => row.id).toList(growable: false);
          final sessionId = batch.first.sessionId;
          if (sessionId == null || sessionId.isEmpty) {
            await localDb.markRejectedAll(ids, code: codeMissingSession);
            rejected += ids.length;
            continue;
          }
          final lines = <SubmitLine>[];
          final malformed = <String>[];
          for (final row in batch) {
            final line = _countLine(row.id, row.deviceSeq, row.payloadJson);
            if (line == null) {
              malformed.add(row.id);
            } else {
              lines.add(line);
            }
          }
          if (malformed.isNotEmpty) {
            await localDb.markRejectedAll(malformed, code: codeMalformedPayload);
            rejected += malformed.length;
          }
          if (lines.isEmpty) continue;
          final sendIds =
              lines.map((line) => line.idempotencyKey).toList(growable: false);
          await localDb.markInflight(sendIds);
          try {
            final tally = await _submitLines(
              sessionId: sessionId,
              lines: lines,
              queueDepth: queueDepth,
            );
            pushed += tally.pushed;
            rejected += tally.rejected;
          } on ApiException catch (error) {
            // ทั้งชุดกลับเข้าคิว — ปลอดภัยเพราะทุกบรรทัดมี idempotencyKey แล้ว
            await localDb.markRetryAll(sendIds);
            return SyncOutcome(
              ok: false,
              reason: _reasonFor(error),
              pushed: pushed,
              rejected: rejected,
              hasMore: true,
            );
          } on Object catch (_) {
            await localDb.markRetryAll(sendIds);
            return SyncOutcome(
              ok: false,
              reason: SyncOutcome.reasonUnexpected,
              pushed: pushed,
              rejected: rejected,
              hasMore: true,
            );
          }
        } else if (type == typeScanEvent) {
          final events = <ScanEventInput>[];
          final sendIds = <String>[];
          final malformed = <String>[];
          for (final row in batch) {
            final event = _scanEvent(row.payloadJson);
            if (event == null) {
              malformed.add(row.id);
            } else {
              events.add(event);
              sendIds.add(row.id);
            }
          }
          if (malformed.isNotEmpty) {
            await localDb.markRejectedAll(malformed, code: codeMalformedPayload);
            rejected += malformed.length;
          }
          if (events.isEmpty) continue;
          await localDb.markInflight(sendIds);
          var done = 0;
          try {
            while (done < events.length) {
              final rawEnd = done + scanEventsPerRequest;
              final end = rawEnd > events.length ? events.length : rawEnd;
              await catalogRepository.pushScanEvents(events.sublist(done, end));
              // audit ไม่ critical → ack ทั้งชุดโดยไม่เทียบผลรายบรรทัด
              final chunkIds = sendIds.sublist(done, end);
              await localDb.markAcked(chunkIds);
              pushed += chunkIds.length;
              done = end;
            }
          } on ApiException catch (error) {
            // เฉพาะที่ยังไม่ ack (กันส่งซ้ำ — scan event ไม่มี idempotency ฝั่ง server)
            await localDb.markRetryAll(sendIds.sublist(done));
            return SyncOutcome(
              ok: false,
              reason: _reasonFor(error),
              pushed: pushed,
              rejected: rejected,
              hasMore: true,
            );
          } on Object catch (_) {
            await localDb.markRetryAll(sendIds.sublist(done));
            return SyncOutcome(
              ok: false,
              reason: SyncOutcome.reasonUnexpected,
              pushed: pushed,
              rejected: rejected,
              hasMore: true,
            );
          }
        } else if (type == typeCountDoc) {
          // เอกสารทุกใบตกอยู่ใน batch เดียวกัน (sessionId เป็น null ทั้งหมด)
          // → **ยิงทีละใบ** ห้ามรวมเป็น request เดียว และห้ามแตกใบเป็นหลาย request
          for (final row in batch) {
            final doc = _countDocument(row.payloadJson);
            if (doc == null) {
              await localDb.markRejectedAll(
                [row.id],
                code: codeMalformedPayload,
              );
              rejected += 1;
              continue;
            }
            await localDb.markInflight([row.id]);
            String? submitted;
            try {
              // 200 = เอกสารถูกบันทึกฝั่ง server ครบแล้ว (ERP จะเข้าหรือไม่เป็นคนละ
              // เรื่องที่จอผู้ดูแลตามต่อ) → ลบออกจากคิวได้
              final result = await countRepository.submitDocument(
                documentId: doc.documentId,
                lines: doc.lines,
              );
              await localDb.markAcked([row.id]);
              pushed += 1;
              // ผล `erp.status` ต้องถึงตาคน ไม่ใช่ถูกทิ้งเงียบ ๆ ใน background
              // (แจ้งนอก try — ชั้น UI พังต้องไม่ทำให้ผลของการส่งเพี้ยน)
              submitted = result.erp.toastTh;
            } on ApiException catch (error) {
              switch (await _settleDocument(row.id, error)) {
                case _DocOutcome.restored:
                  continue;
                case _DocOutcome.rejected:
                  rejected += 1;
                  continue;
                case _DocOutcome.retry:
                  await localDb.markRetryAll([row.id]);
                  return SyncOutcome(
                    ok: false,
                    reason: _reasonFor(error),
                    pushed: pushed,
                    rejected: rejected,
                    hasMore: true,
                  );
              }
            } on Object catch (_) {
              await localDb.markRetryAll([row.id]);
              return SyncOutcome(
                ok: false,
                reason: SyncOutcome.reasonUnexpected,
                pushed: pushed,
                rejected: rejected,
                hasMore: true,
              );
            }
            // มาถึงบรรทัดนี้ได้เฉพาะทางที่ส่งสำเร็จ (ทุก catch ข้างบน return/continue)
            onDocumentSubmitted?.call(submitted);
          }
        }
        // ชนิดอื่น (member_add / change_role) ยังไม่ใช่งานของเอนจินนี้:
        // ปล่อยคาสถานะ queued ไว้ — ไม่ mark อะไร = ไม่ทำงานหาย ไม่ยิง API เปล่า
      }
      return SyncOutcome(
        ok: true,
        pushed: pushed,
        rejected: rejected,
        hasMore: due.length > rows.length,
      );
    } on Object catch (_) {
      return SyncOutcome(
        ok: false,
        reason: SyncOutcome.reasonUnexpected,
        pushed: pushed,
        rejected: rejected,
      );
    } finally {
      _draining = false;
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  /// ตัดสินชะตาเอกสาร 1 ใบที่ backend ตีกลับ
  ///
  /// - 409 `SYSTEM_QTY_DRIFT` → server rollback ทั้งใบแล้ว **ยังไม่มีอะไรถูกเขียน**
  ///   → คืนบรรทัดกลับเป็น draft พร้อมยอดระบบใหม่ ให้คนดูผลต่างใหม่แล้วยืนยันอีกรอบ
  ///   (ส่งซ้ำด้วย `documentId` เดิมเพราะ id ติดไปกับ draft แล้ว)
  /// - 4xx อื่น (`DOCUMENT_PAYLOAD_MISMATCH` / `ITEM_NO_SYSTEM_QTY` / ...) → terminal
  ///   **ห้ามลบ** ค้างไว้ให้จอ pending-review ตัดสิน
  /// - นอกนั้น (session หมด · throttle · 5xx · เน็ต) → ลองใหม่ทั้งใบ
  Future<_DocOutcome> _settleDocument(String id, ApiException error) async {
    if (error.code == CountRepository.codeSystemQtyDrift) {
      final drifted = CountRepository.driftedFrom(error);
      final restored = await localDb.restoreDraftsFromDocument(
        id,
        actualBySku: <String, num>{
          for (final row in drifted) row.sku: row.actual,
        },
      );
      if (restored == null) {
        // payload อ่านไม่ออก → คืนเป็น draft ไม่ได้ ต้องให้คนเห็นว่ามีงานค้าง
        await localDb.markRejectedAll([id], code: codeMalformedPayload);
        return _DocOutcome.rejected;
      }
      onDraftsRestored?.call();
      return _DocOutcome.restored;
    }
    if (error.isSessionExpired) return _DocOutcome.retry;
    if (_isTerminalStatus(error.statusCode)) {
      await localDb.markRejectedAll([id], code: error.code);
      return _DocOutcome.rejected;
    }
    return _DocOutcome.retry;
  }

  /// ส่ง 1 ชุดของ session เดียว แล้ว mark ตามผลรายบรรทัด
  Future<({int pushed, int rejected})> _submitLines({
    required String sessionId,
    required List<SubmitLine> lines,
    required int queueDepth,
  }) async {
    final results = await countRepository.submit(
      sessionId: sessionId,
      lines: lines,
      queueDepth: queueDepth,
    );
    final byKey = <String, SubmitResult>{
      for (final result in results) result.idempotencyKey: result,
    };

    final acked = <String>[];
    final retry = <String>[];
    final rejectedByCode = <String, List<String>>{};
    for (final line in lines) {
      final key = line.idempotencyKey;
      final result = byKey[key];
      if (result == null) {
        // backend ไม่ตอบบรรทัดนี้ → ไม่เดาว่าสำเร็จ ส่งซ้ำ (idempotent)
        retry.add(key);
      } else if (result.isSettled) {
        // accepted หรือ duplicate — duplicate คือสำเร็จ ไม่ใช่ error
        acked.add(key);
      } else if (result.isRejected) {
        // ห้ามลบ: เข้าจอ pending-review ให้คนตัดสิน
        (rejectedByCode[result.code ?? codeRejectedUnknown] ??= <String>[])
            .add(key);
      } else {
        retry.add(key);
      }
    }

    if (acked.isNotEmpty) await localDb.markAcked(acked);
    for (final entry in rejectedByCode.entries) {
      await localDb.markRejectedAll(entry.value, code: entry.key);
    }
    if (retry.isNotEmpty) await localDb.markRetryAll(retry);

    final rejectedCount = rejectedByCode.values
        .fold<int>(0, (sum, list) => sum + list.length);
    return (pushed: acked.length, rejected: rejectedCount);
  }

  Future<void> _run({required bool drainFirst}) async {
    // ⚠️ probe ก่อนทุกครั้ง: link ขึ้น ≠ server ถึงได้ (VLAN ที่ route ไม่ถึง)
    if (!await _probe()) return;
    if (drainFirst) {
      // งานนับค้างขึ้นก่อน — พนักงานเพิ่งเดินเข้าโซนที่มีสัญญาณ
      final pushFirst = await drainOutbox();
      if (pushFirst.needsReauth) return;
    }
    await pullItems();
    await pullSession();
    // รอบปิดท้าย: เก็บบรรทัดที่ enqueue ระหว่างนี้ + ชุดที่รอ session ใหม่
    await drainOutbox();
  }

  /// ยืนยันว่า **server ถึงได้จริง** — คำตอบเดียวที่เชื่อได้ก่อน sync
  Future<bool> _probe() async {
    try {
      final status = await syncRepository.status().timeout(probeTimeout);
      _lastStatus = status;
      _setConn(ConnState.online);
      return true;
    } on Object catch (_) {
      _setConn(ConnState.offline);
      return false;
    }
  }

  /// รอบเดียวเท่านั้น — ซ้อนกันแล้วแถว inflight จะถูก mark สองทาง
  Future<void> _guarded(Future<void> Function() body) {
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    final future = body().whenComplete(() => _inFlight = null);
    _inFlight = future;
    return future;
  }

  /// ยิง sync แบบ fire-and-forget (timer / lifecycle / connectivity ไม่มีใครรับ error)
  void _kick({required bool drainFirst}) {
    unawaited(_guarded(() => _run(drainFirst: drainFirst)).catchError(_swallow));
  }

  /// connectivity_plus เป็น **คำใบ้** เท่านั้น: ไม่มีลิงก์ = ออฟไลน์แน่นอน
  /// แต่มีลิงก์ไม่ได้แปลว่าถึง server — ให้ [_probe] ตัดสิน
  void _onLinkChanged(List<ConnectivityResult> results) {
    final hasLink =
        results.any((result) => result != ConnectivityResult.none);
    if (!hasLink) {
      _setConn(ConnState.offline);
      return;
    }
    _kick(drainFirst: true);
  }

  void _setConn(ConnState next) {
    if (_conn == next) return;
    _conn = next;
    if (!_connCtrl.isClosed) _connCtrl.add(next);
  }

  /// แปลง [ApiException] → reason code
  ///
  /// ยิงงานจริงไม่ผ่านเพราะ transport = ความจริงที่หนักแน่นกว่า probe → อัปเดตป้ายด้วย
  String _reasonFor(ApiException error) {
    if (error.isSessionExpired) return SyncOutcome.reasonSessionExpired;
    if (error.isNetwork) {
      _setConn(ConnState.offline);
      return SyncOutcome.reasonOffline;
    }
    final status = error.statusCode;
    if (status != null && status >= 500) return SyncOutcome.reasonServer;
    // 4xx อื่น ๆ (เช่น INSUFFICIENT_ROLE) — คืน code จริงให้ UI ตัดสินใจ
    return error.code;
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. Payload helpers
// ════════════════════════════════════════════════════════════════════

/// จัดกลุ่มโดยไม่อ้างชื่อคลาสของแถว outbox (ผูกกับชื่อฟิลด์เท่านั้น)
Map<String, List<T>> _groupBy<T>(
  Iterable<T> rows,
  String Function(T row) key,
) {
  final out = <String, List<T>>{};
  for (final row in rows) {
    (out[key(row)] ??= <T>[]).add(row);
  }
  return out;
}

/// payload ของ outbox — รับได้ทั้ง map ที่ decode แล้วและ `payload_json` ดิบ
Map<String, dynamic>? _payloadMap(Object? raw) {
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return raw.cast<String, dynamic>();
  if (raw is String) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    try {
      final decoded = jsonDecode(trimmed);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    } on FormatException {
      return null;
    }
  }
  return null;
}

/// payload → [SubmitLine] · คืน `null` = malformed (เข้า pending-review)
///
/// ⚠️ `countedQty` อ่านไม่ได้ **ห้ามแทนด้วย 0** — "ยังไม่ได้นับ" ต่างจาก "นับได้ 0"
/// [deviceSeq] มาจากคอลัมน์ของ outbox (ลำดับการนับจริง ไม่ใช่จาก payload)
SubmitLine? _countLine(String id, int deviceSeq, Object? payload) {
  final map = _payloadMap(payload);
  if (map == null) return null;
  final sku = _optString(map['sku']);
  final qty = _optNum(map['countedQty']);
  final countedAt = _optDate(map['countedAt']);
  if (sku == null || qty == null || countedAt == null) return null;
  return SubmitLine(
    idempotencyKey: id,
    sku: sku,
    countedQty: qty,
    countedAt: countedAt,
    deviceSeq: deviceSeq,
  );
}

/// ผลของการจัดการเอกสาร 1 ใบที่ถูกตีกลับ
enum _DocOutcome {
  /// คืนเป็น draft แล้ว (งานอยู่ในเครื่อง ไม่ได้อยู่ในคิวและไม่ได้หาย)
  restored,

  /// terminal — ค้างในคิวให้จอ pending-review
  rejected,

  /// ลองใหม่ทั้งใบ
  retry,
}

/// payload → เอกสาร 1 ใบ · คืน `null` = malformed (เข้า pending-review)
///
/// ⚠️ บรรทัดที่อ่าน `countedQty` / `systemQtyShown` ไม่ได้ ทำให้ **ทั้งใบ** malformed
///    — ส่งเอกสารที่ขาดบรรทัดเข้า ERP ไม่ได้ (ลบไม่ได้ ต้องให้คนดูก่อน)
({String documentId, List<CountDocumentLine> lines})? _countDocument(
  Object? payload,
) {
  final map = _payloadMap(payload);
  if (map == null) return null;
  final documentId = _optString(map['documentId']);
  final raw = map['lines'];
  if (documentId == null || raw is! List || raw.isEmpty) return null;
  final lines = <CountDocumentLine>[];
  for (final entry in raw) {
    final line = _payloadMap(entry);
    if (line == null) return null;
    final entryKey = _optString(line['entryKey']);
    final sku = _optString(line['sku']);
    final shown = _optNum(line['systemQtyShown']);
    final counted = _optNum(line['countedQty']);
    final countedAt = _optDate(line['countedAt']);
    if (entryKey == null ||
        sku == null ||
        shown == null ||
        counted == null ||
        countedAt == null) {
      return null;
    }
    lines.add(CountDocumentLine(
      entryKey: entryKey,
      sku: sku,
      systemQtyShown: shown,
      countedQty: counted,
      countedAt: countedAt,
    ));
  }
  return (documentId: documentId, lines: lines);
}

/// payload → [ScanEventInput] · `sku` เป็น null ได้ (บาร์โค้ดที่ยังแม็ปไม่ได้)
ScanEventInput? _scanEvent(Object? payload) {
  final map = _payloadMap(payload);
  if (map == null) return null;
  final barcode = _optString(map['barcode']);
  final scannedAt = _optDate(map['scannedAt']);
  if (barcode == null || scannedAt == null) return null;
  return ScanEventInput(
    barcode: barcode,
    sku: _optString(map['sku']),
    scannedAt: scannedAt,
  );
}

String? _optString(Object? raw) {
  if (raw is! String) return null;
  final trimmed = raw.trim();
  return trimmed.isEmpty ? null : trimmed;
}

/// numeric เก็บใน JSON ได้ทั้ง number และ string ('3.000') — ⚠️ ไม่มี fallback 0
num? _optNum(Object? raw) {
  if (raw is num) return raw.isFinite ? raw : null;
  if (raw is String) {
    final parsed = num.tryParse(raw.trim());
    return (parsed != null && parsed.isFinite) ? parsed : null;
  }
  return null;
}

DateTime? _optDate(Object? raw) {
  if (raw is String) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    return DateTime.tryParse(trimmed);
  }
  if (raw is int) return DateTime.fromMillisecondsSinceEpoch(raw);
  return null;
}

/// กลืน error ของงาน background ที่ไม่มีใครรับ (ทุกเส้นทางแปลงเป็น [SyncOutcome] แล้ว)
///
/// ⚠️ ไม่ log: payload อาจมี sku/บาร์โค้ด/ผลนับ
void _swallow(Object error, StackTrace stackTrace) {}

// ════════════════════════════════════════════════════════════════════
// 4. Providers
// ════════════════════════════════════════════════════════════════════

/// ⚠️ **ห้าม autoDispose** — เอนจินต้องอยู่ตลอดอายุแอป (timer + observer)
/// เรียก `start()` ครั้งเดียวจากชั้นบนสุดหลังผู้ใช้ login
final syncEngineProvider = Provider<SyncEngine>((ref) {
  final engine = SyncEngine(
    localDb: ref.watch(localDbProvider),
    catalogRepository: ref.watch(catalogRepositoryProvider),
    countRepository: ref.watch(countRepositoryProvider),
    syncRepository: ref.watch(syncRepositoryProvider),
    // เอกสารถูกตีกลับเพราะยอดระบบขยับ → บรรทัดกลับมาอยู่ใน count_drafts
    // ชั้น state ต้องอ่านใหม่ ไม่งั้นจอ 'รอส่ง' กับแถบเตือนยังว่างทั้งที่งานกลับมาแล้ว
    onDraftsRestored: () => ref.read(appProvider.notifier).loadDrafts(),
    // เอกสารส่งจบใน background → toast คือที่เดียวที่พนักงานเห็นว่าเข้า ERP แล้วหรือยัง
    onDocumentSubmitted: (message) =>
        ref.read(appProvider.notifier).flash(message),
  );
  ref.onDispose(engine.dispose);
  return engine;
});

/// ป้าย online/offline — ค่าที่ยืนยันด้วย probe แล้ว (ไม่ใช่สถานะ WiFi)
final connStateProvider = StreamProvider<ConnState>(
  (ref) => ref.watch(syncEngineProvider).connStateStream,
);

/// queue-depth badge (design-fidelity.md §7 ข้อ 2)
final queueDepthProvider = StreamProvider<int>(
  (ref) => ref.watch(localDbProvider).watchQueueDepth(),
);
