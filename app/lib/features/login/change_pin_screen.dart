import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/kittikhun_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/api_client.dart';
import '../../data/auth_repository.dart';

/// จอ "ตั้ง PIN ใหม่" — design extension (docs/design-fidelity.md §7 ข้อ 4)
///
/// ใช้สองกรณี:
/// - บังคับตั้งครั้งแรก (`forced: true`) เมื่อ login ด้วย PIN ที่ admin ให้มา
///   (`user.mustChangePin == true`)
/// - ผู้ใช้เปลี่ยน PIN เอง (`forced: false`)
///
/// ใช้ภาษา token เดียวกับจอเข้าสู่ระบบทั้งหมด: โลโก้ 54 + หัวเรื่อง → การ์ดแก้ว
/// (3 บล็อกช่อง PIN + keypad ชุดเดียว + ปุ่มบันทึก + บรรทัดสถานะ) → ปุ่มออกจากระบบ
class ChangePinScreen extends ConsumerStatefulWidget {
  const ChangePinScreen({
    super.key,
    required this.forced,
    required this.onDone,
    this.onSignOut,
  });

  /// true = บังคับตั้ง PIN ก่อนเริ่มใช้งาน (ซับไทเทิลและ copy เปลี่ยนตามนี้)
  final bool forced;

  /// เรียกเมื่อเปลี่ยน PIN สำเร็จ — ผู้เรียกพาไปหน้าถัดไป
  final VoidCallback onDone;

  /// ทางถอยเมื่อถูกบังคับตั้ง PIN (ซ่อนปุ่มเมื่อไม่ส่งมา)
  final VoidCallback? onSignOut;

  @override
  ConsumerState<ChangePinScreen> createState() => _ChangePinScreenState();
}

const int _pinLength = 6;

/// ลำดับช่อง: 0 = PIN เดิม · 1 = PIN ใหม่ · 2 = ยืนยัน PIN ใหม่
const List<String> _fieldLabels = ['PIN เดิม', 'PIN ใหม่ 6 หลัก', 'ยืนยัน PIN ใหม่'];

const String _hintMessage = 'ตั้ง PIN ที่จำได้และไม่บอกใคร';
const String _busyMessage = 'กำลังบันทึก PIN ใหม่…';
const String _fallbackError = 'เปลี่ยน PIN ไม่สำเร็จ ลองอีกครั้ง';

