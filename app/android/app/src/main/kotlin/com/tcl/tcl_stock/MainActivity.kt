package com.tcl.tcl_stock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * จอหลักของแอป + สะพานรับบาร์โค้ดจาก **intent broadcast** ของ Bluebird BBAPI
 *
 * ── ทำไมต้องมีเส้นทางนี้ ────────────────────────────────────────────────
 * เดิมแอปฟังบาร์โค้ดทาง **คีย์บอร์ด** อย่างเดียว (keyboard wedge: เครื่องยิง
 * ทำตัวเป็นคีย์บอร์ดแล้ว "พิมพ์" รหัสลงจอ) แต่ Bluebird S20 หน้างานถูกตั้งค่าให้
 * ส่งผลอ่านเป็น broadcast แทน — เหนี่ยวไกแล้วบี๊บ (เอนจินถอดรหัสสำเร็จ) แต่ไม่มี
 * คีย์สักตัวเข้าแอป จอจึงเงียบสนิททั้งที่เครื่องอ่านได้
 *
 * ไฟล์นี้เพิ่ม **เส้นทางที่สอง** ไม่ใช่มาแทนของเดิม — เครื่องบางตัวในคลังยังตั้ง
 * เป็น keyboard wedge อยู่ ทั้งสองทางต้องทำงานพร้อมกันได้ (ด่านดีดัพฝั่ง Dart
 * กันไม่ให้ฉลากใบเดียวถูกนับสองครั้ง ดู `_ScanSource` ใน scan_screen.dart)
 *
 * ── ทำไมเป็น MethodChannel ไม่ใช่ EventChannel ─────────────────────────
 * `EventChannel.receiveBroadcastStream()` ต้อง "โทรหา" ฝั่ง native ตอนเริ่มฟัง
 * บนเครื่องที่ไม่มีฝั่ง native (macOS · Chrome · เทสต์ · Android ที่ไม่ใช่ Bluebird)
 * สายนั้นไม่มีใครรับ — วัดจริงแล้วเทสต์ **ค้างยาว 10 นาทีจนหมดเวลา** ไม่ใช่แค่
 * โยน error ให้จับ · MethodChannel ที่ฝั่ง native เป็นคนเรียกเข้ามา (`invokeMethod`
 * ทางกลับ) ไม่ต้องโทรออกเลยตอนติดตั้งตัวรับ ฝั่ง Dart จึงเงียบสนิทเมื่อไม่มี
 * ฝั่ง native — ตรงตามข้อกำหนด "ต้องถอยกลับไปพฤติกรรมเดิมแบบไม่มีเสียง"
 *
 * ── open / close: เปิดแล้วไม่ปิด ────────────────────────────────────────
 * ส่ง `BARCODE_OPEN` ตอนจอสแกนเริ่มฟัง แต่ **ไม่เคยส่ง `BARCODE_CLOSE`** เลย
 * Bluebird ระบุว่าโมดูลที่ถูกปิดไปแล้วต้องใช้เวลา 2-3 วินาทีกว่าลำแสงจะติดอีกครั้ง
 * ถ้าปิดทุกครั้งที่สลับแท็บ พนักงานที่กลับมายิงจะเจอไกที่ "ด้าน" ไปหลายวินาที
 * ซึ่งหน้างานอ่านว่าเครื่องเสีย ไม่ใช่ว่าแอปกำลังประหยัดพลังงาน
 *
 * สิ่งที่หยุดเมื่อออกจากจอคือ **ตัวรับ broadcast ของเรา** (unregister) ไม่ใช่
 * ตัวโมดูล — ผลอ่านที่เกิดตอนแอปอยู่เบื้องหลังจึงไม่ไหลเข้าลิสต์นับเงียบ ๆ
 * ส่วนโมดูลยังเปิดค้างพร้อมยิงตลอด
 *
 * สั่ง `BARCODE_OPEN` ซ้ำได้ไม่ต้องกลัว — ถ้าเปิดอยู่แล้วจะได้ callback
 * `REQUEST_FAILED` รหัส -8 (already opened) ซึ่งเราถือว่าปกติ
 */
class MainActivity : FlutterActivity() {

    /** ช่องคุยกับ Dart — `null` = engine ยังไม่ attach หรือ detach ไปแล้ว */
    private var channel: MethodChannel? = null

    /** ตัวรับลงทะเบียนอยู่หรือยัง — กัน `unregisterReceiver` ซ้ำที่โยน exception */
    private var listening = false

