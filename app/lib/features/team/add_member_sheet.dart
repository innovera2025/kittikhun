import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';

// ── ระยะภายใน sheet (ใช้ที่ไฟล์นี้ที่เดียว — ค่าจาก design §2.7) ─────────
const double _sheetPadding = 22;
const double _sectionGap = 16;
const double _labelGap = 7;
const double _titleGap = 2;
const double _actionTopGap = 4;
const double _actionGap = 10;
const double _roleGap = 8;
const double _cancelMinWidth = 106;
const double _grabberWidth = 42;
const double _grabberHeight = 4;

/// rise: translateY 26 → 0 + fade (`@keyframes rise` ใน design)
const double _riseOffset = 26;

/// พื้นความสูงขั้นต่ำ — กันกรณีคำนวณพื้นที่ที่เหลือได้ค่าติดลบ
const double _minSheetHeight = 160;

/// ช่องรหัสพนักงาน: Space Grotesk 16px ls .12em
const double _idFontSize = 16;
const double _idLetterSpacing = 1.92;

/// ปุ่มสิทธิ์: Space Grotesk 12px/600 ls .08em
const double _roleFontSize = 12;
const double _roleLetterSpacing = 0.96;

/// ปุ่มล่าง 15px ตาม design (ไม่ใช่ 16px ของ CTA หลักปกติ)
const double _actionFontSize = 15;

/// Bottom sheet "เพิ่มสมาชิกใหม่" ตาม design §2.7
///
/// ⚠️ เป็น widget ธรรมดาที่ AppShell วางใน `Stack` เดียวกับ toast
/// (ห้ามใช้ `showModalBottomSheet` — toast validation จะจมใต้ barrier)
/// scrim และตำแหน่งชิดขอบล่างเป็นหน้าที่ของ AppShell
class AddMemberSheet extends ConsumerStatefulWidget {
  const AddMemberSheet({super.key});

  @override
  ConsumerState<AddMemberSheet> createState() => _AddMemberSheetState();
}

