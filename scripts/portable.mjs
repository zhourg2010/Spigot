import fs from 'fs'
import fsp from 'fs/promises'
import { createRequire } from 'module'
import path from 'path'

import AdmZip from 'adm-zip'

/**
 * 打包 Windows 便携版(绿色版)zip —— 解压即用,不需要安装。
 *
 * 便携不只是"不用装":exe 旁边放一个空的 `.config/PORTABLE` 标记文件之后,
 * src-tauri/src/utils/dirs.rs 的 init_portable_flag() 会读到它,把配置目录从
 * %APPDATA%\<APP_ID> 切到 <exe目录>\.config\<APP_ID>。所以整个文件夹拷到 U 盘
 * 带走,订阅和设置都跟着走;删掉文件夹就干干净净,注册表和 %APPDATA% 里什么都不留。
 * (顺带:更新器在便携模式下会自动跳过,见 core/updater.rs。)
 *
 * 这份脚本是上游的,rClash 改了两处 —— 两处都是不改就直接跑不起来的:
 *
 *   1. release 目录:上游写的是 ./src-tauri/target/<triple>/release,但根目录的
 *      Cargo.toml 是 [workspace],src-tauri 只是成员之一,**Cargo 工作区的 target
 *      在工作区根目录**。所以是 ./target/<triple>/release。
 *      (build.yml 的缓存和产物路径栽在同一个坑上过,那边注释写得更细。)
 *
 *   2. 主程序文件名:上游是 clash-verge.exe;我们把 productName 改成了 rClash,
 *      tauri build 会把 cargo 产出的 clash-verge.exe 重命名成 rClash.exe。
 *      这里不硬编码,从 tauri.conf.json 读 productName,并保留 Cargo 包名当兜底 ——
 *      万一以后 Tauri 改了重命名行为,不至于莫名其妙找不到文件。
 */

const target = process.argv.slice(2)[0]

const ARCH_MAP = {
  'x86_64-pc-windows-msvc': 'x64',
  'aarch64-pc-windows-msvc': 'arm64',
}
const PROCESS_MAP = { x64: 'x64', arm64: 'arm64' }
const arch = target ? ARCH_MAP[target] : PROCESS_MAP[process.arch]

const require = createRequire(import.meta.url)

/**
 * 在 releaseDir 里找主程序。找不到就把目录里实际有哪些 .exe 列出来 —— 光一个 ENOENT
 * 在 CI 日志里毫无信息量,而这一步最可能出的错恰恰就是"名字跟预期不一样"。
 */
function findMainExe(releaseDir) {
  const tauriConf = require('../src-tauri/tauri.conf.json')
  const cargoBin = 'clash-verge' // src-tauri/Cargo.toml 的 [package] name
  const candidates = [`${tauriConf.productName}.exe`, `${cargoBin}.exe`]

  for (const name of candidates) {
    const p = path.join(releaseDir, name)
    if (fs.existsSync(p)) return p
  }

  const listing = fs
    .readdirSync(releaseDir)
    .filter((f) => f.endsWith('.exe'))
    .join(', ')
  throw new Error(
    `找不到主程序。试过:${candidates.join(' / ')}\n` +
      `${releaseDir} 里现有的 .exe:${listing || '(一个都没有)'}`,
  )
}

/** 便携包里少了内核就是个开不起来的壳,所以缺文件必须直接失败,不能只 warn。 */
function requireFile(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error(`便携包缺少${what}:${p}`)
  }
  return p
}

async function resolvePortable() {
  if (process.platform !== 'win32') {
    console.log('[INFO]: 便携版只在 Windows 上打包,跳过')
    return
  }

  const releaseDir = target ? `./target/${target}/release` : `./target/release`
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`找不到 release 目录:${releaseDir}`)
  }

  // 这个空文件就是"便携模式"的开关,见文件头的说明
  const configDir = path.join(releaseDir, '.config')
  await fsp.mkdir(configDir, { recursive: true })
  const flag = path.join(configDir, 'PORTABLE')
  if (!fs.existsSync(flag)) await fsp.writeFile(flag, '')

  const zip = new AdmZip()
  zip.addLocalFile(findMainExe(releaseDir))
  zip.addLocalFile(requireFile(path.join(releaseDir, 'verge-mihomo.exe'), 'mihomo 内核'))
  zip.addLocalFile(
    requireFile(path.join(releaseDir, 'verge-mihomo-alpha.exe'), 'mihomo alpha 内核'),
  )
  zip.addLocalFolder(requireFile(path.join(releaseDir, 'resources'), '资源目录'), 'resources')
  zip.addLocalFolder(configDir, '.config')

  const { version } = require('../package.json')
  const zipFile = `rClash_${version}_${arch}_portable.zip`
  zip.writeZip(zipFile)
  console.log(`[INFO]: 便携版打包完成 -> ${zipFile}`)
}

resolvePortable().catch((e) => {
  console.error('[ERROR]:', e.message)
  // 必须非零退出。上游是 .catch(console.error),打包失败也算成功 ——
  // 那样 CI 会绿着跑完,最后发一个没有便携版的 Release,而且没人会注意到。
  process.exit(1)
})
