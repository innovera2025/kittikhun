import 'package:flutter/material.dart';

import '../theme/tcl_tokens.dart';

/// ปุ่ม CTA หลัก — พื้น gradient, ตัวอักษร #07121B, pressed = brightness(.94)
class PrimaryButton extends StatefulWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.height = TclTokens.hSignIn,
    this.radius = TclTokens.rButtonLarge,
    this.shadow = TclTokens.shSignInBtn,
    this.trailingIcon,
    this.fontSize = 16,
  });

  final String label;
  final VoidCallback? onPressed;
  final double height;
  final double radius;
  final List<BoxShadow> shadow;
  final Widget? trailingIcon;
  final double fontSize;

  @override
  State<PrimaryButton> createState() => _PrimaryButtonState();
}

class _PrimaryButtonState extends State<PrimaryButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null;
    return Semantics(
      button: true,
      label: widget.label,
      child: GestureDetector(
        onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
        onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
        onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
        onTap: widget.onPressed,
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: AnimatedContainer(
            duration: TclTokens.dKeypad,
            height: widget.height,
            decoration: BoxDecoration(
              gradient: TclTokens.primaryGradient,
              borderRadius: BorderRadius.circular(widget.radius),
              boxShadow: widget.shadow,
            ),
            foregroundDecoration: _pressed
                ? BoxDecoration(
                    color: const Color(0x14000000),
                    borderRadius: BorderRadius.circular(widget.radius),
                  )
                : null,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  widget.label,
                  style: TclTokens.ctaPrimary()
                      .copyWith(fontSize: widget.fontSize),
                ),
                if (widget.trailingIcon != null) ...[
                  const SizedBox(width: 9),
                  widget.trailingIcon!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// ปุ่มรอง — พื้น s07, ขอบ b18
class SecondaryButton extends StatelessWidget {
  const SecondaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.height = TclTokens.hCardAction,
    this.radius = TclTokens.rCardAction,
    this.minWidth,
  });

  final String label;
  final VoidCallback? onPressed;
  final double height;
  final double radius;
  final double? minWidth;

  @override
  Widget build(BuildContext context) {
    return _Tappable(
      onTap: onPressed,
      radius: radius,
      child: Container(
        height: height,
        constraints: minWidth == null ? null : BoxConstraints(minWidth: minWidth!),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: TclTokens.s07,
          border: Border.all(color: TclTokens.b18),
          borderRadius: BorderRadius.circular(radius),
        ),
        child: Text(label, style: TclTokens.ctaSecondary()),
      ),
    );
  }
}

/// การ์ดแก้ว — พื้นขาวโปร่ง + ขอบบาง (ใช้ที่ login card / session card / stat tile)
class GlassCard extends StatelessWidget {
  const GlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.radius = TclTokens.rLoginCard,
    this.fill = TclTokens.s075,
    this.border = TclTokens.b13,
    this.shadow,
  });

  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final Color fill;
  final Color border;
  final List<BoxShadow>? shadow;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          color: fill,
          border: Border.all(color: border),
          borderRadius: BorderRadius.circular(radius),
          boxShadow: shadow,
        ),
        child: child,
      );
}

/// การ์ดในลิสต์ — พื้น gradient (scan / search / count / member)
class GradientCard extends StatelessWidget {
  const GradientCard({
    super.key,
    required this.child,
    this.gradient = TclTokens.listCardBg,
    this.border = TclTokens.b11,
    this.radius = TclTokens.rCard,
    this.shadow = TclTokens.shSearchCard,
    this.padding,
  });

  final Widget child;
  final LinearGradient gradient;
  final Color border;
  final double radius;
  final List<BoxShadow> shadow;
  final EdgeInsets? padding;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          gradient: gradient,
          border: Border.all(color: border),
          borderRadius: BorderRadius.circular(radius),
          boxShadow: shadow,
        ),
        child: child,
      );
}

