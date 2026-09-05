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

/// hero กลางกรอบตอนโหมดเครื่องยิง (โหมดนี้ไม่มีเลเซอร์/กรอบมุมให้มองแทน)
const double _heroIconSize = 28;
const double _heroGap = 10;

/// `@keyframes rise` — translateY(26px) → 0
const double _riseFrom = 26;

/// แถบสลับโหมดสแกน: มิติเดียวกับ `_ViewSwitch` ของจอผู้ดูแล (pad 4 · สูง 38)
const double _modeBandTop = 14;
const double _modeSwitchPad = 4;
const double _modeButtonHeight = 38;
const double _modeIconGap = 7;
const double _modeIconSize = 16;

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

/// สวิตช์ย้อนกลับของการกลืนคีย์เครื่องยิง — ตั้ง `false` แล้วปล่อยคีย์ไหลต่อทุกตัว
/// โดยไม่ต้อง revert สัญญาของ [HandheldScanBuffer.feed]
///
/// ⚠️ ไม่ใช่สวิตช์ "กันคีย์บอร์ดจอพิมพ์เลขไม่เข้า" อีกต่อไป — เรื่องนั้นแก้ที่
/// [HandheldScanBuffer.burstGap] แล้ว (กลืนตามความเร็ว เลขที่นิ้วคนแตะไม่มีวันโดน)
/// เหลือไว้เป็นคันโยกสำหรับ debug หน้างานเท่านั้น: ปิดแล้วอักขระของเครื่องยิงจะ
/// รั่วลงช่องที่โฟกัสอยู่ทั้งสาย (snapshot/restore ยังกู้ให้ แต่จะเห็นตัวเลขกระพริบ)
const bool _swallowScannerKeys = true;

/// นาฬิกาวัดจังหวะคีย์เครื่องยิง — เทสต์เท่านั้นที่เปลี่ยน
/// (`tester.pump()` ขยับแต่นาฬิกาปลอมของ framework ไม่ขยับ `DateTime.now()`
///  เทสต์ที่วัดความเร็วคีย์จึงคุมจังหวะไม่ได้ถ้าไม่มีตะเข็บนี้)
@visibleForTesting
DateTime Function() handheldNow = DateTime.now;

