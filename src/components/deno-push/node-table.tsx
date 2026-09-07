/**
 * node-table.tsx — Deno Push 页的节点表。**故意不用 MUI 的 Table。**
 *
 * 这一页的表和别处不一样:机场动辄四五百个节点,而且上面的搜索框每敲一个字符
 * 就要重新过滤、重新渲染。用 MUI 组件堆出来的话,单行是这个成本:
 *
 *     TableRow + 8×TableCell + Chip + Checkbox(内含 ButtonBase/2×SVG/TouchRipple)
 *     + 4×Tooltip + 6 个内联 sx 对象
 *     ≈ 15 个 MUI 元素 → 展开 30~40 个 React 元素 + 6 次 emotion 样式序列化
 *
 * 500 个节点就是 ~17500 个 React 元素、3000 次样式序列化、2000 个 Tooltip 实例,
 * 而且每次过滤条件一变就整套重来。老机器上这是**秒级**的卡顿,不是"有点慢"。
 *
 * 所以这里三件事一起做:
 *
 *   1. **虚拟化**(@tanstack/react-virtual,仓库里本来就有,代理列表和日志页都在用)。
 *      只渲染视口里那二三十行,渲染量跟节点总数脱钩。
 *   2. **单行不用任何 MUI**。CSS grid 排版 + 原生 checkbox + 原生 title 属性。
 *      原生 title 显示出来的东西跟 Tooltip 一模一样,成本是零。
 *   3. **行组件 memo,且只收原始值**(checked 是 boolean,不是那个 Set)。
 *      勾一个框只重渲那一行 —— 直接把整个 Set 传进来的话引用变了,memo 形同虚设。
 *
 * 配色走 CSS 变量,在容器上设一次。这样行里不需要读 theme,memo 也就不会因为
 * theme 对象而失效。
 *
 * 行高固定,所以**不挂 measureElement** —— 那会给每个渲染出来的行装一个
 * ResizeObserver,而我们的行高是常量,量了也白量。
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useTheme } from '@mui/material/styles'
import { memo, useCallback, useMemo, useRef } from 'react'

import { type NodeRow, REACH_TARGETS } from '@/services/deno-push'

/** 行高(px)。改这个值要同步改 ROW_STYLE 的 height。 */
const ROW_H = 32

/** 表格列宽。表头和数据行必须用同一个值,否则列会对不齐。 */
const GRID = '36px minmax(150px,1.7fr) 76px minmax(150px,1.5fr) 128px 56px 78px 66px'

/** 横向最小宽度:列宽下限之和。比这个窄就横向滚动,不挤成一团。 */
const MIN_W = 780

/**
 * 视口高度用 CSS 算,不用 JS 量窗口。react-virtual 自己在滚动容器上挂了
 * ResizeObserver,窗口一变它就知道 —— 再自己加一个 resize 监听是重复劳动。
 */
const VIEWPORT_H = 'clamp(240px, calc(100vh - 430px), 900px)'

export const pushable = (r: NodeRow) => !!r.uri

// —— 样式对象全部提到模块级。每次渲染新建对象的话,React 每帧都要重新 diff 一遍 style。

const HEAD_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID,
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  height: 34,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dp-muted)',
  borderBottom: '1px solid var(--dp-border)',
  background: 'var(--dp-bg)',
  // 表头在滚动容器**外面**,本来就一直可见,不需要 sticky
}

const ROW_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID,
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  height: ROW_H,
  fontSize: 12.5,
  borderBottom: '1px solid var(--dp-border)',
  boxSizing: 'border-box',
}

const ELLIPSIS: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const MONO: React.CSSProperties = {
  ...ELLIPSIS,
  fontFamily: 'monospace',
  fontSize: 11.5,
}

const NUM: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

const BADGE: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 5,
  border: '1px solid var(--dp-border)',
  fontSize: 11,
  lineHeight: 1.5,
}

const DOTS: React.CSSProperties = { textAlign: 'center', whiteSpace: 'nowrap' }
const MUTED: React.CSSProperties = { opacity: 0.5 }
const CHECK: React.CSSProperties = { width: 14, height: 14, margin: 0, cursor: 'pointer' }
const OUTER: React.CSSProperties = { overflowX: 'auto' }
const SCROLLER: React.CSSProperties = {
  height: VIEWPORT_H,
  overflowY: 'auto',
  // 行是绝对定位的,浏览器的滚动锚定在这种结构上只会帮倒忙(过滤后乱跳)
  overflowAnchor: 'none',
}

