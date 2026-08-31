import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/theme/tcl_tokens.dart';
import '../../core/widgets/common.dart';
import '../../data/fixtures.dart';
import '../../data/models.dart';
import '../../state/app_state.dart';
import '../count/submit_drafts.dart';
import 'handheld_scan_buffer.dart';

// ════════════════════════════════════════════════════════════════════
// ค่าเรขาคณิตที่ถอดตรงจาก design (§2.3) — ไม่ใช่ token สี/รัศมี/เงา/ฟอนต์
// ════════════════════════════════════════════════════════════════════

/// กรอบมุมสแกน: left/right 14% · top/bottom 26% ของกรอบกล้อง
/// (พื้นที่เดียวกันนี้ถูกส่งเป็น `scanWindow` ROI ของ mobile_scanner)
const double _roiInsetX = 0.14;
const double _roiInsetY = 0.26;
const double _bracketArm = 30;
const double _bracketStroke = 3;

/// เส้นเลเซอร์: left/right 16% · สูง 2px · กวาดขึ้นลง 26% → 74%
const double _laserInsetX = 0.16;
const double _laserHeight = 2;
const double _sweepFrom = 0.26;
const double _sweepTo = 0.74;

/// radial glow: `circle at 50% 46%` จบที่ transparent 62%
const double _glowCenterY = 0.46;
const double _glowEdge = 0.62;

/// ป้ายสถานะกล้อง: มุมบนซ้าย 16px · padding 7/13 · จุด 7px · กว้างสุด 74%
const double _camPillInset = 16;
const double _camPillPadX = 13;
const double _camPillPadY = 7;
const double _camPillGap = 8;
const double _statusDotSize = 7;
const double _statusPillMaxWidth = 0.74;
const double _pulseMinOpacity = 0.35;
const double _pulseMinScale = 0.9;

/// คอลัมน์ FAB: มุมล่างขวา 14px · gap 10 · ไอคอน 20px
const double _fabInset = 14;
const double _fabGap = 10;
const double _fabIconSize = 20;

/// `@keyframes rise` — translateY(26px) → 0
const double _riseFrom = 26;

/// แถบเครื่องมือใต้กล้อง: padding 14/18/6 · gap 10 (นอก) / 7 (ในกลุ่มปุ่ม)
const double _toolbarTop = 14;
const double _toolbarBottom = 6;
const double _toolbarGap = 10;
const double _toolButtonGap = 7;
const double _toolButtonPadX = 12;
const double _toolIconSize = 17;

/// การ์ดผลสแกน
const double _cardGap = 9;
const double _cardPadX = 16;
const double _cardPadY = 14;
const double _cardHeaderGap = 13;
const double _toneBarWidth = 8;
const double _toneBarHeight = 40;
const double _titleGap = 2;
const double _blockGap = 14;
const double _actionGap = 16;
const double _footerGap = 10;
const double _statTileGap = 9;
const double _statTilePad = 11;
const double _specRowPadY = 9;
const double _specRowGap = 14;
const int _specKeyFlex = 3;
const int _specValueFlex = 2;
const double _removeMinWidth = 96;

/// ระยะระหว่าง `−` / ช่องกรอก / `+` / หน่วย — ค่าเดียวกับแถว stepper ของจอนับ
const double _stepperGap = 10;

/// dialog กรอกรหัสมือ — ใช้มิติเดียวกับ bottom sheet ของ design (§2.7)
const double _dialogPad = 22;
const double _dialogCancelMinWidth = 106;
const double _emptyTextMaxWidth = 290;
const double _emptyPadX = 2;
const double _emptyPadY = 4;
const double _emptyLineGap = 5;
const double _emptyLineHeight = 1.55;

/// ค่าที่ ERP ไม่มี (onHand / reserved / rop / spec) — ดู docs/erp-tcl-findings.md §4
const String _noValue = '—';

// ════════════════════════════════════════════════════════════════════
// แท็บสแกน (design §2.3) — กรอบกล้อง + แถบเครื่องมือ + รายการผลสแกน
// ════════════════════════════════════════════════════════════════════

/// หน้าสแกนบาร์โค้ด
///
/// วางไว้ใน `Expanded` ของ app shell (ต้องได้ความสูงแบบ bounded)
class ScanScreen extends ConsumerStatefulWidget {
  const ScanScreen({super.key});

  @override
  ConsumerState<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends ConsumerState<ScanScreen>
    with WidgetsBindingObserver {
  /// ⚠️ ห้ามใช้ `DetectionSpeed.noDuplicates` — สแกนซ้ำต้องเด้งขึ้นบนได้
  /// (`detectionTimeoutMs` ทำหน้าที่ cooldown ต่อรหัสแทน ~1.5 วิ)
  final MobileScannerController _scanner = MobileScannerController(
    autoStart: false,
    detectionSpeed: DetectionSpeed.normal,
    detectionTimeoutMs: 1500,
    formats: const [
      BarcodeFormat.ean13,
      BarcodeFormat.ean8,
      BarcodeFormat.code128,
      BarcodeFormat.code39,
      BarcodeFormat.qrCode,
    ],
  );

  /// กัน start/stop ซ้อนกัน (permission dialog ทำให้ lifecycle สลับเร็ว)
  bool _busy = false;

  /// เครื่องยิงบาร์โค้ด (handheld) — ทำตัวเป็นคีย์บอร์ด ยิงแล้วพิมพ์รหัส + Enter
  ///
  /// รับที่ระดับจอ ไม่ใช่ผ่านช่องกรอก เพราะช่องกรอกจะเรียกคีย์บอร์ดจอขึ้นมาบัง
  /// และผู้ใช้ต้องแตะจอทุกครั้ง — ผิดวัตถุประสงค์ของการยิงรัวทีละชิ้น
  final FocusNode _handheldFocus = FocusNode(debugLabel: 'handheld-scan');
  final HandheldScanBuffer _handheld = HandheldScanBuffer();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // กลับเข้าแท็บสแกนแล้ว camOn ยังเป็น true → ต้องเปิดกล้องต่อเอง
    // (รอ post-frame ให้ MobileScanner attach controller ก่อน)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (ref.read(appProvider).camOn) unawaited(_startCamera());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _handheldFocus.dispose();
    unawaited(_shutdown(_scanner));
    super.dispose();
  }

