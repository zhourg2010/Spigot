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
 * ## 为什么另起一个进程,而不是把节点塞进你自己的配置
 *
 * mihomo 的 `/proxies/{name}/delay` **只能测配置里已经加载的节点**,所以免费池得先
 * 进内核。往用户正在用的那份配置里塞是能做到的(Clash Verge Rev 的 `proxies` 类型
 * profile 就干这个),但代价太大:几十上百条来路不明的节点会出现在代理选择列表里,
 * 会被 `use_seq` 塞进第一个策略组,重载配置那一下**正在走的连接会断**,而且中途出
 * 任何岔子——崩溃、断电、用户点了别的——这些节点就留在配置里了。
 *
 * 测一批节点不值得动用户手里那份能上网的配置。所以这里单独起一个 mihomo:
 * `mixed-port: 0`(不监听任何代理端口,不可能跟主内核抢)、只开一个随机端口的
 * external-controller、规则只有一条 `MATCH,DIRECT`。它只用来拨号,测完就杀。
 * 进程管理在 `src-tauri/src/cmd/probe.rs`,退出时也会兜底杀一次。
 *
 * ## 节点名用哈希,不用原名
 *
 * 免费节点的名字是抓来的,什么字符都可能有(emoji、引号、换行),而且**极可能跟你
 * 自己的节点重名** —— mihomo 遇到重名节点会直接拒绝加载整份配置。所以这里一律改名成
 * `chk-<uriHash 前 12 位>`:不可能撞、不可能坏 YAML,而且测完能凭名字直接映射回
 * uri_hash 传给服务端,不用另外维护一张表。
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch } from '@tauri-apps/plugin-http'
import * as yaml from 'js-yaml'

import { createProfile } from './cmds'
import { mapPool } from './deno-push'
import type { ClashProxy, DenoPushSettings } from './deno-push'

/**
 * 一个节点在服务端保留的那几轮里的实测战绩。跟 Deno 端 store.ts 的 CheckStat 对齐。
 *
 * **`lastOk` 是 `boolean | null`,null 表示从没测过 —— 跟 false 不是一回事。**
 * 当成 false 的话,一整池刚抓来还没轮到的节点会被判成"不通",而它们只是还没排上队。
 */
export interface CheckStat {
  /** 被测过几次。0 = 从来没测过 */
  checked: number
  /** 其中通了几次 */
  ok: number
  /** 最后一次的结果。没测过是 null */
  lastOk: boolean | null
  /** 最后一次测的时间,'MM-DD HH:MM'。没测过是空串 */
  lastTs: string
  /** 通的那几次的延迟中位数。一次都没通过是 null */
  medianMs: number | null
}

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
  check: CheckStat
}

/** 服务端没带 check 字段时(老版本部署)的兜底,免得界面上到处判 undefined。 */
export const NO_CHECK: CheckStat = {
  checked: 0,
  ok: 0,
  lastOk: null,
  lastTs: '',
  medianMs: null,
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
  // 不给初值:两条分支都必然赋值或者提前 return,给个 '' 只会掩盖漏赋值的分支
  let method: string
  let password: string
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
  order: 'popular' | 'stale' = 'popular',
): Promise<FreePoolRow[]> {
  const url = poolUrlOf(settings.pushUrl, `/free/pool?format=json&limit=${limit}&order=${order}`)
  if (!url) throw new Error('推送地址不是一个合法网址,拉不了免费池')
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${settings.pushKey}` },
    connectTimeout: 30000,
  })
  if (!resp.ok) throw new Error(`拉免费池失败:HTTP ${resp.status} ${await resp.text()}`)
  const data = (await resp.json()) as { nodes?: FreePoolRow[] }
  // check 字段是后加的。服务端还没更新时这里是 undefined,补上兜底,
  // 免得下游每个筛选条件都得先判一次"有没有这个字段"。
  return (data.nodes ?? []).map((n) => (n.check ? n : { ...n, check: NO_CHECK }))
}

/** 每轮的通过率,新的在前。服务端只留最近 keepRounds 轮。 */
export interface RoundStat {
  round: number
  /** 'MM-DD HH:MM',服务端拼好的 */
  ts: string
  total: number
  ok: number
  medianMs: number | null
}

/**
 * 拉历轮汇总。
 *
 * 单看一轮的数字说明不了什么 —— 免费池本来就是通一半、坏一半。要看的是**趋势**:
 * 通过率一路往下,说明抓来的源在烂掉;突然掉到零,那多半是本机网络的问题,不是节点。
 */
export async function fetchRounds(settings: DenoPushSettings): Promise<RoundStat[]> {
  const url = poolUrlOf(settings.pushUrl, '/free/verify')
  if (!url) throw new Error('推送地址不是一个合法网址,拉不了历轮汇总')
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${settings.pushKey}` },
    connectTimeout: 30000,
  })
  if (!resp.ok) throw new Error(`拉历轮汇总失败:HTTP ${resp.status} ${await resp.text()}`)
  const data = (await resp.json()) as { rounds?: RoundStat[] }
  return data.rounds ?? []
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

