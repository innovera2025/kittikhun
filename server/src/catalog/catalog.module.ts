import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  InternalServerErrorException,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, Roles } from '../auth/auth.guards';
import { AuthModule } from '../auth/auth.module';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  CatalogService,
  type ItemDto,
  type ItemSearchResult,
  type ItemsDeltaPage,
} from './catalog.service';

/**
 * Catalog — item master ที่ **replicate มาจาก ERP แล้ว** (items_cache + item_barcodes)
 *
 * 🚫 ไฟล์นี้ไม่แตะ ERP เลย — มือถืออ่านผ่าน `items_cache` ใน Postgres ของเราเท่านั้น
 *    (ERP อ่านอย่างเดียวและมีแต่ SyncModule ที่คุยด้วย)
 *
 * ⚠️ cursor ของ delta feed คือ `items_cache.row_version` (bigserial) ไม่ใช่เวลาจาก ERP
 *    → ส่งกลับเป็น **string** เสมอ เพราะ bigint ผ่าน JSON.stringify ไม่ได้
 *
 * สัญญาที่ไฟล์นี้เรียกใช้จาก `./catalog.service.ts`:
 *   getDelta({ warehouseCode, since: bigint, limit }) → ItemsDeltaPage
 *   findByBarcode(barcode, warehouseCode)            → ItemDto | null
 *   search({ warehouseCode, q, limit })              → ItemDto[]
 *   recordScanEvents(ScanEventsIngest)               → { recorded: number }
 */

// ---------------------------------------------------------------------------
// ข้อความ error ที่แอปแสดง (ต้องตรงกับ toast ใน design)
// ---------------------------------------------------------------------------

/** design-fidelity.md §2.2 ตารางสถานะกล้อง: toast "ไม่พบบาร์โค้ดนี้ในคลัง · not found" */
const ITEM_NOT_FOUND_TH = 'ไม่พบบาร์โค้ดนี้ในคลัง · not found';
const INTERNAL_TH = 'ระบบขัดข้อง ลองใหม่อีกครั้ง';

// ---------------------------------------------------------------------------
// zod: ทุกค่าที่มาจากภายนอก (query / param / body)
// ---------------------------------------------------------------------------

/** เพดานของ bigint ใน Postgres — เกินนี้ Postgres จะโยน 22003 ตอนเทียบ row_version */
const MAX_ROW_VERSION = 9223372036854775807n;

/**
 * `?since=` cursor ของ replica
 *
 * ไม่ใช้ `z.coerce.bigint()` เพราะ zod v3 เรียก `BigInt(input)` ตรง ๆ → ค่าขยะทำให้
 * โยน SyntaxError หลุดออกจาก safeParse (กลายเป็น 500 แทน 400) จึงกรองด้วย regex ก่อน
 */
export const SinceSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, 'since ต้องเป็นจำนวนเต็มไม่ติดลบ')
  .transform((raw) => BigInt(raw))
  .refine((value) => value <= MAX_ROW_VERSION, 'since เกินช่วงของ cursor')
  .default('0');

/** `?limit=` — ข้อความ error เป็นไทยทุกกรณี (ค่า default ของ zod เป็นอังกฤษ) */
function limitSchema(max: number, fallback: number) {
  const range = `limit ต้องอยู่ระหว่าง 1–${max}`;
  return z.coerce
    .number({ invalid_type_error: 'limit ต้องเป็นจำนวนเต็ม' })
    .int('limit ต้องเป็นจำนวนเต็ม')
    .min(1, range)
    .max(max, range)
    .default(fallback);
}

export const ItemsQuerySchema = z.object({
  since: SinceSchema,
  // หน้าละ 500 แถว: item master 5–50k แถวไหลครบใน 10–100 รอบ และไม่ทำให้ payload บวม
  limit: limitSchema(1000, 500),
});

/** ยาวสุด 64 ตัว = CHECK ของ item_barcodes.barcode */
export const BarcodeSchema = z
  .string({ required_error: 'ต้องระบุบาร์โค้ด', invalid_type_error: 'ต้องระบุบาร์โค้ด' })
  .trim()
  .min(1, 'ต้องระบุบาร์โค้ด')
  .max(64, 'บาร์โค้ดยาวเกิน 64 ตัวอักษร');

export const SearchQuerySchema = z.object({
  // ค้นชื่อ / SKU / บาร์โค้ด (design §2.4) — service ต้อง escape % และ _ ก่อนต่อ ILIKE
  q: z
    .string({ required_error: 'ต้องระบุคำค้นหา', invalid_type_error: 'ต้องระบุคำค้นหา' })
    .trim()
    .min(1, 'ต้องระบุคำค้นหา')
    .max(100, 'คำค้นหายาวเกิน 100 ตัวอักษร'),
  limit: limitSchema(200, 100),
});

