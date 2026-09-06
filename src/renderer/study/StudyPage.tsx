import { useDialogFocus } from '../ui/use-dialog-focus'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DictionaryCollection,
  StudyDashboard,
  StudyPlanDetail,
  StudyPlanInput,
  StudyPlanWordPage,
  StudyPlanWordQuery,
  StudySessionState,
  StudyTodayWordFilter,
  StudyTodayWordPage,
  StudyWordFilter,
  StudyDeletePlanOptions,
} from '../../shared/types'
import { getAppClient } from '../app-client'
import { useSpeech } from '../speech/SpeechProvider'
import { PronounceButton } from '../speech/PronounceButton'
import { PlusIcon } from '../ui/icons'
import { ChoiceChip } from '../ui/primitives'

const client = getAppClient()
const DEFAULT_PLAN: StudyPlanInput = {
  name: '',
  dailyNewLimit: 20,
  dailyReviewLimit: 100,
  sources: [{ type: 'reader_manual', ref: 'favorite' }],
}
const FILTERS: Array<[StudyWordFilter, string]> = [
  ['all', '全部'],
  ['due', '今日待复习'],
  ['unseen', '未学习'],
  ['learning', '学习中'],
  ['consolidating', '巩固中'],
  ['mature', '熟练'],
  ['suspended', '暂停复习'],
  ['excluded', '已排除'],
]

export interface StudyPageSnapshot {
  detailPlanId: string | null
  editing: StudyPlanInput | null
  editingId: string | null
  sessionOpen: boolean
  planWordPlanId: string | null
  planWordDraft: string
  planWordQuery: StudyPlanWordQuery
}

