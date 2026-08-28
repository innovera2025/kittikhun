/// ปุ่ม 'ส่งผลนับ' + popup ยืนยัน — ใช้ร่วมกันระหว่างจอสแกนกับจอ 'รอส่ง'
///
/// ⚠️ เหตุผลที่ต้องมี popup เสมอ: **ERP ไม่มีเส้นทางลบเอกสาร** เอกสารที่ส่งไปแล้ว
///    แก้ได้ทางเดียวคือให้ฝ่ายบัญชีแก้ให้ → คนกดต้องเห็นสรุปตัวเลขก่อนทุกครั้ง
///
/// กติกาของไฟล์นี้:
/// - **ไม่คำนวณ diff เพื่อส่งขึ้น server** — ตัวเลขผลต่างในไฟล์นี้เป็นข้อความบนจอ
///   ล้วน ๆ (ทิศ `นับได้ − ยอดระบบ` เดียวกับ [Variance.signed])
/// - 'นับได้ 0' = ของหายทั้งก้อน ต้องติ๊กยืนยันชั้นสองก่อนกดส่งได้
/// - ห้ามฮาร์ดโค้ดสี/รัศมี/เงา — ทุกค่าจาก [TclTokens]
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../local/local_db.dart';
import '../../state/app_state.dart';

/// จำนวนคั่นหลักพันแบบเดียวกับจอนับ / จอ pending-review
final NumberFormat _qtyFormat = NumberFormat('#,##0.###');

/// ความสูงสูงสุดของลิสต์รายการใน popup — เกินกว่านี้เลื่อนดูในกล่อง
const double _listMaxHeight = 240;

const double _dialogPad = 22;
const double _dialogCancelMinWidth = 106;
const double _gap = 16;
const double _rowGap = 10;
const double _titleGap = 2;
const double _checkboxSize = 22;

/// จำนวนแบบมีเครื่องหมาย — ทิศ `นับได้ − ยอดระบบ` (เหมือนที่การ์ดผลสแกนโชว์)
String _signed(num diff) {
  if (diff == 0) return '0';
  final text = _qtyFormat.format(diff.abs());
  return diff > 0 ? '+$text' : '-$text';
}

/// สรุปเอกสารที่กำลังจะส่ง — คิดจาก draft ตรง ๆ ไม่มีค่าไหนถูกส่งขึ้น server
@immutable
class DraftSummary {
  const DraftSummary._({
    required this.rows,
    required this.short,
    required this.over,
    required this.match,
    required this.shortTotal,
    required this.overTotal,
    required this.zeroCounted,
  });

  factory DraftSummary.of(List<CountDraftRow> rows) {
    var short = 0, over = 0, match = 0;
    num shortTotal = 0, overTotal = 0;
    final zero = <CountDraftRow>[];
    for (final row in rows) {
      final diff = row.countedQty - row.systemQtyShown;
      if (diff < 0) {
        short += 1;
        shortTotal += diff;
      } else if (diff > 0) {
        over += 1;
        overTotal += diff;
      } else {
        match += 1;
      }
      // 0 = "นับแล้วได้ศูนย์" (ของหาย) — ต้องยืนยันชั้นสอง
      if (row.countedQty == 0) zero.add(row);
    }
    return DraftSummary._(
      rows: rows,
      short: short,
      over: over,
      match: match,
      shortTotal: shortTotal,
      overTotal: overTotal,
      zeroCounted: zero,
    );
  }

  final List<CountDraftRow> rows;

  /// จำนวนรายการที่นับได้น้อยกว่ายอดระบบ + ผลรวม (ติดลบ)
  final int short;
  final num shortTotal;

  /// จำนวนรายการที่นับได้มากกว่ายอดระบบ + ผลรวม (บวก)
  final int over;
  final num overTotal;

  final int match;

  /// รายการที่นับได้ 0 — แจ้ง ERP ว่าของหายทั้งก้อน
  final List<CountDraftRow> zeroCounted;

  int get lineCount => rows.length;
  num get net => shortTotal + overTotal;
  bool get hasZeroCounted => zeroCounted.isNotEmpty;
}

// ════════════════════════════════════════════════════════════════════
// 1. แถบปุ่มส่ง
// ════════════════════════════════════════════════════════════════════

/// แถบปุ่ม 'ส่งผลนับ · N รายการ' — ซ่อนตัวเองเมื่อยังไม่มีบรรทัดที่คีย์
class SubmitDraftsBar extends ConsumerWidget {
  const SubmitDraftsBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final drafts = ref.watch(appProvider.select((s) => s.drafts));
    if (drafts.isEmpty) return const SizedBox.shrink();
    final canWrite = ref.watch(appProvider.select((s) => s.me.role.canWrite));
    final busy = ref.watch(appProvider.select((s) => s.busy));

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        TclTokens.gutterTab,
        10,
        TclTokens.gutterTab,
        14,
      ),
      child: Opacity(
        opacity: canWrite ? 1 : 0.45,
        child: PrimaryButton(
          label: 'ส่งผลนับ · ${drafts.length} รายการ',
          height: TclTokens.hSubmit,
          radius: TclTokens.rButtonLarge,
          shadow: TclTokens.shSubmitBtn,
          // กดรัว ๆ ระหว่างเข้าคิวต้องไม่เปิด popup ซ้อน (ด่านจริงอยู่ที่ busy
          // ใน AppController.sendDraftsToErp อีกชั้น)
          onPressed: busy ? null : () => confirmAndSendDrafts(context, ref),
        ),
      ),
    );
  }
}

