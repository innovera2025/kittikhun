import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';

/// แท็บค้นหาสินค้า ตาม design §2.4
///
/// วางในสล็อตที่มีความสูงจำกัด (Expanded ของ app shell) — ลิสต์ใช้พื้นที่ที่เหลือ
///
/// ต่างจาก demo โดยเจตนา (ตาม docs/design-fidelity.md §2.4):
/// debounce การพิมพ์ + จำกัดผลที่แสดง + `ListView.builder` เพราะ catalog จริง
/// มีหลายร้อยถึงหลายพันรายการ
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

/// จำนวนผลลัพธ์สูงสุดที่ render
const int _resultLimit = 100;

/// หน่วงเวลาก่อนกรองจริง — กันกระตุกตอนพิมพ์เร็วบน catalog ใหญ่
const Duration _debounceDelay = Duration(milliseconds: 250);

/// ระยะระหว่างการ์ดผลลัพธ์ / ภายในการ์ด
const double _cardGap = 10;
const double _cardPadding = 15;
const double _cardInnerGap = 13;
const double _toneBarWidth = 8;
const double _toneBarHeight = 38;
const double _searchIconSize = 19;
const double _searchIconGap = 11;

/// ยอดคงเหลือคั่นหลักพันแบบ `toLocaleString` ใน design (1,240)
final NumberFormat _qtyFormat = NumberFormat.decimalPattern('en_US');