  static Future<void> _shutdown(MobileScannerController scanner) async {
    try {
      await scanner.stop();
    } on Object catch (e) {
      debugPrint('TCL: ปิดกล้องไม่สำเร็จ — $e');
    }
    await scanner.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      unawaited(_stopCamera());
    } else if (state == AppLifecycleState.resumed) {
      if (ref.read(appProvider).camOn) unawaited(_startCamera());
    }
  }

  Future<void> _startCamera() async {
    if (_busy) return;
    _busy = true;
    try {
      await _scanner.start();
    } on MobileScannerException catch (e) {
      if (!mounted) return;
      _reportCameraFailure(e.errorCode);
    } on Object catch (e) {
      debugPrint('TCL: เปิดกล้องไม่สำเร็จ — $e');
      if (!mounted) return;
      _reportCameraFailure(MobileScannerErrorCode.genericError);
    } finally {
      _busy = false;
    }
  }

  Future<void> _stopCamera() async {
    if (_busy) return;
    _busy = true;
    try {
      await _scanner.stop();
    } on Object catch (e) {
      debugPrint('TCL: ปิดกล้องไม่สำเร็จ — $e');
    } finally {
      _busy = false;
    }
  }

  void _reportCameraFailure(MobileScannerErrorCode code) {
    // กำลังเริ่มอยู่แล้ว / เริ่มไปแล้ว = ไม่ใช่ความผิดพลาด
    if (code == MobileScannerErrorCode.controllerAlreadyInitialized ||
        code == MobileScannerErrorCode.controllerInitializing) {
      return;
    }
    final c = ref.read(appProvider.notifier);
    c.setCamOn(false); // ลำดับสำคัญ: setCamOn เขียน camStatus ทับ
    if (code == MobileScannerErrorCode.permissionDenied) {
      c.setCamStatus(CamStatus.permissionDenied);
      c.flash('ไม่ได้รับอนุญาตใช้กล้อง · camera blocked');
    } else {
      c.setCamStatus(CamStatus.detectorUnavailable);
    }
  }

  /// ทุก decode ต้องสั่น **ก่อน** ตรวจว่าเจอสินค้าไหม (design: `buzz()` มาก่อน)
  void _resolve(String code) {
    HapticFeedback.mediumImpact();
    // ใช้เวอร์ชัน async — ค้นจาก replica ในเครื่อง (ทำงานได้แม้ออฟไลน์)
    ref.read(appProvider.notifier).resolveCodeAsync(code);
  }

  void _onDetect(BarcodeCapture capture) {
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw != null && raw.isNotEmpty) {
        _resolve(raw);
        return;
      }
    }
  }

  Future<void> _openManualEntry() async {
    final code = await showDialog<String>(
      context: context,
      barrierColor: TclTokens.scrim,
      builder: (_) => const _ManualCodeDialog(),
    );
    if (!mounted || code == null) return;
    _resolve(code);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(appProvider);

    // camOn เปลี่ยนจากที่อื่น (ปุ่ม FAB / permission) → ขับกล้องตามสถานะ
    ref.listen<bool>(appProvider.select((s) => s.camOn), (_, on) {
      unawaited(on ? _startCamera() : _stopCamera());
    });

    // min-height 190 ชนะ flex-basis 186 เหมือน CSS → กรอบที่หดจริงสูง 190
    final camera = ConstrainedBox(
      constraints: const BoxConstraints(
        minHeight: TclTokens.cameraMinHeight,
      ),
      child: state.hasScans
          ? SizedBox(
              height: TclTokens.cameraCollapsed,
              child: _cameraFrame(state),
            )
          : _cameraFrame(state),
    );

    // เครื่องยิงบาร์โค้ดส่งคีย์เข้ามาที่จอตรง ๆ (ไม่ผ่านช่องกรอก) จึงห่อทั้งจอไว้
    // `skipTraversal` กันไม่ให้โหนดนี้ไปแทรกลำดับ Tab ของช่องกรอกจำนวน
    // และคืน `ignored` ทุกครั้งที่ยังไม่จบรหัส เพื่อให้คีย์ไหลต่อไปหาช่องกรอกได้ตามปกติ
    return Focus(
      focusNode: _handheldFocus,
      autofocus: true,
      skipTraversal: true,
      onKeyEvent: _onHandheldKey,
      child: Column(
        children: [
          if (state.hasScans) camera else Expanded(child: camera),
          _toolbar(state),
          Expanded(child: _resultList(state)),
          // ปุ่มส่งเอกสาร — ซ่อนตัวเองเมื่อยังไม่มีบรรทัดที่คีย์ (ลิสต์ได้ความสูงเต็ม)
          const SubmitDraftsBar(),
        ],
      ),
    );
  }

  /// คีย์จากเครื่องยิงบาร์โค้ด — จบรหัสเมื่อเจอ Enter แล้วส่งเข้าเส้นทางเดียวกับกล้อง
  ///
  /// ใช้ `_resolve` ตัวเดียวกับ `_onDetect` โดยตั้งใจ: สั่นก่อน แล้วค้นจาก replica
  /// ในเครื่อง — ยิงจาก handheld กับสแกนด้วยกล้องจึงให้ผลเหมือนกันทุกอย่าง
  KeyEventResult _onHandheldKey(FocusNode node, KeyEvent event) {
    final code = _handheld.feed(event, now: DateTime.now());
    if (code == null) return KeyEventResult.ignored;
    _resolve(code);
    return KeyEventResult.handled;
  }

  // ── A. กรอบกล้อง ─────────────────────────────────────────────────

  Widget _cameraFrame(AppState state) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: TclTokens.gutterTab),
    child: Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: TclTokens.cameraViewportBg,
        border: Border.all(color: TclTokens.b13),
        borderRadius: BorderRadius.circular(TclTokens.rCamera),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final w = constraints.maxWidth;
          final h = constraints.maxHeight;
          final roi = Rect.fromLTRB(
            w * _roiInsetX,
            h * _roiInsetY,
            w * (1 - _roiInsetX),
            h * (1 - _roiInsetY),
          );
          final controller = ref.read(appProvider.notifier);

          return Stack(
            fit: StackFit.expand,
            children: [
              // preview: ปิดอยู่ = โปร่งใส เห็นพื้น cameraViewportBg เปล่า
              Opacity(
                opacity: state.camOn ? 1 : 0,
                child: MobileScanner(
                  controller: _scanner,
                  onDetect: _onDetect,
                  scanWindow: roi,
                  placeholderBuilder: (_) => const SizedBox.shrink(),
                  errorBuilder: (_, _) => const SizedBox.shrink(),
                ),
              ),

              // radial glow ฟ้ากลางกรอบ
              IgnorePointer(
                child: DecoratedBox(decoration: _glowDecoration(w, h)),
              ),

              // เส้นเลเซอร์กวาดขึ้นลงระหว่างกรอบมุม
              _SweepLine(frameWidth: w, frameHeight: h),

              // กรอบมุม 4 ชิ้น (ขอบเขตเดียวกับ scanWindow)
              Positioned.fromRect(
                rect: roi,
                child: const IgnorePointer(
                  child: CustomPaint(painter: _CornerBracketsPainter()),
                ),
              ),

              // ป้ายสถานะกล้อง
              Positioned(
                left: _camPillInset,
                top: _camPillInset,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: w * _statusPillMaxWidth,
                  ),
                  child: GlassCard(
                    padding: const EdgeInsets.symmetric(
                      horizontal: _camPillPadX,
                      vertical: _camPillPadY,
                    ),
                    radius: TclTokens.rPill,
                    fill: TclTokens.camPillBg,
                    border: TclTokens.b16,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const _PulseDot(),
                        const SizedBox(width: _camPillGap),
                        Flexible(
                          child: Text(
                            state.camStatusText,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TclTokens.meta(
                              TclTokens.tSoftAlt,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),

              // คอลัมน์ FAB
              Positioned(
                right: _fabInset,
                bottom: _fabInset,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _GlowRing(
                      active: !state.camOn,
                      child: _CamFab(
                        semanticLabel: 'กล้อง',
                        painter: const _CameraIconPainter(),
                        onTap: () => controller.setCamOn(!state.camOn),
                      ),
                    ),
                    const SizedBox(height: _fabGap),
                    _CamFab(
                      semanticLabel: 'ค้นหา',
                      painter: const _SearchIconPainter(),
                      onTap: () => controller.goTab(AppTab.search),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    ),
  );

  /// `radial-gradient(circle at 50% 46%, rgba(132,186,243,.2), transparent 62%)`
  ///
  /// CSS `circle` ปริยาย = farthest-corner → คำนวณรัศมีจริงเป็นพิกเซล
  /// แล้วแปลงเป็นสัดส่วนของ "ด้านสั้น" ตามนิยาม `RadialGradient.radius`
  BoxDecoration _glowDecoration(double w, double h) {
    final shortest = math.min(w, h);
    final dy = math.max(h * _glowCenterY, h * (1 - _glowCenterY));
    final farthest = math.sqrt(w / 2 * (w / 2) + dy * dy);
    return BoxDecoration(
      gradient: RadialGradient(
        center: Alignment(0, _glowCenterY * 2 - 1),
        radius: shortest <= 0 ? 0 : _glowEdge * farthest / shortest,
        colors: [
          TclTokens.radialGlow,
          // ไล่เป็น alpha 0 ของสีเดิม (ไม่ใช่ดำโปร่ง) กัน halo เทา
          TclTokens.radialGlow.withValues(alpha: 0),
        ],
      ),
    );
  }

  // ── B. แถบเครื่องมือ ──────────────────────────────────────────────

  Widget _toolbar(AppState state) {
    final controller = ref.read(appProvider.notifier);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        TclTokens.gutterTab,
        _toolbarTop,
        TclTokens.gutterTab,
        _toolbarBottom,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              state.hasScans
                  ? 'สแกนแล้ว ${state.scans.length} รายการ'
                  : 'ยังไม่มีรายการที่สแกน',
              style: TclTokens.caption(),
            ),
          ),
          const SizedBox(width: _toolbarGap),
          // แทนปุ่มจำลอง 1/2/3 ของ demo (design-fidelity §6 ข้อ 5)
          Semantics(
            button: true,
            label: 'กรอกรหัสบาร์โค้ด',
            child: Tappable(
              onTap: _openManualEntry,
              radius: TclTokens.rDemoButton,
              child: Container(
                width: TclTokens.hDemoButton,
                height: TclTokens.hDemoButton,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: TclTokens.t12,
                  border: Border.all(color: TclTokens.t35),
                  borderRadius: BorderRadius.circular(
                    TclTokens.rDemoButton,
                  ),
                ),
                child: const StrokeIcon(
                  painter: _KeypadIconPainter(),
                  size: _toolIconSize,
                  color: TclTokens.accentHover,
                ),
              ),
            ),
          ),
          if (state.hasScans) ...[
            const SizedBox(width: _toolButtonGap),
            Tappable(
              onTap: controller.clearScans,
              radius: TclTokens.rDemoButton,
              child: Container(
                height: TclTokens.hDemoButton,
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(
                  horizontal: _toolButtonPadX,
                ),
                decoration: BoxDecoration(
                  color: TclTokens.s07,
                  border: Border.all(color: TclTokens.b16),
                  borderRadius: BorderRadius.circular(
                    TclTokens.rDemoButton,
                  ),
                ),
                child: Text(
                  'ล้าง',
                  style: TclTokens.label(TclTokens.tSoft),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  // ── C. รายการผลสแกน ──────────────────────────────────────────────

  Widget _resultList(AppState state) {
    const padding = EdgeInsets.fromLTRB(
      TclTokens.gutterTab,
      _toolbarBottom,
      TclTokens.gutterTab,
      TclTokens.gutterTab,
    );
    if (!state.hasScans) {
      return ListView(padding: padding, children: const [_ScanEmptyState()]);
    }
    final scans = state.scans;
    return ListView.separated(
      padding: padding,
      itemCount: scans.length,
      // ให้ sliver ย้าย element ตาม key เวลาสแกนซ้ำแล้วรายการเด้งขึ้นบน
      // (ไม่ทำ → การ์ดทุกใบถูกสร้างใหม่และเล่นอนิเมชัน rise ซ้ำทั้งลิสต์)
      findItemIndexCallback: (key) {
        if (key is! ValueKey<String>) return null;
        final i = scans.indexWhere((r) => r.sku == key.value);
        return i < 0 ? null : i;
      },
      separatorBuilder: (_, _) => const SizedBox(height: _cardGap),
      itemBuilder: (context, i) => _RiseIn(
        key: ValueKey(scans[i].sku),
        child: _ScanCard(record: scans[i]),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// การ์ดผลสแกน
// ════════════════════════════════════════════════════════════════════

class _ScanCard extends ConsumerWidget {
  const _ScanCard({required this.record});

  final ScanRecord record;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final expandedSku = ref.watch(appProvider.select((s) => s.expandedSku));
    final controller = ref.read(appProvider.notifier);

    // ⚠️ เดิมค้นจาก `Fixtures.items` ตรง ๆ → รหัสจริงจาก ERP (เช่น 2010201) ไม่เคยเจอ
    //    การ์ดคืนกล่องเปล่า ตัวนับขึ้น "สแกนแล้ว 1 รายการ" แต่จอว่าง
    //    `itemFor()` ดู replica ที่ดึงมาจริงก่อน แล้วค่อย fallback เป็นข้อมูลตัวอย่าง
    //    ต้อง watch `scannedItems` ด้วย ไม่งั้นการ์ดไม่ rebuild เมื่อข้อมูลสินค้ามาถึงทีหลัง
    ref.watch(appProvider.select((s) => s.scannedItems[record.sku]));
    final item = controller.itemFor(record.sku);
    if (item == null) return const SizedBox.shrink();

    final expanded = expandedSku == item.sku;

    final onHand = item.onHand;
    // แถบสีของการ์ดอ้าง **สถานะการนับ** ไม่ใช่ระดับสต็อกเทียบ ROP อีกต่อไป:
    // ERP มี MinStock แค่ ~29% ของรายการ แถบส้ม/แดงที่ไม่มีตัวเลขจุดสั่งซื้อ
    // อธิบายกำกับจึงอ่านไม่ออก และจอนี้กลายเป็นจอ "นับ" แล้ว ไม่ใช่จอเช็คสต็อก
    final variance = _varianceFor(ref, item);
    final toneColor = _countToneColor(variance);

    // ERP จริงไม่มี Shelf (ว่าง 100%) → ส่วนใหญ่บรรทัดนี้จะไม่ขึ้นเลย
    final subtitle = item.loc ?? '';

    return GradientCard(
      gradient: TclTokens.scanCardBg,
      border: expanded ? TclTokens.t45 : TclTokens.b13,
      radius: TclTokens.rCard,
      shadow: TclTokens.shScanCard,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Tappable(
            onTap: () => controller.toggleExpanded(item.sku),
            radius: TclTokens.rCard,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: _cardPadX,
                vertical: _cardPadY,
              ),
              child: Row(
                children: [
                  Container(
                    width: _toneBarWidth,
                    height: _toneBarHeight,
                    decoration: BoxDecoration(
                      color: toneColor,
                      borderRadius: BorderRadius.circular(
                        TclTokens.rPill,
                      ),
                    ),
                  ),
                  const SizedBox(width: _cardHeaderGap),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${item.sku} · ${record.at}',
                          style: TclTokens.skuLine(),
                        ),
                        const SizedBox(height: _titleGap),
                        Text(item.name, style: TclTokens.itemName()),
                        if (subtitle.isNotEmpty)
                          Text(subtitle, style: TclTokens.meta()),
                      ],
                    ),
                  ),
                  const SizedBox(width: _cardHeaderGap),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        _qty(onHand),
                        style: TclTokens.qtyHuge(toneColor),
                      ),
                      Text(
                        '${item.unit} คงเหลือ',
                        style: TclTokens.tiny(),
                      ),
                      // ยอดสดจาก ERP หรือยอดจากรอบ sync ล่าสุด — ต้องแยกให้เห็น
                      if (onHand != null)
                        Text(
                          item.onHandSourceLabel,
                          style: TclTokens.tiny(),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            _ScanCardDetail(
              item: item,
              variance: variance,
              toneColor: toneColor,
            ),
        ],
      ),
    );
  }
}

/// ครึ่งล่างของการ์ดที่กางออก — ยอดคงเหลือ/ผลต่าง + ช่องกรอกจำนวนที่นับได้
///
/// stateful เพราะถือ [TextEditingController] ต่อ 1 sku: ค่าที่กรอกอยู่ใน state
/// ส่วนกลาง แต่ cursor/โฟกัสเป็นของ widget นี้ (กด +/− แล้ว cursor ต้องไม่เด้ง)
class _ScanCardDetail extends ConsumerStatefulWidget {
  const _ScanCardDetail({
    required this.item,
    required this.variance,
    required this.toneColor,
  });

  final Item item;
  final Variance variance;
  final Color toneColor;

  @override
  ConsumerState<_ScanCardDetail> createState() => _ScanCardDetailState();
}

class _ScanCardDetailState extends ConsumerState<_ScanCardDetail> {
  late final TextEditingController _ctrl;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    // กางการ์ดใหม่ต้องเห็นยอดที่เคยคีย์ไว้ (รวมที่ hydrate มาจาก SQLite)
    _ctrl = TextEditingController(
      text: ref.read(appProvider).counts[widget.item.sku] ?? '',
    );
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  /// ดึงค่าจาก state เข้า controller เฉพาะเมื่อถูกเปลี่ยนจากภายนอก (กด +/−)
  /// ตอนผู้ใช้พิมพ์เอง text ตรงกับ state อยู่แล้ว → ข้าม เพื่อไม่ให้ cursor เด้ง
  void _syncFromState(String value) {
    if (_ctrl.text == value) return;
    _ctrl.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final controller = ref.read(appProvider.notifier);
    final onHand = item.onHand;
    final canWrite = ref.watch(appProvider.select((s) => s.me.role.canWrite));

    ref.listen(
      appProvider.select((s) => s.counts[item.sku] ?? ''),
      (_, next) => _syncFromState(next),
    );

    final specs = <(String, String)>[
      if (item.vendor != null) ('ผู้ผลิต · Vendor', item.vendor!),
      if (item.lot != null) ('ล็อต · Lot', item.lot!),
      if (item.lastCountDate != null)
        ('นับครั้งล่าสุด · Last count', item.lastCountDate!),
    ];

    final footer = [
      if (item.nameEn != null) item.nameEn!,
      if (item.updated != null) 'อัปเดต ${item.updated}',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.only(
        left: _cardPadX,
        right: _cardPadX,
        bottom: _cardPadX,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 'จอง' (PendingQTY ว่าง 100%) · 'พร้อมขาย' (= onHand − จอง จึง null เสมอ)
          // และ 'จุดสั่งซื้อ' ถูกถอดออก — สามช่องนั้นแสดง '—' ตลอดในข้อมูล ERP จริง
          Row(
            children: [
              Expanded(
                child: _StatTile(label: 'ยอดคงเหลือ', value: _qty(onHand)),
              ),
              const SizedBox(width: _statTileGap),
              Expanded(
                child: _StatTile(
                  label: 'ผลต่าง',
                  // ทิศ "นับได้ − ยอดระบบ" ตาม Variance.signed (ข้อความสำหรับจอ
                  // เท่านั้น — ไม่มีค่านี้ถูกส่งขึ้น server)
                  value: widget.variance.signed,
                  valueColor: widget.toneColor,
                ),
              ),
            ],
          ),
          const SizedBox(height: _blockGap),
          _countRow(controller, onHand: onHand, canWrite: canWrite),
          if (specs.isNotEmpty) ...[
            const SizedBox(height: _blockGap),
            for (final (key, value) in specs)
              _SpecRow(label: key, value: value),
          ],
          const SizedBox(height: _actionGap),
          Row(
            children: [
              // กรอกจำนวนได้ในการ์ดนี้แล้ว ปุ่มกระโดดข้ามแท็บจึงไม่มีเหตุผล —
              // สิ่งที่คนต้องการตรงนี้คือ "ลบค่าที่คีย์ผิด" (ค่าว่าง = ยังไม่ได้นับ
              // ซึ่งถอนบรรทัดออกจากเอกสาร ต่างจาก '0' ที่แปลว่านับแล้วได้ศูนย์)
              Expanded(
                child: SecondaryButton(
                  label: 'ล้างค่าที่นับ',
                  onPressed: () => controller.setScanCount(item, ''),
                ),
              ),
              const SizedBox(width: _fabGap),
              SecondaryButton(
                label: 'นำออก',
                onPressed: () => controller.removeScan(item.sku),
                minWidth: _removeMinWidth,
              ),
            ],
          ),
          if (footer.isNotEmpty) ...[
            const SizedBox(height: _footerGap),
            Text(footer, style: TclTokens.meta()),
          ],
        ],
      ),
    );
  }

  /// แถวกรอกจำนวนที่นับได้ — `−` / ช่องกรอก / `+` / หน่วย
  ///
  /// สองกรณีที่ **ไม่มีช่องกรอกเลย** (กั้นตั้งแต่จอ ไม่ใช่ไปบอกตอนกดส่ง):
  /// - `onHand == null` — ERP ไม่มียอดให้เทียบ นับแล้วส่งไปก็ไม่มีความหมาย
  ///   (null ≠ 0 · ห้ามแปลงเป็น 0 เด็ดขาด)
  /// - viewer — สิทธิ์ดูอย่างเดียว
  Widget _countRow(
    AppController controller, {
    required num? onHand,
    required bool canWrite,
  }) {
    if (onHand == null) {
      return Text(
        'ไม่มียอดระบบ · นับรายการนี้ไม่ได้',
        style: TclTokens.meta(TclTokens.tMuted),
      );
    }
    if (!canWrite) {
      return Text(
        'ดูอย่างเดียว · viewer',
        style: TclTokens.meta(TclTokens.tMuted),
      );
    }

    final item = widget.item;
    return Row(
      children: [
        StepperButton(
          glyph: '−',
          onTap: () => controller.decScanCount(item),
        ),
        const SizedBox(width: _stepperGap),
        CountField(
          controller: _ctrl,
          focused: _focused,
          onFocusChange: (f) => setState(() => _focused = f),
          onChanged: (v) => controller.setScanCount(item, v),
        ),
        const SizedBox(width: _stepperGap),
        StepperButton(
          glyph: '+',
          onTap: () => controller.incScanCount(item),
        ),
        const SizedBox(width: _stepperGap),
        // 44 + 88 + 44 + gap 10×3 = 196px — ที่เหลือเป็นของหน่วยนับ
        Expanded(
          child: Text(
            item.unit,
            style: TclTokens.meta(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.label, required this.value, this.valueColor});

  final String label;
  final String value;

  /// null = สี tBody เดิมของ [TclTokens.statValue] (ช่องที่ไม่ต้องเน้น)
  final Color? valueColor;

  @override
  Widget build(BuildContext context) => GlassCard(
    padding: const EdgeInsets.all(_statTilePad),
    radius: TclTokens.rStatTile,
    fill: TclTokens.s075,
    border: TclTokens.b10,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TclTokens.tiny(TclTokens.tMuted)),
        const SizedBox(height: _titleGap),
        Text(
          value,
          style: valueColor == null
              ? TclTokens.statValue()
              : TclTokens.statValue(valueColor!),
        ),
      ],
    ),
  );
}

class _SpecRow extends StatelessWidget {
  const _SpecRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: _specRowPadY),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: TclTokens.b10)),
    ),
    // แบ่งความกว้างคงที่ 3:2 → คีย์อยู่ซ้าย ค่าชิดขวาเสมอ (space-between ของ
    // design) และตัดบรรทัดเองเมื่อจอแคบ/text scale ใหญ่ แทนที่จะล้นกรอบ
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          flex: _specKeyFlex,
          child: Text(
            label,
            style: TclTokens.body13(TclTokens.tMuted),
          ),
        ),
        const SizedBox(width: _specRowGap),
        Expanded(
          flex: _specValueFlex,
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: TclTokens.body13(TclTokens.tSoftAlt),
          ),
        ),
      ],
    ),
  );
}

