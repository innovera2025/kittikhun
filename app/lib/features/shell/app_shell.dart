import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/kittikhun_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/fixtures.dart';
import '../../state/app_state.dart';
import '../count/count_screen.dart';
import '../scan/scan_screen.dart';
import '../search/search_screen.dart';
import '../team/add_member_sheet.dart';
import '../pending/pending_review_screen.dart';
import '../team/initial_pin_sheet.dart';
import 'sync_status_bar.dart';
import '../team/team_screen.dart';

/// ระยะยกตัวของ keyframe `rise` ใน design (translateY 26px → 0)
const double _riseFrom = 26;

/// 12/400 — design ใช้ 12px ที่ kicker และชื่อผู้ใช้
/// (อยู่ระหว่าง token caption 12.5/400 กับ label 12/500 → ใช้ helper thai() ตรง ๆ)
TextStyle _head12(Color color) =>
    KittikhunTokens.thai(size: 12, color: color);

/// เปลือกแอปหลัง sign-in (design §2.2) — header + เนื้อหาแท็บ + แถบแท็บล่าง
///
/// Toast (§2.8) และ sheet เพิ่มสมาชิก (§2.7) เป็น layer ใน Stack เดียวกัน
/// **ห้ามเปลี่ยนไปใช้ `showModalBottomSheet`** — barrier ของ route จะทับ toast
/// จนมองไม่เห็นข้อความ validation
/// เปิดจอ pending-review อยู่หรือไม่ (จอชั่วคราว — ไม่แตะแท็บล่าง 4 ช่องของ design)
class ShowPending extends Notifier<bool> {
  @override
  bool build() => false;

  void show() => state = true;
  void hide() => state = false;
}

final showPendingProvider =
    NotifierProvider<ShowPending, bool>(ShowPending.new);

class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(appProvider);
    final controller = ref.read(appProvider.notifier);
    final head = Fixtures.heads[state.tab] ?? Fixtures.heads[AppTab.scan]!;

    return Stack(
      fit: StackFit.expand,
      children: [
        Column(
          children: [
            _Header(
              kicker: head.$1,
              title: head.$2,
              name: state.me.name,
              role: state.me.role.label,
              initials: state.me.initials,
            ),
            // design extension: แถบสถานะซิงค์ (ซ่อนเองเมื่อไม่มีอะไรต้องบอก)
            SyncStatusBar(
              pendingCount: ref.watch(pendingReviewProvider).maybeWhen(
                    data: (rows) => rows.length,
                    orElse: () => 0,
                  ),
              onTapPending: () =>
                  ref.read(showPendingProvider.notifier).show(),
            ),
            Expanded(
              child: ref.watch(showPendingProvider)
                  ? const PendingReviewScreen()
                  : _screenFor(state.tab),
            ),
            _TabBar(
              current: state.tab,
              onSelect: (tab) {
                ref.read(showPendingProvider.notifier).hide();
                controller.goTab(tab);
              },
            ),
          ],
        ),

        // sheet ต้องอยู่ใต้ toast เสมอ (ลำดับใน Stack = ลำดับการวาด)
        if (state.addSheetOpen)
          const Positioned.fill(
            child: Stack(
              fit: StackFit.expand,
              children: [
                // dismissible:false — design ไม่ปิด sheet ด้วยการแตะฉากหลัง
                ModalBarrier(color: KittikhunTokens.scrim, dismissible: false),
                Padding(
                  padding: EdgeInsets.all(16),
                  child: Align(
                    alignment: Alignment.bottomCenter,
                    child: AddMemberSheet(),
                  ),
                ),
              ],
            ),
          ),

        // จอแสดง PIN เริ่มต้นหลังเพิ่มสมาชิก / admin reset PIN — แสดงครั้งเดียว
        // วางหลัง add-member sheet เพราะเปิดต่อจากกันได้ และต้องทับ sheet เดิม
        if (state.lastInitialPin != null)
          Positioned.fill(
            child: Stack(
              fit: StackFit.expand,
              children: [
                const ModalBarrier(
                  color: KittikhunTokens.scrim,
                  dismissible: false,
                ),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Align(
                    alignment: Alignment.bottomCenter,
                    child: InitialPinSheet(
                      empId: state.lastInitialPin!.empId,
                      name: state.lastInitialPin!.name,
                      pin: state.lastInitialPin!.pin,
                      onDismiss: controller.dismissInitialPin,
                    ),
                  ),
                ),
              ],
            ),
          ),

        if (state.toast != null)
          Positioned(
            left: 20,
            right: 20,
            bottom: KittikhunTokens.toastBottomOffset,
            // key ผูกกับข้อความ → ข้อความใหม่ remount แล้วเล่นอนิเมชัน rise ซ้ำ
            child: _Toast(key: ValueKey(state.toast), message: state.toast!),
          ),
      ],
    );
  }

  Widget _screenFor(AppTab tab) => switch (tab) {
    AppTab.scan => const ScanScreen(),
    AppTab.search => const SearchScreen(),
    AppTab.count => const CountScreen(),
    AppTab.team => const TeamScreen(),
  };
}

