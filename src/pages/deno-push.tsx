/**
 * deno-push.tsx — 「Deno Push」页:把内核里当前这批节点里的美国节点推给自建订阅服务。
 *
 * 原来这个功能是代理页顶部那排按钮里的一个小图标 + 一个弹窗。挪成独立一页之后:
 *   - 设置不用挤在弹窗里,推送报告也能摊开显示,不用点两次才看得到
 *   - "先测延迟再推送"这条前提可以写在页面上,而不是藏在弹窗底部的小字里
 *
 * 逻辑仍然全在 services/deno-push.ts,这里只管界面 —— 那份 service 一行没改。
 *
 * 推送用的是**内核里已有的延迟数据**,自己不重测。所以正常用法是先去代理页点测延迟,
 * 再回来推。延迟数据缺失时 service 会明确说,不会静悄悄推一批 0ms 的上去。
 */

import { CloudUploadRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  Card,
  CircularProgress,
  Divider,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import {
  DEFAULT_SETTINGS,
  type DenoPushSettings,
  loadSettings,
  type PushReport,
  pushToDeno,
  saveSettings,
} from '@/services/deno-push'
import { showNotice } from '@/services/notice-service'

const DenoPushPage = () => {
  const [settings, setSettings] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<PushReport | null>(null)

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s)
      setDraft(s)
      setLoaded(true)
    })
  }, [])

  // 草稿跟已保存的不一样 = 有没保存的改动。用它来提示,免得改了没存就去点推送
  // ——推送用的是 settings 不是 draft,不提示的话会以为新设置生效了。
  const dirty = loaded && JSON.stringify(draft) !== JSON.stringify(settings)
  const configured = !!settings.pushUrl && !!settings.pushKey

  const normalize = (s: DenoPushSettings): DenoPushSettings => ({
    ...s,
    // 数字字段从 TextField 回来可能是空串或 NaN,兜回默认值,避免存进去一个坏配置
    maxNodes: Number(s.maxNodes) || DEFAULT_SETTINGS.maxNodes,
    maxDelay: Number(s.maxDelay) || DEFAULT_SETTINGS.maxDelay,
    minKeep: Number(s.minKeep) || DEFAULT_SETTINGS.minKeep,
    pushUrl: s.pushUrl.trim(),
    pushKey: s.pushKey.trim(),
  })

  const onSave = async () => {
    const next = normalize(draft)
    await saveSettings(next)
    setSettings(next)
    setDraft(next)
    showNotice.success('设置已保存')
  }

  const onPush = async () => {
    if (busy) return
    setBusy(true)
    setProgress('')
    setReport(null)
    try {
      const r = await pushToDeno(settings, setProgress)
      setReport(r)
      if (r.ok) showNotice.success(r.message)
      else showNotice.error(r.message)
    } catch (e) {
      showNotice.error(`推送出错: ${String(e)}`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <BasePage title="Deno Push">
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            size="large"
            disabled={busy || !configured}
            startIcon={
              busy ? <CircularProgress size={18} color="inherit" /> : <CloudUploadRounded />
            }
            onClick={onPush}
          >
            {busy ? '推送中…' : '推送美国节点'}
          </Button>

          <Box sx={{ minWidth: 0 }}>
            {!configured ? (
              <Typography variant="body2" color="text.secondary">
                还没配置 —— 先在下面填好推送地址和密钥并保存。
              </Typography>
            ) : (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ wordBreak: 'break-all' }}
              >
                推送到 {settings.pushUrl}
              </Typography>
            )}
            {busy && progress && (
              <Typography variant="body2" color="text.secondary">
                {progress}
              </Typography>
            )}
            {dirty && !busy && (
              <Typography variant="body2" color="warning.main">
                下面的设置改了还没保存,这次推送用的仍是已保存的那份。
              </Typography>
            )}
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          推送用的是内核里已有的延迟数据,<b>不会自己重测</b>。所以先去「代理」页点测延迟,再回来推。
        </Typography>

        {report && (
          <Box
            sx={{
              mt: 2,
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
      </Card>

      <Card sx={{ p: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
          设置
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 560 }}>
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

          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
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

          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={draft.geoipStrict}
                  onChange={(e) => setDraft({ ...draft, geoipStrict: e.target.checked })}
                />
              }
              label="严格模式:GeoIP 确认是美国才推"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              关掉之后,GeoIP 查不到的节点会退回看节点名判断。机场标错国家时会混进非美国节点。
            </Typography>
          </Box>

          <Divider />

          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
            <Button variant="contained" disabled={!dirty} onClick={onSave}>
              保存设置
            </Button>
            <Button disabled={!dirty} onClick={() => setDraft(settings)}>
              撤销改动
            </Button>
            <Typography variant="caption" color="text.secondary">
              存在应用数据目录的 deno-push/settings.json,密钥不进仓库
            </Typography>
          </Box>
        </Box>
      </Card>
    </BasePage>
  )
}

export default DenoPushPage
