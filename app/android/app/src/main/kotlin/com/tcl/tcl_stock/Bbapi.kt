package com.tcl.tcl_stock

/**
 * ค่าคงที่ของ Bluebird BBAPI — **จุดเดียวในโปรเจกต์ที่สตริงพวกนี้มีอยู่**
 *
 * ตั้งใจแยกเป็นไฟล์ของตัวเอง เพราะทุกค่าที่นี่คือ "สัญญากับเฟิร์มแวร์ของเครื่อง"
 * ที่เราแก้เองไม่ได้และทดสอบบนเครื่องอื่นไม่ได้ ถ้ารุ่นถัดไปเปลี่ยนชื่อ action
 * จะได้แก้จบในไฟล์เดียว ไม่ต้องไล่ล่าสตริงกระจายทั้ง MainActivity
 *
 * ── ที่มาของแต่ละค่า (ยืนยันแล้ว ไม่ได้เดา) ──────────────────────────────
 * เทียบตัวอักษรต่อตัวอักษรกับซอร์สสองแหล่งที่เป็นอิสระต่อกัน:
 *
 * 1. `Constants.java` / `BBAPI.java` ของชุดตัวอย่าง Bluebird เอง
 *    (หัวไฟล์ระบุ "Copyright(c) 2013 Bluebird Inc. All rights reserved.")
 *    สำเนาที่ตรวจ: github.com/MartinaMamdouh/scannerProject
 *    → `android/app/src/main/java/com/onlineticketgate/{Constants,BBAPI}.java`
 *    ไฟล์นี้พิมพ์ผลลัพธ์เป็น "[BarcodeDecodingData handle : n / count : n /
 *    seq : n]" ซึ่งตรงกับสิ่งที่แอป "Barcode Test" บน S20 แสดงออกมาเป๊ะ ๆ
 *    จึงมั่นใจได้ว่าเป็นชุดเดียวกับที่เครื่องหน้างานใช้จริง
 *
 * 2. `BluebirdScanner.java` ของโครงการ enioka_scan (ใช้งานจริงในระบบคลังสินค้า)
 *    github.com/enioka-Haute-Couture/enioka_scan
 *
 * ทุกค่าในไฟล์นี้ตรงกันทั้งสองแหล่ง — ไม่มีค่าไหนที่ยังเดาอยู่
 */
object Bbapi {
    /** เปิดโมดูลบาร์โค้ด — ต้องเปิดก่อน callback ถึงจะถูกกระจายออกมา */
    const val ACTION_BARCODE_OPEN = "kr.co.bluebird.android.bbapi.action.BARCODE_OPEN"

    /**
     * ปิดโมดูลบาร์โค้ด — **แอปนี้ไม่เคยส่ง** (ดูเหตุผลที่ `MainActivity`)
     *
     * เก็บชื่อไว้ที่นี่เพื่อให้คนที่มาอ่านทีหลังเห็นว่า "รู้จักแต่จงใจไม่ใช้"
     * ไม่ใช่ "ลืมทำ" — Bluebird ระบุว่าการเปิดโมดูลที่ปิดอยู่กินเวลา 2-3 วินาที
     * กว่าลำแสงจะติด ปิดทุกครั้งที่ออกจากจอ = ไกเครื่องจะรู้สึกเหมือนเสีย
     */
    const val ACTION_BARCODE_CLOSE = "kr.co.bluebird.android.bbapi.action.BARCODE_CLOSE"

    /**
     * สั่งลำแสงติด/ดับจาก **ซอฟต์แวร์** (`EXTRA_INT_DATA2` = 1 ติด / 0 ดับ)
     *
     * **แอปนี้ไม่เคยส่งเช่นกัน** — คลังใช้วิธีเหนี่ยวไกที่ตัวเครื่อง ซึ่งทำงานเอง
     * ได้ทันทีที่โมดูลเปิด (ยืนยันหน้างาน: ไกดังบี๊บอยู่แล้วโดยที่แอปเรายังไม่ได้
     * ส่งอะไรเลย) การส่ง 1 คือการจุดลำแสงค้างไว้เอง ไม่ใช่การ "เปิดใช้ไก"
     * และการส่ง 0 มีโอกาสไปดับลำแสงที่ผู้ใช้กำลังเหนี่ยวไกเรียกอยู่
     */
    const val ACTION_BARCODE_SET_TRIGGER = "kr.co.bluebird.android.bbapi.action.BARCODE_SET_TRIGGER"

    /** ผลการอ่านสำเร็จ — เส้นทางที่บาร์โค้ดวิ่งเข้าแอปเรา */
    const val ACTION_BARCODE_CALLBACK_DECODING_DATA =
        "kr.co.bluebird.android.bbapi.action.BARCODE_CALLBACK_DECODING_DATA"

    /** คำสั่งที่เพิ่งส่งไปล้มเหลว — รหัสเหตุผลอยู่ใน `EXTRA_INT_DATA2` */
    const val ACTION_BARCODE_CALLBACK_REQUEST_FAILED =
        "kr.co.bluebird.android.bbapi.action.BARCODE_CALLBACK_REQUEST_FAILED"

    /** เนื้อบาร์โค้ดที่ถอดรหัสแล้ว — เป็น `byte[]` ไม่ใช่ String */
    const val EXTRA_BARCODE_DECODING_DATA = "EXTRA_BARCODE_DECODING_DATA"

    /**
     * ช่องอเนกประสงค์ที่ความหมายเปลี่ยนตาม action ที่มันติดมาด้วย:
     * - `CALLBACK_DECODING_DATA` → รหัส symbology (EAN13 = 5 · CODE128 = 10)
     * - `CALLBACK_REQUEST_FAILED` → รหัสความผิดพลาด (ดู `ERROR_*` ข้างล่าง)
     * - `SET_TRIGGER` → 1 ติด / 0 ดับ
     */
    const val EXTRA_INT_DATA2 = "EXTRA_INT_DATA2"

    /** หมายเลขลำดับคำขอ — ส่งไปกับคำสั่ง แล้วเด้งกลับมาใน callback คู่กัน */
    const val EXTRA_INT_DATA3 = "EXTRA_INT_DATA3"

    /** ลำดับที่ติดไปกับ `BARCODE_OPEN` ของเรา — ใช้แยกว่า callback ตอบคำสั่งไหน */
    const val SEQ_OPEN = 100

    /** โมดูลเปิดค้างอยู่แล้ว — ไม่ใช่ความผิดพลาดสำหรับเรา (เราสั่งเปิดซ้ำได้เสมอ) */
    const val ERROR_BARCODE_ALREADY_OPENED = -8

    /**
     * กล้องยึดตัวรับภาพไว้อยู่ เครื่องยิงจึงเปิดไม่ได้
     *
     * ตรงกับเคสที่ `_setCamera` ฝั่ง Dart กันไว้ (กล้อง native ที่ปิดไม่ลง)
     * — จอสแกนแจ้งผู้ใช้ผ่าน `CamStatus.detectorUnavailable` อยู่แล้ว
     */
    const val ERROR_BARCODE_CAMERA_USED = -9
}
