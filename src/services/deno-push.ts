/**
 * deno-push.ts — 把当前 Clash 里"测过、好用"的美国节点一键推送到自建的 Deno 订阅服务。
 *
 * 设计约束(重要,改动前先读):
 *
 * 1. **只新增文件,尽量不改上游文件。** 这份代码是从 clash-verge-rev 克隆下来改的,
 *    以后还要跟上游同步。所以整套逻辑收在这个新文件里,对上游的侵入只有
 *    proxy-head.tsx 里加的那几行(渲染一个按钮)。改动越少,同步越省事。
 *
 * 2. **不写 Rust。** 需要的能力全都能从前端拿到:
 *      - 节点完整参数  → invoke('get_runtime_yaml'),这是内核当前真正加载的合并配置
 *      - 逐节点延迟    → tauri-plugin-mihomo-api 的 getProxies()
 *      - 域名解析      → DoH(Cloudflare 的 dns-json),见 resolveHost()
 *      - GeoIP         → 下载 sapics 的 CSV 缓存到 $APPDATA,本地二分查
 *      - POST 到 Deno  → @tauri-apps/plugin-http 的 fetch(不受 CORS 限制)
 *    权限方面 capabilities 里已有 http(允许任意 https/http URL)和 fs($APPDATA 可写),不用改。
 *
 * 3. **设置不进 IVergeConfig。** 那个结构体在 Rust 侧是强类型的,加字段就得改 Rust,
 *    还会跟上游冲突。改成自己的 JSON 文件放 $APPDATA。
 *
 * 为什么用 DoH 而不是内核的 /dns/query:Clash Verge Rev 默认不开外部控制器
 * (enable_external_controller 默认 false),内核只监听 unix socket / 命名管道,
 * 而 tauri-plugin-mihomo 没有封装 /dns/query。DoH 是前端自己就能发的普通 HTTPS 请求。
 */

import { invoke } from '@tauri-apps/api/core'
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { fetch } from '@tauri-apps/plugin-http'
// 必须是 * as,不能是默认导入:js-yaml 5.x 的 ESM 构建只有具名导出,没有 default。
// 仓库里其余 5 处用的也都是这个写法(见 proxies-editor-viewer.tsx 等)。
import * as yaml from 'js-yaml'
import { getProxies } from 'tauri-plugin-mihomo-api'

// ---------------------------------------------------------------- 设置

export interface DenoPushSettings {
  /** Deno 那边的 /push 接口地址 */
  pushUrl: string
  /** 推送密钥,对应 Deno Deploy 环境变量 PUSH_KEY */
  pushKey: string
  /** 推送节点数上限。跟 Deno 端 config.ts 的 NODE_CAP 保持一致 */
  maxNodes: number
  /** 延迟阈值(毫秒),超过的不推 */
  maxDelay: number
  /** 少于这个数就不推,保住 Deno 上一批(防止推空导致全家断网) */
  minKeep: number
  /** 严格模式:GeoIP 确认是美国才要;查不到也算不通过 */
  geoipStrict: boolean
}

export const DEFAULT_SETTINGS: DenoPushSettings = {
  pushUrl: '',
  pushKey: '',
  maxNodes: 100,
  maxDelay: 800,
  minKeep: 10,
  geoipStrict: true,
}

const SETTINGS_DIR = 'deno-push'
const SETTINGS_FILE = `${SETTINGS_DIR}/settings.json`

export async function loadSettings(): Promise<DenoPushSettings> {
  try {
    if (!(await exists(SETTINGS_FILE, { baseDir: BaseDirectory.AppData }))) {
      return { ...DEFAULT_SETTINGS }
    }
    const raw = await readTextFile(SETTINGS_FILE, {
      baseDir: BaseDirectory.AppData,
    })
    // 合并进默认值:以后加了新设置项,老的设置文件也不会因为缺字段而崩
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DenoPushSettings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: DenoPushSettings): Promise<void> {
  await mkdir(SETTINGS_DIR, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  })
  await writeTextFile(SETTINGS_FILE, JSON.stringify(s, null, 2), {
    baseDir: BaseDirectory.AppData,
  })
}

