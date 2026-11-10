// 构建后处理：把插件包描述复制进 dist，形成可直接加载的 dsh 插件包。
// 前端（index.html + bundle + 样式）由 Vite 直接产出在 dist/static/，这里不再复制静态资源。
import { copyFileSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

copyFileSync(path.join(root, 'scripts/dist-package.json'), path.join(dist, 'package.json'))
copyFileSync(path.join(root, 'scripts/cordis.patch.yml'), path.join(dist, 'cordis.patch.yml'))
copyFileSync(path.join(root, 'scripts/icon.svg'), path.join(dist, 'icon.svg'))
cpSync(path.join(root, 'scripts/locale'), path.join(dist, 'locale'), { recursive: true })
console.log(
  'dist 已就绪：dsh-panel-bridge.js + static/ + cordis.patch.yml + locale/ + icon.svg + package.json',
)
