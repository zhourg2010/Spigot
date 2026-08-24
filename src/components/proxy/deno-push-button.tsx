/**
 * deno-push-button.tsx — 代理页顶部那排按钮里的"推送到 Deno"。
 *
 * 交互:
 *   单击   立刻推送(用已保存的设置)。没配过就直接弹设置。
 *   右键   打开设置(推送地址/密钥/上限/延迟阈值)。
 *
 * 推送用的是**内核里已有的延迟数据**,不会自己重测——所以正常用法是:
 * 先点旁边那个测延迟按钮,再点这个。延迟数据缺失时会明确提示去测。
 *
 * 逻辑全在 services/deno-push.ts 里,这里只管界面。
 */

import { CloudUploadRounded } from '@mui/icons-material'
import {
  Box,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useState } from 'react'

import { BaseDialog } from '@/components/base'
import {
  DEFAULT_SETTINGS,
  type DenoPushSettings,
  loadSettings,
  type PushReport,
  pushToDeno,
  saveSettings,
} from '@/services/deno-push'
import { showNotice } from '@/services/notice-service'

export const DenoPushButton = () => {
  const [settings, setSettings] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<PushReport | null>(null)

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s)
      setDraft(s)
    })
  }, [])

  const openSettings = () => {
    setDraft(settings)
    setReport(null)
    setOpen(true)
  }

  const run = async (s: DenoPushSettings) => {
    if (busy) return
    setBusy(true)
    setProgress('')
    setReport(null)
    try {
      const r = await pushToDeno(s, setProgress)
      setReport(r)
      if (r.ok) {
        showNotice.success(r.message)
      } else {
        // 失败原因通常需要看细节(比如"美国节点里没有延迟达标的"),所以顺带把
        // 设置面板打开,里面会展示这次的统计,不用去翻日志。
        showNotice.error(r.message)
        setOpen(true)
      }
    } catch (e) {
      showNotice.error(`推送出错: ${String(e)}`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const onClick = () => {
    if (!settings.pushUrl || !settings.pushKey) {
      openSettings()
      return
    }
    void run(settings)
  }

  const onSave = async () => {
    const next: DenoPushSettings = {
      ...draft,
      // 数字字段从 TextField 回来可能是空串或 NaN,兜回默认值,避免存进去一个坏配置
      maxNodes: Number(draft.maxNodes) || DEFAULT_SETTINGS.maxNodes,
      maxDelay: Number(draft.maxDelay) || DEFAULT_SETTINGS.maxDelay,
      minKeep: Number(draft.minKeep) || DEFAULT_SETTINGS.minKeep,
      pushUrl: draft.pushUrl.trim(),
      pushKey: draft.pushKey.trim(),
    }
    await saveSettings(next)
    setSettings(next)
    setOpen(false)
    showNotice.success('已保存')
  }

  return (
    <>
      <IconButton
        size="small"
        color="inherit"
        disabled={busy}
        title={
          settings.pushUrl
            ? `推送美国节点到 Deno(右键改设置)\n${settings.pushUrl}`
            : '推送到 Deno — 还没配置,点一下去设置'
        }
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          openSettings()
        }}
      >
        {busy ? <CircularProgress size={18} color="inherit" /> : <CloudUploadRounded />}
      </IconButton>

      <BaseDialog
        open={open}
        title="推送到 Deno"
        okBtn="保存"
        cancelBtn="取消"
        onOk={onSave}
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        contentSx={{ width: 460 }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField
            label="推送地址"
            placeholder="https://你的域名/push"
            size="small"
            fullWidth
            value={draft.pushUrl}
            onChange={(e) => setDraft({ ...draft, pushUrl: e.target.value })}
          />
          <TextField
            label="推送密钥"
            placeholder="Deno Deploy 环境变量 PUSH_KEY"
            size="small"
            fullWidth
            type="password"
            value={draft.pushKey}
            onChange={(e) => setDraft({ ...draft, pushKey: e.target.value })}
          />

          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField
              label="节点数上限"
              size="small"
              type="number"
              value={draft.maxNodes}
              onChange={(e) => setDraft({ ...draft, maxNodes: Number(e.target.value) })}
            />
            <TextField
              label="延迟上限 (ms)"
              size="small"
              type="number"
              value={draft.maxDelay}
              onChange={(e) => setDraft({ ...draft, maxDelay: Number(e.target.value) })}
            />
            <TextField
              label="最少节点数"
              size="small"
              type="number"
              helperText="低于此数不推"
              value={draft.minKeep}
              onChange={(e) => setDraft({ ...draft, minKeep: Number(e.target.value) })}
            />
          </Box>

          <FormControlLabel
            control={
              <Switch
                checked={draft.geoipStrict}
                onChange={(e) => setDraft({ ...draft, geoipStrict: e.target.checked })}
              />
            }
            label="严格模式:GeoIP 确认是美国才推"
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
            关掉之后,GeoIP 查不到的节点会退回看节点名判断。机场标错国家时会混进非美国节点。
          </Typography>

          {busy && progress && (
            <Typography variant="body2" color="text.secondary">
              {progress}
            </Typography>
          )}

          {report && (
            <Box
              sx={{
                p: 1.5,
                bgcolor: 'action.hover',
                fontSize: 13,
                lineHeight: 1.9,
                borderRadius: 1,
              }}
            >
              <div>可转换的节点:{report.total}</div>
              <div>
                GeoIP 确认美国:{report.us}
                {report.mislabeled > 0 && (
                  <span style={{ opacity: 0.7 }}>
                    （另有 {report.mislabeled} 个名字写着美国但 GeoIP 查出来不是）
                  </span>
                )}
              </div>
              <div>延迟达标:{report.alive}</div>
              <div>
                已推送:<b>{report.pushed}</b>
                {Object.keys(report.byProto).length > 0 && (
                  <span style={{ opacity: 0.7 }}>
                    {' '}
                    (
                    {Object.entries(report.byProto)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ')}
                    )
                  </span>
                )}
              </div>
              {report.unverified > 0 && (
                <div style={{ opacity: 0.7 }}>
                  无法核实(域名解析不了或 GeoIP 库里没有):{report.unverified}
                </div>
              )}
              {!report.ok && <div style={{ marginTop: 6 }}>{report.message}</div>}
            </Box>
          )}

          <Typography variant="caption" color="text.secondary">
            推送用的是内核里已有的延迟数据,不会自己重测。先点旁边的测延迟按钮,再来推送。
          </Typography>
        </Box>
      </BaseDialog>
    </>
  )
}