export function StudyPage({
  snapshot,
  onSnapshot,
  onError,
  onNotice,
}: {
  snapshot: StudyPageSnapshot
  onSnapshot(value: StudyPageSnapshot): void
  onError(message: string): void
  onNotice(message: string): void
}) {
  const initialSnapshotRef = useRef(snapshot)
  const [dashboard, setDashboard] = useState<StudyDashboard | null>(null),
    [loading, setLoading] = useState(true)
  const [session, setSession] = useState<StudySessionState | null>(null),
    [sessionBusy, setSessionBusy] = useState(false)
  const [editing, setEditing] = useState<StudyPlanInput | null>(
      snapshot.editing,
    ),
    [editingId, setEditingId] = useState<string | null>(snapshot.editingId),
    [collections, setCollections] = useState<DictionaryCollection[]>([]),
    [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<StudyPlanDetail | null>(null),
    [deleteTarget, setDeleteTarget] = useState<StudyPlanDetail | null>(null),
    [todayOpen, setTodayOpen] = useState(false),
    [undoKey, setUndoKey] = useState<string | null>(null)
  const [planWordPlanId, setPlanWordPlanId] = useState<string | null>(
      snapshot.planWordPlanId,
    ),
    [planWordDraft, setPlanWordDraft] = useState(snapshot.planWordDraft),
    [planWordQuery, setPlanWordQuery] = useState<StudyPlanWordQuery>(
      snapshot.planWordQuery,
    )
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadDashboard = useCallback(async () => {
    setLoadError(null)
    try {
      setDashboard(await client.study.getDashboard())
    } catch (e) {
      setLoadError(messageOf(e))
      throw e
    } finally {
      setLoading(false)
    }
  }, [])
  const refresh = useCallback(
    async (backgroundSync = true) => {
      await loadDashboard()
      if (backgroundSync)
        void client.study
          .syncSources()
          .then((result) => {
            if (result.syncedSources || result.failedSources)
              return loadDashboard()
          })
          .catch((e) => onError(messageOf(e)))
    },
    [loadDashboard, onError],
  )
  const openEditor = async (plan?: StudyPlanDetail) => {
    try {
      if (!collections.length) {
        const status = await client.dictionary.getStatus()
        setCollections(
          status.installed ? await client.dictionary.listCollections() : [],
        )
      }
      setEditingId(plan?.planId ?? null)
      setEditing(
        plan
          ? {
              name: plan.name,
              dailyNewLimit: plan.dailyNewLimit,
              dailyReviewLimit: plan.dailyReviewLimit,
              sources: plan.sources
                .filter((s) => s.active)
                .map((s) => ({ type: s.type, ref: s.ref })),
            }
          : { ...DEFAULT_PLAN, sources: [...DEFAULT_PLAN.sources] },
      )
    } catch (e) {
      onError(messageOf(e))
    }
  }
  const savePlan = async () => {
    if (!editing) return
    setSaving(true)
    try {
      if (editingId) await client.study.updatePlan(editingId, editing)
      else await client.study.createPlan(editing)
      setEditing(null)
      setEditingId(null)
      await refresh(false)
      onNotice('学习计划已保存')
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }
  const start = async () => {
    setSessionBusy(true)
    try {
      const next = await client.study.openToday()
      setSession(next)
      if (next.status === 'completed') {
        setSession(null)
        await refresh(false)
      }
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setSessionBusy(false)
    }
  }
  useEffect(() => {
    const initialSnapshot = initialSnapshotRef.current
    refresh().catch((e) => onError(messageOf(e)))
    if (initialSnapshot.detailPlanId)
      client.study
        .getPlan(initialSnapshot.detailPlanId)
        .then(setDetail)
        .catch((e) => onError(messageOf(e)))
    if (initialSnapshot.sessionOpen)
      client.study
        .openToday()
        .then((next) => setSession(next.status === 'active' ? next : null))
        .catch((e) => onError(messageOf(e)))
  }, [onError, refresh])
  useEffect(() => {
    onSnapshot({
      detailPlanId: detail?.planId ?? null,
      editing,
      editingId,
      sessionOpen: session?.status === 'active',
      planWordPlanId,
      planWordDraft,
      planWordQuery,
    })
  }, [
    detail?.planId,
    editing,
    editingId,
    onSnapshot,
    planWordDraft,
    planWordPlanId,
    planWordQuery,
    session?.status,
  ])
  const openDetail = async (planId: string) => {
    try {
      if (planWordPlanId !== planId) {
        setPlanWordPlanId(planId)
        setPlanWordDraft('')
        setPlanWordQuery({ text: '', filter: 'all', offset: 0, limit: 50 })
      }
      setDetail(await client.study.getPlan(planId))
    } catch (e) {
      onError(messageOf(e))
    }
  }
  const updateSession = async (action: () => Promise<StudySessionState>) => {
    setSessionBusy(true)
    try {
      const next = await action()
      if (next.status === 'completed') {
        setSession(null)
        await refresh(false)
      } else setSession(next)
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setSessionBusy(false)
    }
  }
  const stage = (answer: 'known' | 'unknown') => {
    const c = session?.current
    if (c)
      updateSession(() =>
        client.study.stageAnswer({
          sessionId: session!.sessionId,
          itemId: c.itemId,
          expectedVersion: c.version,
          answer,
        }),
      )
  }
  const commit = (answer: 'known' | 'unknown') => {
    const c = session?.current
    if (c)
      updateSession(() =>
        client.study.commitAnswer({
          sessionId: session!.sessionId,
          itemId: c.itemId,
          expectedVersion: c.version,
          commandId: crypto.randomUUID(),
          answer,
        }),
      )
  }
  const tooEasy = () => {
    const c = session?.current
    if (!c) return
    const key = c.lexemeKey
    updateSession(async () => {
      const next = await client.study.markTooEasy({
        sessionId: session!.sessionId,
        itemId: c.itemId,
        expectedVersion: c.version,
        commandId: crypto.randomUUID(),
      })
      setUndoKey(key)
      window.setTimeout(
        () => setUndoKey((current) => (current === key ? null : current)),
        6000,
      )
      return next
    })
  }
  const undoNotice = undoKey && (
    <div className="study-undo">
      已暂停该词复习{' '}
      <button
        onClick={async () => {
          try {
            await client.study.setWordSuspended(undoKey, false)
            setUndoKey(null)
            await refresh(false)
            onNotice('已恢复该词复习')
          } catch (e) {
            onError(messageOf(e))
          }
        }}
      >
        撤销
      </button>
    </div>
  )
  if (session?.status === 'active' && session.current)
    return (
      <>
        <StudySession
          active
          session={session}
          busy={sessionBusy}
          onStage={stage}
          onCommit={commit}
          onTooEasy={tooEasy}
          onExit={async () => {
            setSession(null)
            await refresh(false)
          }}
        />
        {undoNotice}
      </>
    )
  if (loading)
    return (
      <div className="loading">
        <span />
        <p>正在读取今日学习状态</p>
      </div>
    )
  if (!dashboard)
    return (
      <div role="alert">
        <p>{loadError ?? '学习状态暂不可用'}</p>
        <button
          onClick={() => {
            setLoading(true)
            void refresh().catch((e) => onError(messageOf(e)))
          }}
        >
          重试
        </button>
      </div>
    )
  const today = dashboard?.today
  return (
    <section className="page study-page">
      {undoNotice}
      <header className="page-header">
        <div>
          <p className="eyebrow">DAILY STUDY</p>
          <h1>{detail ? detail.name : '背单词'}</h1>
          <p>
            {detail
              ? '查看熟练度、复习安排与计划词表。'
              : '今天学什么、完成多少、刚才学过什么。'}
          </p>
        </div>
      </header>
      {detail ? (
        <PlanDetail
          detail={detail}
          developerMode={dashboard?.developerMode ?? false}
          draft={planWordDraft}
          query={planWordQuery}
          onDraft={setPlanWordDraft}
          onQuery={setPlanWordQuery}
          onClose={() => setDetail(null)}
          onEdit={() => openEditor(detail)}
          onChanged={async () => {
            const next = await client.study.getPlan(detail.planId)
            setDetail(next)
            await refresh(false)
          }}
          onDelete={() => setDeleteTarget(detail)}
          onError={onError}
        />
      ) : (
        <>
          <TodayCard
            dashboard={dashboard!}
            onStart={start}
            busy={sessionBusy}
            onHistory={() => setTodayOpen(true)}
            onExtra={async (id) => {
              if (!confirm('按该计划当前配额追加一批今日任务？')) return
              setSessionBusy(true)
              try {
                const next = await client.study.addExtraBatch(id)
                if (next.status === 'active') setSession(next)
                else await refresh(false)
              } catch (e) {
                onError(messageOf(e))
              } finally {
                setSessionBusy(false)
              }
            }}
          />
          <div className="study-toolbar">
            <div>
              <p className="eyebrow">LONG-TERM PLANS</p>
              <h2>长期计划</h2>
            </div>
            <button
              className="primary-button button-with-icon"
              onClick={() => openEditor()}
            >
              <PlusIcon />
              创建计划
            </button>
          </div>
          {!dashboard?.plans.length ? (
            <div className="dictionary-welcome">
              <h2>建立第一个长期计划</h2>
              <p>选择我的生词、考试词集或混合来源，然后设置每日配额。</p>
            </div>
          ) : (
            <div className="study-plan-grid">
              {dashboard.plans.map((plan) => (
                <button
                  className={`study-plan-card ${plan.status === 'archived' ? 'muted' : ''}`}
                  key={plan.planId}
                  onClick={() => openDetail(plan.planId)}
                >
                  <span
                    className={`pill ${plan.status === 'active' ? 'success' : ''}`}
                  >
                    {plan.status === 'active'
                      ? '启用中'
                      : plan.status === 'paused'
                        ? '已暂停'
                        : '已归档'}
                  </span>
                  <h3>{plan.name}</h3>
                  <p>{plan.sourceLabels.join('、') || '尚未选择词源'}</p>
                  <p>
                    每日 {plan.dailyNewLimit} 新词 / {plan.dailyReviewLimit}{' '}
                    复习
                  </p>
                  <small>{syncLabel(plan.syncStatus)}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {editing && (
        <PlanEditor
          value={editing}
          collections={collections}
          saving={saving}
          onChange={setEditing}
          onSave={savePlan}
          onCancel={() => setEditing(null)}
        />
      )}
      {deleteTarget && (
        <PlanDeleteDialog
          allowReset={dashboard?.developerMode ?? false}
          detail={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (options) => {
            try {
              await client.study.deletePlan(
                deleteTarget.planId,
                deleteTarget.name,
                options,
              )
              setDeleteTarget(null)
              setDetail((current) =>
                current?.planId === deleteTarget.planId ? null : current,
              )
              await refresh(false)
              onNotice(
                options.resetWordProgress
                  ? '计划已删除，相关单词学习进度已重置'
                  : '计划已删除',
              )
            } catch (e) {
              onError(messageOf(e))
              throw e
            }
          }}
        />
      )}
      {todayOpen && today && (
        <TodayWords
          sessionId={today.sessionId}
          onClose={() => setTodayOpen(false)}
          onError={onError}
        />
      )}
    </section>
  )
}

function PlanDeleteDialog({
  detail,
  allowReset,
  onCancel,
  onConfirm,
}: {
  detail: StudyPlanDetail
  allowReset: boolean
  onCancel(): void
  onConfirm(options: StudyDeletePlanOptions): Promise<void>
}) {
  const [confirmation, setConfirmation] = useState(''),
    [resetWordProgress, setResetWordProgress] = useState(false),
    [busy, setBusy] = useState(false)
  const valid = confirmation.normalize('NFKC').trim() === detail.name
  const dialogRef = useDialogFocus<HTMLDivElement>(() => {
    if (!busy) onCancel()
  })
  return (
    <div className="modal-backdrop destructive-confirmation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="删除学习计划"
        className="plan-delete-dialog"
      >
        <h2>删除学习计划</h2>
        <p>不会删除书库、生词收藏或收藏语境。请输入计划名称确认：</p>
        <label>
          计划名称
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={detail.name}
          />
        </label>
        {allowReset && (
          <fieldset>
            <legend>删除方式</legend>
            <label>
              <input
                type="radio"
                checked={!resetWordProgress}
                onChange={() => setResetWordProgress(false)}
              />{' '}
              仅删除计划
              <small>
                移除该计划和它未完成的今日队列项；相关单词已有 FSRS
                进度保留，可被其他计划继续使用。
              </small>
            </label>
            <label>
              <input
                type="radio"
                checked={resetWordProgress}
                onChange={() => setResetWordProgress(true)}
              />{' '}
              删除计划并重置相关单词学习进度
              <small>
                同时清除该计划涉及单词的复习卡、复习事件、强化事件、暂停复习状态和学习队列项。
              </small>
            </label>
          </fieldset>
        )}
        <div className="button-row">
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="danger-button"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm({ resetWordProgress })
              } catch {
                setBusy(false)
              }
            }}
          >
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TodayCard({
  dashboard,
  onStart,
  onHistory,
  onExtra,
  busy,
}: {
  dashboard: StudyDashboard
  onStart(): void
  onHistory(): void
  onExtra(id: string): void
  busy: boolean
}) {
  const t = dashboard.today
  if (!t)
    return (
      <section className="today-card">
        <div>
          <p className="eyebrow">TODAY</p>
          <h2>准备开始今天的学习</h2>
          <p>
            预计 {dashboard.preview.reviewCount} 个到期复习 ·{' '}
            {dashboard.preview.newCount} 个新词
          </p>
        </div>
        <button
          className="primary-button"
          disabled={busy || !dashboard.plans.some((p) => p.status === 'active')}
          onClick={onStart}
        >
          开始今日学习
        </button>
      </section>
    )
  const pct = t.total ? Math.round((t.completed / t.total) * 100) : 100
  return (
    <section className={`today-card ${t.status}`}>
      <div
        className="today-progress"
        style={{ '--progress': `${pct * 3.6}deg` } as React.CSSProperties}
      >
        <b>{pct}%</b>
        <small>
          {t.completed}/{t.total}
        </small>
      </div>
      <div className="today-copy">
        <p className="eyebrow">
          {t.status === 'completed' ? 'TODAY COMPLETE' : 'IN PROGRESS'}
        </p>
        <h2>
          {t.status === 'completed' ? '今天的任务已完成' : '继续今天的学习'}
        </h2>
        <p>
          {t.newCount} 新词 · {t.reviewCount} 复习 · {t.unknownCount} 个首次答错
          {t.tooEasyCount ? ` · ${t.tooEasyCount} 个太简单` : ''}
          {t.status === 'completed'
            ? ` · 用时 ${formatDuration(t.durationSeconds)}`
            : ''}
        </p>
        {t.recentWords.length > 0 && (
          <div className="recent-words">
            {t.recentWords.map((w) => (
              <span key={w.itemId}>{w.lemma}</span>
            ))}
          </div>
        )}
        <button className="text-button" onClick={onHistory}>
          查看今日词表
        </button>
      </div>
      <div className="today-actions">
        {t.status === 'active' ? (
          <button className="primary-button" disabled={busy} onClick={onStart}>
            继续今日学习
          </button>
        ) : (
          <>
            <button disabled>今日已完成</button>
            <small>下一学习日 {formatTime(t.nextRolloverAt)}</small>
            {dashboard.plans
              .filter((p) => p.status === 'active')
              .map((p) => (
                <button
                  key={p.planId}
                  disabled={!p.availableNewCount && !p.dueCount}
                  onClick={() => onExtra(p.planId)}
                >
                  再学一批 · {p.name}
                  <small>
                    最多 {Math.min(p.dailyNewLimit, p.availableNewCount)} 新词 /{' '}
                    {Math.min(p.dailyReviewLimit, p.dueCount)} 复习
                  </small>
                </button>
              ))}
          </>
        )}
      </div>
    </section>
  )
}

function StudySession({
  active,
  session,
  busy,
  onStage,
  onCommit,
  onTooEasy,
  onExit,
}: {
  active: boolean
  session: StudySessionState
  busy: boolean
  onStage(a: 'known' | 'unknown'): void
  onCommit(a: 'known' | 'unknown'): void
  onTooEasy(): void
  onExit(): void
}) {
  const c = session.current!
  const speech = useSpeech()
  const speechRef = useRef(speech)
  speechRef.current = speech
  const autoPlayStudy = speech.preferences.autoPlayStudy
  const currentCardRef = useRef(c)
  currentCardRef.current = c
  const [examples, setExamples] = useState(c.examples)
  const autoSpoken = useRef(new Set<string>())
  useEffect(() => {
    if (client.speech.getState().sourceId === 'study-card') client.speech.stop()
    if (autoPlayStudy && !autoSpoken.current.has(c.itemId)) {
      autoSpoken.current.add(c.itemId)
      speechRef.current.speakWord('study-card', c.itemId, c.lemma)
    }
  }, [autoPlayStudy, c.itemId, c.lemma])
  useEffect(
    () => () => {
      if (client.speech.getState().sourceId === 'study-card')
        client.speech.stop()
    },
    [],
  )
  useEffect(() => {
    const currentCard = currentCardRef.current
    setExamples(currentCard.examples)
    if (currentCard.examples.length) return
    let current = true
    client.study
      .hydrateCurrentExamples({
        sessionId: session.sessionId,
        itemId: currentCard.itemId,
        expectedVersion: currentCard.version,
      })
      .then((value) => {
        if (current) setExamples(value)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [c.itemId, c.version, session.sessionId])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || busy) return
      if (event.key === 'Escape') {
        speechRef.current.stop()
        onExit()
        return
      }
      if (!c.revealed && event.key === '1') onStage('unknown')
      if (!c.revealed && event.key === '2') onStage('known')
      if (c.revealed && event.key === 'Enter')
        onCommit(c.proposedAnswer ?? 'unknown')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, busy, c.revealed, c.proposedAnswer, onCommit, onExit, onStage])
  return (
    <section className="study-session">
      <header>
        <button
          onClick={() => {
            speech.stop()
            onExit()
          }}
        >
          ← 退出
        </button>
        <span>
          {session.completed}/{session.total}
        </span>
      </header>
      <div className="study-card">
        {c.canMarkTooEasy && (
          <button className="too-easy" disabled={busy} onClick={onTooEasy}>
            太简单
          </button>
        )}
        <p className="eyebrow">
          {c.hadFailure ? `强化 ${c.consecutiveKnown}/2` : 'ACTIVE RECALL'}
        </p>
        <div className="study-word-heading">
          <h1>{c.lemma}</h1>
          <PronounceButton
            sourceId="study-card"
            itemId={c.itemId}
            text={c.lemma}
          />
        </div>
        {c.phonetic && <p className="study-phonetic">/{c.phonetic}/</p>}
        {c.revealed && (
          <div className="study-answer">
            {c.senseGroups.length ? (
              c.senseGroups.map((s, i) => (
                <div key={`${s.partOfSpeech}-${i}`}>
                  <b>{s.partOfSpeech}</b>
                  {s.translations.map((t) => (
                    <p key={t}>{t}</p>
                  ))}
                </div>
              ))
            ) : (
              <p>{c.briefMeanings.join('；')}</p>
            )}
            {c.context && (
              <blockquote>
                <small>{c.context.articleTitle}</small>
                {c.context.sentence}
              </blockquote>
            )}
            {examples.map((example) => (
              <blockquote key={example.exampleId}>
                <small>百度例句</small>
                {example.text}
                {example.translationZh && <p>{example.translationZh}</p>}
              </blockquote>
            ))}
          </div>
        )}
      </div>
      <div className="study-actions">
        {!c.revealed ? (
          <>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => onStage('unknown')}
            >
              不认识
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onStage('known')}
            >
              认识
            </button>
          </>
        ) : c.proposedAnswer === 'known' ? (
          <>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => onCommit('unknown')}
            >
              其实不认识
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onCommit('known')}
            >
              确认认识，继续
            </button>
          </>
        ) : (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => onCommit('unknown')}
          >
            继续
          </button>
        )}
      </div>
    </section>
  )
}

function PlanEditor({
  value,
  collections,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  value: StudyPlanInput
  collections: DictionaryCollection[]
  saving: boolean
  onChange(v: StudyPlanInput): void
  onSave(): void
  onCancel(): void
}) {
  const has = (type: 'reader_manual' | 'exam_collection', ref: string) =>
      value.sources.some((s) => s.type === type && s.ref === ref),
    toggle = (type: 'reader_manual' | 'exam_collection', ref: string) =>
      onChange({
        ...value,
        sources: has(type, ref)
          ? value.sources.filter((s) => !(s.type === type && s.ref === ref))
          : [...value.sources, { type, ref }],
      })
  const dialogRef = useDialogFocus<HTMLDivElement>(() => {
    if (!saving) onCancel()
  })
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="学习计划"
        className="plan-editor"
      >
        <h2>学习计划</h2>
        <label>
          名称
          <input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <div className="plan-limits">
          <label>
            每日新词
            <input
              type="number"
              min="0"
              max="500"
              value={value.dailyNewLimit}
              onChange={(e) =>
                onChange({ ...value, dailyNewLimit: Number(e.target.value) })
              }
            />
          </label>
          <label>
            每日复习
            <input
              type="number"
              min="1"
              max="2000"
              value={value.dailyReviewLimit}
              onChange={(e) =>
                onChange({ ...value, dailyReviewLimit: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <fieldset className="source-chip-picker">
          <legend>词汇来源</legend>
          <ChoiceChip
            selected={has('reader_manual', 'favorite')}
            onClick={() => toggle('reader_manual', 'favorite')}
          >
            我的生词
          </ChoiceChip>
          {collections.map((c) => (
            <ChoiceChip
              key={c.id}
              selected={has('exam_collection', c.tag)}
              onClick={() => toggle('exam_collection', c.tag)}
            >
              <b>{c.name}</b>
              <small>{c.count.toLocaleString('zh-CN')} 词</small>
            </ChoiceChip>
          ))}
        </fieldset>
        <div className="button-row">
          <button onClick={onCancel}>取消</button>
          <button className="primary-button" disabled={saving} onClick={onSave}>
            {saving ? '同步中…' : '保存并同步'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DistributionDonut({
  distribution,
  active,
  onSelect,
}: {
  distribution: StudyPlanDetail['distribution']
  active: StudyWordFilter
  onSelect(filter: StudyWordFilter): void
}) {
  const values: Array<[StudyWordFilter, number, string]> = [
      ['unseen', distribution.unseen, '#b8b1a5'],
      ['learning', distribution.learning, '#d99b54'],
      ['consolidating', distribution.consolidating, '#5787aa'],
      ['mature', distribution.mature, '#4f8a62'],
      ['suspended', distribution.suspended, '#9a6a9c'],
    ],
    total = values.reduce((n, [, value]) => n + value, 0),
    scale = total || 1
  let offset = 0
  return (
    <div className="distribution-donut">
      <svg viewBox="0 0 42 42" aria-label="计划熟练度分布">
        {values.map(([filter, value, color]) => {
          const length = (value / scale) * 100,
            start = offset
          offset += length
          return value ? (
            <circle
              key={filter}
              className={active === filter ? 'active' : ''}
              cx="21"
              cy="21"
              r="15.9155"
              fill="none"
              stroke={color}
              strokeWidth="7"
              strokeDasharray={`${length} ${100 - length}`}
              strokeDashoffset={-start}
              transform="rotate(-90 21 21)"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(filter)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(filter)
                }
              }}
            />
          ) : null
        })}
      </svg>
      <span>
        {total}
        <small>总词数</small>
      </span>
    </div>
  )
}

function PlanDetail({
  detail,
  draft,
  query,
  onDraft,
  onQuery,
  onClose,
  onEdit,
  onChanged,
  onDelete,
  onError,
}: {
  detail: StudyPlanDetail
  developerMode: boolean
  draft: string
  query: StudyPlanWordQuery
  onDraft(value: string): void
  onQuery(value: StudyPlanWordQuery): void
  onClose(): void
  onEdit(): void
  onChanged(): void
  onDelete(): void
  onError(m: string): void
}) {
  const [page, setPage] = useState<StudyPlanWordPage | null>(null),
    [loading, setLoading] = useState(false),
    [actionKey, setActionKey] = useState<string | null>(null),
    seq = useRef(0),
    searchInputRef = useRef<HTMLInputElement | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const load = useCallback(
    async (q?: StudyPlanWordQuery) => {
      const requestedQuery = q ?? queryRef.current,
        current = ++seq.current
      setLoading(true)
      try {
        const result = await client.study.listPlanWords(
          detail.planId,
          requestedQuery,
        )
        if (current === seq.current) {
          setPage(result)
          onQuery(requestedQuery)
        }
      } catch (e) {
        onError(messageOf(e))
      } finally {
        if (current === seq.current) setLoading(false)
      }
    },
    [detail.planId, onError, onQuery],
  )
  useEffect(() => {
    void load()
    const timer = window.setTimeout(
      () => searchInputRef.current?.focus({ preventScroll: true }),
      0,
    )
    return () => window.clearTimeout(timer)
  }, [load])
  const changeFilter = (filter: StudyWordFilter) =>
    load({ ...query, filter, offset: 0 })
  const wordAction = async (key: string, action: () => Promise<void>) => {
    setActionKey(key)
    try {
      await action()
      await onChanged()
      await load(query)
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setActionKey((current) => (current === key ? null : current))
    }
  }
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose)
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="学习计划"
        className="plan-detail"
      >
        <header>
          <div>
            <p className="eyebrow">PLAN</p>
            <h2>{detail.name}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <p className="study-plan-summary">
          {detail.sources
            .filter((s) => s.active)
            .map((s) =>
              s.type === 'reader_manual' ? '我的生词' : s.ref.toUpperCase(),
            )
            .join('、')}{' '}
          · 每日 {detail.dailyNewLimit} 新词 / {detail.dailyReviewLimit} 复习 ·{' '}
          {syncLabel(detail.syncStatus)}
        </p>
        <div className="plan-insights">
          <DistributionDonut
            distribution={detail.distribution}
            active={query.filter}
            onSelect={changeFilter}
          />
          <div className="distribution-legend">
            {FILTERS.filter(
              ([f]) => !['all', 'due', 'excluded'].includes(f),
            ).map(([f, label]) => (
              <button
                className={query.filter === f ? 'active' : ''}
                key={f}
                onClick={() => changeFilter(f)}
              >
                <i className={f} />
                {label}
                <b>
                  {detail.distribution[f as keyof typeof detail.distribution]}
                </b>
              </button>
            ))}
          </div>
        </div>
        <div className="button-row">
          <button onClick={onEdit}>编辑设置</button>
          <button
            onClick={async () => {
              try {
                await client.study.setPlanStatus(
                  detail.planId,
                  detail.status === 'active' ? 'paused' : 'active',
                )
                await onChanged()
              } catch (e) {
                onError(messageOf(e))
              }
            }}
          >
            {detail.status === 'active' ? '暂停' : '启用'}
          </button>
          {detail.status !== 'archived' && (
            <button
              onClick={async () => {
                try {
                  await client.study.setPlanStatus(detail.planId, 'archived')
                  await onChanged()
                } catch (e) {
                  onError(messageOf(e))
                }
              }}
            >
              归档
            </button>
          )}
          <button className="danger-button" onClick={onDelete}>
            删除计划
          </button>
        </div>
        <div className="word-filter-row">
          {FILTERS.map(([f, label]) => (
            <button
              className={query.filter === f ? 'active' : ''}
              key={f}
              onClick={() => changeFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="study-word-search"
          onSubmit={(e) => {
            e.preventDefault()
            load({ ...query, text: draft.trim(), offset: 0 })
          }}
        >
          <input
            ref={searchInputRef}
            autoFocus
            value={draft}
            onPointerDown={(event) =>
              event.currentTarget.focus({ preventScroll: true })
            }
            onMouseDown={(event) =>
              event.currentTarget.focus({ preventScroll: true })
            }
            onChange={(e) => onDraft(e.target.value)}
            placeholder="搜索英文词头或中文释义"
          />
          <button type="submit" disabled={loading}>
            搜索
          </button>
          {query.text && (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                onDraft('')
                load({ ...query, text: '', offset: 0 })
                window.setTimeout(
                  () => searchInputRef.current?.focus({ preventScroll: true }),
                  0,
                )
              }}
            >
              清除
            </button>
          )}
        </form>
        {loading ? (
          <div className="plan-list-state">正在搜索…</div>
        ) : page && !page.items.length ? (
          <div className="plan-list-state">没有符合条件的词</div>
        ) : (
          <div className="plan-word-table">
            {page?.items.map((w) => (
              <div key={w.lexemeKey}>
                <span>
                  <b>{w.lemma}</b>
                  <small>{w.meanings.join('；')}</small>
                </span>
                <span>{stateLabel(w.state)}</span>
                <span>
                  难度 {w.difficulty?.toFixed(2) ?? '—'} · 稳定天数{' '}
                  {w.stability?.toFixed(1) ?? '—'} · 预计记忆率{' '}
                  {w.retrievability == null
                    ? '—'
                    : `${Math.round(w.retrievability * 100)}%`}
                  <small>
                    下次复习 {formatDate(w.dueAt)} · 复习 {w.reps} · 遗忘{' '}
                    {w.lapses}
                  </small>
                </span>
                <span className="word-row-actions">
                  <button
                    disabled={actionKey === w.lexemeKey}
                    onClick={() =>
                      wordAction(w.lexemeKey, () =>
                        client.study.setWordExcluded(
                          detail.planId,
                          w.lexemeKey,
                          !w.excluded,
                        ),
                      )
                    }
                  >
                    {actionKey === w.lexemeKey
                      ? '处理中…'
                      : w.excluded
                        ? '恢复计划'
                        : '排除'}
                  </button>
                  <button
                    disabled={actionKey === w.lexemeKey}
                    onClick={() =>
                      wordAction(w.lexemeKey, () =>
                        client.study.setWordSuspended(
                          w.lexemeKey,
                          !w.suspended,
                        ),
                      )
                    }
                  >
                    {actionKey === w.lexemeKey
                      ? '处理中…'
                      : w.suspended
                        ? '恢复复习'
                        : '暂停复习'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {page && (
          <div className="study-pagination">
            <span>
              {page.total
                ? `${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} / ${page.total}`
                : '0 / 0'}
            </span>
            <button
              disabled={!page.offset || loading}
              onClick={() =>
                load({
                  ...query,
                  offset: Math.max(0, page.offset - page.limit),
                })
              }
            >
              上一页
            </button>
            <button
              disabled={loading || page.offset + page.limit >= page.total}
              onClick={() =>
                load({ ...query, offset: page.offset + page.limit })
              }
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TodayWords({
  sessionId,
  onClose,
  onError,
}: {
  sessionId: string
  onClose(): void
  onError(m: string): void
}) {
  const [offset, setOffset] = useState(0),
    [retry, setRetry] = useState(0),
    [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StudyTodayWordFilter>('all'),
    [page, setPage] = useState<StudyTodayWordPage | null>(null)
  useEffect(() => {
    let active = true
    setPage(null)
    setError(null)
    client.study
      .listTodayWords(sessionId, { filter, offset, limit: 100 })
      .then((value) => {
        if (active) setPage(value)
      })
      .catch((e) => {
        if (active) {
          setError(messageOf(e))
          onError(messageOf(e))
        }
      })
    return () => {
      active = false
    }
  }, [filter, offset, retry, onError, sessionId])
  const filters: Array<[StudyTodayWordFilter, string]> = [
    ['all', '全部'],
    ['new', '新词'],
    ['review', '复习'],
    ['known', '首次认识'],
    ['unknown', '首次不认识'],
    ['too_easy', '太简单'],
  ]
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose)
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="今日学习词表"
        className="today-history"
      >
        <header>
          <div>
            <p className="eyebrow">TODAY'S WORDS</p>
            <h2>今日学习词表</h2>
          </div>
          <button onClick={onClose}>×</button>
        </header>
        <div className="word-filter-row">
          {filters.map(([f, l]) => (
            <button
              className={filter === f ? 'active' : ''}
              onClick={() => {
                setFilter(f)
                setOffset(0)
              }}
              key={f}
            >
              {l}
            </button>
          ))}
        </div>
        {error ? (
          <div role="alert">
            {error}
            <button onClick={() => setRetry((v) => v + 1)}>重试</button>
          </div>
        ) : !page ? (
          <p>正在读取词表…</p>
        ) : null}
        <div className="today-word-list">
          {page?.items.map((w) => (
            <details key={w.itemId}>
              <summary>
                <b>{w.lemma}</b>
                <span>
                  {w.firstAnswer === 'too_easy'
                    ? '太简单'
                    : w.firstAnswer === 'unknown'
                      ? '首次不认识'
                      : w.firstAnswer === 'known'
                        ? '首次认识'
                        : '未作答'}{' '}
                  · 最终
                  {w.finalAnswer === 'too_easy'
                    ? '暂停复习'
                    : w.finalAnswer === 'known'
                      ? '认识'
                      : w.finalAnswer === 'unknown'
                        ? '不认识'
                        : '未完成'}{' '}
                  · {w.attemptCount} 次作答
                </span>
              </summary>
              <p>{w.meanings.join('；') || '暂无释义'}</p>
              <small>
                本次记录：不认识 {w.unknownCount} 次，共确认 {w.attemptCount}{' '}
                次。
              </small>
              {w.context && (
                <blockquote>
                  <small>{w.context.articleTitle}</small>
                  {w.context.sentence}
                </blockquote>
              )}
              {w.examples.map((example) => (
                <blockquote key={example.exampleId}>
                  <small>百度例句</small>
                  {example.text}
                  {example.translationZh && <p>{example.translationZh}</p>}
                </blockquote>
              ))}
            </details>
          ))}
        </div>
        {page && (
          <div className="study-pagination">
            <span>{page.total} 个词</span>
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              上一页
            </button>
            <button
              disabled={offset + 100 >= page.total}
              onClick={() => setOffset(offset + 100)}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function syncLabel(v: string) {
  return (
    (
      {
        ready: '词源已同步',
        pending: '等待同步',
        syncing: '同步中',
        error: '同步失败',
      } as Record<string, string>
    )[v] ?? v
  )
}
function stateLabel(v: string) {
  return (
    (
      {
        unseen: '未学习',
        learning: '学习中',
        consolidating: '巩固中',
        mature: '熟练',
        suspended: '暂停复习',
      } as Record<string, string>
    )[v] ?? v
  )
}
function messageOf(v: unknown) {
  return v instanceof Error
    ? v.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(v)
}
function formatDate(v: string | null) {
  return v ? new Date(v).toLocaleDateString('zh-CN') : '—'
}
function formatTime(v: string) {
  return new Date(v).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60
  return minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}