class _ScanEmptyState extends StatelessWidget {
  const _ScanEmptyState();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: _emptyPadX,
      vertical: _emptyPadY,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _emptyTextMaxWidth),
          child: Text(
            'สแกนต่อเนื่องได้เรื่อย ๆ ทุกรายการที่อ่านได้จะเรียงไว้ด้านล่างพร้อมยอดคงเหลือ',
            style: TclTokens.body15(
              TclTokens.tSoft,
            ).copyWith(height: _emptyLineHeight),
          ),
        ),
        const SizedBox(height: _emptyLineGap),
        Text(
          'แตะรายการเพื่อดูรายละเอียดเพิ่ม',
          style: TclTokens.caption(TclTokens.tFaint),
        ),
      ],
    ),
  );
}

/// ผลต่างของการ์ด 1 ใบ — ยอดที่คีย์เทียบยอดระบบ **ที่จอโชว์อยู่**
///
/// watch เฉพาะค่าของ sku นี้ → คีย์การ์ดหนึ่งไม่ทำให้การ์ดอื่นทั้งลิสต์ rebuild
/// `onHand == null` = ห้ามนับ → ไม่มีผลต่างให้พูดถึง
Variance _varianceFor(WidgetRef ref, Item item) {
  final entered = ref.watch(
    appProvider.select((s) => s.counts[item.sku] ?? ''),
  );
  final onHand = item.onHand;
  if (onHand == null) return Variance.notCounted;
  return Variance.from(entered: entered, systemQty: onHand);
}

