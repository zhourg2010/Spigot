import { describe, expect, it } from 'vitest'

import {
  type ClashProxy,
  carryOverReach,
  countryOfIp,
  DEFAULT_SETTINGS,
  geoCodeAt,
  ipToInt,
  isIpv4,
  mapPool,
  looksUs,
  nameOfUri,
  type NodeRow,
  parseGeoDb,
  pickForPush,
  roundRobin,
  STORAGE_FILES,
  switchUrlOf,
  toShareUri,
  utf8ToBase64,
} from './deno-push'

describe('ipToInt / isIpv4', () => {
  it('按大端把点分十进制转成整数', () => {
    expect(ipToInt('0.0.0.0')).toBe(0)
    expect(ipToInt('1.2.3.4')).toBe(16909060)
    // 高位地址不能因为 32 位左移溢出成负数
    expect(ipToInt('255.255.255.255')).toBe(4294967295)
    expect(ipToInt('223.5.5.5')).toBeGreaterThan(0)
  })

  it('拒绝非法地址', () => {
    expect(isIpv4('256.1.1.1')).toBe(false)
    expect(isIpv4('1.2.3')).toBe(false)
    expect(isIpv4('example.com')).toBe(false)
    expect(ipToInt('nope')).toBe(-1)
  })
})

describe('looksUs', () => {
  it('认得各种机场命名风格', () => {
    // 这几种是真实机场最常见的写法,Python 版曾经因为只认国家码前缀而把它们全误杀
    expect(looksUs('🇺🇸 美国 洛杉矶 01')).toBe(true)
    expect(looksUs('美国-洛杉矶-BGP')).toBe(true)
    expect(looksUs('United States 03')).toBe(true)
    expect(looksUs('US-Dallas-04')).toBe(true)
    expect(looksUs('USA | Dallas | 04')).toBe(true)
    expect(looksUs('US_24')).toBe(true)
  })

  it('不把别的地区误判成美国', () => {
    expect(looksUs('🇯🇵 日本 东京 01')).toBe(false)
    expect(looksUs('🇭🇰 香港 01')).toBe(false)
    expect(looksUs('Singapore 02')).toBe(false)
  })
})

