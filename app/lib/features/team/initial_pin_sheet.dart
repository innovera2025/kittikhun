import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';

// ── ระยะภายใน sheet (ค่าเดียวกับ design §2.7 — ใช้ที่ไฟล์นี้ที่เดียว) ─────
const double _sheetPadding = 22;
const double _sectionGap = 16;
const double _labelGap = 7;
const double _titleGap = 2;
const double _rowGap = 4;
const double _valueGap = 7;
const double _grabberWidth = 42;
const double _grabberHeight = 4;

/// rise: translateY 26 → 0 + fade (`@keyframes rise` ใน design)
const double _riseOffset = 26;

/// พื้นความสูงขั้นต่ำ — กันกรณีคำนวณพื้นที่ที่เหลือได้ค่าติดลบ
const double _minSheetHeight = 160;

/// บล็อก PIN: padding 18 บน-ล่าง / 16 ซ้าย-ขวา
const EdgeInsets _pinBlockPadding =
    EdgeInsets.symmetric(vertical: 18, horizontal: 16);

/// ตัวเลข PIN 6 หลัก — 34/700 ls 8 (Space Grotesk) จัดกลาง
const double _pinFontSize = 34;
const double _pinLetterSpacing = 8;

/// รหัสพนักงาน: Space Grotesk 13px ls .08em (เท่าบรรทัด SKU)
const double _empIdFontSize = 13;
const double _empIdLetterSpacing = 1.04;

/// ปุ่มล่างใน sheet 15px ตาม design (ไม่ใช่ 16px ของ CTA หลักปกติ)
const double _actionFontSize = 15;

/// ไอคอนเตือนหน้าข้อความ "แสดงเพียงครั้งเดียว"
const double _warnIconSize = 14;
const double _warnIconGap = 7;

/// ระยะที่ปุ่มคัดลอกค้างข้อความ "คัดลอกแล้ว"
const Duration _copiedHold = Duration(seconds: 2);

const String _copyLabel = 'คัดลอก PIN';
const String _copiedLabel = 'คัดลอกแล้ว';

/// Bottom sheet "เพิ่มสมาชิกแล้ว" — แสดง PIN เริ่มต้นที่ server สุ่มให้
/// (design extension — `docs/design-fidelity.md` §7 ข้อ 5)
///
/// ⚠️ เป็น widget ธรรมดาที่ AppShell วางใน `Stack` เดียวกับ toast
/// (ห้ามใช้ `showModalBottomSheet` — toast จะจมใต้ barrier)
/// scrim และตำแหน่งชิดขอบล่างเป็นหน้าที่ของ AppShell
///
/// ⚠️ PIN รับมาทาง constructor แล้วแสดงทิ้ง — **ห้าม log และห้ามเขียนลง storage**
/// (คลิปบอร์ดเป็นการกระทำที่ผู้ใช้สั่งเองเท่านั้น)
class InitialPinSheet extends ConsumerStatefulWidget {
  const InitialPinSheet({
    super.key,
    required this.empId,
    required this.name,
    required this.pin,
    required this.onDismiss,
  });

  final String empId;
  final String name;

  /// PIN เริ่มต้น 6 หลัก — แสดงครั้งเดียว ปิดแล้วดูย้อนหลังไม่ได้
  final String pin;

  /// ปิด sheet (ผู้เรียกล้าง state ที่ถือ PIN ไว้)
  final VoidCallback onDismiss;

  @override
  ConsumerState<InitialPinSheet> createState() => _InitialPinSheetState();
}

class _InitialPinSheetState extends ConsumerState<InitialPinSheet>
    with SingleTickerProviderStateMixin {
  late final AnimationController _riseCtrl;
  late final Animation<double> _rise;

  /// true = ปุ่มคัดลอกกำลังแสดง "คัดลอกแล้ว" (sheet ทับ toast จึงยืนยันที่ปุ่ม)
  bool _copied = false;
  Timer? _copiedTimer;

  @override
  void initState() {
    super.initState();
    _riseCtrl = AnimationController(
      duration: TclTokens.dRiseSheet,
      vsync: this,
    );
    _rise = CurvedAnimation(parent: _riseCtrl, curve: TclTokens.cRise);
    _riseCtrl.forward();
  }

  @override
  void dispose() {
    _copiedTimer?.cancel();
    _riseCtrl.dispose();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.pin));
    if (!mounted) return;
    setState(() => _copied = true);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(_copiedHold, () {
      if (!mounted) return;
      setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.disableAnimationsOf(context);

    // เพดานความสูงคิดจากจอ — parent constraint ที่แคบกว่าจะชนะเองใน ConstrainedBox
    final maxHeight = math.max(
      _minSheetHeight,
      MediaQuery.sizeOf(context).height -
          MediaQuery.paddingOf(context).vertical,
    );

    return AnimatedBuilder(
      animation: _rise,
      builder: (context, child) {
        final t = reduceMotion ? 1.0 : _rise.value;
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, _riseOffset * (1 - t)),
            child: child,
          ),
        );
      },
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            gradient: TclTokens.sheetBg,
            border: Border.all(color: TclTokens.b15),
            borderRadius: BorderRadius.circular(TclTokens.rSheet),
            boxShadow: TclTokens.shSheet,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(_sheetPadding),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const _Grabber(),
                const SizedBox(height: _sectionGap),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('เพิ่มสมาชิกแล้ว', style: TclTokens.sheetTitle()),
                    const SizedBox(height: _titleGap),
                    Text(
                      'แจ้ง PIN นี้ให้พนักงาน — ระบบจะบังคับตั้ง PIN ใหม่เมื่อเข้าใช้งานครั้งแรก',
                      style: TclTokens.caption(),
                    ),
                  ],
                ),
                const SizedBox(height: _sectionGap),
                _MemberBlock(name: widget.name, empId: widget.empId),
                const SizedBox(height: _sectionGap),
                _PinBlock(pin: widget.pin),
                const SizedBox(height: _sectionGap),
                SecondaryButton(
                  label: _copied ? _copiedLabel : _copyLabel,
                  onPressed: _copy,
                  height: TclTokens.hSheetButton,
                  radius: TclTokens.rSheetButton,
                ),
                const SizedBox(height: _sectionGap),
                const _OnceWarning(),
                const SizedBox(height: _sectionGap),
                PrimaryButton(
                  label: 'รับทราบแล้ว',
                  onPressed: widget.onDismiss,
                  height: TclTokens.hSheetButton,
                  radius: TclTokens.rSheetButton,
                  // design ไม่มีเงาใต้ปุ่มใน sheet
                  shadow: const [],
                  fontSize: _actionFontSize,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// แถบจับด้านบน sheet 42×4
class _Grabber extends StatelessWidget {
  const _Grabber();

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: _grabberWidth,
      height: _grabberHeight,
      decoration: BoxDecoration(
        color: TclTokens.b26,
        borderRadius: BorderRadius.circular(TclTokens.rPill),
      ),
    ),
  );
}

