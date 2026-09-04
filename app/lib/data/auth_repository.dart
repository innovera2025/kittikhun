import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'models.dart';

/// Repository ชั้น auth + members — **ผู้ใช้มาจาก ERP (`menuuser`) ผ่าน sync**
///
/// กติกาของไฟล์นี้:
/// - ไม่แปลข้อความ error เอง: backend ส่ง `message` เป็นภาษาไทยตาม design มาแล้ว
///   ชั้นนี้ปล่อย [ApiException] ขึ้นไปให้ UI แสดงตามที่ได้รับ
/// - ⚠️ **ห้าม log รหัสผ่าน / token** ไม่ว่ากรณีใด (เครื่องคลังใช้ร่วมกัน)
/// - token ทั้งหมดอยู่ใน TokenStore (flutter_secure_storage) เท่านั้น
/// - แอปสร้าง/รีเซ็ตผู้ใช้ไม่ได้ — แก้ที่ ERP แล้วรอ sync รอบถัดไป

/// ข้อความกะเริ่มต้นเมื่อ server ยังไม่กำหนดกะให้ (ตรงตาม design)
const String _kUnassignedShift = 'ยังไม่กำหนดกะ';

// ════════════════════════════════════════════════════════════════════
// Models ของชั้น auth
// ════════════════════════════════════════════════════════════════════

/// โปรไฟล์ผู้ใช้ที่เข้าสู่ระบบอยู่ — mirror ของ `UserProfile` ฝั่ง backend
@immutable
class UserProfile {
  const UserProfile({
    required this.empId,
    required this.name,
    required this.role,
    required this.shift,
    required this.warehouseCode,
  });

  final String empId;
  final String name;
  final Role role;

  /// กะ — `null` จาก server ถูกแทนด้วย 'ยังไม่กำหนดกะ' แล้ว
  final String shift;

  /// คลังของผู้ใช้ — `null` เมื่อ server ส่งค่าว่าง/ช่องว่างล้วนมา
  /// (หัวจอต้องขึ้น "คลัง" เปล่า ๆ ไม่ได้ ต้องรู้ว่าไม่มีค่าแล้วเลือกคำเอง)
  final String? warehouseCode;

  /// ⚠️ ไม่มี `mustChangePin` แล้ว — server ยังส่งคีย์นี้มาในสัญญา wire แต่เป็น
  /// `false` เสมอหลังย้ายไปล็อกอินด้วยข้อมูลรับรองของ ERP (แผน B-2) ฝั่งแอปจึง
  /// เลือกไม่อ่านมันเลย ดีกว่าถือค่าที่ไม่มีวันเป็นจริงไว้ให้เข้าใจผิด
  factory UserProfile.fromJson(Map<String, dynamic> json) => UserProfile(
        empId: _requireString(json['empId'], 'empId'),
        name: _asString(json['name']),
        role: _roleFromApi(json['role']),
        shift: _shiftOrDefault(json['shift']),
        warehouseCode: _emptyToNull(_asString(json['warehouseCode'])),
      );

  /// แปลงเป็น [Member] เพื่อใช้ร่วมกับรายชื่อสมาชิกในหน้า Team
  Member toMember() =>
      Member(name: name, empId: empId, shift: shift, role: role);
}

/// ผลของการเข้าสู่ระบบสำเร็จ
@immutable
class LoginResult {
  const LoginResult({required this.user});

  final UserProfile user;
}

// ════════════════════════════════════════════════════════════════════
// AuthRepository
// ════════════════════════════════════════════════════════════════════

class AuthRepository {
  const AuthRepository({required this.api, required this.store});

  final ApiClient api;
  final TokenStore store;

  /// เข้าสู่ระบบ — โยน [ApiException] ต่อขึ้นไปพร้อม `message` ไทยจาก backend
  /// (UNKNOWN_EMPLOYEE · INVALID_PIN · THROTTLED)
  Future<LoginResult> login({
    required String empId,
    required String pin,
  }) async {
    final deviceId = await store.getDeviceId();
    final json = await _postJson('/auth/login', {
      'empId': empId,
      'pin': pin,
      'deviceId': deviceId,
      'appVersion': ApiConfig.appVersion,
    });
    await _saveTokens(json);
    return LoginResult(
      user: UserProfile.fromJson(_asMap(json['user'], '/auth/login.user')),
    );
  }

  /// ออกจากระบบ — เคลียร์ token บนเครื่องให้สำเร็จเสมอ แม้ request ล้มเหลว
  ///
  /// หมายเหตุ: ไม่แตะงานนับที่ยังไม่ซิงค์ (outbox) — ต้องอยู่รอดข้ามการ sign-out
  Future<void> logout() async {
    try {
      final deviceId = await store.getDeviceId();
      await api.post('/auth/logout', body: {'deviceId': deviceId});
    } catch (_) {
      // เครื่องคลังใช้ร่วมกัน — เน็ตหลุดต้องไม่ทำให้ค้างอยู่ในระบบของคนก่อน
    } finally {
      await store.clear();
    }
  }

