/**
 * setting-deno-push.tsx — 设置页里的「Deno Push」一节。
 *
 * 这些设置本来在 Deno Push 页自己身上。挪过来的理由:它们是**配一次就不动**的东西
 * (地址、密钥、几个阈值),而那一页现在要干的是每天都在干的事 —— 看节点、挑节点、推。
 * 把"配一次"和"天天用"混在一页,天天用的那部分就被挤没了。
 *
 * 存储仍然是自己的 JSON 文件(见 services/deno-push.ts 开头的说明),没有进
 * IVergeConfig —— 那个结构体在 Rust 侧是强类型的,加字段就得改 Rust,还会跟上游冲突。
 *
 * 保存时机:文本框**失焦时**存,开关**立刻**存。不做"边打字边存" ——
 * 密钥打到一半就被存进去,中途去点推送会拿着半截密钥发请求,报一个看不懂的 401。
 */

import { Box, TextField, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

import { Switch } from '@/components/base'
import {
  DEFAULT_SETTINGS,
  type DenoPushSettings,
  loadSettings,
  saveSettings,
  switchUrlOf,
} from '@/services/deno-push'
import { showNotice } from '@/services/notice-service'

import { SettingItem, SettingList } from './mods/setting-comp'

interface Props {
  onError: (err: Error) => void
}

const NUM_FIELDS = [
  { key: 'maxNodes', label: '节点数上限', hint: '推给订阅服务的节点最多几个' },
  { key: 'maxDelay', label: '延迟上限 (ms)', hint: '超过这个延迟的不推' },
  { key: 'minKeep', label: '最少节点数', hint: '凑不够这个数就整轮不推,保住服务器上一批' },
] as const

const SettingDenoPush = ({ onError }: Props) => {
  const [s, setS] = useState<DenoPushSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    loadSettings()
      .then((v) => {
        setS(v)
        setLoaded(true)
      })
      .catch(onError)
  }, [onError])

  /** 存盘。数字字段可能是空串或 NaN,统一兜回默认值,避免把坏配置写进去。 */
  const persist = async (next: DenoPushSettings) => {
    const clean: DenoPushSettings = {
      ...next,
      maxNodes: Number(next.maxNodes) || DEFAULT_SETTINGS.maxNodes,
      maxDelay: Number(next.maxDelay) || DEFAULT_SETTINGS.maxDelay,
      minKeep: Number(next.minKeep) || DEFAULT_SETTINGS.minKeep,
      pushUrl: next.pushUrl.trim(),
      pushKey: next.pushKey.trim(),
    }
    setS(clean)
    try {
      await saveSettings(clean)
    } catch (e) {
      onError(e as Error)
    }
  }

  const switchUrl = switchUrlOf(s.pushUrl)

  return (
    <SettingList title="Deno Push">
      <SettingItem
        label="推送地址"
        secondary={
          s.pushUrl && !switchUrl
            ? '这不是一个合法的网址,服务开关会用不了'
            : '自建订阅服务的 /push 接口'
        }
      >
        <TextField
          size="small"
          autoComplete="off"
          sx={{ width: 220 }}
          placeholder="https://你的域名/push"
          value={s.pushUrl}
          disabled={!loaded}
          onChange={(e) => setS({ ...s, pushUrl: e.target.value })}
          onBlur={() => persist(s)}
        />
      </SettingItem>

      <SettingItem label="推送密钥" secondary="服务端环境变量 PUSH_KEY">
        <TextField
          size="small"
          type="password"
          autoComplete="new-password"
          sx={{ width: 220 }}
          placeholder="PUSH_KEY"
          value={s.pushKey}
          disabled={!loaded}
          onChange={(e) => setS({ ...s, pushKey: e.target.value })}
          onBlur={() => persist(s)}
        />
      </SettingItem>

      {NUM_FIELDS.map((f) => (
        <SettingItem key={f.key} label={f.label} secondary={f.hint}>
          <TextField
            size="small"
            type="number"
            autoComplete="off"
            sx={{ width: 100 }}
            value={s[f.key]}
            disabled={!loaded}
            onChange={(e) => setS({ ...s, [f.key]: Number(e.target.value) })}
            onBlur={() => persist(s)}
          />
        </SettingItem>
      ))}

      <SettingItem
        label="严格模式"
        secondary="GeoIP 确认是美国才推;查不到的也不推"
      >
        <Switch
          checked={s.geoipStrict}
          disabled={!loaded}
          onChange={(_, v) => {
            // 开关是一次点击就完成的操作,没有"打到一半"的问题,所以立刻存
            void persist({ ...s, geoipStrict: v })
            if (!v) {
              showNotice.info('已关闭严格模式:GeoIP 查不到的节点会退回看节点名判断')
            }
          }}
        />
      </SettingItem>

      <Box sx={{ px: 2, pb: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          密钥存在应用数据目录的 <code>spigot/settings.json</code>,不进仓库。
          {switchUrl && <> 服务开关走 <code>{switchUrl}</code>,同一把密钥。</>}
        </Typography>
      </Box>
    </SettingList>
  )
}

export default SettingDenoPush