/// สีตามสถานะการนับ — สูตรเดียวกับ `_varianceTone` ของจอนับ
/// (ยังไม่นับ = กลาง · ตรงกับระบบ = ok · ขาด/เกิน = warn)
Color _countToneColor(Variance v) {
  if (!v.isCounted) return TclTokens.tMuted;
  return v.isMatch ? TclTokens.ok : TclTokens.warn;
}

/// ตัวเลขจำนวนแบบคั่นหลักพัน (design ใช้ `toLocaleString` → 1,240)
String _qty(num? value) {
  if (value == null) return _noValue;
  final negative = value < 0;
  final abs = value.abs();
  final plain = abs == abs.roundToDouble()
      ? abs.toInt().toString()
      : abs.toString();
  final parts = plain.split('.');
  final digits = parts.first;
  final out = StringBuffer(negative ? '-' : '');
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  if (parts.length > 1) out.write('.${parts[1]}');
  return out.toString();
}

// ════════════════════════════════════════════════════════════════════
// D. ช่องกรอกบาร์โค้ดมือ (design extension §7 ข้อ 7)
// ════════════════════════════════════════════════════════════════════

class _ManualCodeDialog extends StatefulWidget {
  const _ManualCodeDialog();

  @override
  State<_ManualCodeDialog> createState() => _ManualCodeDialogState();
}

