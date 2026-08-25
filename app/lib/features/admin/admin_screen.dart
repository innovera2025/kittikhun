import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../data/stock_repository.dart';
import '../../state/app_state.dart';

// ════════════════════════════════════════════════════════════════════════
// จอผู้ดูแลรอบนับ (design extension)
//
// ⚠️ design ต้นแบบ v4.0 **ไม่มี**จอนี้ (มีแค่ปุ่มสลับสิทธิ์ในจอสมาชิก)
//    จอนี้จึงสร้างจาก token + pattern เดิมทั้งหมด ไม่มีสี/รัศมี/เงาใหม่แม้แต่ค่าเดียว
//    โครงเป็นแบบเดียวกับจอ pending-review: เป็น body เท่านั้น
//    (header + แถบแท็บ 4 ช่องเป็นของ shell — ห้ามเพิ่มแท็บที่ 5)
//
// ⚠️ ทุกอย่างในจอนี้ **ต้องออนไลน์** โดยตั้งใจ — เปิด/ปิดรอบและตัดสิน conflict
//    กระทบทุกเครื่องในคลัง การคิวไว้ทำทีหลังจะทำให้ 2 admin ตัดสินคนละอย่าง
//    บนข้อมูลคนละชุด → ล้มไปเลยเมื่อไม่มีเน็ต ดีกว่าให้ผลลัพธ์ที่เชื่อไม่ได้
// ════════════════════════════════════════════════════════════════════════

/// จำนวน คั่นหลักพันแบบเดียวกับจอนับ / จอ pending-review
final NumberFormat _qtyFormat = NumberFormat('#,##0.###');

const double _listGap = 10;
const double _spinnerSize = 22;
const double _spinnerStroke = 2.4;

/// เปิดจอผู้ดูแลอยู่หรือไม่ (จอชั่วคราวเหมือน pending-review — ไม่แตะแท็บล่าง)
class ShowAdmin extends Notifier<bool> {
  @override
  bool build() => false;

  void show() => state = true;
  void hide() => state = false;
}

final showAdminProvider = NotifierProvider<ShowAdmin, bool>(ShowAdmin.new);

/// รอบนับที่เปิดอยู่ ตามที่ **server** เห็น (ไม่ใช่ replica ในเครื่อง)
///
/// จอนี้ตัดสินใจระดับรอบ จึงต้องอ่านจากแหล่งความจริงเดียวเสมอ
final adminSessionProvider = FutureProvider<ActiveSession?>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (!api.isConfigured) return null;
  return ref.watch(countRepositoryProvider).fetchActive();
});

/// รายการที่หลายเครื่องนับไม่ตรงกันในรอบที่เปิดอยู่
final adminConflictsProvider =
    FutureProvider<List<ConflictRow>>((ref) async {
  final session = await ref.watch(adminSessionProvider.future);
  if (session == null) return const <ConflictRow>[];
  return ref.watch(countRepositoryProvider).fetchConflicts(session.id);
});

/// รายงานส่วนต่างของรอบที่เปิดอยู่
final adminVarianceProvider = FutureProvider<List<VarianceRow>>((ref) async {
  final session = await ref.watch(adminSessionProvider.future);
  if (session == null) return const <VarianceRow>[];
  return ref.watch(countRepositoryProvider).fetchVariance(session.id);
});

/// มุมมองย่อยของจอผู้ดูแล
enum AdminView {
  session('รอบนับ'),
  conflicts('ขัดแย้ง'),
  variance('ส่วนต่าง');

  const AdminView(this.label);
  final String label;
}

class AdminViewTab extends Notifier<AdminView> {
  @override
  AdminView build() => AdminView.session;

  void select(AdminView view) => state = view;
}

final adminViewProvider =
    NotifierProvider<AdminViewTab, AdminView>(AdminViewTab.new);

// ════════════════════════════════════════════════════════════════════════

class AdminScreen extends ConsumerWidget {
  const AdminScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(appProvider).me;

    // ชั้นกันซ้ำฝั่งแอป — ด่านจริงคือ @Roles('admin') + role_version ที่ server
    // (JWT เชื่อไม่ได้ ผู้ใช้ถูกลดสิทธิ์กลางกะได้)
    if (!me.role.isAdmin) {
      return const _CenterNote(
        title: 'ต้องมีสิทธิ์ผู้ดูแล',
        subtitle: 'หน้านี้เปิดได้เฉพาะผู้ดูแลระบบ',
      );
    }

