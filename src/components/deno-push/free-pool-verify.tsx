/**
 * free-pool-verify.tsx — Deno Push 页的「免费池实测」一块。
 *
 * 订阅服务那边攒着一个免费节点池(从公开仓库抓来的分享链接)。服务端跑在 Deno Deploy
 * 上,没有代理内核,拨不了号 —— 它只知道"这条链接长什么样",不知道"它现在还能不能
 * 用"。而免费节点最常见的死法是**凭据失效**:服务器还在、端口还开着、TLS 还能握手,
 * 但 uuid 早作废了。只有真的拨一次才知道。这台机器上正好有 mihomo。
 *
 * 点一下"开始实测",这一轮做的事:
 *
 *   拉一批链接 → 解析成 Clash 节点 → **另起一个 mihomo 探针进程** → 逐个测延迟
 *   → 结果传回服务端 → 杀掉探针
 *
 * ## 两件必须说清楚的事
 *
 * **一、不动你正在用的配置。** 探针是独立进程:`mixed-port: 0`(不监听任何代理端口,
 * 不可能跟主内核抢)、规则只有一条 `MATCH,DIRECT`。你的订阅、策略组、正在走的连接
 * 全程没被碰过。测完进程就没了,应用退出时还会再兜底杀一次。
 *
 * **二、测出"通"不等于可以给家人用。** 这一步只回答"这条链接现在还活着吗",答案存回
 * 服务端当作挑选依据。真要用还得走「扫描 → 筛美国 → 推送」那条路,中间有 GeoIP 和
 * 可达性两道关。免费节点是陌生人在跑的,**任何时候都不能直接推给订阅**。
 */

import { PlayArrowRounded, StopRounded } from '@mui/icons-material'
import { Box, Button, Card, CircularProgress, LinearProgress, MenuItem, TextField, Typography } from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'

import type { DenoPushSettings } from '@/services/deno-push'
import {
  DEFAULT_VERIFY,
  fetchRounds,
  type RoundStat,
  runVerifyRound,
  type VerifyReport,
} from '@/services/free-pool'
import { showNotice } from '@/services/notice-service'

/**
 * 一轮测多少条。
 *
 * 上限特意只给到 300:每条最多 `timeout` 毫秒,并发 8 的话 300 条大约三五分钟,
 * 期间这台机器一直在往一堆陌生服务器发包。想测更多就多跑几轮 —— 服务端每轮独立记账,
 * 分几次跟一次测完是一样的。
 */
const LIMITS = [20, 50, 100, 200, 300]
const CONCURRENCY = [4, 8, 16, 24]

/** 这一块的说明文字比较长,提到模块级免得每次渲染重建。 */
const HINT_STYLE = { display: 'block', mt: 1 } as const

