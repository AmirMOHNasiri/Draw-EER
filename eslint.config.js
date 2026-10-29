import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/.vscode-test/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // tsconfig enables `noUncheckedIndexedAccess`, so every `array[i]` is typed
      // as possibly undefined. After a bounds check, `array[i]!` is the clearest
      // way to say so; banning `!` would only force noisier workarounds.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