describe('parseGeoDb / countryOfIp', () => {
  it('二分查到区间,查不到返回 null 而不是瞎猜', () => {
    // 造一个小库:必须按起始 IP 升序,跟 sapics 的发布格式一致
    const db = [
      `${ipToInt('1.2.3.0')},${ipToInt('1.2.3.255')},US`,
      `${ipToInt('5.6.7.0')},${ipToInt('5.6.7.255')},CA`,
      `${ipToInt('9.9.9.0')},${ipToInt('9.9.9.255')},JP`,
    ].join('\n')

    const parsed = parseGeoDb(db)
    expect(parsed.len).toBe(3)
    // codes 是打包过的 Uint16Array,不能直接跟字符串比 —— 走 geoCodeAt 解出来
    expect([0, 1, 2].map((i) => geoCodeAt(parsed, i))).toEqual(['US', 'CA', 'JP'])

    // countryOfIp 用的是模块级的 geoDb,这里直接验解析结果 + 二分的边界语义
    const find = (ip: string): string | null => {
      const n = ipToInt(ip)
      let lo = 0
      let hi = parsed.len - 1
      let hit = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (parsed.starts[mid] <= n) {
          hit = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      if (hit < 0) return null
      return n <= parsed.ends[hit] ? geoCodeAt(parsed, hit) : null
    }

    expect(find('1.2.3.4')).toBe('US')
    expect(find('5.6.7.8')).toBe('CA')
    expect(find('9.9.9.9')).toBe('JP')
    // 落在两个区间之间的空隙 → 查不到,必须是 null(不能返回上一个区间的国家)
    expect(find('3.3.3.3')).toBeNull()
    // 比最小区间还小 → null
    expect(find('0.0.0.1')).toBeNull()
  })

  it('没加载库时返回 null', () => {
    expect(countryOfIp('1.2.3.4')).toBeNull()
  })

  it('忽略格式坏掉的行,不整体崩', () => {
    const parsed = parseGeoDb('这不是一行合法数据\n\n123,456,US\nabc,def,XX\n')
    expect(parsed.len).toBe(1)
    expect(geoCodeAt(parsed, 0)).toBe('US')
  })
})

describe('utf8ToBase64', () => {
  it('中文和 emoji 不能抛异常(btoa 只吃 Latin-1)', () => {
    expect(utf8ToBase64('abc')).toBe('YWJj')
    expect(() => utf8ToBase64('🇺🇸 美国 洛杉矶 01')).not.toThrow()
    // 转回去要一致
    const s = '🇺🇸 美国 洛杉矶 01'
    const back = new TextDecoder().decode(
      Uint8Array.from(atob(utf8ToBase64(s)), (c) => c.charCodeAt(0)),
    )
    expect(back).toBe(s)
  })
})

describe('toShareUri', () => {
  it('vless + reality', () => {
    const p: ClashProxy = {
      name: '🇺🇸 美国 洛杉矶 01',
      type: 'vless',
      server: '1.2.3.4',
      port: 443,
      uuid: 'uuid-1',
      tls: true,
      servername: 'www.microsoft.com',
      'client-fingerprint': 'chrome',
      flow: 'xtls-rprx-vision',
      'reality-opts': { 'public-key': 'PBK', 'short-id': 'ab' },
    }
    const uri = toShareUri(p)
    expect(uri.startsWith('vless://uuid-1@1.2.3.4:443?')).toBe(true)
    expect(uri).toContain('security=reality')
    expect(uri).toContain('pbk=PBK')
    expect(uri).toContain('sid=ab')
    expect(uri).toContain('flow=xtls-rprx-vision')
    // 节点名要 URL 编码,不能原样带中文/emoji 进 fragment
    expect(uri).toContain(`#${encodeURIComponent(p.name)}`)
  })

  it('vless + ws', () => {
    const uri = toShareUri({
      name: 'ws节点',
      type: 'vless',
      server: 'a.com',
      port: 8443,
      uuid: 'u2',
      tls: true,
      network: 'ws',
      'ws-opts': { path: '/w', headers: { Host: 'cdn.a.com' } },
    })
    expect(uri).toContain('type=ws')
    expect(uri).toContain('security=tls')
    expect(uri).toContain(`path=${encodeURIComponent('/w')}`)
    expect(uri).toContain('host=cdn.a.com')
  })

  it('anytls 的密码要转义', () => {
    const uri = toShareUri({
      name: 'a',
      type: 'anytls',
      server: 'b.com',
      port: 443,
      password: 'p@ss:w/rd',
      sni: 'b.com',
    })
    // @ 和 / 不转义的话会把 userinfo 和 host 的边界搞乱
    expect(uri.startsWith('anytls://p%40ss%3Aw%2Frd@b.com:443/?')).toBe(true)
    expect(uri).toContain('insecure=0')
  })

  it('trojan + skip-cert-verify', () => {
    const uri = toShareUri({
      name: 't',
      type: 'trojan',
      server: 'c.com',
      port: 443,
      password: 'tj',
      sni: 'c.com',
      'skip-cert-verify': true,
    })
    expect(uri.startsWith('trojan://tj@c.com:443?')).toBe(true)
    expect(uri).toContain('allowInsecure=1')
  })

  it('vmess 是 base64 过的 JSON', () => {
    const uri = toShareUri({
      name: 'vm',
      type: 'vmess',
      server: 'd.com',
      port: 443,
      uuid: 'u3',
      tls: true,
      network: 'ws',
      'ws-opts': { path: '/vm', headers: { Host: 'd.com' } },
    })
    expect(uri.startsWith('vmess://')).toBe(true)
    const conf = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(uri.slice('vmess://'.length)), (c) => c.charCodeAt(0)),
      ),
    )
    expect(conf.add).toBe('d.com')
    expect(conf.id).toBe('u3')
    expect(conf.net).toBe('ws')
    expect(conf.tls).toBe('tls')
  })

  it('缺关键字段的节点转不出来,返回空串而不是半吊子链接', () => {
    expect(toShareUri({ name: 'x', type: 'vless', server: 'a.com', port: 443 })).toBe('')
    expect(toShareUri({ name: 'x', type: 'trojan', server: 'a.com', port: 443 })).toBe('')
    expect(toShareUri({ name: 'x', type: 'vless', uuid: 'u', port: 443 })).toBe('')
    expect(toShareUri({ name: 'x', type: 'hysteria2', server: 'a.com', port: 443 })).toBe('')
  })
})

