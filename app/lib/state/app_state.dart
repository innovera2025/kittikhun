import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api_client.dart';
import '../data/auth_repository.dart';
import '../data/fixtures.dart';
import '../data/models.dart';
import '../data/stock_repository.dart';
import '../local/local_db.dart';
import '../local/sync_engine.dart';

/// คนที่ลงมือนับ + คลังที่เขาสังกัด — สองคอลัมน์หลักฐานของแถว count_drafts
///
/// จับเป็นก้อนเดียวเพราะทั้งคู่มาจาก session เดียวกันเสมอ และต้องเดินทางไปด้วยกัน
/// เมื่อการเขียนลงเครื่องเกิด**หลัง**ที่ session นั้นจบไปแล้ว (ดู
/// [AppController.setScanCount])
typedef CountActor = ({String empId, String? warehouseCode});

/// สถานะทั้งแอป — พฤติกรรมทุกอย่างตรงตาม design ต้นแบบ
///
/// หมายเหตุ production (ต่างจาก demo โดยเจตนา — ดู docs/design-fidelity.md §6):
/// - ไม่มี PIN กลาง `000000` และ **ปฏิเสธ PIN ว่างเสมอ**
/// - ไม่เติม empId ล่วงหน้า
/// - sign-out เคลียร์ค่าที่กรอกไว้ (เครื่องใช้ร่วมกัน)
@immutable
class AppState {
  const AppState({
    this.signedIn = false,
    this.tab = AppTab.scan,
    this.empId = '',
    this.pin = '',
    this.loginError = false,
    this.loginMessage = 'กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน',
    this.members = Fixtures.members,
    this.currentEmpId,
    this.scans = const [],
    this.expandedSku,
    this.camOn = false,
    this.camStatus = CamStatus.offInitial,
    this.camStatusOverride,
    this.query = '',
    this.counts = const {},
    this.toast,
    this.addSheetOpen = false,
    this.newName = '',
    this.newId = '',
    this.newRole = Role.staff,
    this.busy = false,
    this.mustChangePin = false,
    this.lastInitialPin,
    this.session,
    this.searchHits,
    this.scannedItems = const {},
    this.warehouseCode,
    this.drafts = const {},
    this.scanMode = ScanMode.handheld,
    this.scanModeHotkey,
  });

  final bool signedIn;
  final AppTab tab;

  // ── login ──────────────────────────────────────────────────────────
  final String empId;
  final String pin;
  final bool loginError;
  final String loginMessage;

  // ── ผู้ใช้และสมาชิก ─────────────────────────────────────────────────
  final List<Member> members;
  final String? currentEmpId;

  /// คลังของผู้ใช้ที่ล็อกอินอยู่ (`user.warehouseCode` จาก `/auth/login`)
  ///
  /// ⚠️ เคยไม่มีฟิลด์นี้ หัวจอจึงอ่าน `Fixtures.heads` ที่ฝัง 'WH-BKK-02' ไว้ตายตัว
  ///    ทำให้แอปที่ต่อคลัง WHFG จริงยังขึ้นชื่อคลังตัวอย่าง — พนักงานเข้าใจผิดว่านับผิดคลังได้
  final String? warehouseCode;

  // ── สแกน ───────────────────────────────────────────────────────────
  final List<ScanRecord> scans;
  final String? expandedSku;
  final bool camOn;
  final CamStatus camStatus;

  /// ข้อความสถานะกล้องแบบเจาะจง (เช่น 'ไม่พบรหัส 123', 'พบสินค้า · SKU-1')
  final String? camStatusOverride;

  // ── ค้นหา ──────────────────────────────────────────────────────────
  final String query;

  // ── นับสต็อก ────────────────────────────────────────────────────────
  /// sku → ค่าที่กรอก (string ตัวเลขล้วน; '' = ยังไม่ได้นับ)
  final Map<String, String> counts;

  // ── UI ทั่วไป ───────────────────────────────────────────────────────
  final String? toast;
  final bool addSheetOpen;
  final String newName;
  final String newId;
  final Role newRole;

  /// กำลังรอ backend (ปิดปุ่มกันกดซ้ำ)
  final bool busy;

  /// ต้องตั้ง PIN ใหม่ก่อนใช้งาน (PIN เริ่มต้นจาก admin หรือถูก reset)
  final bool mustChangePin;

  /// PIN เริ่มต้นของสมาชิกที่เพิ่งเพิ่ม — แสดงให้ admin เห็น **ครั้งเดียว**
  /// ⚠️ อยู่ใน memory เท่านั้น ห้ามเก็บลง storage ห้าม log
  final ({String empId, String name, String pin})? lastInitialPin;

  /// รอบนับที่ดึงมาเก็บในเครื่อง (นับต่อได้แม้ออฟไลน์) — null = ยังไม่มีรอบเปิด
  final ActiveSession? session;

  /// ผลค้นหาจาก replica ในเครื่อง (โหมดต่อ backend) — null = ยังไม่ได้ค้น
  final List<Item>? searchHits;

  /// รายการที่สแกนได้ พร้อมข้อมูลสินค้าจาก replica (โหมดต่อ backend)
  final Map<String, Item> scannedItems;

  /// ⭐ บรรทัดที่คีย์ไว้แต่ยังไม่กดส่งเข้าเอกสาร (sku → แถวใน `count_drafts`)
  ///
  /// เป็นเงาของตาราง SQLite เพื่อให้จอวาดได้โดยไม่ต้อง await ทุกเฟรม
  /// **ตัวจริงคือแถวในเครื่อง** — state นี้ถูกเติมใหม่จาก [AppController.loadDrafts]
  /// ทุกครั้งที่ sign-in จึงรอดการปิดแอป/สลับกะ
  final Map<String, CountDraftRow> drafts;

  /// โหมดสแกนของเครื่องนี้ (R1/R2) — ค่าคงที่ handheld ไม่ต้องอ่านดิสก์
  final ScanMode scanMode;

  /// LogicalKeyboardKey.keyId ที่ผูกกับการสลับโหมด — null = ยังไม่ได้ผูก (R4)
  final int? scanModeHotkey;

  // ── derived ────────────────────────────────────────────────────────

  /// ผู้ใช้ปัจจุบัน (fallback = คนแรกในรายชื่อ ตาม design)
  Member get me => members.firstWhere(
        (m) => m.empId == currentEmpId,
        orElse: () => members.first,
      );

