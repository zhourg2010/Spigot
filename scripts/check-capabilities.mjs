/**
 * 检查 Tauri capabilities 里有没有本仓库依赖的权限。
 *
 * 为什么需要这个:Tauri 的 ACL 是**按命令**授权的。`writeTextFile()` 走的是
 * `write_text_file` 命令,归 `fs:allow-write-text-file` 管 —— 跟 `fs:allow-write-file`
 * (管 `write_file`)是两条不同的权限。少一条的后果是运行时
 * `plugin fs|<命令> not allowed by ACL`,而 **tsc 和 vitest 都看不见**,
 * 只有真装上打开才知道。这一条已经栽过两次(先 mkdir,再 writeTextFile)。
 *
 * 另一个场景:同步上游时 capabilities/migrated.json 被覆盖,我们加的几条没了。
 * 有这个检查的话 CI 会红,而不是等下一个包发出去、装上才发现。
 *
 * 放在 scripts/ 而不是写成 vitest 用例:它要读 src-tauri 下的 JSON,而 tsconfig 的
 * types 是白名单(只有 vite/client 和 vite-plugin-svgr/client,没有 @types/node),
 * 在 src/ 里 import node:fs 会让 `tsc --noEmit` 挂。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = 'src-tauri/capabilities'

/** 用到哪个就在这儿加哪个。左边是权限,右边是为了让报错能说清"谁在用"。 */
const REQUIRED = {
  'fs:allow-exists': 'exists() —— 判断设置/缓存文件在不在',
  'fs:allow-mkdir': 'mkdir() —— 建 $APPDATA/spigot 数据目录',
  'fs:allow-read-file': 'readFile()',
  'fs:allow-read-text-file': 'readTextFile() —— 读设置 / DNS 缓存 / GeoIP 库',
  'fs:allow-write-file': 'writeFile()',
  'fs:allow-write-text-file': 'writeTextFile() —— 存设置 / DNS 缓存 / GeoIP 库',
  'http:allow-fetch': 'plugin-http 的 fetch() —— DoH 解析、下 GeoIP、推送到 Deno',
  'mihomo:default': 'delayProxyByName / getProxies —— 读节点和测延迟',
}

// 权限散在好几个 capability 文件里(fs 的在 migrated.json,http / mihomo 在
// desktop.json),所以整个目录一起扫。三份都是 windows: ["main"],也就是都作用在
// 主窗口上 —— 只有一个窗口,所以"在任意一份里出现"就等于"主窗口有这个权限"。
// 哪天真加了第二个窗口,这个判断要跟着改细。
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
const have = new Set()
const source = new Map()
for (const f of files) {
  const cap = JSON.parse(readFileSync(path.join(DIR, f), 'utf-8'))
  for (const p of cap.permissions ?? []) {
    const id = typeof p === 'string' ? p : String(p?.identifier ?? '')
    if (!id) continue
    have.add(id)
    if (!source.has(id)) source.set(id, f)
  }
}

const missing = Object.entries(REQUIRED).filter(([k]) => !have.has(k))

if (missing.length === 0) {
  console.log(`[OK] ${Object.keys(REQUIRED).length} 条必需权限都在(扫了 ${files.join(', ')})`)
  for (const k of Object.keys(REQUIRED)) console.log(`     ${k}  ←  ${source.get(k)}`)
  process.exit(0)
}

console.error(`[ERROR] ${DIR} 下缺少 ${missing.length} 条权限:\n`)
for (const [k, why] of missing) console.error(`  ${k}\n      用在:${why}`)
console.error(
  `\n少了这些不会有编译错误 —— 只会在用户点下去的那一刻报 "not allowed by ACL"。` +
    `\n把缺的加进 ${DIR}/migrated.json 的 permissions 数组。`,
)
process.exit(1)