class _ManualCodeDialogState extends State<_ManualCodeDialog> {
  final TextEditingController _controller = TextEditingController();
  bool _focused = false;
  String _code = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final code = _code.trim();
    if (code.isEmpty) return;
    Navigator.of(context).pop(code);
  }

  @override
  Widget build(BuildContext context) => Material(
    type: MaterialType.transparency,
    child: Padding(
      // เลื่อนพ้นคีย์บอร์ด (design-fidelity §5.2)
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(TclTokens.gutterTab),
          child: GradientCard(
            gradient: TclTokens.sheetBg,
            border: TclTokens.b15,
            radius: TclTokens.rSheet,
            shadow: TclTokens.shSheet,
            padding: const EdgeInsets.all(_dialogPad),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('กรอกรหัสบาร์โค้ด', style: TclTokens.sheetTitle()),
                const SizedBox(height: _titleGap),
                Text(
                  'ใช้เมื่อกล้องอ่านไม่ได้หรือฉลากเสีย',
                  style: TclTokens.caption(),
                ),
                const SizedBox(height: _actionGap),
                Text('รหัสสินค้า · บาร์โค้ด', style: TclTokens.label()),
                const SizedBox(height: _toolButtonGap),
                FieldBox(
                  height: TclTokens.hSheetInput,
                  focused: _focused,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Focus(
                      onFocusChange: (has) => setState(() => _focused = has),
                      child: TokenTextField(
                        controller: _controller,
                        onChanged: (v) => setState(() => _code = v),
                        hint: 'SKU-40128',
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: _actionGap),
                Row(
                  children: [
                    SecondaryButton(
                      label: 'ยกเลิก',
                      onPressed: () => Navigator.of(context).pop(),
                      height: TclTokens.hSheetButton,
                      radius: TclTokens.rSheetButton,
                      minWidth: _dialogCancelMinWidth,
                    ),
                    const SizedBox(width: _fabGap),
                    Expanded(
                      child: PrimaryButton(
                        label: 'ยืนยัน',
                        onPressed: _code.trim().isEmpty ? null : _submit,
                        height: TclTokens.hSheetButton,
                        radius: TclTokens.rSheetButton,
                        shadow: const [],
                        fontSize: TclTokens.ctaSecondary().fontSize!,
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

// ════════════════════════════════════════════════════════════════════
// E. แอนิเมชัน (เคารพ reduce-motion ทุกตัว)
// ════════════════════════════════════════════════════════════════════

/// การ์ดเข้าแบบ `rise`: translateY 26→0 + fade (220ms, cubic-bezier ของ design)
class _RiseIn extends StatefulWidget {
  const _RiseIn({required this.child, super.key});

  final Widget child;

  @override
  State<_RiseIn> createState() => _RiseInState();
}

class _RiseInState extends State<_RiseIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: TclTokens.dRiseCard,
  );
  late final Animation<double> _t = CurvedAnimation(
    parent: _c,
    curve: TclTokens.cRise,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _t,
    builder: (context, child) => Opacity(
      opacity: _t.value.clamp(0, 1),
      child: Transform.translate(
        offset: Offset(0, _riseFrom * (1 - _t.value)),
        child: child,
      ),
    ),
    child: widget.child,
  );
}

/// จุดสถานะกล้อง: opacity .35↔1 + scale .9↔1 ต่อเนื่อง 1.5s
class _PulseDot extends StatefulWidget {
  const _PulseDot();

  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: TclTokens.dPulse,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.stop();
      _c.value = 0.5; // ค้างที่จุดสว่างสุด
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, child) {
      // keyframe 0%/100% = ค่าต่ำสุด, 50% = ค่าสูงสุด → คลื่นสามเหลี่ยม
      final wave = Curves.easeInOut.transform(1 - (_c.value * 2 - 1).abs());
      return Opacity(
        opacity: _pulseMinOpacity + (1 - _pulseMinOpacity) * wave,
        child: Transform.scale(
          scale: _pulseMinScale + (1 - _pulseMinScale) * wave,
          child: child,
        ),
      );
    },
    child: Container(
      width: _statusDotSize,
      height: _statusDotSize,
      decoration: const BoxDecoration(
        color: TclTokens.ok,
        shape: BoxShape.circle,
      ),
    ),
  );
}

/// เส้นเลเซอร์กวาดขึ้นลงระหว่างกรอบมุม (26% ↔ 74%)
///
/// ⚠️ deviation ที่บันทึกไว้: CSS ตรงตัวขยับแค่ ±44% ของความสูง 2px
/// (แทบไม่ขยับ) → ตีความตาม intent ตาม design-fidelity §1.7
class _SweepLine extends StatefulWidget {
  const _SweepLine({required this.frameWidth, required this.frameHeight});

  final double frameWidth;
  final double frameHeight;

  @override
  State<_SweepLine> createState() => _SweepLineState();
}

class _SweepLineState extends State<_SweepLine>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: TclTokens.dSweep,
  );
  late final Animation<double> _t = CurvedAnimation(
    parent: _c,
    curve: Curves.easeInOut,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.stop();
      _c.value = 0.5; // ค้างกลางกรอบ (ตำแหน่ง top:50% ของ design)
    } else if (!_c.isAnimating) {
      _c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final inset = widget.frameWidth * _laserInsetX;
    return AnimatedBuilder(
      animation: _t,
      builder: (context, child) {
        final center =
            widget.frameHeight *
            (_sweepFrom + (_sweepTo - _sweepFrom) * _t.value);
        return Positioned(
          left: inset,
          right: inset,
          top: center - _laserHeight / 2,
          height: _laserHeight,
          child: child!,
        );
      },
      child: IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [
                TclTokens.accentBright.withValues(alpha: 0),
                TclTokens.accentBright,
                TclTokens.accentBright.withValues(alpha: 0),
              ],
            ),
            borderRadius: BorderRadius.circular(TclTokens.rPill),
            boxShadow: TclTokens.shSweepGlow,
          ),
        ),
      ),
    );
  }
}

