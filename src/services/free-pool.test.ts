import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'


import { toShareUri } from './deno-push'
import {
  b64decode,
  buildFreeProfile,
  buildProbeYaml,
  type CheckStat,
  checkName,
  EMPTY_FILTER,
  type FreePoolRow,
  hashOfCheckName,
  NO_CHECK,
  okRate,
  parseShareUri,
  passesFilter,
} from './free-pool'

/**
 * 这里最重要的是**往返一致**:拿 toShareUri 生成链接,再 parseShareUri 反解析回来,
 * 关键字段必须一模一样。
 *
 * 为什么这条最重要:两边对不上的话,"推给家人的"和"测过的"就不是同一个东西了 ——
 * 而那种错不会报任何异常,只会表现为"明明测通了,家人却连不上",极难往这上面想。
 */
const ROUND_TRIP: Array<[string, Record<string, unknown>]> = [
  [
    'vless + reality + grpc',
    {
      name: 'US-1', type: 'vless', server: 'a.example.com', port: 443,
      uuid: '11111111-2222-3333-4444-555555555555', tls: true, servername: 'www.apple.com',
      network: 'grpc', flow: 'xtls-rprx-vision', 'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'PBK123', 'short-id': 'ab' },
      'grpc-opts': { 'grpc-service-name': 'gsvc' },
    },
  ],
  [
    'vless + tls + ws',
    {
      name: 'US-2', type: 'vless', server: 'b.example.com', port: 8443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tls: true, servername: 'cdn.example.com',
      network: 'ws', 'ws-opts': { path: '/ray', headers: { Host: 'cdn.example.com' } },
    },
  ],
  [
    'trojan + ws',
    {
      name: 'JP-1', type: 'trojan', server: 'c.example.com', port: 443,
      password: 'p@ss w/rd', sni: 'c.example.com', network: 'ws', 'skip-cert-verify': true,
      'ws-opts': { path: '/t', headers: { Host: 'h.example.com' } },
    },
  ],
  ['trojan 裸 tcp', { name: 'JP-2', type: 'trojan', server: 'd.example.com', port: 443, password: 'pw', sni: 'd.example.com' }],
  ['anytls', { name: 'SG-1', type: 'anytls', server: 'e.example.com', port: 8443, password: 'pw123', sni: 'e.example.com', 'skip-cert-verify': true }],
  [
    'vmess + ws + tls(名字带中文和 emoji)',
    {
      name: '中文节点 🇺🇸', type: 'vmess', server: 'f.example.com', port: 443,
      uuid: '99999999-8888-7777-6666-555555555555', alterId: 0, cipher: 'auto', tls: true,
      servername: 'f.example.com', network: 'ws',
      'ws-opts': { path: '/v', headers: { Host: 'f.example.com' } },
    },
  ],
  ['ss', { name: 'HK-1', type: 'ss', server: 'g.example.com', port: 8388, cipher: 'aes-256-gcm', password: 'sspw' }],
]

const KEYS = ['type', 'server', 'port', 'uuid', 'password', 'cipher', 'servername', 'sni', 'network', 'flow', 'client-fingerprint']

describe('parseShareUri 往返', () => {
  it.each(ROUND_TRIP)('%s', (_label, orig) => {
    const uri = toShareUri(orig as never)
    expect(uri).toBeTruthy()
    const back = parseShareUri(uri) as Record<string, unknown> | null
    expect(back).not.toBeNull()
    for (const k of KEYS) {
      if (orig[k] !== undefined) expect(back![k]).toEqual(orig[k])
    }
    for (const k of ['reality-opts', 'ws-opts', 'grpc-opts']) {
      if (orig[k]) expect(back![k]).toEqual(orig[k])
    }
    if (orig['skip-cert-verify']) expect(back!['skip-cert-verify']).toBe(true)
    expect(back!.name).toBe(orig.name)
  })
})

