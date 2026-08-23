import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser, RequireFreshRole, Roles } from '../auth/auth.guards';
import { AuthModule } from '../auth/auth.module';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CountService } from './count.service';

// ---------------------------------------------------------------------------
// zod: ทุกอย่างที่มาจากภายนอก (path param / query / body)
// ---------------------------------------------------------------------------

/** ห้ามเกิน 200 บรรทัด/batch — เครื่องที่ออฟไลน์ทั้งกะจะยิงคิวยาว ต้องแบ่งเป็นหลาย request */
const MAX_BATCH_LINES = 200;

/**
 * รหัสรอบนับ — ตรงกับ CHECK `count_sessions_id_fmt` (trim + ยาว 1–64)
 * ห้ามมี control char / `"` / `\` เพราะค่านี้ถูกเอาไปประกอบชื่อไฟล์ใน Content-Disposition
 */
const SessionIdSchema = z
  .string()
  .trim()
  .min(1, 'รหัสรอบนับไม่ถูกต้อง')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001F"\\]+$/, 'รหัสรอบนับไม่ถูกต้อง')
  .max(64, 'รหัสรอบนับไม่ถูกต้อง');

const SkuSchema = z.string().trim().min(1, 'รหัสสินค้าไม่ถูกต้อง').max(64, 'รหัสสินค้าไม่ถูกต้อง');

const UuidSchema = z.string().uuid('ต้องเป็น UUID');

const DeviceIdSchema = z.string().trim().min(1, 'ต้องระบุรหัสเครื่อง').max(64);

/**
 * ผลนับ 1 บรรทัดจากคิวของเครื่อง
 *
 * - `idempotencyKey` = UUIDv7 จาก outbox → retry กี่ครั้งก็ไม่นับซ้ำ
 * - `countedQty` numeric(18,3) → ทศนิยมได้ แต่ห้ามติดลบ / NaN / Infinity
 * - `deviceSeq` คือลำดับจริงของการนับ (นาฬิกาเครื่องเชื่อไม่ได้ `countedAt` ใช้แสดงผล)
 * - `countedAt` ยอมรับ offset ได้ (เครื่องออฟไลน์ส่งเวลาท้องถิ่นมา)
 */
const SubmissionLineSchema = z.object({
  idempotencyKey: UuidSchema,
  sku: SkuSchema,
  countedQty: z
    .number()
    .finite('จำนวนที่นับได้ไม่ถูกต้อง')
    .min(0, 'จำนวนที่นับได้ต้องไม่ติดลบ')
    .max(999_999_999_999, 'จำนวนที่นับได้เกินขอบเขต'),
  countedAt: z.string().datetime({ offset: true, message: 'เวลาที่นับไม่ถูกต้อง' }),
  deviceSeq: z.number().int('ลำดับของเครื่องไม่ถูกต้อง').min(0, 'ลำดับของเครื่องไม่ถูกต้อง'),
});

const SubmitBatchSchema = z.object({
  deviceId: DeviceIdSchema,
  /** heartbeat: งานค้างในคิวของเครื่องนี้ → devices.queue_depth (ops view) */
  queueDepth: z.number().int().min(0).optional(),
  lines: z
    .array(SubmissionLineSchema)
    .min(1, 'ไม่มีบรรทัดผลนับในคำขอ')
    .max(MAX_BATCH_LINES, `ส่งได้ไม่เกิน ${MAX_BATCH_LINES} บรรทัดต่อครั้ง`),
});
export type SubmitBatchInput = z.infer<typeof SubmitBatchSchema>;

/**
 * เปิดรอบนับ — **รอบนับทุกรอบเปิดจากระบบเราเอง** แล้ว freeze ยอดจาก `items_cache`
 * (เลิก mirror รอบนับจาก ERP ตั้งแต่ 22 ส.ค. 2569 — ดึงจาก ERP แค่จำนวนคงเหลือ)
 *
 * `allowStaleCache` = admin เห็นอายุ cache แล้วยืนยันเปิดรอบตอน ERP ล่ม
 * (erp-integration.md §5 → ประทับ `count_sessions.opened_on_stale_cache`)
 */
