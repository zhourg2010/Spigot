/**
 * free-pool.ts —— 免费节点池的实测:从订阅服务拉下来,用本机内核逐个拨,结果传回去。
 *
 * ## 为什么验证在客户端做
 *
 * Deno Deploy 上没有代理内核,拨不了节点 —— 服务端只能记"这条链接长什么样",
 * 记不了"它现在还能不能用"。而免费节点是从公开仓库抓来的,**最常见的死法是凭据
 * 失效或被封,不是端口关闭**:服务器还在跑、端口还开着、TLS 还握手成功,但 uuid
 * 早就作废了。所以"能不能用"只有真的拨一次才知道,而这台机器上正好有 mihomo。
 *
 * ## 怎么让内核认识这些节点
 *
 * mihomo 的 `/proxies/{name}/delay`(也就是 `delayProxyByName`)**只能测配置里已经
 * 加载的节点**。免费池不在你的订阅里,所以得先塞进去。
 *
 * 用的是 Clash Verge Rev 自带的 **`proxies` 类型 profile** —— 文件内容是
 * `{prepend, append, delete}`,`enhance/seq.rs` 的 `use_seq` 会把 `append` 里的节点
 * **追加**到运行时 `proxies` 列表(不是替换),然后 `enhance_profiles` 让内核重载。
 * 这是上游的一等机制,不是往配置里硬塞。
 *
 * **一个副作用得知道:** `use_seq` 追加之后,还会把这些名字塞进第一个 selector 类型的
 * 策略组(seq.rs:92 起)。所以测试期间这批节点会出现在代理选择列表里 —— 不会被自动
 * 选中、不影响路由,但看着乱。测完清空 append 就没了。
 *
 * ## 节点名用哈希,不用原名
 *
 * 免费节点的名字是抓来的,什么字符都可能有(emoji、引号、换行),而且**极可能跟你
 * 自己的节点重名** —— mihomo 遇到重名节点会直接拒绝加载整份配置。所以这里一律改名成
 * `chk-<uriHash 前 12 位>`:不可能撞、不可能坏 YAML,而且测完能凭名字直接映射回
 * uri_hash 传给服务端,不用另外维护一张表。
 */

import { fetch } from '@tauri-apps/plugin-http'

import type { ClashProxy, DenoPushSettings } from './deno-push'

/** 从 /free/pool?format=json 拿到的一行。字段名跟 Deno 端 store.ts 的 toRow 对齐。 */
export interface FreePoolRow {
  uriHash: string
  uri: string
  proto: string
  name: string
  server: string
  port: number
  sourceId: string
  seenCount: number
}

/** 一个节点的实测结果,直接就是 POST /free/verify 要的形状。 */
export interface CheckResult {
  uriHash: string
  ok: boolean
  latencyMs?: number | null
  err?: string
}

/**
 * 测试期间给节点用的名字。
 *
 * 12 位十六进制 = 48 bit,几万条里撞一次的概率约十亿分之一;真撞了后果也只是
 * 那一条测不出来(mihomo 会拒绝重名),不会污染结果。
 */
export function checkName(uriHash: string): string {
  return `chk-${uriHash.slice(0, 12)}`
}

/** 反过来:从测试名字认出是哪条。认不出返回 null(比如用户自己的节点混进来了)。 */
export function hashOfCheckName(name: string): string | null {
  const m = /^chk-([0-9a-f]{12})$/.exec(name)
  return m ? m[1] : null
}

// ---------------------------------------------------------------- 链接 → Clash 节点

function qs(u: URL): URLSearchParams {
  return u.searchParams
}

/** 传输层参数(ws / grpc),vless 和 trojan 共用同一套写法。 */
function transport(p: ClashProxy, sp: URLSearchParams, net: string): void {
  if (net === 'ws') {
    const path = sp.get('path')
    const host = sp.get('host')
    p['ws-opts'] = {
      ...(path ? { path } : {}),
      ...(host ? { headers: { Host: host } } : {}),
    }
  } else if (net === 'grpc') {
    const svc = sp.get('serviceName')
    if (svc) p['grpc-opts'] = { 'grpc-service-name': svc }
  }
}