  /// ข้อความบนป้ายสถานะในกรอบสแกน — ป้ายนี้มีอยู่ทั้งสองโหมด
  ///
  /// ⚠️ โหมดเครื่องยิงกลบ `camStatus` ด้วย 'พร้อมยิงบาร์โค้ด' ได้เฉพาะตอนที่
  /// กล้อง**ไม่ได้ขัดข้อง** เท่านั้น (ดู [CamStatus.isFailure]) — เดิมกลบทั้งก้อน
  /// กล้องที่สั่งปิดไม่ลงจึงเงียบสนิทในโหมดที่ไม่มีปุ่มกล้องเหลือบนจอเลย
  /// `camOn` บอกว่าปิดแล้วสวนทางกับฮาร์ดแวร์ที่ยังยึดเซ็นเซอร์อยู่ โดยไม่มีอะไร
  /// บอกผู้ใช้สักอย่าง
  String get camStatusText =>
      camStatusOverride ??
      (scanMode == ScanMode.handheld && !camStatus.isFailure
          ? CamStatus.handheldReady.text
          : camStatus.text);

  bool get hasScans => scans.isNotEmpty;

  /// จำนวนรายการที่กรอกค่าแล้วในรอบนับ
  ///
  /// ⚠️ เดิมนับจาก `Fixtures.countRows` เสมอ → ตัวเลข "นับแล้ว x/y" ไม่ตรงกับ
  ///    รอบจริง และยังนับต่อได้ทั้งที่ไม่มีรอบเปิดอยู่
  int get countedRows => (session?.rows ?? const <CountRow>[])
      .where((r) => (counts[r.sku] ?? '').isNotEmpty)
      .length;

  /// จำนวนบรรทัดที่คีย์ไว้แต่ยังไม่ได้ส่งเข้าเอกสาร — แถบเตือนใต้ header อ่านค่านี้
  int get draftCount => drafts.length;

  AppState copyWith({
    bool? signedIn,
    AppTab? tab,
    String? empId,
    String? pin,
    bool? loginError,
    String? loginMessage,
    List<Member>? members,
    String? currentEmpId,
    List<ScanRecord>? scans,
    String? expandedSku,
    bool clearExpanded = false,
    bool? camOn,
    CamStatus? camStatus,
    String? camStatusOverride,
    bool clearCamOverride = false,
    String? query,
    Map<String, String>? counts,
    String? toast,
    bool clearToast = false,
    bool? addSheetOpen,
    String? newName,
    String? newId,
    Role? newRole,
    bool? busy,
    bool? mustChangePin,
    ({String empId, String name, String pin})? lastInitialPin,
    bool clearInitialPin = false,
    ActiveSession? session,
    bool clearSession = false,
    List<Item>? searchHits,
    Map<String, Item>? scannedItems,
    String? warehouseCode,
    Map<String, CountDraftRow>? drafts,
    ScanMode? scanMode,
    int? scanModeHotkey,
    bool clearScanModeHotkey = false,
  }) => AppState(
    signedIn: signedIn ?? this.signedIn,
    tab: tab ?? this.tab,
    empId: empId ?? this.empId,
    pin: pin ?? this.pin,
    loginError: loginError ?? this.loginError,
    loginMessage: loginMessage ?? this.loginMessage,
    members: members ?? this.members,
    currentEmpId: currentEmpId ?? this.currentEmpId,
    scans: scans ?? this.scans,
    expandedSku: clearExpanded ? null : (expandedSku ?? this.expandedSku),
    camOn: camOn ?? this.camOn,
    camStatus: camStatus ?? this.camStatus,
    camStatusOverride:
        clearCamOverride ? null : (camStatusOverride ?? this.camStatusOverride),
    query: query ?? this.query,
    counts: counts ?? this.counts,
    toast: clearToast ? null : (toast ?? this.toast),
    addSheetOpen: addSheetOpen ?? this.addSheetOpen,
    newName: newName ?? this.newName,
    newId: newId ?? this.newId,
    newRole: newRole ?? this.newRole,
    busy: busy ?? this.busy,
    mustChangePin: mustChangePin ?? this.mustChangePin,
    lastInitialPin:
        clearInitialPin ? null : (lastInitialPin ?? this.lastInitialPin),
    session: clearSession ? null : (session ?? this.session),
    searchHits: searchHits ?? this.searchHits,
    scannedItems: scannedItems ?? this.scannedItems,
    warehouseCode: warehouseCode ?? this.warehouseCode,
    drafts: drafts ?? this.drafts,
    scanMode: scanMode ?? this.scanMode,
    scanModeHotkey:
        clearScanModeHotkey ? null : (scanModeHotkey ?? this.scanModeHotkey),
  );
}

class AppController extends Notifier<AppState> {
  @override
  AppState build() => const AppState();

  // ══════════════════════════════════════════════════════════════════
  // Login
  // ══════════════════════════════════════════════════════════════════

  /// รับเฉพาะตัวเลข สูงสุด 6 หลัก · กดแล้วล้าง error
  void setEmpId(String v) {
    final digits = v.replaceAll(RegExp(r'[^0-9]'), '');
    state = state.copyWith(
      empId: digits.length > 6 ? digits.substring(0, 6) : digits,
      loginError: false,
    );
  }

  /// keypad: '1'-'9', '0', 'C' (ล้าง), '⌫' (ลบตัวท้าย)
  void pressKey(String key) {
    final pin = switch (key) {
      'C' => '',
      '⌫' => state.pin.isEmpty ? '' : state.pin.substring(0, state.pin.length - 1),
      _ => (state.pin + key).length > 6 ? state.pin : state.pin + key,
    };
    state = state.copyWith(pin: pin, loginError: false);
  }

