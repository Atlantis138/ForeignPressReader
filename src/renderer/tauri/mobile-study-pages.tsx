import { ErrorState } from './mobile-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DictionaryCollection,
  DictionaryExample,
  StudyDashboard,
  StudyDebugState,
  StudyDeletePlanOptions,
  StudyPlanDetail,
  StudyPlanInput,
  StudyPlanStatus,
  StudyPlanWordPage,
  StudyPlanWordQuery,
  StudyPreferences,
  StudySessionState,
  StudySourceSyncResult,
  StudyTodayWordFilter,
  StudyTodayWordPage,
  StudyTooEasyRequest,
  StudyWordFilter,
} from '../../shared/types'
import type { MobileSpeechClient } from '../../shared/mobile-online-services'
import { DictionaryIcon, PlusIcon, SlidersIcon, SpeakerIcon } from '../ui/icons'
import {
  ChoiceChip,
  ContextCard,
  EditorialCard,
  EmptyState,
  MobileButton,
  PageHeader,
  PaginationFooter,
  SearchField,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  StatusPill,
  StudyAnswerActions,
  TopAppBar,
} from './mobile-ui'

export interface MobileStudyUiClient {
  getDashboard(): Promise<StudyDashboard>
  peekDashboard?(): StudyDashboard | undefined
  listPlans(includeArchived?: boolean): Promise<StudyDashboard['plans']>
  createPlan(input: StudyPlanInput): Promise<StudyPlanDetail>
  updatePlan(planId: string, input: StudyPlanInput): Promise<StudyPlanDetail>
  setPlanStatus(planId: string, status: StudyPlanStatus): Promise<void>
  getPlan(planId: string): Promise<StudyPlanDetail>
  listPlanWords(
    planId: string,
    query: StudyPlanWordQuery,
  ): Promise<StudyPlanWordPage>
  setWordExcluded(
    planId: string,
    lexemeKey: string,
    excluded: boolean,
  ): Promise<void>
  setWordSuspended(lexemeKey: string, suspended: boolean): Promise<void>
  listTodayWords(
    sessionId: string,
    query: { filter: StudyTodayWordFilter; offset: number; limit: number },
  ): Promise<StudyTodayWordPage>
  openToday(): Promise<StudySessionState>
  stageAnswer(request: {
    sessionId: string
    itemId: string
    expectedVersion: number
    answer: 'known' | 'unknown'
  }): Promise<StudySessionState>
  commitAnswer(request: {
    sessionId: string
    itemId: string
    commandId: string
    expectedVersion: number
    answer: 'known' | 'unknown'
  }): Promise<StudySessionState>
  markTooEasy(request: StudyTooEasyRequest): Promise<StudySessionState>
  addExtraBatch(planId: string): Promise<StudySessionState>
  syncSources(planId?: string): Promise<StudySourceSyncResult>
  getPreferences(): Promise<StudyPreferences>
  savePreferences(value: StudyPreferences): Promise<StudyPreferences>
  listDictionaryCollections(): Promise<DictionaryCollection[]>
  hydrateCurrentExamples(request: {
    sessionId: string
    itemId: string
    expectedVersion: number
  }): Promise<DictionaryExample[]>
  getDebugState(): Promise<StudyDebugState>
  setDeveloperMode(enabled: boolean): Promise<StudyDebugState>
  deletePlan(
    planId: string,
    confirmationName: string,
    options?: StudyDeletePlanOptions,
  ): Promise<void>
  resetAllProgress(confirmationToken: string): Promise<void>
  forceNextStudyDay(confirmationToken: string): Promise<StudySessionState>
}

const DEFAULT_PLAN: StudyPlanInput = {
  name: '',
  dailyNewLimit: 20,
  dailyReviewLimit: 100,
  sources: [{ type: 'reader_manual', ref: 'favorite' }],
}
const DEFAULT_WORD_QUERY: StudyPlanWordQuery = {
  text: '',
  filter: 'all',
  offset: 0,
  limit: 30,
}
const WORD_FILTERS: ReadonlyArray<[StudyWordFilter, string]> = [
  ['all', '全部'],
  ['due', '今日待复习'],
  ['unseen', '未学习'],
  ['learning', '学习中'],
  ['consolidating', '巩固中'],
  ['mature', '熟练'],
  ['suspended', '暂停复习'],
  ['excluded', '已排除'],
]