// ---------------------------------------------------------------- 节点类型

/** 从运行时配置里读出来的一个节点。字段名跟 Clash 配置一致。 */
export interface ClashProxy {
  name: string
  type: string
  server?: string
  port?: number | string
  uuid?: string
  password?: string
  tls?: boolean
  sni?: string
  servername?: string
  network?: string
  flow?: string
  cipher?: string
  alterId?: number
  'client-fingerprint'?: string
  'skip-cert-verify'?: boolean
  'reality-opts'?: { 'public-key'?: string; 'short-id'?: string }
  'ws-opts'?: { path?: string; headers?: Record<string, string> }
  'grpc-opts'?: { 'grpc-service-name'?: string }
  [k: string]: unknown
}

/** 能转成分享链接的协议。其余的(hysteria2/tuic/wireguard…)Deno 端的转换器不认,直接跳过。 */
const SUPPORTED = ['vless', 'anytls', 'trojan', 'vmess', 'ss'] as const
/**
 * 轮转顺序。vless 放最前是因为它在目标客户端里兼容性最好;
 * anytls 最窄(v2rayN 之外的 base64 客户端、Surge 都不支持),放最后。
 */
const PROTO_ORDER = ['vless', 'trojan', 'anytls', 'vmess', 'ss'] as const

export async function loadRuntimeProxies(): Promise<ClashProxy[]> {
  // 读的是内核当前真正加载的那份合并配置——比 profiles/ 下的原始订阅文件准确,
  // 节点名跟 API 报的是 1:1 对得上的,不会因为 profile 里配了改名脚本而错位。
  const text = await invoke<string>('get_runtime_yaml')
  const doc = yaml.load(text) as { proxies?: ClashProxy[] } | null
  const proxies = doc?.proxies ?? []
  return proxies.filter(
    (p) => p && typeof p.name === 'string' && SUPPORTED.includes(p.type as never),
  )
}

/** 从内核拿每个节点最近一次的实测延迟。0 / 缺失 = 当下不可用。 */
export async function loadDelays(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const res = await getProxies()
  for (const [name, info] of Object.entries(res.proxies ?? {})) {
    const history = (info as { history?: { delay?: number }[] }).history ?? []
    const last = history.at(-1)?.delay ?? 0
    if (last > 0) out.set(name, last)
  }
  return out
}

// ---------------------------------------------------------------- 域名解析

const dnsCache = new Map<string, string | null>()

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s)
  return !!m && m.slice(1).every((x) => Number(x) <= 255)
}

/**
 * 把节点的 server 解析成 IPv4。已经是 IP 字面量就直接返回。
 *
 * 走 DoH 而不是系统 DNS,是因为浏览器环境没有 DNS API;也没走内核的 /dns/query,
 * 原因见文件头。解析不出来返回 null,调用方按"无法核实"处理。
 */
export async function resolveHost(host: string): Promise<string | null> {
  if (!host) return null
  if (isIpv4(host)) return host
  if (dnsCache.has(host)) return dnsCache.get(host)!

  let ip: string | null = null
  try {
    const resp = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
      { headers: { accept: 'application/dns-json' }, connectTimeout: 8000 },
    )
    if (resp.ok) {
      const data = (await resp.json()) as { Answer?: { type: number; data: string }[] }
      // type 1 = A 记录。CNAME(type 5)会混在 Answer 里,要挑出 A。
      ip = data.Answer?.find((a) => a.type === 1 && isIpv4(a.data))?.data ?? null
    }
  } catch {
    ip = null
  }
  dnsCache.set(host, ip)
  return ip
}

// ---------------------------------------------------------------- GeoIP