// ---------------------------------------------------------------- 探针内核

interface ProbeInfo {
  port: number
  secret: string
}

/**
 * 待测节点 → 探针配置里 `proxies:` 底下那一段。
 *
 * 用 js-yaml 生成而不是手拼字符串:节点里什么字符都可能有(密码里的引号、路径里的
 * 井号、名字里的冒号),手拼一定会在某条数据上翻车,而翻车的表现是整个探针起不来,
 * 却看不出是哪一条的问题。
 */
export function buildProbeYaml(nodes: ClashProxy[]): string {
  // 顶层是个序列,dump 出来是 "- name: ...",再整体缩进两格塞进 proxies: 下面
  return yaml
    .dump(nodes, { lineWidth: -1 })
    .split('\n')
    .map((l: string) => (l ? `  ${l}` : l))
    .join('\n')
}

/** 探针起来之后要等它把 controller 端口监听上。轮询 /version,通了才算好。 */
async function waitReady(info: ProbeInfo, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${info.port}/version`, {
        headers: { authorization: `Bearer ${info.secret}` },
        connectTimeout: 2000,
      })
      if (r.ok) return
      lastErr = `HTTP ${r.status}`
    } catch (e) {
      lastErr = String(e)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  // 起不来最常见的原因是配置里有条节点 mihomo 不认(比如协议参数缺字段)。
  // 把最后一次的错带上,不然只有一句"超时",无从查起。
  throw new Error(`探针内核 ${timeoutMs / 1000} 秒内没起来(最后一次:${lastErr})`)
}

/** 通过探针测一个节点。返回延迟毫秒;不通返回 null 并带上原因。 */
async function delayOne(
  info: ProbeInfo,
  name: string,
  testUrl: string,
  timeout: number,
): Promise<{ ms: number | null; err: string }> {
  const u =
    `http://127.0.0.1:${info.port}/proxies/${encodeURIComponent(name)}/delay` +
    `?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`
  try {
    const r = await fetch(u, {
      headers: { authorization: `Bearer ${info.secret}` },
      // 比内核自己的超时多给 5 秒:让内核先超时并告诉我们原因,
      // 而不是 HTTP 这一层先断掉、我们只知道"没响应"
      connectTimeout: timeout + 5000,
    })
    const text = await r.text()
    if (!r.ok) {
      // mihomo 拨不通时返回 4xx/5xx + {"message":"..."}
      let msg = text.slice(0, 120)
      try {
        msg = String((JSON.parse(text) as { message?: string }).message ?? msg)
      } catch {
        /* 不是 JSON 就用原文 */
      }
      return { ms: null, err: msg }
    }
    const d = (JSON.parse(text) as { delay?: number }).delay
    return typeof d === 'number' && d > 0
      ? { ms: d, err: '' }
      : { ms: null, err: '内核返回的延迟不是正数' }
  } catch (e) {
    return { ms: null, err: String(e).slice(0, 120) }
  }
}

export interface VerifyOptions {
  /** 这一轮测多少条 */
  limit: number
  /** 拿什么地址判定"通" */
  testUrl: string
  /** 单条超时(毫秒) */
  timeout: number
  /** 同时拨几个 */
  concurrency: number
}

export const DEFAULT_VERIFY: VerifyOptions = {
  limit: 50,
  testUrl: 'http://www.gstatic.com/generate_204',
  timeout: 5000,
  concurrency: 8,
}

export interface VerifyReport {
  fetched: number
  /** 解析不出 Clash 节点的条数 —— 这些没测,也没上报 */
  unparsable: number
  tested: number
  ok: number
  round: number
  saved: number
  skipped: number
}

/**
 * 跑完整的一轮:拉池子 → 起探针 → 逐个拨 → 回传 → 收摊。
 *
 * **无论中间哪一步炸,探针都会被杀掉**(finally)。留一个孤儿 mihomo 在系统里
 * 是这个功能最讨厌的失败方式:它占着端口、还连着网,而用户完全看不见。
 */