/**
 * ⚠️ ต้องมีทุกฟิลด์ที่ `CountService.openSession()` ใช้
 *    zod strip key ที่ไม่ประกาศไว้ → ฟิลด์ที่ขาดจะหายก่อนถึง service แบบเงียบ ๆ
 *    (เคยทำให้ `skus` หลุด แล้ว freeze ทั้งคลังแทนที่จะ freeze แค่รายการที่ขอ)
 */
const OpenSessionSchema = z.object({
  id: SessionIdSchema.optional(),
  // ⚠️ เคยมี `erpTransactionNo` ตรงนี้หลังจากที่ service เลิกรับไปแล้ว → controller
  //    รับเข้ามาแล้ว zod ของ service strip ทิ้งเงียบ ๆ ผู้เรียกไม่มีทางรู้ว่าค่าหาย
  //    ตัดออกให้ตรงกันทั้งสองชั้น (ฟิลด์ที่ไม่มีในสัญญา zod จะถูกปฏิเสธที่นี่แทน)
  zone: z.string().trim().min(1).max(64).optional(),
  warehouseCode: z.string().trim().min(1).max(32).optional(),
  /** จำกัดรายการที่จะ freeze — ไม่ส่ง = ทั้งคลัง */
  skus: z.array(z.string().trim().min(1).max(64)).min(1).max(50_000).optional(),
  allowStaleCache: z.boolean().optional().default(false),
});
export type OpenSessionInput = z.infer<typeof OpenSessionSchema>;

const ResolveConflictSchema = z.object({ chosenSubmission: UuidSchema });

/** `?format=csv` → text/csv, ไม่ส่งมา → JSON */
const VarianceQuerySchema = z.object({ format: z.enum(['json', 'csv']).optional() });

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, fallback: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // สัญญา error ของทั้งระบบ: {code, message} — แอป map เป็นข้อความไทยบน toast
    throw new BadRequestException({
      code: 'VALIDATION',
      message: parsed.error.issues[0]?.message ?? fallback,
    });
  }
  return parsed.data;
}

/** ตัดให้เหลือเฉพาะอักขระที่ปลอดภัยในชื่อไฟล์ (กัน header injection ใน Content-Disposition) */
function safeFileToken(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'session';
}

/**
 * ส่วนของ FastifyReply ที่ใช้จริง — ประกาศเองเพื่อไม่ผูกกับเวอร์ชัน type ของ fastify
 * (`@Res({ passthrough: true })` = ตั้ง header เองแต่ยังคืนค่าจาก handler ให้ Nest ส่งต่อ)
 */
interface RawReply {
  header(name: string, value: string): unknown;
}

// ---------------------------------------------------------------------------
// ชนิดข้อมูลที่ส่งออก — ผูกกับ CountService ไม่ผูกกับชื่อ DTO
// (service เปลี่ยนชื่อ/เพิ่มฟิลด์ได้โดยไฟล์นี้ไม่ต้องแก้)
// ---------------------------------------------------------------------------

type ActiveSessionResult = Awaited<ReturnType<CountService['activeSession']>>;
type SubmitBatchResult = Awaited<ReturnType<CountService['submit']>>;
type VarianceResult = Awaited<ReturnType<CountService['variance']>>;
type ConflictsResult = Awaited<ReturnType<CountService['conflicts']>>;
type OpenSessionResult = Awaited<ReturnType<CountService['openSession']>>;
type CloseSessionResult = Awaited<ReturnType<CountService['closeSession']>>;
type ResolveConflictResult = Awaited<ReturnType<CountService['resolveConflict']>>;

