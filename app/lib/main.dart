import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme/kittikhun_tokens.dart';
import 'features/login/change_pin_screen.dart';
import 'features/login/login_screen.dart';
import 'features/shell/app_shell.dart';
import 'state/app_state.dart';

void main() => runApp(const ProviderScope(child: KittikhunApp()));

/// สไตล์แถบระบบ — ตัวอักษร/ไอคอนขาวบนพื้นเข้ม
///
/// mockup วาดแถบสถานะปลอม (นาฬิกา 09:41 + wifi/แบต) — production ใช้ของ OS จริง
/// ตาม design-fidelity §5.1 จึงมีแค่การตั้งสีให้กลืนกับ screenBg
const SystemUiOverlayStyle _overlayLight = SystemUiOverlayStyle(
  statusBarColor: Colors.transparent,
  // iOS อ่านค่านี้เป็น "ความสว่างของพื้นหลัง" → dark = ตัวอักษรขาว
  statusBarBrightness: Brightness.dark,
  statusBarIconBrightness: Brightness.light,
  systemNavigationBarColor: KittikhunTokens.screenBottom,
  systemNavigationBarIconBrightness: Brightness.light,
);

class KittikhunApp extends StatelessWidget {
  const KittikhunApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'KITTIKHUN Stock Check',
        debugShowCheckedModeBanner: false,
        theme: buildKittikhunTheme(),
        locale: const Locale('th'),
        supportedLocales: const [Locale('th'), Locale('en')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const KittikhunRoot(),
      );
}

/// ธีมเดียวของแอป — ทุกค่ามาจาก [KittikhunTokens]
///
/// จุดสำคัญ: fontFamily default = IBM Plex Sans Thai (ไม่ใช่ Space Grotesk)
/// ตาม design-fidelity §1.4 — Space Grotesk ใช้เฉพาะจุดที่ token ระบุ
ThemeData buildKittikhunTheme() {
  const scheme = ColorScheme.dark(
    primary: KittikhunTokens.accent,
    onPrimary: KittikhunTokens.onAccent,
    secondary: KittikhunTokens.accentBright,
    onSecondary: KittikhunTokens.onAccent,
    surface: KittikhunTokens.screenBottom,
    onSurface: KittikhunTokens.tBody,
    error: KittikhunTokens.bad,
    onError: KittikhunTokens.onAccent,
    outline: KittikhunTokens.b15,
  );

  final base = ThemeData(
    brightness: Brightness.dark,
    colorScheme: scheme,
    extensions: const <ThemeExtension<dynamic>>[KittikhunTokens()],
    scaffoldBackgroundColor: KittikhunTokens.screenBottom,
    canvasColor: KittikhunTokens.screenBottom,
    fontFamily: KittikhunTokens.fontThai,
    fontFamilyFallback: KittikhunTokens.thaiFallback,
    // pressed state ของ InkWell ทุกจุด = accent tint ตาม style-active ใน design
    splashColor: KittikhunTokens.t12,
    highlightColor: KittikhunTokens.t16,
    iconTheme: const IconThemeData(color: KittikhunTokens.tBody),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: KittikhunTokens.accent,
      selectionColor: KittikhunTokens.t40,
      selectionHandleColor: KittikhunTokens.accent,
    ),
    // ช่องกรอกใน design ไม่มีเส้นใต้/label ลอย — กรอบเป็นหน้าที่ของ FieldBox
    inputDecorationTheme: InputDecorationThemeData(
      isDense: true,
      filled: false,
      border: InputBorder.none,
      enabledBorder: InputBorder.none,
      focusedBorder: InputBorder.none,
      errorBorder: InputBorder.none,
      focusedErrorBorder: InputBorder.none,
      disabledBorder: InputBorder.none,
      contentPadding: EdgeInsets.zero,
      floatingLabelBehavior: FloatingLabelBehavior.never,
      hintStyle: KittikhunTokens.body15(KittikhunTokens.tFaint),
      labelStyle: KittikhunTokens.label(),
      counterStyle: KittikhunTokens.meta(),
      errorStyle: KittikhunTokens.meta(KittikhunTokens.bad),
    ),
  );

  // apply() แก้เฉพาะสี — ไม่ทับ fontFamily ที่ ThemeData ใส่ไว้ให้แล้ว
  return base.copyWith(
    textTheme: base.textTheme.apply(
      bodyColor: KittikhunTokens.tBody,
      displayColor: KittikhunTokens.tBrightest,
    ),
  );
}

/// รากของ UI — เลือกจอตามสถานะ sign-in และวางพื้นหลัง gradient ให้ทั้งแอป
class KittikhunRoot extends ConsumerWidget {
  const KittikhunRoot({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signedIn = ref.watch(appProvider.select((s) => s.signedIn));
    final mustChangePin =
        ref.watch(appProvider.select((s) => s.mustChangePin));

    // ลำดับจอ: ยังไม่ล็อกอิน → Login
    //          ล็อกอินแล้วแต่ต้องตั้ง PIN ใหม่ (PIN เริ่มต้นจาก admin / ถูก reset)
    //            → บังคับตั้ง PIN ก่อนเข้าใช้งาน
    //          ปกติ → AppShell
    final Widget screen;
    if (!signedIn) {
      screen = const LoginScreen();
    } else if (mustChangePin) {
      screen = ChangePinScreen(
        forced: true,
        onDone: () => ref.read(appProvider.notifier).pinChanged(),
        onSignOut: () => ref.read(appProvider.notifier).signOut(),
      );
    } else {
      screen = const AppShell();
    }

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: _overlayLight,
      child: Scaffold(
        backgroundColor: KittikhunTokens.screenBottom,
        body: Container(
          decoration: const BoxDecoration(gradient: KittikhunTokens.screenBg),
          child: SafeArea(child: screen),
        ),
      ),
    );
  }
}
