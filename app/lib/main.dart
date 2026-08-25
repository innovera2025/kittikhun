import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme/tcl_tokens.dart';
import 'features/login/change_pin_screen.dart';
import 'features/login/login_screen.dart';
import 'features/shell/app_shell.dart';
import 'state/app_state.dart';

void main() => runApp(const ProviderScope(child: TclApp()));

/// สไตล์แถบระบบ — ตัวอักษร/ไอคอนขาวบนพื้นเข้ม
///
/// mockup วาดแถบสถานะปลอม (นาฬิกา 09:41 + wifi/แบต) — production ใช้ของ OS จริง
/// ตาม design-fidelity §5.1 จึงมีแค่การตั้งสีให้กลืนกับ screenBg
const SystemUiOverlayStyle _overlayLight = SystemUiOverlayStyle(
  statusBarColor: Colors.transparent,
  // iOS อ่านค่านี้เป็น "ความสว่างของพื้นหลัง" → dark = ตัวอักษรขาว
  statusBarBrightness: Brightness.dark,
  statusBarIconBrightness: Brightness.light,
  systemNavigationBarColor: TclTokens.screenBottom,
  systemNavigationBarIconBrightness: Brightness.light,
);

class TclApp extends StatelessWidget {
  const TclApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'TCL Stock Check',
        debugShowCheckedModeBanner: false,
        theme: buildTclTheme(),
        locale: const Locale('th'),
        supportedLocales: const [Locale('th'), Locale('en')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const TclRoot(),
      );
}

/// ธีมเดียวของแอป — ทุกค่ามาจาก [TclTokens]
///
/// จุดสำคัญ: fontFamily default = IBM Plex Sans Thai (ไม่ใช่ Space Grotesk)
/// ตาม design-fidelity §1.4 — Space Grotesk ใช้เฉพาะจุดที่ token ระบุ
ThemeData buildTclTheme() {
  const scheme = ColorScheme.dark(
    primary: TclTokens.accent,
    onPrimary: TclTokens.onAccent,
    secondary: TclTokens.accentBright,
    onSecondary: TclTokens.onAccent,
    surface: TclTokens.screenBottom,
    onSurface: TclTokens.tBody,
    error: TclTokens.bad,
    onError: TclTokens.onAccent,
    outline: TclTokens.b15,
  );

  final base = ThemeData(
    brightness: Brightness.dark,
    colorScheme: scheme,
    extensions: const <ThemeExtension<dynamic>>[TclTokens()],
    scaffoldBackgroundColor: TclTokens.screenBottom,
    canvasColor: TclTokens.screenBottom,
    fontFamily: TclTokens.fontThai,
    fontFamilyFallback: TclTokens.thaiFallback,
    // pressed state ของ InkWell ทุกจุด = accent tint ตาม style-active ใน design
    splashColor: TclTokens.t12,
    highlightColor: TclTokens.t16,
    iconTheme: const IconThemeData(color: TclTokens.tBody),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: TclTokens.accent,
      selectionColor: TclTokens.t40,
      selectionHandleColor: TclTokens.accent,
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
      hintStyle: TclTokens.body15(TclTokens.tFaint),
      labelStyle: TclTokens.label(),
      counterStyle: TclTokens.meta(),
      errorStyle: TclTokens.meta(TclTokens.bad),
    ),
  );

  // apply() แก้เฉพาะสี — ไม่ทับ fontFamily ที่ ThemeData ใส่ไว้ให้แล้ว
  return base.copyWith(
    textTheme: base.textTheme.apply(
      bodyColor: TclTokens.tBody,
      displayColor: TclTokens.tBrightest,
    ),
  );
}

/// รากของ UI — เลือกจอตามสถานะ sign-in และวางพื้นหลัง gradient ให้ทั้งแอป
class TclRoot extends ConsumerWidget {
  const TclRoot({super.key});

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
        backgroundColor: TclTokens.screenBottom,
        body: Container(
          decoration: const BoxDecoration(gradient: TclTokens.screenBg),
          child: SafeArea(child: screen),
        ),
      ),
    );
  }
}
