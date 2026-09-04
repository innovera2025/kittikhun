import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../data/fixtures.dart';
import '../../state/app_state.dart';
import '../scan/handheld_scan_buffer.dart';

/// นาฬิกาวัดจังหวะคีย์ของช่องรหัสผ่าน — เทสต์เท่านั้นที่เปลี่ยน
///
/// เหตุผลเดียวกับ `handheldNow` ของจอสแกน (`tester.pump()` ไม่ขยับ
/// `DateTime.now()` เทสต์ที่วัดความเร็วคีย์จึงคุมจังหวะไม่ได้ถ้าไม่มีตะเข็บนี้)
/// **แยกตัวจากของจอสแกนโดยจำเป็น** ไม่ใช่โดยเลือก: ตัวนั้นเป็น
/// `@visibleForTesting` ของไลบรารีจอสแกน โค้ด production ข้ามไลบรารีไปใช้ไม่ได้
@visibleForTesting
DateTime Function() loginScanNow = DateTime.now;

/// ข้อความเตือนเมื่อด่านกันเครื่องยิงกลืนบาร์โค้ดที่ช่องรหัสผ่าน (design §2.1)
const String _kScanBlockedNotice =
    'ตรวจพบการสแกนขณะกรอกรหัสผ่าน · กรุณาพิมพ์ด้วยตนเอง';