export function MobileStudyHome({
  client,
  onSession,
  onCreatePlan,
  onPlan,
  onToday,
  onError,
}: {
  client: MobileStudyUiClient
  onSession(session: StudySessionState): void
  onCreatePlan(): void
  onPlan(planId: string): void
  onToday(sessionId: string): void
  onError(message: string): void
}) {
  const [dashboard, setDashboard] = useState<StudyDashboard | null>(
    () => client.peekDashboard?.() ?? null,
  )
  const [busy, setBusy] = useState(() => !client.peekDashboard?.())
  const reload = useCallback(async () => {
    setBusy(true)
    try {
      setDashboard(await client.getDashboard())
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [client, onError])
  useEffect(() => {
    void reload()
  }, [reload])
  const open = async () => {
    setBusy(true)
    try {
      onSession(await client.openToday())
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  const extra = async (planId: string) => {
    setBusy(true)
    try {
      onSession(await client.addExtraBatch(planId))
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mobile-page study-page">
      <PageHeader
        eyebrow="DAILY STUDY"
        title="背单词"
        description="今天学什么、完成多少、刚才学过什么。"
      />
      {busy && !dashboard ? (
        <Skeleton lines={5} />
      ) : (
        dashboard && (
          <>
            <EditorialCard
              className={`study-today-card ${dashboard.today?.status ?? 'preview'}`}
            >
              <div>
                <p className="mobile-eyebrow">TODAY</p>
                <h2>
                  {dashboard.today?.status === 'completed'
                    ? '今天的学习已完成'
                    : dashboard.today
                      ? '继续今天的学习'
                      : '准备开始今天的学习'}
                </h2>
                <p>
                  {dashboard.today
                    ? `${dashboard.today.completed}/${dashboard.today.total} 已完成 · ${dashboard.today.newCount} 新词 · ${dashboard.today.reviewCount} 复习`
                    : `预计 ${dashboard.preview.reviewCount} 个到期复习 · ${dashboard.preview.newCount} 个新词`}
                </p>
                {dashboard.today?.recentWords.length ? (
                  <div className="study-recent-words">
                    {dashboard.today.recentWords.map((word) => (
                      <span key={word.itemId}>{word.lemma}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="study-today-actions">
                {dashboard.today && (
                  <MobileButton
                    variant="text"
                    onClick={() => onToday(dashboard.today!.sessionId)}
                  >
                    今日词表
                  </MobileButton>
                )}
                {dashboard.today?.status === 'completed' ? (
                  dashboard.plans
                    .filter((plan) => plan.status === 'active')
                    .map((plan) => (
                      <MobileButton
                        key={plan.planId}
                        disabled={!plan.availableNewCount && !plan.dueCount}
                        onClick={() => void extra(plan.planId)}
                      >
                        再学一批 · {plan.name}
                      </MobileButton>
                    ))
                ) : (
                  <MobileButton
                    variant="primary"
                    disabled={
                      busy ||
                      !dashboard.plans.some((plan) => plan.status === 'active')
                    }
                    onClick={() => void open()}
                  >
                    {dashboard.today ? '继续今日学习' : '开始今日学习'}
                  </MobileButton>
                )}
              </div>
            </EditorialCard>
            <SectionHeader
              title="长期计划"
              detail={`${dashboard.plans.filter((plan) => plan.status !== 'archived').length} 个`}
            />
            <div className="study-plan-toolbar">
              <MobileButton variant="primary" onClick={onCreatePlan}>
                <PlusIcon /> 创建计划
              </MobileButton>
            </div>
            <div className="study-plan-grid">
              {dashboard.plans
                .filter((plan) => plan.status !== 'archived')
                .map((plan) => (
                  <button
                    key={plan.planId}
                    className="study-plan-summary-card"
                    onClick={() => onPlan(plan.planId)}
                  >
                    <StatusPill
                      tone={plan.status === 'active' ? 'success' : 'warning'}
                    >
                      {plan.status === 'active' ? '启用中' : '已暂停'}
                    </StatusPill>
                    <h2>{plan.name}</h2>
                    <p>{plan.sourceLabels.join('、') || '尚无词汇来源'}</p>
                    <small>
                      每日 {plan.dailyNewLimit} 新词 / {plan.dailyReviewLimit}{' '}
                      复习
                    </small>
                    <small>
                      {plan.wordCount} 词 · {syncLabel(plan.syncStatus)}
                    </small>
                  </button>
                ))}
            </div>
            {!dashboard.plans.length && (
              <EmptyState
                symbol="学"
                title="创建第一份学习计划"
                description="可以混合“我的生词”和 ECDICT 考试词集。"
                action={
                  <MobileButton variant="primary" onClick={onCreatePlan}>
                    创建计划
                  </MobileButton>
                }
              />
            )}
          </>
        )
      )}
    </div>
  )
}

export function MobileStudyPlanEditor({
  client,
  planId,
  onBack,
  onSaved,
  onError,
}: {
  client: MobileStudyUiClient
  planId?: string
  onBack(): void
  onSaved(planId: string): void
  onError(message: string): void
}) {
  const [value, setValue] = useState(DEFAULT_PLAN)
  const [collections, setCollections] = useState<DictionaryCollection[]>([])
  const [busy, setBusy] = useState(Boolean(planId))
  useEffect(() => {
    let active = true
    Promise.all([
      client.listDictionaryCollections(),
      planId ? client.getPlan(planId) : Promise.resolve(null),
    ])
      .then(([nextCollections, plan]) => {
        if (!active) return
        setCollections(nextCollections)
        if (plan)
          setValue({
            name: plan.name,
            dailyNewLimit: plan.dailyNewLimit,
            dailyReviewLimit: plan.dailyReviewLimit,
            sources: plan.sources
              .filter((source) => source.active)
              .map(({ type, ref }) => ({ type, ref })),
          })
      })
      .catch((reason) => onError(messageOf(reason)))
      .finally(() => active && setBusy(false))
    return () => {
      active = false
    }
  }, [client, onError, planId])
  const hasSource = (type: 'reader_manual' | 'exam_collection', ref: string) =>
    value.sources.some((source) => source.type === type && source.ref === ref)
  const toggleSource = (
    type: 'reader_manual' | 'exam_collection',
    ref: string,
  ) =>
    setValue((current) => ({
      ...current,
      sources: hasSource(type, ref)
        ? current.sources.filter(
            (source) => source.type !== type || source.ref !== ref,
          )
        : [...current.sources, { type, ref }],
    }))
  const save = async () => {
    setBusy(true)
    try {
      const saved = planId
        ? await client.updatePlan(planId, value)
        : await client.createPlan(value)
      await client.syncSources(saved.planId)
      onSaved(saved.planId)
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mobile-page study-editor-page">
      <TopAppBar
        title={planId ? '编辑学习计划' : '创建学习计划'}
        onBack={onBack}
      />
      <PageHeader
        eyebrow="LEARNING PLAN"
        title="学习计划"
        description="计划保存后立即同步本地词源；失败时可从计划详情重试。"
      />
      {busy && planId && !value.name ? (
        <Skeleton lines={5} />
      ) : (
        <form
          className="mobile-plan-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            名称
            <input
              value={value.name}
              maxLength={40}
              onChange={(event) =>
                setValue({ ...value, name: event.target.value })
              }
            />
          </label>
          <div className="mobile-plan-limits">
            <label>
              每日新词
              <input
                type="number"
                min="0"
                max="500"
                value={value.dailyNewLimit}
                onChange={(event) =>
                  setValue({
                    ...value,
                    dailyNewLimit: Number(event.target.value),
                  })
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
                onChange={(event) =>
                  setValue({
                    ...value,
                    dailyReviewLimit: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <fieldset>
            <legend>词汇来源</legend>
            <ChoiceChip
              selected={hasSource('reader_manual', 'favorite')}
              onClick={() => toggleSource('reader_manual', 'favorite')}
            >
              我的生词
            </ChoiceChip>
            {collections.map((collection) => (
              <ChoiceChip
                key={collection.id}
                selected={hasSource('exam_collection', collection.tag)}
                onClick={() => toggleSource('exam_collection', collection.tag)}
              >
                {collection.name}{' '}
                <small>{collection.count.toLocaleString('zh-CN')}</small>
              </ChoiceChip>
            ))}
          </fieldset>
          <div className="mobile-form-actions">
            <MobileButton onClick={onBack}>取消</MobileButton>
            <MobileButton
              type="submit"
              variant="primary"
              disabled={busy || !value.name.trim() || !value.sources.length}
            >
              {busy ? '保存并同步中…' : '保存并同步'}
            </MobileButton>
          </div>
        </form>
      )}
    </div>
  )
}

export function MobileStudyPlanDetail({
  client,
  planId,
  onBack,
  onEdit,
  onError,
  onNotice,
}: {
  client: MobileStudyUiClient
  planId: string
  onBack(): void
  onEdit(): void
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [detail, setDetail] = useState<StudyPlanDetail | null>(null)
  const [query, setQuery] = useState(DEFAULT_WORD_QUERY)
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState<StudyPlanWordPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [debug, setDebug] = useState<StudyDebugState | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteName, setDeleteName] = useState('')
  const [resetWordProgress, setResetWordProgress] = useState(false)
  const sequence = useRef(0)
  const reloadDetail = useCallback(
    async () => setDetail(await client.getPlan(planId)),
    [client, planId],
  )
  const loadWords = useCallback(
    async (next: StudyPlanWordQuery) => {
      const current = ++sequence.current
      setBusy(true)
      try {
        const result = await client.listPlanWords(planId, next)
        if (current === sequence.current) {
          setPage(result)
          setQuery(next)
        }
      } catch (reason) {
        onError(messageOf(reason))
      } finally {
        if (current === sequence.current) setBusy(false)
      }
    },
    [client, onError, planId],
  )
  useEffect(() => {
    setLoadError(null)
    void Promise.all([
      reloadDetail(),
      loadWords(DEFAULT_WORD_QUERY),
      client.getDebugState().then(setDebug),
    ]).catch((reason) => {
      const message = messageOf(reason)
      setLoadError(message)
      onError(message)
    })
  }, [client, loadWords, onError, reloadDetail])
  const changeStatus = async (status: StudyPlanStatus) => {
    try {
      await client.setPlanStatus(planId, status)
      await reloadDetail()
    } catch (reason) {
      onError(messageOf(reason))
    }
  }
  const mutateWord = async (lexemeKey: string, task: () => Promise<void>) => {
    try {
      await task()
      await Promise.all([reloadDetail(), loadWords(query)])
    } catch (reason) {
      onError(messageOf(reason))
    }
  }
  const deleteCurrentPlan = async () => {
    if (!detail) return
    setBusy(true)
    try {
      await client.deletePlan(planId, deleteName, { resetWordProgress })
      onNotice(
        resetWordProgress
          ? '计划已删除，相关词的学习进度也已重置。'
          : '计划已删除，已有学习进度已保留。',
      )
      onBack()
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mobile-page study-plan-detail-page">
      <TopAppBar title="计划详情" onBack={onBack} />
      {!detail && loadError ? (
        <EmptyState
          symbol="!"
          title="计划已不可用"
          description="它可能已在另一台设备删除，或学习数据刚刚发生变化。"
          action={<MobileButton onClick={onBack}>返回学习计划</MobileButton>}
        />
      ) : !detail ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <PageHeader
            eyebrow="DAILY STUDY"
            title={detail.name}
            description="查看熟练度、复习安排与计划词表。"
          />
          <p className="mobile-study-plan-summary">
            {detail.sourceLabels.join('、') || '尚未选择词源'} · 每日{' '}
            {detail.dailyNewLimit} 新词 / {detail.dailyReviewLimit} 复习 ·{' '}
            {syncLabel(detail.syncStatus)}
          </p>
          <EditorialCard className="study-plan-insights">
            <div className="study-plan-status">
              <StatusPill
                tone={
                  detail.syncStatus === 'ready'
                    ? 'success'
                    : detail.syncStatus === 'error'
                      ? 'danger'
                      : 'warning'
                }
              >
                {syncLabel(detail.syncStatus)}
              </StatusPill>
              <span>
                <b>{detail.wordCount} 词</b>
                <small>
                  {detail.dueCount} 到期 · {detail.availableNewCount} 可学新词 ·{' '}
                  {detail.excludedCount} 已排除
                </small>
              </span>
            </div>
            <div className="study-plan-distribution">
              <MobileDistributionDonut
                distribution={detail.distribution}
                active={query.filter}
                onSelect={(filter) =>
                  void loadWords({ ...query, filter, offset: 0 })
                }
              />
              <div className="study-distribution-legend">
                {WORD_FILTERS.filter(
                  ([filter]) => !['all', 'due', 'excluded'].includes(filter),
                ).map(([filter, label]) => (
                  <button
                    className={query.filter === filter ? 'active' : ''}
                    key={filter}
                    onClick={() =>
                      void loadWords({ ...query, filter, offset: 0 })
                    }
                  >
                    <i className={filter} />
                    <span>{label}</span>
                    <b>
                      {
                        detail.distribution[
                          filter as keyof typeof detail.distribution
                        ]
                      }
                    </b>
                  </button>
                ))}
              </div>
            </div>
          </EditorialCard>
          <div className="study-plan-actions">
            <MobileButton onClick={onEdit}>编辑设置</MobileButton>
            <MobileButton
              onClick={() =>
                void changeStatus(
                  detail.status === 'active' ? 'paused' : 'active',
                )
              }
            >
              {detail.status === 'active' ? '暂停' : '启用'}
            </MobileButton>
            {detail.status !== 'archived' && (
              <MobileButton onClick={() => void changeStatus('archived')}>
                归档
              </MobileButton>
            )}
            {detail.syncStatus === 'error' && (
              <MobileButton
                variant="text"
                onClick={() =>
                  void client
                    .syncSources(planId)
                    .then(reloadDetail)
                    .catch((reason) => onError(messageOf(reason)))
                }
              >
                重试词源同步
              </MobileButton>
            )}
          </div>
          <SectionHeader
            title="计划词表"
            detail={page ? `${page.total} 词` : undefined}
          />
          <div className="mobile-chip-row study-word-filters">
            {WORD_FILTERS.map(([filter, label]) => (
              <ChoiceChip
                key={filter}
                selected={query.filter === filter}
                onClick={() => void loadWords({ ...query, filter, offset: 0 })}
              >
                {label}
              </ChoiceChip>
            ))}
          </div>
          <div className="study-word-toolbar">
            <SearchField
              value={draft}
              onChange={setDraft}
              onSubmit={() =>
                void loadWords({ ...query, text: draft.trim(), offset: 0 })
              }
              placeholder="搜索英文词头或中文释义"
            />
          </div>
          {busy ? (
            <Skeleton lines={5} />
          ) : (
            <div className="mobile-plan-word-list">
              {page?.items.map((word) => (
                <article key={word.lexemeKey}>
                  <header>
                    <span>
                      <b>{word.lemma}</b>
                      <small>{word.meanings.join('；') || '暂无释义'}</small>
                    </span>
                    <StatusPill tone={word.suspended ? 'warning' : 'neutral'}>
                      {stateLabel(word.state)}
                    </StatusPill>
                  </header>
                  <p>
                    D {formatNumber(word.difficulty)} · S{' '}
                    {formatNumber(word.stability)} · R{' '}
                    {word.retrievability == null
                      ? '—'
                      : `${Math.round(word.retrievability * 100)}%`}
                  </p>
                  <small>
                    due {formatDate(word.dueAt)} · 复习 {word.reps} · 遗忘{' '}
                    {word.lapses}
                  </small>
                  <footer>
                    <MobileButton
                      variant="text"
                      onClick={() =>
                        void mutateWord(word.lexemeKey, () =>
                          client.setWordExcluded(
                            planId,
                            word.lexemeKey,
                            !word.excluded,
                          ),
                        )
                      }
                    >
                      {word.excluded ? '恢复计划' : '排除'}
                    </MobileButton>
                    <MobileButton
                      variant="text"
                      onClick={() =>
                        void mutateWord(word.lexemeKey, () =>
                          client.setWordSuspended(
                            word.lexemeKey,
                            !word.suspended,
                          ),
                        )
                      }
                    >
                      {word.suspended ? '恢复复习' : '暂停复习'}
                    </MobileButton>
                  </footer>
                </article>
              ))}
            </div>
          )}
          {page && (
            <PaginationFooter
              offset={page.offset}
              limit={page.limit}
              total={page.total}
              onPrevious={() =>
                void loadWords({
                  ...query,
                  offset: Math.max(0, page.offset - page.limit),
                })
              }
              onNext={() =>
                void loadWords({ ...query, offset: page.offset + page.limit })
              }
            />
          )}
          {
            <EditorialCard className="mobile-danger-zone">
              <h2>删除计划</h2>
              <p>
                删除会停止来源并移出未完成队列；默认保留已经形成的 FSRS 进度。
              </p>
              {!deleteOpen ? (
                <MobileButton
                  variant="text"
                  onClick={() => setDeleteOpen(true)}
                >
                  删除此计划
                </MobileButton>
              ) : (
                <>
                  <label>
                    输入计划名称“{detail.name}”确认
                    <input
                      value={deleteName}
                      disabled={busy}
                      autoComplete="off"
                      onChange={(event) => setDeleteName(event.target.value)}
                    />
                  </label>
                  {debug?.enabled && (
                    <label className="mobile-toggle-row">
                      <input
                        type="checkbox"
                        checked={resetWordProgress}
                        disabled={busy}
                        onChange={(event) =>
                          setResetWordProgress(event.target.checked)
                        }
                      />
                      <span>
                        <b>同时重置相关词进度</b>
                        <small>
                          会删除这些词的复习卡、事件、暂停状态和队列项。
                        </small>
                      </span>
                    </label>
                  )}
                  <div className="mobile-service-actions">
                    <MobileButton
                      variant="text"
                      disabled={busy}
                      onClick={() => {
                        setDeleteOpen(false)
                        setDeleteName('')
                        setResetWordProgress(false)
                      }}
                    >
                      取消
                    </MobileButton>
                    <MobileButton
                      disabled={busy || deleteName !== detail.name}
                      onClick={() => void deleteCurrentPlan()}
                    >
                      确认删除计划
                    </MobileButton>
                  </div>
                </>
              )}
            </EditorialCard>
          }
        </>
      )}
    </div>
  )
}

function MobileDistributionDonut({
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
  ]
  const total = values.reduce((sum, [, value]) => sum + value, 0)
  const scale = total || 1
  let offset = 0
  return (
    <div className="mobile-distribution-donut">
      <svg viewBox="0 0 42 42" aria-label="计划熟练度分布">
        {values.map(([filter, value, color]) => {
          const length = (value / scale) * 100
          const start = offset
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
        <b>{total}</b>
        <small>总词数</small>
      </span>
    </div>
  )
}

export function MobileTodayWords({
  client,
  sessionId,
  onBack,
  onLexeme,
  onError,
}: {
  client: MobileStudyUiClient
  sessionId: string
  onBack(): void
  onLexeme(lexemeKey: string): void
  onError(message: string): void
}) {
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StudyTodayWordFilter>('all')
  const [page, setPage] = useState<StudyTodayWordPage | null>(null)
  const filters: ReadonlyArray<[StudyTodayWordFilter, string]> = [
    ['all', '全部'],
    ['new', '新词'],
    ['review', '复习'],
    ['known', '首次认识'],
    ['unknown', '首次不认识'],
    ['too_easy', '太简单'],
  ]
  useEffect(() => {
    let active = true
    setPage(null)
    setError(null)
    void client
      .listTodayWords(sessionId, { filter, offset, limit: 100 })
      .then((value) => {
        if (active) setPage(value)
      })
      .catch((reason) => {
        if (active) {
          setError(messageOf(reason))
          onError(messageOf(reason))
        }
      })
    return () => {
      active = false
    }
  }, [client, filter, offset, retry, onError, sessionId])
  return (
    <div className="mobile-page study-today-words-page">
      <TopAppBar title="今日学习词表" onBack={onBack} />
      <PageHeader
        eyebrow="TODAY'S WORDS"
        title="刚才学过什么"
        description="复习包含跨日结转；首次判断与最终答案分别记录。"
      />
      <div className="mobile-chip-row">
        {filters.map(([value, label]) => (
          <ChoiceChip
            key={value}
            selected={filter === value}
            onClick={() => {
              setFilter(value)
              setOffset(0)
            }}
          >
            {label}
          </ChoiceChip>
        ))}
      </div>
      {error ? (
        <ErrorState
          description={error}
          onRetry={() => setRetry((v) => v + 1)}
        />
      ) : !page ? (
        <Skeleton lines={5} />
      ) : (
        <div className="study-today-word-list">
          {page.items.map((word) => (
            <article key={word.itemId}>
              <button onClick={() => onLexeme(word.lexemeKey)}>
                <b>{word.lemma}</b>
                <span>
                  {answerLabel(word.firstAnswer)} · 最终{' '}
                  {answerLabel(word.finalAnswer)} · {word.attemptCount} 次
                </span>
                <small>{word.meanings.join('；') || '暂无释义'}</small>
              </button>
              {word.context && (
                <ContextCard
                  title={word.context.articleTitle}
                  sentence={word.context.sentence}
                />
              )}
              {word.examples.map((example, index) => (
                <ContextCard
                  key={example.exampleId}
                  title={
                    example.definition ??
                    example.partOfSpeech ??
                    `例句 ${index + 1}`
                  }
                  sentence={example.text}
                  translation={example.translationZh}
                />
              ))}
            </article>
          ))}
        </div>
      )}
      {page && (
        <PaginationFooter
          offset={offset}
          limit={100}
          total={page.total}
          onPrevious={() => setOffset(Math.max(0, offset - 100))}
          onNext={() => setOffset(offset + 100)}
        />
      )}
    </div>
  )
}

export function MobileStudySession({
  client,
  speech,
  session,
  onSession,
  onBack,
  onOpenLexeme,
  onError,
  onNotice,
}: {
  client: MobileStudyUiClient
  speech: MobileSpeechClient
  session: StudySessionState
  onSession(session: StudySessionState): void
  onBack(): void
  onOpenLexeme(lexemeKey: string): void
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<{
    lexemeKey: string
    expiresAt: number
  } | null>(null)
  const [examples, setExamples] = useState<DictionaryExample[]>(
    session.current?.examples ?? [],
  )
  const autoPlayed = useRef(new Set<string>())
  const hydratedExamples = useRef(new Set<string>())
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(
      () => setUndo(null),
      Math.max(0, undo.expiresAt - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [undo])
  const run = async (task: () => Promise<StudySessionState>) => {
    setBusy(true)
    try {
      onSession(await task())
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  const current = session.current
  useEffect(() => {
    let active = true
    setExamples(current?.examples ?? [])
    if (
      !current?.revealed ||
      current.examples.length ||
      hydratedExamples.current.has(`${current.itemId}:${current.version}`)
    )
      return
    hydratedExamples.current.add(`${current.itemId}:${current.version}`)
    void client
      .hydrateCurrentExamples({
        sessionId: session.sessionId,
        itemId: current.itemId,
        expectedVersion: current.version,
      })
      .then((value) => {
        if (active) setExamples(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [
    client,
    current?.examples,
    current?.itemId,
    current?.revealed,
    current?.version,
    session.sessionId,
  ])
  const speakCurrent = useCallback(async () => {
    if (!current) return
    const settings = await speech.getSettings()
    const providerId = settings.preferences.wordProviderId
    const providerSetting = settings.preferences.providerSettings[providerId]
    await speech.play({
      providerId,
      modelId: providerSetting?.modelId ?? 'system',
      voiceId: providerSetting?.voiceId ?? settings.preferences.voiceId ?? '',
      text: current.lemma,
      locale: settings.preferences.locale,
      rate: settings.preferences.rate,
      sourceId: session.sessionId,
      itemId: current.itemId,
      usage: 'word',
    })
  }, [current, session.sessionId, speech])
  useEffect(() => {
    if (
      !current ||
      current.kind !== 'new' ||
      current.revealed ||
      autoPlayed.current.has(current.itemId)
    )
      return
    autoPlayed.current.add(current.itemId)
    void speech
      .getSettings()
      .then((settings) =>
        settings.preferences.autoPlayStudy ? speakCurrent() : undefined,
      )
      .catch((reason) => onError(messageOf(reason)))
  }, [current, onError, speakCurrent, speech])
  useEffect(
    () => () => {
      void speech.stop().catch(() => undefined)
    },
    [speech],
  )
  const stage = (answer: 'known' | 'unknown') =>
    current &&
    run(() =>
      client.stageAnswer({
        sessionId: session.sessionId,
        itemId: current.itemId,
        expectedVersion: current.version,
        answer,
      }),
    )
  const commit = (answer: 'known' | 'unknown') =>
    current &&
    run(() =>
      client.commitAnswer({
        sessionId: session.sessionId,
        itemId: current.itemId,
        expectedVersion: current.version,
        commandId: crypto.randomUUID(),
        answer,
      }),
    )
  const tooEasy = async () => {
    if (!current) return
    setBusy(true)
    try {
      const next = await client.markTooEasy({
        sessionId: session.sessionId,
        itemId: current.itemId,
        expectedVersion: current.version,
        commandId: crypto.randomUUID(),
      })
      onSession(next)
      setUndo({ lexemeKey: current.lexemeKey, expiresAt: Date.now() + 6000 })
      onNotice(`${current.lemma} 已暂停复习，6 秒内可撤销。`)
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  const undoTooEasy = async () => {
    if (!undo) return
    try {
      await client.setWordSuspended(undo.lexemeKey, false)
      setUndo(null)
      onNotice('已恢复该词复习。')
    } catch (reason) {
      onError(messageOf(reason))
    }
  }
  return (
    <div className="mobile-page study-session-page">
      <TopAppBar
        title="今日学习"
        eyebrow={`${session.completed}/${session.total}`}
        onBack={onBack}
        action={
          undo && (
            <MobileButton variant="text" onClick={() => void undoTooEasy()}>
              撤销太简单
            </MobileButton>
          )
        }
      />
      {!current ? (
        <EmptyState
          symbol="✓"
          title={session.total ? '今日完成' : '当前没有待学词'}
          description={`${session.logicalDate} · 已完成 ${session.completed}/${session.total}`}
          action={<MobileButton onClick={onBack}>返回学习首页</MobileButton>}
        />
      ) : (
        <section className="study-card" aria-busy={busy}>
          <div className="study-session-progress">
            <i
              style={{
                width: `${Math.max(4, ((session.completed + 1) / Math.max(1, session.total)) * 100)}%`,
              }}
            />
            <span>
              {session.completed + 1} / {session.total}
            </span>
          </div>
          <header>
            <small>
              {current.revealed
                ? current.hadFailure
                  ? `强化确认 · 连续认识 ${current.consecutiveKnown}/2`
                  : '确认本次判断'
                : '你认识这个词吗？'}
            </small>
            <h1>{current.lemma}</h1>
            {current.phonetic && <p>/{current.phonetic}/</p>}
            <MobileButton
              variant="text"
              onClick={() =>
                void speakCurrent().catch((reason) =>
                  onError(messageOf(reason)),
                )
              }
            >
              <SpeakerIcon /> 朗读
            </MobileButton>
          </header>
          {current.revealed ? (
            <>
              <div className="study-answer">
                <p>{current.briefMeanings.join('；')}</p>
                {current.senseGroups.map((group) => (
                  <p key={group.partOfSpeech}>
                    <b>{group.partOfSpeech}</b> {group.translations.join('；')}
                  </p>
                ))}
                {current.context && (
                  <ContextCard
                    title={current.context.articleTitle}
                    sentence={current.context.sentence}
                  />
                )}
                {examples.map((example, index) => (
                  <ContextCard
                    key={example.exampleId}
                    title={
                      example.definition ??
                      example.partOfSpeech ??
                      `学习例句 ${index + 1}`
                    }
                    sentence={example.text}
                    translation={example.translationZh}
                  />
                ))}
                <MobileButton
                  variant="text"
                  onClick={() => onOpenLexeme(current.lexemeKey)}
                >
                  <DictionaryIcon /> 查看词典详情
                </MobileButton>
              </div>
              <div className="study-actions">
                {current.proposedAnswer === 'known' && (
                  <MobileButton
                    variant="primary"
                    disabled={busy}
                    onClick={() => void commit('known')}
                  >
                    确认认识
                  </MobileButton>
                )}
                <MobileButton
                  disabled={busy}
                  onClick={() => void commit('unknown')}
                >
                  {current.proposedAnswer === 'known'
                    ? '其实不认识'
                    : '确认不认识'}
                </MobileButton>
              </div>
            </>
          ) : (
            <>
              <StudyAnswerActions
                busy={busy}
                onKnown={() => void stage('known')}
                onUnknown={() => void stage('unknown')}
              />
              {current.canMarkTooEasy && (
                <MobileButton
                  className="study-too-easy"
                  variant="text"
                  disabled={busy}
                  onClick={() => void tooEasy()}
                >
                  太简单，暂停复习
                </MobileButton>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

export function MobileStudySettings({
  client,
  onError,
  onNotice,
}: {
  client: MobileStudyUiClient
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saved, setSaved] = useState<StudyPreferences | null>(null)
  const [draft, setDraft] = useState<StudyPreferences | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    setLoadError(null)
    void client
      .getPreferences()
      .then((value) => {
        setSaved(value)
        setDraft(value)
      })
      .catch((reason) => {
        setLoadError(messageOf(reason))
        onError(messageOf(reason))
      })
      .finally(() => setBusy(false))
  }, [client, onError, retry])
  const dirty = useMemo(
    () => JSON.stringify(saved) !== JSON.stringify(draft),
    [draft, saved],
  )
  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const value = await client.savePreferences(draft)
      setSaved(value)
      setDraft(value)
      onNotice('学习设置已保存，将从下一批任务开始生效。')
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  if (!draft)
    return loadError ? (
      <ErrorState
        description={loadError}
        onRetry={() => setRetry((v) => v + 1)}
      />
    ) : (
      <Skeleton lines={5} />
    )
  return (
    <div className="study-settings">
      <h2>今日队列</h2>
      <p>常用设置只保留队列顺序；学习日和 FSRS 参数放在高级设置中。</p>
      <SegmentedControl
        value={draft.queueOrder}
        label="今日队列顺序"
        items={[
          { value: 'mixed', label: '混合' },
          { value: 'review_first', label: '复习优先' },
          { value: 'new_first', label: '新词优先' },
        ]}
        onChange={(queueOrder) => setDraft({ ...draft, queueOrder })}
      />
      <button
        className="study-advanced-toggle"
        onClick={() => setAdvanced((value) => !value)}
      >
        <SlidersIcon />
        <span>
          <b>高级设置</b>
          <small>下一批任务生效</small>
        </span>
      </button>
      {advanced && (
        <div className="study-advanced-settings">
          <label>
            学习日切点 <b>{draft.cutoffHour}:00</b>
            <input
              type="range"
              min="0"
              max="23"
              value={draft.cutoffHour}
              onChange={(event) =>
                setDraft({ ...draft, cutoffHour: Number(event.target.value) })
              }
            />
          </label>
          <label>
            目标记忆率 <b>{Math.round(draft.requestRetention * 100)}%</b>
            <input
              type="range"
              min="0.8"
              max="0.95"
              step="0.01"
              value={draft.requestRetention}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  requestRetention: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            最长间隔{' '}
            <input
              type="number"
              min="30"
              max="36500"
              value={draft.maximumInterval}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  maximumInterval: Number(event.target.value),
                })
              }
            />{' '}
            天
          </label>
        </div>
      )}
      <div className="mobile-form-actions">
        <MobileButton
          disabled={!dirty || busy}
          onClick={() => saved && setDraft(saved)}
        >
          撤销改动
        </MobileButton>
        <MobileButton
          variant="primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          保存学习设置
        </MobileButton>
      </div>
    </div>
  )
}

function syncLabel(value: string) {
  return (
    (
      {
        ready: '词源已同步',
        pending: '等待同步',
        syncing: '同步中',
        error: '同步失败',
      } as Record<string, string>
    )[value] ?? value
  )
}
function stateLabel(value: string) {
  return (
    (
      {
        unseen: '未学习',
        learning: '学习中',
        consolidating: '巩固中',
        mature: '熟练',
        suspended: '暂停复习',
      } as Record<string, string>
    )[value] ?? value
  )
}
function answerLabel(value: 'known' | 'unknown' | 'too_easy' | null) {
  return value === 'known'
    ? '认识'
    : value === 'unknown'
      ? '不认识'
      : value === 'too_easy'
        ? '太简单'
        : '未作答'
}
function formatNumber(value: number | null) {
  return value == null ? '—' : value.toFixed(2)
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '—'
}
function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