describe('roundRobin', () => {
  const mk = (type: string, n: number): ClashProxy[] =>
    Array.from({ length: n }, (_, i) => ({ name: `${type}-${i}`, type }))

  it('各协议交替取,保证都有代表', () => {
    const got = roundRobin(
      new Map([
        ['vless', mk('vless', 3)],
        ['trojan', mk('trojan', 3)],
        ['anytls', mk('anytls', 3)],
      ]),
      6,
    )
    expect(got.map((p) => p.type)).toEqual([
      'vless',
      'trojan',
      'anytls',
      'vless',
      'trojan',
      'anytls',
    ])
  })

  it('某协议先取完,名额让给还有货的(不像固定配额那样浪费)', () => {
    const got = roundRobin(
      new Map([
        ['vless', mk('vless', 5)],
        ['anytls', mk('anytls', 1)],
      ]),
      5,
    )
    expect(got).toHaveLength(5)
    expect(got.filter((p) => p.type === 'anytls')).toHaveLength(1)
    expect(got.filter((p) => p.type === 'vless')).toHaveLength(4)
  })

  it('节点不够就有多少给多少,不会死循环', () => {
    const got = roundRobin(new Map([['vless', mk('vless', 2)]]), 100)
    expect(got).toHaveLength(2)
  })

  it('空输入返回空,不死循环', () => {
    expect(roundRobin(new Map(), 10)).toEqual([])
    expect(roundRobin(new Map([['vless', []]]), 10)).toEqual([])
  })

  it('严格遵守上限', () => {
    const got = roundRobin(
      new Map([
        ['vless', mk('vless', 100)],
        ['trojan', mk('trojan', 100)],
      ]),
      7,
    )
    expect(got).toHaveLength(7)
  })
})

describe('pickForPush', () => {
  const row = (o: Partial<NodeRow>): NodeRow => ({
    name: 'n', proto: 'vless', server: 's', port: 443,
    ip: '1.2.3.4', cc: 'US', delay: 100, uri: 'vless://x', ...o,
  })

  it('只要 GeoIP 确认的美国节点,别的国家一律不要', () => {
    const got = pickForPush(
      [row({ name: 'a', cc: 'US' }), row({ name: 'b', cc: 'JP' }), row({ name: 'c', cc: 'SG' })],
      DEFAULT_SETTINGS,
    )
    expect(got.picked.map((r) => r.name)).toEqual(['a'])
    expect(got.us).toBe(1)
  })

  it('严格模式下,GeoIP 查不到的不要 —— 哪怕名字写着美国', () => {
    const got = pickForPush(
      [row({ name: '🇺🇸 洛杉矶 01', cc: null })],
      { ...DEFAULT_SETTINGS, geoipStrict: true },
    )
    expect(got.picked).toHaveLength(0)
    expect(got.unverified).toBe(1)
  })

  it('非严格模式下,查不到才退回看名字', () => {
    const got = pickForPush(
      [row({ name: '🇺🇸 洛杉矶 01', cc: null }), row({ name: '东京 02', cc: null })],
      { ...DEFAULT_SETTINGS, geoipStrict: false },
    )
    expect(got.picked.map((r) => r.name)).toEqual(['🇺🇸 洛杉矶 01'])
  })

  it('名字写着美国但 GeoIP 说不是 —— 计入 mislabeled,不推', () => {
    const got = pickForPush([row({ name: 'US-LA-01', cc: 'HK' })], DEFAULT_SETTINGS)
    expect(got.picked).toHaveLength(0)
    expect(got.mislabeled).toBe(1)
  })

  it('没测过延迟的(delay=0)不算达标 —— 0 不能当成"极快"', () => {
    const got = pickForPush([row({ name: 'a', delay: 0 })], DEFAULT_SETTINGS)
    expect(got.us).toBe(1)      // 是美国节点
    expect(got.alive).toBe(0)   // 但没有延迟数据,不推
  })

  it('超过延迟上限的不要,结果按延迟从快到慢', () => {
    const got = pickForPush(
      [row({ name: 'slow', delay: 900 }), row({ name: 'fast', delay: 80 }), row({ name: 'mid', delay: 300 })],
      { ...DEFAULT_SETTINGS, maxDelay: 800 },
    )
    expect(got.picked.map((r) => r.name)).toEqual(['fast', 'mid'])
  })
})

