import { describe, expect, it } from 'vitest'

import {
  type ClashProxy,
  countryOfIp,
  ipToInt,
  isIpv4,
  looksUs,
  parseGeoDb,
  roundRobin,
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
    expect(parsed.starts).toHaveLength(3)
    expect(parsed.codes).toEqual(['US', 'CA', 'JP'])

    // countryOfIp 用的是模块级的 geoDb,这里直接验解析结果 + 二分的边界语义
    const find = (ip: string): string | null => {
      const n = ipToInt(ip)
      let lo = 0
      let hi = parsed.starts.length - 1
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
      return n <= parsed.ends[hit] ? parsed.codes[hit] : null
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
    expect(parsed.codes).toEqual(['US'])
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
