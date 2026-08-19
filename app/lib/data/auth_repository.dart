import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'models.dart';

/// Repository ชั้น auth + members — **ผู้ใช้เป็นของระบบเราเอง ไม่ดึงจาก ERP**
///
/// กติกาของไฟล์นี้:
/// - ไม่แปลข้อความ error เอง: backend ส่ง `message` เป็นภาษาไทยตาม design มาแล้ว
///   ชั้นนี้ปล่อย [ApiException] ขึ้นไปให้ UI แสดงตามที่ได้รับ
/// - ⚠️ **ห้าม log PIN / initialPin / token** ไม่ว่ากรณีใด (เครื่องคลังใช้ร่วมกัน)
/// - token ทั้งหมดอยู่ใน TokenStore (flutter_secure_storage) เท่านั้น

/// เวอร์ชันแอปที่ส่งไปกับ login (ตรงกับ `version:` ใน pubspec.yaml)
const String _kAppVersion = '4.0.0';

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
    required this.mustChangePin,
  });

  final String empId;
  final String name;
  final Role role;

  /// กะ — `null` จาก server ถูกแทนด้วย 'ยังไม่กำหนดกะ' แล้ว
  final String shift;
  final String warehouseCode;

  /// true = ต้องตั้ง PIN ใหม่ก่อนใช้งาน (PIN เริ่มต้นจาก admin หรือถูก reset)
  final bool mustChangePin;

  factory UserProfile.fromJson(Map<String, dynamic> json) => UserProfile(
        empId: _requireString(json['empId'], 'empId'),
        name: _asString(json['name']),
        role: _roleFromApi(json['role']),
        shift: _shiftOrDefault(json['shift']),
        warehouseCode: _asString(json['warehouseCode']),
        mustChangePin: json['mustChangePin'] == true,
      );

  /// แปลงเป็น [Member] เพื่อใช้ร่วมกับรายชื่อสมาชิกในหน้า Team
  Member toMember() =>
      Member(name: name, empId: empId, shift: shift, role: role);

  UserProfile copyWith({bool? mustChangePin}) => UserProfile(
        empId: empId,
        name: name,
        role: role,
        shift: shift,
        warehouseCode: warehouseCode,
        mustChangePin: mustChangePin ?? this.mustChangePin,
      );
}

/// ผลของการเข้าสู่ระบบสำเร็จ
@immutable
class LoginResult {
  const LoginResult({required this.user, required this.mustChangePin});

  final UserProfile user;

  /// เท่ากับ `user.mustChangePin` — แยกออกมาให้ชั้น routing อ่านง่าย
  final bool mustChangePin;
}

/// ผลของการเพิ่มสมาชิก — `initialPin` แสดงให้ admin เห็น **ครั้งเดียว**
@immutable
class AddMemberResult {
  const AddMemberResult({required this.member, required this.initialPin});

  final Member member;

  /// ⚠️ PIN เริ่มต้นที่ server สุ่มให้ — ห้าม log ห้ามเก็บลง storage
  final String initialPin;
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
      'appVersion': _kAppVersion,
    });
    await _saveTokens(json);
    final user = UserProfile.fromJson(_asMap(json['user'], '/auth/login.user'));
    return LoginResult(user: user, mustChangePin: user.mustChangePin);
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

  /// ตั้ง PIN ใหม่ — ใช้ทั้งกรณีบังคับครั้งแรก (mustChangePin) และเปลี่ยนตามปกติ
  Future<void> changePin({
    required String currentPin,
    required String newPin,
  }) async {
    await api.post('/auth/change-pin', body: {
      'currentPin': currentPin,
      'newPin': newPin,
    });
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
        warehouseCode: _asString(claims['wh']),
        // refresh ไม่ส่ง mustChangePin กลับมา — ถ้ายังต้องเปลี่ยน PIN
        // endpoint ที่ถูก gate จะตอบ MUST_CHANGE_PIN ให้ UI พาไปตั้ง PIN เอง
        mustChangePin: false,
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

  /// เพิ่มสมาชิก (admin) — คืน PIN เริ่มต้นที่ server สุ่มให้ **แสดงครั้งเดียว**
  Future<AddMemberResult> add({
    required String empId,
    required String name,
    required Role role,
    String? shift,
  }) async {
    final body = <String, dynamic>{
      'empId': empId,
      'name': name,
      'role': _roleToApi(role),
    };
    final trimmedShift = shift?.trim();
    if (trimmedShift != null && trimmedShift.isNotEmpty) {
      body['shift'] = trimmedShift;
    }
    final json = _asMap(await api.post('/members', body: body), '/members');
    return AddMemberResult(
      member: _memberFromJson(json),
      initialPin: _requireString(json['initialPin'], 'initialPin'),
    );
  }

  /// เปลี่ยนสิทธิ์ (admin)
  Future<void> changeRole({required String empId, required Role role}) async {
    await api.patch(
      '/members/${Uri.encodeComponent(empId)}/role',
      body: {'role': _roleToApi(role)},
    );
  }

  /// รีเซ็ต PIN (admin) — คืน PIN เริ่มต้นใหม่ **แสดงครั้งเดียว**
  /// ใช้แทน unlock ด้วย: ไม่มี endpoint `/auth/unlock/:empId`
  Future<String> resetPin(String empId) async {
    final json = _asMap(
      await api.post('/members/${Uri.encodeComponent(empId)}/reset-pin'),
      '/members/:empId/reset-pin',
    );
    return _requireString(json['initialPin'], 'initialPin');
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
