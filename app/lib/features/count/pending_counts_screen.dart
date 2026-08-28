/// จอ 'รอส่ง' — บรรทัดที่คีย์ไว้แล้วแต่ยังไม่ได้กดส่งเข้า ERP (แท็บที่ 3)
///
/// แทนที่จอ 'นับสต็อก' เดิมบนแท็บเดียวกัน (`count_screen.dart` ยังอยู่ครบทั้งไฟล์
/// แต่ไม่มีใครเรียกแล้ว จนกว่าจะตัดสินว่าจะปลดระวางเส้นทางรอบนับเมื่อไหร่)
///
/// ⚠️ **ห้ามลบแท็บนี้** — แถบล่างเป็นกริด 4 ช่องตาม design และ
///    **ทางเข้าจอผู้ดูแลอยู่ที่จอนี้จอเดียว** ลบแท็บ = admin เข้าจอตัวเองไม่ได้อีกเลย
///
/// กติกาของไฟล์นี้:
/// - ผลต่างที่แสดงคือ `นับได้ − ยอดระบบ` (ทิศเดียวกับการ์ดผลสแกน) —
///   เป็นข้อความบนจอเท่านั้น ไม่มีค่านี้ถูกส่งขึ้น server
/// - ยอดระบบที่ขยับหลังคีย์ต้องขึ้นป้ายให้เห็น **ห้ามเปลี่ยนตัวเลขเงียบ ๆ**
/// - ลบ draft รายแถวได้ (ยังอยู่ในเครื่อง ไม่เคยเป็นหลักฐานฝั่ง server)
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../local/local_db.dart';
import '../../state/app_state.dart';
import '../admin/admin_screen.dart';
import 'submit_drafts.dart';

/// จำนวนคั่นหลักพันแบบเดียวกับจอนับ / จอ pending-review
final NumberFormat _qtyFormat = NumberFormat('#,##0.###');

const double _listGap = 10;
const double _cardPad = 16;
const double _removeMinWidth = 88;
const double _emptyMaxWidth = 290;
const double _emptyLineHeight = 1.55;

class PendingCountsScreen extends ConsumerWidget {
  const PendingCountsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(appProvider);
    final rows = state.drafts.values.toList()
      ..sort((a, b) => a.enteredAt.compareTo(b.enteredAt));

    return Column(
      children: [
        // ทางเข้าจอผู้ดูแล — ย้ายมาจากการ์ดรอบนับของจอนับเดิม
        // staff/viewer ไม่เห็นปุ่มนี้เลย จอจึงเหมือนเดิมทุกพิกเซลสำหรับคนหน้างาน
        if (state.me.role.isAdmin)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              TclTokens.gutterTab,
              0,
              TclTokens.gutterTab,
              6,
            ),
            child: SecondaryButton(
              label: 'จอผู้ดูแล',
              height: 38,
              radius: TclTokens.rTeamAction,
              onPressed: () => ref.read(showAdminProvider.notifier).show(),
            ),
          ),
        Expanded(
          child: rows.isEmpty
              ? ListView(
                  padding: const EdgeInsets.all(TclTokens.gutterTab),
                  children: const [_PendingEmptyState()],
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(
                    TclTokens.gutterTab,
                    6,
                    TclTokens.gutterTab,
                    8,
                  ),
                  itemCount: rows.length,
                  separatorBuilder: (_, _) => const SizedBox(height: _listGap),
                  itemBuilder: (context, i) => _DraftCard(
                    key: ValueKey(rows[i].sku),
                    row: rows[i],
                  ),
                ),
        ),
        const SubmitDraftsBar(),
      ],
    );
  }
}

/// การ์ด 1 บรรทัดที่คีย์ไว้ — sku/ชื่อ · ระบบ · นับได้ · ผลต่าง · ปุ่มลบ
class _DraftCard extends ConsumerWidget {
  const _DraftCard({super.key, required this.row});

  final CountDraftRow row;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final diff = row.countedQty - row.systemQtyShown;
    final toneColor = diff == 0 ? TclTokens.ok : TclTokens.warn;
    final before = row.systemQtyBefore;
    final loc = row.loc;
    final skuLine = (loc == null || loc.isEmpty) ? row.sku : '${row.sku} · $loc';

    return GradientCard(
      gradient: TclTokens.listCardBg,
      radius: TclTokens.rCard,
      border: TclTokens.b11,
      shadow: TclTokens.shCountCard,
      padding: const EdgeInsets.all(_cardPad),
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
                    Text(
                      skuLine,
                      style: TclTokens.skuLine(),
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(row.name, style: TclTokens.itemName()),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('นับได้', style: TclTokens.tiny()),
                  Text(
                    _qtyFormat.format(row.countedQty),
                    style: TclTokens.statValue(toneColor),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: Text(
                  'ระบบ ${_qtyFormat.format(row.systemQtyShown)}'
                  '${row.unit == null ? '' : ' ${row.unit}'}',
                  style: TclTokens.caption(TclTokens.tSoft),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: _listGap),
              Pill(
                label: _diffLabel(diff),
                background:
                    diff == 0 ? TclTokens.okTint14 : TclTokens.warnTint14,
                style: TclTokens.label(toneColor),
              ),
            ],
          ),

          // ⚠️ ยอดระบบขยับหลังคีย์ (409 SYSTEM_QTY_DRIFT) — ต้องเห็นทั้งเลขเก่าและใหม่
          if (before != null) ...[
            const SizedBox(height: _listGap),
            Text(
              'ยอดระบบเปลี่ยน (${_qtyFormat.format(before)} → '
              '${_qtyFormat.format(row.systemQtyShown)}) · '
              'ตรวจผลต่างใหม่แล้วกดส่งอีกครั้ง',
              style: TclTokens.body13(TclTokens.warn),
            ),
          ],

          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              SecondaryButton(
                label: 'ลบรายการ',
                minWidth: _removeMinWidth,
                onPressed: () =>
                    ref.read(appProvider.notifier).deleteDraft(row.sku),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// ข้อความผลต่างแบบเดียวกับ [Variance] ('ตรงกับระบบ' · 'เกิน +3' · 'ขาด -3')
  String _diffLabel(num diff) {
    if (diff == 0) return 'ตรงกับระบบ';
    final text = _qtyFormat.format(diff.abs());
    return diff > 0 ? 'เกิน +$text' : 'ขาด -$text';
  }
}

class _PendingEmptyState extends StatelessWidget {
  const _PendingEmptyState();

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _emptyMaxWidth),
            child: Text(
              'ยังไม่มีรายการที่คีย์ไว้ — สแกนสินค้าแล้วกรอกจำนวนที่นับได้ '
              'รายการจะมารออยู่ที่นี่จนกว่าจะกดส่ง',
              style: TclTokens.body15(TclTokens.tSoft)
                  .copyWith(height: _emptyLineHeight),
            ),
          ),
          const SizedBox(height: 5),
          Text(
            'ยอดที่คีย์ไว้ไม่หายแม้ปิดแอปหรือไม่มีสัญญาณ',
            style: TclTokens.caption(TclTokens.tFaint),
          ),
        ],
      );
}
