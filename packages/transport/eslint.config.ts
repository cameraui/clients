import jsLint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';
import tsLint from 'typescript-eslint';

export default [
  {
    name: 'files-to-lint',
    files: ['**/*.{js,mjs,cjs,ts,mts}'],
  },
  {
    name: 'files-to-ignore',
    ignores: ['**/dist/**', '**/demo/**', '**/coverage/**', '**/node_modules/**', 'eslint.config.ts', 'vite.config.ts', 'vitest.config.ts', 'updates.config.js'],
  },
  jsLint.configs.recommended,
  ...tsLint.configs.recommended,
  stylistic.configs['disable-legacy'],
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
    commaDangle: 'always-multiline',
    jsx: false,
    arrowParens: true,
    braceStyle: '1tbs',
    blockSpacing: true,
    quoteProps: 'as-needed',
  }),
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parser: tsParser,
    },

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      '@typescript-eslint/prefer-for-of': 'off',
      '@typescript-eslint/prefer-find': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@stylistic/generator-star-spacing': ['error', { before: true, after: false }],

      '@stylistic/max-len': ['error', { code: 170, tabWidth: 2, ignorePattern: 'url\\([^)]*\\)' }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/operator-linebreak': 'off',
      '@stylistic/comma-dangle': [
        'error',
        {
          arrays: 'always-multiline',
          objects: 'always-multiline',
          imports: 'always-multiline',
          exports: 'only-multiline',
          functions: 'always-multiline',
          enums: 'always-multiline',
          generics: 'always-multiline',
          tuples: 'always-multiline',
        },
      ],

      semi: [1, 'always'],
      'comma-dangle': ['error', 'only-multiline'],
      'no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 0 }],
      'eol-last': ['error', 'always'],
      'space-before-function-paren': ['error', { named: 'never' }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-case-declarations': 'off',
      'no-async-promise-executor': 'off',
      'no-control-regex': 'off',
    },
  },
];
