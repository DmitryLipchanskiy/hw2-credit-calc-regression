import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // REQ-01: money is integer kopecks. A float literal with a fractional part
      // inside the core is almost always a bug; the two legal float sites (i and K)
      // are computed, not written as literals.
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Scripts are plain node ESM, not part of the typed program.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