describe('parseShareUri 拒绝坏输入', () => {
  // 造不出节点时必须返回 null。硬塞一个残缺的进去,得到的是一个永远连不上的节点,
  // 而它会被记成"测过了,不通" —— 那是在污染数据,不是在测试。
  it.each([
    ['空串', ''],
    ['只有空白', '   '],
    ['根本不是链接', '不是链接'],
    ['协议不认识', 'http://a.com'],
    ['vless 没有 uuid', 'vless://@a.com:443'],
    ['没有主机名', 'vless://uuid@:443'],
    ['端口是 0', 'vless://uuid@a.com:0'],
    ['端口越界', 'vless://uuid@a.com:99999'],
    ['reality 缺公钥', 'vless://uuid@a.com:443?security=reality'],
    ['trojan 没有密码', 'trojan://@a.com:443'],
    ['anytls 没有密码', 'anytls://@a.com:443'],
    ['vmess 不是 base64', 'vmess://????'],
    ['vmess 缺 add', `vmess://${btoa('{"add":"","id":"x"}')}`],
    ['ss 解不开', 'ss://bm90YmFzZTY0'],
  ])('%s', (_label, uri) => {
    expect(parseShareUri(uri)).toBeNull()
  })
})

describe('测试用的节点名', () => {
  it('checkName / hashOfCheckName 往返', () => {
    const h = 'abcdef0123456789'.repeat(4)
    expect(hashOfCheckName(checkName(h))).toBe(h.slice(0, 12))
  })

  it('认不出的名字返回 null —— 用户自己的节点不能被当成待测项', () => {
    expect(hashOfCheckName('我自己的节点')).toBeNull()
    expect(hashOfCheckName('chk-XYZ')).toBeNull()
    expect(hashOfCheckName('chk-abc')).toBeNull()
  })
})

describe('b64decode', () => {
  it('缺 padding 也能解', () => {
    expect(b64decode('aGVsbG8')).toBe('hello')
  })

  it('中文和 emoji 不会乱码 —— atob 出来是 Latin-1,得再按 UTF-8 解一次', () => {
    const s = '中文 🇺🇸'
    expect(b64decode(btoa(String.fromCharCode(...new TextEncoder().encode(s))))).toBe(s)
  })

  it('解不开返回空串,不抛', () => {
    expect(b64decode('!!!!')).toBe('')
  })
})

/**
 * 探针配置里的 proxies 片段。
 *
 * 这块最容易在**真实数据**上翻车:免费节点的密码、路径、名字是从公开仓库抓来的,
 * 引号、冒号、井号、反斜杠什么都有。手拼字符串一定会在某条上出事,而出事的表现是
 * **整个探针起不来** —— 报错只会说"内核没起来",看不出是哪一条的问题。
 *
 * 所以这里验的是:片段塞回 `proxies:` 底下之后仍是合法 YAML,而且解析回来跟原对象
 * 一模一样。
 */
const wrap = (frag: string): { proxies: Record<string, unknown>[] } =>
  yaml.load(`mixed-port: 0\nproxies:\n${frag}\nrules:\n  - MATCH,DIRECT\n`) as never