/// ป้าย pill — ใช้ที่ variance / role / chip
class Pill extends StatelessWidget {
  const Pill({
    super.key,
    required this.label,
    required this.background,
    required this.style,
    this.border,
    this.padding = const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
    this.onTap,
  });

  final String label;
  final Color background;
  final TextStyle style;
  final Color? border;
  final EdgeInsets padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pill = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: background,
        border: border == null ? null : Border.all(color: border!),
        borderRadius: BorderRadius.circular(TclTokens.rPill),
      ),
      child: Text(label, style: style),
    );
    if (onTap == null) return pill;
    return _Tappable(onTap: onTap, radius: TclTokens.rPill, child: pill);
  }
}

/// แถบ progress แนวนอน — แทร็ก s11 + fill gradient/สี
class ProgressBar extends StatelessWidget {
  const ProgressBar({
    super.key,
    required this.fraction,
    this.gradient,
    this.color,
    this.height = 8,
  });

  final double fraction;
  final LinearGradient? gradient;
  final Color? color;
  final double height;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(TclTokens.rPill),
        child: Container(
          height: height,
          color: TclTokens.s11,
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: fraction.clamp(0.0, 1.0),
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: gradient,
                color: gradient == null ? color : null,
                borderRadius: BorderRadius.circular(TclTokens.rPill),
              ),
            ),
          ),
        ),
      );
}

/// ช่องกรอกข้อความตามสไตล์ design
class TokenTextField extends StatelessWidget {
  const TokenTextField({
    super.key,
    required this.controller,
    required this.onChanged,
    this.hint,
    this.style,
    this.keyboardType,
    this.textAlign = TextAlign.start,
    this.obscure = false,
    this.maxLength,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final String? hint;
  final TextStyle? style;
  final TextInputType? keyboardType;
  final TextAlign textAlign;
  final bool obscure;
  final int? maxLength;

  @override
  Widget build(BuildContext context) => TextField(
        controller: controller,
        onChanged: onChanged,
        keyboardType: keyboardType,
        textAlign: textAlign,
        obscureText: obscure,
        maxLength: maxLength,
        cursorColor: TclTokens.accent,
        style: style ?? TclTokens.body15(),
        decoration: InputDecoration(
          isDense: true,
          border: InputBorder.none,
          counterText: '',
          contentPadding: EdgeInsets.zero,
          hintText: hint,
          hintStyle: (style ?? TclTokens.body15())
              .copyWith(color: TclTokens.tFaint),
        ),
      );
}

/// กล่องรอบช่องกรอก — พื้น s085 + ขอบ b15 → โฟกัสเปลี่ยนขอบเป็น accent
class FieldBox extends StatelessWidget {
  const FieldBox({
    super.key,
    required this.child,
    this.height = TclTokens.hInput,
    this.radius = TclTokens.rInput,
    this.focused = false,
    this.fill = TclTokens.s085,
    this.padding = const EdgeInsets.symmetric(horizontal: 14),
  });

  final Widget child;
  final double height;
  final double radius;
  final bool focused;
  final Color fill;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => AnimatedContainer(
        duration: TclTokens.dKeypad,
        height: height,
        padding: padding,
        decoration: BoxDecoration(
          color: fill,
          border: Border.all(
            color: focused ? TclTokens.accent : TclTokens.b15,
          ),
          borderRadius: BorderRadius.circular(radius),
        ),
        child: child,
      );
}

/// ปุ่ม − / + ของ stepper — 44×44
class StepperButton extends StatelessWidget {
  const StepperButton({super.key, required this.glyph, required this.onTap});

  final String glyph;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: glyph == '+' ? 'เพิ่มจำนวน' : 'ลดจำนวน',
      child: Tappable(
        onTap: onTap,
        radius: TclTokens.rStepper,
        child: Container(
          width: TclTokens.hStepper,
          height: TclTokens.hStepper,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: TclTokens.s07,
            border: Border.all(color: TclTokens.b16),
            borderRadius: BorderRadius.circular(TclTokens.rStepper),
          ),
          child: Text(
            glyph,
            style: TclTokens.thai(
              size: 20,
              color: TclTokens.tBody,
              height: 1,
            ),
          ),
        ),
      ),
    );
  }
}

