import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', '**/__tests__/', '**/*.test.ts', 'src/scripts/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow unused vars prefixed with _ (common pattern for destructuring)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Fastify plugins use default exports
      '@typescript-eslint/no-empty-function': 'off',
      // Allow require() in CJS backend
      '@typescript-eslint/no-require-imports': 'off',
      // @ts-ignore needed where @ts-expect-error fails (no actual TS error but runtime typing issue)
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-ignore': 'allow-with-description' }],
      // We intentionally throw generic errors in auth/WS to avoid leaking details
      'preserve-caught-error': 'off',
    },
  },
];
