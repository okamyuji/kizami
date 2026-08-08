import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['dist/', 'node_modules/', '.stryker-tmp/'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  }
);
