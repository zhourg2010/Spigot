import { describe, expect, it } from 'vitest'

import { toShareUri } from './deno-push'
import { b64decode, checkName, hashOfCheckName, parseShareUri } from './free-pool'

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
