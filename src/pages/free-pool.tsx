/**
 * free-pool.tsx — 「免费池」页。
 *
 * 订阅服务那边攒着一个免费节点池(从公开仓库抓来的分享链接,几千条)。这一页做三件事:
 *
 *   1. **实测**   起一个独立的 mihomo 探针把节点逐个拨一遍,结果存回服务端
 *   2. **筛**     按实测战绩、协议、来源、出现次数挑出你要的那批
 *   3. **落地**   把挑出来的做成一份本地 profile,切过去就能用
 *
 * ## 为什么单独一页,不跟 Deno Push 挤在一起
 *
 * Deno Push 那一页的主题是「内核里已经有的节点 → 挑一批推给家人」。免费池是另一件事:
 * 「服务器上攒的陌生链接 → 实测 → 挑出还活着的」。两者只是碰巧都跟同一个订阅服务说话。
 * 混在一页的直接代价是那一页的搜索框每敲一个字符都要把这边整套状态一起重渲。
 *
 * ## 判据不写死
 *
 * 筛选条件全是开关,默认一个都不勾。**不预设"什么算好节点"** —— 免费池的成色随时间
 * 变化很大,源好的时候"测过 3 次全通"能筛出几百条,源烂的时候同样的条件一条都没有,
 * 而用户看到的只是一个空列表,分不清是没节点还是条件太严。让他自己松紧。
 *
 * ## 这一页**不推送**
 *
 * 挑出来的节点不会、也不该从这里直接推给家人的订阅。免费节点是陌生人在跑的,
 * "测通了"只说明这条链接现在还活着,不说明它明天还在、不说明运营它的人不看流量。
 * 要用就走生成本地 profile 那条路(自己用),或者装进内核之后到 Deno Push 页跟自己的
 * 节点一起过 GeoIP 和可达性两道关、手动勾选再推 —— 那条路上的每道关都在,
 * 这里再开一条旁路等于把它们全绕过去。
 */