    if (!ref.watch(apiClientProvider).isConfigured) {
      return const _CenterNote(
        title: 'โหมดดูตัวอย่าง UI',
        subtitle: 'การจัดการรอบนับต้องต่อ backend จริง '
            '(ตั้ง API_BASE_URL ตอน build)',
      );
    }

    final view = ref.watch(adminViewProvider);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            TclTokens.gutterTab,
            0,
            TclTokens.gutterTab,
            12,
          ),
          child: _ViewSwitch(
            current: view,
            onSelect: (v) => ref.read(adminViewProvider.notifier).select(v),
          ),
        ),
        Expanded(
          child: switch (view) {
            AdminView.session => const _SessionPane(),
            AdminView.conflicts => const _ConflictsPane(),
            AdminView.variance => const _VariancePane(),
          },
        ),
      ],
    );
  }
}

/// สลับมุมมอง — ใช้ token เดียวกับแถบแท็บล่างของ design (s09 / activeTabGradient)
class _ViewSwitch extends StatelessWidget {
  const _ViewSwitch({required this.current, required this.onSelect});

  final AdminView current;
  final ValueChanged<AdminView> onSelect;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: TclTokens.s09,
          border: Border.all(color: TclTokens.b13),
          borderRadius: BorderRadius.circular(TclTokens.rTabBar),
        ),
        child: Row(
          children: [
            for (final view in AdminView.values) ...[
              if (view.index > 0) const SizedBox(width: 4),
              Expanded(
                child: _ViewButton(
                  label: view.label,
                  active: view == current,
                  onTap: () => onSelect(view),
                ),
              ),
            ],
          ],
        ),
      );
}

class _ViewButton extends StatelessWidget {
  const _ViewButton({
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        selected: active,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(TclTokens.rTabButton),
          child: Container(
            height: 38,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: active ? TclTokens.activeTabGradient : null,
              borderRadius: BorderRadius.circular(TclTokens.rTabButton),
            ),
            child: Text(
              label,
              style: TclTokens.thai(
                size: 13,
                weight: FontWeight.w600,
                color: active
                    ? TclTokens.onAccent
                    : TclTokens.tMuted,
              ),
            ),
          ),
        ),
      );
}

// ════════════════════════════════════════════════════════════════════════
// 1. รอบนับ — เปิด / ปิด
// ════════════════════════════════════════════════════════════════════════

class _SessionPane extends ConsumerStatefulWidget {
  const _SessionPane();

  @override
  ConsumerState<_SessionPane> createState() => _SessionPaneState();
}

class _SessionPaneState extends ConsumerState<_SessionPane> {
  final TextEditingController _zone = TextEditingController();

  /// กันกดซ้ำระหว่างรอ server — เปิดรอบซ้อนกันคือความเสียหายจริง
  bool _busy = false;