/// เปิด popup ยืนยันแล้วเข้าคิวเมื่อผู้ใช้กดยืนยัน
///
/// viewer ถูกกั้นตั้งแต่ก่อนเปิด popup (ด่านแข็งอยู่ใน [AppController.sendDraftsToErp])
Future<void> confirmAndSendDrafts(BuildContext context, WidgetRef ref) async {
  final controller = ref.read(appProvider.notifier);
  final state = ref.read(appProvider);
  if (!state.me.role.canWrite) {
    controller.flash('สิทธิ์ viewer ส่งผลนับไม่ได้');
    return;
  }
  final rows = state.drafts.values.toList()
    ..sort((a, b) => a.enteredAt.compareTo(b.enteredAt));
  if (rows.isEmpty) {
    controller.flash('ยังไม่มีรายการที่คีย์ไว้');
    return;
  }

  final ok = await showDialog<bool>(
    context: context,
    barrierColor: TclTokens.scrim,
    builder: (_) => ConfirmSendDialog(summary: DraftSummary.of(rows)),
  );
  if (ok != true) return;
  await controller.sendDraftsToErp();
}

// ════════════════════════════════════════════════════════════════════
// 2. popup ยืนยัน
// ════════════════════════════════════════════════════════════════════

/// popup ยืนยันก่อนส่งเอกสารเข้า ERP — เปลือกเดียวกับ sheet ของ design (§2.7)
class ConfirmSendDialog extends StatefulWidget {
  const ConfirmSendDialog({super.key, required this.summary});

  final DraftSummary summary;

  @override
  State<ConfirmSendDialog> createState() => _ConfirmSendDialogState();
}

class _ConfirmSendDialogState extends State<ConfirmSendDialog> {
  /// ติ๊กยืนยันรายการที่นับได้ 0 — ไม่มีรายการแบบนั้นก็ไม่ต้องติ๊ก
  bool _zeroConfirmed = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.summary;
    final canSend = !s.hasZeroCounted || _zeroConfirmed;

    return Material(
      type: MaterialType.transparency,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(TclTokens.gutterTab),
          child: GradientCard(
            gradient: TclTokens.sheetBg,
            border: TclTokens.b15,
            radius: TclTokens.rSheet,
            shadow: TclTokens.shSheet,
            padding: const EdgeInsets.all(_dialogPad),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('ยืนยันส่งผลนับ', style: TclTokens.sheetTitle()),
                const SizedBox(height: _titleGap),
                Text(
                  'เอกสาร 1 ใบ · ${s.lineCount} รายการ',
                  style: TclTokens.caption(),
                ),
                const SizedBox(height: _gap),

                // ── สรุปตัวเลข (ทิศ นับได้ − ยอดระบบ เหมือนบนการ์ด)
                _SummaryRow(label: 'จำนวนรายการ', value: '${s.lineCount}'),
                if (s.short > 0)
                  _SummaryRow(
                    label: 'ขาด',
                    value: '${s.short} รายการ · รวม ${_signed(s.shortTotal)}',
                    valueColor: TclTokens.warn,
                  ),
                if (s.over > 0)
                  _SummaryRow(
                    label: 'เกิน',
                    value: '${s.over} รายการ · รวม ${_signed(s.overTotal)}',
                    valueColor: TclTokens.warn,
                  ),
                if (s.match > 0)
                  _SummaryRow(
                    label: 'ตรงกับระบบ',
                    value: '${s.match} รายการ',
                    valueColor: TclTokens.ok,
                  ),
                _SummaryRow(label: 'รวมสุทธิ', value: _signed(s.net)),

                // ── รายการที่นับได้ 0 — ยืนยันชั้นสอง
                if (s.hasZeroCounted) ...[
                  const SizedBox(height: _gap),
                  _ZeroCountedBlock(
                    rows: s.zeroCounted,
                    confirmed: _zeroConfirmed,
                    onToggle: () =>
                        setState(() => _zeroConfirmed = !_zeroConfirmed),
                  ),
                ],

                // ── ทุกบรรทัดที่กำลังจะส่ง
                const SizedBox(height: _gap),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: _listMaxHeight),
                  child: ListView.separated(
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    itemCount: s.rows.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 6),
                    itemBuilder: (context, i) => _LineRow(row: s.rows[i]),
                  ),
                ),

                // ── คำเตือนที่ห้ามหายไปจากจอนี้
                const SizedBox(height: _gap),
                Container(
                  padding: const EdgeInsets.all(_rowGap),
                  decoration: BoxDecoration(
                    color: TclTokens.s075,
                    border: Border.all(color: TclTokens.errorBorder),
                    borderRadius: BorderRadius.circular(TclTokens.rStatTile),
                  ),
                  child: Text(
                    'เอกสารที่ส่งแล้วลบใน ERP ไม่ได้ '
                    'ถ้าตัวเลขผิดต้องให้ฝ่ายบัญชีแก้ให้',
                    style: TclTokens.body13(TclTokens.bad),
                  ),
                ),

                const SizedBox(height: _gap),
                Row(
                  children: [
                    SecondaryButton(
                      label: 'ยกเลิก',
                      onPressed: () => Navigator.of(context).pop(false),
                      height: TclTokens.hSheetButton,
                      radius: TclTokens.rSheetButton,
                      minWidth: _dialogCancelMinWidth,
                    ),
                    const SizedBox(width: _rowGap),
                    Expanded(
                      child: PrimaryButton(
                        label: 'ยืนยันส่ง',
                        onPressed:
                            canSend ? () => Navigator.of(context).pop(true) : null,
                        height: TclTokens.hSheetButton,
                        radius: TclTokens.rSheetButton,
                        shadow: const [],
                        fontSize: TclTokens.ctaSecondary().fontSize!,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 1 บรรทัดของสรุป — คีย์ซ้าย ค่าขวา (รูปเดียวกับ spec row ของการ์ดผลสแกน)
class _SummaryRow extends StatelessWidget {
  const _SummaryRow({
    required this.label,
    required this.value,
    this.valueColor,
  });

  final String label;
  final String value;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: TclTokens.b10)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 3,
              child: Text(label, style: TclTokens.body13(TclTokens.tMuted)),
            ),
            const SizedBox(width: 14),
            Expanded(
              flex: 4,
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: TclTokens.body13(valueColor ?? TclTokens.tSoftAlt),
              ),
            ),
          ],
        ),
      );
}