/**
 * 数据源:sapics/ip-location-db 的 server-country 库。
 * PDDL 协议,不用注册也不用 key。特意选 server-country 而不是 user-country——
 * 后者是"优先判断经 VPN 用户的真实地区"(给反爬虫/合规场景用的),我们要的正相反:
 * 服务器本身的物理位置。
 * -num.csv 格式:起始IP,结束IP 已经是整数,不用自己转换。
 */
const GEOIP_URL =
  'https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv4-num.csv'
const GEOIP_FILE = `${SETTINGS_DIR}/country-ipv4-num.csv`
const GEOIP_MAX_AGE_MS = 7 * 24 * 3600 * 1000
const GEOIP_MIN_BYTES = 100 * 1024 // 小得离谱说明下到的是错误页而不是库

interface GeoDb {
  starts: number[]
  ends: number[]
  codes: string[]
}

let geoDb: GeoDb | null = null

export function ipToInt(ip: string): number {
  const m = IPV4_RE.exec(ip)
  if (!m) return -1
  // 用 * 而不是 <<:32 位左移在 JS 里会溢出成负数
  return (
    Number(m[1]) * 16777216 + Number(m[2]) * 65536 + Number(m[3]) * 256 + Number(m[4])
  )
}

export function parseGeoDb(text: string): GeoDb {
  const starts: number[] = []
  const ends: number[] = []
  const codes: string[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const a = line.indexOf(',')
    if (a < 0) continue
    const b = line.indexOf(',', a + 1)
    if (b < 0) continue
    const s = Number(line.slice(0, a))
    const e = Number(line.slice(a + 1, b))
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    starts.push(s)
    ends.push(e)
    codes.push(line.slice(b + 1, b + 3))
  }
  return { starts, ends, codes }
}

/**
 * 确保 GeoIP 库可用。超过 7 天就重新下载;下载失败但本地有旧的就继续用旧的——
 * 库是"验证增强",不是关键路径上不能有闪失的依赖。一次都没下成功过才返回 false,
 * 由调用方决定怎么降级。
 */
export async function ensureGeoDb(): Promise<boolean> {
  if (geoDb) return true

  await mkdir(SETTINGS_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  const opts = { baseDir: BaseDirectory.AppData } as const
  const has = await exists(GEOIP_FILE, opts)

  let stale = true
  if (has) {
    try {
      const meta = await readTextFile(`${SETTINGS_DIR}/geoip-updated.txt`, opts)
      stale = Date.now() - Number(meta) > GEOIP_MAX_AGE_MS
    } catch {
      stale = true
    }
  }

  if (!has || stale) {
    try {
      const resp = await fetch(GEOIP_URL, { connectTimeout: 30000 })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()
      if (text.length < GEOIP_MIN_BYTES) {
        throw new Error(`文件小得离谱(${text.length} 字节),多半下到的是错误页`)
      }
      await writeTextFile(GEOIP_FILE, text, opts)
      await writeTextFile(`${SETTINGS_DIR}/geoip-updated.txt`, String(Date.now()), opts)
      geoDb = parseGeoDb(text)
      return true
    } catch {
      // 下载失败。本地有旧的就用旧的,没有就只能报不可用。
      if (!has) return false
    }
  }

  try {
    geoDb = parseGeoDb(await readTextFile(GEOIP_FILE, opts))
    return geoDb.starts.length > 0
  } catch {
    return false
  }
}

/**
 * 查一个 IPv4 属于哪个国家(ISO 两位码)。
 * 查不到返回 null —— 调用方要把 null 当成"验证不了",**不能**当成"确认不是目标国家"。
 */
export function countryOfIp(ip: string): string | null {
  if (!geoDb) return null
  const n = ipToInt(ip)
  if (n < 0) return null

  const { starts, ends, codes } = geoDb
  let lo = 0
  let hi = starts.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= n) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (hit < 0) return null
  return n <= ends[hit] ? codes[hit] : null
}

