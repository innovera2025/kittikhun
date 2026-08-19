import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';

import { AppModule } from './app.module';
import { loadConfig } from './config/env.config';

async function bootstrap() {
  const logger = new Logger('bootstrap');

  // ชั้นที่ 1 ของ boot: ตรวจ .env ก่อนทุกอย่าง — ผิดแล้ว fail fast พร้อมชื่อตัวแปร
  // (ห้าม log ค่าของ secret เด็ดขาด)
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error(`คอนฟิกไม่ถูกต้อง — ระบบไม่เริ่มทำงาน\n${(err as Error).message}`);
    process.exit(1);
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  // validation ใช้ zod (nestjs-zod) ที่ระดับ controller — ไม่ใช้ class-validator
  app.enableCors({
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen({ port: config.APP_PORT, host: '0.0.0.0' });
  logger.log(
    `KITTIKHUN Stock API พร้อมใช้งานที่พอร์ต ${config.APP_PORT} · คลัง ${config.WAREHOUSE_CODE} · ERP driver: ${config.ERP_DRIVER}`,
  );
  logger.log('โหมด ERP: อ่านอย่างเดียว — ระบบนี้ไม่เขียนข้อมูลกลับ ERP ทุกกรณี');
}

void bootstrap();