const FreePoolVerify = ({ settings }: { settings: DenoPushSettings }) => {
  const [limit, setLimit] = useState(DEFAULT_VERIFY.limit)
  const [concurrency, setConcurrency] = useState(DEFAULT_VERIFY.concurrency)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<VerifyReport | null>(null)
  const [rounds, setRounds] = useState<RoundStat[]>([])

  /** 有个探针在跑、但不是这个界面起的(上一轮跑到一半切走了、或者上次异常退出)。 */
  const [orphan, setOrphan] = useState(false)

  // useCallback 而不是每次渲染新建:它进了下面 useEffect 的依赖数组,
  // 引用一变就等于每渲染一次重拉一次汇总。
  const loadRounds = useCallback(async () => {
    try {
      setRounds(await fetchRounds(settings))
    } catch {
      // 拉不到不弹错:历轮汇总只是参考,没有它这一块照样能用。
      // 真正要紧的错(密钥不对、地址写错)会在点"开始实测"时明明白白报出来。
      setRounds([])
    }
  }, [settings])

  useEffect(() => {
    void loadRounds()
    // 切走再切回来的时候,上一轮可能还在跑。查一下,有就让用户自己决定停不停 ——
    // 直接替他停掉的话,一轮跑了两分钟的结果会在最后一步(回传)前没了。
    invoke<boolean>('probe_running')
      .then(setOrphan)
      .catch(() => setOrphan(false))
  }, [loadRounds])

  const run = async () => {
    if (running) return
    setRunning(true)
    setReport(null)
    setProgress('准备…')
    try {
      const r = await runVerifyRound(settings, { ...DEFAULT_VERIFY, limit, concurrency }, setProgress)
      setReport(r)
      setOrphan(false)
      showNotice.success(`第 ${r.round} 轮:${r.tested} 条里 ${r.ok} 条通`)
      void loadRounds()
    } catch (e) {
      showNotice.error(`实测失败: ${String(e)}`)
    } finally {
      setRunning(false)
      setProgress('')
    }
  }

  const stopOrphan = async () => {
    try {
      await invoke('probe_stop')
      setOrphan(false)
      showNotice.success('探针进程已停掉')
    } catch (e) {
      showNotice.error(`停不掉: ${String(e)}`)
    }
  }

  return (
    <Card sx={{ p: 2, mb: 1.5 }}>
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>免费池实测</Typography>
      <Typography variant="body2" color="text.secondary">
        用本机内核把服务器上攒的免费节点逐个拨一遍,结果存回去当挑选依据。
        <b>另起一个独立进程做,不碰你正在用的配置</b>,也不会占用任何代理端口。
      </Typography>

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mt: 1.5 }}>
        <TextField
          size="small"
          select
          label="这一轮测"
          sx={{ width: 120 }}
          value={limit}
          disabled={running}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {LIMITS.map((n) => (
            <MenuItem key={n} value={n}>
              {n} 条
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          select
          label="并发"
          sx={{ width: 100 }}
          value={concurrency}
          disabled={running}
          onChange={(e) => setConcurrency(Number(e.target.value))}
        >
          {CONCURRENCY.map((n) => (
            <MenuItem key={n} value={n}>
              {n}
            </MenuItem>
          ))}
        </TextField>

        <Button
          variant="contained"
          disabled={running}
          startIcon={running ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRounded />}
          onClick={run}
        >
          {running ? '实测中…' : '开始实测'}
        </Button>

        {orphan && !running && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            startIcon={<StopRounded fontSize="small" />}
            onClick={stopOrphan}
          >
            有个探针还在跑,停掉
          </Button>
        )}
      </Box>

      {running && (
        <Box sx={{ mt: 1.5 }}>
          {/* 进度只有"第几条"这一个维度,而拉池子、起内核这两步没法给百分比,
              所以用不确定进度条 + 一行文字,不假装知道还剩多久。 */}
          <LinearProgress />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {progress}
          </Typography>
        </Box>
      )}

      {report && !running && (
        <Box sx={{ mt: 1.5, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 13 }}>
          第 <b>{report.round}</b> 轮:测了 <b>{report.tested}</b> 条,
          <b>{report.ok}</b> 条通(
          {report.tested ? Math.round((report.ok / report.tested) * 100) : 0}%)。
          {report.unparsable > 0 && (
            <span style={{ opacity: 0.7 }}>
              {' '}
              另有 {report.unparsable} 条链接解析不出来,没测(多半是还不支持的协议)。
            </span>
          )}
          {report.skipped > 0 && (
            <span style={{ opacity: 0.7 }}>
              {' '}
              {report.skipped} 条服务端没收(库里已经没有这个节点了)。
            </span>
          )}
        </Box>
      )}

      {rounds.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            最近几轮(服务端只留最近 7 轮):
          </Typography>
          <Box sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.9 }}>
            {rounds.map((r) => (
              <div key={r.round}>
                {r.ts} · 第 {r.round} 轮 · {r.ok}/{r.total} 通(
                {r.total ? Math.round((r.ok / r.total) * 100) : 0}%)
                {r.medianMs != null && ` · 中位延迟 ${r.medianMs}ms`}
              </div>
            ))}
          </Box>
        </Box>
      )}

      <Typography variant="caption" color="text.secondary" sx={HINT_STYLE}>
        测出「通」<b>不等于能给家人用</b> —— 这一步只回答"这条链接现在还活着吗"。
        免费节点是陌生人在跑的,要用还得走上面的「扫描 → 筛美国 → 推送」,
        中间有 GeoIP 和可达性两道关。
      </Typography>
    </Card>
  )
}

export default FreePoolVerify