class _ChangePinScreenState extends ConsumerState<ChangePinScreen>
    with SingleTickerProviderStateMixin {
  final List<String> _pins = List<String>.filled(
    _fieldLabels.length,
    '',
    growable: false,
  );

  /// ช่องที่ keypad กำลังป้อนเข้า
  int _focus = 0;
  bool _busy = false;
  bool _error = false;

  /// ช่องที่ผิด (ขอบแดง) — null = error ไม่ผูกกับช่องใด
  int? _errorField;
  String _message = _hintMessage;
  bool _reduceMotion = false;

  late final AnimationController _shakeCtrl;
  late final Animation<double> _shake;

  @override
  void initState() {
    super.initState();
    _shakeCtrl = AnimationController(duration: KittikhunTokens.dNudge, vsync: this);
    // @keyframes nudge: 0%,100% = 0 · 25% = -6 · 75% = +6 (เหมือนจอเข้าสู่ระบบ)
    _shake = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween(begin: 0.0, end: -KittikhunTokens.nudgeOffset)
            .chain(CurveTween(curve: Curves.easeInOut)),
        weight: 25,
      ),
      TweenSequenceItem(
        tween: Tween(
          begin: -KittikhunTokens.nudgeOffset,
          end: KittikhunTokens.nudgeOffset,
        ).chain(CurveTween(curve: Curves.easeInOut)),
        weight: 50,
      ),
      TweenSequenceItem(
        tween: Tween(begin: KittikhunTokens.nudgeOffset, end: 0.0)
            .chain(CurveTween(curve: Curves.easeInOut)),
        weight: 25,
      ),
    ]).animate(_shakeCtrl);
  }

  @override
  void dispose() {
    _shakeCtrl.dispose();
    super.dispose();
  }

  // ══════════════════════════════════════════════════════════════════
  // keypad — ป้อนเข้าช่องที่โฟกัส · ครบ 6 หลักเลื่อนไปช่องถัดไป
  // ══════════════════════════════════════════════════════════════════

  void _press(String key) {
    if (_busy) return;
    final current = _pins[_focus];
    setState(() {
      // กดปุ่มใด ๆ ล้าง error (พฤติกรรมเดียวกับจอเข้าสู่ระบบ)
      _error = false;
      _errorField = null;
      _message = _hintMessage;
      switch (key) {
        case 'C':
          _pins[_focus] = '';
        case '⌫':
          if (current.isEmpty) {
            if (_focus > 0) _focus -= 1;
          } else {
            _pins[_focus] = current.substring(0, current.length - 1);
          }
        default:
          if (current.length < _pinLength) {
            final next = current + key;
            _pins[_focus] = next;
            if (next.length == _pinLength && _focus < _fieldLabels.length - 1) {
              _focus += 1;
            }
          }
      }
    });
  }

  void _focusField(int index) {
    if (_busy || _focus == index) return;
    setState(() => _focus = index);
  }

  // ══════════════════════════════════════════════════════════════════
  // ตรวจฝั่งแอปก่อนยิง API แล้วเรียก POST /auth/change-pin
  // ══════════════════════════════════════════════════════════════════

  /// PIN เดาง่าย: เลขซ้ำทั้งหมด หรือ 123456
  bool _isWeak(String pin) =>
      pin == '123456' || pin.split('').every((d) => d == pin[0]);

  void _fail(String message, int? field) {
    setState(() {
      _error = true;
      _errorField = field;
      _message = message;
      if (field != null) _focus = field;
    });
    if (!_reduceMotion) _shakeCtrl.forward(from: 0);
  }

  Future<void> _submit() async {
    if (_busy) return;
    final currentPin = _pins[0];
    final newPin = _pins[1];
    final confirmPin = _pins[2];

    if (currentPin.length < _pinLength) {
      _fail('กรอก PIN เดิมให้ครบ 6 หลัก', 0);
      return;
    }
    if (newPin.length < _pinLength) {
      _fail('กรอก PIN ใหม่ให้ครบ 6 หลัก', 1);
      return;
    }
    if (confirmPin != newPin) {
      _fail('PIN ยืนยันไม่ตรงกัน', 2);
      return;
    }
    if (newPin == currentPin) {
      _fail('PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม', 1);
      return;
    }
    if (_isWeak(newPin)) {
      _fail('PIN นี้เดาง่ายเกินไป', 1);
      return;
    }

    setState(() {
      _busy = true;
      _error = false;
      _errorField = null;
      _message = _busyMessage;
    });

    try {
      await ref
          .read(authRepositoryProvider)
          .changePin(currentPin: currentPin, newPin: newPin);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _pins.setAll(0, List<String>.filled(_fieldLabels.length, ''));
        _focus = 0;
        _message = _hintMessage;
      });
      widget.onDone();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      // ข้อความไทยจาก backend ตรงกับ design แล้ว — แสดงตามที่ได้รับ
      // PIN เดิมผิด → ชี้ขอบแดงที่ช่อง "PIN เดิม", error อื่นไม่ผูกกับช่องใด
      _fail(e.message, e.code == ApiException.codeInvalidPin ? 0 : null);
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      _fail(_fallbackError, null);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // build
  // ══════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    _reduceMotion = MediaQuery.disableAnimationsOf(context);
    final onSignOut = widget.onSignOut;

    return DecoratedBox(
      decoration: const BoxDecoration(gradient: KittikhunTokens.screenBg),
      child: SafeArea(
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
                  left: KittikhunTokens.gutterLogin,
                  right: KittikhunTokens.gutterLogin,
                  bottom: 30,
                ),
                sliver: SliverFillRemaining(
                  hasScrollBody: false,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _Header(forced: widget.forced),
                      _buildCard(),
                      if (onSignOut != null) ...[
                        const Spacer(),
                        Padding(
                          padding: const EdgeInsets.only(top: 24),
                          child: Center(
                            child: SecondaryButton(
                              label: 'ออกจากระบบ',
                              onPressed: _busy ? null : onSignOut,
                              height: KittikhunTokens.hDemoButton,
                              radius: KittikhunTokens.rDemoButton,
                              minWidth: 160,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCard() => GlassCard(
        radius: KittikhunTokens.rLoginCard,
        fill: KittikhunTokens.s075,
        border: KittikhunTokens.b13,
        shadow: KittikhunTokens.shLoginCard,
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < _fieldLabels.length; i++) ...[
              if (i > 0) const SizedBox(height: 18),
              _PinField(
                label: _fieldLabels[i],
                filled: _pins[i].length,
                active: _focus == i,
                error: _error && _errorField == i,
                onTap: () => _focusField(i),
              ),
            ],
            const SizedBox(height: 22),
            _Keypad(onKey: _press),
            const SizedBox(height: 20),
            PrimaryButton(
              label: 'บันทึก PIN ใหม่',
              onPressed: _busy ? null : _submit,
              height: KittikhunTokens.hSignIn,
              radius: KittikhunTokens.rButtonLarge,
              shadow: KittikhunTokens.shSignInBtn,
            ),
            const SizedBox(height: 14),
            Text(
              _message,
              textAlign: TextAlign.center,
              style: KittikhunTokens.caption(
                _error ? KittikhunTokens.bad : KittikhunTokens.tFaint,
              ),
            ),
          ],
        ),
      );
}

/// โลโก้ 54 + หัวเรื่อง "ตั้ง PIN ใหม่" + ซับไทเทิลตามกรณีที่ใช้
class _Header extends StatelessWidget {
  const _Header({required this.forced});

  final bool forced;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 26, bottom: 22),
        child: Row(
          children: [
            const BrandMark(size: 54, radius: KittikhunTokens.rLogoLarge),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('ตั้ง PIN ใหม่', style: KittikhunTokens.screenTitle()),
                  const SizedBox(height: 2),
                  Text(
                    forced
                        ? 'เพื่อความปลอดภัย กรุณาตั้ง PIN ของคุณเองก่อนเริ่มใช้งาน'
                        : 'กรอก PIN เดิมและ PIN ใหม่ 6 หลัก',
                    style: KittikhunTokens.caption(),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
}

/// label + ช่อง PIN 6 เซลล์ · แตะเพื่อเลือกช่องที่จะป้อน
class _PinField extends StatelessWidget {
  const _PinField({
    required this.label,
    required this.filled,
    required this.active,
    required this.error,
    required this.onTap,
  });

  final String label;
  final int filled;

  /// ช่องที่ keypad กำลังป้อนเข้า — ขอบ accent + label สี accent
  final bool active;
  final bool error;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final borderColor = error
        ? KittikhunTokens.errorBorder
        : (active ? KittikhunTokens.accent : KittikhunTokens.b20);
    return Semantics(
      button: true,
      label: label,
      value: '$filled/$_pinLength',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    label,
                    style: KittikhunTokens.label(
                      active ? KittikhunTokens.accent : KittikhunTokens.tMuted,
                    ),
                  ),
                ),
                Text(
                  '$filled/$_pinLength',
                  style: KittikhunTokens.display(
                    size: 12,
                    weight: FontWeight.w400,
                    color: KittikhunTokens.tFaint,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                for (var i = 0; i < _pinLength; i++) ...[
                  if (i > 0) const SizedBox(width: 10),
                  Expanded(
                    child: AnimatedContainer(
                      duration: KittikhunTokens.dKeypad,
                      height: KittikhunTokens.hPinCell,
                      decoration: BoxDecoration(
                        color: i < filled ? KittikhunTokens.accent : null,
                        border: Border.all(color: borderColor),
                        borderRadius:
                            BorderRadius.circular(KittikhunTokens.rPinCell),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// keypad ชุดเดียวของทั้งจอ — 3 คอลัมน์ · 12 ปุ่ม · gap 9
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
            duration: KittikhunTokens.dKeypad,
            height: KittikhunTokens.hKeypadKey,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _pressed ? KittikhunTokens.t28 : KittikhunTokens.s07,
              border: Border.all(color: KittikhunTokens.b11),
              borderRadius: BorderRadius.circular(KittikhunTokens.rKeypad),
            ),
            child: Text(widget.label, style: KittikhunTokens.keypadKey()),
          ),
        ),
      );
}