// ════════════════════════════════════════════════════════════════════
// Header — logo 34 + kicker/title ต่อแท็บ + บล็อกผู้ใช้ + avatar 42
// ════════════════════════════════════════════════════════════════════

class _Header extends StatelessWidget {
  const _Header({
    required this.kicker,
    required this.title,
    required this.name,
    required this.role,
    required this.initials,
  });

  final String kicker;
  final String title;
  final String name;
  final String role;
  final String initials;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 8, 22, 16),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // จำกัดบล็อกผู้ใช้ไม่เกิน 34% ของความกว้าง — ชื่อยาวจึงไม่ดันหัวเรื่องหาย
          // (ถ้าชื่อสั้นกว่านี้ บล็อกก็ยังหุบตามเนื้อหา ให้หัวเรื่องได้พื้นที่เต็ม)
          final userMax = constraints.maxWidth * 0.34;
          return Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    const BrandMark(
                      size: 34,
                      radius: KittikhunTokens.rLogoSmall,
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            kicker,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: _head12(KittikhunTokens.tMuted),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: KittikhunTokens.screenTitle(),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: userMax),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            name,
                            maxLines: 1,
                            textAlign: TextAlign.right,
                            overflow: TextOverflow.ellipsis,
                            style: _head12(KittikhunTokens.tSoft),
                          ),
                          Text(
                            role,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: KittikhunTokens.roleKicker(),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    _HeaderAvatar(initials: initials),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _HeaderAvatar extends StatelessWidget {
  const _HeaderAvatar({required this.initials});

  final String initials;

  @override
  Widget build(BuildContext context) => Container(
    width: 42,
    height: 42,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: KittikhunTokens.t16,
      border: Border.all(color: KittikhunTokens.t30),
      borderRadius: BorderRadius.circular(KittikhunTokens.rHeaderAvatar),
    ),
    child: Text(
      initials,
      style: KittikhunTokens.display(
        size: 14,
        weight: FontWeight.w600,
        color: KittikhunTokens.accentHover,
      ),
    ),
  );
}

// ════════════════════════════════════════════════════════════════════
// แถบแท็บล่าง — grid 4 ช่อง gap 4 ใน container r24 พื้น s09
// ════════════════════════════════════════════════════════════════════

class _TabBar extends StatelessWidget {
  const _TabBar({required this.current, required this.onSelect});

