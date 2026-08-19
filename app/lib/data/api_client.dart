/// ชั้นเชื่อมต่อ backend ของแอป — dio + เก็บ token + refresh อัตโนมัติ
///
/// สัญญา API อยู่ที่ `server/docs/` (NestJS, ไม่มี global prefix):
/// `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout`
/// `POST /auth/change-pin` · `GET|POST /members` · `PATCH /members/:empId/role`
/// `POST /members/:empId/reset-pin`
///
/// ข้อความ error ไทยมาจาก backend (`{code, message}`) — ชั้นนี้ไม่แปลใหม่
/// มีเพียงข้อความ fallback ตอน transport พังจนไม่มี body ให้อ่าน
///
/// ⚠️ ห้าม log token/PIN ที่ไฟล์นี้ (ไม่ติดตั้ง LogInterceptor โดยเจตนา)
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

// ─────────────────────────────────────────────────────────────────────
// 1. ApiConfig
// ─────────────────────────────────────────────────────────────────────

/// ค่า build-time ของ backend — ตั้งตอน build ด้วย `--dart-define`
///
/// ```sh
/// flutter build apk --dart-define=API_BASE_URL=http://10.0.1.20:3000
/// ```
///
/// ถ้าไม่ตั้ง `API_BASE_URL` แอปอยู่ในโหมด offline/fixture
/// ([isConfigured] = false) — ชั้น state ใช้ `Fixtures` ต่อไปได้ตามปกติ
class ApiConfig {
  const ApiConfig._();

  /// base URL ของ backend เช่น `http://10.0.1.20:3000` (ไม่ต้องมี `/` ปิดท้าย)
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: '',
  );

  /// เวอร์ชันแอปที่ส่งไปกับ `POST /auth/login` (backend เทียบ `APP_MIN_VERSION`)
  static const String appVersion = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: '4.0.0',
  );

  /// true = ต่อ backend จริง · false = โหมด offline/fixture
  static bool get isConfigured => baseUrl.trim().isNotEmpty;

  static const Duration connectTimeout = Duration(seconds: 15);
  static const Duration receiveTimeout = Duration(seconds: 30);
}

// ─────────────────────────────────────────────────────────────────────
// 2. TokenStore
// ─────────────────────────────────────────────────────────────────────

/// เก็บ token / empId / deviceId ใน keychain-keystore (flutter_secure_storage)
///
/// ⚠️ ห้ามย้ายไป SharedPreferences — เครื่องคลังใช้ร่วมกันหลายกะ
///
/// `deviceId` **คงอยู่ข้าม sign-out** เพราะ refresh token ฝั่ง backend ผูกกับ
/// device (มี reuse detection) — เครื่องเดียวกันต้องได้ id เดิมตลอดอายุการติดตั้ง
class TokenStore {
  TokenStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              // ต้องอ่านได้หลังรีบูตก่อนปลดล็อก (ส่งงานนับค้างตอนเปิดกะ)
              // และไม่ย้ายเครื่องตาม iCloud keychain — deviceId ต้องผูกเครื่องจริง
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
              mOptions: MacOsOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
            );

  final FlutterSecureStorage _storage;

  static const String _kAccessToken = 'kk.accessToken';
  static const String _kRefreshToken = 'kk.refreshToken';
  static const String _kEmpId = 'kk.empId';
  static const String _kDeviceId = 'kk.deviceId';

  /// cache เฉพาะ deviceId (ค่าคงที่ตลอดอายุการติดตั้ง) — token ไม่ cache
  /// เพื่อให้ค่าที่อ่านได้เป็นความจริงล่าสุดเสมอตอนเทียบ token ใน interceptor
  String? _deviceId;
  Future<String>? _deviceIdInFlight;

  Future<String?> readAccessToken() => _storage.read(key: _kAccessToken);

  Future<String?> readRefreshToken() => _storage.read(key: _kRefreshToken);

  /// empId ที่ login ล่าสุด — ใช้เติมช่องรหัสพนักงานตอน session หมดอายุ
  Future<String?> readEmpId() => _storage.read(key: _kEmpId);

  Future<bool> hasSession() async {
    final refresh = await readRefreshToken();
    return refresh != null && refresh.isNotEmpty;
  }

  /// เขียนคู่ token (และ empId ถ้าส่งมา) — เรียกหลัง login และหลัง refresh
  Future<void> write({
    required String accessToken,
    required String refreshToken,
    String? empId,
  }) async {
    await _storage.write(key: _kAccessToken, value: accessToken);
    await _storage.write(key: _kRefreshToken, value: refreshToken);
    if (empId != null && empId.isNotEmpty) {
      await _storage.write(key: _kEmpId, value: empId);
    }
  }

  Future<void> writeEmpId(String empId) =>
      _storage.write(key: _kEmpId, value: empId);

  /// ล้าง token + empId — **คง deviceId ไว้** (device binding ฝั่ง backend)
  Future<void> clear() async {
    await _storage.delete(key: _kAccessToken);
    await _storage.delete(key: _kRefreshToken);
    await _storage.delete(key: _kEmpId);
  }

  /// deviceId ของเครื่องนี้ — สร้าง UUID v4 ครั้งแรกแล้วเก็บถาวร
  ///
  /// single-flight: เรียกพร้อมกันหลายเส้นต้องได้ id เดียวกัน (ไม่สร้างซ้อน)
  Future<String> getDeviceId() {
    final cached = _deviceId;
    if (cached != null) return Future<String>.value(cached);
    return _deviceIdInFlight ??= _loadOrCreateDeviceId().whenComplete(() {
      _deviceIdInFlight = null;
    });
  }

  Future<String> _loadOrCreateDeviceId() async {
    final existing = await _storage.read(key: _kDeviceId);
    if (existing != null && existing.isNotEmpty) {
      _deviceId = existing;
      return existing;
    }
    final created = _newUuidV4();
    await _storage.write(key: _kDeviceId, value: created);
    _deviceId = created;
    return created;
  }

  /// UUID v4 จาก `Random.secure()` (ไม่พึ่ง package เพิ่ม)
  static String _newUuidV4() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    String hex(int start, int end) => bytes
        .sublist(start, end)
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. ApiException
// ─────────────────────────────────────────────────────────────────────