  /// กู้เซสชันตอนเปิดแอป — refresh แล้วดึงโปรไฟล์ตัวเองจาก `GET /members`
  ///
  /// คืน `null` เมื่อกู้ไม่ได้ (ให้ไปหน้า login) โดย**ไม่ล้าง token**:
  /// ถ้าล้มเพราะ LAN หลุด การลองใหม่ตอนมีเน็ตยังใช้ refresh token เดิมได้
  /// ส่วน login สำเร็จจะเขียน token ทับให้เองอยู่แล้ว
  Future<UserProfile?> restoreSession() async {
    try {
      final refreshToken = await store.readRefreshToken();
      if (refreshToken == null || refreshToken.isEmpty) return null;

      final deviceId = await store.getDeviceId();
      final tokens = await _postJson('/auth/refresh', {
        'refreshToken': refreshToken,
        'deviceId': deviceId,
      });
      await _saveTokens(tokens);

      // ไม่มี endpoint /me — empId/คลัง อ่านจาก claims ของ access token
      final claims = _jwtClaims(_asString(tokens['accessToken']));
      final empId = _asString(claims['sub']);
      if (empId.isEmpty) return null;

      final members = await MembersRepository(api: api).list();
      Member? me;
      for (final m in members) {
        if (m.empId == empId) {
          me = m;
          break;
        }
      }
      if (me == null) return null;

      return UserProfile(
        empId: me.empId,
        name: me.name,
        role: me.role,
        shift: me.shift,
        warehouseCode: _emptyToNull(_asString(claims['wh'])),
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _saveTokens(Map<String, dynamic> json, {String? empId}) =>
      store.write(
        accessToken: _requireString(json['accessToken'], 'accessToken'),
        refreshToken: _requireString(json['refreshToken'], 'refreshToken'),
        empId: empId,
      );

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, dynamic> body,
  ) async =>
      _asMap(await api.post(path, body: body), path);

  /// อ่าน claims จาก payload ของ JWT (ไม่ verify — server เป็นผู้ตรวจ)
  /// ⚠️ ห้าม log ค่าที่ได้จากฟังก์ชันนี้พร้อม token
  static Map<String, dynamic> _jwtClaims(String token) {
    final parts = token.split('.');
    if (parts.length != 3) return const {};
    try {
      final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
      final decoded = jsonDecode(payload);
      return decoded is Map<String, dynamic> ? decoded : const {};
    } catch (_) {
      return const {};
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// MembersRepository
// ════════════════════════════════════════════════════════════════════

class MembersRepository {
  const MembersRepository({required this.api});

  final ApiClient api;

  /// รายชื่อสมาชิกทั้งหมด — กะที่ยังไม่กำหนดแสดงเป็น 'ยังไม่กำหนดกะ'
  Future<List<Member>> list() async {
    final raw = await api.get('/members');
    return _asList(raw, '/members')
        .map((e) => _memberFromJson(_asMap(e, '/members[]')))
        .toList(growable: false);
  }

  /// เปลี่ยนสิทธิ์ (admin) — mutation เดียวที่แอปทำกับสมาชิกได้
  ///
  /// ⚠️ ไม่มี `add` / `resetPin` แล้ว: ชื่อผู้ใช้และรหัสผ่านเป็นของ ERP
  /// (`POST /members` และ `POST /members/:empId/reset-pin` ถูกลบทิ้งฝั่ง server)
  Future<void> changeRole({required String empId, required Role role}) async {
    await api.patch(
      '/members/${Uri.encodeComponent(empId)}/role',
      body: {'role': _roleToApi(role)},
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// Mapping helpers
// ════════════════════════════════════════════════════════════════════

Member _memberFromJson(Map<String, dynamic> json) => Member(
      name: _asString(json['name']),
      empId: _requireString(json['empId'], 'empId'),
      shift: _shiftOrDefault(json['shift']),
      role: _roleFromApi(json['role']),
    );

/// `user_role` ฝั่ง Postgres/API เป็นตัวพิมพ์เล็ก: admin | staff | viewer
/// ค่าที่ไม่รู้จัก = viewer (least privilege — กันเขียนทับข้อมูลเมื่อสัญญา drift)
Role _roleFromApi(Object? raw) => switch (_asString(raw).toLowerCase()) {
      'admin' => Role.admin,
      'staff' => Role.staff,
      _ => Role.viewer,
    };

String _roleToApi(Role role) => switch (role) {
      Role.admin => 'admin',
      Role.staff => 'staff',
      Role.viewer => 'viewer',
    };

String _shiftOrDefault(Object? raw) {
  final s = _asString(raw).trim();
  return s.isEmpty ? _kUnassignedShift : s;
}

String _asString(Object? raw) => raw is String ? raw : '';

/// ช่องว่างล้วน/สตริงว่าง = "ไม่มีค่า" ไม่ใช่ค่าที่เอาไปต่อท้ายคำว่า 'คลัง' ได้
String? _emptyToNull(String raw) {
  final s = raw.trim();
  return s.isEmpty ? null : s;
}

/// ฟิลด์ที่ขาดไม่ได้ — ผิดสัญญา backend ถือเป็นบั๊ก ไม่ใช่ error ที่ผู้ใช้แก้ได้
/// (ข้อความเป็นภาษาอังกฤษโดยเจตนา: dev-facing ไม่ใช่ข้อความบน UI
///  และไม่มีค่าของฟิลด์อยู่ในข้อความ — กันความลับหลุดลง log)
String _requireString(Object? raw, String field) {
  final s = _asString(raw);
  if (s.isEmpty) throw FormatException('missing field: $field');
  return s;
}

Map<String, dynamic> _asMap(Object? raw, [String where = 'response']) {
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return raw.cast<String, dynamic>();
  throw FormatException('expected JSON object at $where');
}

List<Object?> _asList(Object? raw, [String where = 'response']) {
  if (raw is List) return raw;
  throw FormatException('expected JSON array at $where');
}

// ════════════════════════════════════════════════════════════════════
// Providers
// ════════════════════════════════════════════════════════════════════

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(
    api: ref.watch(apiClientProvider),
    store: ref.watch(tokenStoreProvider),
  ),
);

final membersRepositoryProvider = Provider<MembersRepository>(
  (ref) => MembersRepository(api: ref.watch(apiClientProvider)),
);
