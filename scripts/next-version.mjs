/**
 * 算出下一个版本号,打到 stdout(形如 v1.0.1)。
 *
 * 为什么要它:版本号写在三个文件里,而 zip 文件名是从 package.json 拼的。靠人记得
 * 发版前手动改,忘一次就是两个同名的包 —— v2.5.4-r1 和 v2.5.4-r2 就是这么撞的。
 * 上一步把"tag 说了算"接上了,但版本号**还是得人自己想**。这一步把最后那点人工也去掉。
 *
 * 用法:
 *   node scripts/next-version.mjs                 # 从最近一个正式 Release 递增补丁号
 *   node scripts/next-version.mjs --latest v1.2.3 # 不查 API,直接按给定值算(测试用)
 *
 * 需要 GITHUB_REPOSITORY(owner/repo);GITHUB_TOKEN 可选,公开仓库不给也能查,
 * 只是走匿名额度。
 */

const PAT = /^v?(\d+)\.(\d+)\.(\d+)$/

/** 上一个 tag → 下一个补丁号。空字符串表示"还没发过"。 */
export function nextTag(latest) {
  const s = (latest ?? '').trim()
  // 还没有过 Release —— 这是正常的第一次,从 v1.0.0 起
  if (!s) return 'v1.0.0'
  const m = PAT.exec(s)
  if (!m) {
    // **不要**在这里退回 v1.0.0。那会去发一个早就发过的版本号,而报出来的错会是
    // "这个版本发过了",跟真正的原因(上一个 tag 看不懂)差着十万八千里。
    throw new Error(
      `读不懂上一个 Release 的版本号:${JSON.stringify(s)}\n` +
        `自动递增只认 vX.Y.Z。在 tag 里手动填一个明确的版本号再跑一次。`,
    )
  }
  const [, a, b, c] = m
  return `v${a}.${b}.${Number(c) + 1}`
}

/**
 * 查最近一个**正式** Release 的 tag。
 *
 * /releases/latest 会自动跳过 prerelease 和 draft —— 也就是 dev-<运行号> 那些开发构建
 * 不会被算进来,正是我们要的。一个也没有时它返回 404,那就是"还没发过"。
 *
 * 注意它取的是**最近发布的**,不是版本号最大的。我们的发布是线性的,两者一致;
 * 哪天开始维护老版本分支,这个判断要跟着改。
 */
export async function fetchLatest(repo, token) {
  const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (resp.status === 404) return ''
  if (!resp.ok) throw new Error(`查 Release 失败:HTTP ${resp.status} ${await resp.text()}`)
  return (await resp.json()).tag_name ?? ''
}

// 被 import 时(测试)不要跑主流程
const isMain = import.meta.url === `file://${process.argv[1]}`
if (!isMain) {
  // 什么都不做,只导出 nextTag / fetchLatest
} else {
const args = process.argv.slice(2)
const i = args.indexOf('--latest')
const latest =
  i >= 0
    ? args[i + 1] ?? ''
    : await fetchLatest(
        process.env.GITHUB_REPOSITORY ?? 'zhourg2010/Spigot',
        process.env.GITHUB_TOKEN ?? '',
      )

process.stdout.write(nextTag(latest) + '\n')
}