// ---------------------------------------------------------------- 分享链接

function q(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, v)
  }
  return sp.toString()
}

/**
 * 把一个 Clash 节点转成分享链接(Deno 端 /push 收的就是这个格式)。
 * 转不了的返回空串。
 */
export function toShareUri(p: ClashProxy): string {
  const host = String(p.server ?? '')
  const port = String(p.port ?? '')
  const frag = encodeURIComponent(p.name)
  if (!host || !port) return ''

  const sni = (p.servername || p.sni || '') as string
  const ws = p['ws-opts']
  const wsHost = ws?.headers?.Host ?? ws?.headers?.host
  const grpcName = p['grpc-opts']?.['grpc-service-name']
  const net = (p.network as string) || 'tcp'

  if (p.type === 'vless') {
    if (!p.uuid) return ''
    const reality = p['reality-opts']
    const params: Record<string, string | undefined> = {
      encryption: 'none',
      type: net,
      security: reality ? 'reality' : p.tls ? 'tls' : 'none',
      pbk: reality?.['public-key'],
      sid: reality?.['short-id'],
      sni: sni || undefined,
      fp: p['client-fingerprint'],
      flow: p.flow,
    }
    if (net === 'ws') {
      params.path = ws?.path
      params.host = wsHost
    } else if (net === 'grpc') {
      params.serviceName = grpcName
    }
    return `vless://${p.uuid}@${host}:${port}?${q(params)}#${frag}`
  }

  if (p.type === 'anytls') {
    if (!p.password) return ''
    const params = {
      sni: sni || undefined,
      insecure: p['skip-cert-verify'] ? '1' : '0',
    }
    return `anytls://${encodeURIComponent(p.password)}@${host}:${port}/?${q(params)}#${frag}`
  }

  if (p.type === 'trojan') {
    if (!p.password) return ''
    const params: Record<string, string | undefined> = {
      sni: sni || undefined,
      allowInsecure: p['skip-cert-verify'] ? '1' : undefined,
    }
    if (net && net !== 'tcp') {
      params.type = net
      if (net === 'ws') {
        params.path = ws?.path
        params.host = wsHost
      } else if (net === 'grpc') {
        params.serviceName = grpcName
      }
    }
    return `trojan://${encodeURIComponent(p.password)}@${host}:${port}?${q(params)}#${frag}`
  }

  if (p.type === 'vmess') {
    if (!p.uuid) return ''
    // vmess 的分享链接是整段 base64 过的 JSON,跟其他协议不是一个路子
    const conf = {
      v: '2',
      ps: p.name,
      add: host,
      port: String(port),
      id: p.uuid,
      aid: String(p.alterId ?? 0),
      net,
      type: 'none',
      host: wsHost ?? '',
      path: ws?.path ?? '',
      tls: p.tls ? 'tls' : '',
      sni: sni || '',
    }
    return `vmess://${utf8ToBase64(JSON.stringify(conf))}`
  }

  if (p.type === 'ss') {
    if (!p.cipher || !p.password) return ''
    const userinfo = utf8ToBase64(`${p.cipher}:${p.password}`)
    return `ss://${userinfo}@${host}:${port}#${frag}`
  }

  return ''
}

/** btoa 只吃 Latin-1,节点名里有中文会抛异常,所以先编码成字节。 */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// ---------------------------------------------------------------- 选点

/**
 * 按协议轮转取节点,取满 limit 个为止。
 *
 * 比"每协议固定配额"好在两点:某协议节点少的时候名额会自动让给别的协议,不会白白浪费;
 * 而且轮转天然保证各协议都有代表,不会出现"Deno 那边某个客户端链接过滤掉某协议之后
 * 一个节点都不剩"的情况。
 */