export async function runVerifyRound(
  settings: DenoPushSettings,
  opts: VerifyOptions,
  onProgress?: (msg: string) => void,
): Promise<VerifyReport> {
  const say = (m: string) => onProgress?.(m)

  say('拉取免费节点池…')
  // stale:最久没测的优先。默认顺序是确定性的,每轮拿到的会是同一批 ——
  // 测七轮等于把同样那几十条测了七遍,池子里其余几千条一次都轮不到。
  const rows = await fetchFreePool(settings, opts.limit, 'stale')
  if (rows.length === 0) throw new Error('免费池是空的,先去后台跑一轮抓取')

  say(`解析 ${rows.length} 条分享链接…`)
  const nodes: ClashProxy[] = []
  const hashOf = new Map<string, string>()
  for (const r of rows) {
    const p = parseShareUri(r.uri)
    if (!p) continue
    const name = checkName(r.uriHash)
    nodes.push({ ...p, name })
    hashOf.set(name, r.uriHash)
  }
  const unparsable = rows.length - nodes.length
  if (nodes.length === 0) throw new Error(`${rows.length} 条链接一条都解析不了`)

  say(`启动探针内核(${nodes.length} 个节点)…`)
  const info = await invoke<ProbeInfo>('probe_start', {
    proxiesYaml: buildProbeYaml(nodes),
  })

  const results: CheckResult[] = []
  try {
    await waitReady(info)

    let done = 0
    await mapPool(
      nodes,
      opts.concurrency,
      async (n: ClashProxy) => {
        const { ms, err } = await delayOne(info, n.name, opts.testUrl, opts.timeout)
        results.push({
          uriHash: hashOf.get(n.name)!,
          ok: ms !== null,
          latencyMs: ms,
          err: ms === null ? err : '',
        })
      },
      (d: number) => {
        done = d
        if (d === nodes.length || d % 5 === 0) say(`实测中 ${done}/${nodes.length}…`)
      },
    )
  } finally {
    // 不管上面怎么炸,进程必须收掉
    await invoke('probe_stop').catch(() => {})
  }

  say('回传结果…')
  const r = await reportChecks(settings, results)

  return {
    fetched: rows.length,
    unparsable,
    tested: results.length,
    ok: results.filter((x) => x.ok).length,
    round: r.round,
    saved: r.saved,
    skipped: r.skipped,
  }
}

// ---------------------------------------------------------------- 筛选

/**
 * 免费池的筛选条件。**每一条都是可选的** —— 判据由用户在界面上定,这里不替他预设
 * 任何"什么算好节点"。
 *
 * 之所以全做成开关而不是写死一套判据:免费池的成色随时间变化很大。源好的时候
 * "测过 3 次全通"能筛出几百条,源烂的时候同样的条件一条都没有,而用户看到的是
 * 一个空列表,不知道是没节点还是条件太严。让他自己松紧,至少知道自己在做什么。
 */
export interface PoolFilter {
  /** 名字 / 服务器 / 来源里搜这个词 */
  kw: string
  /** 只要这个协议。'' = 不限 */
  proto: string
  /** 只要这个来源。'' = 不限 */
  sourceId: string
  /** 至少被测过几次。0 = 不限(没测过的也留着) */
  minChecked: number
  /** 通过率至少百分之几(0~100)。只在 checked > 0 时有意义 */
  minOkRate: number
  /** 最后一次必须是通的 */
  lastMustOk: boolean
  /** 延迟中位数上限(毫秒)。0 = 不限 */
  maxMedianMs: number
  /** 抓取时至少出现过几次(seen_count) */
  minSeen: number
}

export const EMPTY_FILTER: PoolFilter = {
  kw: '',
  proto: '',
  sourceId: '',
  minChecked: 0,
  minOkRate: 0,
  lastMustOk: false,
  maxMedianMs: 0,
  minSeen: 0,
}

/** 通过率,百分数。一次没测过是 0 —— 但别拿它当"测了都不通",那是 minChecked 管的事。 */
export function okRate(c: CheckStat): number {
  return c.checked > 0 ? Math.round((c.ok / c.checked) * 100) : 0
}

/**
 * 一条节点过不过筛。
 *
 * **没测过的节点怎么办**,是这个函数唯一需要想清楚的事:
 *
 * - `minChecked` 是 0 时,没测过的**留着**。它们只是还没排上队,不是不通。
 *   刚抓来一批新节点、还没跑过实测,这时候把它们全滤掉等于告诉用户"池子是空的"。
 * - 只要用了任何一条**跟实测有关**的条件(通过率、最后一次必须通、延迟上限),
 *   没测过的就**过不了** —— 因为这些条件对它们无从判断,放过去等于默认它们合格。
 *
 * 换句话说:不问就不管,一问就必须有答案。
 */
