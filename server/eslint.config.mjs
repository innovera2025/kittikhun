// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 flat config
 *
 * ก่อนหน้านี้ `npm run lint` พังเพราะไม่มีไฟล์คอนฟิกเลย (ESLint 9 เลิกอ่าน .eslintrc)
 * → script ที่เขียนไว้ใน package.json ใช้ไม่ได้มาตลอด
 *
 * กฎที่เพิ่มจาก recommended ตั้งใจให้ตรงกับสิ่งที่โปรเจคนี้ถือเป็นเรื่องคอขาดบาดตาย:
 * ยอด/ส่วนต่างเป็น `null` ได้จริง การเผลอ `??`/`||` ผิดที่ทำให้ null กลายเป็น 0 เงียบ ๆ
 */
export default tseslint.config(
  {
    // build artifact + ของที่ generate — ไม่ใช่โค้ดที่คนเขียน
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // ใช้ tsconfig.eslint.json เพราะ tsconfig.json หลัก exclude test/ ไว้
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── null ≠ 0 (กฎหลักของโปรเจค) ──────────────────────────────────
      // ยอดระบบ/ยอดนับ/ส่วนต่างเป็น null ได้จริง — เผลอใช้ || แทน ?? แล้ว 0 หายไปเงียบ
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // ── ข้อมูลจาก ERP/แอปเป็น unknown เสมอ ต้อง validate ก่อนใช้ ─────
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // ── async ที่ลืม await = งานนับหายเงียบ ────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ── ปิดกฎที่ขัดกับสไตล์ที่โปรเจคนี้ใช้โดยตั้งใจ ────────────────────
      // โค้ดนี้ใช้ static helper ที่ไม่แตะ this แล้วส่งเป็น reference ให้ .map() เป็นปกติ
      '@typescript-eslint/unbound-method': 'off',
      // async ที่ไม่มี await มีจริงเพราะต้องตรงกับ interface (OnModuleInit, AsyncIterable)
      '@typescript-eslint/require-await': 'off',

      // ── ตัวแปรที่ไม่ได้ใช้: ยอมให้ขึ้นต้นด้วย _ ตามสไตล์ที่โค้ดใช้อยู่ ──
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // เทสต์เข้าถึง private method ด้วย cast เพื่อทดสอบ mapping — ยอมได้
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