  @override
  void dispose() {
    _zone.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final message = await action();
      ref.invalidate(adminSessionProvider);
      if (mounted) ref.read(appProvider.notifier).flash(message);
    } on ApiException catch (e) {
      // server เป็นผู้ตัดสิน — ข้อความไทยจาก backend ตรงกว่าที่แอปเดาเอง
      if (mounted) ref.read(appProvider.notifier).flash(e.message);
    } catch (_) {
      if (mounted) {
        ref.read(appProvider.notifier).flash('ทำรายการไม่สำเร็จ ลองอีกครั้ง');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _open({required bool allowStale}) => _run(() async {
        final session = await ref
            .read(countRepositoryProvider)
            .openSession(zone: _zone.text, allowStaleCache: allowStale);
        _zone.clear();
        return 'เปิดรอบนับแล้ว · ${session.rows.length} รายการ';
      });

  Future<void> _close(String sessionId) => _run(() async {
        final result =
            await ref.read(countRepositoryProvider).closeSession(sessionId);
        ref.invalidate(adminConflictsProvider);
        ref.invalidate(adminVarianceProvider);
        return 'ปิดรอบแล้ว · แช่แข็ง ${result.materialized} รายการ';
      });

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(adminSessionProvider);

    return session.when(
      loading: () => const _Spinner(),
      error: (_, _) => const _CenterNote(
        title: 'อ่านสถานะรอบนับไม่สำเร็จ',
        subtitle: 'ต่อ server ไม่ได้ — ตรวจ WiFi แล้วเปิดหน้านี้ใหม่',
      ),
      data: (active) => ListView(
        padding: const EdgeInsets.fromLTRB(
          TclTokens.gutterTab,
          0,
          TclTokens.gutterTab,
          TclTokens.gutterTab,
        ),
        children: active == null
            ? _openForm()
            : _closeForm(active),
      ),
    );
  }

  List<Widget> _openForm() => [
        GlassCard(
          radius: TclTokens.rCard,
          fill: TclTokens.s075,
          border: TclTokens.b11,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('ยังไม่มีรอบตรวจนับ',
                  style: TclTokens.itemName()),
              const SizedBox(height: 6),
              Text(
                'เปิดรอบใหม่จะ freeze ยอดระบบของทุกสินค้าในคลัง ณ ตอนนี้ '
                'ตัวเลขที่ freeze จะไม่เปลี่ยนอีกแม้ ERP อัปเดตระหว่างรอบ',
                style: TclTokens.caption(),
              ),
              const SizedBox(height: 16),
              Text('โซน (ไม่ระบุ = ทั้งคลัง)',
                  style: TclTokens.label()),
              const SizedBox(height: 6),
              FieldBox(
                child: TokenTextField(
                  controller: _zone,
                  onChanged: (_) {},
                  hint: 'เช่น A-01',
                ),
              ),
              const SizedBox(height: 16),
              PrimaryButton(
                label: _busy ? 'กำลังเปิดรอบ…' : 'เปิดรอบนับ',
                onPressed: _busy ? null : () => _open(allowStale: false),
              ),
              const SizedBox(height: 10),
              // ERP ล่ม → server ปฏิเสธการเปิดบน cache เก่ากว่า 6 ชม.
              // ทางออกนี้ต้องเป็นการกดที่ 2 ที่ตั้งใจ ไม่ใช่ retry เงียบ ๆ
              SecondaryButton(
                label: 'เปิดทั้งที่ข้อมูลอาจไม่ใช่ล่าสุด',
                onPressed: _busy ? null : () => _open(allowStale: true),
              ),
            ],
          ),
        ),
      ];

  List<Widget> _closeForm(ActiveSession active) {
    final conflicts = ref.watch(adminConflictsProvider);
    final unresolved = conflicts.maybeWhen(
      data: (rows) => rows.where((r) => !r.resolved).length,
      orElse: () => 0,
    );
    final blocked = unresolved > 0;

    return [
      GlassCard(
        radius: TclTokens.rCard,
        fill: TclTokens.s075,
        border: TclTokens.b11,
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    active.voucherNo ?? active.id,
                    style: TclTokens.itemName(),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 12),
                Pill(
                  label: 'เปิดอยู่',
                  background: TclTokens.okTint16,
                  style: TclTokens.rolePill(TclTokens.ok),
                  border: TclTokens.okTint40,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              [
                if (active.zone != null) 'โซน ${active.zone}',
                'คลัง ${active.warehouseCode}',
                '${active.rows.length} รายการ',
              ].join(' · '),
              style: TclTokens.caption(),
            ),
            if (active.staleCache) ...[
              const SizedBox(height: 10),
              _WarnNote(
                text: 'รอบนี้เปิดบนข้อมูลที่อาจไม่ใช่ล่าสุด — '
                    'ยอดระบบที่ freeze อาจต่างจาก ERP จริง',
              ),
            ],
            const SizedBox(height: 16),
            if (blocked)
              _WarnNote(
                text: 'ยังมี $unresolved รายการที่หลายเครื่องนับไม่ตรงกัน '
                    'ต้องตัดสินให้ครบก่อนจึงจะปิดรอบได้',
              )
            else
              Text(
                'ปิดรอบแล้วตัวเลขจะถูกแช่แข็ง แก้ย้อนหลังไม่ได้ '
                'ผลนับที่ส่งมาหลังจากนี้จะเข้าจอค้างตรวจแทน',
                style: TclTokens.caption(),
              ),
            const SizedBox(height: 16),
            PrimaryButton(
              label: _busy ? 'กำลังปิดรอบ…' : 'ปิดรอบนับ',
              onPressed: _busy || blocked ? null : () => _close(active.id),
            ),
          ],
        ),
      ),
    ];
  }
}