  /// เข้าสู่ระบบ
  ///
  /// ตั้ง `--dart-define=API_BASE_URL=...` → เรียก backend จริง
  /// ไม่ตั้ง → โหมด fixture สำหรับพัฒนา/ดู UI (ไม่มี PIN กลาง ยังต้องกรอกครบ 6 หลัก)
  ///
  /// ⚠️ ต่างจาก demo: PIN ว่างถูกปฏิเสธเสมอ
  Future<void> signIn() async {
    if (state.busy) return;

    // ลำดับการตรวจตาม design: รหัสพนักงานก่อน แล้วค่อย PIN
    if (state.empId.isEmpty) {
      state = state.copyWith(
        loginError: true,
        loginMessage: 'ไม่พบรหัสพนักงานนี้ · unknown employee ID',
      );
      return;
    }

    if (!ApiConfig.isConfigured) {
      await _signInWithFixtures();
      return;
    }

    // โหมดต่อ backend: ต้องมี PIN ครบก่อนยิง API (server ตรวจรหัสพนักงานให้)
    if (state.pin.length < 6) {
      state = state.copyWith(
        loginError: true,
        loginMessage: 'กรอก PIN ให้ครบ 6 หลัก',
      );
      return;
    }

    state = state.copyWith(busy: true, loginError: false);
    try {
      final result = await ref
          .read(authRepositoryProvider)
          .login(empId: state.empId, pin: state.pin);
      // ดึง roster หลัง login (ล้มเหลวไม่ควรบล็อกการเข้าใช้งาน)
      final members = await _fetchMembers(fallback: [result.user.toMember()]);
      // เริ่มซิงค์: ดึง item master + รอบนับลงเครื่อง แล้วเฝ้าสัญญาณเพื่อ drain คิว
      final engine = ref.read(syncEngineProvider);
      engine.start();
      await engine.syncAll();
      await loadSession();
      // ยอดที่กะก่อนคีย์ค้างไว้ต้องโผล่กลับมาเองทั้งบนแถบเตือนและในช่องกรอก
      // (ไม่ hydrate = พนักงานคีย์ซ้ำทั้งชุดโดยไม่รู้ว่าของเดิมยังอยู่)
      await loadDrafts();
      final prefs = await _loadScanPrefs();
      state = state.copyWith(
        signedIn: true,
        tab: AppTab.scan,
        currentEmpId: result.user.empId,
        warehouseCode: result.user.warehouseCode,
        members: members,
        mustChangePin: result.mustChangePin,
        pin: '',
        loginError: false,
        busy: false,
        loginMessage: 'กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน',
        scanMode: prefs.mode,
        scanModeHotkey: prefs.hotkey,
      );
    } on ApiException catch (e) {
      state = state.copyWith(
        busy: false,
        pin: e.code == ApiException.codeInvalidPin ? '' : state.pin,
        loginError: true,
        loginMessage: e.message,
      );
    }
  }

  /// โหมดพัฒนา — ตรวจกับรายชื่อ fixture (ไม่มี backend)
  ///
  /// hydrate โหมดสแกนเหมือนแขนงต่อ backend ทุกประการ — `localDbProvider`
  /// เปิดไฟล์ sqlite จริงเสมอไม่ว่าโหมดไหน (ดู [setScanCount] ที่อ่าน db
  /// โดยไม่มี `ApiConfig.isConfigured` guard อยู่แล้ว) จึงไม่มี "fixture mode
  /// ที่ไม่แตะ DB" ให้ต้องกันเป็นกรณีพิเศษ
  Future<void> _signInWithFixtures() async {
    final found =
        state.members.where((m) => m.empId == state.empId).firstOrNull;
    if (found == null) {
      state = state.copyWith(
        loginError: true,
        loginMessage: 'ไม่พบรหัสพนักงานนี้ · unknown employee ID',
      );
      return;
    }
    if (state.pin.length < 6) {
      state = state.copyWith(
        loginError: true,
        loginMessage: 'กรอก PIN ให้ครบ 6 หลัก',
      );
      return;
    }
    final prefs = await _loadScanPrefs();
    state = state.copyWith(
      signedIn: true,
      tab: AppTab.scan,
      currentEmpId: found.empId,
      pin: '',
      loginError: false,
      loginMessage: 'กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน',
      scanMode: prefs.mode,
      scanModeHotkey: prefs.hotkey,
    );
  }

  Future<List<Member>> _fetchMembers({required List<Member> fallback}) async {
    try {
      final list = await ref.read(membersRepositoryProvider).list();
      return list.isEmpty ? fallback : list;
    } on ApiException {
      return fallback;
    }
  }

  /// ตั้ง PIN ใหม่สำเร็จแล้ว — ปลดสถานะบังคับเปลี่ยน
  void pinChanged() => state = state.copyWith(mustChangePin: false);