/// แหล่งที่อ่านรหัสเข้ามา — ด่านดีดัพต้องรู้ว่า "ใคร" อ่าน ไม่ใช่แค่ "อ่านอะไร"
enum _ScanSource { camera, handheld, manual }

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

  /// มีคนกำลังไล่สถานะกล้องอยู่ (ห้ามสั่ง native ซ้อน) — **ไม่ใช่** เหตุผลให้ทิ้งคำสั่ง
  bool _busy = false;

  /// สถานะกล้องที่ "ขอไว้ล่าสุด" กับสถานะที่ลงมือทำสำเร็จไปแล้ว
  ///
  /// สองค่านี้คือทั้งหมดของการปรองดอง: ใครสั่งอะไรเข้ามาก็เขียนแค่ [_wantCamOn]
  /// ตัวที่กำลังวนอยู่จะเห็นเองแล้วไล่ให้ตรงกัน
  ///
  /// ⚠️ [_appliedCamOn] เป็น `null` ได้ = **ไม่รู้** ว่าฮาร์ดแวร์ค้างอยู่สถานะไหน
  /// (native โยน exception กลางคำสั่ง) — `null` ไม่เท่ากับเป้าไหนเลย คำสั่งครั้ง
  /// ถัดไปจึงถูกส่งถึง native จริงเสมอ ถ้าจำค่าเดิมไว้แทน คำสั่งที่ "ตรงกับค่าเดิม"
  /// จะถูกมองว่าไม่มีอะไรต้องทำแล้วไม่ถึง native เลย (เช่น `stop()` โยนตอนสลับไป
  /// โหมดเครื่องยิง แล้วกลับมาโหมดกล้องอีกครั้ง — `start()` จะไม่ถูกสั่งอีกตลอดกาล
  /// เหลือเลเซอร์กวาดบนภาพดำ)
  bool _wantCamOn = false;
  bool? _appliedCamOn = false;

  /// เครื่องยิงบาร์โค้ด (handheld) — ทำตัวเป็นคีย์บอร์ด ยิงแล้วพิมพ์รหัส + Enter
  ///
  /// รับที่ระดับจอ ไม่ใช่ผ่านช่องกรอก เพราะช่องกรอกจะเรียกคีย์บอร์ดจอขึ้นมาบัง
  /// และผู้ใช้ต้องแตะจอทุกครั้ง — ผิดวัตถุประสงค์ของการยิงรัวทีละชิ้น
  final FocusNode _handheldFocus = FocusNode(debugLabel: 'handheld-scan');
  final HandheldScanBuffer _handheld = HandheldScanBuffer();

  /// ตัวคุม AppState ที่จับไว้ตั้งแต่จอเกิด — **ทางเดียว**ที่ [dispose] ซ่อม
  /// ยอดที่รั่วได้
  ///
  /// riverpod 3 โยน `StateError` ทันทีที่แตะ `ref` หลัง element ถูก unmount
  /// ("Using ref when a widget is about to or has been unmounted is unsafe")
  /// และบอกทางแก้ไว้เองว่าให้เก็บตัวที่ต้องใช้ลงฟิลด์ของ State ไว้ก่อน
  /// (`appProvider` ไม่ใช่ autoDispose และไม่มีใคร invalidate — ตัวนี้จึงอยู่ยาว
  ///  เท่าอายุของ container ซึ่งครอบอายุของจอนี้อยู่แล้ว)
  late final AppController _app;

  @override
  void initState() {
    super.initState();
    _app = ref.read(appProvider.notifier);
    WidgetsBinding.instance.addObserver(this);
    // กลับเข้าแท็บสแกนแล้ว camOn ยังเป็น true → ต้องเปิดกล้องต่อเอง
    // (รอ post-frame ให้ MobileScanner attach controller ก่อน)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (ref.read(appProvider).camOn) unawaited(_setCamera(true));
    });
  }

  /// จอถูกถอดออกจาก tree ทั้งที่สายรัวยังค้าง — สลับแท็บ (app shell ถอด
  /// `ScanScreen` ทิ้งจริง ไม่มี `IndexedStack` คั่น) · ออกจากระบบ · ปิดจอ
  ///
  /// อักขระที่รั่วไปแล้วต้องถูกถอนที่นี่ ทิ้งไปพร้อมจอไม่ได้ — มันอยู่ใน AppState
  /// และในแถว count_drafts ตั้งแต่วินาทีที่มันรั่ว ไม่มีจอไหนต้องเปิดอยู่ทั้งนั้น
  ///
  /// ⚠️ ตัวหนังสือบนจอไม่ต้องกู้ (ช่องกำลังหายไปกับจอ) และ**กู้ไม่ได้ด้วย**:
  /// การ์ดถูก unmount ก่อนพ่อเสมอ `_disposeCountField` จึง null ตัว controller
  /// ใน snapshot ทิ้งไปแล้ว — [_restoreCountField] ข้ามการเขียนจอให้เอง
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _closeCountSnapshot(afterFrame: true); // ยกเลิก `_burstDeathTimer` ให้ด้วย
    //                   ในตัว — ห้ามมีนัดค้างยิงใส่ controller/ref ที่ตายไปแล้ว
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
      unawaited(_setCamera(false));
    } else if (state == AppLifecycleState.resumed) {
      if (ref.read(appProvider).camOn) unawaited(_setCamera(true));
    }
  }

  /// ปลายทางเดียวของทุกคำสั่งเปิด/ปิดกล้อง — ไล่ให้ถึงสถานะที่ขอไว้ **ล่าสุด**
  ///
  /// เดิม `_startCamera`/`_stopCamera` ขึ้นต้นด้วย `if (_busy) return;` แล้ว
  /// **ทิ้งคำสั่งนั้นทั้งดุ้น** ไม่มีใครตามเก็บ · แถบสลับโหมดกับปุ่มฮาร์ดแวร์สั่ง
  /// สลับได้เร็วกว่า `_scanner.start()` จะคืนค่า จึงเหลือกล้อง native ที่ยังทำงาน
  /// อยู่ทั้งที่ `camOn == false` และปุ่มกล้องถูกถอดออกจากจอไปแล้ว — ไม่มีปุ่มไหน
  /// เหลือให้กดแก้ (Bluebird คืน `BBAPI_ERROR_BARCODE_CAMERA_USED = -9` เมื่อ
  /// กล้องถูกยึดไว้แบบนี้ เครื่องยิงก็พลอยใช้ไม่ได้)
  ///
  /// วนซ้ำได้เฉพาะเมื่อ "เป้าเปลี่ยน" เท่านั้น — คำสั่งที่ล้มเหลวไม่เคยถูกลองใหม่
  /// ด้วยเป้าเดิม จึงไม่มีทางกลายเป็น retry loop ที่ไม่รู้จบ
  ///
  /// native ที่ **โยน exception** ก็ต้องจบลงที่สถานะที่ปรองดองได้เหมือนกัน: รอบนั้น
  /// ทิ้ง [_appliedCamOn] ไว้เป็น `null` (ไม่รู้) แทนที่จะจำค่าเดิม แล้วเลิกวน —
  /// คำสั่งของผู้ใช้ครั้งถัดไปจะถูกส่งถึง native จริง ไม่ถูกกลืนว่า "ตรงอยู่แล้ว"
  Future<void> _setCamera(bool on) async {
    _wantCamOn = on;
    if (_busy) return; // ตัวที่วนอยู่จะเห็นค่าใหม่เองในรอบถัดไป
    _busy = true;
    try {
      while (mounted && _wantCamOn != _appliedCamOn) {
        final target = _wantCamOn;
        if (await _applyCamera(target)) {
          _appliedCamOn = target;
          continue;
        }
        // native โยนกลางคัน = ฮาร์ดแวร์อยู่สถานะไหนก็ไม่รู้ ห้ามจำค่าเดิมต่อ
        _appliedCamOn = null;
        // ล้มเหลว = ไม่ลองเป้าเดิมซ้ำ · วนต่อเฉพาะเมื่อมีคำสั่งใหม่เข้ามาระหว่างรอ
        if (_wantCamOn == target) break;
      }
    } finally {
      _busy = false;
    }
  }

  /// สั่ง native หนึ่งครั้ง — `true` = สำเร็จ (เป้าถือว่าไปถึงแล้ว)
  Future<bool> _applyCamera(bool on) async {
    try {
      if (on) {
        await _scanner.start();
      } else {
        await _scanner.stop();
      }
      return true;
    } on Object catch (e) {
      final code = e is MobileScannerException
          ? e.errorCode
          : MobileScannerErrorCode.genericError;
      // "เริ่มไปแล้ว/กำลังเริ่ม" = กล้องเปิดอยู่จริง ต้องนับว่าถึงเป้า ไม่งั้น
      // `_appliedCamOn` โกหกว่ายังปิด แล้วคำสั่งปิดครั้งต่อไปจะถูกมองว่าไม่มีอะไรต้องทำ
      // (จริงเฉพาะตอนสั่ง**เปิด** — คำสั่งปิดที่เจอรหัสนี้แปลว่ากล้องยังทำงานอยู่)
      if (on &&
          (code == MobileScannerErrorCode.controllerAlreadyInitialized ||
              code == MobileScannerErrorCode.controllerInitializing)) {
        return true;
      }
      // ⚠️ เดิมฝั่ง "ปิดไม่สำเร็จ" เงียบสนิทเพราะคิดว่าผู้ใช้ไม่มีอะไรต้องทำต่อ
      //    แต่ในโหมดเครื่องยิงไม่มีปุ่มกล้องเหลือบนจอเลย ผู้ใช้จึงไม่มีทางรู้ว่า
      //    กล้องยังยึดเซ็นเซอร์อยู่ (Bluebird: BBAPI_ERROR_BARCODE_CAMERA_USED = -9
      //    → เครื่องยิงก็พลอยอ่านไม่ได้) ต้องบอกผ่าน CamStatus เหมือนตอนเปิดไม่ได้
      debugPrint('TCL: ${on ? 'เปิด' : 'ปิด'}กล้องไม่สำเร็จ — $e');
      if (mounted) _reportCameraFailure(code, target: on);
      return false;
    }
  }

  /// [target] = สถานะที่คำสั่งซึ่งล้มพยายามไปให้ถึง (ไม่ใช่สถานะที่ขอไว้ล่าสุด)
  void _reportCameraFailure(
    MobileScannerErrorCode code, {
    required bool target,
  }) {
    // กำลังเริ่มอยู่แล้ว / เริ่มไปแล้ว = ไม่ใช่ความผิดพลาด
    if (code == MobileScannerErrorCode.controllerAlreadyInitialized ||
        code == MobileScannerErrorCode.controllerInitializing) {
      return;
    }
    // ⚠️ มีคำสั่งใหม่กว่ารออยู่แล้ว (เช่นแอปถูกปลุกกลับมาระหว่างที่ `stop()` ของ
    // ตอน pause ยังไม่คืนค่า) — ความล้มของ**เป้าเก่า**ห้ามเขียนทับเจตนาล่าสุด
    // `setCamOn(false)` วิ่งกลับเข้า `_setCamera(false)` ทาง `ref.listen` แล้ว
    // ลบคำสั่งเปิดที่คิวไว้ทิ้งเงียบ ๆ ผู้ใช้กลับมาเจอกล้องดับคู่กับป้าย
    // "ตัวอ่านไม่พร้อม" ที่ไม่จริงแล้ว และไม่มีอะไรบอกว่าต้องแตะ FAB ซ้ำ
    //
    // ไม่ใช่การกลืนความผิดพลาด: `_setCamera` กำลังจะไล่เป้าใหม่ต่อในรอบถัดไป
    // (รอบเดียว ไม่ใช่ retry เป้าเดิม) ถ้าเป้านั้นล้มด้วย มันจะรายงานตอนนั้นเอง
    if (_wantCamOn != target) return;
    final c = ref.read(appProvider.notifier);
    c.setCamOn(false); // ลำดับสำคัญ: setCamOn เขียน camStatus ทับ
    if (code == MobileScannerErrorCode.permissionDenied) {
      c.setCamStatus(CamStatus.permissionDenied);
      c.flash('ไม่ได้รับอนุญาตใช้กล้อง · camera blocked');
    } else {
      c.setCamStatus(CamStatus.detectorUnavailable);
      // โหมดกล้อง: ป้ายสถานะอยู่บนภาพที่ผู้ใช้จ้องอยู่แล้ว และ preview ที่ดับไป
      // ก็เห็นเอง · โหมดเครื่องยิงไม่มีทั้งสองอย่าง คนที่กำลังเล็งฉลากอยู่ไม่ได้
      // มองป้ายมุมกรอบ ต้องมี toast สะกิดด้วย — กล้องที่ยังยึดเซ็นเซอร์อยู่ทำให้
      // เครื่องยิงพลอยอ่านไม่ได้ (BBAPI_ERROR_BARCODE_CAMERA_USED = -9)
      if (ref.read(appProvider).scanMode == ScanMode.handheld) {
        c.flash(CamStatus.detectorUnavailable.text);
      }
    }
  }

  /// ฉลากล่าสุดที่ผ่านด่านแล้ว: รหัส · เวลาที่ผ่าน · แหล่งที่อ่าน**ใบนี้**ไปแล้ว
  ({String code, DateTime at, Set<_ScanSource> readBy})? _lastResolved;

  /// ค่าเดียวกับ `detectionTimeoutMs` ของ `_scanner` ด้านบน — ไม่ใช่ตัวเลขใหม่
  /// mobile_scanner บังคับ cooldown นี้กับตัวเองอยู่แล้วสำหรับ "รหัสเดียวกันซ้ำ"
  /// ตอนนี้ทำให้กฎเดียวกันครอบคลุมข้ามแหล่ง (กล้อง+เครื่องยิง) ด้วย
  static const Duration _resolveDedupe = Duration(milliseconds: 1500);

  /// ทุก decode ต้องสั่น **ก่อน** ตรวจว่าเจอสินค้าไหม (design: `buzz()` มาก่อน)
  ///
  /// ด่านดีดัพมีไว้ทำอย่างเดียว: ฉลาก **ใบเดียวกัน** ที่ถูกกล้องกับเครื่องยิงอ่าน
  /// พร้อมกัน = 1 สแกน · ไม่ใช่ "รหัสนี้ห้ามซ้ำใน 1.5 วิ" — สินค้าที่ไม่ซีเรียล
  /// สองชิ้นใช้บาร์โค้ดเดียวกัน ยิงติด ๆ กันด้วยเครื่องเดิมคือ **สองชิ้นจริง**
  /// ถ้ากลืนตัวที่สองทิ้ง จะไม่สั่น ไม่เด้งการ์ด และไม่มีแถว scan_event ให้ตรวจย้อน
  /// เกณฑ์จึงเป็น "แหล่งนี้ยังไม่ได้อ่านใบนี้" ไม่ใช่ "รหัสนี้เพิ่งผ่านไป"
  ///
  /// [allowDuplicate] ข้ามด่านทั้งหมด — ใช้กับรหัสที่คนพิมพ์เองเท่านั้น
  void _resolve(
    String code, {
    required _ScanSource source,
    bool allowDuplicate = false,
  }) {
    final now = DateTime.now();
    final last = _lastResolved;
    if (!allowDuplicate &&
        last != null &&
        last.code == code &&
        now.difference(last.at) <= _resolveDedupe &&
        !last.readBy.contains(source)) {
      // อีกแหล่งเพิ่งอ่านใบนี้ไป — จำไว้ว่าแหล่งนี้ก็อ่านแล้ว ครั้งหน้าที่แหล่งนี้
      // เจอรหัสเดิมอีกจึงถือเป็นชิ้นใหม่ ไม่ใช่เสียงสะท้อนของใบเดิม
      last.readBy.add(source);
      return;
    }
    _lastResolved = (code: code, at: now, readBy: {source});
    HapticFeedback.mediumImpact();
    // ใช้เวอร์ชัน async — ค้นจาก replica ในเครื่อง (ทำงานได้แม้ออฟไลน์)
    ref.read(appProvider.notifier).resolveCodeAsync(code);
  }

  void _onDetect(BarcodeCapture capture) {
    // กล้อง native หยุดไม่ทันคำสั่ง (stop เป็น async) จึงยังส่งผลตรวจจับเข้ามาได้
    // อีกหลายเฟรมหลัง UI สลับไปโหมดเครื่องยิงแล้ว
    if (!ref.read(appProvider).camOn) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw != null && raw.isNotEmpty) {
        _resolve(raw, source: _ScanSource.camera);
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
    // พิมพ์รหัสเดิมซ้ำด้วยมือ = ความตั้งใจ ไม่ใช่ฉลากเดียวกันถูกอ่านซ้ำ
    _resolve(code, source: _ScanSource.manual, allowDuplicate: true);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(appProvider);

    // camOn เปลี่ยนจากที่อื่น (ปุ่ม FAB / permission) → ขับกล้องตามสถานะ
    ref.listen<bool>(appProvider.select((s) => s.camOn), (_, on) {
      unawaited(_setCamera(on));
    });

    // จุดรวมเดียวที่ทิ้งเศษรหัสค้างในบัฟเฟอร์ทุกครั้งที่โหมดเปลี่ยน — ไม่ว่าจะ
    // มาจากแถบสลับโหมด ปุ่มฮาร์ดแวร์ หรือทางอื่นในอนาคต
    ref.listen<ScanMode>(appProvider.select((s) => s.scanMode), (_, _) {
      // ⚠️ ปิดบัญชี snapshot **ก่อน** `reset()` เสมอ — `reset()` ลบหลักฐานสายรัว
      // ที่ [_closeCountSnapshot] ใช้ตัดสินว่าควรกู้ไหม พอหลักฐานหาย อักขระที่
      // รั่วไปแล้วจะถูกทิ้งทั้งที่ยังค้างอยู่ทั้งบนจอ ใน state และใน count_drafts
      _closeCountSnapshot();
      _handheld.reset(); // บัฟเฟอร์ตายแล้ว ไม่มีรหัสไหนจะมาสั่งกู้อีก
    });

    // min-height 190 ชนะ flex-basis 186 เหมือน CSS → กรอบที่หดจริงสูง 190
    // โหมดเครื่องยิงตรึง 190 เสมอ ไม่ขยายเต็มจอ — คืนพื้นที่ให้ลิสต์ผลสแกน
    final camera = state.scanMode == ScanMode.handheld
        ? SizedBox(
            height: TclTokens.cameraMinHeight,
            child: _cameraFrame(state),
          )
        : ConstrainedBox(
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

    // เทียบเท่า `!state.hasScans` เดิมทุกประการเมื่ออยู่โหมดกล้อง
    final expandCamera = state.scanMode == ScanMode.camera && !state.hasScans;

    // เครื่องยิงบาร์โค้ดส่งคีย์เข้ามาที่จอตรง ๆ (ไม่ผ่านช่องกรอก) จึงห่อทั้งจอไว้
    // `skipTraversal` กันไม่ให้โหนดนี้ไปแทรกลำดับ Tab ของช่องกรอกจำนวน
    // และคืน `ignored` ให้คีย์ที่ไม่ใช่ของเครื่องยิง เพื่อให้ไหลต่อไปหาช่องกรอกตามปกติ
    return Focus(
      focusNode: _handheldFocus,
      autofocus: true,
      skipTraversal: true,
      onKeyEvent: _onHandheldKey,
      child: Column(
        children: [
          if (expandCamera) Expanded(child: camera) else camera,
          _modeBand(state),
          _toolbar(state),
          Expanded(child: _resultList(state)),
          // ปุ่มส่งเอกสาร — ซ่อนตัวเองเมื่อยังไม่มีบรรทัดที่คีย์ (ลิสต์ได้ความสูงเต็ม)
          const SubmitDraftsBar(),
        ],
      ),
    );
  }

  // ── ช่องจำนวนที่โฟกัสอยู่: snapshot ก่อนรั่ว · กู้คืนเมื่อรหัสจบหรือสายรัวตาย ──

  /// ช่องจำนวนบนการ์ดที่กำลังโฟกัสอยู่ — จุดเดียวที่รู้ว่าอักขระตัวแรกของสายรัว
  /// จะไปตกที่ไหน · ฟิลด์ธรรมดา ห้ามอยู่ใน `setState` (ไม่มีผลต่อการวาด)
  ({Item item, TextEditingController ctrl})? _focusedCount;

  void _attachCountField(Item item, TextEditingController ctrl) =>
      _focusedCount = (item: item, ctrl: ctrl);

  /// เลิกโฟกัส — controller ยังมีชีวิต snapshot จึงชี้ต่อได้
  void _blurCountField(TextEditingController ctrl) {
    if (identical(_focusedCount?.ctrl, ctrl)) _focusedCount = null;
  }

  /// การ์ดถูกยุบ/ถอดทิ้ง — ห้าม snapshot ชี้ controller ที่ dispose แล้ว
  /// (เขียน `.value` ลงไปจะโยน assert) แต่ยังต้องกู้ state + count_drafts ได้อยู่
  void _disposeCountField(TextEditingController ctrl) {
    _blurCountField(ctrl);
    final snap = _countSnapshot;
    if (snap != null && identical(snap.ctrl, ctrl)) {
      _countSnapshot = (
        item: snap.item,
        ctrl: null,
        text: snap.text,
        actor: snap.actor,
      );
    }
  }

  /// ค่าที่อยู่ในช่องจำนวน "ก่อน" อักขระตัวแรกของสายรัวจะรั่วลงไป
  ///
  /// [actor] ถูกจับ ณ วินาทีที่เก็บ snapshot ไม่ใช่ตอนกู้ — เส้นทาง [dispose]
  /// กู้ใน post-frame callback ซึ่งช้ากว่าการรีเซ็ต state ของ sign-out เสมอ
  /// (ดู [AppController.setScanCount])
  ({
    Item item,
    TextEditingController? ctrl,
    String text,
    CountActor actor,
  })? _countSnapshot;

  /// เงียบนานกว่านี้ = สายรัวตายกลางคัน · **อ่านจากบัฟเฟอร์** ไม่ตั้งเลขซ้ำที่นี่
  /// (ตั้งสองที่แล้วมันจะเบี่ยงจากกันเงียบ ๆ นาฬิกากู้ค่าจะยิงคนละจังหวะกับตอนที่
  ///  บัฟเฟอร์ทิ้งเศษรหัส แล้วเราจะกู้ทับสายที่ยังไหลอยู่ หรือกู้ช้าจนไม่ทันใครเลย)
  late final Duration _burstDeath = _handheld.idleReset;

  /// นาฬิกากู้ช่องจำนวนเมื่อสายรัวตายไปเฉย ๆ — null = ไม่มีอะไรค้างรอกู้
  Timer? _burstDeathTimer;

  void _snapshotCountField() {
    final f = _focusedCount;
    // ไม่มีช่องไหนโฟกัส = ไม่มีอะไรให้รั่วใส่ · ต้องล้างของเก่าทิ้งด้วย ไม่ใช่ปล่อยค้าง
    if (f == null) {
      _dropCountSnapshot();
      return;
    }
    // ⚠️ `_app.countActor` ต้องอ่าน **ที่นี่** ไม่ใช่ตอนกู้ — ตอนกู้ในเส้นทาง
    // [dispose] อาจไม่มีใครล็อกอินอยู่แล้ว (sign-out รีเซ็ต state ก่อนถอดจอ)
    _countSnapshot = (
      item: f.item,
      ctrl: f.ctrl,
      text: f.ctrl.text,
      actor: _app.countActor,
    );
  }

  /// ทิ้ง snapshot **พร้อมนาฬิกาที่ตั้งไว้กู้มัน** — ทางออกทางเดียวของทั้งคู่
  ///
  /// สองอย่างนี้ต้องตายพร้อมกันเสมอ ไม่งั้นจะเหลือ timer ที่ตื่นมาแล้วไม่มีอะไรให้กู้
  /// (ไม่พังทันที เพราะ [_restoreCountField] เช็ค null อยู่ แต่เป็นนัดที่ไม่มีใครยกเลิก)
  void _dropCountSnapshot() {
    _countSnapshot = null;
    _burstDeathTimer?.cancel();
    _burstDeathTimer = null;
  }

  /// ปิดบัญชี snapshot ที่ **ไม่มีใครมาปิดท้ายให้** — โหมดถูกสลับกลางสายรัว
  /// หรือจอถูกถอดทิ้งทั้งใบ
  ///
  /// ทิ้งเฉย ๆ ไม่ได้: อักขระตัวแรกของสายรัวไหลผ่าน `onChanged` ลง state และลง
  /// แถว count_drafts ตั้งแต่วินาทีที่มันรั่ว การทิ้ง snapshot จึงไม่ใช่ "ยกเลิก
  /// การกู้" แต่คือ **ยืนยันยอดที่เพี้ยน**: ช่องที่เคยเป็น 19 ค้างเป็น 198 ทั้ง
  /// บนจอ ใน AppState และใน SQLite แล้วถูกส่งขึ้น ERP ตามยอดนั้น
  ///
  /// ⚠️ ด่านเดียวกับ [_armBurstDeath] — ต้องมี**สายรัวที่พิสูจน์แล้ว**ถึงจะกู้
  /// คีย์ที่นิ้วคนแตะก็สั่ง snapshot เหมือนกัน (ตามดีไซน์) กู้มันคือถอยยอดที่
  /// พนักงานเพิ่งคีย์กลับเงียบ ๆ · พังหนักกว่าบั๊กที่กำลังแก้อยู่
  void _closeCountSnapshot({bool afterFrame = false}) {
    if (_handheld.inBurst) {
      // กู้แล้วมันเรียก _dropCountSnapshot ให้เองในตัว
      _restoreCountField(afterFrame: afterFrame);
    } else {
      _dropCountSnapshot();
    }
  }

  /// ตั้งนาฬิกากู้ช่องเผื่อสายรัวจบแบบ **ไม่มี Enter ปิดท้าย**
  ///
  /// Enter ท้ายรหัสเป็น suffix ที่ **ตั้งค่าได้** ของ S20 (BBSettings
  /// `BARCODE_MODE_SUFFIX` / parameter 501) ไม่ใช่คุณสมบัติติดตัวเครื่องยิง
  /// เครื่องที่ปิด suffix ไว้จะไม่มีคีย์ไหนมาบอกว่ารหัสจบเลย เส้นทางกู้ที่แขวนอยู่กับ
  /// `code != null` จึงไม่มีวันทำงาน แล้วอักขระตัวแรกที่รั่วจะค้างอยู่ทั้งบนจอ
  /// ใน state และในแถว count_drafts — บั๊กยอดเพี้ยนเดิมกลับมาทั้งดุ้นบนเครื่องรุ่นนั้น
  /// สัญญาณเดียวที่เหลือคือ **ความเงียบ**: ไม่มีคีย์ตามมาอีกภายใน [_burstDeath]
  ///
  /// ⚠️ ต้องมี **สายรัวที่พิสูจน์แล้ว** ไม่ใช่แค่มี snapshot — คีย์ที่นิ้วคนแตะก็สั่ง
  /// snapshot เหมือนกัน ถ้าตั้งนาฬิกาให้ด้วย พอคนหยุดพิมพ์ครบ 800ms ยอดที่เพิ่งคีย์
  /// จะถูกถอยกลับไปเป็นค่าก่อนหน้าเงียบ ๆ · พังหนักกว่าบั๊กที่กำลังแก้อยู่
  ///
  /// ไม่มีช่องไหนโฟกัส (เส้นทางปกติของการยิง) = ไม่มี snapshot = ไม่มีนาฬิกา
  void _armBurstDeath() {
    if (_countSnapshot == null || !_handheld.inBurst) return;
    _burstDeathTimer?.cancel(); // เลื่อนเส้นตายตามคีย์ล่าสุดเสมอ
    _burstDeathTimer = Timer(_burstDeath, _restoreCountField);
  }

  /// กู้ค่าที่เครื่องยิงพิมพ์แทรกทับช่องจำนวน
  ///
  /// ต้องเรียก [AppController.setScanCount] ซ้ำ ไม่ใช่แค่เขียน controller —
  /// อักขระที่รั่วไหลผ่าน `onChanged` ลง state และลงแถว count_drafts ไปแล้ว
  /// ถ้ากู้แค่ตัวหนังสือบนจอ ยอดเพี้ยนจะรอดอยู่ใน SQLite แล้วถูกส่งขึ้น ERP
  ///
  /// ลำดับสำคัญ: เขียน controller ก่อน แล้วค่อยเรียก `setScanCount` — `ref.listen`
  /// ของการ์ดจะยิง `_syncFromState` ทันทีที่ `counts` เปลี่ยน ถ้า controller ตรงอยู่
  /// แล้วมันจะคืนออกไปเฉย ๆ cursor จึงไม่กระโดด
  ///
  /// เข้าที่นี่ได้สี่ทาง — รหัสจบด้วย Enter · สายรัวเงียบไปเฉย ๆ
  /// ([_armBurstDeath]) · โหมดถูกสลับ · จอถูกถอดทิ้ง ([_closeCountSnapshot])
  /// — และทุกทางต้องซ่อมให้ครบทั้งสามชั้นเหมือนกัน จึงใช้ตัวเดียวกัน
  ///
  /// [afterFrame] = เลื่อนการเขียน AppState/SQLite ไปท้ายเฟรมนี้ · จำเป็นเฉพาะ
  /// เส้นทาง [dispose] ซึ่งวิ่งอยู่กลางเฟรมที่กำลัง build แท็บใหม่ riverpod กัน
  /// การเขียน provider ระหว่างนั้นไว้ ('Tried to modify a provider while the
  /// widget tree was building') — post-frame callback ของ**เฟรมเดียวกัน**คือ
  /// จังหวะแรกที่เขียนได้ ไม่ต้องรอเฟรมถัดไปที่อาจไม่มีวันมา
  void _restoreCountField({bool afterFrame = false}) {
    final snap = _countSnapshot;
    _dropCountSnapshot();
    if (snap == null) return;
    final ctrl = snap.ctrl;
    if (ctrl != null) {
      // ไม่มีอะไรรั่วลงไป — ไม่ต้องไปกวน state/SQLite ให้เสียเที่ยว
      if (ctrl.text == snap.text) return;
      ctrl.value = TextEditingValue(
        text: snap.text,
        selection: TextSelection.collapsed(offset: snap.text.length),
      );
    }
    // [_app] ไม่ใช่ `ref.read` — เส้นทางกู้ตอนจอถูกถอดทิ้งวิ่งผ่านที่นี่ด้วย
    // และ `actor` มาจาก snapshot ไม่ใช่ state ปัจจุบัน ด้วยเหตุผลเดียวกัน:
    // ตอนนี้อาจไม่มีใครล็อกอินอยู่แล้ว การซ่อมยอดต้องเข้าชื่อคนที่นับจริง
    void repair() => unawaited(
      _app.setScanCount(snap.item, snap.text, actor: snap.actor),
    );
    if (afterFrame) {
      WidgetsBinding.instance.addPostFrameCallback((_) => repair());
    } else {
      repair();
    }
  }

  /// คีย์จากเครื่องยิงบาร์โค้ด — จบรหัสเมื่อเจอ Enter แล้วส่งเข้าเส้นทางเดียวกับกล้อง
  ///
  /// ใช้ `_resolve` ตัวเดียวกับ `_onDetect` โดยตั้งใจ: สั่นก่อน แล้วค้นจาก replica
  /// ในเครื่อง — ยิงจาก handheld กับสแกนด้วยกล้องจึงให้ผลเหมือนกันทุกอย่าง
  ///
  /// คืน `handled` เฉพาะคีย์ที่อยู่ใน **สายรัว** ของเครื่องยิงเท่านั้น เพื่อกัน
  /// KeyboardManager.onUnhandled() (KeyboardManager.java:249-256) ส่งอักขระ
  /// ต่อให้ TextInputPlugin.handleKeyEvent() (TextInputPlugin.java:636-648)
  /// เรียก InputConnectionAdaptor.handleKeyEvent() พิมพ์ทับช่องที่โฟกัสอยู่
  ///
  /// ⚠️ **ห้ามกลืนเพราะ "บัฟเฟอร์รับคีย์นี้ไว้แล้ว"** — คีย์บอร์ดจอแบบตัวเลขของ
  /// Android ส่งเลขที่คนแตะผ่าน `InputConnection.sendKeyEvent()` ซึ่งวิ่งมาทาง
  /// `KeyboardManager` เส้นเดียวกับคีย์ฮาร์ดแวร์ กลืนแบบนั้นแล้วยอดที่พนักงาน
  /// กดจะหายเงียบ ๆ ทั้งที่จอไม่บอกอะไรเลย (ดู [HandheldScanBuffer.burstGap])
  ///
  /// อักขระ **ตัวแรก** ของทุกสายรัวไม่มีทางพิสูจน์ได้ว่ามาจากเครื่อง จึงต้องปล่อย
  /// ให้รั่วลงช่องที่โฟกัสอยู่แล้วกู้คืนทีหลัง ([_snapshotCountField] /
  /// [_restoreCountField]) — แลกตัวเลขกระพริบหนึ่งจังหวะ กับการไม่กลืนคีย์คน
  ///
  /// "ทีหลัง" มีสองจังหวะ ไม่ใช่จังหวะเดียว: Enter ปิดท้าย (มีก็ต่อเมื่อเครื่องตั้ง
  /// suffix ไว้) หรือสายรัวเงียบไปเฉย ๆ ([_armBurstDeath]) — ขาดอันหลังไป
  /// เครื่องที่ปิด suffix จะเหลืออักขระรั่วค้างถาวร
  KeyEventResult _onHandheldKey(FocusNode node, KeyEvent event) {
    // ปุ่มฮาร์ดแวร์ที่ผูกไว้มาก่อนบัฟเฟอร์เสมอ — ปุ่มที่ผูกได้ต้องไม่มี
    // `character` อยู่แล้ว (ด่านแรกของ `_refusalReason` ในจอผู้ดูแล) จึงไม่มีทาง
    // เป็นเนื้อรหัสบาร์โค้ดที่หายไป การเช็คก่อนแค่ทำให้เจตนาชัดกว่า
    final hotkey = ref.read(appProvider).scanModeHotkey;
    if (hotkey != null &&
        event is KeyDownEvent &&
        event.logicalKey.keyId == hotkey) {
      _handleHotkey();
      return KeyEventResult.handled;
    }
    // สถานะสายรัว **ก่อน** ป้อนคีย์ตัวนี้ — `feed` ล้าง `_burst` ทิ้งทันทีที่รหัสจบ
    // (สายรัวจบพร้อมรหัส) อ่านหลัง `feed` จะได้ false เสมอ ใช้เป็นด่านไม่ได้
    final wasInBurst = _handheld.inBurst;
    final result = _handheld.feed(event, now: handheldNow());
    if (result.snapshotNow) _snapshotCountField();
    if (result.code != null) {
      // ⚠️ ด่านเดียวกับอีกสามทางออก ([_armBurstDeath] / [_closeCountSnapshot]):
      // ต้องมา**จากสายรัวที่พิสูจน์แล้ว** ถึงจะกู้ · คนที่พิมพ์เลขลงช่องจำนวนแล้ว
      // กด Enter บนคีย์บอร์ดจริงก็ป้อนรหัสจบให้บัฟเฟอร์ได้เหมือนกัน กู้ตรงนั้นคือ
      // ถอยยอดที่พนักงานเพิ่งคีย์กลับเงียบ ๆ — พังหนักกว่าบั๊กที่กำลังกันอยู่
      // ทิ้ง snapshot แทน: ค่าที่อยู่ในช่องตอนนี้คือค่าที่คนตั้งใจ ไม่มีอะไรต้องถอน
      if (wasInBurst) {
        _restoreCountField(); // กู้ช่องก่อน แล้วค่อยเดินเส้นทางสแกนปกติ
      } else {
        _dropCountSnapshot();
      }
      _resolve(result.code!, source: _ScanSource.handheld);
    } else {
      _armBurstDeath(); // เผื่อรหัสนี้จบแบบไม่มี Enter มาปิดท้าย
    }
    if (!_swallowScannerKeys) return KeyEventResult.ignored; // สวิตช์ย้อนกลับ
    return result.swallow ? KeyEventResult.handled : KeyEventResult.ignored;
  }

  /// เวลาที่โหมดถูกสลับล่าสุด — ด่านกันสั่งรัว
  DateTime? _lastModeSwitchAt;

  /// กันทั้งหน้าสัมผัสของปุ่มฮาร์ดแวร์ที่เด้งซ้ำ **และ** นิ้วที่รัวบนแถบสลับโหมด
  ///
  /// ทุกครั้งที่สลับคือคำสั่งเปิด/ปิดกล้องจริงหนึ่งชุด กดเร็วกว่าที่ native ทำเสร็จ
  /// ไม่ได้ช่วยอะไร มีแต่ทำให้ต้องไล่สถานะย้อนไปมา (ดู [_setCamera])
  static const Duration _modeSwitchCooldown = Duration(milliseconds: 300);

  /// สลับโหมดสแกน — ปลายทางเดียวกันทั้งการแตะแถบและการกดปุ่มฮาร์ดแวร์
  ///
  /// [fromHardware] ต่างกันแค่ toast: คนที่แตะแถบเห็นปุ่มเปลี่ยนสีอยู่แล้ว
  /// แต่คนที่กดปุ่มข้างเครื่องอาจไม่ได้มองจอ ต้องบอกให้รู้ว่าโหมดเปลี่ยนไปแล้ว
  void _switchMode(ScanMode mode, {required bool fromHardware}) {
    final controller = ref.read(appProvider.notifier);
    if (ref.read(appProvider).scanMode == mode) return;
    final now = DateTime.now();
    final last = _lastModeSwitchAt;
    if (last != null && now.difference(last) < _modeSwitchCooldown) return;
    _lastModeSwitchAt = now;
    controller.setScanMode(mode);
    HapticFeedback.selectionClick(); // ต่างจาก mediumImpact ของการสแกน
    if (fromHardware) {
      controller.flash(
        mode == ScanMode.handheld
            ? 'โหมดเครื่องยิง · handheld'
            : 'โหมดกล้อง · camera',
      );
    }
  }

  /// ปุ่มฮาร์ดแวร์ที่ผูกไว้ = สลับไปมาระหว่างสองโหมด (ไม่ใช่เลือกโหมดตายตัว)
  /// คูลดาวน์อยู่ที่ [_switchMode] ที่เดียว — แถบกับปุ่มใช้ด่านเดียวกัน
  void _handleHotkey() {
    final current = ref.read(appProvider).scanMode;
    _switchMode(
      current == ScanMode.handheld ? ScanMode.camera : ScanMode.handheld,
      fromHardware: true,
    );
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

              // เส้นเลเซอร์กวาดขึ้นลงระหว่างกรอบมุม — เกทด้วย `camOn` ไม่ใช่
              // โหมด: โหมดเครื่องยิงบังคับ `camOn=false` อยู่แล้ว และเลเซอร์ที่
              // กวาดตอนกล้องยังปิด (ก่อนแตะ FAB) ก็โกหกมาตั้งแต่ก่อนหน้านี้
              if (state.camOn) _SweepLine(frameWidth: w, frameHeight: h),

              // กรอบมุม 4 ชิ้น (ขอบเขตเดียวกับ scanWindow) — ภาษาของโหมดกล้อง
              if (state.scanMode == ScanMode.camera)
                Positioned.fromRect(
                  rect: roi,
                  child: const IgnorePointer(
                    child: CustomPaint(painter: _CornerBracketsPainter()),
                  ),
                ),

              // hero กลางกรอบแทนเลเซอร์/กรอบมุมที่หายไปในโหมดเครื่องยิง
              if (state.scanMode == ScanMode.handheld)
                const IgnorePointer(child: Center(child: _HandheldHero())),

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
                    // โหมดเครื่องยิงไม่มีปุ่มกล้องเลย (ไม่ใช่แค่ดับ glow) —
                    // แถบสลับโหมดต้องเป็นแหล่งความจริงเดียวว่าใช้ตัวไหนอยู่
                    if (state.scanMode == ScanMode.camera) ...[
                      _GlowRing(
                        active: !state.camOn,
                        child: _CamFab(
                          semanticLabel: 'กล้อง',
                          painter: const _CameraIconPainter(),
                          onTap: () => controller.setCamOn(!state.camOn),
                        ),
                      ),
                      const SizedBox(height: _fabGap),
                    ],
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

  // ── B. แถบสลับโหมดสแกน ────────────────────────────────────────────

  /// สวิตช์ 2 ช่องเต็มความกว้างระหว่างกรอบกล้องกับแถบเครื่องมือ
  ///
  /// ใช้ภาษาเดียวกับแถบแท็บล่างและแท็บจอผู้ดูแล (`s09` / `activeTabGradient`)
  /// ไม่คิดคำศัพท์ภาพใหม่ให้ผู้ใช้ต้องเรียนเพิ่ม
  Widget _modeBand(AppState state) => Padding(
    padding: const EdgeInsets.fromLTRB(
      TclTokens.gutterTab,
      _modeBandTop,
      TclTokens.gutterTab,
      0,
    ),
    child: Container(
      padding: const EdgeInsets.all(_modeSwitchPad),
      decoration: BoxDecoration(
        color: TclTokens.s09,
        border: Border.all(color: TclTokens.b13),
        borderRadius: BorderRadius.circular(TclTokens.rTabBar),
      ),
      child: Row(
        children: [
          for (final mode in ScanMode.values) ...[
            if (mode.index > 0) const SizedBox(width: _modeSwitchPad),
            Expanded(
              child: _ModeButton(
                mode: mode,
                active: mode == state.scanMode,
                onTap: () => _switchMode(mode, fromHardware: false),
              ),
            ),
          ],
        ],
      ),
    ),
  );

  // ── C. แถบเครื่องมือ ──────────────────────────────────────────────

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

  // ── D. รายการผลสแกน ──────────────────────────────────────────────

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
// แถบสลับโหมดสแกน + hero ของโหมดเครื่องยิง
// ════════════════════════════════════════════════════════════════════

/// ปุ่ม 1 ช่องของแถบสลับโหมด — โครงเดียวกับ `_ViewButton` ของจอผู้ดูแล
/// (สูง 38 · `rTabButton` · `activeTabGradient` · `onAccent`/`tMuted`)
/// บวกไอคอนนำหน้าข้อความเพื่อให้อ่านออกโดยไม่ต้องอ่านตัวหนังสือ
class _ModeButton extends StatelessWidget {
  const _ModeButton({
    required this.mode,
    required this.active,
    required this.onTap,
  });

  final ScanMode mode;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = active ? TclTokens.onAccent : TclTokens.tMuted;
    return Semantics(
      button: true,
      selected: active,
      label: 'โหมด${mode.label}',
      child: Tappable(
        onTap: onTap,
        radius: TclTokens.rTabButton,
        child: Container(
          height: _modeButtonHeight,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: active ? TclTokens.activeTabGradient : null,
            borderRadius: BorderRadius.circular(TclTokens.rTabButton),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              StrokeIcon(
                painter: switch (mode) {
                  ScanMode.handheld => _HandheldIconPainter(color: fg),
                  ScanMode.camera => _CameraIconPainter(color: fg),
                },
                size: _modeIconSize,
                color: fg,
              ),
              const SizedBox(width: _modeIconGap),
              // ตัวอักษรย่อได้เมื่อจอแคบ/ตัวอักษรใหญ่ — ปุ่มต้องไม่ล้นแถว
              // `ExcludeSemantics` กันไม่ให้ป้ายซ้ำกับ label ของปุ่ม
              // (ไม่งั้นโปรแกรมอ่านหน้าจออ่านว่า "โหมดเครื่องยิง เครื่องยิง")
              Flexible(
                child: ExcludeSemantics(
                  child: Text(
                    mode.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TclTokens.thai(
                      size: 13,
                      weight: FontWeight.w600,
                      color: fg,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// กลางกรอบกล้องตอนโหมดเครื่องยิง — กรอบยังอยู่เพราะป้ายสถานะอยู่ในนั้น
/// แต่ต้องบอกความจริงว่าไม่มีกล้องทำงาน มีแต่เครื่องยิงที่พร้อมอยู่
class _HandheldHero extends StatelessWidget {
  const _HandheldHero();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: _camPillInset),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const StrokeIcon(
          painter: _HandheldIconPainter(color: TclTokens.accentBright),
          size: _heroIconSize,
          color: TclTokens.accentBright,
        ),
        const SizedBox(height: _heroGap),
        Text(
          'ยิงบาร์โค้ดได้เลย',
          textAlign: TextAlign.center,
          style: TclTokens.itemName(),
        ),
        Text(
          'เล็งฉลากแล้วเหนี่ยวไก — ไม่ต้องแตะจอ',
          textAlign: TextAlign.center,
          style: TclTokens.caption(TclTokens.tSoft),
        ),
      ],
    ),
  );
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

  /// จอสแกนที่ครอบการ์ดใบนี้อยู่ — ปลายทางของ snapshot/restore ช่องจำนวน
  /// (การ์ดอยู่ใต้ `Focus` ของจอเสมอ เดินขึ้นไปหาครั้งเดียวตอนกางการ์ด)
  _ScanScreenState? _screen;

  @override
  void initState() {
    super.initState();
    // กางการ์ดใหม่ต้องเห็นยอดที่เคยคีย์ไว้ (รวมที่ hydrate มาจาก SQLite)
    _ctrl = TextEditingController(
      text: ref.read(appProvider).counts[widget.item.sku] ?? '',
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _screen = context.findAncestorStateOfType<_ScanScreenState>();
  }

  @override
  void dispose() {
    _screen?._disposeCountField(_ctrl); // ต้องมาก่อน _ctrl.dispose() เสมอ
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
          // จอต้องรู้ว่าอักขระตัวแรกของสายรัวจะไปตกช่องไหน ถึงจะกู้คืนได้ทัน
          onFocusChange: (f) {
            setState(() => _focused = f);
            if (f) {
              _screen?._attachCountField(item, _ctrl);
            } else {
              _screen?._blurCountField(_ctrl);
            }
          },
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
///
/// [color] เปลี่ยนได้เพราะไอคอนนี้ถูกใช้บนแถบสลับโหมดที่พื้นหลังสลับสีด้วย
/// (ค่าเริ่มต้นคือสีเดิมของ FAB — จุดเรียกเดิมไม่ต้องแก้)
class _CameraIconPainter extends CustomPainter {
  const _CameraIconPainter({this.color = TclTokens.tBody});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
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
  bool shouldRepaint(_CameraIconPainter old) => old.color != color;
}

/// ไอคอนเครื่องยิงบาร์โค้ด — แท่งแนวตั้งความกว้างสลับกัน (viewBox 24×24)
///
/// ภาษาเดียวกับ `_BarcodeMarkPainter` ของโลโก้: เส้นตรงล้วน ไม่มีตัวเครื่อง
/// ที่ทำให้ไอคอนขนาด 16px กลายเป็นก้อนอ่านไม่ออก
class _HandheldIconPainter extends CustomPainter {
  const _HandheldIconPainter({this.color = TclTokens.tBody});

  final Color color;

  /// (x ในพิกัด viewBox, ความหนาแท่ง) — สลับบาง/หนาให้อ่านออกว่าเป็นบาร์โค้ด
  static const List<(double, double)> _bars = [
    (4.5, 1.7),
    (8.0, 3.0),
    (11.5, 1.7),
    (15.0, 3.0),
    (19.5, 1.7),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..color = color;
    canvas
      ..save()
      ..scale(size.width / 24, size.height / 24);
    for (final (x, stroke) in _bars) {
      paint.strokeWidth = stroke;
      canvas.drawLine(Offset(x, 6), Offset(x, 18), paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_HandheldIconPainter old) => old.color != color;
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