describe('switchUrlOf', () => {
  it('从 /push 推出同域名的 /switch', () => {
    expect(switchUrlOf('https://sub.example.com/push')).toBe('https://sub.example.com/switch')
  })

  it('push 地址带子路径也照样落到根上的 /switch', () => {
    expect(switchUrlOf('https://x.com/a/b/push')).toBe('https://x.com/switch')
  })

  it('地址没填或不合法时返回 null,而不是拼出个假 URL', () => {
    expect(switchUrlOf('')).toBeNull()
    expect(switchUrlOf('不是网址')).toBeNull()
  })
})

describe('nameOfUri', () => {
  it('抠出 # 后面那段并解码', () => {
    expect(nameOfUri('vless://x@1.2.3.4:443#' + encodeURIComponent('🇺🇸 US_1 | 12 MB/s')))
      .toBe('🇺🇸 US_1 | 12 MB/s')
  })

  it('没有 # 就返回空串,而不是把整条 URI 当名字', () => {
    // vmess 的分享链接就是没有 fragment 的(名字在 base64 里的 ps 字段)
    expect(nameOfUri('vmess://eyJ2IjoiMiJ9')).toBe('')
  })

  it('百分号编码坏掉时返回原文,不抛异常', () => {
    // 单独一个 % 会让 decodeURIComponent 抛 URIError,不能让它把整页搞崩
    expect(nameOfUri('vless://x@1.2.3.4:443#bad%zz')).toBe('bad%zz')
  })
})

describe('mapPool', () => {
  it('结果按输入顺序排列,跟完成顺序无关', async () => {
    // 故意让前面的慢、后面的快:如果实现是按完成顺序 push,这个断言会挂
    const delays = [30, 1, 20, 1, 10]
    const out = await mapPool(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2, 3, 4])
  })

  it('并发数不超过上限,而且每个任务都跑到', async () => {
    let running = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    const out = await mapPool(items, 4, async (i) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 1))
      running--
      return i * 2
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(out).toHaveLength(20)
    expect(out[19]).toBe(38)
  })

  it('慢任务不挡快任务 —— 这正是从"切批次"改成并发池的理由', async () => {
    // 一个 100ms 的慢任务 + 五个 1ms 的快任务,并发 2。
    // 切批次的话(每批 2 个)总耗时 ≈ 100 + 1 + 1 = 102ms 起步;
    // 并发池里慢的那个自己占一个 worker,另一个 worker 把五个快的全跑完。
    const t0 = Date.now()
    await mapPool([100, 1, 1, 1, 1, 1], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
    })
    // 只断言"没有被慢任务串行拖成两倍",不卡死具体毫秒数(CI 机器抖动很大)
    expect(Date.now() - t0).toBeLessThan(180)
  })

  it('空输入不挂起', async () => {
    await expect(mapPool([], 4, async () => 1)).resolves.toEqual([])
  })

  it('进度回调的 done 是递增的,最后一次等于总数', async () => {
    const seen: number[] = []
    await mapPool([1, 1, 1, 1, 1], 2, async () => 0, (done) => seen.push(done))
    expect(seen).toHaveLength(5)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(seen.at(-1)).toBe(5)
  })
})