describe('buildProbeYaml', () => {
  it('普通节点原样往返', () => {
    const nodes = [{ name: 'chk-aaa', type: 'ss', server: 'a.com', port: 8388, cipher: 'aes-256-gcm', password: 'pw' }]
    expect(wrap(buildProbeYaml(nodes as never)).proxies).toEqual(nodes)
  })

  it('密码里有引号、冒号、井号、反斜杠', () => {
    const nodes = [{ name: 'chk-bbb', type: 'trojan', server: 'b.com', port: 443, password: `a"b'c:d#e\\f g` }]
    expect(wrap(buildProbeYaml(nodes as never)).proxies).toEqual(nodes)
  })

  it('ws path 里有井号和问号', () => {
    const nodes = [{
      name: 'chk-ccc', type: 'vless', server: 'c.com', port: 443, uuid: 'u',
      network: 'ws', 'ws-opts': { path: '/x?a=1#frag', headers: { Host: 'h.com' } },
    }]
    expect(wrap(buildProbeYaml(nodes as never)).proxies).toEqual(nodes)
  })

  it('看起来像布尔/数字的密码不能被 YAML 降级', () => {
    // 经典坑:password: yes → true,password: 0755 → 八进制数。
    // 降级之后 mihomo 拿到的就不是原来那个密码了,节点必然连不上,
    // 而它会被记成"测过了,不通" —— 数据被污染,还查不出原因。
    const nodes = [
      { name: 'chk-d', type: 'trojan', server: 'd.com', port: 443, password: 'yes' },
      { name: 'chk-e', type: 'trojan', server: 'e.com', port: 443, password: '0755' },
      { name: 'chk-f', type: 'trojan', server: 'f.com', port: 443, password: '1.20' },
    ]
    const got = wrap(buildProbeYaml(nodes as never)).proxies
    expect(got.map((p) => p.password)).toEqual(['yes', '0755', '1.20'])
    for (const p of got) expect(typeof p.password).toBe('string')
  })

  it('几十条一起仍是合法 YAML', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      name: `chk-${String(i).padStart(12, '0')}`, type: 'ss', server: `n${i}.com`,
      port: 1000 + i, cipher: 'aes-256-gcm', password: `p#${i}:'"`,
    }))
    const got = wrap(buildProbeYaml(nodes as never)).proxies
    expect(got).toHaveLength(60)
    expect(got[59]).toEqual(nodes[59])
  })

  it('从真实分享链接一路走到 YAML,嵌套字段不丢', () => {
    const uri =
      'vless://11111111-2222-3333-4444-555555555555@a.example.com:443' +
      '?encryption=none&security=reality&pbk=PBK&sid=ab&sni=www.apple.com' +
      '&type=ws&path=%2Fx%3Fa%3D1&host=cdn.com#%E8%8A%82%E7%82%B9'
    const p = parseShareUri(uri)
    expect(p).not.toBeNull()
    const got = wrap(buildProbeYaml([{ ...p!, name: 'chk-hhh' }])).proxies[0]
    const sub = (k: string) => got[k] as Record<string, unknown>
    expect(sub('reality-opts')['public-key']).toBe('PBK')
    expect(sub('ws-opts')['path']).toBe('/x?a=1')
    expect(sub('ws-opts')['headers']).toEqual({ Host: 'cdn.com' })
  })
})

/**
 * 筛选。这里钉的核心只有一条:**"没测过"和"测过且不通"必须分得开**。
 *
 * 混起来的后果是单向的、而且很难发现:刚抓来一整批新节点还没轮到实测,如果被当成
 * "不通"过滤掉,界面上看到的是一个空列表 —— 用户会以为池子是空的,而不是"还没测"。
 * 反过来如果把"没测过"当成合格放进去,那筛选条件等于没写。
 */
const row = (over: Partial<FreePoolRow> = {}): FreePoolRow => ({
  uriHash: 'a'.repeat(64),
  uri: 'ss://x',
  proto: 'ss',
  name: '节点',
  server: 'a.com',
  port: 443,
  sourceId: 'src1',
  seenCount: 5,
  check: { ...NO_CHECK },
  ...over,
})

const withCheck = (c: Partial<CheckStat>, over: Partial<FreePoolRow> = {}) =>
  row({ ...over, check: { ...NO_CHECK, ...c } })