/**
 * 分享链接 → Clash 节点对象。转不了返回 null。
 *
 * 这是 deno-push.ts 里 `toShareUri` 的**逆运算**,字段映射刻意保持一一对应 ——
 * 两边对不上的话,"推上去的"和"测过的"就不是同一个东西了,而那种错很难看出来。
 *
 * `name` 由调用方覆盖成 checkName(),这里填的是链接里的 fragment,只为调试时好认。
 */
export function parseShareUri(uri: string): ClashProxy | null {
  const s = (uri ?? '').trim()
  if (!s) return null

  // vmess 是整段 base64 的 JSON,跟其他协议不是一个路子,单独处理
  if (s.startsWith('vmess://')) return parseVmess(s)

  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }

  const server = u.hostname
  const port = Number(u.port)
  // 端口是 0 或者解析不出来的话,推给内核只会得到一个永远连不上的节点
  if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) return null

  const name = decodeURIComponent(u.hash.slice(1)) || `${server}:${port}`
  const sp = qs(u)
  const sni = sp.get('sni') || sp.get('peer') || undefined
  const proto = u.protocol.replace(':', '')

  if (proto === 'vless') {
    const uuid = decodeURIComponent(u.username)
    if (!uuid) return null
    const net = sp.get('type') || 'tcp'
    const security = sp.get('security') || 'none'
    const p: ClashProxy = {
      name,
      type: 'vless',
      server,
      port,
      uuid,
      network: net,
      udp: true,
      ...(security !== 'none' ? { tls: true } : {}),
      ...(sni ? { servername: sni } : {}),
      ...(sp.get('fp') ? { 'client-fingerprint': sp.get('fp')! } : {}),
      ...(sp.get('flow') ? { flow: sp.get('flow')! } : {}),
    }
    if (security === 'reality') {
      const pbk = sp.get('pbk')
      // reality 缺公钥是连不上的,与其推一个必然失败的节点,不如当成解析不了
      if (!pbk) return null
      p['reality-opts'] = {
        'public-key': pbk,
        ...(sp.get('sid') ? { 'short-id': sp.get('sid')! } : {}),
      }
    }
    transport(p, sp, net)
    return p
  }

  if (proto === 'trojan') {
    const password = decodeURIComponent(u.username)
    if (!password) return null
    const net = sp.get('type') || 'tcp'
    const p: ClashProxy = {
      name,
      type: 'trojan',
      server,
      port,
      password,
      udp: true,
      ...(sni ? { sni } : {}),
      ...(sp.get('allowInsecure') === '1' ? { 'skip-cert-verify': true } : {}),
      ...(net !== 'tcp' ? { network: net } : {}),
    }
    transport(p, sp, net)
    return p
  }

  if (proto === 'anytls') {
    const password = decodeURIComponent(u.username)
    if (!password) return null
    return {
      name,
      type: 'anytls',
      server,
      port,
      password,
      udp: true,
      ...(sni ? { sni } : {}),
      ...(sp.get('insecure') === '1' ? { 'skip-cert-verify': true } : {}),
    }
  }

  if (proto === 'ss') return parseSs(u, name)

  return null
}

/**
 * ss://  两种写法都要认:
 *   ss://base64(method:password)@host:port#name        新写法
 *   ss://base64(method:password@host:port)#name        老写法(整段都编码了)
 */