describe('parseGeoDb 的边界', () => {
  it('最后一行没有换行也要收进去', () => {
    const parsed = parseGeoDb('1,10,US\n11,20,CA')
    expect(parsed.len).toBe(2)
    expect(geoCodeAt(parsed, 1)).toBe('CA')
  })

  it('国家码被行尾截断的行直接丢掉,不拿下一行的字符凑数', () => {
    // 'U' 后面就换行了 —— 老实现会去读 \n 当第二个字符,拼出个鬼东西
    const parsed = parseGeoDb('1,10,U\n11,20,CA\n')
    expect(parsed.len).toBe(1)
    expect(geoCodeAt(parsed, 0)).toBe('CA')
  })

  it('IP 超出 uint32 范围的行丢掉,不让它被静默截断', () => {
    // 4294967296 = 2^32,存进 Uint32Array 会变成 0,区间就彻底错了
    const parsed = parseGeoDb('1,4294967296,US\n5,10,CA\n')
    expect(parsed.len).toBe(1)
    expect(geoCodeAt(parsed, 0)).toBe('CA')
  })

  it('起止颠倒的行丢掉', () => {
    const parsed = parseGeoDb('100,5,US\n5,10,CA\n')
    expect(parsed.len).toBe(1)
    expect(geoCodeAt(parsed, 0)).toBe('CA')
  })
})

describe('carryOverReach', () => {
  const row = (over: Partial<NodeRow> = {}): NodeRow => ({
    name: 'US-01',
    proto: 'vless',
    server: 'a.example.com',
    port: 443,
    ip: '1.2.3.4',
    cc: 'US',
    delay: 100,
    uri: 'vless://x@a.example.com:443',
    ...over,
  })

  it('同一个节点的可达性结果搬过来,省掉一分多钟的重测', () => {
    const prev = [row({ reach: { claude: 210, gpt: 0 } })]
    const next = [row({ delay: 88 })] // 延迟变了,身份没变
    const out = carryOverReach(prev, next)
    expect(out[0].reach).toEqual({ claude: 210, gpt: 0 })
    expect(out[0].delay).toBe(88) // 新数据不能被旧的盖掉
  })

  it('名字一样但服务器换了 → 不搬,标回没测过', () => {
    // 机场沿用节点名换后端是常事,搬过来等于拿旧服务器的结果骗人
    const prev = [row({ reach: { claude: 210 } })]
    const next = [row({ server: 'b.example.com' })]
    expect(carryOverReach(prev, next)[0].reach).toBeUndefined()
  })

  it('名字和服务器一样但端口换了 → 也不搬', () => {
    const prev = [row({ reach: { claude: 210 } })]
    const next = [row({ port: 8443 })]
    expect(carryOverReach(prev, next)[0].reach).toBeUndefined()
  })

  it('上一轮没测过就原样返回,不做无谓的拷贝', () => {
    const next = [row()]
    expect(carryOverReach([row()], next)).toBe(next)
    expect(carryOverReach([], next)).toBe(next)
  })

  it('新增的节点保持没测过', () => {
    const prev = [row({ reach: { claude: 210 } })]
    const next = [row(), row({ name: 'US-02', server: 'c.example.com' })]
    const out = carryOverReach(prev, next)
    expect(out[0].reach).toEqual({ claude: 210 })
    expect(out[1].reach).toBeUndefined()
  })

  it('名字里带空格也不会跟别的行串上 —— key 用不可见字符拼就是为了这个', () => {
    // 拿 '-' 之类的可见字符拼 key 的话,"a-b" + "c" 会跟 "a" + "b-c" 撞上
    const prev = [row({ name: 'a', server: 'b', port: 1, reach: { claude: 1 } })]
    const next = [row({ name: 'a b', server: '', port: 1 })]
    expect(carryOverReach(prev, next)[0].reach).toBeUndefined()
  })
})

describe('落盘路径', () => {
  it('都在同一个目录下,不往外散', () => {
    // 权限那一侧由 scripts/check-capabilities.mjs 在 CI 里查 —— 那个检查要读
    // src-tauri 下的 JSON,而 tsconfig 的 types 是白名单(不含 @types/node),
    // 在 vitest 里 import node:fs 会让 tsc --noEmit 挂。
    expect(STORAGE_FILES.length).toBeGreaterThan(0)
    for (const f of STORAGE_FILES) {
      expect(f.startsWith('spigot/')).toBe(true)
    }
    expect(new Set(STORAGE_FILES).size).toBe(STORAGE_FILES.length)
  })
})