/// บล็อกยืนยันชั้นสองของรายการที่นับได้ 0
class _ZeroCountedBlock extends StatelessWidget {
  const _ZeroCountedBlock({
    required this.rows,
    required this.confirmed,
    required this.onToggle,
  });

  final List<CountDraftRow> rows;
  final bool confirmed;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(_rowGap),
        decoration: BoxDecoration(
          color: TclTokens.warnTint14,
          border: Border.all(color: TclTokens.b16),
          borderRadius: BorderRadius.circular(TclTokens.rStatTile),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'นับได้ 0 · ${rows.length} รายการ',
              style: TclTokens.label(TclTokens.warn),
            ),
            const SizedBox(height: 4),
            Text(
              'จะแจ้ง ERP ว่าของหายทั้งก้อน: '
              '${rows.map((r) => r.sku).join(' · ')}',
              style: TclTokens.body13(TclTokens.tSoft),
            ),
            const SizedBox(height: _rowGap),
            Semantics(
              checked: confirmed,
              button: true,
              label: 'ยืนยันว่านับแล้วได้ 0 จริง',
              child: Tappable(
                onTap: onToggle,
                radius: TclTokens.rStatTile,
                child: Row(
                  children: [
                    Container(
                      width: _checkboxSize,
                      height: _checkboxSize,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: confirmed ? TclTokens.t30 : TclTokens.s10,
                        border: Border.all(
                          color: confirmed ? TclTokens.accent : TclTokens.b18,
                        ),
                        borderRadius: BorderRadius.circular(
                          TclTokens.rCountInput,
                        ),
                      ),
                      child: confirmed
                          ? Text(
                              '✓',
                              style: TclTokens.label(TclTokens.accentHover),
                            )
                          : null,
                    ),
                    const SizedBox(width: _rowGap),
                    Expanded(
                      child: Text(
                        'ยืนยันว่านับแล้วได้ 0 จริง (ไม่ใช่ยังไม่ได้นับ)',
                        style: TclTokens.body13(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
}

/// 1 บรรทัดในลิสต์ของ popup — 'sku · ระบบ X → นับได้ Y · ±Z'
class _LineRow extends StatelessWidget {
  const _LineRow({required this.row});

  final CountDraftRow row;

  @override
  Widget build(BuildContext context) {
    final diff = row.countedQty - row.systemQtyShown;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            '${row.sku} · ระบบ ${_qtyFormat.format(row.systemQtyShown)} '
            '→ นับได้ ${_qtyFormat.format(row.countedQty)}',
            style: TclTokens.body13(TclTokens.tSoft),
          ),
        ),
        const SizedBox(width: _rowGap),
        Text(
          _signed(diff),
          style: TclTokens.body13(
            diff == 0 ? TclTokens.ok : TclTokens.warn,
          ),
        ),
      ],
    );
  }
}
