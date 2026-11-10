// 清空 dist/，避免 tsc 增量构建留下改名/删除后的陈旧产物。
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
rmSync(dist, { recursive: true, force: true })