/// error ก้อนเดียวที่ชั้น UI ต้องรู้จัก
///
/// [message] มาจาก backend ตรง ๆ เมื่ออ่าน body ได้ (ตรงตาม design แล้ว)
/// ถ้าอ่านไม่ได้ → [code] = [codeNetwork] และ [message] = [networkMessage]
@immutable
class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.statusCode,
    this.retryAfterMs,
  });

  /// transport พัง / body อ่านไม่ได้
  factory ApiException.network([int? statusCode]) => ApiException(
        code: codeNetwork,
        message: networkMessage,
        statusCode: statusCode,
      );

  /// refresh ไม่สำเร็จ — ชั้นบนต้องพา user กลับหน้า login
  factory ApiException.sessionExpired({String? message, int? statusCode}) =>
      ApiException(
        code: codeSessionExpired,
        message: (message != null && message.isNotEmpty)
            ? message
            : sessionExpiredMessage,
        statusCode: statusCode,
      );

  /// แปลง [DioException] → [ApiException] โดยอ่าน body `{code, message, retryAfterMs}`
  factory ApiException.fromDio(DioException error) {
    // interceptor ห่อ ApiException ไว้ใน DioException.error (เช่น SESSION_EXPIRED)
    final inner = error.error;
    if (inner is ApiException) return inner;

    final status = error.response?.statusCode;
    final body = _decodeBody(error.response?.data);
    final rawCode = body?['code'];
    if (rawCode is String && rawCode.isNotEmpty) {
      final rawMessage = body?['message'];
      final rawRetry = body?['retryAfterMs'];
      return ApiException(
        code: rawCode,
        message: (rawMessage is String && rawMessage.isNotEmpty)
            ? rawMessage
            : networkMessage,
        statusCode: status,
        retryAfterMs: rawRetry is num ? rawRetry.toInt() : null,
      );
    }
    return ApiException.network(status);
  }

  /// HTTP status (null = ไม่ได้คำตอบจาก server เลย)
  final int? statusCode;

  /// code จาก backend เช่น `UNKNOWN_EMPLOYEE` `INVALID_PIN` `THROTTLED`
  /// หรือ code ของชั้นนี้: [codeNetwork] [codeSessionExpired] [codeNotConfigured]
  final String code;

  /// ข้อความไทยที่แสดงได้ทันที
  final String message;

  /// เวลาที่ต้องรอก่อนลองใหม่ (มาจาก `THROTTLED`)
  final int? retryAfterMs;

  // ── code ของชั้นนี้ (backend ไม่ได้ส่งมา) ──
  static const String codeNetwork = 'NETWORK';
  static const String codeSessionExpired = 'SESSION_EXPIRED';
  static const String codeNotConfigured = 'NOT_CONFIGURED';

  // ── code ที่ backend ส่ง (ให้ชั้น UI อ้างอิงแทนการพิมพ์ string เอง) ──
  static const String codeUnknownEmployee = 'UNKNOWN_EMPLOYEE';
  static const String codeInvalidPin = 'INVALID_PIN';
  static const String codeThrottled = 'THROTTLED';
  static const String codeMustChangePin = 'MUST_CHANGE_PIN';
  static const String codeInsufficientRole = 'INSUFFICIENT_ROLE';

  /// fallback เดียวของชั้น transport
  static const String networkMessage = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';

  /// ใช้เมื่อ backend ไม่ได้ส่ง message มากับ refresh ที่ล้มเหลว
  /// (ตรงกับ `AUTH_ERROR_MESSAGE_TH.INVALID_REFRESH` ฝั่ง server)
  static const String sessionExpiredMessage = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';

  bool get isSessionExpired => code == codeSessionExpired;
  bool get isThrottled => code == codeThrottled;
  bool get isNetwork => code == codeNetwork || code == codeNotConfigured;

  /// วินาทีที่ต้องรอ (ปัดขึ้น) — ใช้กับ copy "ลองใหม่ใน {n} วินาที"
  int? get retryAfterSeconds =>
      retryAfterMs == null ? null : (retryAfterMs! / 1000).ceil();

  static Map<String, dynamic>? _decodeBody(Object? data) {
    if (data is Map) {
      return data.map((key, value) => MapEntry(key.toString(), value));
    }
    if (data is String && data.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(data);
        if (decoded is Map) {
          return decoded.map((key, value) => MapEntry(key.toString(), value));
        }
      } on FormatException {
        return null;
      }
    }
    return null;
  }

  @override
  String toString() =>
      'ApiException($code${statusCode == null ? '' : ' · $statusCode'}): $message';
}

