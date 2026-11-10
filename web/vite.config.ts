import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// dev 代理配置：
//   VITE_PANEL_TARGET  后端地址，默认 http://127.0.0.1:3180（pnpm mock）；
//                      用 pnpm host 时设为 http://127.0.0.1:3181，接真实 dsh 时设为插件端口
//   VITE_PANEL_TOKEN   后端的 token（mock 固定为 mock；host/插件看启动时控制台输出）
const target = process.env.VITE_PANEL_TARGET ?? 'http://127.0.0.1:3180'
const panelToken = process.env.VITE_PANEL_TOKEN ?? 'mock'

// root 指向 web/ 本目录；产物输出到工程根的 dist/static
// base：构建时 /static/（与插件的 /static/ 路由对齐）；dev 时用 / 更顺手
export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: command === 'build' ? '/static/' : '/',
  plugins: [vue()],
  build: {
    outDir: '../dist/static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // dev 模式页面拿不到注入 token，由代理统一补上正确的 token
      '/meta': { target },
      '/presets': { target, headers: { 'x-panel-token': panelToken } },
      '/preset/active': { target, headers: { 'x-panel-token': panelToken } },
      '/events': {
        target,
        rewrite: (path) => {
          const u = new URL(path, target)
          u.searchParams.set('token', panelToken)
          return u.pathname + '?' + u.searchParams.toString()
        },
      },
      '/command': { target, headers: { 'x-panel-token': panelToken } },
    },
  },
}))