describe('passesFilter', () => {
  it('什么都不填时全过 —— 包括从没测过的', () => {
    expect(passesFilter(row(), EMPTY_FILTER)).toBe(true)
    expect(passesFilter(withCheck({ checked: 3, ok: 0, lastOk: false }), EMPTY_FILTER)).toBe(true)
  })

  it('不问实测就不管没测过的:只按协议筛时,没测过的照样留着', () => {
    const f = { ...EMPTY_FILTER, proto: 'ss' }
    expect(passesFilter(row(), f)).toBe(true)
    expect(passesFilter(row({ proto: 'vless' }), f)).toBe(false)
  })

  it('一问实测就必须有答案:没测过的过不了任何一条跟实测有关的条件', () => {
    const never = row()
    expect(passesFilter(never, { ...EMPTY_FILTER, minOkRate: 1 })).toBe(false)
    expect(passesFilter(never, { ...EMPTY_FILTER, lastMustOk: true })).toBe(false)
    expect(passesFilter(never, { ...EMPTY_FILTER, maxMedianMs: 5000 })).toBe(false)
    expect(passesFilter(never, { ...EMPTY_FILTER, minChecked: 1 })).toBe(false)
  })

  it('lastOk 是 null(没测过)不能当成 true', () => {
    // 当成 true 的话,"最后一次必须通"这个条件会把整池还没轮到的节点全放进去,
    // 而用户以为自己筛的是"确认还活着的"
    expect(passesFilter(withCheck({ lastOk: null }), { ...EMPTY_FILTER, lastMustOk: true })).toBe(false)
    expect(passesFilter(withCheck({ checked: 1, ok: 1, lastOk: true }), { ...EMPTY_FILTER, lastMustOk: true })).toBe(true)
    expect(passesFilter(withCheck({ checked: 1, ok: 0, lastOk: false }), { ...EMPTY_FILTER, lastMustOk: true })).toBe(false)
  })

  it('通过率按测过的次数算,不按总轮数', () => {
    // 每轮只抽一小批,所以"3 轮里通了 2 轮"说的是"它自己被测的 3 次里通了 2 次"
    const r = withCheck({ checked: 3, ok: 2, lastOk: true })
    expect(okRate(r.check)).toBe(67)
    expect(passesFilter(r, { ...EMPTY_FILTER, minOkRate: 60 })).toBe(true)
    expect(passesFilter(r, { ...EMPTY_FILTER, minOkRate: 70 })).toBe(false)
  })

  it('延迟上限:一次都没通过的(medianMs 为 null)不算达标', () => {
    const dead = withCheck({ checked: 2, ok: 0, lastOk: false, medianMs: null })
    expect(passesFilter(dead, { ...EMPTY_FILTER, maxMedianMs: 800 })).toBe(false)
    const fast = withCheck({ checked: 2, ok: 2, lastOk: true, medianMs: 300 })
    expect(passesFilter(fast, { ...EMPTY_FILTER, maxMedianMs: 800 })).toBe(true)
    expect(passesFilter(fast, { ...EMPTY_FILTER, maxMedianMs: 200 })).toBe(false)
  })

  it('关键词搜名字、服务器和来源', () => {
    const r = row({ name: '香港 01', server: 'hk.example.com', sourceId: 'github-abc' })
    for (const kw of ['香港', 'hk.exa', 'github']) {
      expect(passesFilter(r, { ...EMPTY_FILTER, kw })).toBe(true)
    }
    expect(passesFilter(r, { ...EMPTY_FILTER, kw: '日本' })).toBe(false)
  })

  it('多个条件是"与"的关系', () => {
    const r = withCheck({ checked: 5, ok: 5, lastOk: true, medianMs: 200 }, { proto: 'vless', seenCount: 9 })
    const f = { ...EMPTY_FILTER, proto: 'vless', minChecked: 3, minOkRate: 90, lastMustOk: true, maxMedianMs: 500, minSeen: 5 }
    expect(passesFilter(r, f)).toBe(true)
    expect(passesFilter(r, { ...f, minSeen: 10 })).toBe(false)
  })
})

describe('buildFreeProfile', () => {
  const nodes = [
    { name: '[免费] a', type: 'ss', server: 'a.com', port: 1, cipher: 'aes-256-gcm', password: 'p' },
    { name: '[免费] b', type: 'ss', server: 'b.com', port: 2, cipher: 'aes-256-gcm', password: 'q' },
  ]

  it('是一份自足的配置:节点、两个组、一条规则', () => {
    const c = yaml.load(buildFreeProfile(nodes as never)) as Record<string, never>
    expect(c.proxies).toEqual(nodes)
    expect((c['proxy-groups'] as unknown as { name: string }[]).map((g) => g.name)).toEqual([
      '免费节点',
      '自动选择',
    ])
    expect(c.rules).toEqual(['MATCH,免费节点'])
  })

  it('不写端口 / DNS / tun —— 那些由「设置」注入,写死会跟界面上的选择打架', () => {
    const c = yaml.load(buildFreeProfile(nodes as never)) as Record<string, unknown>
    for (const k of ['mixed-port', 'port', 'socks-port', 'dns', 'tun', 'mode', 'allow-lan']) {
      expect(c[k]).toBeUndefined()
    }
  })

  it('自动选择组里是全部节点,手动组把自动选择排在最前', () => {
    const c = yaml.load(buildFreeProfile(nodes as never)) as {
      'proxy-groups': { name: string; proxies: string[] }[]
    }
    expect(c['proxy-groups'][0].proxies).toEqual(['自动选择', '[免费] a', '[免费] b'])
    expect(c['proxy-groups'][1].proxies).toEqual(['[免费] a', '[免费] b'])
  })
})