// ════════════════════════════════════════════════════════════════════════
// 2. ตัดสิน conflict
// ════════════════════════════════════════════════════════════════════════

class _ConflictsPane extends ConsumerWidget {
  const _ConflictsPane();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conflicts = ref.watch(adminConflictsProvider);

    return conflicts.when(
      loading: () => const _Spinner(),
      error: (_, _) => const _CenterNote(
        title: 'อ่านรายการขัดแย้งไม่สำเร็จ',
        subtitle: 'ต่อ server ไม่ได้ — ตรวจ WiFi แล้วเปิดหน้านี้ใหม่',
      ),
      data: (rows) {
        if (rows.isEmpty) {
          return const _CenterNote(
            title: 'ไม่มีรายการขัดแย้ง',
            subtitle: 'ไม่มี SKU ที่ถูกนับจากหลายเครื่องในรอบนี้',
          );
        }
        return ListView.separated(
          padding: const EdgeInsets.fromLTRB(
            TclTokens.gutterTab,
            0,
            TclTokens.gutterTab,
            TclTokens.gutterTab,
          ),
          itemCount: rows.length,
          separatorBuilder: (_, _) => const SizedBox(height: _listGap),
          itemBuilder: (_, i) => _ConflictCard(key: ValueKey(rows[i].sku), row: rows[i]),
        );
      },
    );
  }
}

class _ConflictCard extends ConsumerStatefulWidget {
  const _ConflictCard({super.key, required this.row});

  final ConflictRow row;

  @override
  ConsumerState<_ConflictCard> createState() => _ConflictCardState();
}

class _ConflictCardState extends ConsumerState<_ConflictCard> {
  bool _busy = false;

  Future<void> _choose(String submissionKey) async {
    if (_busy) return;
    final session = ref.read(adminSessionProvider).value;
    if (session == null) return;

    setState(() => _busy = true);
    try {
      await ref.read(countRepositoryProvider).resolveConflict(
            sessionId: session.id,
            sku: widget.row.sku,
            chosenSubmission: submissionKey,
          );
      ref.invalidate(adminConflictsProvider);
      ref.invalidate(adminVarianceProvider);
      if (mounted) {
        ref.read(appProvider.notifier).flash('ตัดสินแล้ว · ${widget.row.sku}');
      }
    } on ApiException catch (e) {
      if (mounted) ref.read(appProvider.notifier).flash(e.message);
    } catch (_) {
      if (mounted) {
        ref.read(appProvider.notifier).flash('ตัดสินไม่สำเร็จ ลองอีกครั้ง');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final frozen = row.frozenOnHand;

    return GradientCard(
      gradient: TclTokens.listCardBg,
      border: TclTokens.b11,
      radius: TclTokens.rCard,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  row.name ?? row.sku,
                  style: TclTokens.itemName(),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 10),
              Pill(
                label: row.resolved ? 'ตัดสินแล้ว' : '${row.deviceCount} เครื่อง',
                background: row.resolved
                    ? TclTokens.okTint16
                    : TclTokens.warnTint14,
                style: TclTokens.rolePill(
                  row.resolved ? TclTokens.ok : TclTokens.warn,
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(row.sku, style: TclTokens.skuLine()),
          const SizedBox(height: 8),
          Text(
            frozen == null
                // นอกรายการ: ไม่มียอดระบบให้เทียบ — ห้ามแสดงเป็น 0
                ? 'นอกรายการ · ไม่มียอดระบบให้เทียบ'
                : 'ยอดระบบ ${_qtyFormat.format(frozen)}'
                    '${row.unit == null ? '' : ' ${row.unit}'}',
            style: TclTokens.caption(TclTokens.tSoft),
          ),
          const SizedBox(height: 12),
          for (final s in row.submissions) ...[
            _SubmissionOption(
              submission: s,
              chosen: row.chosenSubmission == s.idempotencyKey,
              enabled: !_busy,
              onTap: () => _choose(s.idempotencyKey),
            ),
            const SizedBox(height: 8),
          ],
          if (row.resolved && row.resolvedBy != null)
            Text(
              'ตัดสินโดย ${row.resolvedBy} · เลือกใหม่ได้จนกว่าจะปิดรอบ',
              style: TclTokens.meta(),
            )
          else
            Text(
              // เตือนไม่ให้เผลอเชื่อ "ตัวที่มาถึงก่อน/หลัง"
              'เวลาที่แสดงคือเวลาที่เครื่องบอก — ใช้ประกอบเท่านั้น '
              'ไม่ใช่หลักฐานว่านับก่อนหรือหลัง',
              style: TclTokens.meta(),
            ),
        ],
      ),
    );
  }
}

class _SubmissionOption extends StatelessWidget {
  const _SubmissionOption({
    required this.submission,
    required this.chosen,
    required this.enabled,
    required this.onTap,
  });

