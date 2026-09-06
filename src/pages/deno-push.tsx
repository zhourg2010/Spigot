/**
 * deno-push.tsx — 「Deno Push」页:看当前内核里都有哪些节点,挑一批推给自建订阅服务,
 * 以及一个让订阅服务立刻装死的总开关。
 *
 * 页面分三块:
 *   1. 服务开关   订阅服务现在开着还是关着,一键切
 *   2. 工具条     扫描 / 过滤 / 选中多少 / 推送
 *   3. 节点表     内核当前加载的全部节点,连推不了的也列出来
 *
 * **推不了的节点也显示**,只是行是灰的、勾选框禁用。看得见"这个节点为什么没被推"
 * (延迟没测、GeoIP 不是美国、缺字段转不出链接)比它默默消失有用得多 ——
 * 以前那版就是默默消失,结果"为什么只推了 12 个"这种问题只能靠猜。
 *
 * 设置(地址、密钥、几个阈值)不在这一页,在**设置页**的「Deno Push」一节。
 * 那些是配一次就不动的东西,跟这一页天天要干的事不是一回事。
 *
 * 逻辑全在 services/deno-push.ts:scanNodes 摊表、pickForPush 自动筛、pushRows 推。
 * 这里只管界面和"用户挑了哪些"。
 */

