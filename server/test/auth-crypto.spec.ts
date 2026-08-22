import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';

import { AuthService } from '../src/auth/auth.service';
import type { AppConfig } from '../src/config/env.config';
import type { PostgresService } from '../src/db/postgres.service';

/**
 * ชั้นเข้ารหัสของ auth — ทดสอบได้โดยไม่ต้องมี Postgres
 *
 * ทำไมต้องล็อกไว้:
 *   - pepper หลุดจาก config → hash ที่รั่วจาก DB ถูก crack ได้ทันที (PIN แค่ 6 หลัก)
 *   - safeEqual ถ้าเผลอเป็น === → เทียบ token แบบวัดเวลาได้
 *   - parseDuration ถ้าอ่าน '30d' ผิด → refresh token หมดอายุผิดไปหลายเท่า
 */

const CFG: Record<string, string | number> = {
  PIN_PEPPER: 'pepper-สำหรับเทสต์-ห้ามใช้จริง',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  AUTH_THROTTLE_BASE_MS: 1000,
  AUTH_THROTTLE_MAX_MS: 300_000,
};

function makeService(overrides: Record<string, string | number> = {}): AuthService {
  const merged = { ...CFG, ...overrides };
  const cfg = { get: (k: string) => merged[k] } as unknown as ConfigService<AppConfig, true>;
  return new AuthService({} as PostgresService, {} as JwtService, cfg);
}

describe('AuthService — ชั้นเข้ารหัส', () => {
  describe('hashPin: argon2id + server pepper', () => {
    it('hash ที่ได้เป็น argon2id (ไม่ใช่ argon2i/d ที่อ่อนกว่าในบริบทนี้)', async () => {
      const hash = await makeService().hashPin('520417');
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });

    it('hash PIN เดิมสองครั้งได้คนละค่า (มี salt สุ่ม)', async () => {
      const svc = makeService();
      const [a, b] = await Promise.all([svc.hashPin('520417'), svc.hashPin('520417')]);
      expect(a).not.toBe(b);
    });

    it('PIN ที่ถูกต้อง + pepper ที่ถูกต้อง → verify ผ่าน', async () => {
      const hash = await makeService().hashPin('520417');
      await expect(argon2.verify(hash, '520417' + CFG.PIN_PEPPER)).resolves.toBe(true);
    });

    it('⭐ pepper ถูกผสมจริง — รู้ PIN แต่ไม่รู้ pepper ก็ verify ไม่ผ่าน', async () => {
      const hash = await makeService().hashPin('520417');
      await expect(argon2.verify(hash, '520417')).resolves.toBe(false);
      await expect(argon2.verify(hash, '520417' + 'pepper-ผิด')).resolves.toBe(false);
    });

    it('เปลี่ยน pepper แล้ว hash เดิมใช้ไม่ได้ (หมุน pepper = ต้อง reset PIN ทั้งระบบ)', async () => {
      const hash = await makeService({ PIN_PEPPER: 'pepper-เก่า' }).hashPin('520417');
      await expect(argon2.verify(hash, '520417' + 'pepper-ใหม่')).resolves.toBe(false);
    });

    it('พารามิเตอร์ argon2 แรงพอ (memoryCost ≥ 19MiB, timeCost ≥ 2)', async () => {
      const hash = await makeService().hashPin('520417');
      const m = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(19_456);
      expect(Number(m![2])).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sha256 — เก็บเฉพาะ digest ของ refresh token ไม่เก็บตัว token', () => {
    it('ให้ค่าเดิมเสมอสำหรับ input เดิม และยาว 64 hex', () => {
      const a = AuthService.sha256('token-abc');
      expect(a).toBe(AuthService.sha256('token-abc'));
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('input ต่างกันนิดเดียวก็ได้ digest คนละค่า', () => {
      expect(AuthService.sha256('token-abc')).not.toBe(AuthService.sha256('token-abd'));
    });

    it('ตรงกับค่าอ้างอิงมาตรฐาน (กันเผลอเปลี่ยนอัลกอริทึมแล้ว token เดิมใช้ไม่ได้ทั้งระบบ)', () => {
      expect(AuthService.sha256('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('safeEqual — เทียบแบบ constant-time', () => {
    it('string เดียวกัน → true', () => {
      expect(AuthService.safeEqual('abc123', 'abc123')).toBe(true);
    });

    it('string ต่างกัน → false', () => {
      expect(AuthService.safeEqual('abc123', 'abc124')).toBe(false);
    });

    it('ความยาวไม่เท่ากัน → false และ**ไม่ throw** (timingSafeEqual ดิบจะ throw)', () => {
      expect(() => AuthService.safeEqual('abc', 'abcdef')).not.toThrow();
      expect(AuthService.safeEqual('abc', 'abcdef')).toBe(false);
      expect(AuthService.safeEqual('', 'x')).toBe(false);
    });

    it('ว่างทั้งคู่ → true (ไม่ crash)', () => {
      expect(AuthService.safeEqual('', '')).toBe(true);
    });

    it('รองรับอักขระไทย/ยูนิโค้ดโดยไม่ throw', () => {
      expect(AuthService.safeEqual('รหัส', 'รหัส')).toBe(true);
      expect(AuthService.safeEqual('รหัส', 'รหัซ')).toBe(false);
    });
  });

  describe('parseDuration — อายุ token', () => {
    it.each([
      ['15m', 15 * 60_000],
      ['30d', 30 * 86_400_000],
      ['3600s', 3_600_000],
      ['2h', 7_200_000],
      ['1d', 86_400_000],
      [' 15m ', 15 * 60_000],
    ])('%s → %d ms', (input, expected) => {
      expect(AuthService.parseDuration(input)).toBe(expected);
    });

    it('ตัวเลขล้วนถือเป็นวินาที', () => {
      expect(AuthService.parseDuration('90')).toBe(90_000);
    });

    it('รูปแบบที่อ่านไม่ออก → throw พร้อมบอกค่าที่ผิด (fail fast ตอน boot ดีกว่าเงียบ)', () => {
      expect(() => AuthService.parseDuration('30วัน')).toThrow(/30วัน/);
      expect(() => AuthService.parseDuration('abc')).toThrow();
    });

    it('refresh (30d) ต้องยาวกว่า access (15m) อย่างมีนัย — กันสลับค่ากันใน config', () => {
      expect(AuthService.parseDuration('30d')).toBeGreaterThan(
        AuthService.parseDuration('15m') * 100,
      );
    });
  });
});