  final AppTab current;
  final ValueChanged<AppTab> onSelect;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      KittikhunTokens.gutterTab,
      6,
      KittikhunTokens.gutterTab,
      16,
    ),
    child: Container(
      padding: const EdgeInsets.all(7),
      decoration: BoxDecoration(
        color: KittikhunTokens.s09,
        border: Border.all(color: KittikhunTokens.b13),
        borderRadius: BorderRadius.circular(KittikhunTokens.rTabBar),
        boxShadow: KittikhunTokens.shTabBar,
      ),
      child: Row(
        children: [
          for (final tab in AppTab.values) ...[
            if (tab.index > 0) const SizedBox(width: 4),
            Expanded(
              child: _TabButton(
                tab: tab,
                active: tab == current,
                onTap: () => onSelect(tab),
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

class _TabButton extends StatelessWidget {
  const _TabButton({
    required this.tab,
    required this.active,
    required this.onTap,
  });

  final AppTab tab;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = active ? KittikhunTokens.onAccent : KittikhunTokens.tMuted;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: active ? KittikhunTokens.activeTabGradient : null,
        borderRadius: BorderRadius.circular(KittikhunTokens.rTabButton),
      ),
      child: Semantics(
        button: true,
        selected: active,
        child: Tappable(
          onTap: onTap,
          radius: KittikhunTokens.rTabButton,
          child: SizedBox(
            height: KittikhunTokens.hTabButton,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                StrokeIcon(
                  painter: _TabIconPainter(tab: tab, color: fg),
                  size: 21,
                  color: fg,
                ),
                const SizedBox(height: 4),
                Text(tab.label, style: KittikhunTokens.tiny(fg)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// ไอคอนแท็บ — path เดียวกับ SVG ใน design (viewBox 24, stroke 1.7)
class _TabIconPainter extends CustomPainter {
  const _TabIconPainter({required this.tab, required this.color});

  final AppTab tab;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;

    canvas.save();
    // เขียน path ในพิกัด viewBox 24 แล้วย่อลงตามขนาดจริง (stroke ย่อตามด้วย)
    canvas.scale(size.width / 24);
    switch (tab) {
      case AppTab.scan:
        canvas.drawPath(
          Path()
            ..moveTo(3, 8)
            ..lineTo(3, 6.5)
            ..arcToPoint(
              const Offset(5.5, 4),
              radius: const Radius.circular(2.5),
            )
            ..lineTo(7, 4)
            ..moveTo(17, 4)
            ..lineTo(18.5, 4)
            ..arcToPoint(
              const Offset(21, 6.5),
              radius: const Radius.circular(2.5),
            )
            ..lineTo(21, 8)
            ..moveTo(21, 16)
            ..lineTo(21, 17.5)
            ..arcToPoint(
              const Offset(18.5, 20),
              radius: const Radius.circular(2.5),
            )
            ..lineTo(17, 20)
            ..moveTo(7, 20)
            ..lineTo(5.5, 20)
            ..arcToPoint(
              const Offset(3, 17.5),
              radius: const Radius.circular(2.5),
            )
            ..lineTo(3, 16)
            ..moveTo(3, 12)
            ..lineTo(21, 12),
          paint,
        );
      case AppTab.search:
        canvas.drawCircle(const Offset(11, 11), 7, paint);
        canvas.drawLine(const Offset(20, 20), const Offset(15.7, 15.7), paint);
      case AppTab.count:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(5, 4, 14, 17),
            const Radius.circular(3),
          ),
          paint,
        );
        canvas.drawPath(
          Path()
            ..moveTo(9.5, 3.5)
            ..lineTo(14.5, 3.5)
            ..moveTo(9, 11)
            ..lineTo(15, 11)
            ..moveTo(9, 15)
            ..lineTo(13, 15),
          paint,
        );
      case AppTab.team:
        canvas.drawCircle(const Offset(9, 8), 3.4, paint);
        canvas.drawPath(
          Path()
            ..moveTo(3, 20)
            ..cubicTo(3, 16.6, 5.8, 14.4, 9, 14.4)
            ..cubicTo(12.2, 14.4, 15, 16.6, 15, 20)
            ..moveTo(16, 6.6)
            ..arcToPoint(
              const Offset(16, 12.4),
              radius: const Radius.circular(3),
            )
            ..moveTo(18.5, 20)
            ..cubicTo(18.5, 17.5, 17.6, 16, 16.3, 15.2),
          paint,
        );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_TabIconPainter oldDelegate) =>
      oldDelegate.tab != tab || oldDelegate.color != color;
}

// ════════════════════════════════════════════════════════════════════
// Toast — ลอยเหนือแถบแท็บ 96px · เข้าแบบ rise · หมดอายุที่ AppController
// ════════════════════════════════════════════════════════════════════

class _Toast extends StatefulWidget {
  const _Toast({super.key, required this.message});

  final String message;

  @override
  State<_Toast> createState() => _ToastState();
}

class _ToastState extends State<_Toast> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl = AnimationController(
    vsync: this,
    duration: KittikhunTokens.dRiseToast,
  );
  late final Animation<double> _rise = CurvedAnimation(
    parent: _ctrl,
    curve: KittikhunTokens.cRise,
  );

  @override
  void initState() {
    super.initState();
    _ctrl.forward();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: _rise,
        builder: (context, child) => Opacity(
          opacity: _rise.value.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, _riseFrom * (1 - _rise.value)),
            child: child,
          ),
        ),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          decoration: BoxDecoration(
            color: KittikhunTokens.toastBg,
            border: Border.all(color: KittikhunTokens.b16),
            borderRadius: BorderRadius.circular(KittikhunTokens.rToast),
            boxShadow: KittikhunTokens.shToast,
          ),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                  color: KittikhunTokens.accent,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(widget.message, style: KittikhunTokens.body13()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