class _AddMemberSheetState extends ConsumerState<AddMemberSheet>
    with SingleTickerProviderStateMixin {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _idCtrl;
  late final AnimationController _riseCtrl;
  late final Animation<double> _rise;
  bool _nameFocused = false;
  bool _idFocused = false;

  @override
  void initState() {
    super.initState();
    final s = ref.read(appProvider);
    _nameCtrl = TextEditingController(text: s.newName);
    _idCtrl = TextEditingController(text: s.newId);
    _riseCtrl = AnimationController(
      duration: TclTokens.dRiseSheet,
      vsync: this,
    );
    _rise = CurvedAnimation(parent: _riseCtrl, curve: TclTokens.cRise);
    _riseCtrl.forward();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _idCtrl.dispose();
    _riseCtrl.dispose();
    super.dispose();
  }

  /// ให้ช่องรหัสตรงกับ state เสมอ (state ตัดอักขระที่ไม่ใช่ตัวเลข / จำกัด 6 หลัก)
  void _syncIdField(String value) {
    if (_idCtrl.text == value) return;
    _idCtrl.value = TextEditingValue(
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

    // เพดานความสูงคิดจากจอ — parent constraint ที่แคบกว่าจะชนะเองใน ConstrainedBox
    final maxHeight = math.max(
      _minSheetHeight,
      MediaQuery.sizeOf(context).height -
          keyboardInset -
          MediaQuery.paddingOf(context).vertical,
    );

    ref.listen<String>(
      appProvider.select((s) => s.newId),
      (_, next) => _syncIdField(next),
    );

    return Padding(
      // หลบคีย์บอร์ด (เป็น 0 ถ้ามี Scaffold ชั้นนอกจัดการให้แล้ว)
      padding: EdgeInsets.only(bottom: keyboardInset),
      child: AnimatedBuilder(
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
              keyboardDismissBehavior:
                  ScrollViewKeyboardDismissBehavior.onDrag,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const _Grabber(),
                  const SizedBox(height: _sectionGap),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'เพิ่มสมาชิกใหม่',
                        style: TclTokens.sheetTitle(),
                      ),
                      const SizedBox(height: _titleGap),
                      Text(
                        'กำหนดชื่อ รหัสพนักงาน และสิทธิ์การใช้งาน',
                        style: TclTokens.caption(),
                      ),
                    ],
                  ),
                  const SizedBox(height: _sectionGap),
                  _FieldGroup(
                    label: 'ชื่อ-สกุล',
                    child: FieldBox(
                      height: TclTokens.hSheetInput,
                      radius: TclTokens.rInput,
                      focused: _nameFocused,
                      child: Focus(
                        // canRequestFocus:false เพื่ออ่านสถานะโฟกัสของ TextField
                        // ข้างในโดยไม่แย่งโฟกัสเอง
                        canRequestFocus: false,
                        onFocusChange: (has) {
                          if (has != _nameFocused) {
                            setState(() => _nameFocused = has);
                          }
                        },
                        child: TokenTextField(
                          controller: _nameCtrl,
                          onChanged: c.setNewName,
                          hint: 'ชื่อพนักงาน',
                          style: TclTokens.body15(),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: _sectionGap),
                  _FieldGroup(
                    label: 'รหัสพนักงาน',
                    child: FieldBox(
                      height: TclTokens.hSheetInput,
                      radius: TclTokens.rInput,
                      focused: _idFocused,
                      child: Focus(
                        canRequestFocus: false,
                        onFocusChange: (has) {
                          if (has != _idFocused) {
                            setState(() => _idFocused = has);
                          }
                        },
                        child: TokenTextField(
                          controller: _idCtrl,
                          onChanged: c.setNewId,
                          hint: '52xxx',
                          keyboardType: TextInputType.number,
                          style: TclTokens.display(
                            size: _idFontSize,
                            color: TclTokens.tBrightest,
                            letterSpacing: _idLetterSpacing,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: _sectionGap),
                  _FieldGroup(
                    label: 'สิทธิ์',
                    child: Row(
                      children: [
                        for (var i = 0; i < Role.values.length; i++) ...[
                          if (i > 0) const SizedBox(width: _roleGap),
                          Expanded(
                            child: _RoleOption(
                              role: Role.values[i],
                              selected: s.newRole == Role.values[i],
                              onTap: () => c.setNewRole(Role.values[i]),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: _sectionGap + _actionTopGap),
                  Row(
                    children: [
                      SecondaryButton(
                        label: 'ยกเลิก',
                        onPressed: c.closeAddSheet,
                        height: TclTokens.hSheetButton,
                        radius: TclTokens.rSheetButton,
                        minWidth: _cancelMinWidth,
                      ),
                      const SizedBox(width: _actionGap),
                      Expanded(
                        child: PrimaryButton(
                          label: 'บันทึก',
                          onPressed: c.addMember,
                          height: TclTokens.hSheetButton,
                          radius: TclTokens.rSheetButton,
                          // design ไม่มีเงาใต้ปุ่มใน sheet
                          shadow: const [],
                          fontSize: _actionFontSize,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
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

/// label 12/500 + ระยะ 7 + ตัวควบคุม
class _FieldGroup extends StatelessWidget {
  const _FieldGroup({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(label, style: TclTokens.label()),
      const SizedBox(height: _labelGap),
      child,
    ],
  );
}

/// ปุ่มเลือกสิทธิ์ 1 ช่องในกริด 3 คอลัมน์
class _RoleOption extends StatelessWidget {
  const _RoleOption({
    required this.role,
    required this.selected,
    required this.onTap,
  });

  final Role role;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = _rolePalette(role, selected: selected);
    return Semantics(
      button: true,
      selected: selected,
      label: role.label,
      child: Tappable(
        onTap: onTap,
        radius: TclTokens.rRolePicker,
        child: Container(
          height: TclTokens.hRoleOption,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: palette.bg,
            border: Border.all(color: palette.border),
            borderRadius: BorderRadius.circular(TclTokens.rRolePicker),
          ),
          child: Text(
            role.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TclTokens.display(
              size: _roleFontSize,
              weight: FontWeight.w600,
              color: palette.fg,
              letterSpacing: _roleLetterSpacing,
            ),
          ),
        ),
      ),
    );
  }
}

/// สี พื้น/ตัวอักษร/ขอบ ของปุ่มสิทธิ์ — ตรงกับ ROLES ใน design
({Color bg, Color fg, Color border}) _rolePalette(
  Role role, {
  required bool selected,
}) {
  if (!selected) {
    return (
      bg: TclTokens.s07,
      fg: TclTokens.tMuted,
      border: TclTokens.b16,
    );
  }
  return switch (role) {
    Role.admin => (
      bg: TclTokens.t18,
      fg: TclTokens.accentHover,
      border: TclTokens.t45,
    ),
    Role.staff => (
      bg: TclTokens.okTint16,
      fg: TclTokens.staffFg,
      border: TclTokens.okTint40,
    ),
    Role.viewer => (
      bg: TclTokens.s10,
      fg: TclTokens.tMuted,
      border: TclTokens.b18,
    ),
  };
}