/// บล็อกข้อมูลสมาชิกที่เพิ่งเพิ่ม — ชื่อ + รหัสพนักงาน
class _MemberBlock extends StatelessWidget {
  const _MemberBlock({required this.name, required this.empId});

  final String name;
  final String empId;

  @override
  Widget build(BuildContext context) => GlassCard(
    fill: TclTokens.s075,
    border: TclTokens.b13,
    radius: TclTokens.rCard,
    padding: const EdgeInsets.all(_sectionGap),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          name,
          style: TclTokens.itemName(),
          // กันชื่อยาวล้นการ์ด: ตัดที่ 2 บรรทัด (เหมือนแถวสมาชิก)
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: _rowGap),
        Row(
          children: [
            Text('รหัสพนักงาน', style: TclTokens.label()),
            const SizedBox(width: _valueGap),
            Expanded(
              child: Text(
                empId,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TclTokens.display(
                  size: _empIdFontSize,
                  color: TclTokens.accent,
                  letterSpacing: _empIdLetterSpacing,
                ),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}

/// บล็อก PIN เด่นชัด — พื้น t12 ขอบ t45 + ตัวเลข 6 หลัก 34/700 จัดกลาง
class _PinBlock extends StatelessWidget {
  const _PinBlock({required this.pin});

  final String pin;

  @override
  Widget build(BuildContext context) => GlassCard(
    fill: TclTokens.t12,
    border: TclTokens.t45,
    radius: TclTokens.rCard,
    padding: _pinBlockPadding,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'PIN เริ่มต้น',
          textAlign: TextAlign.center,
          style: TclTokens.label(TclTokens.tMuted),
        ),
        const SizedBox(height: _labelGap),
        // letterSpacing เติมช่องว่างท้ายตัวสุดท้าย → เผื่อ padding ซ้ายเท่ากัน
        // เพื่อให้กลุ่มตัวเลขอยู่กลางจริง
        Padding(
          padding: const EdgeInsets.only(left: _pinLetterSpacing),
          child: Semantics(
            label: 'PIN เริ่มต้น',
            value: pin.split('').join(' '),
            child: Text(
              pin,
              textAlign: TextAlign.center,
              maxLines: 1,
              style: TclTokens.display(
                size: _pinFontSize,
                weight: FontWeight.w700,
                color: TclTokens.accentHover,
                letterSpacing: _pinLetterSpacing,
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

/// คำเตือน "แสดงเพียงครั้งเดียว" — ไอคอนสามเหลี่ยม + ข้อความ meta สี WARN
class _OnceWarning extends StatelessWidget {
  const _OnceWarning();

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Padding(
        // ดันไอคอนลงให้ตรงกับบรรทัดแรกของข้อความ 11.5px
        padding: EdgeInsets.only(top: 1),
        child: StrokeIcon(
          painter: _WarningPainter(color: TclTokens.warn),
          size: _warnIconSize,
        ),
      ),
      const SizedBox(width: _warnIconGap),
      Expanded(
        child: Text(
          'PIN นี้แสดงเพียงครั้งเดียว ปิดหน้านี้แล้วจะดูย้อนหลังไม่ได้',
          style: TclTokens.meta(TclTokens.warn),
        ),
      ),
    ],
  );
}

/// ไอคอนเตือน (สามเหลี่ยม + เครื่องหมายตกใจ) — stroke 1.8 round, viewBox 24
class _WarningPainter extends CustomPainter {
  const _WarningPainter({required this.color});

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
    final triangle = Path()
      ..moveTo(12, 3.5)
      ..lineTo(21.5, 20)
      ..lineTo(2.5, 20)
      ..close();
    canvas.drawPath(triangle, p);
    canvas.drawLine(const Offset(12, 9.5), const Offset(12, 14), p);
    canvas.drawLine(const Offset(12, 17), const Offset(12, 17), p);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_WarningPainter old) => old.color != color;
}
