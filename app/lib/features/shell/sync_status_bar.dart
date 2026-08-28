/// ตัวชี้สถานะซิงค์ — design extension §7 ข้อ 2 ของ `docs/design-fidelity.md`
///
/// คลังมีจุดอับสัญญาณ พนักงานจึงต้องเห็นสองเรื่องตลอดเวลาโดยไม่ต้องกดหา:
/// 1. **ยอดที่เห็นเก่าแค่ไหน** — 'ข้อมูล ณ HH:MM' จาก `SyncStatus.dataAsOfLabel`
///    (= เวลาที่ดึงจาก ERP สำเร็จครั้งล่าสุด — ไม่ใช่ max ของ `erp_updated_at`)
/// 2. **งานนับที่กรอกไปแล้วส่งขึ้นไปหรือยัง** — ความลึกของ outbox
/// 3. **ยอดที่คีย์ไว้แต่ยังไม่ได้กดส่งเข้าเอกสาร** — จำนวนแถวใน `count_drafts`
///    ต่างจากข้อ 2 ตรงที่ยังไม่มีใครส่งให้เลย ปิดแอปไปเฉย ๆ ก็ไม่มีอะไรเกิดขึ้น
///
/// ถ้าไม่บอก พนักงานจะไม่เชื่อระบบเมื่อเลขไม่ตรงกับชั้นวาง แล้วหันไปจดกระดาษ
///
/// กติกาของไฟล์นี้:
/// - **ไม่กินพื้นที่จอเมื่อไม่มีอะไรต้องบอก** — ทุก widget คืน [SizedBox.shrink]
///   ตอนสถานะปกติ (ออนไลน์ · คิวว่าง · ข้อมูลสด)
/// - **ทน loading/error** — provider ที่ยังไม่มีค่า / ยิง `/sync/status` ไม่ผ่าน
///   (ออฟไลน์อยู่ก็เป็นเรื่องปกติ) ต้องแสดงว่าง ไม่ throw ไม่ crash
/// - ห้ามฮาร์ดโค้ดสี/รัศมี/เงา — ทุกค่าจาก [TclTokens]
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../data/stock_repository.dart';
import '../../local/sync_engine.dart';
import '../../state/app_state.dart';

// ════════════════════════════════════════════════════════════════════
// เกณฑ์และขนาด
// ════════════════════════════════════════════════════════════════════

/// เก่ากว่านี้ = เตือนด้วยสี warn (ยอดในคลังขยับเร็วกว่ารอบ sync ปกติ)
const Duration kStaleDataAfter = Duration(minutes: 30);

/// ความสูงแถบ — บางพอที่จะไม่แข่งกับ header (design §7: แถบบางใต้หัวจอ)
const double _barHeight = 30;

/// จุดสถานะ 7px (ขนาดเดียวกับจุด pulse ของป้ายสถานะกล้อง ลดจาก 8px ของ toast)
const double _dotSize = 7;

/// เพดานตัวเลขบน badge — เกินกว่านี้แสดง '9+' (ที่ว่างบนไอคอนแท็บจำกัด)
const int _badgeMax = 9;

/// ระยะระหว่างเรื่องที่เตือนพร้อมกันในแถบเดียว
const double _noticeGap = 10;

// ════════════════════════════════════════════════════════════════════
// Snapshot ของ /sync/status
// ════════════════════════════════════════════════════════════════════

/// อายุข้อมูลยอดสต็อกฝั่ง server — ใช้ร่วมกันทั้ง [SyncStatusBar] และ [StaleDataChip]
///
/// คืน `null` แทนการโยน error เมื่อยังไม่ได้ตั้ง `API_BASE_URL` (โหมด fixture)
/// · error อื่น (ออฟไลน์ / session หมด) ตกเป็น `AsyncError` ซึ่งผู้เรียกอ่านเป็น
/// `null` ผ่าน `.value` → ป้ายหายไปเงียบ ๆ ไม่ขึ้นข้อความแดงคาจอในคลัง
///
/// ⚠️ ค่านี้ cache ไว้: SyncEngine ควร `ref.invalidate(syncStatusSnapshotProvider)`
/// หลังทุกรอบ sync สำเร็จ — เป็นจังหวะเดียวกับที่ทำให้ป้ายอายุข้อมูลขยับตามเวลาด้วย
final syncStatusSnapshotProvider = FutureProvider<SyncStatus?>((ref) async {
  if (!ApiConfig.isConfigured) return null;
  return ref.watch(syncRepositoryProvider).status();
});