/// วงแหวน glow รอบ FAB กล้องตอนกล้องปิด (ขยาย 0→14px แล้วจาง)
///
/// Flutter animate `box-shadow` spread ตรง ๆ ไม่ได้ → วาดด้วย CustomPainter
class _GlowRing extends StatefulWidget {
  const _GlowRing({required this.active, required this.child});

  final bool active;
  final Widget child;

  @override
  State<_GlowRing> createState() => _GlowRingState();
}

class _GlowRingState extends State<_GlowRing>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: TclTokens.dGlow,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(_GlowRing old) {
    super.didUpdateWidget(old);
    if (old.active != widget.active) _sync();
  }

  void _sync() {
    if (!widget.active || MediaQuery.disableAnimationsOf(context)) {
      _c.stop();
      _c.value = 0;
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, child) {
      final wave = Curves.easeOut.transform(1 - (_c.value * 2 - 1).abs());
      return CustomPaint(
        painter: _GlowRingPainter(
          spread: TclTokens.glowMaxSpread * wave,
          fade: 1 - wave,
          radius: TclTokens.rFab,
        ),
        child: child,
      );
    },
    child: widget.child,
  );
}

class _GlowRingPainter extends CustomPainter {
  const _GlowRingPainter({
    required this.spread,
    required this.fade,
    required this.radius,
  });