function parseSs(u: URL, name: string): ClashProxy | null {
  let method = ''
  let password = ''
  let server = u.hostname
  let port = Number(u.port)

  if (u.username && server) {
    const decoded = b64decode(decodeURIComponent(u.username))
    if (!decoded) return null
    const i = decoded.indexOf(':')
    if (i < 0) return null
    method = decoded.slice(0, i)
    password = decoded.slice(i + 1)
  } else {
    // 老写法:host 部分其实是整段 base64,URL 解析出来的 hostname 不可信
    const raw = u.href.slice('ss://'.length).split('#')[0]
    const decoded = b64decode(raw)
    if (!decoded) return null
    const at = decoded.lastIndexOf('@')
    if (at < 0) return null
    const cred = decoded.slice(0, at)
    const addr = decoded.slice(at + 1)
    const ci = cred.indexOf(':')
    const ai = addr.lastIndexOf(':')
    if (ci < 0 || ai < 0) return null
    method = cred.slice(0, ci)
    password = cred.slice(ci + 1)
    server = addr.slice(0, ai)
    port = Number(addr.slice(ai + 1))
  }

  if (!method || !password || !server) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { name, type: 'ss', server, port, cipher: method, password, udp: true }
}

function parseVmess(uri: string): ClashProxy | null {
  const decoded = b64decode(uri.slice('vmess://'.length))
  if (!decoded) return null
  let c: Record<string, unknown>
  try {
    c = JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
  const server = String(c.add ?? '')
  const port = Number(c.port)
  const uuid = String(c.id ?? '')
  if (!server || !uuid) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null

  const net = String(c.net || 'tcp')
  const p: ClashProxy = {
    name: String(c.ps || `${server}:${port}`),
    type: 'vmess',
    server,
    port,
    uuid,
    // alterId 缺省是 0(VMessAEAD)。老链接里可能是字符串,统一成数字。
    alterId: Number(c.aid ?? 0) || 0,
    cipher: String(c.scy || 'auto'),
    udp: true,
    network: net,
    ...(String(c.tls || '') === 'tls' ? { tls: true } : {}),
    ...(c.sni ? { servername: String(c.sni) } : {}),
  }
  if (net === 'ws') {
    const path = c.path ? String(c.path) : ''
    const host = c.host ? String(c.host) : ''
    p['ws-opts'] = {
      ...(path ? { path } : {}),
      ...(host ? { headers: { Host: host } } : {}),
    }
  } else if (net === 'grpc' && c.path) {
    p['grpc-opts'] = { 'grpc-service-name': String(c.path) }
  }
  return p
}

/** base64 解码,兼容 URL-safe 和缺省的 padding。解不开返回空串。 */
export function b64decode(s: string): string {
  const t = (s ?? '').trim().replace(/-/g, '+').replace(/_/g, '/')
  const padded = t + '='.repeat((4 - (t.length % 4)) % 4)
  try {
    // atob 出来的是 Latin-1 字节,节点名常有中文,得按 UTF-8 再解一次
    const bin = atob(padded)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- 跟服务端通信

function poolUrlOf(pushUrl: string, path: string): string | null {
  try {
    return new URL(path, pushUrl).toString()
  } catch {
    return null
  }
}

/** 拉一批免费节点。limit 是这一轮要测多少条。 */
export async function fetchFreePool(
  settings: DenoPushSettings,
  limit: number,
): Promise<FreePoolRow[]> {
  const url = poolUrlOf(settings.pushUrl, `/free/pool?format=json&limit=${limit}`)
  if (!url) throw new Error('推送地址不是一个合法网址,拉不了免费池')
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${settings.pushKey}` },
    connectTimeout: 30000,
  })
  if (!resp.ok) throw new Error(`拉免费池失败:HTTP ${resp.status} ${await resp.text()}`)
  const data = (await resp.json()) as { nodes?: FreePoolRow[] }
  return data.nodes ?? []
}

/** 把一轮结果传回服务端。轮号由服务端分配。 */
export async function reportChecks(
  settings: DenoPushSettings,
  results: CheckResult[],
): Promise<{ round: number; saved: number; skipped: number }> {
  const url = poolUrlOf(settings.pushUrl, '/free/verify')
  if (!url) throw new Error('推送地址不是一个合法网址,回传不了结果')
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.pushKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ results }),
    connectTimeout: 30000,
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`回传失败:HTTP ${resp.status} ${text}`)
  return JSON.parse(text) as { round: number; saved: number; skipped: number }
}