export function roundRobin(byProto: Map<string, ClashProxy[]>, limit: number): ClashProxy[] {
  const out: ClashProxy[] = []
  const idx = new Map<string, number>()
  for (;;) {
    let progressed = false
    for (const proto of PROTO_ORDER) {
      const pool = byProto.get(proto)
      if (!pool) continue
      const i = idx.get(proto) ?? 0
      if (i < pool.length) {
        out.push(pool[i])
        idx.set(proto, i + 1)
        progressed = true
        if (out.length >= limit) return out
      }
    }
    if (!progressed) return out
  }
}

export interface PushReport {
  ok: boolean
  message: string
  /** 运行时配置里能转成分享链接的节点总数 */
  total: number
  /** 经 GeoIP 确认在美国的 */
  us: number
  /** 美国且延迟达标的 */
  alive: number
  /** 最终推送的(不含末尾的时间戳标记节点) */
  pushed: number
  /** 名字写着美国但 GeoIP 判定不是——机场标错国家的信号 */
  mislabeled: number
  /** 域名解析不了或库里查不到 */
  unverified: number
  byProto: Record<string, number>
}

/** 节点名里"看起来像美国"的写法。只在非严格模式下当线索,严格模式下名字不算数。 */
const US_HINTS = ['🇺🇸', '美国', '美國', 'UNITED STATES', 'USA']

export function looksUs(name: string): boolean {
  const upper = name.toUpperCase()
  if (/^\s*US[\s_\-|]/.test(upper) || upper.startsWith('US-') || upper.startsWith('US_')) {
    return true
  }
  return US_HINTS.some((h) => name.includes(h) || upper.includes(h))
}

// ---------------------------------------------------------------- 主流程

/**
 * 一键推送。
 *
 * 顺序:读运行时节点 → 拿延迟 → 并发解析 IP → GeoIP 筛美国 → 按延迟筛 → 轮转选点
 * → base64 → POST。
 *
 * 判据是 **GeoIP,不是节点名**。机场的命名五花八门("🇺🇸 美国 洛杉矶 01"、"US-LA-01"、
 * "United States 03"…),拿名字当硬门槛会误杀一大片(这个坑在 Python 版踩过:
 * 8 个真实机场命名里 3 个美国节点被误杀,而且日志里看不出是误杀)。
 */