// ─────────────────────────────────────────────────────────────────────
// 4. ApiClient
// ─────────────────────────────────────────────────────────────────────

/// dio ตัวกลางของแอป — แนบ Bearer, refresh อัตโนมัติ, แปลง error เป็น [ApiException]
///
/// พฤติกรรม 401:
/// - path `/auth/*` → ปล่อยผ่าน (401 ของ `change-pin` คือ PIN ผิด ไม่ใช่ token หมดอายุ)
/// - path อื่น → refresh หนึ่งรอบร่วมกันทุกเส้น แล้ว **retry request เดิมครั้งเดียว**
/// - refresh ล้ม → ล้าง token + โยน [ApiException] code [ApiException.codeSessionExpired]
class ApiClient {
  ApiClient({required TokenStore tokenStore, Dio? dio, Dio? refreshDio})
      : _tokens = tokenStore,
        _dio = dio ?? Dio(_baseOptions()),
        _refreshDio = refreshDio ?? Dio(_baseOptions()) {
    _dio.interceptors.add(
      InterceptorsWrapper(onRequest: _onRequest, onError: _onError),
    );
  }

  final TokenStore _tokens;

  /// dio หลัก (มี interceptor)
  final Dio _dio;

  /// dio เปล่าเฉพาะ `POST /auth/refresh` — กัน recursion กับ interceptor
  final Dio _refreshDio;

  /// refresh ที่กำลังวิ่ง — ทุกเส้นที่เจอ 401 พร้อมกันต้องรอ future เดียวกัน
  /// (backend มี reuse detection: ยิง refresh ซ้อนกัน = ถูกตัดทั้ง session)
  Future<String>? _refreshInFlight;

  static const String _authHeader = 'Authorization';
  static const String _retriedKey = 'kk.retried';

  /// false = ไม่ได้ตั้ง `API_BASE_URL` → แอปอยู่โหมด offline/fixture
  bool get isConfigured => ApiConfig.isConfigured;

  TokenStore get tokenStore => _tokens;

  static BaseOptions _baseOptions() => BaseOptions(
        baseUrl: ApiConfig.baseUrl,
        connectTimeout: ApiConfig.connectTimeout,
        receiveTimeout: ApiConfig.receiveTimeout,
        sendTimeout: ApiConfig.receiveTimeout,
        contentType: Headers.jsonContentType,
        responseType: ResponseType.json,
        headers: const {'Accept': Headers.jsonContentType},
      );

  // ── public API ────────────────────────────────────────────────────

  Future<T> get<T>(
    String path, {
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) =>
      _send<T>('GET', path, query: query, cancelToken: cancelToken);

  Future<T> post<T>(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) =>
      _send<T>('POST', path, body: body, query: query, cancelToken: cancelToken);

  Future<T> patch<T>(
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) =>
      _send<T>(
        'PATCH',
        path,
        body: body,
        query: query,
        cancelToken: cancelToken,
      );

  void close() {
    _dio.close(force: true);
    _refreshDio.close(force: true);
  }

  // ── internals ─────────────────────────────────────────────────────

  Future<T> _send<T>(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) async {
    if (!isConfigured) {
      throw ApiException(
        code: ApiException.codeNotConfigured,
        message: ApiException.networkMessage,
      );
    }
    try {
      final res = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        cancelToken: cancelToken,
        options: Options(method: method),
      );
      final data = res.data;
      if (data is T) return data;
      // 204 (data = null) และ T = void/dynamic ผ่านทางนี้
      return data as T;
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    } on TypeError {
      // body รูปร่างไม่ตรงกับที่ชั้นบนคาด — ปฏิบัติเหมือน server ตอบเสีย
      throw ApiException.network();
    }
  }

