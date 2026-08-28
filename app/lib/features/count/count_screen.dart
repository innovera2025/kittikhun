import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/models.dart';
import '../../data/stock_repository.dart';
import '../../state/app_state.dart';
import '../admin/admin_screen.dart';

/// ยอดระบบคั่นหลักพันตาม design (`onHand.toLocaleString()`)
final NumberFormat _qtyFormat = NumberFormat('#,##0.##');

/// หน้านับสต็อก (design §2.5)
///
/// การ์ดรอบนับ (flex:none) → ลิสต์รายการนับ (flex:1 scroll) → ปุ่มส่งผล (flex:none)
class CountScreen extends ConsumerStatefulWidget {
  const CountScreen({super.key});

  @override
  ConsumerState<CountScreen> createState() => _CountScreenState();
}

class _CountScreenState extends ConsumerState<CountScreen> {
  /// controller ต่อ sku — คงค่าที่กรอกไว้ข้าม rebuild
  final Map<String, TextEditingController> _ctrls = {};

  @override
  void dispose() {
    for (final c in _ctrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  /// ดึงค่าจาก state เข้า controller เฉพาะเมื่อค่าถูกเปลี่ยนจากภายนอก (กด +/−)
  /// ตอนผู้ใช้พิมพ์เอง text จะตรงกับ state อยู่แล้ว → ข้าม เพื่อไม่ให้ cursor เด้ง
  void _syncFromState(Map<String, String> counts) {
    for (final entry in _ctrls.entries) {
      final value = counts[entry.key] ?? '';
      if (entry.value.text == value) continue;
      entry.value.value = TextEditingValue(
        text: value,
        selection: TextSelection.collapsed(offset: value.length),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(appProvider);
    final controller = ref.read(appProvider.notifier);
    // counts map ถูกสร้างใหม่เฉพาะเมื่อ setCount → listener ไม่ยิงจาก state อื่น
    ref.listen(appProvider.select((s) => s.counts), (_, next) {
      _syncFromState(next);
    });

    // รอบนับจริงจาก replica ถ้ามี ไม่งั้น fixture (โหมดดู UI)
    final rows = ref.read(appProvider.notifier).countRows();
    final done = state.countedRows;
    final canWrite = state.me.role.canWrite;
    // เผื่อคีย์บอร์ดบัง: ให้แถวล่างสุดเลื่อนขึ้นเหนือคีย์บอร์ดได้
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: TclTokens.gutterTab,
          ),
          child: _SessionCard(
            done: done,
            total: rows.length,
            session: state.session,
            // ทางเข้าจอผู้ดูแล — ไม่เพิ่มแท็บที่ 5 (design กำหนดไว้ 4 ช่อง)
            // staff/viewer ไม่เห็นปุ่มนี้เลย จอจึงเหมือนเดิมทุกพิกเซล
            onManage: state.me.role.isAdmin
                ? () => ref.read(showAdminProvider.notifier).show()
                : null,
          ),
        ),
        Expanded(
          child: ListView.separated(
            padding: EdgeInsets.fromLTRB(
              TclTokens.gutterTab,
              12,
              TclTokens.gutterTab,
              8 + keyboardInset,
            ),
            itemCount: rows.length,
            separatorBuilder: (_, _) => const SizedBox(height: 10),
            itemBuilder: (context, index) {
              final row = rows[index];
              final ctrl = _ctrls.putIfAbsent(
                row.sku,
                () => TextEditingController(text: state.counts[row.sku] ?? ''),
              );
              return _CountCard(
                key: ValueKey(row.sku),
                row: row,
                controller: ctrl,
                variance: Variance.from(
                  entered: state.counts[row.sku] ?? '',
                  systemQty: row.systemQty,
                ),
                onChanged: (v) => controller.setCount(row.sku, v),
                onDecrement: () => controller.decCount(row.sku),
                onIncrement: () => controller.incCount(row.sku),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            TclTokens.gutterTab,
            10,
            TclTokens.gutterTab,
            14,
          ),
          child: Opacity(
            // viewer กดได้แต่ controller จะ flash ข้อความสิทธิ์ → ทำให้ดู disabled
            opacity: canWrite ? 1 : 0.45,
            child: PrimaryButton(
              label: 'ส่งผลการนับ',
              height: TclTokens.hSubmit,
              radius: TclTokens.rButtonLarge,
              shadow: TclTokens.shSubmitBtn,
              onPressed: controller.submitCount,
            ),
          ),
        ),
      ],
    );
  }
}

/// ป้ายบอกรอบนับ — โซนและเลขเอกสารจากรอบจริง
String _sessionLabel(ActiveSession? s) {
  if (s == null) return 'ยังไม่มีรอบนับที่เปิดอยู่';
  final zone = s.zone?.trim();
  final voucher = s.voucherNo?.trim();
  final parts = [
    if (zone != null && zone.isNotEmpty) 'โซน $zone' else 'ทั้งคลัง ${s.warehouseCode}',
    if (voucher != null && voucher.isNotEmpty) voucher else s.id,
  ];
  return parts.join(' · ');
}

/// การ์ดหัวรอบนับ — โซน/เลขรอบ + ความคืบหน้า
class _SessionCard extends StatelessWidget {
  const _SessionCard({
    required this.done,
    required this.total,
    required this.session,
    this.onManage,
  });

  final int done;
  final int total;

  /// รอบนับที่เปิดอยู่จริง — null = ยังไม่มีรอบ
  final ActiveSession? session;

  /// null = ผู้ใช้ไม่ใช่ผู้ดูแล → ไม่แสดงปุ่มจัดการรอบนับ
  final VoidCallback? onManage;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      radius: TclTokens.rCard,
      fill: TclTokens.s075,
      border: TclTokens.b11,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text(
                  // ⚠️ เดิมเป็นค่าตัวอย่างตายตัว ('โซน A · CC-2408') ต่อให้ไม่มีรอบเปิดอยู่
                  //    ก็ยังขึ้นเหมือนมีรอบจริง — พนักงานเริ่มนับทั้งที่ยังไม่เปิดรอบได้
                  _sessionLabel(session),
                  style: TclTokens.caption(TclTokens.tSoft),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 12),
              Text(
                'นับแล้ว $done/$total',
                style: TclTokens.display(
                  size: 12.5,
                  weight: FontWeight.w400,
                  color: TclTokens.accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ProgressBar(
            fraction: total == 0 ? 0 : done / total,
            gradient: TclTokens.countProgressGradient,
          ),
          if (onManage case final VoidCallback open) ...[
            const SizedBox(height: 12),
            SecondaryButton(
              label: 'จัดการรอบนับ',
              height: 38,
              radius: TclTokens.rTeamAction,
              onPressed: open,
            ),
          ],
        ],
      ),
    );
  }
}

