import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tcl_stock/data/api_client.dart';

/// ทดสอบสัญญาระหว่างแอปกับ backend ที่รันอยู่จริง — **ข้ามอัตโนมัติถ้าไม่มี server**
///
///   API_BASE_URL=http://127.0.0.1:18090 flutter test test/api_contract_test.dart
///
/// ทำไมต้องมี: เทสต์อื่นทั้งหมด mock ชั้น HTTP ทิ้ง จึงจับไม่ได้เลยว่า header
/// ที่ Dio ส่งจริงทำให้ Fastify ปฏิเสธก่อนถึง handler หรือไม่
/// (เคสจริง: `Content-Type: application/json` + body ว่าง → Fastify ตอบ 400
///  "Body cannot be empty" ซึ่งเกิดกับทุก endpoint ที่แอปเรียกแบบไม่มี body)
void main() {
  final baseUrl = Platform.environment['API_BASE_URL'];

  group('สัญญา HTTP ที่ Dio ส่งจริง', () {
    late Dio dio;

    setUpAll(() {
      dio = Dio(
        BaseOptions(
          baseUrl: baseUrl ?? '',
          // ตั้งเหมือน ApiClient จริงเป๊ะ ๆ — จงใจ **ไม่** ตั้ง contentType ที่นี่
          responseType: ResponseType.json,
          headers: const {'Accept': Headers.jsonContentType},
          validateStatus: (_) => true,
        ),
      );
    });

    test(
      '⭐ POST ที่ไม่มี body ต้องไม่ถูกปฏิเสธด้วย 400 "Body cannot be empty"',
      () async {
        // ยิงไปที่ endpoint ที่ต้อง login — เราสนใจแค่ว่า "ไม่ใช่ 400 เพราะ body ว่าง"
        // 401 = ผ่านชั้น body parser มาแล้ว (ดีสำหรับเทสต์นี้)
        //
        // ⚠️ ใช้ `ApiClient.contentTypeFor` ตัวจริงที่ _send() ใช้ — ถ้าใครแก้ตรรกะนั้น
        //    กลับไปส่ง Content-Type เสมอ เทสต์นี้จะแดงทันที
        final res = await dio.post<dynamic>(
          '/sync/items',
          options: Options(contentType: ApiClient.contentTypeFor(null)),
        );

        final body = res.data?.toString() ?? '';
        expect(
          body.contains('Body cannot be empty'),
          isFalse,
          reason:
              'Dio ส่ง Content-Type: application/json พร้อม body ว่าง → Fastify ปฏิเสธ '
              'ก่อนถึง handler · จอผู้ดูแล (ปิดรอบ / sync) จะพังทั้งหมด '
              'ได้ HTTP ${res.statusCode}: $body',
        );
      },
      skip: baseUrl == null ? 'ไม่ได้ตั้ง API_BASE_URL — ข้ามเทสต์ที่ต้องมี server' : null,
    );

    test(
      'POST ที่มี body ปกติยังทำงานได้',
      () async {
        const body = {'empId': '00000', 'pin': '111112', 'deviceId': 'contract-test'};
        final res = await dio.post<dynamic>(
          '/auth/login',
          data: body,
          options: Options(contentType: ApiClient.contentTypeFor(body)),
        );
        // ต้องไปถึง handler (401/404 ก็ได้) ไม่ใช่ 400 จาก body parser
        expect(res.data?.toString() ?? '', isNot(contains('Body cannot be empty')));
      },
      skip: baseUrl == null ? 'ไม่ได้ตั้ง API_BASE_URL — ข้ามเทสต์ที่ต้องมี server' : null,
    );
  });
}