export const ScanEventSchema = z.object({
  barcode: BarcodeSchema,
  /**
   * สแกนแล้วไม่พบสินค้า → ส่ง `null` หรือไม่ส่งเลยก็ได้
   * (scan_events.sku เก็บ NULL ไว้วิเคราะห์ฉลากไม่ตรง — แอปส่ง null มาตรง ๆ ง่ายกว่าตัด key ออก)
   */
  sku: z
    .string()
    .trim()
    .min(1, 'sku ว่างไม่ได้')
    .max(64, 'sku ยาวเกิน 64 ตัวอักษร')
    .nullish(),
  /**
   * นาฬิกาเครื่องเชื่อไม่ได้ 100% — ค่านี้ใช้แสดงผล/วิเคราะห์ ไม่ใช่ใช้ตัดสินลำดับ
   * ไม่ใช้ `z.coerce.date()` เพราะ issue `invalid_date` ตั้งข้อความไทยไม่ได้
   */
  scannedAt: z
    .string({
      required_error: 'ต้องระบุ scannedAt',
      invalid_type_error: 'scannedAt ต้องเป็นเวลาแบบ ISO 8601',
    })
    .trim()
    .transform((raw) => new Date(raw))
    .refine((at) => !Number.isNaN(at.getTime()), 'scannedAt ต้องเป็นเวลาแบบ ISO 8601'),
});

export const ScanEventsBodySchema = z.object(
  {
    // devices.device_id: 1–128 ตัว · service ต้อง upsert devices ก่อน insert (scan_events มี FK มาที่นี่)
    deviceId: z
      .string({ required_error: 'ต้องระบุ deviceId', invalid_type_error: 'ต้องระบุ deviceId' })
      .trim()
      .min(1, 'ต้องระบุ deviceId')
      .max(128, 'deviceId ยาวเกิน 128 ตัวอักษร'),
    appVersion: z.string().trim().max(32, 'appVersion ยาวเกิน 32 ตัวอักษร').optional(),
    events: z
      .array(ScanEventSchema)
      .min(1, 'ต้องมีอย่างน้อย 1 event')
      .max(500, 'ส่งได้ไม่เกิน 500 event ต่อครั้ง'),
  },
  { required_error: 'ข้อมูลการสแกนไม่ถูกต้อง', invalid_type_error: 'ข้อมูลการสแกนไม่ถูกต้อง' },
);

export type ScanEventInput = z.infer<typeof ScanEventSchema>;

/** input ของ `CatalogService.recordScanEvents` (service ควร `import type` เท่านั้น กัน import วน) */
export interface ScanEventsIngest {
  empId: string;
  deviceId: string;
  appVersion?: string;
  events: ScanEventInput[];
}

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

/**
 * query ของ Fastify เป็น string ล้วน (และเป็น array เมื่อคีย์ซ้ำ)
 * - คีย์ซ้ำ → เอาค่าแรก
 * - ค่าว่าง (`?since=`) → ถือว่า "ไม่ได้ส่งมา" เพื่อให้ `.default()` ของ zod ทำงาน
 */
function normalizeQuery(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== 'string' || first.trim() === '') continue;
    out[key] = first;
  }
  return out;
}

/** validate แล้วโยน 400 ที่มี `{code, message}` เหมือนทุก endpoint อื่นในระบบ */
function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  fallback: string,
): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION',
      message: parsed.error.issues[0]?.message ?? fallback,
    });
  }
  return parsed.data as z.infer<T>;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

/**
 * ⚠️ ไม่ต้อง `@UseGuards` — JwtAuthGuard + RolesGuard ลงทะเบียนเป็น APP_GUARD
 *    ระดับแอปแล้วใน app.module.ts (ทุก endpoint ที่ไม่มี `@Public()` ต้อง login)
 *
 * อ่านได้ทุก role ที่ login แล้ว (viewer สแกน/ค้นหา/ดูข้อมูลได้ ตาม role matrix §7)
 * และเห็นเฉพาะคลังของตัวเองจาก `warehouseCode` ใน token — ไม่รับคลังจาก query
 */
@Controller('items')
export class CatalogController {
  private readonly logger = new Logger(CatalogController.name);

  constructor(private readonly catalog: CatalogService) {}