/// การ์ด 1 รายการนับ — ชื่อ/ยอดระบบ + stepper + pill ส่วนต่าง
class _CountCard extends StatefulWidget {
  const _CountCard({
    super.key,
    required this.row,
    required this.controller,
    required this.variance,
    required this.onChanged,
    required this.onDecrement,
    required this.onIncrement,
  });

  final CountRow row;
  final TextEditingController controller;
  final Variance variance;
  final ValueChanged<String> onChanged;
  final VoidCallback onDecrement;
  final VoidCallback onIncrement;

  @override
  State<_CountCard> createState() => _CountCardState();
}

class _CountCardState extends State<_CountCard> {
  bool _focused = false;

  /// สี/พื้นของ pill ตามผลส่วนต่าง (ยังไม่นับ → กลาง · ตรง → ok · เกิน/ขาด → warn)
  (Color fg, Color bg) get _varianceTone {
    final v = widget.variance;
    if (!v.isCounted) return (TclTokens.tMuted, TclTokens.s10);
    if (v.isMatch) return (TclTokens.ok, TclTokens.okTint14);
    return (TclTokens.warn, TclTokens.warnTint14);
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final loc = row.loc;
    // ERP จริงไม่มี Shelf → แสดงแค่ sku เมื่อไม่มีตำแหน่ง
    final skuLine = (loc == null || loc.isEmpty) ? row.sku : '${row.sku} · $loc';
    final (varFg, varBg) = _varianceTone;

    return GradientCard(
      gradient: TclTokens.listCardBg,
      radius: TclTokens.rCard,
      border: TclTokens.b11,
      shadow: TclTokens.shCountCard,
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
                  Text('ระบบ', style: TclTokens.tiny()),
                  Text(
                    _qtyFormat.format(row.systemQty),
                    style: TclTokens.statValue(TclTokens.tSoft),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              StepperButton(glyph: '−', onTap: widget.onDecrement),
              const SizedBox(width: 10),
              CountField(
                controller: widget.controller,
                focused: _focused,
                onFocusChange: (f) => setState(() => _focused = f),
                onChanged: widget.onChanged,
              ),
              const SizedBox(width: 10),
              StepperButton(glyph: '+', onTap: widget.onIncrement),
              const SizedBox(width: 10),
              Expanded(
                child: Align(
                  alignment: Alignment.centerRight,
                  // จอ 360px: ย่อ pill ลงแทนที่จะล้นขอบการ์ด
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerRight,
                    child: Pill(
                      label: widget.variance.label,
                      background: varBg,
                      style: TclTokens.label(varFg),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
