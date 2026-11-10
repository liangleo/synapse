// 一键部署：build → 打包插件 tgz → dsh 离线安装到指定 profile。
// 用法：pnpm dsh:add   （DSH_PROFILE=web 可改 profile；DSH_ADD=link 安装目录实时链接，默认 tgz 快照）
import { execSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const profile = process.env.DSH_PROFILE || 'web'
if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) {
  console.error(
    `[dsh:add] 非法 profile 名：${JSON.stringify(profile)}（只允许小写字母/数字/连字符）`,
  )
  process.exit(1)
}
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' })

// ---------- 环境自检：Node ≥ 24.9（dsh 硬性要求），dsh CLI 缺失则自动安装 ----------
function sh(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, { stdio: 'pipe', ...opts })
        .toString()
        .trim(),
    }
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message) }
  }
}

function ensureDsh() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) {
    console.error(
      `[dsh:add] 当前 Node ${process.versions.node} < 24.9（dsh 硬性要求）。先升级：nvm install 24 && nvm use 24，再重跑本命令。`,
    )
    process.exit(1)
  }
  const probe = sh('dsh --version')
  if (probe.ok) {
    console.log(`[dsh:add] dsh ${probe.out.split('\n')[0]}`)
    return
  }
  console.log('[dsh:add] 未检测到 dsh CLI，自动安装 @deepseek-ai/dsh …')
  const install = sh('npm i -g @deepseek-ai/dsh')
  if (!install.ok || !sh('dsh --version').ok) {
    console.error(
      `[dsh:add] 自动安装失败：${install.out}\n` +
        '手动安装：npm i -g @deepseek-ai/dsh（nvm 多版本时先 nvm use 24 再装，否则全局 bin 不在 PATH）',
    )
    process.exit(1)
  }
  console.log(`[dsh:add] dsh ${sh('dsh --version').out.split('\n')[0]} 安装完成`)
}

ensureDsh()

run('pnpm -s build')

// DSH_ADD=link：安装 dist 目录本身（pnpm link: 实时链接，之后 pnpm build + 重启 dsh 即生效）；
// 默认打 tgz 固定快照（锁版本/分享给他人用）
const installLink = process.env.DSH_ADD === 'link'

if (installLink) {
  console.log(`[dsh:add] 安装目录链接 ${dist} → profile ${profile}`)
  try {
    run(`dsh plugin --profile ${profile} add "${dist}"`)
  } catch {
    console.error(
      `[dsh:add] dsh 命令失败：确认 dsh 已安装（Node ≥ 24.9）、API Key 已配置、profile "${profile}" 存在`,
    )
    process.exit(1)
  }
} else {
  run('npm pack --silent', dist)
  const tgz = readdirSync(dist)
    .filter((f) => f.endsWith('.tgz'))
    .sort((a, b) => statSync(path.join(dist, b)).mtimeMs - statSync(path.join(dist, a)).mtimeMs)[0]
  if (!tgz) {
    console.error('[dsh:add] 未找到 tgz')
    process.exit(1)
  }
  console.log(`[dsh:add] 安装 ${tgz} → profile ${profile}`)
  try {
    run(`dsh plugin --profile ${profile} add --offline "${path.join(dist, tgz)}"`)
  } catch {
    console.error(
      `[dsh:add] dsh 命令失败：确认 dsh 已安装（Node ≥ 24.9）、API Key 已配置、profile "${profile}" 存在`,
    )
    process.exit(1)
  }
}
// 确认（注意：--profile 属于 plugin 命令组，必须写在 list 前面）
try {
  run(`dsh plugin --profile ${profile} list`)
} catch {
  // list 失败不影响部署结果
}
console.log(
  `[dsh:add] 完成；也可用 dsh --profile ${profile} --dump-config | grep panel-bridge 查看挂载行，启动后找 [dsh-panel-bridge] 的地址和 token`,
)
