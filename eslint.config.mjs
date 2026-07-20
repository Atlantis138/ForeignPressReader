import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const platformImportPatterns = [
  'node:*',
  'electron',
  '@tauri-apps/*',
]

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'test-artifacts/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/android/.gradle/**',
      'src-tauri/gen/android/build/**',
      'src-tauri/gen/android/app/build/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        BufferSource: 'readonly',
        Electron: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          ...platformImportPatterns,
          '../main/*',
          '../preload/*',
          '../renderer/*',
          '../../main/*',
          '../../preload/*',
          '../../renderer/*',
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'Buffer', message: 'core 必须使用 Uint8Array。' },
        { name: 'process', message: 'core 不得读取 Node 运行时状态。' },
        { name: 'require', message: 'core 不得加载平台模块。' },
        { name: 'fetch', message: 'core 网络访问必须经 NetworkClient。' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          'node:*',
          'electron',
          '../../main/*',
          '../main/*',
          '../../preload/*',
          '../preload/*',
        ],
      }],
    },
  },
)