  final ConflictSubmission submission;
  final bool chosen;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final at = submission.countedAt;
    return Semantics(
      button: true,
      selected: chosen,
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(TclTokens.rInput),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: chosen ? TclTokens.t16 : TclTokens.s085,
            border: Border.all(
              color: chosen ? TclTokens.t45 : TclTokens.b15,
            ),
            borderRadius: BorderRadius.circular(TclTokens.rInput),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'นับได้ ${_qtyFormat.format(submission.countedQty)}',
                      style: TclTokens.statValue(
                        chosen
                            ? TclTokens.accentHover
                            : TclTokens.tBrightest,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        'โดย ${submission.empId}',
                        if (at != null) 'เวลา ${_hhmm(at)}',
                        if (submission.isLatest) 'ค่าที่ระบบใช้อยู่',
                      ].join(' · '),
                      style: TclTokens.meta(),
                    ),
                  ],
                ),
              ),
              if (chosen)
                const Icon(
                  Icons.check_rounded,
                  size: 18,
                  color: TclTokens.accent,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// 3. รายงานส่วนต่าง
// ════════════════════════════════════════════════════════════════════════

class _VariancePane extends ConsumerWidget {
  const _VariancePane();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final variance = ref.watch(adminVarianceProvider);

    return variance.when(
      loading: () => const _Spinner(),
      error: (_, _) => const _CenterNote(
        title: 'อ่านรายงานส่วนต่างไม่สำเร็จ',
        subtitle: 'ต่อ server ไม่ได้ — ตรวจ WiFi แล้วเปิดหน้านี้ใหม่',
      ),
      data: (rows) {
        if (rows.isEmpty) {
          return const _CenterNote(
            title: 'ยังไม่มีรายงาน',
            subtitle: 'เปิดรอบนับก่อนจึงจะมีส่วนต่างให้ดู',
          );
        }
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: TclTokens.gutterTab,
              ),
              child: _VarianceSummary(rows: rows),
            ),
            Expanded(
              child: ListView.separated(
                padding: const EdgeInsets.fromLTRB(
                  TclTokens.gutterTab,
                  12,
                  TclTokens.gutterTab,
                  TclTokens.gutterTab,
                ),
                itemCount: rows.length,
                separatorBuilder: (_, _) => const SizedBox(height: _listGap),
                itemBuilder: (_, i) =>
                    _VarianceCard(key: ValueKey(rows[i].sku), row: rows[i]),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _VarianceSummary extends StatelessWidget {
  const _VarianceSummary({required this.rows});

  final List<VarianceRow> rows;

  int _count(String status) =>
      rows.where((r) => r.status == status).length;

  @override
  Widget build(BuildContext context) {
    final match = _count(VarianceRow.statusMatch);
    final over = _count(VarianceRow.statusOver);
    final short = _count(VarianceRow.statusShort);
    final notCounted = _count(VarianceRow.statusNotCounted);
    final offList = _count(VarianceRow.statusOffList);
    final conflict = rows.where((r) => r.isConflict).length;

    return GlassCard(
      radius: TclTokens.rCard,
      fill: TclTokens.s075,
      border: TclTokens.b11,
      padding: const EdgeInsets.all(14),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _Tally('ตรงกับระบบ', match, TclTokens.ok),
          if (over > 0) _Tally('เกิน', over, TclTokens.warn),
          if (short > 0) _Tally('ขาด', short, TclTokens.warn),
          // ยังไม่ได้นับ ≠ นับได้ 0 — แยกให้เห็นชัดเสมอ แม้เป็น 0 รายการ
          _Tally('ยังไม่ได้นับ', notCounted, TclTokens.tMuted),
          if (offList > 0)
            _Tally('นอกรายการ', offList, TclTokens.accent),
          if (conflict > 0) _Tally('ขัดแย้ง', conflict, TclTokens.bad),
        ],
      ),
    );
  }
}

class _Tally extends StatelessWidget {
  const _Tally(this.label, this.count, this.color);

  final String label;
  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: TclTokens.s07,
          border: Border.all(color: TclTokens.b10),
          borderRadius: BorderRadius.circular(TclTokens.rTeamAction),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('$count', style: TclTokens.statValue(color)),
            const SizedBox(width: 6),
            Text(label, style: TclTokens.meta()),
          ],
        ),
      );
}