class _SearchScreenState extends ConsumerState<SearchScreen> {
  late final TextEditingController _controller;
  Timer? _debounce;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    // คงคำค้นเดิมไว้เมื่อสลับแท็บกลับมา
    _controller = TextEditingController(text: ref.read(appProvider).query);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(_debounceDelay, () {
      if (!mounted) return;
      ref.read(appProvider.notifier).setQuery(value);
    });
  }

  @override
  Widget build(BuildContext context) {
    // watch เฉพาะ query (ที่ debounce แล้ว) — toast/สแกนจากแท็บอื่นไม่ทำให้ลิสต์ rebuild
    ref.watch(appProvider.select((s) => s.query));
    final all = ref.read(appProvider.notifier).searchResults();
    final total = all.length;
    final limited = total > _resultLimit;
    final shown = limited ? all.take(_resultLimit).toList(growable: false) : all;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: TclTokens.gutterTab,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FieldBox(
                height: TclTokens.hSearchInput,
                radius: TclTokens.rSearchInput,
                focused: _focused,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    const StrokeIcon(
                      painter: _SearchIconPainter(),
                      size: _searchIconSize,
                      color: TclTokens.accent,
                    ),
                    const SizedBox(width: _searchIconGap),
                    Expanded(
                      // Focus ครอบเพื่ออ่านสถานะโฟกัสของ TextField ข้างใน
                      // (canRequestFocus:false ไม่กระทบ descendant)
                      child: Focus(
                        canRequestFocus: false,
                        onFocusChange: (has) {
                          if (has != _focused) setState(() => _focused = has);
                        },
                        child: TokenTextField(
                          controller: _controller,
                          onChanged: _onChanged,
                          hint: 'ชื่อสินค้า / SKU / บาร์โค้ด',
                          style: TclTokens.body15(),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(
                  top: 12,
                  left: 2,
                  right: 2,
                  bottom: 4,
                ),
                child: Text(
                  limited
                      ? 'แสดง ${shown.length} จาก $total รายการ'
                      : '$total รายการ',
                  style: TclTokens.label(TclTokens.tFaint),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: shown.isEmpty
              ? const _SearchEmptyState()
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(
                    TclTokens.gutterTab,
                    6,
                    TclTokens.gutterTab,
                    TclTokens.gutterTab,
                  ),
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  itemCount: shown.length,
                  separatorBuilder: (_, _) => const SizedBox(height: _cardGap),
                  itemBuilder: (context, i) {
                    final item = shown[i];
                    return _ResultCard(
                      item: item,
                      onTap: () => ref
                          .read(appProvider.notifier)
                          .openFromSearch(item.sku),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

/// การ์ดผลค้นหา — แถบ tone · SKU/ตำแหน่ง · ชื่อไทย · ชื่ออังกฤษ · ยอดคงเหลือ
class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.item, required this.onTap});

  final Item item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // onHand ว่าง = ไม่มีข้อมูลยอด → ไม่เดา tone (แสดงกลาง ๆ + '—')
    final hasQty = item.hasQty;
    final tone = hasQty
        ? TclTokens.toneOf(onHand: item.onHand!, rop: item.rop ?? 0)
        : null;
    final toneColor = tone == null
        ? TclTokens.tFaint
        : TclTokens.toneColor(tone);
    final loc = item.loc;

    return GradientCard(
      gradient: TclTokens.listCardBg,
      border: TclTokens.b11,
      radius: TclTokens.rCard,
      shadow: TclTokens.shSearchCard,
      child: Tappable(
        onTap: onTap,
        radius: TclTokens.rCard,
        child: Padding(
          padding: const EdgeInsets.all(_cardPadding),
          child: Row(
            children: [
              Container(
                width: _toneBarWidth,
                height: _toneBarHeight,
                decoration: BoxDecoration(
                  color: toneColor,
                  borderRadius: BorderRadius.circular(TclTokens.rPill),
                ),
              ),
              const SizedBox(width: _cardInnerGap),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      loc == null ? item.sku : '${item.sku} · $loc',
                      style: TclTokens.skuLine(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.name,
                      style: TclTokens.itemName(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    // ชื่ออังกฤษว่าง 100% ใน ERP จริง → ข้ามทั้งบรรทัด
                    if (item.nameEn != null)
                      Text(
                        item.nameEn!,
                        style: TclTokens.meta(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              const SizedBox(width: _cardInnerGap),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    hasQty ? _qtyFormat.format(item.onHand) : '—',
                    style: TclTokens.qtyLarge(toneColor),
                    maxLines: 1,
                  ),
                  Text(item.unit, style: TclTokens.tiny(), maxLines: 1),
                  // ที่มาของยอด: ยิงสดจาก ERP หรือยอดจากรอบ sync ล่าสุด
                  // แสดงเฉพาะเมื่อมียอด — ไม่มียอดแล้วบอกเวลาไม่มีความหมาย
                  if (hasQty)
                    Text(
                      item.onHandSourceLabel,
                      style: TclTokens.tiny(),
                      maxLines: 1,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// ไม่พบผลลัพธ์ — ข้อความ 2 บรรทัดจัดกลาง
class _SearchEmptyState extends StatelessWidget {
  const _SearchEmptyState();

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(
      TclTokens.gutterTab,
      6,
      TclTokens.gutterTab,
      TclTokens.gutterTab,
    ),
    keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
    children: [
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 44),
        child: Text(
          'ไม่พบสินค้าที่ตรงกับคำค้น\nNo matching items',
          textAlign: TextAlign.center,
          // design 13.5px ไม่มี step ในสเกล → เรียก helper thai() ของ token โดยตรง
          style: TclTokens.thai(
            size: 13.5,
            color: TclTokens.tFaint,
            height: 1.5,
          ),
        ),
      ),
    ],
  );
}

/// ไอคอนแว่นขยาย — path เดียวกับ SVG ใน design
/// `<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>` stroke 1.8 @ viewBox 24
class _SearchIconPainter extends CustomPainter {
  const _SearchIconPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 24;
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..color = TclTokens.accent
      ..strokeWidth = 1.8 * s
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(Offset(11 * s, 11 * s), 7 * s, p);
    canvas.drawLine(Offset(20 * s, 20 * s), Offset(15.7 * s, 15.7 * s), p);
  }

  @override
  bool shouldRepaint(_SearchIconPainter oldDelegate) => false;
}
