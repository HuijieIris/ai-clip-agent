import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDown, IconCheck } from './icons'
import { RATIOS, getRatio, type RatioDef } from '../lib/ratios'

/** 通用下拉外壳：点击外部关闭、Esc 关闭 */
export function Dropdown({
  trigger,
  children,
  width,
  align = 'left',
  label,
}: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  width?: number
  align?: 'left' | 'right'
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`pill ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
      >
        {trigger(open)}
      </button>
      {open && (
        <div className="dropdown" style={{ width, [align === 'right' ? 'right' : 'left']: 0 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** 比例示意图：用真实宽高比画一个方块 */
export function RatioGlyph({ def, size = 22, active }: { def: RatioDef; size?: number; active?: boolean }) {
  const r = def.id === 'fit' ? 9 / 16 : def.width / def.height
  const maxW = size * (r > 1 ? 1 : r)
  const maxH = size * (r > 1 ? 1 / r : 1)
  return (
    <span className="ratio-glyph" style={{ width: size, height: size }}>
      <i
        style={{
          width: def.id === 'fit' ? size * 0.7 : maxW,
          height: def.id === 'fit' ? size * 0.7 : maxH,
          borderStyle: def.id === 'fit' ? 'dashed' : 'solid',
          borderColor: active ? 'var(--accent)' : 'var(--text-muted)',
        }}
      />
    </span>
  )
}

export function RatioSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const cur = getRatio(value)
  return (
    <Dropdown
      width={318}
      label="画面比例"
      trigger={() => (
        <>
          <span className="pill-icon">
            <RatioGlyph def={cur} size={16} active />
          </span>
          <span className="pill-value">{cur.label}</span>
          <IconChevronDown size={13} />
        </>
      )}
    >
      {(close) => (
        <div role="listbox">
          <div className="dropdown-head">画面比例</div>
          <div className="dropdown-scroll">
            {RATIOS.map((r) => {
              const on = r.id === value
              return (
                <button
                  key={r.id}
                  className={`dropdown-item ${on ? 'on' : ''}`}
                  onClick={() => {
                    onChange(r.id)
                    close()
                  }}
                  role="option"
                  aria-selected={on}
                >
                  <span className="dropdown-item-glyph">
                    <RatioGlyph def={r} size={30} active={on} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="dropdown-item-title">{r.label}</span>
                    <span className="dropdown-item-desc">
                      {r.id === 'fit' ? '沿用模板画布尺寸' : `${r.width}×${r.height}${r.hint ? ' · ' + r.hint : ''}`}
                    </span>
                  </span>
                  {on && <IconCheck size={13} className="dropdown-check" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Dropdown>
  )
}

/* ---------------- 切片时长 ---------------- */

export interface DurationRange {
  min: number // 秒
  max: number
}

export const DURATION_PRESETS: { label: string; min: number; max: number }[] = [
  { label: '15 秒 ～ 1 分钟', min: 15, max: 60 },
  { label: '30 秒 ～ 2 分钟', min: 30, max: 120 },
  { label: '1 ～ 3 分钟', min: 60, max: 180 },
  { label: '2 ～ 5 分钟', min: 120, max: 300 },
  { label: '30 秒 ～ 90 秒', min: 30, max: 90 },
]

export function DurationSelect({
  value,
  onChange,
  videoDuration,
}: {
  value: DurationRange
  onChange: (v: DurationRange) => void
  videoDuration: number
}) {
  const [mode, setMode] = useState<'preset' | 'custom'>(
    DURATION_PRESETS.some((p) => p.min === value.min && p.max === value.max) ? 'preset' : 'custom'
  )
  const [minS, setMinS] = useState(value.min)
  const [maxS, setMaxS] = useState(value.max)

  useEffect(() => {
    setMinS(value.min)
    setMaxS(value.max)
  }, [value.min, value.max])

  const maxAllowed = videoDuration > 0 ? Math.floor(videoDuration / 1000) : 600
  const customErr =
    minS >= maxS ? '最短需小于最长' : maxS > maxAllowed ? `最长不能超过视频时长 ${maxAllowed}s` : null

  const label =
    DURATION_PRESETS.find((p) => p.min === value.min && p.max === value.max)?.label ??
    `${value.min} 秒 ～ ${value.max} 秒`

  return (
    <Dropdown
      width={320}
      label="切片时长"
      trigger={() => (
        <>
          <span className="pill-icon">⏱</span>
          <span className="pill-value">{label}</span>
          <IconChevronDown size={13} />
        </>
      )}
    >
      {(close) => (
        <div>
          <div className="dropdown-head">切片时长范围</div>
          <div className="dropdown-scroll">
            {DURATION_PRESETS.map((p) => {
              const on = p.min === value.min && p.max === value.max
              const over = p.max > maxAllowed
              return (
                <button
                  key={p.label}
                  className={`dropdown-item ${on ? 'on' : ''}`}
                  disabled={over}
                  onClick={() => {
                    if (over) return
                    setMode('preset')
                    onChange({ min: p.min, max: p.max })
                    close()
                  }}
                  role="option"
                  aria-selected={on}
                >
                  <span style={{ flex: 1 }}>
                    <span className="dropdown-item-title">{p.label}</span>
                    <span className="dropdown-item-desc">
                      {over ? `超出视频时长（${maxAllowed}s）` : `单条 ${p.min}–${p.max} 秒`}
                    </span>
                  </span>
                  {on && <IconCheck size={13} className="dropdown-check" />}
                </button>
              )
            })}
          </div>
          <div className="dropdown-sep" />
          <div className="dropdown-custom">
            <div className="dropdown-head" style={{ padding: '0 0 8px' }}>自定义范围（秒）</div>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input input-sm mono" type="number" min={3} max={maxAllowed}
                value={minS}
                onChange={(e) => setMinS(Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="tiny muted">～</span>
              <input
                className="input input-sm mono" type="number" min={3} max={maxAllowed}
                value={maxS}
                onChange={(e) => setMaxS(Math.max(2, Number(e.target.value) || 2))}
              />
            </div>
            {customErr && <div className="tiny" style={{ color: 'var(--error)', marginTop: 6 }}>{customErr}</div>}
            <button
              className="btn btn-primary btn-sm btn-block"
              style={{ marginTop: 8 }}
              disabled={!!customErr}
              onClick={() => {
                setMode('custom')
                onChange({ min: minS, max: maxS })
                close()
              }}
            >
              应用自定义范围
            </button>
          </div>
        </div>
      )}
    </Dropdown>
  )
}

/* ---------------- 切片数量 ---------------- */

export function CountSelect({
  value,
  onChange,
  autoEstimate,
}: {
  value: number | 'auto'
  onChange: (v: number | 'auto') => void
  autoEstimate: { count: number; reason: string } | null
}) {
  return (
    <Dropdown
      width={300}
      align="right"
      label="切片数量"
      trigger={() => (
        <>
          <span className="pill-icon">◆</span>
          <span className="pill-value">
            {value === 'auto' ? `AI 智能推荐${autoEstimate ? ` · 约 ${autoEstimate.count} 条` : ''}` : `${value} 条`}
          </span>
          <IconChevronDown size={13} />
        </>
      )}
    >
      {(close) => (
        <div>
          <div className="dropdown-head">切片数量</div>
          <button
            className={`dropdown-item ${value === 'auto' ? 'on' : ''}`}
            onClick={() => {
              onChange('auto')
              close()
            }}
            role="option"
            aria-selected={value === 'auto'}
          >
            <span style={{ flex: 1 }}>
              <span className="dropdown-item-title">AI 智能推荐</span>
              <span className="dropdown-item-desc">
                {autoEstimate ? autoEstimate.reason : '上传视频后按内容与时长自动判断'}
              </span>
            </span>
            {value === 'auto' && <IconCheck size={13} className="dropdown-check" />}
          </button>
          <div className="dropdown-sep" />
          <div className="dropdown-head" style={{ padding: '0 0 8px' }}>自定义条数</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {[3, 5, 8, 10, 15, 20].map((n) => (
              <button
                key={n}
                className={`chip ${value === n ? 'on' : ''}`}
                onClick={() => {
                  onChange(n)
                  close()
                }}
              >
                {n} 条
              </button>
            ))}
          </div>
        </div>
      )}
    </Dropdown>
  )
}