  /// ออกจากระบบ — reset ตาม design + เคลียร์ค่าที่กรอกของ user เดิม
  ///
  /// ⚠️ ไม่แตะคิวงานที่ยังไม่ซิงค์ (เฟสถัดไป) — งานนับต้องอยู่รอดการ sign-out
  ///
  /// โหมดสแกนและปุ่มที่ผูกไว้เป็น**คุณสมบัติของเครื่อง** ไม่ใช่ของผู้ใช้คนใดคนหนึ่ง
  /// (เครื่องคลังใช้ร่วมกันหลายกะ) กะถัดไปที่ล็อกอินไม่ควรต้องตั้งโหมด/ผูกปุ่มใหม่
  /// จึงยกเว้นไว้เหมือน `members`
  Future<void> signOut() async {
    if (ApiConfig.isConfigured) {
      // หยุดเฝ้าสัญญาณ แต่ **ห้ามลบ outbox** — งานนับที่ยังไม่ซิงค์ต้องอยู่รอด
      ref.read(syncEngineProvider).stop();
      // clear token ให้สำเร็จแม้ request ล้มเหลว (repository จัดการแล้ว)
      await ref.read(authRepositoryProvider).logout();
    }
    state = AppState(
      members: state.members,
      scanMode: state.scanMode,
      scanModeHotkey: state.scanModeHotkey,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // แท็บ
  // ══════════════════════════════════════════════════════════════════

  void goTab(AppTab tab) => state = state.copyWith(tab: tab);

  // ══════════════════════════════════════════════════════════════════
  // กล้องและการสแกน
  // ══════════════════════════════════════════════════════════════════

  void setCamOn(bool on) => state = state.copyWith(
        camOn: on,
        camStatus: on ? CamStatus.scanning : CamStatus.offToggled,
        clearCamOverride: true,
      );

  void setCamStatus(CamStatus s) =>
      state = state.copyWith(camStatus: s, clearCamOverride: true);

  /// สลับโหมดสแกน — HANDHELD บังคับปิดกล้อง (R4 ต้องไม่มีทางเปิดกล้อง/ขอ
  /// permission จากการกดพลาดของปุ่มฮาร์ดแวร์) CAMERA แค่คืนสถานะให้ตรงความจริง
  /// โดยไม่เปิดกล้องเอง (ผู้ใช้แตะ FAB เอง)
  void setScanMode(ScanMode mode) {
    if (state.scanMode == mode) return;
    state = state.copyWith(scanMode: mode);
    if (mode == ScanMode.handheld) {
      setCamOn(false); // เขียน camStatus ทับ (setCamOn) — ไม่เป็นไร: camStatusText
      //                  มองข้าม `offToggled` เมื่อ scanMode == handheld อยู่แล้ว
      //                  (สถานะ**ขัดข้อง**ที่ _reportCameraFailure เขียนทีหลัง
      //                   ไม่ถูกมองข้าม — ดู CamStatus.isFailure)
    } else {
      setCamStatus(CamStatus.offInitial);
    }
    unawaited(_persistScanMode(mode));
  }

  Future<void> _persistScanMode(ScanMode mode) async {
    try {
      await ref.read(localDbProvider).setMeta(MetaKeys.scanMode, mode.name);
    } on Object catch (e) {
      debugPrint('TCL: บันทึกโหมดสแกนไม่สำเร็จ — $e');
    }
  }

  /// ผูกปุ่มฮาร์ดแวร์เข้ากับการสลับโหมด — เรียกจาก admin pane เท่านั้น
  /// (ด่านปฏิเสธ denylist/burst/character/enter อยู่ที่ผู้เรียก ไม่ใช่ที่นี่ —
  /// ที่นี่รับผิดชอบแค่ "จำค่า" ไม่ตัดสินว่าปุ่มไหนควรผูกได้)
  void bindScanModeHotkey(int keyId) {
    state = state.copyWith(scanModeHotkey: keyId);
    unawaited(_persistHotkey(keyId));
  }

  void clearScanModeHotkey() {
    state = state.copyWith(clearScanModeHotkey: true);
    unawaited(_persistHotkey(null));
  }

  Future<void> _persistHotkey(int? keyId) async {
    try {
      await ref.read(localDbProvider).setMeta(
            MetaKeys.scanModeHotkey,
            keyId?.toString() ?? '',
          );
    } on Object catch (e) {
      debugPrint('TCL: บันทึกปุ่มสลับโหมดไม่สำเร็จ — $e');
    }
  }

  /// อ่านบาร์โค้ดจาก **replica ในเครื่อง** (ออฟไลน์ได้) + บันทึก scan_event เป็น audit
  ///
  /// โหมด fixture (ไม่ตั้ง API_BASE_URL) จะ fallback ไป [resolveCode]
  Future<bool> resolveCodeAsync(String code) async {
    if (!ApiConfig.isConfigured) return resolveCode(code);

    final db = ref.read(localDbProvider);
    final item = await db.itemByBarcode(code);
    // บันทึกทุกครั้งที่ decode ได้ ทั้งเจอและไม่เจอ (ฉลากไม่ตรงต้องตรวจย้อนได้)
    await db.enqueueScanEvent(barcode: code, sku: item?.sku);

    if (item == null) {
      state = state.copyWith(camStatusOverride: 'ไม่พบรหัส $code');
      flash('ไม่พบบาร์โค้ดนี้ในคลัง · not found');
      return false;
    }
    state = state.copyWith(
      scannedItems: {...state.scannedItems, item.sku: item},
    );
    addScan(item.sku);
    return true;
  }

  /// ข้อมูลสินค้าที่ใช้แสดงในการ์ด — replica ก่อน แล้วค่อย fixture
  ///
  /// 🚫 ต่อ backend จริงแล้วห้ามหล่นไปข้อมูลตัวอย่างเด็ดขาด
  ///    ของปลอมที่หน้าตาเหมือนของจริงทำให้พนักงานนับผิดตัวโดยไม่รู้
  Item? itemFor(String sku) {
    final hit = state.scannedItems[sku];
    if (hit != null) return hit;
    if (ApiConfig.isConfigured) return null;
    return Fixtures.items.where((i) => i.sku == sku).firstOrNull;
  }

  /// ผลการอ่านบาร์โค้ด — ทั้งเจอและไม่เจอต้องสั่น (จัดการที่ UI)
  ///
  /// คืนค่า true เมื่อพบสินค้า
  bool resolveCode(String code) {
    final item = Fixtures.items
        .where((i) => i.barcodes.contains(code) || i.sku == code)
        .firstOrNull;
    if (item == null) {
      state = state.copyWith(camStatusOverride: 'ไม่พบรหัส $code');
      flash('ไม่พบบาร์โค้ดนี้ในคลัง · not found');
      return false;
    }
    addScan(item.sku);
    return true;
  }

  /// เพิ่มรายการสแกน — สแกนซ้ำ = ลบของเดิมแล้วเด้งขึ้นบนพร้อมเวลาใหม่
  void addScan(String sku, {String note = 'พบสินค้า'}) {
    final now = DateTime.now();
    final stamp =
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    state = state.copyWith(
      camStatusOverride: '$note · $sku',
      scans: [
        ScanRecord(sku: sku, at: stamp),
        ...state.scans.where((s) => s.sku != sku),
      ],
    );
  }

  /// เปิด/ปิดการ์ด — เปิดได้ทีละใบ
  void toggleExpanded(String sku) => state.expandedSku == sku
      ? state = state.copyWith(clearExpanded: true)
      : state = state.copyWith(expandedSku: sku);

  /// นำการ์ดออกจากรายการสแกน
  ///
  /// 🚫 **ห้ามแตะ `count_drafts`** — ลิสต์สแกนคือ "สิ่งที่เพิ่งส่องเจอ"
  ///    ส่วน draft คือ "ผลนับที่คนคีย์ไว้แล้ว" คนละเรื่องกัน
  ///    ปัดการ์ดทิ้งแล้วผลนับหายคือการลบงานของพนักงานโดยไม่ได้ถาม
  void removeScan(String sku) {
    state = state.copyWith(
      scans: state.scans.where((s) => s.sku != sku).toList(),
      clearExpanded: true,
    );
    if (state.drafts.containsKey(sku)) {
      flash('ยอดที่คีย์ไว้ยังอยู่ในรายการรอส่ง');
    }
  }

  /// ล้างรายการสแกนทั้งจอ — เช่นเดียวกับ [removeScan] คือไม่แตะ `count_drafts`
  void clearScans() {
    state = state.copyWith(scans: const [], clearExpanded: true);
    if (state.drafts.isNotEmpty) {
      flash('ยอดที่คีย์ไว้ยังอยู่ในรายการรอส่ง');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ค้นหา
  // ══════════════════════════════════════════════════════════════════

  void setQuery(String v) {
    state = state.copyWith(query: v, searchHits: null);
    if (ApiConfig.isConfigured) runSearch(v);
  }

  /// ค้นหาจาก replica ในเครื่อง (ออฟไลน์ได้) — หน้าค้นหาเรียกแบบ debounce
  Future<void> runSearch(String q) async {
    if (!ApiConfig.isConfigured) return;
    final hits = await ref.read(localDbProvider).searchItems(q, limit: 100);
    // ทิ้งผลที่ล้าหลัง (ผู้ใช้พิมพ์ต่อไปแล้ว)
    if (state.query.trim() != q.trim()) return;
    state = state.copyWith(searchHits: hits);
  }

  /// ใส่ผลค้นหาตรง ๆ — สำหรับเทสต์ที่ไม่มี replica ในเครื่อง
  @visibleForTesting
  void setSearchHits(List<Item> hits) =>
      state = state.copyWith(searchHits: hits);

  /// จำข้อมูลสินค้าที่ดึงมาแล้ว — สำหรับเทสต์ (ของจริงตั้งใน resolveCodeAsync)
  @visibleForTesting
  void rememberScannedItem(Item item) => state = state.copyWith(
        scannedItems: {...state.scannedItems, item.sku: item},
      );

  /// ผลค้นหา — substring บน name + nameEn + sku + barcode (ไม่สนตัวพิมพ์)
  ///
  /// โหมดต่อ backend จะได้ผลจาก [runSearch] (replica) แทน fixture
  List<Item> searchResults() {
    if (state.searchHits != null) return state.searchHits!;
    // ต่อ backend จริง: ยังไม่มีผลจาก replica = ยังไม่มีผล ห้ามยัดข้อมูลตัวอย่างแทน
    if (ApiConfig.isConfigured) return const [];
    final q = state.query.trim().toLowerCase();
    if (q.isEmpty) return Fixtures.items;
    return Fixtures.items.where((i) {
      final hay =
          '${i.name}${i.nameEn ?? ''}${i.sku}${i.barcodes.join()}'.toLowerCase();
      return hay.contains(q);
    }).toList();
  }

  /// แตะผลค้นหา → เข้ารายการสแกนแบบขยาย (พฤติกรรม handoff ตาม design)
  ///
  /// ⚠️ ต้องพาข้อมูลสินค้าติดไปด้วย — การ์ดฝั่งสแกนอ่านจาก `scannedItems`
  ///    ถ้าไม่เก็บ การ์ดจะ fallback ไปหาในข้อมูลตัวอย่างแล้วไม่เจอ → จอว่าง
  void openFromSearch(String sku) {
    final hit = searchResults().where((i) => i.sku == sku).firstOrNull;
    if (hit != null) {
      state = state.copyWith(
        scannedItems: {...state.scannedItems, sku: hit},
      );
    }
    addScan(sku, note: 'เลือกจากการค้นหา');
    state = state.copyWith(tab: AppTab.scan, expandedSku: sku);
  }

  // ══════════════════════════════════════════════════════════════════
  // นับสต็อก
  // ══════════════════════════════════════════════════════════════════

  /// กรอกค่าที่นับได้ — ตัวเลขบวก จุดทศนิยมได้ **จุดเดียว ไม่เกิน 3 ตำแหน่ง**
  ///
  /// 3 ตำแหน่งมาจาก `numeric(18,3)` ของ `count_submissions` ฝั่ง server:
  /// ถ้าปล่อยให้กรอกละเอียดกว่านั้น ค่าที่จอโชว์กับค่าที่ถูกบันทึกจะไม่ตรงกัน
  void setCount(String sku, String raw) {
    state = state.copyWith(counts: {...state.counts, sku: _sanitizeQty(raw)});
  }

  /// ตัวกรองค่าที่นับได้ — ทิ้งอักขระอื่นทั้งหมด เก็บจุดแรกจุดเดียว ตัดเศษที่เกิน 3 ตำแหน่ง
  static String _sanitizeQty(String raw) {
    final cleaned = raw.replaceAll(RegExp(r'[^0-9.]'), '');
    final dot = cleaned.indexOf('.');
    if (dot < 0) return cleaned;
    final whole = cleaned.substring(0, dot);
    // จุดที่เหลือถูกทิ้ง → '1.2.3' กลายเป็น '1.23' (ยอมจุดเดียว)
    final frac = cleaned.substring(dot + 1).replaceAll('.', '');
    return '$whole.${frac.length > 3 ? frac.substring(0, 3) : frac}';
  }

  void incCount(String sku) {
    // num ไม่ใช่ int — ค่าที่กรอกเป็นทศนิยมได้ ('20.5' + 1 ต้องได้ 21.5 ไม่ใช่ 1)
    final v = num.tryParse(state.counts[sku] ?? '') ?? 0;
    setCount(sku, '${v + 1}');
  }

  /// ลดค่าที่นับได้ทีละ 1 — **ช่องที่ยังว่างต้องอยู่ว่างต่อไป**
  ///
  /// ว่าง = "ยังไม่ได้นับ" · '0' = "นับแล้วได้ศูนย์" (ของหาย → ผลต่างเท่ายอดระบบทั้งก้อน)
  /// กดลบพลาดบนช่องว่างแล้วกลายเป็น '0' = สร้างผลนับที่ไม่มีใครเคยนับ
  void decCount(String sku) {
    final cur = state.counts[sku] ?? '';
    if (cur.isEmpty) return;
    final v = num.tryParse(cur) ?? 0;
    final next = v - 1;
    setCount(sku, next <= 0 ? '0' : '$next');
  }

  // ══════════════════════════════════════════════════════════════════
  // ⭐ นับจากการ์ดผลสแกน (เอกสารแบบไม่มีรอบ) — write-through ลง count_drafts
  //
  // แยกจาก [setCount] ของจอรอบนับ **เด็ดขาด**: เส้นทางรอบนับเดิมยังไม่แตะ
  // SQLite ตอนกรอก (เข้าคิวตอนกดส่งเท่านั้น) ส่วนเส้นนี้ต้องบันทึกทุก keystroke
  // เพราะไม่มีปุ่ม "ส่ง" คั่นระหว่างการคีย์กับการปิดแอป
  //
  // ⚠️ ไม่คำนวณและไม่เก็บ `diff` ที่ไหนเลย — เก็บแต่ systemQtyShown + countedQty
  //    การกลับเครื่องหมายให้ ERP มีจุดเดียวคือ `erpDifQty()` ฝั่ง server
  // ══════════════════════════════════════════════════════════════════

  /// ใครกำลังนับอยู่ **ตอนนี้** — จับไว้ล่วงหน้าได้ ดู [setScanCount]
  ///
  /// เป็น derived ล้วน ๆ ไม่มี setter: ทางเดียวที่ค่านี้เปลี่ยนคือมีคนล็อกอิน
  /// เข้ามาใหม่ หรือ [signOut] รีเซ็ต state
  CountActor get countActor =>
      (empId: state.me.empId, warehouseCode: state.warehouseCode);

  /// กรอกยอดที่นับได้จากการ์ดผลสแกน แล้ว**เขียนทะลุลงเครื่องทันที**
  ///
  /// - `onHand == null` → ห้ามนับ (null ≠ 0) — กั้นซ้ำจากที่จอไม่แสดงช่องกรอก
  /// - viewer → ไม่เขียนอะไรเลย
  /// - ค่าว่าง = "ยังไม่ได้นับ" → ถอนบรรทัดออกจากเอกสาร
  ///   ต่างจาก '0' ที่แปลว่า "นับแล้วได้ศูนย์" (ของหาย) ซึ่งต้องเก็บเป็นแถวจริง
  ///
  /// [actor] = คนที่ลงมือนับ **ณ เวลาที่เก็บ snapshot** ไม่ใช่ ณ เวลาที่เขียน
  /// — มีไว้ให้เส้นทางเดียวคือการซ่อมยอดที่เครื่องยิงทำรั่ว ซึ่งวิ่งใน post-frame
  /// callback หลังจอสแกนถูกถอดทิ้งแล้ว การ sign-out ถอดจอ **หลัง** รีเซ็ต state
  /// ไปแล้ว ตอนซ่อมจึงไม่เหลือใครล็อกอินอยู่: `state.me` ตกไปที่ fallback
  /// (คนแรกในรายชื่อ = แอดมิน) และ `warehouseCode` กลายเป็น null — ยอดถูกซ่อมถูก
  /// แต่ไปเข้าชื่อคนที่ไม่ได้นับ ซึ่งเป็นหลักฐานตรวจสอบของเอกสารตรวจนับ
  ///
  /// null (ปกติ) = เขียนตามคนที่ล็อกอินอยู่ตอนนี้ ([countActor])
  Future<void> setScanCount(Item item, String raw, {CountActor? actor}) async {
    // มี [actor] = การเขียนครั้งนี้เป็นการ**ถอน**สิ่งที่เขียนไปแล้วตอนที่สิทธิ์
    // ถูกตรวจไปรอบหนึ่งแล้ว ด่านสิทธิ์ของ "ตอนนี้" จึงไม่ใช่ด่านที่ถูกต้อง
    // (sign-out แล้ว state.me กลายเป็นคนอื่น — ถ้าคนนั้นเป็น viewer การซ่อมจะเงียบ)
    if (actor == null && !state.me.role.canWrite) return;
    final scribe = actor ?? countActor;
    final onHand = item.onHand;
    if (onHand == null) return;

    final value = _sanitizeQty(raw);
    state = state.copyWith(counts: {...state.counts, item.sku: value});

    final db = ref.read(localDbProvider);
    final qty = value.isEmpty ? null : num.tryParse(value);
    if (qty == null) {
      state = state.copyWith(drafts: {...state.drafts}..remove(item.sku));
      await db.deleteDraft(item.sku);
      return;
    }

    await db.upsertDraft(
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      loc: item.loc,
      warehouseCode: scribe.warehouseCode ?? item.warehouse ?? '',
      // สแนปช็อตยอด ณ เวลาที่คนเห็นจอ — server เอาไปเทียบ drift ตอนสร้างเอกสาร
      // ห้ามให้ชั้นล่างไปอ่านยอดล่าสุดเอง มิฉะนั้นการตรวจ drift ไร้ผล
      systemQtyShown: onHand,
      systemQtyAsOf: item.onHandAsOf,
      countedQty: qty,
      enteredBy: scribe.empId,
    );
    final row = await db.draftFor(item.sku);
    if (row != null) {
      state = state.copyWith(drafts: {...state.drafts, item.sku: row});
    }
  }

  Future<void> incScanCount(Item item) {
    // num ไม่ใช่ int — '20.5' + 1 ต้องได้ 21.5
    final v = num.tryParse(state.counts[item.sku] ?? '') ?? 0;
    return setScanCount(item, '${v + 1}');
  }

  /// ลดทีละ 1 — **ช่องที่ยังว่างต้องอยู่ว่างต่อไป** (ดูเหตุผลที่ [decCount])
  Future<void> decScanCount(Item item) async {
    final cur = state.counts[item.sku] ?? '';
    if (cur.isEmpty) return;
    final v = num.tryParse(cur) ?? 0;
    final next = v - 1;
    await setScanCount(item, next <= 0 ? '0' : '$next');
  }

  /// ดึงบรรทัดที่คีย์ค้างจาก SQLite เข้า state + เติมค่ากลับลงช่องกรอก
  Future<void> loadDrafts() async {
    final rows = await ref.read(localDbProvider).allDrafts();
    final counts = {...state.counts};
    for (final r in rows) {
      counts[r.sku] = _qtyText(r.countedQty);
    }
    state = state.copyWith(
      drafts: {for (final r in rows) r.sku: r},
      counts: counts,
    );
  }

  /// อ่านโหมดสแกน + ปุ่มฮาร์ดแวร์ที่ผูกไว้จาก KvMeta — ห่อ try/catch เพราะแถวที่
  /// เพี้ยน/รุ่นเก่ากว่าห้ามทำให้ sign-in ล้ม (ต่างจาก [setScanCount] ที่ยอมให้โยนได้
  /// เพราะมี UI จับ error โดยตรง จุดนี้ไม่มี)
  Future<({ScanMode mode, int? hotkey})> _loadScanPrefs() async {
    try {
      final db = ref.read(localDbProvider);
      final modeRaw = await db.meta(MetaKeys.scanMode);
      final hotkeyRaw = await db.meta(MetaKeys.scanModeHotkey);
      return (
        mode: _parseScanMode(modeRaw),
        hotkey:
            (hotkeyRaw == null || hotkeyRaw.isEmpty) ? null : int.tryParse(hotkeyRaw),
      );
    } on Object catch (e) {
      debugPrint('TCL: อ่านค่าโหมดสแกนไม่สำเร็จ — ใช้ค่าเริ่มต้น handheld ($e)');
      return (mode: ScanMode.handheld, hotkey: null);
    }
  }

  static ScanMode _parseScanMode(String? raw) {
    for (final m in ScanMode.values) {
      if (m.name == raw) return m;
    }
    return ScanMode.handheld; // ค่าที่อ่านไม่ออก/รุ่นอนาคต → ปลอดภัยไว้ก่อนเสมอ
  }

  /// ค่าที่เก็บเป็น double กลับมาเป็นข้อความแบบที่คนคีย์ (19.0 → '19')
  static String _qtyText(num v) =>
      v == v.roundToDouble() ? v.toInt().toString() : '$v';

  /// ลบบรรทัดที่คีย์ไว้ 1 แถว (จอ 'รอส่ง')
  ///
  /// ทำได้เพราะ draft ยังอยู่ในเครื่อง ยังไม่เคยเป็นหลักฐานฝั่ง server
  /// จึงไม่ขัดกฎ append-only · viewer ถูกกั้น
  Future<void> deleteDraft(String sku) async {
    if (!state.me.role.canWrite) {
      flash('สิทธิ์ viewer แก้ผลนับไม่ได้');
      return;
    }
    await ref.read(localDbProvider).deleteDraft(sku);
    state = state.copyWith(
      drafts: {...state.drafts}..remove(sku),
      counts: {...state.counts}..remove(sku),
    );
  }

  /// ⭐ ปิดเอกสารจากบรรทัดที่คีย์ไว้แล้วเข้าคิวส่ง (จอสแกน / จอ 'รอส่ง')
  ///
  /// ⚠️ เอกสารที่ถึง ERP แล้ว **ลบไม่ได้** — จอที่เรียกเมธอดนี้ต้องผ่าน popup
  ///    ยืนยันเสมอ (`ConfirmSendSheet`) เมธอดนี้ไม่ถามซ้ำให้
  ///
  /// - viewer ถูกกั้นแบบ fail-closed ตั้งแต่บรรทัดแรก
  /// - [AppState.busy] กันกดยืนยันรัว ๆ ให้เข้าคิวใบเดียว
  /// - เข้าคิวสำเร็จ = งานอยู่ใน SQLite แล้ว **ไม่ต้องมีเน็ต** (SyncEngine ส่งให้ทีหลัง)
  Future<void> sendDraftsToErp() async {
    if (!state.me.role.canWrite) {
      flash('สิทธิ์ viewer ส่งผลนับไม่ได้');
      return;
    }
    if (state.busy) return;
    if (state.drafts.isEmpty) {
      flash('ยังไม่มีรายการที่คีย์ไว้');
      return;
    }

    state = state.copyWith(busy: true);
    try {
      final doc = await ref.read(localDbProvider).enqueueCountDoc();
      if (doc == null) {
        state = state.copyWith(busy: false);
        flash('ยังไม่มีรายการที่คีย์ไว้');
        return;
      }
      // ล้างเฉพาะ sku ที่เข้าใบนี้ — บรรทัดที่เกินเพดานยังคีย์ค้างอยู่จริง
      // (ล้างทั้ง map จะลบค่าที่กรอกในจอรอบนับซึ่งคนละเส้นทางกันไปด้วย)
      final drafts = {...state.drafts}..removeWhere((sku, _) => doc.skus.contains(sku));
      final counts = {...state.counts}..removeWhere((sku, _) => doc.skus.contains(sku));
      // เอาการ์ดที่ส่งไปแล้วออกจากลิสต์ผลสแกนด้วย — งานจบแล้วไม่ต้องค้างให้สับสน
      // ว่ายังต้องนับอยู่ไหม (บรรทัดที่เกินเพดานยังไม่ถูกส่ง จึงต้องคาไว้ตามเดิม)
      final scans = state.scans.where((s) => !doc.skus.contains(s.sku)).toList();
      final expandedGone =
          state.expandedSku != null && doc.skus.contains(state.expandedSku);
      state = state.copyWith(
        drafts: drafts,
        counts: counts,
        scans: scans,
        busy: false,
        clearExpanded: expandedGone,
      );

      // ยิงซิงค์ทันที — ไม่มีเน็ตก็ไม่เป็นไร คิวยังอยู่และ SyncEngine retry ให้
      if (ApiConfig.isConfigured) {
        unawaited(ref.read(syncEngineProvider).syncAll());
      }
      flash(doc.remaining > 0
          ? 'ส่ง ${doc.lineCount} รายการเข้าคิวแล้ว · เหลืออีก ${doc.remaining} รายการ'
          : 'ส่ง ${doc.lineCount} รายการเข้าคิวแล้ว');
    } on Object catch (_) {
      // เขียน SQLite ไม่ผ่าน = งานยังอยู่ครบใน count_drafts (ทรานแซกชัน rollback)
      state = state.copyWith(busy: false);
      flash('บันทึกลงเครื่องไม่สำเร็จ · ยอดที่คีย์ยังอยู่');
    }
  }

  /// เข้าจอ 'รอส่ง' จากการ์ดสแกน — viewer ถูกกั้น
  void goCount() {
    if (!state.me.role.canWrite) {
      flash('สิทธิ์ viewer นับสต็อกไม่ได้');
      return;
    }
    state = state.copyWith(tab: AppTab.count);
  }

  /// ส่งผลการนับ
  ///
  /// โหมดต่อ backend: **เข้าคิว outbox ในเครื่อง** แล้ว SyncEngine ส่งขึ้นเมื่อถึง server
  /// → กดแล้วได้ toast ทันทีแม้ออฟไลน์ (ตาม design) งานไม่หายเพราะคิวอยู่ใน SQLite
  ///
  /// ⚠️ viewer ถูกกั้นที่นี่ด้วย (deviation ที่บันทึกไว้ — demo ไม่ได้กั้น)
  Future<void> submitCount() async {
    if (!state.me.role.canWrite) {
      flash('สิทธิ์ viewer นับสต็อกไม่ได้');
      return;
    }

    final entered = <String, num>{};
    for (final r in countRows()) {
      final raw = state.counts[r.sku] ?? '';
      if (raw.isEmpty) continue;
      final qty = num.tryParse(raw);
      if (qty != null) entered[r.sku] = qty;
    }
    if (entered.isEmpty) {
      flash('ยังไม่มีรายการที่นับ');
      return;
    }

    final sessionId = state.session?.id;
    if (ApiConfig.isConfigured && sessionId != null) {
      final db = ref.read(localDbProvider);
      for (final e in entered.entries) {
        await db.enqueueCountLine(
          sessionId: sessionId,
          sku: e.key,
          countedQty: e.value,
        );
      }
      // ยิงซิงค์ทันที — ไม่มีเน็ตก็ไม่เป็นไร คิวยังอยู่และ SyncEngine retry ให้
      ref.read(syncEngineProvider).syncAll();
    }
    flash('ส่งผลการนับ ${entered.length} รายการแล้ว');
  }

  /// รายการในรอบนับ — จากรอบจริงถ้ามี ไม่งั้นใช้ fixture
  /// รายการในรอบนับ
  ///
  /// 🚫 ต่อ backend จริงแล้วไม่มีรอบเปิดอยู่ = ลิสต์ว่าง
  ///    เดิม fallback ไป `Fixtures.countRows` ทำให้จอขึ้นสินค้าตัวอย่าง
  ///    (SKU-40128 ฯลฯ) ที่พนักงานกรอกจำนวนแล้วกดส่งได้จริง
  List<CountRow> countRows() =>
      state.session?.rows ?? (ApiConfig.isConfigured ? const [] : Fixtures.countRows);

  /// ดึงรอบนับ active จาก replica ในเครื่อง (นับต่อได้แม้ออฟไลน์)
  Future<void> loadSession() async {
    if (!ApiConfig.isConfigured) return;
    final s = await ref.read(localDbProvider).activeSession();
    state = s == null
        ? state.copyWith(clearSession: true)
        : state.copyWith(session: s);
  }

  // ══════════════════════════════════════════════════════════════════
  // สมาชิกและสิทธิ์
  // ══════════════════════════════════════════════════════════════════

  /// วนสิทธิ์ admin → staff → viewer (admin เท่านั้น)
  ///
  /// ⚠️ กติกาเพิ่ม: กันลดสิทธิ์จนไม่มี admin เหลือ
  Future<void> cycleRole(int index) async {
    if (!state.me.role.isAdmin) {
      flash('ต้องมีสิทธิ์ผู้ดูแลเพื่อแก้ไขสิทธิ์');
      return;
    }
    if (state.busy) return;

    final target = state.members[index];
    final adminCount = state.members.where((m) => m.role.isAdmin).length;
    if (target.role.isAdmin && adminCount <= 1) {
      flash('ต้องมีผู้ดูแลอย่างน้อย 1 คน');
      return;
    }
    final nextRole = target.role.next;

    if (!ApiConfig.isConfigured) {
      final updated = [...state.members];
      updated[index] = target.copyWith(role: nextRole);
      state = state.copyWith(members: updated);
      return;
    }

    // อัปเดตหน้าจอทันที แล้วย้อนคืนถ้า backend ปฏิเสธ
    final optimistic = [...state.members];
    optimistic[index] = target.copyWith(role: nextRole);
    state = state.copyWith(members: optimistic, busy: true);
    try {
      await ref
          .read(membersRepositoryProvider)
          .changeRole(empId: target.empId, role: nextRole);
      state = state.copyWith(busy: false);
    } on ApiException catch (e) {
      final reverted = [...state.members];
      reverted[index] = target;
      state = state.copyWith(members: reverted, busy: false);
      flash(e.message);
    }
  }

  void openAddSheet() {
    if (!state.me.role.isAdmin) {
      flash('ต้องมีสิทธิ์ผู้ดูแลเพื่อเพิ่มสมาชิก');
      return;
    }
    state = state.copyWith(addSheetOpen: true);
  }

  void closeAddSheet() =>
      state = state.copyWith(addSheetOpen: false, newName: '', newId: '');

  void setNewName(String v) => state = state.copyWith(newName: v);

  void setNewId(String v) {
    final d = v.replaceAll(RegExp(r'[^0-9]'), '');
    state = state.copyWith(newId: d.length > 6 ? d.substring(0, 6) : d);
  }

  void setNewRole(Role r) => state = state.copyWith(newRole: r);

  Future<void> addMember() async {
    if (state.busy) return;
    if (state.newName.trim().isEmpty || state.newId.length < 3) {
      flash('กรอกชื่อและรหัสพนักงานให้ครบ');
      return;
    }
    if (state.members.any((m) => m.empId == state.newId)) {
      flash('รหัสพนักงานนี้มีอยู่แล้ว');
      return;
    }

    if (!ApiConfig.isConfigured) {
      // โหมดพัฒนา — เพิ่มในหน่วยความจำ (ไม่มี PIN เพราะไม่มี backend)
      state = state.copyWith(
        members: [
          ...state.members,
          Member(
            name: state.newName.trim(),
            empId: state.newId,
            shift: 'ยังไม่กำหนดกะ',
            role: state.newRole,
          ),
        ],
        addSheetOpen: false,
        newName: '',
        newId: '',
      );
      flash('เพิ่มสมาชิกแล้ว · member added');
      return;
    }

    state = state.copyWith(busy: true);
    try {
      final result = await ref.read(membersRepositoryProvider).add(
            empId: state.newId,
            name: state.newName.trim(),
            role: state.newRole,
          );
      state = state.copyWith(
        members: [...state.members, result.member],
        addSheetOpen: false,
        newName: '',
        newId: '',
        busy: false,
        // PIN เริ่มต้นแสดงให้ admin ครั้งเดียว (อยู่ใน memory เท่านั้น)
        lastInitialPin: (
          empId: result.member.empId,
          name: result.member.name,
          pin: result.initialPin,
        ),
      );
      flash('เพิ่มสมาชิกแล้ว · member added');
    } on ApiException catch (e) {
      state = state.copyWith(busy: false);
      flash(e.message);
    }
  }

  /// ปิดจอแสดง PIN เริ่มต้น (admin กดรับทราบแล้ว)
  void dismissInitialPin() => state = state.copyWith(clearInitialPin: true);

  /// admin สั่งรีเซ็ต PIN ของสมาชิก — ได้ PIN ใหม่มาแสดงครั้งเดียว
  Future<void> resetPin(String empId) async {
    if (!state.me.role.isAdmin) {
      flash('ต้องมีสิทธิ์ผู้ดูแลเพื่อรีเซ็ต PIN');
      return;
    }
    if (!ApiConfig.isConfigured || state.busy) return;

    state = state.copyWith(busy: true);
    try {
      final pin = await ref.read(membersRepositoryProvider).resetPin(empId);
      final target = state.members.firstWhere((m) => m.empId == empId);
      state = state.copyWith(
        busy: false,
        lastInitialPin: (empId: empId, name: target.name, pin: pin),
      );
    } on ApiException catch (e) {
      state = state.copyWith(busy: false);
      flash(e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Toast — แสดง 2400ms · ข้อความใหม่แทนที่ทันที
  // ══════════════════════════════════════════════════════════════════

  int _toastSeq = 0;

  void flash(String message) {
    final seq = ++_toastSeq;
    state = state.copyWith(toast: message);
    Future.delayed(TclToastDuration.value, () {
      // provider ถูกทิ้งไปแล้ว (sign-out / ปิดจอ) — แตะ state ต่อจะโยน
      if (!ref.mounted) return;
      if (seq == _toastSeq) state = state.copyWith(clearToast: true);
    });
  }
}

/// แยกออกมาเพื่อไม่ให้ state layer ต้อง import theme
class TclToastDuration {
  const TclToastDuration._();
  static const Duration value = Duration(milliseconds: 2400);
}

final appProvider = NotifierProvider<AppController, AppState>(AppController.new);
