import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../data/fixtures.dart';
import '../../state/app_state.dart';

/// จอเข้าสู่ระบบ — design §2.1
///
/// โครง: โลโก้ + แบรนด์ → การ์ดแก้ว (ช่องรหัสพนักงาน · PIN 6 เซลล์ · keypad ·
/// ปุ่มเข้าสู่ระบบ · บรรทัดสถานะ) → chips ล่างสุด
///
/// ⚠️ ไม่มี chip "PIN 000000" (prototype artifact — design-fidelity.md §6 ข้อ 2)
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen>
    with SingleTickerProviderStateMixin {
  late final TextEditingController _empCtrl;
  late final AnimationController _shakeCtrl;
  late final Animation<double> _shake;
  bool _empFocused = false;

  @override
  void initState() {
    super.initState();
    _empCtrl = TextEditingController(text: ref.read(appProvider).empId);
    _shakeCtrl = AnimationController(duration: TclTokens.dNudge, vsync: this);
    // @keyframes nudge: 0%,100% = 0 · 25% = -6 · 75% = +6
    _shake = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween(begin: 0.0, end: -TclTokens.nudgeOffset)
            .chain(CurveTween(curve: Curves.easeInOut)),
        weight: 25,
      ),
      TweenSequenceItem(
        tween: Tween(
          begin: -TclTokens.nudgeOffset,
          end: TclTokens.nudgeOffset,
        ).chain(CurveTween(curve: Curves.easeInOut)),
        weight: 50,
      ),
      TweenSequenceItem(
        tween: Tween(begin: TclTokens.nudgeOffset, end: 0.0)
            .chain(CurveTween(curve: Curves.easeInOut)),
        weight: 25,
      ),
    ]).animate(_shakeCtrl);
  }

  @override
  void dispose() {
    _empCtrl.dispose();
    _shakeCtrl.dispose();
    super.dispose();
  }

  /// ให้ช่องกรอกตรงกับ state เสมอ (state ตัดอักขระที่ไม่ใช่ตัวเลข / จำกัด 6 หลัก)
  void _syncEmpField(String value) {
    if (_empCtrl.text == value) return;
    _empCtrl.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(appProvider);
    final c = ref.read(appProvider.notifier);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;

    ref.listen<String>(
      appProvider.select((s) => s.empId),
      (_, next) => _syncEmpField(next),
    );
    // error ใหม่ = สั่นหนึ่งรอบ (กดปุ่มใด ๆ ล้าง error → ครั้งถัดไปสั่นได้อีก)
    ref.listen<bool>(appProvider.select((s) => s.loginError), (prev, next) {
      if (next && prev != true && !reduceMotion) _shakeCtrl.forward(from: 0);
    });

    return DecoratedBox(
      decoration: const BoxDecoration(gradient: TclTokens.screenBg),
      child: SafeArea(
        child: Padding(
          // หลบคีย์บอร์ด (เป็น 0 ถ้ามี Scaffold ชั้นนอกจัดการให้แล้ว)
          padding: EdgeInsets.only(bottom: keyboardInset),
          child: AnimatedBuilder(
            animation: _shake,
            builder: (context, child) => Transform.translate(
              offset: Offset(_shake.value, 0),
              child: child,
            ),
            child: CustomScrollView(
              slivers: [
                SliverPadding(
                  padding: const EdgeInsets.only(
                    left: TclTokens.gutterLogin,
                    right: TclTokens.gutterLogin,
                    bottom: 30,
                  ),
                  sliver: SliverFillRemaining(
                    hasScrollBody: false,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const _Brand(),
                        _LoginCard(
                          state: s,
                          controller: c,
                          empController: _empCtrl,
                          empFocused: _empFocused,
                          onEmpFocusChange: (f) =>
                              setState(() => _empFocused = f),
                        ),
                        const Spacer(),
                        const Padding(
                          padding: EdgeInsets.only(top: 24),
                          child: _EnvChips(),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// โลโก้ 54 + แบรนด์ + ซับไทเทิล (padding 26 บน / 22 ล่าง · gap 14)
class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 26, bottom: 22),
        child: Row(
          children: [
            const BrandMark(size: 54, radius: TclTokens.rLogoLarge),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('TCL', style: TclTokens.brand()),
                  const SizedBox(height: 2),
                  Text(
                    'เข้าสู่ระบบด้วยรหัสพนักงานและ PIN',
                    style: TclTokens.caption(),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
}

/// การ์ดแก้วของฟอร์มเข้าสู่ระบบ
class _LoginCard extends StatelessWidget {
  const _LoginCard({
    required this.state,
    required this.controller,
    required this.empController,
    required this.empFocused,
    required this.onEmpFocusChange,
  });

  final AppState state;
  final AppController controller;
  final TextEditingController empController;
  final bool empFocused;
  final ValueChanged<bool> onEmpFocusChange;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      radius: TclTokens.rLoginCard,
      fill: TclTokens.s075,
      border: TclTokens.b13,
      shadow: TclTokens.shLoginCard,
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'รหัสพนักงาน · Employee ID',
            style: TclTokens.label(),
          ),
          const SizedBox(height: 8),
          FieldBox(
            height: TclTokens.hInput,
            radius: TclTokens.rInput,
            focused: empFocused,
            child: Row(
              children: [
                const StrokeIcon(
                  painter: _PersonPainter(color: TclTokens.accent),
                  size: 18,
                  color: TclTokens.accent,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Focus(
                    onFocusChange: onEmpFocusChange,
                    child: TokenTextField(
                      controller: empController,
                      onChanged: controller.setEmpId,
                      hint: '',
                      style: TclTokens.empIdInput(),
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text('รหัส PIN · 6 หลัก', style: TclTokens.label()),
              ),
              Text(
                '${state.pin.length}/6',
                style: TclTokens.display(
                  size: 12,
                  weight: FontWeight.w400,
                  color: TclTokens.tFaint,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          _PinCells(filled: state.pin.length, error: state.loginError),
          const SizedBox(height: 22),
          _Keypad(onKey: controller.pressKey),
          const SizedBox(height: 20),
          PrimaryButton(
            label: 'เข้าสู่ระบบ',
            onPressed: controller.signIn,
            height: TclTokens.hSignIn,
            radius: TclTokens.rButtonLarge,
            shadow: TclTokens.shSignInBtn,
            trailingIcon: const StrokeIcon(
              painter: _ArrowRightPainter(color: TclTokens.onAccent),
              size: 18,
              color: TclTokens.onAccent,
            ),
          ),
          const SizedBox(height: 14),
          Text(
            state.loginMessage,
            textAlign: TextAlign.center,
            style: TclTokens.caption(
              state.loginError ? TclTokens.bad : TclTokens.tFaint,
            ),
          ),
        ],
      ),
    );
  }
}

/// ช่อง PIN 6 เซลล์ — เติมสี accent ซ้าย→ขวา · ขอบแดงเมื่อ error
class _PinCells extends StatelessWidget {
  const _PinCells({required this.filled, required this.error});

  final int filled;
  final bool error;

  static const int _count = 6;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          for (var i = 0; i < _count; i++) ...[
            if (i > 0) const SizedBox(width: 10),
            Expanded(
              child: Container(
                height: TclTokens.hPinCell,
                decoration: BoxDecoration(
                  color: i < filled ? TclTokens.accent : null,
                  border: Border.all(
                    color: error
                        ? TclTokens.errorBorder
                        : TclTokens.b20,
                  ),
                  borderRadius: BorderRadius.circular(TclTokens.rPinCell),
                ),
              ),
            ),
          ],
        ],
      );
}

/// keypad 3 คอลัมน์ · 12 ปุ่ม · gap 9
class _Keypad extends StatelessWidget {
  const _Keypad({required this.onKey});

  final ValueChanged<String> onKey;

  static const List<List<String>> _rows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['C', '0', '⌫'],
  ];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          for (var r = 0; r < _rows.length; r++) ...[
            if (r > 0) const SizedBox(height: 9),
            Row(
              children: [
                for (var i = 0; i < _rows[r].length; i++) ...[
                  if (i > 0) const SizedBox(width: 9),
                  Expanded(
                    child: _KeypadKey(
                      label: _rows[r][i],
                      onTap: () => onKey(_rows[r][i]),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ],
      );
}

class _KeypadKey extends StatefulWidget {
  const _KeypadKey({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  State<_KeypadKey> createState() => _KeypadKeyState();
}

class _KeypadKeyState extends State<_KeypadKey> {
  bool _pressed = false;

  void _set(bool v) => setState(() => _pressed = v);

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: widget.label,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => _set(true),
          onTapUp: (_) => _set(false),
          onTapCancel: () => _set(false),
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: TclTokens.dKeypad,
            height: TclTokens.hKeypadKey,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _pressed ? TclTokens.t28 : TclTokens.s07,
              border: Border.all(color: TclTokens.b11),
              borderRadius: BorderRadius.circular(TclTokens.rKeypad),
            ),
            child: Text(widget.label, style: TclTokens.keypadKey()),
          ),
        ),
      );
}

/// chips ล่างสุด — คลังและเวอร์ชันเท่านั้น
class _EnvChips extends StatelessWidget {
  const _EnvChips();

  @override
  Widget build(BuildContext context) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          // ⚠️ ก่อน login ยังไม่รู้คลังของผู้ใช้ — ต่อ backend จริงจึงไม่โชว์ชื่อคลัง
          //    (เดิมโชว์ 'WH-BKK-02' ซึ่งเป็นค่าตัวอย่าง ทำให้เข้าใจผิดตั้งแต่หน้าแรก)
          for (final label in [
            if (!ApiConfig.isConfigured) Fixtures.warehouseCode,
            Fixtures.appVersion,
          ])
            Pill(
              label: label,
              background: TclTokens.s085,
              style: TclTokens.chip(),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
            ),
        ],
      );
}

// ══════════════════════════════════════════════════════════════════════
// ไอคอน — path เดียวกับ SVG ใน design (viewBox 24)
// ══════════════════════════════════════════════════════════════════════

/// ไอคอนคนในช่องรหัสพนักงาน (stroke 1.8 round)
class _PersonPainter extends CustomPainter {
  const _PersonPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    canvas.drawCircle(const Offset(12, 8.5), 3.5, p);
    // M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5
    final shoulders = Path()
      ..moveTo(5, 20)
      ..cubicTo(5, 16.4, 8.1, 14.5, 12, 14.5)
      ..cubicTo(15.9, 14.5, 19, 16.4, 19, 20);
    canvas.drawPath(shoulders, p);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_PersonPainter old) => old.color != color;
}

/// ลูกศรขวาบนปุ่มเข้าสู่ระบบ (stroke 2 round)
class _ArrowRightPainter extends CustomPainter {
  const _ArrowRightPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    // M5 12h13
    canvas.drawLine(const Offset(5, 12), const Offset(18, 12), p);
    // M12.5 6.5 19 12l-6.5 5.5
    final head = Path()
      ..moveTo(12.5, 6.5)
      ..lineTo(19, 12)
      ..lineTo(12.5, 17.5);
    canvas.drawPath(head, p);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_ArrowRightPainter old) => old.color != color;
}