  /**
   * delta feed สำหรับ replica บนมือถือ — **รวม tombstone** (สินค้าที่หายจาก ERP)
   * เครื่องเก็บ `nextSince` ไว้ยิงรอบถัดไป จนกว่า `hasMore` จะเป็น false
   */
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<ItemsDeltaPage> {
    const { since, limit } = parseOrThrow(
      ItemsQuerySchema,
      normalizeQuery(query),
      'พารามิเตอร์ไม่ถูกต้อง',
    );
    try {
      return await this.catalog.getDelta({
        warehouseCode: user.warehouseCode,
        since,
        limit,
      });
    } catch (err) {
      throw this.toHttp(err, 'ดึง delta feed ของ items');
    }
  }

  /** ค้นหาแบบ substring: ชื่อ / ชื่ออังกฤษ / SKU / บาร์โค้ด (design §2.4 "{n} รายการ") */
  @Get('search')
  async search(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<ItemSearchResult> {
    const { q, limit } = parseOrThrow(
      SearchQuerySchema,
      normalizeQuery(query),
      'คำค้นหาไม่ถูกต้อง',
    );
    try {
      return await this.catalog.search(q, user.warehouseCode, limit);
    } catch (err) {
      throw this.toHttp(err, 'ค้นหาสินค้า');
    }
  }

  /**
   * สแกนแล้ว lookup exact-match — ไม่พบ → 404 `ITEM_NOT_FOUND`
   * (แอปแสดงสถานะกล้อง "ไม่พบรหัส {code}" + toast ตามข้อความนี้)
   */
  @Get('by-barcode/:code')
  async byBarcode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
  ): Promise<ItemDto> {
    const barcode = parseOrThrow(BarcodeSchema, code, 'บาร์โค้ดไม่ถูกต้อง');
    let item: ItemDto | null;
    try {
      item = await this.catalog.findByBarcode(barcode, user.warehouseCode);
    } catch (err) {
      throw this.toHttp(err, 'ค้นหาด้วยบาร์โค้ด');
    }
    if (!item) {
      throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: ITEM_NOT_FOUND_TH });
    }
    return item;
  }

  /**
   * telemetry การสแกนที่เครื่องคิวไว้ตอนออฟไลน์ (บาร์โค้ดที่ไม่พบก็ส่งมาด้วย)
   *
   * ⚠️ **ห้าม version-gate endpoint นี้** — นี่คือ ingest path ของเครื่องที่ออฟไลน์มาทั้งกะ
   *    เครื่องเวอร์ชัน N-1 ต้องระบายคิวขึ้น server ได้ก่อนถูกบังคับอัปเดตแอป
   *    (กติกาเดียวกับ POST /auth/refresh และ POST /count-sessions/:id/submissions
   *     — ตอนเพิ่ม gate ของ APP_MIN_VERSION ต้องยกเว้น 3 เส้นทางนี้)
   *
   * ตอบ 200 ไม่ใช่ 201: เป็น batch ingest ที่เครื่องยิงซ้ำได้ ไม่ใช่การสร้าง resource
   */
  @Post('scan-events')
  @Roles('staff', 'admin')
  @HttpCode(200)
  async recordScanEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ recorded: number }> {
    const input = parseOrThrow(ScanEventsBodySchema, body, 'ข้อมูลการสแกนไม่ถูกต้อง');
    try {
      const recorded = await this.catalog.recordScanEvents(
        input.events,
        user.empId,
        input.deviceId,
      );
      return { recorded };
    } catch (err) {
      throw this.toHttp(err, 'บันทึก scan events');
    }
  }

  /**
   * error → HTTP ที่มี `{code, message}` ทุกกรณี
   * HttpException จาก service ปล่อยผ่าน (มี body ตามสัญญาแล้ว) ส่วน error อื่น
   * เช่นข้อความจากไดรเวอร์ Postgres ต้องไม่หลุดถึงมือถือ → log ฝั่ง server แล้วตอบกลาง ๆ
   */
  private toHttp(err: unknown, action: string): Error {
    if (err instanceof HttpException) return err;
    this.logger.error(`${action} ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
    return new InternalServerErrorException({ code: 'INTERNAL', message: INTERNAL_TH });
  }
}

/**
 * PostgresModule เป็น @Global และ ConfigModule ตั้ง isGlobal ไว้แล้ว จึงไม่ต้อง import
 * AuthModule import ไว้เพื่อให้ guard/AuthService ใช้ได้เมื่อถูกผูกที่ scope นี้ในอนาคต
 */
@Module({
  imports: [AuthModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