import {
  CloudDownloadRounded,
  CloudUploadRounded,
  NetworkCheckRounded,
  PowerSettingsNewRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import { BasePage } from '@/components/base'
import {
  DEFAULT_SETTINGS,
  type DenoPushSettings,
  getServiceState,
  loadSettings,
  type NodeRow,
  pickForPush,
  fetchRemotePool,
  nameOfUri,
  type PushReport,
  pushRows,
  REACH_TARGETS,
  type ReachKey,
  type RemotePool,
  scanNodes,
  type ServiceState,
  setServiceState,
  testReach,
} from '@/services/deno-push'
import { showNotice } from '@/services/notice-service'

/** 节点能不能推。转不出分享链接的,推上去也是坏行。 */
const pushable = (r: NodeRow) => !!r.uri

const DenoPushPage = () => {
  const [settings, setSettings] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [configured, setConfigured] = useState(false)

  const [rows, setRows] = useState<NodeRow[]>([])
  const [geoReady, setGeoReady] = useState(true)
  const [scanned, setScanned] = useState(false)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<PushReport | null>(null)

  // 勾选状态按**节点名**存,不是按下标 —— 重新扫描之后顺序会变,存下标等于选错节点。
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const [kw, setKw] = useState('')
  const [cc, setCc] = useState('ALL')
  const [proto, setProto] = useState('ALL')
  const [onlyAlive, setOnlyAlive] = useState(true)

  const [svc, setSvc] = useState<ServiceState | null>(null)

  /** 可达性过滤:选了哪个目标就只留对它通的。'' = 不按可达性过滤 */
  const [reachFilter, setReachFilter] = useState<ReachKey | ''>('')
  /** 服务器上现在那批。null = 还没拉过 */
  const [remote, setRemote] = useState<RemotePool | null>(null)

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s)
      setConfigured(!!s.pushUrl && !!s.pushKey)
      if (s.pushUrl && s.pushKey) {
        getServiceState(s)
          .then(setSvc)
          // 读不到不弹错:可能只是没联网或者还没部署。界面上显示"未知"就够了。
          .catch(() => setSvc(null))
      }
    })
  }, [])

  // ---------------- 过滤 ----------------

  const countries = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) set.add(r.cc ?? '未知')
    return [...set].sort()
  }, [rows])

  const protos = useMemo(() => [...new Set(rows.map((r) => r.proto))].sort(), [rows])

  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return rows.filter((r) => {
      if (cc !== 'ALL' && (r.cc ?? '未知') !== cc) return false
      if (proto !== 'ALL' && r.proto !== proto) return false
      if (onlyAlive && r.delay <= 0) return false
      // 可达性:只留测过**并且通**的。没测过(undefined)也排除 ——
      // 把"没测过"当成通过,等于这个过滤器什么也没干,还给人一种筛过了的错觉。
      if (reachFilter && !(r.reach?.[reachFilter] ?? 0)) return false
      if (!k) return true
      // 名字、服务器域名、IP 一起搜 —— 想按 IP 段挑的时候直接敲 "104." 就行
      return (
        r.name.toLowerCase().includes(k) ||
        r.server.toLowerCase().includes(k) ||
        (r.ip ?? '').includes(k)
      )
    })
  }, [rows, kw, cc, proto, onlyAlive, reachFilter])

  const shownPushable = useMemo(() => shown.filter(pushable), [shown])
  const chosenRows = useMemo(() => rows.filter((r) => chosen.has(r.name) && pushable(r)), [rows, chosen])

  // ---------------- 动作 ----------------

  const scan = async () => {
    if (busy) return
    setBusy('scan')
    setProgress('')
    setReport(null)
    try {
      const res = await scanNodes(setProgress)
      setRows(res.rows)
      setGeoReady(res.geoReady)
      setScanned(true)
      // 扫完默认按老的那套判据勾上(美国 + 延迟达标)—— 大多数时候这就是你要推的,
      // 想改再手动动。默认全不选的话每次都要先点一遍全选,毫无意义。
      const auto = pickForPush(res.rows, settings)
      setChosen(new Set(auto.picked.map((r) => r.name)))
      if (res.withDelay === 0) {
        showNotice.info('所有节点都没有延迟数据 —— 先去「代理」页点一下测延迟')
      }
    } catch (e) {
      showNotice.error(`扫描失败: ${String(e)}`)
    } finally {
      setBusy('')
      setProgress('')
    }
  }

  const push = async () => {
    if (busy || chosenRows.length === 0) return
    setBusy('push')
    setProgress('')
    setReport(null)
    try {
      const r = await pushRows(settings, chosenRows, setProgress)
      setReport(r)
      if (r.ok) showNotice.success(r.message)
      else showNotice.error(r.message)
    } catch (e) {
      showNotice.error(`推送出错: ${String(e)}`)
    } finally {
      setBusy('')
      setProgress('')
    }
  }

  const runReach = async (key: ReachKey) => {
    if (busy) return
    // 只测当前筛出来的。全测的话几百个节点 × 5 秒超时,等到天黑。
    const targets = shown
    if (targets.length === 0) return
    setBusy('reach')
    try {
      const label = REACH_TARGETS.find((t) => t.key === key)!.label
      const updated = await testReach(targets, key, 5000, (done, total) =>
        setProgress(`测 ${label} 可达性 ${done}/${total}…`),
      )
      // 只把测过的那些合并回总表,没测的行保持原样
      const byName = new Map(updated.map((r) => [r.name, r]))
      setRows(rows.map((r) => byName.get(r.name) ?? r))
      const ok = updated.filter((r) => r.reach?.[key]).length
      showNotice.success(`${label}:${targets.length} 个里 ${ok} 个连得上`)
    } catch (e) {
      showNotice.error(`测试失败: ${String(e)}`)
    } finally {
      setBusy('')
      setProgress('')
    }
  }

  const pullRemote = async () => {
    if (busy) return
    setBusy('pull')
    try {
      const pool = await fetchRemotePool(settings)
      setRemote(pool)
    } catch (e) {
      showNotice.error(`拉取失败: ${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const toggleService = async () => {
    if (busy || !svc) return
    const next = !svc.up
    if (next === false && !confirm('关闭之后所有订阅链接立刻返回 404,家人拉不到订阅。确定?')) {
      return
    }
    setBusy('svc')
    try {
      setSvc(await setServiceState(settings, next))
      showNotice.success(next ? '服务已开启' : '服务已关闭,订阅链接现在一律 404')
    } catch (e) {
      showNotice.error(`切换失败: ${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const setAll = (on: boolean) => {
    const next = new Set(chosen)
    for (const r of shownPushable) {
      if (on) next.add(r.name)
      else next.delete(r.name)
    }
    setChosen(next)
  }

  // ---------------- 渲染 ----------------

  if (!configured) {
    return (
      <BasePage title="Deno Push">
        <Card sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 700, mb: 1 }}>还没配置</Typography>
          <Typography variant="body2" color="text.secondary">
            去<b>设置</b>页最下面的「Deno Push」一节,填好推送地址和密钥,再回来。
          </Typography>
        </Card>
      </BasePage>
    )
  }

  return (
    <BasePage title="Deno Push">
      {/* ---- 服务开关 ---- */}
      <Card
        sx={{
          p: 2,
          mb: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexWrap: 'wrap',
          // 关掉是需要一眼看见的状态,给整块底色而不是一个小徽章
          bgcolor: svc === null ? undefined : svc.up ? 'success.light' : 'error.light',
          opacity: svc === null ? 1 : 0.96,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 240 }}>
          <Typography sx={{ fontWeight: 700 }}>
            {svc === null ? '服务状态未知' : svc.up ? '订阅服务开启中' : '订阅服务已关闭'}
          </Typography>
          <Typography variant="body2">
            {svc === null
              ? '连不上服务器,或者服务端还没部署这个开关。'
              : svc.up
                ? '订阅链接正常工作。'
                : '所有订阅链接返回 404,跟"链接写错了"完全一样。家人拉不到订阅(客户端会保留上一次的配置)。'}
          </Typography>
        </Box>
        <Button
          variant="contained"
          color={svc?.up ? 'error' : 'success'}
          disabled={!!busy || svc === null}
          startIcon={
            busy === 'svc' ? <CircularProgress size={16} color="inherit" /> : <PowerSettingsNewRounded />
          }
          onClick={toggleService}
        >
          {svc?.up ? '关闭服务' : '开启服务'}
        </Button>
      </Card>

      {/* ---- 工具条 ---- */}
      <Card sx={{ p: 2, mb: 1.5 }}>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            disabled={!!busy}
            startIcon={busy === 'scan' ? <CircularProgress size={16} /> : <RefreshRounded />}
            onClick={scan}
          >
            {scanned ? '重新扫描' : '扫描节点'}
          </Button>

          <TextField
            size="small"
            placeholder="搜名称 / 域名 / IP"
            sx={{ width: 200 }}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
          />
          <TextField
            size="small"
            select
            label="国家"
            sx={{ width: 110 }}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          >
            <MenuItem value="ALL">全部</MenuItem>
            {countries.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="协议"
            sx={{ width: 110 }}
            value={proto}
            onChange={(e) => setProto(e.target.value)}
          >
            <MenuItem value="ALL">全部</MenuItem>
            {protos.map((p) => (
              <MenuItem key={p} value={p}>
                {p}
              </MenuItem>
            ))}
          </TextField>
          <Button size="small" onClick={() => setOnlyAlive(!onlyAlive)}>
            {onlyAlive ? '只看测过延迟的 ✓' : '只看测过延迟的'}
          </Button>
          <TextField
            size="small"
            select
            label="可达"
            sx={{ width: 120 }}
            value={reachFilter}
            onChange={(e) => setReachFilter(e.target.value as ReachKey | '')}
          >
            <MenuItem value="">不限</MenuItem>
            {REACH_TARGETS.map((t) => (
              <MenuItem key={t.key} value={t.key}>
                {t.label} 通
              </MenuItem>
            ))}
          </TextField>

          <Box sx={{ flex: 1 }} />

          <Button size="small" disabled={!shownPushable.length} onClick={() => setAll(true)}>
            全选当前
          </Button>
          <Button size="small" disabled={!chosen.size} onClick={() => setAll(false)}>
            取消当前
          </Button>
          <Button
            variant="contained"
            disabled={!!busy || chosenRows.length === 0}
            startIcon={
              busy === 'push' ? <CircularProgress size={16} color="inherit" /> : <CloudUploadRounded />
            }
            onClick={push}
          >
            推送选中 {chosenRows.length}
          </Button>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            测可达性(只测当前筛出的 {shown.length} 个):
          </Typography>
          {REACH_TARGETS.map((t) => (
            <Button
              key={t.key}
              size="small"
              variant="outlined"
              disabled={!!busy || shown.length === 0}
              startIcon={
                busy === 'reach' ? <CircularProgress size={14} /> : <NetworkCheckRounded fontSize="small" />
              }
              onClick={() => runReach(t.key)}
            >
              {t.label}
            </Button>
          ))}
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="outlined"
            disabled={!!busy}
            startIcon={
              busy === 'pull' ? <CircularProgress size={14} /> : <CloudDownloadRounded fontSize="small" />
            }
            onClick={pullRemote}
          >
            看服务器上现在有什么
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          共 {rows.length} 个节点,当前筛出 {shown.length} 个,选中 {chosenRows.length} 个。
          延迟来自内核里已有的数据,<b>这一页不会自己重测</b> —— 要新的延迟先去「代理」页点测延迟。
          {!geoReady && scanned && ' ⚠ GeoIP 库不可用,所有节点的国家都显示为未知。'}
          <br />
          可达性测的是<b>网络层连不连得通</b>,不是"有没有被区域封锁" ——
          连得上但对方按 IP 拒绝服务(常见于 Claude / ChatGPT)这里看不出来。它能帮你排除明显不通的,不保证能用。
          {busy && progress ? ` · ${progress}` : ''}
        </Typography>

        {report && (
          <Box sx={{ mt: 1.5, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 13 }}>
            已推送 <b>{report.pushed}</b> 个
            {Object.keys(report.byProto).length > 0 && (
              <span style={{ opacity: 0.7 }}>
                {' ('}
                {Object.entries(report.byProto)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
                {')'}
              </span>
            )}
            {!report.ok && <div style={{ marginTop: 6 }}>{report.message}</div>}
          </Box>
        )}
      </Card>

      {/* ---- 服务器上现在那批 ---- */}
      {remote && (
        <Card sx={{ p: 2, mb: 1.5 }}>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>
            服务器上现在有 {remote.count} 个节点
            {remote.nodes.length > remote.count && (
              <span style={{ opacity: 0.6, fontWeight: 400 }}>
                {' '}(另有 {remote.nodes.length - remote.count} 个在后台被停用了)
              </span>
            )}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            最后一次推送:{remote.updatedAt ? new Date(remote.updatedAt).toLocaleString() : '未知'}
          </Typography>
          <Box
            sx={{
              mt: 1,
              maxHeight: 180,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: 11.5,
              lineHeight: 1.8,
            }}
          >
            {remote.nodes.map((n, i) => (
              <div key={i} style={{ opacity: n.disabled ? 0.45 : 1 }}>
                {n.disabled ? '[停用] ' : ''}
                {nameOfUri(n.uri) || n.uri.slice(0, 60)}
              </div>
            ))}
          </Box>
        </Card>
      )}

      {/* ---- 节点表 ---- */}
      <Card sx={{ overflow: 'auto' }}>
        {!scanned ? (
          <Typography sx={{ p: 4, textAlign: 'center' }} color="text.secondary">
            点「扫描节点」把内核当前加载的节点列出来。
          </Typography>
        ) : shown.length === 0 ? (
          <Typography sx={{ p: 4, textAlign: 'center' }} color="text.secondary">
            没有符合条件的节点。放宽一下过滤条件试试。
          </Typography>
        ) : (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>名称</TableCell>
                <TableCell>协议</TableCell>
                <TableCell>服务器</TableCell>
                <TableCell>IP</TableCell>
                <TableCell>国家</TableCell>
                <TableCell align="right">延迟</TableCell>
                <TableCell align="center">可达</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((r) => {
                const ok = pushable(r)
                return (
                  <TableRow key={r.name} hover sx={{ opacity: ok ? 1 : 0.45 }}>
                    <TableCell padding="checkbox">
                      <Tooltip title={ok ? '' : '这个节点缺关键字段,转不出分享链接,推不了'}>
                        <span>
                          <Checkbox
                            size="small"
                            disabled={!ok}
                            checked={chosen.has(r.name)}
                            onChange={(_, v) => {
                              const next = new Set(chosen)
                              if (v) next.add(r.name)
                              else next.delete(r.name)
                              setChosen(next)
                            }}
                          />
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.name}
                    </TableCell>
                    <TableCell>
                      <Chip label={r.proto} size="small" variant="outlined" />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {r.server}:{r.port}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {r.ip ?? <span style={{ opacity: 0.5 }}>解析不了</span>}
                    </TableCell>
                    <TableCell>
                      {r.cc ?? <span style={{ opacity: 0.5 }}>未知</span>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.delay > 0 ? `${r.delay} ms` : <span style={{ opacity: 0.5 }}>未测</span>}
                    </TableCell>
                    <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                      {REACH_TARGETS.map((t) => {
                        const v = r.reach?.[t.key]
                        // undefined = 没测过,显示灰点;0 = 测了不通;>0 = 通
                        const color = v === undefined ? '#c7c7cc' : v > 0 ? '#34c759' : '#ff3b30'
                        const tip =
                          v === undefined ? `${t.label}:没测过` : v > 0 ? `${t.label}:${v} ms` : `${t.label}:连不上`
                        return (
                          <Tooltip key={t.key} title={tip}>
                            <span
                              style={{
                                display: 'inline-block',
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: color,
                                margin: '0 2px',
                              }}
                            />
                          </Tooltip>
                        )
                      })}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </BasePage>
  )
}

export default DenoPushPage
