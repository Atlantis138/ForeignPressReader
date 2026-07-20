import type { ButtonHTMLAttributes, CSSProperties, ReactNode, RefObject } from 'react'
import {
  AppearanceIcon,
  ArrowLeftIcon,
  CheckIcon,
  DictionaryIcon,
  LibraryIcon,
  SearchIcon,
  SettingsIcon,
  StudyIcon,
} from '../ui/icons'
import { AppLogo } from '../ui/app-logo'
import type { PrimaryTab } from './mobile-shell-model'

export interface MobileTask {
  id: string
  kind: 'import' | 'dictionary' | 'study' | 'translation' | 'speech' | 'data'
  label: string
  detail?: string
  progress?: number | null
  onCancel?: () => void
}

const NAV_ITEMS: ReadonlyArray<{ tab: PrimaryTab; label: string; icon: (props: { className?: string }) => ReactNode }> = [
  { tab: 'library', label: '书库', icon: LibraryIcon },
  { tab: 'dictionary', label: '词典', icon: DictionaryIcon },
  { tab: 'study', label: '背单词', icon: StudyIcon },
  { tab: 'settings', label: '设置', icon: SettingsIcon },
]

export function MobileAppShell({ activeTab, immersive, onSelectTab, scrollRef, busy, task, error, onDismissError, snackbar, onDismissSnackbar, children }: {
  activeTab: PrimaryTab
  immersive: boolean
  onSelectTab(tab: PrimaryTab): void
  scrollRef: RefObject<HTMLElement | null>
  busy?: boolean
  task?: MobileTask | null
  error?: string | null
  onDismissError?(): void
  snackbar?: string | null
  onDismissSnackbar?(): void
  children: ReactNode
}) {
  return <div className="mobile-app mobile-app-shell" data-immersive={immersive ? 'true' : 'false'}>
    {busy && <InlineProgress />}
    {error && <InlineBanner tone="danger" role="alert" action="关闭" onAction={onDismissError}>{error}</InlineBanner>}
    {task && <GlobalTaskBar task={task} />}
    {!immersive && <PrimaryNavigation activeTab={activeTab} onSelect={onSelectTab} />}
    <main ref={scrollRef} className="main-content mobile-scroll" tabIndex={-1}>{children}</main>
    {snackbar && <Snackbar message={snackbar} onDismiss={onDismissSnackbar} />}
  </div>
}

export function PrimaryNavigation({ activeTab, onSelect }: { activeTab: PrimaryTab; onSelect(tab: PrimaryTab): void }) {
  return <nav className="mobile-primary-navigation" aria-label="主要导航">
    <div className="mobile-navigation-brand" aria-hidden="true"><AppLogo /></div>
    {NAV_ITEMS.map((item) => {
      const Icon = item.icon
      const active = item.tab === activeTab
      return <button key={item.tab} type="button" className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => onSelect(item.tab)}>
        <Icon className="mobile-navigation-icon" />
        <span>{item.label}</span>
      </button>
    })}
    <small className="mobile-navigation-status"><i /> 本地</small>
  </nav>
}

export function TopAppBar({ title, onBack, action, eyebrow }: { title: string; onBack?: () => void; action?: ReactNode; eyebrow?: string }) {
  return <header className="mobile-toolbar">
    <span>{onBack && <IconButton label="返回" onClick={onBack}><ArrowLeftIcon /></IconButton>}</span>
    <div>{eyebrow && <small>{eyebrow}</small>}<strong>{title}</strong></div>
    <span>{action}</span>
  </header>
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: ReactNode; description?: string; action?: ReactNode }) {
  return <header className="mobile-page-header">
    <div>{eyebrow && <p className="mobile-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action && <div className="mobile-page-header-action">{action}</div>}
  </header>
}

export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return <header className="mobile-section-header"><h2>{title}</h2>{detail && <span>{detail}</span>}</header>
}