/// จอเข้าสู่ระบบ — design §2.1
///
/// โครง: โลโก้ + แบรนด์ → การ์ดแก้ว (ช่องชื่อผู้ใช้ · ช่องรหัสผ่าน ·
/// ปุ่มเข้าสู่ระบบ · บรรทัดสถานะ) → chips ล่างสุด
///
/// ⚠️ ไม่มี keypad 6 หลักแล้ว — ล็อกอินคือชื่อผู้ใช้/รหัสผ่านของ ERP ซึ่งพิมพ์
/// ด้วยแป้นตัวเลขไม่ได้ (ดู PLAN ล็อกอินผ่าน ERP กลุ่ม E)
/// ⚠️ ไม่มี chip "PIN 000000" (prototype artifact — design-fidelity.md §6 ข้อ 2)
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen>
    with SingleTickerProviderStateMixin {
  late final TextEditingController _empCtrl;
  late final TextEditingController _pwdCtrl;
  late final AnimationController _shakeCtrl;
  late final Animation<double> _shake;
  bool _empFocused = false;
  bool _pwdFocused = false;

  /// ด่านกันเครื่องยิงบาร์โค้ดที่ช่องรหัสผ่าน — คลาสเดียวกับที่จอสแกนใช้
  /// (เครื่องยิงเป็น HID keyboard-wedge เหนี่ยวไกเผลอขณะช่องนี้โฟกัสอยู่ =
  ///  บาร์โค้ดถูกพิมพ์ลงช่องที่บดบังไว้เงียบ ๆ แล้วโดน throttle โดยไม่มีคำอธิบาย)
  final HandheldScanBuffer _pwdScan = HandheldScanBuffer();

  @override
  void initState() {
    super.initState();
    _empCtrl = TextEditingController(text: ref.read(appProvider).empId);
    _pwdCtrl = TextEditingController(text: ref.read(appProvider).pin);
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
    _pwdCtrl.dispose();
    _shakeCtrl.dispose();
    super.dispose();
  }

  /// ให้ช่องกรอกตรงกับ state เสมอ — state เป็นเจ้าของค่า ช่องเป็นแค่เงา
  /// (จุดที่จำเป็นจริง: รหัสผิด → state ล้าง `pin` ช่องต้องว่างตามทันที)
  static void _syncField(TextEditingController ctrl, String value) {
    if (ctrl.text == value) return;
    ctrl.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
  }

  /// ล้างช่องรหัสผ่านทั้งช่อง (ทั้งตัวที่รั่วเข้ามาและที่พิมพ์ไว้ก่อนหน้า)
  ///
  /// ไม่มีกลไก snapshot/restore แบบจอสแกน เพราะช่องรหัสผ่าน **ไม่มี "ค่าที่ถูกต้อง
  /// ให้กู้คืน"** — เดาไม่ได้ว่าตัวไหนคนพิมพ์ ตัวไหนเครื่องยิง กลืนแล้วล้างทั้งช่อง
  /// จึงเป็นพฤติกรรมเดียวที่ไม่ทำให้คนล็อกอินด้วยรหัสที่ตัวเองไม่ได้พิมพ์
  void _clearPassword() {
    _pwdCtrl.clear();
    ref.read(appProvider.notifier).setPassword('');
  }

  /// คีย์ที่ช่องรหัสผ่าน — กลืนทั้งชุดถ้ามาจากเครื่องยิง (แผน E-6)
  ///
  /// อักขระ**ตัวแรก**ของทุกสายรัวพิสูจน์ไม่ได้ว่ามาจากเครื่อง (ต้องมีตัวที่สองมา
  /// เทียบช่องไฟก่อน) จึงรั่วลงช่องไปแล้วเสมอตอนที่เรารู้ตัว — ล้างทั้งช่องทันทีที่
  /// สายรัวถูกพิสูจน์ ไม่รอ Enter ปิดท้าย (เครื่องที่ปิด suffix ไม่ส่ง Enter เลย
  /// อักขระที่รั่วไปจะค้างถาวรถ้ารอ)
  ///
  /// ⚠️ ด่านคือ `swallow` **ไม่ใช่** `code != null` — คนที่พิมพ์รหัสผ่านเองแล้วกด
  /// Enter ปิดท้ายก็ทำให้บัฟเฟอร์คืน `code` ได้เหมือนกัน (แต่ `swallow` เป็น false
  /// เพราะไม่เคยเข้าสายรัว) ล้างช่องตรงนั้น = ลบรหัสผ่านที่เขาเพิ่งพิมพ์ทิ้งเงียบ ๆ
  /// พังหนักกว่าบั๊กที่กำลังกันอยู่ — กับดักเดียวกับที่ `_onHandheldKey` ของจอสแกน
  /// เขียนกำกับไว้
  KeyEventResult _onPasswordKey(KeyEvent event) {
    // สถานะสายรัว **ก่อน** ป้อนคีย์นี้ — `feed` ล้าง `_burst` ทิ้งทันทีที่รหัสจบ
    // อ่านหลัง `feed` จะได้ false เสมอ ใช้ตัดสิน "เตือนไปแล้วหรือยัง" ไม่ได้
    final wasInBurst = _pwdScan.inBurst;
    if (!_pwdScan.feed(event, now: loginScanNow()).swallow) {
      return KeyEventResult.ignored; // จังหวะคน — ปล่อยให้ TextField รับตามปกติ
    }
    _clearPassword();
    // เตือนครั้งเดียวต่อการยิงหนึ่งใบ (ตอนที่สายรัวเพิ่งถูกพิสูจน์) ไม่ใช่ทุกอักขระ
    if (!wasInBurst) ref.read(appProvider.notifier).flash(_kScanBlockedNotice);
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(appProvider);
    final c = ref.read(appProvider.notifier);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;

    ref.listen<String>(
      appProvider.select((s) => s.empId),
      (_, next) => _syncField(_empCtrl, next),
    );
    ref.listen<String>(
      appProvider.select((s) => s.pin),
      (_, next) => _syncField(_pwdCtrl, next),
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
                          passwordController: _pwdCtrl,
                          passwordFocused: _pwdFocused,
                          onPasswordFocusChange: (f) =>
                              setState(() => _pwdFocused = f),
                          onPasswordKey: _onPasswordKey,
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
                    'เข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน',
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
    required this.passwordController,
    required this.passwordFocused,
    required this.onPasswordFocusChange,
    required this.onPasswordKey,
  });

  final AppState state;
  final AppController controller;
  final TextEditingController empController;
  final bool empFocused;
  final ValueChanged<bool> onEmpFocusChange;
  final TextEditingController passwordController;
  final bool passwordFocused;
  final ValueChanged<bool> onPasswordFocusChange;

  /// ด่านกันเครื่องยิงบาร์โค้ด — ดู `_LoginScreenState._onPasswordKey`
  final KeyEventResult Function(KeyEvent) onPasswordKey;

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
          Text('ชื่อผู้ใช้ · Username', style: TclTokens.label()),
          const SizedBox(height: 8),
          FieldBox(
            height: TclTokens.hInput,
            radius: TclTokens.rInput,
            focused: empFocused,
            error: state.loginError,
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
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Text('รหัสผ่าน · Password', style: TclTokens.label()),
          const SizedBox(height: 8),
          FieldBox(
            height: TclTokens.hInput,
            radius: TclTokens.rInput,
            focused: passwordFocused,
            error: state.loginError,
            // Focus ชั้นนี้เห็นคีย์ก่อน TextInputPlugin จะพิมพ์ลงช่อง — คืน
            // `handled` = อักขระของเครื่องยิงไม่มีทางถึงช่องที่บดบังไว้
            child: Focus(
              onFocusChange: onPasswordFocusChange,
              onKeyEvent: (_, event) => onPasswordKey(event),
              child: TokenTextField(
                controller: passwordController,
                onChanged: controller.setPassword,
                hint: '',
                style: TclTokens.body15(),
                obscure: true,
                maxLength: 128,
              ),
            ),
          ),
          const SizedBox(height: 22),
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
          // จอนี้อยู่นอก AppShell จึงไม่มีชั้น toast ให้วาด — บรรทัดสถานะเดิม
          // ทำหน้าที่นั้นแทน (คำเตือนของด่านกันเครื่องยิงต้องมีที่ให้เห็นจริง
          // ไม่ใช่ค่าที่ตั้งไว้ใน state แล้วไม่มีใครแสดง)
          Text(
            state.toast ?? state.loginMessage,
            textAlign: TextAlign.center,
            style: TclTokens.caption(
              state.loginError || state.toast != null
                  ? TclTokens.bad
                  : TclTokens.tFaint,
            ),
          ),
        ],
      ),
    );
  }
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
