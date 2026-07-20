import type { ReactNode } from 'react'

export function ModuleTabs<T extends string>({ value, items, onChange, label }: { value: T; items: ReadonlyArray<{ value: T; label: string; count?: number }>; onChange(value: T): void; label: string }) {
  return <div className="module-tabs" role="tablist" aria-label={label}>{items.map(item => <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}><span>{item.label}</span>{item.count !== undefined && <small>{item.count}</small>}</button>)}</div>
}

export function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>
}

export function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>
}

export function ToggleSwitch({ checked, onChange, label, description, disabled = false }: {
  checked: boolean
  onChange(checked: boolean): void
  label: string
  description?: string
  disabled?: boolean
}) {
  return <label className="toggle-control"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span><span className="toggle-copy"><b>{label}</b>{description && <small>{description}</small>}</span></label>
}

export function ChoiceChip({ selected, onClick, children, className = '' }: {
  selected: boolean
  onClick(): void
  children: ReactNode
  className?: string
}) {
  return <button type="button" className={`choice-chip ${selected ? 'selected' : ''} ${className}`} aria-pressed={selected} onClick={onClick}>{children}</button>
}