export function EditorialCard({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <section className={`editorial-card ${className}`} style={style}>{children}</section>
}

export function BookCover({ title, imageUrl, width = 384, height = 512 }: { title: string; imageUrl?: string | null; width?: number | null; height?: number | null }) {
  return <span className="mobile-cover"><b aria-hidden="true">{title.slice(0,1)}</b>{imageUrl && <img src={imageUrl} alt="" width={width ?? 384} height={height ?? 512} loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true }} />}</span>
}

export function MobileButton({ variant = 'secondary', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'text' }) {
  return <button type="button" className={`mobile-button ${variant} ${className}`} {...props}>{children}</button>
}

export function IconButton({ label, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`mobile-icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>
}

export function SegmentedControl<T extends string>({ value, items, label, onChange }: {
  value: T
  items: ReadonlyArray<{ value: T; label: string }>
  label: string
  onChange(value: T): void
}) {
  return <div className="mobile-segmented" role="tablist" aria-label={label}>{items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>
}

export function SearchField({ value, onChange, onSubmit, placeholder }: { value: string; onChange(value: string): void; onSubmit(): void; placeholder: string }) {
  return <form className="mobile-search-field" role="search" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
    <SearchIcon />
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoCapitalize="none" enterKeyHint="search" />
    <MobileButton variant="primary" type="submit">搜索</MobileButton>
  </form>
}

export function ChoiceChip({ selected, children, onClick }: { selected: boolean; children: ReactNode; onClick(): void }) {
  return <button type="button" className={`mobile-choice-chip ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick}>{children}</button>
}

