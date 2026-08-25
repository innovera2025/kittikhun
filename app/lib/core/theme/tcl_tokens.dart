import 'package:flutter/material.dart';

/// Design token ทั้งหมดของ TCL v4.0
///
/// สกัดจาก `Mobile Stock Check System/Stock Scan Mobile.dc.html` (ไฟล์ต้นแบบ)
/// **ห้าม widget ใดฮาร์ดโค้ดสี / รัศมี / เงา / ขนาดฟอนต์** — ต้องอ่านจากที่นี่เท่านั้น
///
/// ดูสัญญาความตรงกับ design ที่ `docs/design-fidelity.md`
@immutable
class TclTokens extends ThemeExtension<TclTokens> {
  const TclTokens();

  // ══════════════════════════════════════════════════════════════════
  // สีพื้นและพื้นผิว
  // ══════════════════════════════════════════════════════════════════

  /// พื้นหลังนอกสุด (mockup ใช้ radial gradient — บนอุปกรณ์จริงใช้ screenBg)
  static const Color canvasBg = Color(0xFF0F1925);

  /// พื้นหลังจอทั้งแอป: linear-gradient(#22303F, #18232F 42%)
  static const Color screenTop = Color(0xFF22303F);
  static const Color screenBottom = Color(0xFF18232F);
  static const LinearGradient screenBg = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [screenTop, screenBottom],
    stops: [0.0, 0.42],
  );

  /// พื้นกรอบกล้อง
  static const Color cameraViewportBg = Color(0xFF121C27);

  /// การ์ดผลสแกน: linear-gradient(#2A3846, #1E2A36)
  static const LinearGradient scanCardBg = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF2A3846), Color(0xFF1E2A36)],
  );

  /// การ์ดค้นหา / นับ / สมาชิก: linear-gradient(#2A3846, #212D3A)
  static const LinearGradient listCardBg = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF2A3846), Color(0xFF212D3A)],
  );

  /// bottom sheet: linear-gradient(#28374A, #1E2A36)
  static const LinearGradient sheetBg = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF28374A), Color(0xFF1E2A36)],
  );

  static const Color toastBg = Color(0xF5223040); // rgba(34,48,63,.96)
  static const Color scrim = Color(0x9E0A1119); // rgba(10,17,25,.62)
  static const Color camPillBg = Color(0x8C0C141D); // rgba(12,20,29,.55)

  // ══════════════════════════════════════════════════════════════════
  // Surface overlays (ขาวโปร่ง) — ตามระดับที่ design ใช้
  // ══════════════════════════════════════════════════════════════════

  static const Color s07 = Color(0x12FFFFFF); // .07 ปุ่มรอง / keypad / role opt
  static const Color s075 = Color(0x13FFFFFF); // .075 การ์ด login / stat tile
  static const Color s085 = Color(0x16FFFFFF); // .085 input / chip
  static const Color s09 = Color(0x17FFFFFF); // .09 แถบแท็บ
  static const Color s10 = Color(0x1AFFFFFF); // .10 ช่องกรอกนับ / pill กลาง
  static const Color s11 = Color(0x1CFFFFFF); // .11 แทร็ก progress
  static const Color hover14 = Color(0x24FFFFFF);
  static const Color hover15 = Color(0x26FFFFFF);
  static const Color hover16 = Color(0x29FFFFFF);

  // ══════════════════════════════════════════════════════════════════
  // เส้นขอบ (ขาวโปร่ง)
  // ══════════════════════════════════════════════════════════════════

  static const Color b10 = Color(0x1AFFFFFF); // stat tile / spec divider
  static const Color b11 = Color(0x1CFFFFFF); // keypad / list card
  static const Color b13 = Color(0x21FFFFFF); // การ์ด login / กรอบกล้อง / แท็บ
  static const Color b15 = Color(0x26FFFFFF); // input / sheet
  static const Color b16 = Color(0x29FFFFFF); // stepper / cam pill / toast
  static const Color b18 = Color(0x2EFFFFFF); // ปุ่มรอง / FAB
  static const Color b20 = Color(0x33FFFFFF); // ช่อง PIN ปกติ
  static const Color b26 = Color(0x42FFFFFF); // grabber ของ sheet
  static const Color errorBorder = Color(0xB3FF8377); // rgba(255,131,119,.7)

  // ══════════════════════════════════════════════════════════════════
  // Text ramp
  // ══════════════════════════════════════════════════════════════════

  static const Color tBrightest = Color(0xFFFBFDFF); // หัวเรื่อง / ชื่อสินค้า
  static const Color tBody = Color(0xFFF3F7FB); // เนื้อความ / ปุ่มบนพื้นเข้ม
  static const Color tSoft = Color(0xFFDCE6F0); // ค่ารอง
  static const Color tSoftAlt = Color(0xFFE6EEF6); // สถานะกล้อง / spec value
  static const Color tMuted = Color(0xFFA4B2C0); // label / kicker / แท็บ inactive
  static const Color tFaint = Color(0xFF8492A0); // hint / meta / placeholder
  static const Color onAccent = Color(0xFF07121B); // ตัวอักษรบนปุ่ม gradient
  static const Color logoIconStroke = Color(0xFF18232F);

  // ══════════════════════════════════════════════════════════════════
  // Accent
  // ══════════════════════════════════════════════════════════════════

  static const Color accent = Color(0xFF84BAF3); // BLUE
  static const Color accentHover = Color(0xFFBBDBFC);
  static const Color accentBright = Color(0xFFA6D2FB); // กรอบมุม + เส้นเลเซอร์

  /// CTA หลักทุกปุ่ม: linear-gradient(140deg, #95C6F7, #5A96D6)
  static const LinearGradient primaryGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF95C6F7), Color(0xFF5A96D6)],
  );

  /// แท็บ active: linear-gradient(140deg, #A2CEF9, #6EA8E8)
  static const LinearGradient activeTabGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFA2CEF9), Color(0xFF6EA8E8)],
  );

  /// โลโก้: linear-gradient(150deg, #84BAF3, #5A96D6)
  static const LinearGradient logoGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, Color(0xFF5A96D6)],
  );

  /// progress ของรอบนับ: linear-gradient(90deg, #95C6F7, #6FE7AC)
  static const LinearGradient countProgressGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Color(0xFF95C6F7), Color(0xFF6FE7AC)],
  );

  // accent tints
  static const Color t12 = Color(0x1F84BAF3);
  static const Color t16 = Color(0x2984BAF3);
  static const Color t18 = Color(0x2E84BAF3);
  static const Color t26 = Color(0x4284BAF3);
  static const Color t28 = Color(0x4784BAF3);
  static const Color t30 = Color(0x4D84BAF3);
  static const Color t35 = Color(0x5984BAF3);
  static const Color t40 = Color(0x6684BAF3);
  static const Color t45 = Color(0x7384BAF3);
  static const Color radialGlow = Color(0x3384BAF3); // .2 บนกล้อง

  // ══════════════════════════════════════════════════════════════════
  // สถานะสต็อก
  // ══════════════════════════════════════════════════════════════════

  static const Color ok = Color(0xFF6FE7AC); // พร้อมจ่าย / ตรงกับระบบ
  static const Color warn = Color(0xFFFFBA5C); // ใกล้หมด / เกิน / ขาด
  static const Color bad = Color(0xFFFF8377); // หมดสต็อก / login error
  static const Color okTint14 = Color(0x246FE7AC);
  static const Color okTint16 = Color(0x296FE7AC);
  static const Color okTint40 = Color(0x666FE7AC);
  static const Color staffFg = Color(0xFFA6F0C8);
  static const Color warnTint14 = Color(0x24FFBA5C);

  // ══════════════════════════════════════════════════════════════════
  // ฟอนต์
  //
  // ⚠️ IBM Plex Sans Thai เป็น default ของ TextTheme (สแต็ก body ใน design
  //    เป็นไทยนำ) — Space Grotesk ใช้เฉพาะจุดที่ design ระบุ:
  //    ตัวเลขจำนวน / บรรทัด SKU / แบรนด์ / keypad / badge / นาฬิกา
  // ⚠️ ห้ามใส่ letterSpacing กับข้อความสคริปต์ไทย (ทำ shaping พัง)
  // ══════════════════════════════════════════════════════════════════

  static const String fontThai = 'IBMPlexSansThai';
  static const String fontDisplay = 'SpaceGrotesk';
  static const List<String> thaiFallback = [fontDisplay];
  static const List<String> displayFallback = [fontThai];

  /// TextStyle สำหรับข้อความไทย (ค่า default)
  static TextStyle thai({
    required double size,
    FontWeight weight = FontWeight.w400,
    Color color = tBody,
    double? height,
  }) => TextStyle(
    fontFamily: fontThai,
    fontFamilyFallback: thaiFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    height: height,
  );

  /// TextStyle สำหรับตัวเลข / SKU / แบรนด์ (Space Grotesk — letterSpacing ได้)
  static TextStyle display({
    required double size,
    FontWeight weight = FontWeight.w500,
    Color color = tBody,
    double? letterSpacing,
    double? height,
  }) => TextStyle(
    fontFamily: fontDisplay,
    fontFamilyFallback: displayFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    letterSpacing: letterSpacing,
    height: height,
  );

  // ── type scale ตาม design (ชื่อสื่อถึงจุดใช้งาน) ──────────────────

  /// เลขคงเหลือการ์ดสแกน 30/700 lh.95 ls-.02em
  static TextStyle qtyHuge(Color c) =>
      display(size: 30, weight: FontWeight.w700, color: c, letterSpacing: -0.6, height: 0.95);

  /// หัวเรื่องแท็บ 26/600 lh1.2 ls-.01em
  static TextStyle screenTitle() =>
      thai(size: 26, weight: FontWeight.w600, color: tBrightest, height: 1.2);

  /// เลขผลค้นหา 24/700 lh1
  static TextStyle qtyLarge(Color c) =>
      display(size: 24, weight: FontWeight.w700, color: c, height: 1.0);

  /// แบรนด์ TCL 24/700 ls.02em
  static TextStyle brand() =>
      display(size: 24, weight: FontWeight.w700, color: tBrightest, letterSpacing: 0.48);

  /// หัว bottom sheet 23/600
  static TextStyle sheetTitle() =>
      thai(size: 23, weight: FontWeight.w600, color: tBrightest);

  /// keypad 21/500
  static TextStyle keypadKey() =>
      display(size: 21, weight: FontWeight.w500, color: tBody);

  /// ช่องรหัสพนักงาน 19/500 ls.14em
  static TextStyle empIdInput() =>
      display(size: 19, weight: FontWeight.w500, color: tBrightest, letterSpacing: 2.66);

  /// ค่าใน stat tile / ช่องนับ / เลขระบบ 18/600
  static TextStyle statValue([Color c = tBody]) =>
      display(size: 18, weight: FontWeight.w600, color: c);

  /// ชื่อสินค้า / สมาชิก 17/600 lh1.25
  static TextStyle itemName() =>
      thai(size: 17, weight: FontWeight.w600, color: tBrightest, height: 1.25);

  /// CTA หลัก 16/600
  static TextStyle ctaPrimary() =>
      thai(size: 16, weight: FontWeight.w600, color: onAccent);

  /// CTA รอง 15/600
  static TextStyle ctaSecondary([Color c = tBody]) =>
      thai(size: 15, weight: FontWeight.w600, color: c);

  /// input / เนื้อความ 15/400
  static TextStyle body15([Color c = tBrightest]) => thai(size: 15, color: c);

  /// toast / spec row 13/400
  static TextStyle body13([Color c = tBody]) => thai(size: 13, color: c);

  /// subtitle / hint 12.5/400
  static TextStyle caption([Color c = tMuted]) => thai(size: 12.5, color: c);

  /// field label 12/500
  static TextStyle label([Color c = tMuted]) =>
      thai(size: 12, weight: FontWeight.w500, color: c);

  /// meta / สถานะกล้อง 11.5/400
  static TextStyle meta([Color c = tFaint]) => thai(size: 11.5, color: c);

  /// บรรทัด SKU 11/400 ls.08em (Space Grotesk)
  static TextStyle skuLine() =>
      display(size: 11, weight: FontWeight.w400, color: accent, letterSpacing: 0.88);

  /// role pill 11/600 ls.1em
  static TextStyle rolePill(Color c) =>
      display(size: 11, weight: FontWeight.w600, color: c, letterSpacing: 1.1);

  /// chip ที่ login 11/400
  static TextStyle chip() => display(size: 11, color: tFaint);

  /// หน่วย / label แท็บ 10.5/400
  static TextStyle tiny([Color c = tFaint]) => thai(size: 10.5, color: c);

  /// role ที่ header 10/400 uppercase ls.12em
  static TextStyle roleKicker() =>
      display(size: 10, color: accent, letterSpacing: 1.2);

  // ══════════════════════════════════════════════════════════════════
  // รัศมี
  // ══════════════════════════════════════════════════════════════════

  static const double rSheet = 28;
  static const double rCamera = 28;
  static const double rLoginCard = 24;
  static const double rTabBar = 24;
  static const double rCard = 20;
  static const double rButtonLarge = 18;
  static const double rTabButton = 18;
  static const double rSearchInput = 18;
  static const double rToast = 18;
  static const double rLogoLarge = 17;
  static const double rTeamAction = 17;
  static const double rInput = 16;
  static const double rKeypad = 16;
  static const double rCardAction = 16;
  static const double rFab = 16;
  static const double rStatTile = 16;
  static const double rSheetButton = 16;
  static const double rAvatar = 15;
  static const double rRolePicker = 15;
  static const double rCornerBracket = 14;
  static const double rHeaderAvatar = 14;
  static const double rStepper = 14;
  static const double rCountInput = 14;
  static const double rDemoButton = 11;
  static const double rLogoSmall = 11;
  static const double rPinCell = 6;
  static const double rPill = 999;

  // ══════════════════════════════════════════════════════════════════
  // เงา
  // ══════════════════════════════════════════════════════════════════

  static const List<BoxShadow> shLoginCard = [
    BoxShadow(color: Color(0x59000000), blurRadius: 40, offset: Offset(0, 18)),
  ];
  static const List<BoxShadow> shSignInBtn = [
    BoxShadow(color: Color(0x615A96D6), blurRadius: 30, offset: Offset(0, 14)),
  ];
  static const List<BoxShadow> shSubmitBtn = [
    BoxShadow(color: Color(0x575A96D6), blurRadius: 30, offset: Offset(0, 14)),
  ];
  static const List<BoxShadow> shTeamAddBtn = [
    BoxShadow(color: Color(0x525A96D6), blurRadius: 26, offset: Offset(0, 12)),
  ];
  static const List<BoxShadow> shLogoTile = [
    BoxShadow(color: Color(0x665A96D6), blurRadius: 26, offset: Offset(0, 12)),
  ];
  static const List<BoxShadow> shScanCard = [
    BoxShadow(color: Color(0x4D000000), blurRadius: 26, offset: Offset(0, 12)),
  ];
  static const List<BoxShadow> shSearchCard = [
    BoxShadow(color: Color(0x47000000), blurRadius: 24, offset: Offset(0, 10)),
  ];
  static const List<BoxShadow> shCountCard = [
    BoxShadow(color: Color(0x42000000), blurRadius: 24, offset: Offset(0, 10)),
  ];
  static const List<BoxShadow> shTabBar = [
    BoxShadow(color: Color(0x59000000), blurRadius: 26, offset: Offset(0, -6)),
  ];
  static const List<BoxShadow> shSheet = [
    BoxShadow(color: Color(0x80000000), blurRadius: 60, offset: Offset(0, 30)),
  ];
  static const List<BoxShadow> shToast = [
    BoxShadow(color: Color(0x80000000), blurRadius: 40, offset: Offset(0, 18)),
  ];
  static const List<BoxShadow> shSweepGlow = [
    BoxShadow(color: Color(0xD9A6D2FB), blurRadius: 22),
  ];

  // ══════════════════════════════════════════════════════════════════
  // แอนิเมชัน — ค่าจาก @keyframes ใน design
  // ══════════════════════════════════════════════════════════════════

  /// rise: translateY 26→0 + fade
  static const Duration dRiseCard = Duration(milliseconds: 220);
  static const Duration dRiseSheet = Duration(milliseconds: 240);
  static const Duration dRiseToast = Duration(milliseconds: 200);
  static const Cubic cRise = Cubic(0.22, 0.9, 0.24, 1);

  /// nudge: shake ±6px (login error)
  static const Duration dNudge = Duration(milliseconds: 300);
  static const double nudgeOffset = 6;

  /// pulse: จุดสถานะกล้อง opacity .35↔1 + scale .9↔1
  static const Duration dPulse = Duration(milliseconds: 1500);

  /// sweep: เส้นเลเซอร์ — ตีความตาม intent: กวาดระหว่างกรอบมุม 26%→74%
  /// (CSS ตรงตัวขยับแค่ ±0.88px ซึ่งดูเหมือนค้าง — deviation ที่บันทึกแล้ว)
  static const Duration dSweep = Duration(milliseconds: 2200);

  /// glow: วงแหวนขยาย 0→14px รอบ FAB กล้องตอนปิด
  static const Duration dGlow = Duration(milliseconds: 2400);
  static const double glowMaxSpread = 14;

  /// keypad transition
  static const Duration dKeypad = Duration(milliseconds: 140);

  /// toast แสดง 2400ms
  static const Duration dToastVisible = Duration(milliseconds: 2400);

  // ══════════════════════════════════════════════════════════════════
  // Layout
  // ══════════════════════════════════════════════════════════════════

  static const double gutterTab = 18; // แท็บทั้งหมด
  static const double gutterLogin = 26; // login + status bar
  static const double cameraMinHeight = 190;
  static const double cameraCollapsed = 186; // sheet layout เมื่อมีรายการ
  static const double cameraSplit = 250; // split layout
  static const double toastBottomOffset = 96;

  // ความสูง control
  static const double hSignIn = 56;
  static const double hTabButton = 56;
  static const double hSubmit = 54;
  static const double hKeypadKey = 54;
  static const double hTeamAction = 52;
  static const double hInput = 52;
  static const double hSearchInput = 52;
  static const double hSheetInput = 50;
  static const double hSheetButton = 50;
  static const double hCardAction = 48;
  static const double hFab = 46;
  static const double hRoleOption = 46;
  static const double hStepper = 44;
  static const double hDemoButton = 34;
  static const double hPinCell = 12;

  // ══════════════════════════════════════════════════════════════════
  // ฟังก์ชันสถานะสต็อก (ใช้ร่วมทั้ง scan / search / count)
  //
  // ⚠️ production ใช้ onHand <= 0 (ไม่ใช่ == 0) เพราะ ERP ส่งค่าติดลบได้
  // ⚠️ ROP ใน ERP มีแค่ ~29% ของรายการ → rop <= 0 ถือว่า "ไม่ทราบเกณฑ์"
  //    แสดงสถานะกลางแทน ไม่เดาว่า "ใกล้หมด"
  // ══════════════════════════════════════════════════════════════════

  static StockTone toneOf({required num onHand, required num rop}) {
    if (onHand <= 0) return StockTone.out;
    if (rop > 0 && onHand <= rop) return StockTone.low;
    return StockTone.ready;
  }

  static Color toneColor(StockTone t) => switch (t) {
    StockTone.out => bad,
    StockTone.low => warn,
    StockTone.ready => ok,
  };

  static String toneLabel(StockTone t) => switch (t) {
    StockTone.out => 'หมดสต็อก',
    StockTone.low => 'ใกล้หมด',
    StockTone.ready => 'พร้อมจ่าย',
  };

  /// ความกว้างแถบระดับสต็อก — clamp(3, 100, round(onHand/(rop*3)*100))%
  /// คืน null เมื่อ rop <= 0 (ซ่อนแถบ — ไม่มีเกณฑ์ให้เทียบ)
  static double? stockBarFraction({required num onHand, required num rop}) {
    if (rop <= 0) return null;
    final pct = (onHand / (rop * 3) * 100).round();
    return pct.clamp(3, 100) / 100;
  }

  // ══════════════════════════════════════════════════════════════════
  // ThemeExtension boilerplate
  // ══════════════════════════════════════════════════════════════════

  @override
  TclTokens copyWith() => const TclTokens();

  @override
  TclTokens lerp(ThemeExtension<TclTokens>? other, double t) => this;
}

/// สถานะสต็อกของรายการ (ขับสีและข้อความตาม design)
enum StockTone { out, low, ready }
