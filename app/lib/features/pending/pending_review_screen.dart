import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/kittikhun_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../local/local_db.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';

// ════════════════════════════════════════════════════════════════════════
// สัญญาที่ไฟล์นี้ต้องการจาก replica ในเครื่อง (`lib/data/local_db.dart`)
//
//   localDbProvider                       → object ที่มี 2 เมธอดนี้
//   Future<List<RejectedRow>> rejectedRows()      // outbox status = failed_terminal
//   Future<void> discardRejected(String id)       // ลบทิ้งถาวรตาม outbox id
//
//   RejectedRow (อ่านที่ `_entryFrom` เท่านั้น — จุดเดียวที่ผูกกับชื่อฟิลด์):
//   id (String, = outbox UUIDv7) · sku (String) · countedQty (num?)
//   countedAt (DateTime?) · code (String?)
//
// ถ้าชื่อคลาส/ฟิลด์ฝั่ง local_db ต่างจากนี้ ให้แก้ที่ `_entryFrom` จุดเดียว
// ════════════════════════════════════════════════════════════════════════

/// จำนวนที่นับได้ คั่นหลักพันแบบเดียวกับจอนับ (`1,240`)
final NumberFormat _qtyFormat = NumberFormat('#,##0.##');

/// ความกว้างต่ำสุดของปุ่มทิ้ง — กันปุ่มหุบตอนสลับข้อความเป็น 'ยืนยันทิ้ง?'
const double _discardMinWidth = 152;

/// ระยะห่างระหว่างการ์ดในลิสต์ (เท่ากับจอนับ / จอสมาชิก)
const double _listGap = 10;

/// ขนาดวงโหลดตอนอ่าน replica
const double _spinnerSize = 22;

/// ความหนาเส้นวงโหลด
const double _spinnerStroke = 2;

/// รายการค้างตรวจ 1 รายการ — ผลการนับที่ backend ปฏิเสธตอนซิงค์
///
/// ⚠️ `countedQty` เป็น null ได้ = ไม่ทราบจำนวน — **ห้ามแปลงเป็น 0**
/// เพราะ "นับได้ 0" (ของหมดจริง) ต้องแยกจาก "ไม่มีข้อมูลจำนวน"
@immutable
class PendingReviewEntry {
  const PendingReviewEntry({
    required this.id,
    required this.sku,
    required this.name,
    required this.countedQty,
    required this.unit,
    required this.countedAt,
    required this.code,
  });

  /// outbox id (UUIDv7) — คีย์ที่ใช้กับ `discardRejected`
  final String id;
  final String sku;

  /// ชื่อสินค้าจาก replica — ถ้าหาไม่เจอจะเท่ากับ `sku`
  final String name;

  /// จำนวนที่พนักงานนับได้ — null = ไม่ทราบ (สิ่งที่จะหายถ้าไม่จัดการ)
  final num? countedQty;
  final String? unit;
  final DateTime? countedAt;

  /// เหตุผลที่ถูกปฏิเสธจาก server (§6.3 ของ architecture.md)
  final String? code;

  /// เหตุผลเป็นภาษาไทย — code ที่ยังไม่รู้จักแสดงตรง ๆ (งานต้องไม่หายเงียบ ๆ
  /// เพราะแอปไม่รู้จัก code ใหม่)
  String get reasonLabel => switch (code) {
    'SESSION_CLOSED' => 'รอบนับถูกปิดแล้ว',
    'ROLE_CHANGED' => 'สิทธิ์ถูกเปลี่ยน — รอผู้ดูแลตรวจสอบ',
    'SKU_NOT_FOUND' => 'ไม่พบสินค้านี้ในระบบ',
    'INVALID_QTY' => 'จำนวนไม่ถูกต้อง',
    final String c when c.trim().isNotEmpty => c,
    _ => 'ส่งไม่สำเร็จ',
  };

  /// จำนวนที่แสดง — '—' เมื่อไม่ทราบจำนวน (ไม่ใช่ '0')
  String get qtyLabel {
    final qty = countedQty;
    return qty == null ? '—' : _qtyFormat.format(qty);
  }
}

/// รายการค้างตรวจจาก replica ในเครื่อง — อ่านได้แม้ไม่มีสัญญาณ
final pendingReviewProvider = FutureProvider<List<PendingReviewEntry>>((
  ref,
) async {
  // โหมด fixture (ไม่ตั้ง API_BASE_URL) ไม่มีคิวซิงค์ → ไม่ต้องเปิด local DB
  // (สำคัญบนแพลตฟอร์มที่ไม่มี path_provider เช่น web ที่ใช้ดู UI)
  if (!ApiConfig.isConfigured) return const [];
  final db = ref.watch(localDbProvider);
  final rows = await db.rejectedForReview();
  return [
    // หาชื่อ/หน่วยจาก replica จริง — `itemByBarcode` จับกับ sku ตรง ๆ ได้ด้วย
    for (final row in rows) _entryFrom(row, await db.itemByBarcode(row.sku)),
  ];
});