  Future<void> _onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (!_isTokenFreePath(options.path)) {
      final token = await _tokens.readAccessToken();
      if (token != null && token.isNotEmpty) {
        options.headers[_authHeader] = 'Bearer $token';
      }
    }
    handler.next(options);
  }

  Future<void> _onError(
    DioException error,
    ErrorInterceptorHandler handler,
  ) async {
    final options = error.requestOptions;
    final isRetry = options.extra[_retriedKey] == true;
    if (error.response?.statusCode != 401 ||
        _isAuthPath(options.path) ||
        isRetry) {
      if (isRetry && error.response?.statusCode == 401) {
        // token ใหม่ก็ยังไม่ผ่าน → session ใช้ไม่ได้จริง
        await _tokens.clear();
        handler.reject(
          _wrap(
            error,
            ApiException.sessionExpired(statusCode: error.response?.statusCode),
          ),
        );
        return;
      }
      handler.next(error);
      return;
    }

    try {
      final sent = options.headers[_authHeader];
      final current = await _tokens.readAccessToken();
      final String token;
      if (current != null && current.isNotEmpty && sent != 'Bearer $current') {
        // เส้นอื่น refresh สำเร็จไปแล้วระหว่างที่ request นี้ค้างอยู่ — ใช้ของใหม่เลย
        token = current;
      } else {
        token = await _refreshOnce();
      }
      final retryOptions = options
        ..headers[_authHeader] = 'Bearer $token'
        ..extra[_retriedKey] = true;
      handler.resolve(await _dio.fetch<dynamic>(retryOptions));
    } on ApiException catch (failure) {
      handler.reject(_wrap(error, failure));
    } on DioException catch (failure) {
      handler.reject(failure);
    }
  }

  /// refresh รอบเดียวร่วมกันทุกเส้น — คืน accessToken ใหม่
  Future<String> _refreshOnce() {
    return _refreshInFlight ??= _refresh().whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<String> _refresh() async {
    final refreshToken = await _tokens.readRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      await _tokens.clear();
      throw ApiException.sessionExpired();
    }
    final deviceId = await _tokens.getDeviceId();
    try {
      final res = await _refreshDio.post<dynamic>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken, 'deviceId': deviceId},
      );
      final data = res.data;
      final access = data is Map ? data['accessToken'] : null;
      final refresh = data is Map ? data['refreshToken'] : null;
      if (access is! String ||
          access.isEmpty ||
          refresh is! String ||
          refresh.isEmpty) {
        await _tokens.clear();
        throw ApiException.sessionExpired();
      }
      await _tokens.write(accessToken: access, refreshToken: refresh);
      return access;
    } on DioException catch (error) {
      await _tokens.clear();
      final mapped = ApiException.fromDio(error);
      // 4xx = refresh token ใช้ไม่ได้ (หมดอายุ / ถูก reuse / role เปลี่ยน)
      // 5xx หรือ timeout = server/เครือข่ายมีปัญหา — คง code เดิมไว้ให้ชั้นบนแยกออก
      final status = mapped.statusCode;
      if (status != null && status >= 400 && status < 500) {
        throw ApiException.sessionExpired(
          message: mapped.message == ApiException.networkMessage
              ? null
              : mapped.message,
          statusCode: status,
        );
      }
      throw mapped;
    }
  }

  static DioException _wrap(DioException source, ApiException failure) =>
      DioException(
        requestOptions: source.requestOptions,
        response: source.response,
        type: source.type,
        error: failure,
      );

  /// `/auth/login` และ `/auth/refresh` ไม่ต้องแนบ Bearer
  static bool _isTokenFreePath(String path) {
    final p = _normalize(path);
    return p.endsWith('/auth/login') || p.endsWith('/auth/refresh');
  }

  /// ทุก path ใต้ `/auth/` ไม่เข้ากลไก refresh อัตโนมัติ
  /// (401 ของ `change-pin` = PIN ปัจจุบันผิด ไม่ใช่ token หมดอายุ)
  static bool _isAuthPath(String path) => _normalize(path).contains('/auth/');

  static String _normalize(String path) {
    final withoutQuery = path.split('?').first;
    return withoutQuery.startsWith('/') ? withoutQuery : '/$withoutQuery';
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. providers
// ─────────────────────────────────────────────────────────────────────

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(tokenStore: ref.watch(tokenStoreProvider));
  ref.onDispose(client.close);
  return client;
});
