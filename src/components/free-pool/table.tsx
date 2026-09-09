/**
 * table.tsx — 免费池的节点表。
 *
 * 跟 deno-push/node-table.tsx 是同一套做法(虚拟化 + 单行零 MUI + CSS 变量配色 + 行 memo),
 * 原因也一样:免费池是**几千条**,比机场那四五百条还多一个数量级,而且上面挂着六七个
 * 筛选条件,随便动一个就要重排整张表。理由写在 deno-push/node-table.tsx 的头注释里,不重复。
 *
 * 这张表跟那张的差别只在列:那边看的是"能不能推给家人"(IP、国家、可达性),
 * 这边看的是"这条链接还活不活"(测过几次、通了几次、最后一次、延迟中位数)。
 *
 * **"没测过"必须一眼跟"测了不通"分开。** 免费池里随时有一大批刚抓来还没轮到实测的
 * 节点,把它们显示成红色等于说它们是坏的 —— 用户会去删本来好好的节点。所以没测过的
 * 一律灰字「未测」,不给任何红色。
 */

import { useTheme } from '@mui/material/styles'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useRef, useMemo } from 'react'

import { type FreePoolRow, NO_CHECK, okRate } from '@/services/free-pool'

const ROW_H = 32

/** 表头和数据行必须用同一个值,否则列会对不齐。 */
const GRID = '36px minmax(160px,1.8fr) 70px minmax(150px,1.5fr) 96px 56px 74px 96px 72px'
const MIN_W = 900

const VIEWPORT_H = 'clamp(240px, calc(100vh - 470px), 900px)'

// —— 样式全部提到模块级,理由同 node-table.tsx

const HEAD_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID,
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  height: 34,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--fp-muted)',
  borderBottom: '1px solid var(--fp-border)',
  background: 'var(--fp-bg)',
}

const ROW_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID,
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  height: ROW_H,
  fontSize: 12.5,
  borderBottom: '1px solid var(--fp-border)',
  boxSizing: 'border-box',
}

const ELLIPSIS: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const MONO: React.CSSProperties = { ...ELLIPSIS, fontFamily: 'monospace', fontSize: 11.5 }
const NUM: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const MUTED: React.CSSProperties = { opacity: 0.5 }
const CHECK: React.CSSProperties = { width: 14, height: 14, margin: 0, cursor: 'pointer' }
const OUTER: React.CSSProperties = { overflowX: 'auto' }
const SCROLLER: React.CSSProperties = {
  height: VIEWPORT_H,
  overflowY: 'auto',
  overflowAnchor: 'none',
}

const BADGE: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 5,
  border: '1px solid var(--fp-border)',
  fontSize: 11,
  lineHeight: 1.5,
}

/**
 * 通过率的颜色。**没测过不给颜色** —— 见头注释。
 *
 * 分界线定在 60%:免费节点抽风是常态,偶尔一次没测通说明不了什么,连着一多半都不通
 * 才是真坏了。这个数只影响一个字的颜色,不参与任何筛选,所以不做成设置项。
 */
const OK_GOOD = '#34c759'
const OK_BAD = '#ff3b30'
const RATE_STYLES: Record<string, React.CSSProperties> = {
  good: { color: OK_GOOD, fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  bad: { color: OK_BAD, fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
}

interface RowProps {
  row: FreePoolRow
  checked: boolean
  /** 必须是稳定引用,否则行 memo 白加 */
  onToggle: (uriHash: string) => void
}

const Row = memo(function Row({ row, checked, onToggle }: RowProps) {
  const c = row.check ?? NO_CHECK
  const rate = okRate(c)

  return (
    <div style={ROW_STYLE} className="fp-row">
      <input
        type="checkbox"
        style={CHECK}
        checked={checked}
        onChange={() => onToggle(row.uriHash)}
      />
      <div style={ELLIPSIS} title={row.name || '(没有名字)'}>
        {row.name || <span style={MUTED}>(没有名字)</span>}
      </div>
      <div>
        <span style={BADGE}>{row.proto}</span>
      </div>
      <div style={MONO} title={`${row.server}:${row.port}`}>
        {row.server}:{row.port}
      </div>
      <div style={ELLIPSIS} title={`来源:${row.sourceId}`}>
        {row.sourceId}
      </div>
      <div style={NUM} title="抓取时出现过几次 —— 反复出现的机器更可能是长期在跑的">
        {row.seenCount}
      </div>
      <div style={NUM} title={c.checked === 0 ? '还没轮到实测' : `测过 ${c.checked} 次,通了 ${c.ok} 次`}>
        {c.checked === 0 ? <span style={MUTED}>未测</span> : `${c.ok}/${c.checked}`}
      </div>
      <div
        style={ELLIPSIS}
        title={
          c.checked === 0
            ? '还没轮到实测'
            : `最后一次 ${c.lastTs}:${c.lastOk ? '通' : '不通'}`
        }
      >
        {c.checked === 0 ? (
          <span style={MUTED}>—</span>
        ) : (
          <span style={rate >= 60 ? RATE_STYLES.good : RATE_STYLES.bad}>
            {c.lastOk ? '通' : '不通'} · {rate}%
          </span>
        )}
      </div>
      <div style={NUM} title={c.medianMs == null ? '一次都没通过,没有延迟数据' : '通的那几次的中位数'}>
        {c.medianMs == null ? <span style={MUTED}>—</span> : `${c.medianMs} ms`}
      </div>
    </div>
  )
})

interface Props {
  rows: FreePoolRow[]
  chosen: Set<string>
  onToggle: (uriHash: string) => void
}

export default function FreePoolTable({ rows, chosen, onToggle }: Props) {
  const theme = useTheme()
  const parentRef = useRef<HTMLDivElement>(null)

  // 用 uriHash 当 key,不用下标 —— 筛完之后同一个下标是另一条节点了,
  // 拿下标当 key 会让 React 复用错行的 DOM(勾选框会串)。
  const getItemKey = useCallback((i: number) => rows[i]?.uriHash ?? i, [rows])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    getItemKey,
  })

  const vars = useMemo(
    () =>
      ({
        '--fp-border': theme.palette.divider,
        '--fp-muted': theme.palette.text.secondary,
        '--fp-bg': theme.palette.background.paper,
        '--fp-hover': theme.palette.action.hover,
        minWidth: MIN_W,
      }) as React.CSSProperties,
    [theme],
  )

  const items = virtualizer.getVirtualItems()

  return (
    <div style={OUTER}>
      <style>{`.fp-row:hover{background:var(--fp-hover)}`}</style>
      <div style={vars}>
        <div style={HEAD_STYLE}>
          <span />
          <span>名称</span>
          <span>协议</span>
          <span>服务器</span>
          <span>来源</span>
          <span style={NUM}>出现</span>
          <span style={NUM}>通/测</span>
          <span>最后一次</span>
          <span style={NUM}>中位延迟</span>
        </div>
        <div ref={parentRef} style={SCROLLER}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const r = rows[vi.index]
              return (
                <div
                  key={vi.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <Row row={r} checked={chosen.has(r.uriHash)} onToggle={onToggle} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