/// จุดเดียวที่ผูกกับชื่อฟิลด์ของ `RejectedRow`
///
/// ฟิลด์จำนวน/เวลา/เหตุผลรับเข้าเป็น nullable ทั้งหมด (ฝั่ง local_db ประกาศเป็น
/// non-nullable ก็ยังคอมไพล์ผ่าน) — จำนวนที่เป็น null จะไม่ถูกแปลงเป็น 0
PendingReviewEntry _entryFrom(RejectedRow row, Item? item) {
  return PendingReviewEntry(
    id: row.id,
    sku: row.sku,
    name: item?.name ?? row.sku,
    countedQty: row.countedQty,
    unit: item?.unit,
    countedAt: row.countedAt,
    code: row.code,
  );
}

/// ป้ายเวลาที่นับ: 'วันนี้ 09:42' · 'เมื่อวาน 17:20' · '12 ส.ค. 2569'
String? _countedAtLabel(DateTime? value) {
  if (value == null) return null;
  final at = value.toLocal();
  final now = DateTime.now();
  final startOfToday = DateTime(now.year, now.month, now.day);
  final startOfDay = DateTime(at.year, at.month, at.day);
  final days = startOfToday.difference(startOfDay).inDays;
  final hhmm =
      '${at.hour.toString().padLeft(2, '0')}:'
      '${at.minute.toString().padLeft(2, '0')}';
  if (days == 0) return 'วันนี้ $hhmm';
  if (days == 1) return 'เมื่อวาน $hhmm';
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

/// จอ pending-review (design extension §7 ข้อ 1)
///
/// ผลการนับที่ backend ปฏิเสธตอนซิงค์ (`failed_terminal` ใน outbox) — งานทั้งกะ
/// ต้องไม่หายเงียบ ๆ จอนี้จึงเป็นที่เดียวที่เห็นและจัดการได้
///
/// ⚠️ **ไม่มีปุ่ม "ลองส่งใหม่ทั้งหมด"** โดยตั้งใจ — เหตุผลที่ถูกปฏิเสธเป็นเหตุผลถาวร
/// (รอบปิด / สิทธิ์เปลี่ยน) การ retry จะถูกปฏิเสธซ้ำ ต้องให้ผู้ดูแลแก้ต้นเหตุก่อน
///
/// เป็น body ของจอเท่านั้น (header + แถบแท็บเป็นของ shell เหมือน CountScreen)
class PendingReviewScreen extends ConsumerWidget {
  const PendingReviewScreen({super.key});

  /// ทิ้งรายการถาวร แล้วอ่านลิสต์ใหม่ — ไม่โยน exception ออกไปที่ปุ่ม
  Future<void> _discard(WidgetRef ref, String id) async {
    try {
      await ref.read(localDbProvider).discardRejected(id);
      ref.invalidate(pendingReviewProvider);
    } catch (_) {
      ref.read(appProvider.notifier).flash('ทิ้งรายการไม่สำเร็จ ลองอีกครั้ง');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(pendingReviewProvider);

    return pending.when(
      loading: () => const Center(
        child: SizedBox(
          width: _spinnerSize,
          height: _spinnerSize,
          child: CircularProgressIndicator(
            strokeWidth: _spinnerStroke,
            color: KittikhunTokens.accent,
          ),
        ),
      ),
      error: (_, _) => const _CenterNote(
        title: 'อ่านรายการค้างตรวจไม่สำเร็จ',
        subtitle:
            'ข้อมูลยังอยู่ในเครื่อง — เปิดหน้านี้อีกครั้งเพื่อลองอ่านใหม่',
      ),
      data: (entries) {
        if (entries.isEmpty) {
          return const _CenterNote(
            title: 'ไม่มีรายการค้างตรวจ',
            subtitle: 'ผลการนับทั้งหมดถูกส่งเรียบร้อยแล้ว',
          );
        }
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: KittikhunTokens.gutterTab,
              ),
              child: _SummaryCard(count: entries.length),
            ),
            Expanded(
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(
                  KittikhunTokens.gutterTab,
                  12,
                  KittikhunTokens.gutterTab,
                  KittikhunTokens.gutterTab,
                ),
                itemCount: entries.length,
                separatorBuilder: (_, _) => const SizedBox(height: _listGap),
                itemBuilder: (context, index) {
                  final entry = entries[index];
                  return _PendingCard(
                    key: ValueKey(entry.id),
                    entry: entry,
                    onDiscard: () => _discard(ref, entry.id),
                  );
                },
              ),
            ),
          ],
        );
      },
    );
  }
}