/**
 * Count — รอบนับ, ingest ผลนับ, รายงานส่วนต่าง
 *
 * 🚫 ไม่มี endpoint ใดเขียนกลับ ERP — ERP อ่านอย่างเดียว ผลนับและส่วนต่างเก็บใน
 *    Postgres ของระบบเราเท่านั้น (`count_submissions` → `closed_variance`)
 *    CSV ที่ export คือ **เอกสารอ้างอิงภายใน** ไม่ใช่ไฟล์คีย์เข้า ERP (erp-integration.md §6)
 *
 * guard: `JwtAuthGuard` + `RolesGuard` ลงทะเบียนเป็น APP_GUARD ระดับแอปแล้ว
 *        → ทุก route ที่นี่ต้อง login (ไม่มี `@Public()`) และไม่ต้องใส่ `@UseGuards` ซ้ำ
 *
 * error: service โยน HttpException ที่มี body `{code, message}` — ปล่อยผ่านให้ Nest จัดการ
 *        (error อื่นเป็น 500 กลาง ไม่หลุดข้อความจากไดรเวอร์ Postgres)
 */
@Controller('count-sessions')
export class CountController {
  constructor(private readonly count: CountService) {}

  /**
   * รอบนับที่เปิดอยู่ของคลังผู้เรียก + frozen qty + `erpDataAsOf`
   *
   * ⚠️ ไม่มีรอบเปิด → **200 พร้อม body `null`** (ไม่ใช่ 404)
   *    แอปเช็ค null ง่ายกว่าและไม่ต้องแยก error path ตอนออฟไลน์
   */
  @Get('active')
  async active(@CurrentUser() user: AuthenticatedUser): Promise<ActiveSessionResult> {
    return this.count.activeSession(user.warehouseCode);
  }