// ════════════════════════════════════════════════════════════════════
// ตัวอ่านค่าจาก SyncEngine (stream → AsyncValue: loading/error = ยังไม่รู้)
// ════════════════════════════════════════════════════════════════════

/// ความลึกของ outbox — ยังไม่รู้ค่า ถือเป็น 0 (ซ่อนตัวชี้ ไม่เดาว่ามีคิว)
int _queueDepthOf(AsyncValue<int> queue) {
  final depth = queue.value;
  return (depth != null && depth > 0) ? depth : 0;
}

/// ออฟไลน์อยู่หรือไม่ — **`unknown` / ยังไม่มีค่า = ไม่เตือน**
///
/// สถานะนี้ยืนยันด้วย probe แล้ว (ไม่ใช่ธง WiFi ดิบ) แต่ตอนเปิดแอปยังไม่มีผล probe
/// → เตือนว่า "ออฟไลน์" ตอนที่ยังไม่รู้ แย่กว่าการนิ่งไว้ก่อน
bool _isOffline(AsyncValue<ConnState> conn) =>
    conn.value == ConnState.offline;

/// ยอดที่เห็นเก่าเกินเกณฑ์ หรือ server ต่อ ERP ไม่ได้
bool _isStale(SyncStatus status) {
  if (status.isStale) return true; // erpOk == false หรือยังไม่เคย sync
  final at = status.itemsStockAsOf;
  return at != null && DateTime.now().difference(at) > kStaleDataAfter;
}

// ════════════════════════════════════════════════════════════════════
// 1. แถบสถานะซิงค์ — วางใต้ header ของ AppShell
// ════════════════════════════════════════════════════════════════════

/// แถบบางแนวนอนใต้ header — โผล่เฉพาะเมื่อมีอะไรต้องบอก
///
/// ออฟไลน์ · มีคิวค้าง · มียอดที่คีย์ค้าง · ข้อมูลเก่ากว่า [kStaleDataAfter] ·
/// มีงานค้างตรวจ
/// นอกนั้นซ่อนสนิท (สูง 0) เพื่อไม่เบียดพื้นที่กล้องบนจอ 360px
///
/// [pendingCount] = งานที่ถูก reject ตอน sync (`failed_terminal` ใน outbox) —
/// ส่งมาจากผู้เรียกเพราะเจ้าของจอ pending-review เป็นคนถือตัวเลขนั้น
class SyncStatusBar extends ConsumerWidget {
  const SyncStatusBar({super.key, this.pendingCount = 0, this.onTapPending});

  final int pendingCount;

  /// แตะป้าย 'ค้างตรวจ {n}' → เปิดจอ pending-review
  final VoidCallback? onTapPending;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offline = _isOffline(ref.watch(connStateProvider));
    final queued = _queueDepthOf(ref.watch(queueDepthProvider));
    final drafts = ref.watch(appProvider.select((s) => s.draftCount));
    final status = ref.watch(syncStatusSnapshotProvider).value;

    // ป้ายอายุข้อมูล: ไม่เคย sync = ไม่มีเวลาให้อ้าง → ไม่แสดงป้าย
    final asOfLabel = status?.dataAsOfLabel;
    final stale = status != null && _isStale(status);
    final pending = pendingCount > 0 ? pendingCount : 0;

    final staleNotice = asOfLabel != null && stale;
    if (!offline && queued == 0 && drafts == 0 && !staleNotice && pending == 0) {
      return const SizedBox.shrink();
    }

