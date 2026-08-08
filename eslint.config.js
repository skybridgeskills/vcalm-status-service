import globals from 'globals'
import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'
import { importX } from 'eslint-plugin-import-x'

export default [
  {
    ignores: [
      '**/dist/**/*',
      '**/node_modules/**/*',
      '**/coverage/**/*',
      '.pnpm-store/**/*'
    ]
  },
  {
    languageOptions: { globals: globals.node }
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'import-x': importX },
    rules: {
      'import-x/extensions': ['error', 'ignorePackages'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ]
    }
  },
  eslintConfigPrettier
]