/// หัวจอสรุป — บอกจำนวนที่ค้าง + ทางออกที่ทำได้จริง
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) => GlassCard(
    radius: KittikhunTokens.rCard,
    fill: KittikhunTokens.s075,
    border: KittikhunTokens.b11,
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'มี $count รายการที่ส่งไม่สำเร็จ',
          style: KittikhunTokens.itemName(),
        ),
        const SizedBox(height: 6),
        Text(
          'ตรวจสอบแล้วแจ้งผู้ดูแล หรือทิ้งรายการที่ไม่ต้องการ',
          style: KittikhunTokens.caption(),
        ),
      ],
    ),
  );
}

/// การ์ด 1 รายการค้างตรวจ — sku/เวลา · ชื่อ · จำนวนที่นับได้ · เหตุผล · ปุ่มทิ้ง
class _PendingCard extends StatelessWidget {
  const _PendingCard({super.key, required this.entry, required this.onDiscard});

  final PendingReviewEntry entry;
  final Future<void> Function() onDiscard;

  @override
  Widget build(BuildContext context) {
    final timeLabel = _countedAtLabel(entry.countedAt);
    final unit = entry.unit;

    return GradientCard(
      gradient: KittikhunTokens.listCardBg,
      radius: KittikhunTokens.rCard,
      border: KittikhunTokens.b11,
      shadow: KittikhunTokens.shCountCard,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Wrap ไม่ใช่ Row: ที่จอ 360px + text scale 1.3 เวลาที่นับ
                    // ต้องตกบรรทัดใหม่ได้ ห้ามตัดทิ้ง (sku และเวลาเป็นหลักฐานงาน)
                    Wrap(
                      spacing: 8,
                      runSpacing: 2,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(entry.sku, style: KittikhunTokens.skuLine()),
                        // เวลาแยก Text: skuLine() มี letterSpacing ซึ่งทำ
                        // shaping ของ 'วันนี้/เมื่อวาน' พัง (ดูหมายเหตุใน token)
                        if (timeLabel != null)
                          Text(timeLabel, style: KittikhunTokens.meta()),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(entry.name, style: KittikhunTokens.itemName()),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('นับได้', style: KittikhunTokens.tiny()),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(
                        entry.qtyLabel,
                        style: KittikhunTokens.statValue(
                          KittikhunTokens.tBrightest,
                        ),
                      ),
                      if (unit != null && unit.isNotEmpty) ...[
                        const SizedBox(width: 4),
                        Text(unit, style: KittikhunTokens.tiny()),
                      ],
                    ],
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: Pill(
              label: entry.reasonLabel,
              background: KittikhunTokens.warnTint14,
              style: KittikhunTokens.label(KittikhunTokens.warn),
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: _DiscardButton(onConfirm: onDiscard),
          ),
        ],
      ),
    );
  }
}

/// ปุ่มทิ้งแบบ 2 จังหวะ — กดครั้งแรกขึ้น 'ยืนยันทิ้ง?' กดซ้ำจึงลบจริง
///
/// ทิ้งแล้วกู้ไม่ได้ (จำนวนที่นับหายถาวร) จึงต้องมีจังหวะยืนยัน — ใช้ 2 จังหวะ
/// แทน dialog เพื่อไม่ให้ทับกับ toast ของ shell (กติกาเดียวกับ sheet ใน §2.7)
class _DiscardButton extends StatefulWidget {
  const _DiscardButton({required this.onConfirm});

  final Future<void> Function() onConfirm;

  @override
  State<_DiscardButton> createState() => _DiscardButtonState();
}

class _DiscardButtonState extends State<_DiscardButton> {
  /// ปลดสถานะยืนยันเองถ้าไม่กดต่อ — กันนิ้วไปโดนทีหลังแล้วลบทิ้งโดยไม่ตั้งใจ
  static const Duration _armWindow = Duration(seconds: 6);

  bool _armed = false;
  bool _busy = false;
  Timer? _disarm;

  @override
  void dispose() {
    _disarm?.cancel();
    super.dispose();
  }

  void _handleTap() {
    _disarm?.cancel();
    if (!_armed) {
      setState(() => _armed = true);
      _disarm = Timer(_armWindow, () {
        if (mounted) setState(() => _armed = false);
      });
      return;
    }
    setState(() => _busy = true);
    _confirm();
  }

  Future<void> _confirm() async {
    await widget.onConfirm();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _armed = false;
    });
  }

  @override
  Widget build(BuildContext context) => SecondaryButton(
    label: _armed ? 'ยืนยันทิ้ง?' : 'ทิ้งรายการนี้',
    minWidth: _discardMinWidth,
    onPressed: _busy ? null : _handleTap,
  );
}

/// ข้อความ 2 บรรทัดจัดกลางจอ (ว่าง / อ่านไม่สำเร็จ)
class _CenterNote extends StatelessWidget {
  const _CenterNote({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: KittikhunTokens.gutterTab,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            textAlign: TextAlign.center,
            style: KittikhunTokens.body15(KittikhunTokens.tSoft),
          ),
          const SizedBox(height: 6),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: KittikhunTokens.caption(KittikhunTokens.tFaint),
          ),
        ],
      ),
    ),
  );
}