    /**
     * ตัวรับผลอ่านจากโมดูลบาร์โค้ด
     *
     * ลงทะเบียนแบบไม่ระบุ `Handler` = `onReceive` วิ่งบนเมนเธรด ซึ่งเป็นเธรด
     * เดียวกับที่ `MethodChannel.invokeMethod` บังคับ จึงส่งต่อได้ตรงนี้เลย
     */
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Bbapi.ACTION_BARCODE_CALLBACK_DECODING_DATA -> {
                    val code = decode(intent.getByteArrayExtra(Bbapi.EXTRA_BARCODE_DECODING_DATA))
                    if (code.isNotEmpty()) channel?.invokeMethod("barcode", code)
                }
                Bbapi.ACTION_BARCODE_CALLBACK_REQUEST_FAILED -> {
                    // ไม่ส่งต่อให้ Dart โดยตั้งใจ: ผู้ใช้ทำอะไรกับรหัสพวกนี้ไม่ได้
                    // และจอสแกนมีป้ายบอกสถานะกล้องยึดเซ็นเซอร์อยู่แล้ว
                    // (`CamStatus.detectorUnavailable`) — toast ซ้อนอีกชั้นมีแต่กวน
                    when (val err = intent.getIntExtra(Bbapi.EXTRA_INT_DATA2, 0)) {
                        Bbapi.ERROR_BARCODE_ALREADY_OPENED ->
                            Log.d(TAG, "โมดูลบาร์โค้ดเปิดค้างอยู่แล้ว — ไม่ต้องทำอะไร")
                        Bbapi.ERROR_BARCODE_CAMERA_USED ->
                            Log.w(TAG, "กล้องยึดตัวรับภาพไว้ เครื่องยิงจึงเปิดไม่ได้ (-9)")
                        else -> Log.w(TAG, "คำสั่ง BBAPI ล้มเหลว — รหัส $err")
                    }
                }
            }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "startListening" -> {
                    startListening()
                    result.success(null)
                }
                "stopListening" -> {
                    stopListening()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    /** engine ถูกถอด — ตัวรับต้องตายไปพร้อมกัน ไม่งั้นจะยิงใส่ช่องที่ปิดไปแล้ว */
    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        stopListening()
        channel?.setMethodCallHandler(null)
        channel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun startListening() {
        if (!listening) {
            val filter = IntentFilter().apply {
                addAction(Bbapi.ACTION_BARCODE_CALLBACK_DECODING_DATA)
                addAction(Bbapi.ACTION_BARCODE_CALLBACK_REQUEST_FAILED)
            }
            // ต้องเป็น RECEIVER_EXPORTED — ผู้ส่งคือบริการ BBAPI ของ Bluebird
            // ซึ่งเป็นคนละแอปกับเรา ถ้าใส่ NOT_EXPORTED บน targetSdk 33+ ระบบจะ
            // ตัดทิ้งเงียบ ๆ เหมือนไม่ได้ลงทะเบียนอะไรเลย
            ContextCompat.registerReceiver(
                this,
                receiver,
                filter,
                ContextCompat.RECEIVER_EXPORTED,
            )
            listening = true
        }
        // สั่งเปิดโมดูลทุกครั้งที่กลับเข้าจอ ไม่ใช่แค่ครั้งแรก — ระหว่างที่เราไม่ได้ฟัง
        // อาจมีแอปอื่น (หรือกล้องของเราเอง) ปิดมันไป
        sendBroadcast(
            Intent(Bbapi.ACTION_BARCODE_OPEN)
                .putExtra(Bbapi.EXTRA_INT_DATA3, Bbapi.SEQ_OPEN),
        )
    }

    private fun stopListening() {
        if (!listening) return
        listening = false
        try {
            unregisterReceiver(receiver)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "ถอนตัวรับบาร์โค้ดไม่สำเร็จ — $e")
        }
    }

    /**
     * `byte[]` → String
     *
     * **เลือก UTF-8 อย่างจงใจ ไม่ใช่ charset ปริยายของเครื่อง**: ERP ของคลังใช้
     * utf8 และ ASCII เป็นสับเซ็ตแท้ของ UTF-8 ฉลากที่เป็นตัวเลขล้วน (EAN-13 /
     * Code128 ซึ่งเป็นเกือบทั้งหมดของคลัง) จึงถอดออกมาได้ไบต์ต่อไบต์เป๊ะ ๆ
     * ส่วนฉลากที่มีภาษาไทยฝังมาก็ถูกพิมพ์จากข้อมูล utf8 ของ ERP ตัวเดียวกัน
     *
     * ที่ไม่ใช้ `String(bytes)` เปล่า ๆ แบบตัวอย่างของ Bluebird เพราะนั่นอิง
     * charset ปริยายของ JVM ซึ่งเปลี่ยนตามเครื่อง/รุ่น Android — ตัวแปรที่เรา
     * คุมไม่ได้และเห็นผลก็ต่อเมื่อของหน้างานเพี้ยนไปแล้ว
     * (ตัวอย่างของ Bluebird มี fallback เป็น Shift-JIS ด้วย ซึ่งเป็นเรื่องของ
     *  ตลาดญี่ปุ่น ไม่เกี่ยวกับคลังไทย จึงไม่เอามา)
     *
     * ไบต์ที่ไม่ใช่ UTF-8 จะกลายเป็น U+FFFD ตามพฤติกรรมมาตรฐาน — ปล่อยให้ไหลต่อ
     * โดยตั้งใจ: รหัสจะค้นไม่เจอแล้วขึ้น "ไม่พบสินค้า" ให้คนเห็น ดีกว่ากลืนทิ้ง
     * เงียบ ๆ แล้วคนเข้าใจว่าเครื่องไม่อ่าน
     *
     * ตัด `<= ' '` หัวท้าย = เก็บทั้งช่องว่าง อักขระควบคุม และ NUL ที่บางรุ่นเติม
     * เป็น prefix/suffix (`String.trim()` เปล่า ๆ ไม่ตัด NUL ให้)
     */
    private fun decode(bytes: ByteArray?): String =
        bytes?.toString(Charsets.UTF_8)?.trim { it <= ' ' } ?: ""

    private companion object {
        const val CHANNEL = "tcl/bluebird_scan"
        const val TAG = "TclScan"
    }
}