export function passesFilter(r: FreePoolRow, f: PoolFilter): boolean {
  if (f.proto && r.proto !== f.proto) return false
  if (f.sourceId && r.sourceId !== f.sourceId) return false
  if (f.minSeen > 0 && r.seenCount < f.minSeen) return false

  const c = r.check ?? NO_CHECK
  if (f.minChecked > 0 && c.checked < f.minChecked) return false

  // 下面三条都要求"测过"。没测过的在这里被挡掉,不是因为它不通,
  // 而是因为用户问了一个对它无法回答的问题。
  if (f.minOkRate > 0 && (c.checked === 0 || okRate(c) < f.minOkRate)) return false
  if (f.lastMustOk && c.lastOk !== true) return false
  if (f.maxMedianMs > 0 && (c.medianMs == null || c.medianMs > f.maxMedianMs)) return false

  if (f.kw) {
    const k = f.kw.trim().toLowerCase()
    if (
      k &&
      !r.name.toLowerCase().includes(k) &&
      !r.server.toLowerCase().includes(k) &&
      !r.sourceId.toLowerCase().includes(k)
    ) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------- 生成本地 profile

/**
 * 挑出来的免费节点 → 一份完整的 Clash 配置。
 *
 * ## 为什么是**独立的一份**,不往现有配置里合
 *
 * 上游 `enhance/merge.rs` 的 `deep_merge` 对非 mapping 一律 `*a = b` —— 往 merge
 * profile 里写 `proxies:` 会把你真正的节点**整个替换掉**,不是追加。这条已经查证过
 * (`merge.rs` 的测试夹具里那个 `append-proxies` 只是夹具,实现里没有对应处理,
 * 而且那个测试根本没断言)。所以这里生成的是一份**自足的 local profile**,
 * 你在配置列表里手动切过去用,切回来什么都没变。
 *
 * ## 配置里放什么
 *
 * 一个 `select` 组(手动挑)+ 一个 `url-test` 组(自动挑最快的),规则只有一条
 * `MATCH`。**刻意不写端口、DNS、tun 这些** —— 那些是 Clash Verge Rev 自己按你在
 * 「设置」里的选择注入的(`enhance/mod.rs`),在 profile 里写死会跟界面上的设置打架:
 * 界面显示一套、实际生效另一套,而且看不出为什么。
 */
export function buildFreeProfile(nodes: ClashProxy[], title = '免费节点'): string {
  const names = nodes.map((n) => n.name)
  const config = {
    proxies: nodes,
    'proxy-groups': [
      { name: title, type: 'select', proxies: ['自动选择', ...names] },
      {
        name: '自动选择',
        type: 'url-test',
        proxies: names,
        url: DEFAULT_VERIFY.testUrl,
        interval: 300,
        tolerance: 50,
      },
    ],
    rules: [`MATCH,${title}`],
  }
  return yaml.dump(config, { lineWidth: -1 })
}

/**
 * 把选中的免费节点做成一份本地 profile。返回实际写进去几个节点。
 *
 * 名字用**原始名字加前缀**而不是实测时那个 `chk-<hash>`:实测期间用哈希是为了不跟
 * 你自己的节点重名、不坏 YAML;但这份配置是给人看的,一列 `chk-a1b2c3` 没法用。
 * 前缀留着,是为了在代理列表里一眼认出哪些是免费来的。
 *
 * 重名会让 mihomo **拒绝加载整份配置**,所以同名的后面补序号。
 */
export async function createFreeProfile(
  rows: FreePoolRow[],
  title = '免费节点',
): Promise<number> {
  const used = new Set<string>()
  const nodes: ClashProxy[] = []
  for (const r of rows) {
    const p = parseShareUri(r.uri)
    if (!p) continue
    // 名字可能有 emoji、引号、换行 —— 换行会直接坏掉 YAML 的块结构,先清掉
    const base = `[免费] ${(r.name || r.server).replace(/\s+/g, ' ').trim()}`.slice(0, 60)
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base} ${i}`
    used.add(name)
    nodes.push({ ...p, name })
  }
  if (nodes.length === 0) throw new Error('选中的这些一条都解析不出来,生成不了配置')

  await createProfile(
    {
      type: 'local',
      name: title,
      desc: `免费池实测挑出来的 ${nodes.length} 个,${new Date().toLocaleString()}`,
      url: '',
      option: { with_proxy: false, self_proxy: false },
    },
    buildFreeProfile(nodes, title),
  )
  return nodes.length
}