class _VarianceCard extends StatelessWidget {
  const _VarianceCard({super.key, required this.row});

  final VarianceRow row;

  Color get _statusColor => switch (row.status) {
        VarianceRow.statusMatch => TclTokens.ok,
        VarianceRow.statusOver || VarianceRow.statusShort =>
          TclTokens.warn,
        VarianceRow.statusConflict => TclTokens.bad,
        VarianceRow.statusOffList => TclTokens.accent,
        _ => TclTokens.tMuted,
      };

  /// '—' ไม่ใช่ '0' — null แปลว่ายังเทียบไม่ได้ ไม่ใช่เท่ากับศูนย์
  String _qty(num? value) => value == null ? '—' : _qtyFormat.format(value);

  @override
  Widget build(BuildContext context) => GradientCard(
        gradient: TclTokens.listCardBg,
        border: TclTokens.b11,
        radius: TclTokens.rCard,
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    row.sku,
                    style: TclTokens.itemName(),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 10),
                Pill(
                  label: row.statusLabelTh,
                  background: TclTokens.s07,
                  style: TclTokens.rolePill(_statusColor),
                  border: TclTokens.b10,
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                _Cell('ยอดระบบ', _qty(row.frozenOnHand)),
                _Cell('นับได้', _qty(row.countedQty)),
                _Cell('ส่วนต่าง', _qty(row.diff), color: _statusColor),
              ],
            ),
            if (row.countedBy != null) ...[
              const SizedBox(height: 8),
              Text('ผู้นับ ${row.countedBy}', style: TclTokens.meta()),
            ],
          ],
        ),
      );
}

class _Cell extends StatelessWidget {
  const _Cell(this.label, this.value, {this.color});

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TclTokens.meta()),
            const SizedBox(height: 2),
            Text(
              value,
              style: TclTokens.statValue(
                color ?? TclTokens.tBrightest,
              ),
            ),
          ],
        ),
      );
}

// ════════════════════════════════════════════════════════════════════════
// ชิ้นส่วนร่วม
// ════════════════════════════════════════════════════════════════════════

class _WarnNote extends StatelessWidget {
  const _WarnNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: TclTokens.warnTint14,
          borderRadius: BorderRadius.circular(TclTokens.rInput),
        ),
        child: Text(
          text,
          style: TclTokens.body13(TclTokens.tSoftAlt),
        ),
      );
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const Center(
        child: SizedBox(
          width: _spinnerSize,
          height: _spinnerSize,
          child: CircularProgressIndicator(
            strokeWidth: _spinnerStroke,
            color: TclTokens.accent,
          ),
        ),
      );
}

class _CenterNote extends StatelessWidget {
  const _CenterNote({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                textAlign: TextAlign.center,
                style: TclTokens.itemName(),
              ),
              const SizedBox(height: 6),
              Text(
                subtitle,
                textAlign: TextAlign.center,
                style: TclTokens.caption(),
              ),
            ],
          ),
        ),
      );
}

String _hhmm(DateTime value) {
  final local = value.toLocal();
  return '${local.hour.toString().padLeft(2, '0')}:'
      '${local.minute.toString().padLeft(2, '0')}';
}