  final double spread;
  final double fade;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    if (spread <= 0 || fade <= 0) return;
    // box-shadow ภายนอกถูก clip ออกจาก border-box → เจาะรูปปุ่มออก
    final outer = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(
            -spread,
            -spread,
            size.width + spread * 2,
            size.height + spread * 2,
          ),
          Radius.circular(radius + spread),
        ),
      );
    final inner = Path()
      ..addRRect(
        RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)),
      );
    canvas.drawPath(
      Path.combine(PathOperation.difference, outer, inner),
      Paint()
        ..color = TclTokens.t35.withValues(
          alpha: TclTokens.t35.a * fade,
        ),
    );
  }

  @override
  bool shouldRepaint(_GlowRingPainter old) =>
      old.spread != spread || old.fade != fade || old.radius != radius;
}

// ════════════════════════════════════════════════════════════════════
// FAB + ไอคอน stroke (path เดียวกับ SVG ใน design, viewBox 24×24)
// ════════════════════════════════════════════════════════════════════

class _CamFab extends StatelessWidget {
  const _CamFab({
    required this.semanticLabel,
    required this.painter,
    required this.onTap,
  });

  final String semanticLabel;
  final CustomPainter painter;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: semanticLabel,
    child: Tappable(
      onTap: onTap,
      radius: TclTokens.rFab,
      child: Container(
        width: TclTokens.hFab,
        height: TclTokens.hFab,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: TclTokens.camPillBg,
          border: Border.all(color: TclTokens.b18),
          borderRadius: BorderRadius.circular(TclTokens.rFab),
        ),
        child: StrokeIcon(
          painter: painter,
          size: _fabIconSize,
          color: TclTokens.tBody,
        ),
      ),
    ),
  );
}

