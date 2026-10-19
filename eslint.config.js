import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'docs/.vitepress/**',
      'apps/demo/public/**',
      'bench-results/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      'assets/**',
      'upstream/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // TypeScript resolves identifiers, so `no-undef` only produces noise.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      // `void somePromise` is how this code says "deliberately not awaited".
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
);
