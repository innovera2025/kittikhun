import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';

/// ด้านของ avatar สมาชิก (44×44 ตาม design — ไม่ใช่ความสูง control ตัวใด)
const double _avatarSize = 44;

/// ระยะห่างระหว่างช่องในการ์ดสมาชิก (flex gap 13 ของ design)
const double _cardGap = 13;

/// ระยะห่างระหว่างการ์ดในลิสต์ (flex gap 10)
const double _listGap = 10;

/// สีของ role ตาม ROLES ใน design (pill + avatar)
typedef _RoleTone = ({Color pillBg, Color fg, Color border, Color avatarBg});

_RoleTone _toneOfRole(Role role) => switch (role) {
  Role.admin => (
    pillBg: TclTokens.t18,
    fg: TclTokens.accentHover,
    border: TclTokens.t45,
    avatarBg: TclTokens.t18,
  ),
  Role.staff => (
    pillBg: TclTokens.okTint16,
    fg: TclTokens.staffFg,
    border: TclTokens.okTint40,
    avatarBg: TclTokens.okTint16,
  ),
  // viewer: พื้น avatar (.11) เข้มกว่าพื้น pill (.10) เล็กน้อยตาม design
  Role.viewer => (
    pillBg: TclTokens.s10,
    fg: TclTokens.tMuted,
    border: TclTokens.b18,
    avatarBg: TclTokens.s11,
  ),
};

/// หน้าสมาชิกและสิทธิ์ (design §2.6)
///
/// ลิสต์สมาชิก (flex:1 scroll) + hint ท้ายลิสต์ → ปุ่ม "ออกจากระบบ"
///
/// ⚠️ ไม่มีปุ่ม "เพิ่มสมาชิก" แล้ว — รายชื่อมาจาก sync ผู้ใช้ ERP อย่างเดียว
/// สร้างคนใหม่ต้องทำที่ ERP (ปุ่มที่กดแล้วได้ 404 แย่กว่าไม่มีปุ่ม)
class TeamScreen extends ConsumerWidget {
  const TeamScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(appProvider.select((s) => s.members));
    final controller = ref.read(appProvider.notifier);

    return Column(
      children: [
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(
              TclTokens.gutterTab,
              0,
              TclTokens.gutterTab,
              8,
            ),
            // รายการสุดท้ายคือ hint ที่อยู่ในพื้นที่เลื่อนเดียวกันตาม design
            itemCount: members.length + 1,
            separatorBuilder: (_, _) => const SizedBox(height: _listGap),
            itemBuilder: (context, index) {
              if (index == members.length) return const _RoleHint();
              final member = members[index];
              return _MemberCard(
                key: ValueKey(member.empId),
                member: member,
                onCycleRole: () => controller.cycleRole(index),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            TclTokens.gutterTab,
            12,
            TclTokens.gutterTab,
            14,
          ),
          child: SizedBox(
            width: double.infinity,
            child: SecondaryButton(
              label: 'ออกจากระบบ',
              height: TclTokens.hTeamAction,
              radius: TclTokens.rTeamAction,
              onPressed: controller.signOut,
            ),
          ),
        ),
      ],
    );
  }
}

/// การ์ดสมาชิก 1 คน — avatar · ชื่อ/รหัส/กะ · pill สิทธิ์ (แตะเพื่อวน role)
class _MemberCard extends StatelessWidget {
  const _MemberCard({super.key, required this.member, required this.onCycleRole});

  final Member member;
  final VoidCallback onCycleRole;

  @override
  Widget build(BuildContext context) {
    final tone = _toneOfRole(member.role);

    return GradientCard(
      gradient: TclTokens.listCardBg,
      radius: TclTokens.rCard,
      border: TclTokens.b11,
      // design ไม่ใส่เงาให้การ์ดสมาชิก (ต่างจากการ์ดค้นหา/นับ)
      shadow: const [],
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
      child: Row(
        children: [
          Container(
            width: _avatarSize,
            height: _avatarSize,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: tone.avatarBg,
              borderRadius: BorderRadius.circular(TclTokens.rAvatar),
            ),
            child: Text(
              member.initials,
              style: TclTokens.display(
                size: 15,
                weight: FontWeight.w600,
                color: tone.fg,
              ),
            ),
          ),
          const SizedBox(width: _cardGap),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  member.name,
                  style: TclTokens.itemName(),
                  // กันชื่อยาวล้นการ์ด: ตัดที่ 2 บรรทัด
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  '${member.empId} · ${member.shift}',
                  style: TclTokens.meta(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: _cardGap),
          Semantics(
            button: true,
            label: 'สิทธิ์ ${member.role.label}',
            child: Pill(
              label: member.role.label,
              background: tone.pillBg,
              border: tone.border,
              style: TclTokens.rolePill(tone.fg),
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
              onTap: onCycleRole,
            ),
          ),
        ],
      ),
    );
  }
}

/// คำอธิบายท้ายลิสต์
class _RoleHint extends StatelessWidget {
  const _RoleHint();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 6, left: 4, right: 4),
    child: Text(
      'แตะที่สิทธิ์เพื่อสลับ admin / staff / viewer (เฉพาะผู้ดูแล)',
      style: TclTokens.meta().copyWith(height: 1.6),
    ),
  );
}