/** 没测过 / 测了不通 / 通。灰点必须跟红点区分开——"没测"和"不通"是两回事。 */
const DOT_UNTESTED = '#c7c7cc'
const DOT_OK = '#34c759'
const DOT_BAD = '#ff3b30'

const dotStyle = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: color,
  margin: '0 2px',
})

// 三个目标的圆点样式是固定的三选一,提前建好,避免每行每个点都造一个新对象
const DOT_STYLES: Record<string, React.CSSProperties> = {
  [DOT_UNTESTED]: dotStyle(DOT_UNTESTED),
  [DOT_OK]: dotStyle(DOT_OK),
  [DOT_BAD]: dotStyle(DOT_BAD),
}

interface RowProps {
  row: NodeRow
  checked: boolean
  /** 必须是稳定引用(页面那边用 useCallback + 函数式 setState),否则 memo 白加 */
  onToggle: (name: string) => void
}

const Row = memo(function Row({ row, checked, onToggle }: RowProps) {
  const ok = pushable(row)
  const style = useMemo(
    () => (ok ? ROW_STYLE : { ...ROW_STYLE, opacity: 0.45 }),
    [ok],
  )

  return (
    <div style={style} className="dp-row">
      <span title={ok ? undefined : '这个节点缺关键字段,转不出分享链接,推不了'}>
        <input
          type="checkbox"
          style={CHECK}
          disabled={!ok}
          checked={checked}
          onChange={() => onToggle(row.name)}
        />
      </span>
      <div style={ELLIPSIS} title={row.name}>
        {row.name}
      </div>
      <div>
        <span style={BADGE}>{row.proto}</span>
      </div>
      <div style={MONO} title={`${row.server}:${row.port}`}>
        {row.server}:{row.port}
      </div>
      <div style={MONO}>
        {row.ip ?? <span style={MUTED}>解析不了</span>}
      </div>
      <div style={ELLIPSIS}>{row.cc ?? <span style={MUTED}>未知</span>}</div>
      <div style={NUM}>
        {row.delay > 0 ? `${row.delay} ms` : <span style={MUTED}>未测</span>}
      </div>
      <div style={DOTS}>
        {REACH_TARGETS.map((t) => {
          const v = row.reach?.[t.key]
          // undefined = 没测过(灰);0 = 测了不通(红);>0 = 通(绿)
          const color = v === undefined ? DOT_UNTESTED : v > 0 ? DOT_OK : DOT_BAD
          const tip =
            v === undefined
              ? `${t.label}:没测过`
              : v > 0
                ? `${t.label}:${v} ms`
                : `${t.label}:连不上`
          return <span key={t.key} style={DOT_STYLES[color]} title={tip} />
        })}
      </div>
    </div>
  )
})

interface Props {
  rows: NodeRow[]
  chosen: Set<string>
  onToggle: (name: string) => void
}

export default function NodeTable({ rows, chosen, onToggle }: Props) {
  const theme = useTheme()
  const parentRef = useRef<HTMLDivElement>(null)

  // 用节点名当 key,不用下标 —— 过滤之后同一个下标对应的是另一个节点了,
  // 拿下标当 key 会让 React 复用错行的 DOM(勾选框会串)。
  const getItemKey = useCallback((i: number) => rows[i]?.name ?? i, [rows])

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
        '--dp-border': theme.palette.divider,
        '--dp-muted': theme.palette.text.secondary,
        '--dp-bg': theme.palette.background.paper,
        '--dp-hover': theme.palette.action.hover,
        minWidth: MIN_W,
      }) as React.CSSProperties,
    [theme],
  )

  const items = virtualizer.getVirtualItems()

  return (
    <div style={OUTER}>
      {/* 一个 style 标签换掉 500 行 × emotion —— hover 这种纯样式的东西不值得走 JS */}
      <style>{`.dp-row:hover{background:var(--dp-hover)}`}</style>
      <div style={vars}>
        <div style={HEAD_STYLE}>
          <span />
          <span>名称</span>
          <span>协议</span>
          <span>服务器</span>
          <span>IP</span>
          <span>国家</span>
          <span style={NUM}>延迟</span>
          <span style={DOTS}>可达</span>
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
                  <Row row={r} checked={chosen.has(r.name)} onToggle={onToggle} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
