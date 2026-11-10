// ESLint 9 扁平配置：TS/TS 规则 + Vue SFC + 浏览器/Node 环境区分 + Prettier 兼容（格式交给 Prettier）。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    // SFC 的 <script lang="ts"> 用 TS 解析器
    files: ['web/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
  },
  {
    files: ['web/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.ts', '**/*.mjs', 'web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // dsh 的 agent/*、session/event 等 API 用 any 过渡（类型在 dsh 包内、按真机核对过形状）
    files: ['src/dsh-panel-bridge.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