import {
  CloudDownloadRounded,
  PlaylistAddCheckRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Card,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'

import { BasePage } from '@/components/base'
import FreePoolTable from '@/components/free-pool/table'
import FreePoolVerify from '@/components/free-pool/verify'
import {
  DEFAULT_SETTINGS,
  type DenoPushSettings,
  loadSettings,
} from '@/services/deno-push'
import {
  createFreeProfile,
  EMPTY_FILTER,
  fetchFreePool,
  type FreePoolRow,
  passesFilter,
  type PoolFilter,
} from '@/services/free-pool'
import { showNotice } from '@/services/notice-service'

/** 一次从服务端拉多少条回来看。跟"一轮测多少条"是两件事,这个只是浏览。 */
const PULL_SIZES = [200, 500, 1000, 2000]

/** 通过率的挡位。做成挡位而不是让人填数字:填 73% 和填 70% 没有区别,徒增犹豫。 */
const RATE_STEPS = [0, 50, 60, 80, 100]
const DELAY_STEPS = [0, 300, 500, 800, 1500]
const CHECKED_STEPS = [0, 1, 2, 3, 5]

const SELECT_SX = { width: 116 }

const FreePoolPage = () => {
  const [settings, setSettings] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [configured, setConfigured] = useState(false)

  const [rows, setRows] = useState<FreePoolRow[]>([])
  const [pulled, setPulled] = useState(false)
  const [pullSize, setPullSize] = useState(500)
  const [busy, setBusy] = useState('')

  const [filter, setFilter] = useState<PoolFilter>(EMPTY_FILTER)
  const [chosen, setChosen] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s)
      setConfigured(!!s.pushUrl && !!s.pushKey)
    })
  }, [])

  // 几千条的筛选不该挡住打字。输入框用最新值立刻回显,表格用落后一拍的值在低优先级里
  // 重算 —— 中途再敲一个字符,上一轮直接作废。比 debounce 好在不用猜延迟多少毫秒。
  const deferredKw = useDeferredValue(filter.kw)
  const effective = useMemo(() => ({ ...filter, kw: deferredKw }), [filter, deferredKw])

  const shown = useMemo(() => rows.filter((r) => passesFilter(r, effective)), [rows, effective])

  const protos = useMemo(() => [...new Set(rows.map((r) => r.proto))].sort(), [rows])
  const sources = useMemo(() => [...new Set(rows.map((r) => r.sourceId))].sort(), [rows])

  /** 拉回来的这批里有多少条是还没轮到实测的 —— 这个数字直接决定筛选条件该怎么设。 */
  const untested = useMemo(() => rows.filter((r) => (r.check?.checked ?? 0) === 0).length, [rows])

  const chosenRows = useMemo(() => rows.filter((r) => chosen.has(r.uriHash)), [rows, chosen])

  const set = <K extends keyof PoolFilter>(k: K, v: PoolFilter[K]) =>
    setFilter((prev) => ({ ...prev, [k]: v }))

  const pull = async () => {
    if (busy) return
    setBusy('pull')
    try {
      const list = await fetchFreePool(settings, pullSize)
      setRows(list)
      setPulled(true)
      // 勾选按 uriHash 存,但重新拉一批之后手里那些 hash 可能已经不在池子里了。
      // 不清的话"选中 30 个"里有一半是幽灵,生成 profile 时凭空少一半。
      setChosen(new Set())
    } catch (e) {
      showNotice.error(`拉取失败: ${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  /** 必须是稳定引用 —— 它是每一行的 prop,引用一变 memo 就全失效。 */
  const toggleOne = useCallback((uriHash: string) => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(uriHash)) next.delete(uriHash)
      else next.add(uriHash)
      return next
    })
  }, [])

  const setAll = (on: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev)
      for (const r of shown) {
        if (on) next.add(r.uriHash)
        else next.delete(r.uriHash)
      }
      return next
    })
  }

  const makeProfile = async () => {
    if (busy || chosenRows.length === 0) return
    setBusy('profile')
    try {
      const n = await createFreeProfile(chosenRows)
      showNotice.success(`已生成本地配置,${n} 个节点。去「配置」页切过去用。`)
    } catch (e) {
      showNotice.error(`生成失败: ${String(e)}`)
    } finally {
      setBusy('')
    }
  }

  if (!configured) {
    return (
      <BasePage title="免费池">
        <Card sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 700, mb: 1 }}>还没配置</Typography>
          <Typography variant="body2" color="text.secondary">
            免费池存在订阅服务那边,要先能连上它。去<b>设置</b>页最下面的「Deno Push」一节，
            填好推送地址和密钥，再回来。
          </Typography>
        </Card>
      </BasePage>
    )
  }

  return (
    <BasePage title="免费池">
      <FreePoolVerify settings={settings} />

      <Card sx={{ p: 2, mb: 1.5 }}>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            disabled={!!busy}
            startIcon={busy === 'pull' ? <CircularProgress size={16} /> : <CloudDownloadRounded />}
            onClick={pull}
          >
            {pulled ? '重新拉取' : '拉取池子'}
          </Button>
          <TextField
            size="small"
            select
            label="拉多少"
            sx={SELECT_SX}
            value={pullSize}
            disabled={!!busy}
            onChange={(e) => setPullSize(Number(e.target.value))}
          >
            {PULL_SIZES.map((n) => (
              <MenuItem key={n} value={n}>
                {n} 条
              </MenuItem>
            ))}
          </TextField>

          <Box sx={{ flex: 1 }} />

          <Button size="small" disabled={!shown.length} onClick={() => setAll(true)}>
            全选当前
          </Button>
          <Button size="small" disabled={!chosen.size} onClick={() => setAll(false)}>
            取消当前
          </Button>
          <Button
            variant="contained"
            disabled={!!busy || chosenRows.length === 0}
            startIcon={
              busy === 'profile' ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <PlaylistAddCheckRounded />
              )
            }
            onClick={makeProfile}
          >
            生成本地配置 {chosenRows.length}
          </Button>
        </Box>

        {/* ---- 筛选 ---- */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mt: 1.5 }}>
          <TextField
            size="small"
            placeholder="搜名称 / 服务器 / 来源"
            sx={{ width: 200 }}
            value={filter.kw}
            onChange={(e) => set('kw', e.target.value)}
          />
          <TextField
            size="small"
            select
            label="协议"
            sx={SELECT_SX}
            value={filter.proto}
            onChange={(e) => set('proto', e.target.value)}
          >
            <MenuItem value="">全部</MenuItem>
            {protos.map((p) => (
              <MenuItem key={p} value={p}>
                {p}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="来源"
            sx={{ width: 150 }}
            value={filter.sourceId}
            onChange={(e) => set('sourceId', e.target.value)}
          >
            <MenuItem value="">全部</MenuItem>
            {sources.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="至少测过"
            sx={SELECT_SX}
            value={filter.minChecked}
            onChange={(e) => set('minChecked', Number(e.target.value))}
          >
            {CHECKED_STEPS.map((n) => (
              <MenuItem key={n} value={n}>
                {n === 0 ? '不限' : `${n} 次`}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="通过率"
            sx={SELECT_SX}
            value={filter.minOkRate}
            onChange={(e) => set('minOkRate', Number(e.target.value))}
          >
            {RATE_STEPS.map((n) => (
              <MenuItem key={n} value={n}>
                {n === 0 ? '不限' : `≥ ${n}%`}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="中位延迟"
            sx={SELECT_SX}
            value={filter.maxMedianMs}
            onChange={(e) => set('maxMedianMs', Number(e.target.value))}
          >
            {DELAY_STEPS.map((n) => (
              <MenuItem key={n} value={n}>
                {n === 0 ? '不限' : `< ${n}ms`}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="出现次数"
            sx={SELECT_SX}
            value={filter.minSeen}
            onChange={(e) => set('minSeen', Number(e.target.value))}
          >
            {[0, 3, 5, 10, 20].map((n) => (
              <MenuItem key={n} value={n}>
                {n === 0 ? '不限' : `≥ ${n}`}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={filter.lastMustOk}
                onChange={(e) => set('lastMustOk', e.target.checked)}
              />
            }
            label={<Typography variant="body2">最后一次必须通</Typography>}
          />
          <Button size="small" onClick={() => setFilter(EMPTY_FILTER)}>
            清空条件
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          拉回 {rows.length} 条，当前筛出 {shown.length} 条，选中 {chosenRows.length} 条。
          {untested > 0 && (
            <>
              {' '}其中 <b>{untested}</b> 条还没轮到实测 ——
              它们不是不通，是还没测。一旦你用了任何一条跟实测有关的条件
              （通过率 / 最后一次 / 中位延迟 / 至少测过几次），这些就会被筛掉。
            </>
          )}
          <br />
          「生成本地配置」做的是一份<b>独立的</b>配置，不会动你现有的任何一份；
          去「配置」页手动切过去才生效，切回来什么都没变。
          <b>这一页不会把节点推给家人的订阅</b> —— 那条路在 Deno Push 页，中间有 GeoIP
          和可达性两道关。
        </Typography>
      </Card>

      <Card sx={{ overflow: 'hidden' }}>
        {!pulled ? (
          <Typography sx={{ p: 4, textAlign: 'center' }} color="text.secondary">
            点「拉取池子」把服务器上攒的免费节点列出来。
          </Typography>
        ) : shown.length === 0 ? (
          <Typography sx={{ p: 4, textAlign: 'center' }} color="text.secondary">
            {rows.length === 0
              ? '池子是空的 —— 先去订阅服务的后台跑一轮抓取。'
              : `拉回了 ${rows.length} 条，但没有一条符合当前条件。${
                  untested === rows.length
                    ? '这批全都还没测过，跟实测有关的条件先放开。'
                    : '放宽一下试试。'
                }`}
          </Typography>
        ) : (
          <FreePoolTable rows={shown} chosen={chosen} onToggle={toggleOne} />
        )}
      </Card>
    </BasePage>
  )
}

export default FreePoolPage