    // ลำดับคงที่ — เหตุผลที่ของยังไม่ขึ้น (ออฟไลน์) มาก่อนจำนวน แล้วงานที่
    // **ยังไม่มีใครส่งให้** (draft) ต้องมาก่อนงานที่ระบบกำลังส่งเอง (คิวซิงค์)
    // สลับลำดับเมื่อไหร่พนักงานจะเข้าใจว่าของที่คีย์ไว้กำลังถูกส่งอยู่แล้ว
    final notices = <(String, Color)>[
      if (offline) ('ออฟไลน์ · บันทึกไว้ในเครื่อง', TclTokens.warn),
      if (drafts > 0) ('คีย์แล้วยังไม่ส่ง $drafts รายการ', TclTokens.warn),
      if (queued > 0) ('รอซิงค์ $queued รายการ', TclTokens.accent),
    ];

    return Container(
      height: _barHeight,
      padding: const EdgeInsets.symmetric(
        horizontal: TclTokens.gutterTab,
      ),
      decoration: const BoxDecoration(
        color: TclTokens.s07,
        border: Border(bottom: BorderSide(color: TclTokens.b11)),
      ),
      child: Row(
        children: [
          // แต่ละเรื่องมีจุดสีของตัวเอง — draft (warn) กับคิวซิงค์ (accent)
          // ต้องแยกออกจากกันด้วยสี ไม่ใช่ลำดับคำอย่างเดียว
          for (final (index, (text, color)) in notices.indexed) ...[
            if (index > 0) const SizedBox(width: _noticeGap),
            _StatusDot(color: color),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TclTokens.meta(TclTokens.tSoftAlt),
              ),
            ),
          ],
          const Spacer(),
          if (asOfLabel != null)
            Text(
              asOfLabel,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TclTokens.meta(
                stale ? TclTokens.warn : TclTokens.tFaint,
              ),
            ),
          if (pending > 0) ...[
            const SizedBox(width: 8),
            Pill(
              label: 'ค้างตรวจ $pending',
              background: TclTokens.s10,
              border: TclTokens.bad,
              // ข้อความไทย → ห้าม letterSpacing (ใช้ meta ไม่ใช่ rolePill)
              style: TclTokens.meta(TclTokens.bad),
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
              onTap: onTapPending,
            ),
          ],
        ],
      ),
    );
  }
}

/// จุดสถานะกลม 7px
class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: _dotSize,
    height: _dotSize,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

// ════════════════════════════════════════════════════════════════════
// 2. Badge จำนวนคิว — ติดบนไอคอนแท็บ
// ════════════════════════════════════════════════════════════════════

/// ตัวเลขคิวเล็ก ๆ สำหรับซ้อนบนไอคอนแท็บ (คิวว่าง = ไม่มีอะไรวาด)
///
/// ตัวเลขใช้ Space Grotesk ตาม design §1.4 (badge อยู่ในกลุ่ม Latin/ตัวเลข)
class QueueBadge extends ConsumerWidget {
  const QueueBadge({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final depth = _queueDepthOf(ref.watch(queueDepthProvider));
    if (depth == 0) return const SizedBox.shrink();

    return Semantics(
      label: 'รอซิงค์ $depth รายการ',
      child: Container(
        height: 17,
        constraints: const BoxConstraints(minWidth: 17),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: TclTokens.accent,
          borderRadius: BorderRadius.circular(TclTokens.rPill),
        ),
        child: Text(
          depth > _badgeMax ? '$_badgeMax+' : '$depth',
          style: TclTokens.display(
            size: 10,
            weight: FontWeight.w600,
            color: TclTokens.onAccent,
            height: 1.0,
          ),
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. ป้ายอายุข้อมูล — แถบเครื่องมือใต้กล้องของหน้าสแกน
// ════════════════════════════════════════════════════════════════════

/// 'ข้อมูล ณ HH:MM' — ซ่อนเมื่อยังไม่เคย sync (ไม่มีเวลาให้อ้าง)
///
/// design §7 ข้อ 2 ระบุให้วางในแถบเครื่องมือใต้กล้อง ไม่ทับกรอบกล้องที่พื้นที่จำกัด
class StaleDataChip extends ConsumerWidget {
  const StaleDataChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(syncStatusSnapshotProvider).value;
    final label = status?.dataAsOfLabel;
    if (status == null || label == null) return const SizedBox.shrink();

    final chip = TclTokens.chip();
    return Pill(
      label: label,
      background: TclTokens.s085,
      style: _isStale(status)
          ? chip.copyWith(color: TclTokens.warn)
          : chip,
    );
  }
}
