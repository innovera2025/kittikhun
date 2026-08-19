import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api_client.dart';
import '../data/auth_repository.dart';
import '../data/fixtures.dart';
import '../data/models.dart';
import '../data/stock_repository.dart';
import '../local/local_db.dart';
import '../local/sync_engine.dart';

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

  // ── derived ────────────────────────────────────────────────────────

  /// ผู้ใช้ปัจจุบัน (fallback = คนแรกในรายชื่อ ตาม design)
  Member get me => members.firstWhere(
        (m) => m.empId == currentEmpId,
        orElse: () => members.first,
      );

  String get camStatusText => camStatusOverride ?? camStatus.text;

  bool get hasScans => scans.isNotEmpty;

  /// จำนวนรายการที่กรอกค่าแล้วในรอบนับ
  int get countedRows =>
      Fixtures.countRows.where((r) => (counts[r.sku] ?? '').isNotEmpty).length;

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
      _signInWithFixtures();
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
      state = state.copyWith(
        signedIn: true,
        tab: AppTab.scan,
        currentEmpId: result.user.empId,
        members: members,
        mustChangePin: result.mustChangePin,
        pin: '',
        loginError: false,
        busy: false,
        loginMessage: 'กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน',
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
  void _signInWithFixtures() {
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
    state = state.copyWith(
      signedIn: true,
      tab: AppTab.scan,
      currentEmpId: found.empId,
      pin: '',
      loginError: false,
      loginMessage: 'กรอกรหัสพนักงานและ PIN เพื่อเข้าใช้งาน',
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
  Future<void> signOut() async {
    if (ApiConfig.isConfigured) {
      // หยุดเฝ้าสัญญาณ แต่ **ห้ามลบ outbox** — งานนับที่ยังไม่ซิงค์ต้องอยู่รอด
      ref.read(syncEngineProvider).stop();
      // clear token ให้สำเร็จแม้ request ล้มเหลว (repository จัดการแล้ว)
      await ref.read(authRepositoryProvider).logout();
    }
    state = AppState(members: state.members);
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
  Item? itemFor(String sku) =>
      state.scannedItems[sku] ??
      Fixtures.items.where((i) => i.sku == sku).firstOrNull;

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

  void removeScan(String sku) => state = state.copyWith(
        scans: state.scans.where((s) => s.sku != sku).toList(),
        clearExpanded: true,
      );

  void clearScans() =>
      state = state.copyWith(scans: const [], clearExpanded: true);

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

  /// ผลค้นหา — substring บน name + nameEn + sku + barcode (ไม่สนตัวพิมพ์)
  ///
  /// โหมดต่อ backend จะได้ผลจาก [runSearch] (replica) แทน fixture
  List<Item> searchResults() {
    if (state.searchHits != null) return state.searchHits!;
    final q = state.query.trim().toLowerCase();
    if (q.isEmpty) return Fixtures.items;
    return Fixtures.items.where((i) {
      final hay =
          '${i.name}${i.nameEn ?? ''}${i.sku}${i.barcodes.join()}'.toLowerCase();
      return hay.contains(q);
    }).toList();
  }

  /// แตะผลค้นหา → เข้ารายการสแกนแบบขยาย (พฤติกรรม handoff ตาม design)
  void openFromSearch(String sku) {
    addScan(sku, note: 'เลือกจากการค้นหา');
    state = state.copyWith(tab: AppTab.scan, expandedSku: sku);
  }

  // ══════════════════════════════════════════════════════════════════
  // นับสต็อก
  // ══════════════════════════════════════════════════════════════════

  /// กรอกค่าที่นับได้ — ตัวเลขเท่านั้น
  void setCount(String sku, String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    state = state.copyWith(counts: {...state.counts, sku: digits});
  }

  void incCount(String sku) {
    final v = int.tryParse(state.counts[sku] ?? '') ?? 0;
    setCount(sku, '${v + 1}');
  }

  void decCount(String sku) {
    final v = int.tryParse(state.counts[sku] ?? '') ?? 0;
    setCount(sku, '${v <= 0 ? 0 : v - 1}');
  }

  /// เข้าหน้านับจากการ์ดสแกน — viewer ถูกกั้น
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
  List<CountRow> countRows() => state.session?.rows ?? Fixtures.countRows;

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
    Future.delayed(KittikhunToastDuration.value, () {
      if (seq == _toastSeq) state = state.copyWith(clearToast: true);
    });
  }
}

/// แยกออกมาเพื่อไม่ให้ state layer ต้อง import theme
class KittikhunToastDuration {
  const KittikhunToastDuration._();
  static const Duration value = Duration(milliseconds: 2400);
}

final appProvider = NotifierProvider<AppController, AppState>(AppController.new);