export function Toggle({ checked, label, description, disabled = false, onChange }: { checked: boolean; label: string; description?: string; disabled?: boolean; onChange(value: boolean): void }) {
  return <label className={`mobile-toggle ${disabled ? 'disabled' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true"><i /></span><b>{label}<small>{description}</small></b></label>
}

export function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return <span className={`mobile-status-pill ${tone}`}>{children}</span>
}

export function EmptyState({ symbol, title, description, action }: { symbol: string; title: string; description: string; action?: ReactNode }) {
  return <section className="mobile-empty"><span aria-hidden="true">{symbol}</span><h2>{title}</h2><p>{description}</p>{action}</section>
}

export function ErrorState({ title = '暂时无法显示', description, onRetry }: { title?: string; description: string; onRetry?: () => void }) {
  return <section className="mobile-state-card error"><strong>!</strong><h2>{title}</h2><p>{description}</p>{onRetry && <MobileButton onClick={onRetry}>重试</MobileButton>}</section>
}

export function OfflineState({ description }: { description: string }) {
  return <section className="mobile-state-card offline"><strong>离线</strong><h2>当前没有网络</h2><p>{description}</p></section>
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="mobile-skeleton" aria-label="正在加载">{Array.from({ length: lines }, (_, index) => <i key={index} />)}</div>
}

export function BottomSheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <div className="sheet-backdrop" onClick={onClose}><section className="mobile-bottom-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
    <header><span /><h2>{title}</h2><MobileButton variant="text" onClick={onClose}>完成</MobileButton></header>
    {children}
  </section></div>
}

export function FilterSheet({ title = '筛选', onClose, children }: { title?: string; onClose(): void; children: ReactNode }) {
  return <BottomSheet title={title} onClose={onClose}><div className="mobile-filter-sheet">{children}</div></BottomSheet>
}

export function SelectionBar({ count, cancelLabel = '取消', onCancel, actions }: { count: number; cancelLabel?: string; onCancel(): void; actions: ReactNode }) {
  return <section className="mobile-selection-bar" aria-label={`已选择 ${count} 项`}><MobileButton variant="text" onClick={onCancel}>{cancelLabel}</MobileButton><b>已选择 {count} 项</b><div>{actions}</div></section>
}

export function PaginationFooter({ offset, limit, total, onPrevious, onNext }: { offset: number; limit: number; total: number; onPrevious(): void; onNext(): void }) {
  return <footer className="mobile-pagination"><MobileButton disabled={offset <= 0} onClick={onPrevious}>上一页</MobileButton><span>{total ? `${offset + 1}–${Math.min(total, offset + limit)} / ${total}` : '0 / 0'}</span><MobileButton disabled={offset + limit >= total} onClick={onNext}>下一页</MobileButton></footer>
}

export function SideSheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <div className="sheet-backdrop mobile-side-sheet-backdrop" onClick={onClose}><section className="mobile-side-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}><TopAppBar title={title} onBack={onClose} />{children}</section></div>
}

export function FullScreenDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <section className="mobile-fullscreen-dialog" role="dialog" aria-modal="true" aria-label={title}><TopAppBar title={title} onBack={onClose} />{children}</section>
}

export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = '取消', onConfirm, onCancel }: { title: string; description: string; confirmLabel: string; cancelLabel?: string; onConfirm(): void; onCancel(): void }) {
  return <div className="mobile-dialog-backdrop" onClick={onCancel}><section className="mobile-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mobile-confirm-title" onClick={(event) => event.stopPropagation()}>
    <div className="mobile-confirm-icon"><AppearanceIcon /></div><h2 id="mobile-confirm-title">{title}</h2><p>{description}</p>
    <div><MobileButton onClick={onCancel}>{cancelLabel}</MobileButton><MobileButton variant="primary" onClick={onConfirm}>{confirmLabel}</MobileButton></div>
  </section></div>
}

export function InlineProgress() {
  return <div className="mobile-progress-line" role="progressbar" aria-label="正在处理" />
}

export function GlobalTaskBar({ task }: { task: MobileTask }) {
  const style = task.progress === null || task.progress === undefined ? undefined : { '--task-progress': `${Math.max(0, Math.min(1, task.progress)) * 100}%` } as CSSProperties
  return <section className="mobile-global-task" aria-live="polite" style={style}>
    <span className="mobile-task-icon"><CheckIcon /></span><div><b>{task.label}</b>{task.detail && <small>{task.detail}</small>}<i /></div>
    {task.onCancel && <MobileButton variant="text" onClick={task.onCancel}>取消</MobileButton>}
  </section>
}

export function InlineBanner({ tone, role, children, action, onAction }: { tone: 'danger' | 'warning'; role?: 'alert' | 'status'; children: ReactNode; action?: string; onAction?: () => void }) {
  return <section className={`mobile-inline-banner ${tone}`} role={role}><span>{children}</span>{action && <button type="button" onClick={onAction}>{action}</button>}</section>
}

export function Snackbar({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <output className="mobile-snackbar" aria-live="polite"><span>{message}</span>{onDismiss && <button type="button" onClick={onDismiss}>关闭</button>}</output>
}

export function LexemeHeader({ lemma, phonetic, action }: { lemma: string; phonetic?: string | null; action?: ReactNode }) {
  return <header className="mobile-lexeme-header"><div><h1>{lemma}</h1>{phonetic && <span>/{phonetic}/</span>}</div>{action}</header>
}

export function LexemeBadges({ badges }: { badges: ReadonlyArray<{ label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }> }) {
  return <div className="lexeme-badges">{badges.map((badge) => <StatusPill key={badge.label} tone={badge.tone}>{badge.label}</StatusPill>)}</div>
}

export function SenseList({ groups }: { groups: ReadonlyArray<{ partOfSpeech: string; meanings: readonly string[] }> }) {
  return <div className="dictionary-senses">{groups.map((group, index) => <section key={`${group.partOfSpeech}-${index}`}><h3>{group.partOfSpeech}</h3>{group.meanings.map((meaning) => <p key={meaning}>{meaning}</p>)}</section>)}</div>
}

export function ContextCard({ title, sentence, translation, action }: { title?: string; sentence: string; translation?: string | null; action?: ReactNode }) {
  return <article className="mobile-context-card">{title && <small>{title}</small>}<blockquote>{sentence}</blockquote>{translation && <p>{translation}</p>}{action}</article>
}

export function StudyAnswerActions({ busy, onKnown, onUnknown }: { busy?: boolean; onKnown(): void; onUnknown(): void }) {
  return <div className="study-actions"><MobileButton variant="primary" disabled={busy} onClick={onKnown}>认识</MobileButton><MobileButton disabled={busy} onClick={onUnknown}>不认识</MobileButton></div>
}
