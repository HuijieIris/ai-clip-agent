import type { ReactNode } from 'react'
import { IconCheck, IconX } from './icons'

export function Checkbox({ on, onClick, label }: { on: boolean; onClick?: (e: React.MouseEvent) => void; label?: string }) {
  return (
    <div
      className={`checkbox ${on ? 'on' : ''}`}
      onClick={onClick}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.(e as any)}
    >
      <IconCheck size={12} />
    </div>
  )
}

export function Badge({ children, kind }: { children: ReactNode; kind?: 'accent' | 'success' | 'warning' | 'error' }) {
  return <span className={`badge ${kind ? `badge-${kind}` : ''}`}>{children}</span>
}

export function Progress({ value, thin }: { value: number; thin?: boolean }) {
  return (
    <div className={`progress ${thin ? 'thin' : ''}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function Alert({ kind, children, title }: { kind: 'warning' | 'error' | 'info' | 'success'; children: ReactNode; title?: string }) {
  return (
    <div className={`alert alert-${kind}`}>
      <div>
        {title && <b style={{ display: 'block', marginBottom: 2 }}>{title}</b>}
        {children}
      </div>
    </div>
  )
}

export function Empty({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 14 }}>{title}</div>
      {desc && <div className="sm" style={{ maxWidth: 420 }}>{desc}</div>}
      {action}
    </div>
  )
}

export function Modal({
  open, title, onClose, children, footer, width, sub,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  sub?: string
}) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal>
        <div className="modal-head">
          <div>
            <div className="h2">{title}</div>
            {sub && <div className="tiny muted" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs">
      {options.map((o) => (
        <button key={o.value} className={`tab ${value === o.value ? 'on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="label">
        {label} {required && <span className="req">*</span>}
        {hint && <span className="tiny muted" style={{ fontWeight: 400 }}>{hint}</span>}
      </label>
      {children}
    </div>
  )
}