export async function pushToDeno(
  settings: DenoPushSettings,
  onProgress?: (msg: string) => void,
): Promise<PushReport> {
  const say = (m: string) => onProgress?.(m)
  const empty: PushReport = {
    ok: false,
    message: '',
    total: 0,
    us: 0,
    alive: 0,
    pushed: 0,
    mislabeled: 0,
    unverified: 0,
    byProto: {},
  }

  if (!settings.pushUrl || !settings.pushKey) {
    return { ...empty, message: '还没填推送地址和密钥,先去设置里配好。' }
  }

  say('读取内核当前加载的节点…')
  const proxies = await loadRuntimeProxies()
  if (proxies.length === 0) {
    return { ...empty, message: '内核里没有可转换的节点(vless/anytls/trojan/vmess/ss)。' }
  }

  say('准备 GeoIP 库…')
  const geoReady = await ensureGeoDb()
  if (!geoReady && settings.geoipStrict) {
    // 严格模式下没有 GeoIP 就等于没有判据。这时候推送等于把一池子没核实过国家的
    // 节点发出去,不如不推——Deno 上一批还在,家里不会断网。
    return {
      ...empty,
      total: proxies.length,
      message:
        'GeoIP 库不可用(下载失败且本地没有缓存)。严格模式下无法核实节点是否真在美国,' +
        '本轮不推送,保留 Deno 上一批节点。',
    }
  }

  say('查询节点延迟…')
  let delays = new Map<string, number>()
  try {
    delays = await loadDelays()
  } catch {
    // 拿不到延迟不致命——下面会因为没有延迟数据而全部落到"未测速"分支,
    // 由调用方在界面上提示先点一下测延迟。
  }

  say(`解析 ${proxies.length} 个节点的服务器地址…`)
  const hosts = [...new Set(proxies.map((p) => String(p.server ?? '')).filter(Boolean))]
  const ipOf = new Map<string, string | null>()
  // 并发解析。串行的话一个解析不了的域名要等超时,几百个节点能拖到分钟级。
  const CONCURRENCY = 16
  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    const batch = hosts.slice(i, i + CONCURRENCY)
    const ips = await Promise.all(batch.map((h) => resolveHost(h)))
    batch.forEach((h, k) => ipOf.set(h, ips[k]))
  }

  say('按 GeoIP 筛选美国节点…')
  const report = { ...empty, total: proxies.length }
  const usNodes: ClashProxy[] = []
  for (const p of proxies) {
    const ip = ipOf.get(String(p.server ?? '')) ?? null
    const cc = ip && geoReady ? countryOfIp(ip) : null
    if (cc === 'US') {
      usNodes.push(p)
      continue
    }
    if (cc === null) {
      report.unverified++
      // "验证不了"在只要美国节点的前提下等同于"不算数"。非严格模式才退回看名字。
      if (!settings.geoipStrict && looksUs(p.name)) usNodes.push(p)
      continue
    }
    if (looksUs(p.name)) report.mislabeled++
  }
  report.us = usNodes.length
  if (usNodes.length === 0) {
    return { ...report, message: '一个经 GeoIP 确认的美国节点都没有,本轮不推送。' }
  }

  const alive = usNodes
    .map((p) => ({ p, delay: delays.get(p.name) ?? 0 }))
    .filter((x) => x.delay > 0 && x.delay <= settings.maxDelay)
    .sort((a, b) => a.delay - b.delay)
  report.alive = alive.length

  if (alive.length === 0) {
    return {
      ...report,
      message:
        `${usNodes.length} 个美国节点里没有一个延迟达标(≤${settings.maxDelay}ms)。` +
        '先点一下测延迟按钮,再来推送。',
    }
  }

  const byProto = new Map<string, ClashProxy[]>()
  for (const { p } of alive) {
    const list = byProto.get(p.type) ?? []
    list.push(p)
    byProto.set(p.type, list)
  }
  const picked = roundRobin(byProto, settings.maxNodes)

  const uris = picked.map(toShareUri).filter(Boolean)
  for (const p of picked) {
    report.byProto[p.type] = (report.byProto[p.type] ?? 0) + 1
  }

  if (uris.length < settings.minKeep) {
    return {
      ...report,
      pushed: uris.length,
      message:
        `只凑出 ${uris.length} 个节点,低于安全线 ${settings.minKeep} 个。` +
        '本轮不推送,保留 Deno 上一批节点。',
    }
  }

  // 末尾追加一个时间戳标记节点(指向 127.0.0.1,连不通)。它的作用只是让家人在客户端
  // 节点列表末尾一眼看出这批节点是什么时候推的。Deno 端会把它排除在数量统计之外。
  const stamp = `🇺🇸US 更新于 ${formatNow()}`
  uris.push(
    'vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1' +
      `?encryption=none&security=none&type=tcp#${encodeURIComponent(stamp)}`,
  )

  say(`推送 ${uris.length - 1} 个节点…`)
  const body = utf8ToBase64(uris.join('\n') + '\n')
  try {
    const resp = await fetch(settings.pushUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.pushKey}`,
        'content-type': 'text/plain; charset=utf-8',
      },
      body,
      connectTimeout: 30000,
    })
    const text = await resp.text()
    if (!resp.ok) {
      return { ...report, pushed: 0, message: `推送失败 HTTP ${resp.status}: ${text.slice(0, 200)}` }
    }
    return {
      ...report,
      ok: true,
      pushed: uris.length - 1,
      message: `已推送 ${uris.length - 1} 个美国节点。`,
    }
  } catch (e) {
    return { ...report, pushed: 0, message: `推送出错: ${String(e)}` }
  }
}

function formatNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}