/// ช่องกรอกจำนวนที่นับได้ — กว้าง 88 · โฟกัสแล้วขอบเป็น accent
class CountField extends StatelessWidget {
  const CountField({
    super.key,
    required this.controller,
    required this.focused,
    required this.onFocusChange,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool focused;
  final ValueChanged<bool> onFocusChange;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 88,
      child: Focus(
        onFocusChange: onFocusChange,
        child: AnimatedContainer(
          duration: TclTokens.dKeypad,
          height: TclTokens.hStepper,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: TclTokens.s10,
            border: Border.all(
              color: focused ? TclTokens.accent : TclTokens.b16,
            ),
            borderRadius: BorderRadius.circular(TclTokens.rCountInput),
          ),
          child: TokenTextField(
            controller: controller,
            onChanged: onChanged,
            hint: 'นับได้',
            textAlign: TextAlign.center,
            keyboardType: TextInputType.number,
            style: TclTokens.statValue(TclTokens.tBrightest),
          ),
        ),
      ),
    );
  }
}

/// ไอคอนกล่องแบรนด์ (แถบบาร์โค้ด 5 เส้นบนพื้น gradient)
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, required this.size, required this.radius});

  final double size;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          gradient: TclTokens.logoGradient,
          borderRadius: BorderRadius.circular(radius),
          boxShadow: size >= 50 ? TclTokens.shLogoTile : null,
        ),
        child: CustomPaint(
          painter: _BarcodeMarkPainter(strokeWidth: size >= 50 ? 2 : 2.2),
        ),
      );
}

class _BarcodeMarkPainter extends CustomPainter {
  const _BarcodeMarkPainter({required this.strokeWidth});
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = TclTokens.logoIconStroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    // เส้นแนวตั้ง 5 เส้นที่ x = 4, 8, 11.5, 15.5, 20 ของ viewBox 24 (y 6→18)
    const xs = [4.0, 8.0, 11.5, 15.5, 20.0];
    final sx = size.width / 24, sy = size.height / 24;
    for (final x in xs) {
      canvas.drawLine(Offset(x * sx, 6 * sy), Offset(x * sx, 18 * sy), p);
    }
  }

  @override
  bool shouldRepaint(_BarcodeMarkPainter old) => old.strokeWidth != strokeWidth;
}

/// พื้นที่แตะที่มี ripple สีกลืนกับธีม (pressed state ตาม design)
class _Tappable extends StatelessWidget {
  const _Tappable({required this.child, required this.onTap, required this.radius});

  final Widget child;
  final VoidCallback? onTap;
  final double radius;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(radius),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(radius),
          highlightColor: TclTokens.t16,
          splashColor: TclTokens.t12,
          child: child,
        ),
      );
}

/// ให้ไฟล์อื่นใช้ _Tappable ได้ผ่านชื่อ public
class Tappable extends StatelessWidget {
  const Tappable({
    super.key,
    required this.child,
    required this.onTap,
    this.radius = TclTokens.rCard,
  });

  final Widget child;
  final VoidCallback? onTap;
  final double radius;

  @override
  Widget build(BuildContext context) =>
      _Tappable(onTap: onTap, radius: radius, child: child);
}

/// ไอคอน stroke บาง (แทน Lucide) — วาดจาก path เดียวกับ design
class StrokeIcon extends StatelessWidget {
  const StrokeIcon({
    super.key,
    required this.painter,
    required this.size,
    this.color = TclTokens.tBody,
  });

  final CustomPainter painter;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) =>
      SizedBox(width: size, height: size, child: CustomPaint(painter: painter));
}