  /**
   * ingest ผลนับแบบ batch → **200 พร้อมผลรายบรรทัด** (architecture.md §6.3)
   * `[{ idempotencyKey, status: accepted|duplicate|rejected, code? }]`
   *
   * ⚠️ **ห้าม version-gate เส้นทางนี้** — เครื่อง N-1 ที่ออฟไลน์ทั้งกะต้องส่งงานค้าง
   *    ได้ก่อนถูกบังคับอัปเดต (architecture.md §8.3)
   * ⚠️ ไม่ใส่ `@RequireFreshRole()` ด้วยเหตุผลเดียวกัน — role ที่เปลี่ยนกลางกะไม่ควรทำให้
   *    ทั้ง batch พังที่ transport แต่ตอบเป็น `rejected` + `ROLE_CHANGED` รายบรรทัดให้จอ
   *    pending-review แทน (งานไม่หายเงียบ ๆ)
   * ⚠️ 4xx/5xx สงวนไว้ให้ request พังทั้งก้อนเท่านั้น (auth เสีย / JSON เสีย / เกิน 200 บรรทัด)
   */
  @Post(':id/submissions')
  @Roles('staff', 'admin')
  @HttpCode(200)
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') idParam: string,
    @Body() body: unknown,
  ): Promise<SubmitBatchResult> {
    const sessionId = parseOrThrow(SessionIdSchema, idParam, 'รหัสรอบนับไม่ถูกต้อง');
    const input = parseOrThrow(SubmitBatchSchema, body, 'ข้อมูลผลนับไม่ถูกต้อง');
    // service รับ lines/deviceId/heartbeat แยกกัน (ดู CountService.submit)
    return this.count.submit(
      sessionId,
      input.lines,
      user,
      input.deviceId,
      input.queueDepth === undefined ? undefined : { queueDepth: input.queueDepth },
    );
  }

  /**
   * รายงานส่วนต่าง — ระหว่างรอบอ่านสดจาก `v_variance`, หลังปิดรอบอ่านจาก `closed_variance`
   * (service เป็นผู้เลือกแหล่ง) · `?format=csv` = export อ้างอิงภายใน
   *
   * ⚠️ status `not_counted` / `off_list` มี `diff = NULL` — ต้องแยกแสดง ห้ามแปลงเป็น 0
   */
  @Get(':id/variance')
  async variance(
    @Param('id') idParam: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: RawReply,
  ): Promise<VarianceResult | string> {
    const sessionId = parseOrThrow(SessionIdSchema, idParam, 'รหัสรอบนับไม่ถูกต้อง');
    const { format } = parseOrThrow(VarianceQuerySchema, query ?? {}, 'พารามิเตอร์ไม่ถูกต้อง');
    if (format !== 'csv') return this.count.variance(sessionId);

    const filename = `variance-${safeFileToken(sessionId)}.csv`;
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    // service เป็นเจ้าของรูปแบบ CSV (header ไทย + BOM + สถานะแปลไทย) — ห้ามทำซ้ำที่นี่
    return this.count.varianceCsv(sessionId);
  }

  /**
   * รายการ CONFLICT — 2+ เครื่องนับ SKU เดียวกันในรอบเดียวกัน
   * ⚠️ ห้าม auto-resolve: `received_at` คือลำดับการซิงค์ ไม่ใช่ลำดับการนับจริง
   *    → admin เป็นผู้เลือก submission เอง (architecture.md §4.1)
   */
  @Get(':id/conflicts')
  @Roles('admin')
  async conflicts(@Param('id') idParam: string): Promise<ConflictsResult> {
    const sessionId = parseOrThrow(SessionIdSchema, idParam, 'รหัสรอบนับไม่ถูกต้อง');
    return this.count.conflicts(sessionId);
  }

  /**
   * เปิดรอบนับ — service sync stock + freeze `count_snapshot` + ประทับ `erp_data_as_of`
   * ERP ล่ม → เปิดได้เฉพาะ `allowStaleCache: true` (admin ยืนยันโดยเห็นอายุ cache)
   */
  @Post()
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(201)
  async open(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<OpenSessionResult> {
    const input = parseOrThrow(OpenSessionSchema, body ?? {}, 'ข้อมูลรอบนับไม่ถูกต้อง');
    return this.count.openSession(input, user);
  }

  /**
   * ปิดรอบนับ = **materialize `closed_variance`** (คำตอบถาวร "ต่างกันเท่าไหร่")
   * submission ที่มาช้ากว่านี้ → `rejected` เข้าจอ pending-review
   */
  @Post(':id/close')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') idParam: string,
  ): Promise<CloseSessionResult> {
    const sessionId = parseOrThrow(SessionIdSchema, idParam, 'รหัสรอบนับไม่ถูกต้อง');
    return this.count.closeSession(sessionId, user);
  }

  /** admin ตัดสิน conflict โดยเลือก submission ที่ถือเป็นผลจริง (บันทึก `resolved_by`) */
  @Post(':id/conflicts/:sku/resolve')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async resolveConflict(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') idParam: string,
    @Param('sku') skuParam: string,
    @Body() body: unknown,
  ): Promise<ResolveConflictResult> {
    const sessionId = parseOrThrow(SessionIdSchema, idParam, 'รหัสรอบนับไม่ถูกต้อง');
    const sku = parseOrThrow(SkuSchema, skuParam, 'รหัสสินค้าไม่ถูกต้อง');
    const { chosenSubmission } = parseOrThrow(
      ResolveConflictSchema,
      body,
      'ต้องเลือก submission ที่ใช้เป็นผลจริง',
    );
    return this.count.resolveConflict(sessionId, sku, chosenSubmission, user);
  }
}

/** PostgresModule เป็น @Global และ ConfigModule ตั้ง isGlobal ไว้แล้ว จึงไม่ต้อง import */
@Module({
  imports: [AuthModule],
  controllers: [CountController],
  providers: [CountService],
  exports: [CountService],
})
export class CountModule {}