/// กรอบมุม 4 ชิ้น 30×30 หนา 3 โค้งมุมนอก 14 (วาดชิ้นเดียวแล้วมิเรอร์)
class _CornerBracketsPainter extends CustomPainter {
  const _CornerBracketsPainter();

  @override
  void paint(Canvas canvas, Size size) {
    const half = _bracketStroke / 2;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _bracketStroke
      ..color = TclTokens.accentBright;

    // CSS วาด border ไว้ในกรอบ → เยื้องเส้นเข้ามาครึ่งความหนา
    final bracket = Path()
      ..moveTo(half, _bracketArm)
      ..lineTo(half, TclTokens.rCornerBracket)
      ..arcTo(
        Rect.fromCircle(
          center: const Offset(
            TclTokens.rCornerBracket,
            TclTokens.rCornerBracket,
          ),
          radius: TclTokens.rCornerBracket - half,
        ),
        math.pi,
        math.pi / 2,
        false,
      )
      ..lineTo(_bracketArm, half);

    const mirrors = [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)];
    for (final (sx, sy) in mirrors) {
      canvas
        ..save()
        ..translate(sx < 0 ? size.width : 0, sy < 0 ? size.height : 0)
        ..scale(sx, sy)
        ..drawPath(bracket, paint)
        ..restore();
    }
  }

  @override
  bool shouldRepaint(_CornerBracketsPainter old) => false;
}

/// `M4 9.5A2.5 2.5 0 0 1 6.5 7h1L9 5h6l1.5 2h1A2.5 2.5 0 0 1 20 9.5v7…` + วงเลนส์
class _CameraIconPainter extends CustomPainter {
  const _CameraIconPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = TclTokens.tBody;
    const r = Radius.circular(2.5);
    final body = Path()
      ..moveTo(4, 9.5)
      ..arcToPoint(const Offset(6.5, 7), radius: r)
      ..lineTo(7.5, 7)
      ..lineTo(9, 5)
      ..lineTo(15, 5)
      ..lineTo(16.5, 7)
      ..lineTo(17.5, 7)
      ..arcToPoint(const Offset(20, 9.5), radius: r)
      ..lineTo(20, 16.5)
      ..arcToPoint(const Offset(17.5, 19), radius: r)
      ..lineTo(6.5, 19)
      ..arcToPoint(const Offset(4, 16.5), radius: r)
      ..close();

    canvas
      ..save()
      ..scale(size.width / 24, size.height / 24)
      ..drawPath(body, paint)
      ..drawCircle(const Offset(12, 13), 3.4, paint)
      ..restore();
  }

  @override
  bool shouldRepaint(_CameraIconPainter old) => false;
}

/// `<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>`
class _SearchIconPainter extends CustomPainter {
  const _SearchIconPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..color = TclTokens.tBody;
    canvas
      ..save()
      ..scale(size.width / 24, size.height / 24)
      ..drawCircle(const Offset(11, 11), 7, paint)
      ..drawLine(const Offset(20, 20), const Offset(15.7, 15.7), paint)
      ..restore();
  }

  @override
  bool shouldRepaint(_SearchIconPainter old) => false;
}

/// ไอคอนแป้นตัวเลขของปุ่มกรอกบาร์โค้ดมือ (วาดด้วยภาษา stroke เดียวกัน)
class _KeypadIconPainter extends CustomPainter {
  const _KeypadIconPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..color = TclTokens.accentHover;
    canvas
      ..save()
      ..scale(size.width / 24, size.height / 24)
      ..drawRRect(
        RRect.fromRectAndRadius(
          const Rect.fromLTRB(3, 5, 21, 19),
          const Radius.circular(2.5),
        ),
        paint,
      );
    for (final y in const [9.5, 13.0]) {
      for (final x in const [7.5, 12.0, 16.5]) {
        canvas.drawLine(Offset(x - 0.6, y), Offset(x + 0.6, y), paint);
      }
    }
    canvas
      ..drawLine(const Offset(9.5, 16.2), const Offset(14.5, 16.2), paint)
      ..restore();
  }

  @override
  bool shouldRepaint(_KeypadIconPainter old) => false;
}
