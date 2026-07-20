import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  DeveloperState,
  PortableImportPreview,
  ReaderPreferences,
  SpeechPreferences,
  SpeechSettings,
  StorageReport,
  TranslationSettings,
} from '../../shared/types'
import { SyncSettingsPanel } from '../sync-settings'
import {
  AppearanceIcon,
  ChevronRightIcon,
  DatabaseIcon,
  DictionaryIcon,
  SettingsIcon,
  SpeakerIcon,
  StudyIcon,
  TranslateIcon,
} from '../ui/icons'
import { READER_COLUMN_PRESETS, readerColumnPreset, readerColumnValue } from './mobile-appearance-model'
import type { MobileAppClient } from './mobile-app-client'
import { MobileDictionarySettings } from './mobile-dictionary-pages'
import type { MobileSettingsSection } from './mobile-shell-model'
import { MobileStudySettings } from './mobile-study-pages'
import {
  ConfirmDialog,
  EditorialCard,
  MobileButton,
  PageHeader,
  SegmentedControl,
  Skeleton,
  StatusPill,
  TopAppBar,
  type MobileTask,
} from './mobile-ui'

export const DEFAULT_MOBILE_READER_PREFERENCES: ReaderPreferences = {
  theme: 'light', fontSize: 20, lineHeight: 1.8, columnWidth: 760, paperTint: 58,
}

export function MobileSettingsHome({
  preferences,
  developerVisible,
  onTitleTap,
  onOpen,
}: {
  preferences: ReaderPreferences
  developerVisible: boolean
  onTitleTap(): void
  onOpen(section: MobileSettingsSection): void
}) {
  const appearanceSummary = `${preferences.theme === 'light' ? '浅色' : '深色'} · ${preferences.fontSize}px · 行距 ${preferences.lineHeight.toFixed(1)}`
  return <div className="mobile-page settings-page">
    <PageHeader eyebrow="PREFERENCES" title={<button className="settings-title-unlock" aria-label="设置" onClick={onTitleTap}>设置</button>} description="集中管理阅读、学习与本机服务。" />
    <div className="settings-group">
      <SettingsRow icon={<AppearanceIcon />} title="阅读外观" detail={appearanceSummary} onClick={() => onOpen('appearance')} />
      <SettingsRow icon={<TranslateIcon />} title="翻译服务" detail="DeepSeek、OpenAI、Kimi · 译文离线缓存" status="可用" onClick={() => onOpen('translation')} />
      <SettingsRow icon={<DictionaryIcon />} title="词典服务" detail="本地 ECDICT · 百度增强 · AI 文中义" onClick={() => onOpen('dictionary')} />
      <SettingsRow icon={<SpeakerIcon />} title="语音服务" detail="系统、Google 与 MiniMax 朗读" status="可用" onClick={() => onOpen('speech')} />
      <SettingsRow icon={<StudyIcon />} title="每日学习" detail="队列顺序、学习日与 FSRS 参数" status="可用" onClick={() => onOpen('study')} />
      <SettingsRow icon={<DatabaseIcon />} title="数据与存储" detail="本地优先 · formal-v1" onClick={() => onOpen('data')} />
      {developerVisible && <SettingsRow icon={<SettingsIcon />} title="开发与调试" detail="学习调试、脱敏日志与恢复应用" onClick={() => onOpen('developer')} />}
    </div>
  </div>
}

function SettingsRow({ icon, title, detail, status, onClick }: { icon: ReactNode; title: string; detail: string; status?: string; onClick(): void }) {
  return <button className="settings-row" onClick={onClick}><span className="settings-row-icon">{icon}</span><span><b>{title}</b><small>{detail}</small></span>{status && <em>{status}</em>}<ChevronRightIcon /></button>
}

export function MobileSettingsSectionPage({
  clients,
  section,
  preferences,
  onBack,
  onOpen,
  onChange,
  onError,
  onNotice,
  onTask,
}: {
  clients: MobileAppClient
  section: MobileSettingsSection
  preferences: ReaderPreferences
  onBack(): void
  onOpen(section: MobileSettingsSection): void
  onChange(value: ReaderPreferences): void
  onError(message: string): void
  onNotice(message: string): void
  onTask(task: MobileTask | null): void
}) {
  if (section === 'appearance') return <MobileAppearanceSettings preferences={preferences} onBack={onBack} onChange={onChange} />
  const content = SETTINGS_SECTION_CONTENT[section]
  return <div className="mobile-page settings-section-page">
    <TopAppBar title={content.title} onBack={onBack} />
    <PageHeader eyebrow={content.eyebrow} title={content.heading} description={content.description} />
    {section === 'translation'
      ? <MobileTranslationSettings client={clients.settings.translation} onError={onError} onNotice={onNotice} />
      : section === 'dictionary'
        ? <MobileDictionarySettings client={clients.dictionary} onError={onError} onNotice={onNotice} onTask={onTask} />
        : section === 'speech'
          ? <MobileSpeechSettings client={clients.speech} onError={onError} onNotice={onNotice} />
          : section === 'study'
            ? <MobileStudySettings client={clients.study} onError={onError} onNotice={onNotice} />
            : section === 'data'
              ? <MobileDataSettings clients={clients} onOpenSync={() => onOpen('sync')} onError={onError} onNotice={onNotice} onTask={onTask} />
              : section === 'sync'
                ? <SyncSettingsPanel api={clients.sync} compact onError={onError} />
                : section === 'developer'
                  ? <MobileDeveloperSettings clients={clients} onError={onError} onNotice={onNotice} />
                  : <SettingsCapabilityCard section={section} />}
  </div>
}

const SETTINGS_SECTION_CONTENT: Record<Exclude<MobileSettingsSection, 'appearance'>, { title: string; eyebrow: string; heading: string; description: string }> = {
  translation: { title: '翻译服务', eyebrow: 'TRANSLATION', heading: '模型翻译', description: '选择供应商与模型；每家供应商的密钥独立保存在 Android Keystore。' },
  dictionary: { title: '词典服务', eyebrow: 'DICTIONARY', heading: '本地与在线词典', description: 'ECDICT 保持离线底座，可按需使用百度增强释义与例句。' },
  speech: { title: '语音服务', eyebrow: 'SPEECH', heading: '单词与文章朗读', description: '分别选择系统、Google 或 MiniMax；远程服务密钥保存在 Android Keystore。' },
  study: { title: '每日学习', eyebrow: 'DAILY STUDY', heading: '每日学习', description: '选择今日队列顺序；学习日和 FSRS 参数在高级设置中。' },
  data: { title: '数据与存储', eyebrow: 'LOCAL DATA', heading: '数据与存储', description: '管理便携备份、空间占用与设备上的正式数据。' },
  sync: { title: '跨设备同步', eyebrow: 'LOCAL SYNC', heading: '跨设备同步', description: '在同一局域网内发现另一台设备，配对后由当前设备定向发送增量变化。' },
  developer: { title: '开发与调试', eyebrow: 'DEVELOPER', heading: '开发与调试', description: '用于验证调度、收集脱敏日志和恢复应用；破坏性操作不会进入便携备份。' },
}

function MobileTranslationSettings({
  client,
  onError,
  onNotice,
}: {
  client: MobileAppClient['settings']['translation']
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [settings, setSettings] = useState<TranslationSettings | null>(null)
  const [providerId, setProviderId] = useState('deepseek')
  const [modelId, setModelId] = useState('deepseek-v4-flash')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const next = await client.getSettings()
    setSettings(next)
    setProviderId(next.preferences.providerId)
    setModelId(next.preferences.modelId)
  }, [client])
  useEffect(() => { void load().catch((reason) => onError(messageOf(reason))) }, [load, onError])
  const provider = settings?.providers.find((item) => item.id === providerId) ?? settings?.providers[0]
  const commit = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await action(); await load(); onNotice(success) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  if (!settings || !provider) return <Skeleton lines={6} />
  return <div className="mobile-service-settings">
    <EditorialCard className="mobile-service-card">
      <div className="mobile-service-heading"><div><h2>模型选择</h2><p>文章翻译、文中义和例句翻译共用当前模型。</p></div><StatusPill tone={provider.keyStatus.configured ? 'success' : 'warning'}>{provider.keyStatus.configured ? '已配置' : '未配置'}</StatusPill></div>
      <label>模型供应商<select value={providerId} disabled={busy} onChange={(event) => {
        const next = settings.providers.find((item) => item.id === event.target.value)!
        setProviderId(next.id); setModelId(next.models[0].id)
      }}>{settings.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>翻译模型<select value={modelId} disabled={busy} onChange={(event) => setModelId(event.target.value)}>{provider.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <p className="settings-help">{provider.models.find((model) => model.id === modelId)?.description}</p>
      <MobileButton variant="primary" disabled={busy} onClick={() => void commit(
        () => client.savePreferences({ providerId, modelId }),
        '模型选择已保存。',
      )}>保存模型选择</MobileButton>
    </EditorialCard>
    <EditorialCard className="mobile-service-card">
      <div className="mobile-service-heading"><div><h2>{provider.name} API Key</h2><p>保存前会执行一次极小的真实结构化请求，因此会产生极少量用量。</p></div>{provider.keyStatus.masked && <code>{provider.keyStatus.masked}</code>}</div>
      <label>新密钥<input type="password" autoComplete="off" value={key} disabled={busy} placeholder="输入新密钥以替换" onChange={(event) => setKey(event.target.value)} /></label>
      <div className="mobile-service-actions">
        <MobileButton variant="primary" disabled={busy || key.trim().length < 16} onClick={() => void commit(async () => {
          const result = await client.saveApiKey(providerId, modelId, key)
          if (!result.ok) throw new Error(result.message)
          setKey('')
        }, '密钥已验证并安全保存。')}>保存并测试</MobileButton>
        <MobileButton disabled={busy || !provider.keyStatus.configured} onClick={() => void commit(async () => {
          const result = await client.testConnection()
          if (!result.ok) throw new Error(result.message)
          onNotice(result.message)
        }, '连接测试完成。')}>测试所选模型</MobileButton>
        {provider.keyStatus.configured && <MobileButton variant="text" disabled={busy} onClick={() => void commit(
          () => client.deleteApiKey(providerId),
          '密钥已删除。',
        )}>删除密钥</MobileButton>}
      </div>
    </EditorialCard>
  </div>
}

function MobileSpeechSettings({
  client,
  onError,
  onNotice,
}: {
  client: MobileAppClient['speech']
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [settings, setSettings] = useState<SpeechSettings | null>(null)
  const [draft, setDraft] = useState<SpeechPreferences | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({ google: '', minimax: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const next = await client.getSettings()
    setSettings(next)
    setDraft(next.preferences)
  }, [client])
  useEffect(() => { void load().catch((reason) => onError(messageOf(reason))) }, [load, onError])
  const commit = async (action: () => Promise<unknown>, notice: string) => {
    setBusy(true)
    try { await action(); await load(); onNotice(notice) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const updateProviderSetting = (providerId: string, field: 'modelId' | 'voiceId', value: string) => setDraft((current) => current ? ({
    ...current,
    providerSettings: {
      ...current.providerSettings,
      [providerId]: { ...current.providerSettings[providerId], [field]: value },
    },
  }) : current)
  const updateLocale = (locale: SpeechPreferences['locale']) => setDraft((current) => {
    if (!current) return current
    const providerSettings = { ...current.providerSettings }
    for (const provider of settings?.providers ?? []) {
      if (!provider.requiresApiKey) continue
      const voices = provider.voices.filter((voice) => voice.locales.includes(locale))
      const selected = providerSettings[provider.id]
      if (selected && !voices.some((voice) => voice.id === selected.voiceId) && voices[0]) {
        providerSettings[provider.id] = { ...selected, voiceId: voices[0].id }
      }
    }
    return { ...current, locale, providerSettings }
  })
  const preview = async (usage: 'word' | 'article') => {
    if (!settings || !draft) return
    const providerId = usage === 'word' ? draft.wordProviderId : draft.articleProviderId
    const providerSetting = draft.providerSettings[providerId]
    setBusy(true)
    try {
      await client.stop().catch(() => undefined)
      await client.play({
        providerId,
        modelId: providerSetting?.modelId ?? 'system',
        voiceId: providerSetting?.voiceId ?? draft.voiceId ?? '',
        locale: draft.locale,
        rate: draft.rate,
        text: usage === 'word' ? 'serendipity' : 'A clear voice keeps the reader close to the argument.',
        sourceId: 'speech-settings-preview',
        itemId: usage,
        usage,
      })
      onNotice(usage === 'word' ? '单词试听完成。' : '文章试听完成。')
    } catch (reason) { onError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  if (!settings || !draft) return <Skeleton lines={9} />
  return <div className="mobile-service-settings mobile-speech-settings">
    <EditorialCard className="mobile-service-card">
      <div className="mobile-service-heading"><div><h2>朗读偏好</h2><p>单词使用短暂音频焦点；文章朗读在锁屏、回到桌面或退出阅读器时停止。</p></div><StatusPill tone="success">已接入</StatusPill></div>
      <label>单词与词条发音<select disabled={busy} value={draft.wordProviderId} onChange={(event) => setDraft({ ...draft, wordProviderId: event.target.value })}>{settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <label>文章与段落朗读<select disabled={busy} value={draft.articleProviderId} onChange={(event) => setDraft({ ...draft, articleProviderId: event.target.value })}>{settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <div className="mobile-service-grid"><label>英语地区<select disabled={busy} value={draft.locale} onChange={(event) => updateLocale(event.target.value as SpeechPreferences['locale'])}><option value="en-US">美式英语（en-US）</option><option value="en-GB">英式英语（en-GB）</option></select></label><label>朗读速度 <b>{draft.rate.toFixed(1)}×</b><input type="range" min="0.5" max="2" step="0.1" disabled={busy} value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: Number(event.target.value) })} /></label></div>
      <label className="mobile-toggle-row"><input type="checkbox" checked={draft.autoPlayStudy} disabled={busy} onChange={(event) => setDraft({ ...draft, autoPlayStudy: event.target.checked })} /><span><b>每日学习新词自动朗读一次</b><small>仅在未翻面的新词卡首次出现时触发。</small></span></label>
      <div className="mobile-service-actions"><MobileButton variant="primary" disabled={busy} onClick={() => void commit(() => client.savePreferences(draft), '语音偏好已保存。')}>保存语音偏好</MobileButton><MobileButton disabled={busy} onClick={() => void preview('word')}>试听单词</MobileButton><MobileButton disabled={busy} onClick={() => void preview('article')}>试听文章</MobileButton></div>
    </EditorialCard>
    {settings.providers.filter((provider) => provider.requiresApiKey).map((provider) => {
      const setting = draft.providerSettings[provider.id] ?? { modelId: provider.models[0]?.id ?? '', voiceId: provider.voices[0]?.id ?? '' }
      const voices = provider.voices.filter((voice) => voice.locales.includes(draft.locale))
      return <EditorialCard className="mobile-service-card" key={provider.id}>
        <div className="mobile-service-heading"><div><h2>{provider.name}</h2><p>{provider.description}</p></div><StatusPill tone={provider.keyStatus.configured ? 'success' : 'warning'}>{provider.keyStatus.configured ? '已配置' : '未配置'}</StatusPill></div>
        <div className="mobile-service-grid"><label>模型<select disabled={busy} value={setting.modelId} onChange={(event) => updateProviderSetting(provider.id, 'modelId', event.target.value)}>{provider.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>英文音色<select disabled={busy} value={setting.voiceId} onChange={(event) => updateProviderSetting(provider.id, 'voiceId', event.target.value)}>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label></div>
        {provider.keyStatus.masked && <code className="mobile-key-mask">{provider.keyStatus.masked}</code>}
        <label>API Key<input type="password" autoComplete="off" disabled={busy} value={keys[provider.id] ?? ''} placeholder="输入新密钥以替换" onChange={(event) => setKeys((current) => ({ ...current, [provider.id]: event.target.value }))} /></label>
        <div className="mobile-service-actions"><MobileButton variant="primary" disabled={busy || (keys[provider.id]?.trim().length ?? 0) < 16} onClick={() => void commit(async () => {
          const result = await client.saveApiKey(provider.id as 'google' | 'minimax', keys[provider.id])
          if (!result.ok) throw new Error(result.message)
          setKeys((current) => ({ ...current, [provider.id]: '' }))
        }, '语音密钥已验证并安全保存。')}>保存并测试</MobileButton><MobileButton disabled={busy || !provider.keyStatus.configured} onClick={() => void commit(async () => {
          const result = await client.testConnection(provider.id as 'google' | 'minimax')
          if (!result.ok) throw new Error(result.message)
          onNotice(result.message)
        }, '语音连接测试完成。')}>测试连接</MobileButton>{provider.keyStatus.configured && <MobileButton variant="text" disabled={busy} onClick={() => void commit(() => client.deleteApiKey(provider.id as 'google' | 'minimax'), '语音密钥已删除。')}>删除密钥</MobileButton>}</div>
      </EditorialCard>
    })}
  </div>
}

export function MobileDataSettings({
  onOpenSync,
  onError,
  onNotice,
  onTask,
  clients,
}: {
  onOpenSync(): void
  onError(message: string): void
  onNotice(message: string): void
  onTask(task: MobileTask | null): void
  clients: Pick<MobileAppClient, 'data' | 'storage' | 'platform'>
}) {
  const { data: dataClient, storage: storageClient, platform } = clients
  const appInfoClient = platform.appInfo
  const [report, setReport] = useState<StorageReport | null>(null)
  const [preview, setPreview] = useState<PortableImportPreview | null>(null)
  const [appVersion, setAppVersion] = useState('1.0.0')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmAi, setConfirmAi] = useState(false)
  const load = useCallback(async () => {
    const [storage, info] = await Promise.all([storageClient.scan(), appInfoClient.getInfo()])
    setReport(storage); setAppVersion(info.appVersion)
  }, [appInfoClient, storageClient])
  useEffect(() => { void load().catch((reason) => onError(messageOf(reason))) }, [load, onError])
  useEffect(() => dataClient.onProgress((progress) => {
    if (progress.stage === 'completed' || progress.stage === 'cancelled' || progress.stage === 'error') { onTask(null); return }
    onTask({ id: 'portable-data', kind: 'import', label: progress.message ?? (progress.operation === 'export' ? '正在导出便携备份' : '正在导入便携备份'), detail: progress.operation === 'export' ? '正在生成并写入系统选择的位置。' : '正在校验或合并便携备份。', progress: progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : null, onCancel: () => void dataClient.cancelTransfer().catch((reason) => onError(messageOf(reason))) })
  }), [dataClient, onError, onTask])
  const run = async (id: string, action: () => Promise<unknown>, notice?: string, refresh = true) => {
    setBusy(id)
    try { await action(); if (refresh) await load(); if (notice) onNotice(notice) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setBusy(null); onTask(null) }
  }
  const exportBackup = () => run('export', async () => { const result = await dataClient.exportPortable(); onNotice(result ? `便携备份已导出（${formatBytes(result.bytes)}）。` : '已取消导出。') }, undefined, false)
  const selectBackup = () => run('select', async () => { const selected = await dataClient.selectPortableImport(); if (selected) setPreview(selected); else onNotice('已取消选择。') }, undefined, false)
  const confirmImport = () => {
    if (!preview) return
    const selected = preview; setPreview(null)
    void run('import', async () => { const result = await dataClient.confirmPortableImport(selected.token); onNotice(`恢复完成：新增 ${result.importedPublications ?? 0} 本，合并 ${result.mergedVocabulary ?? 0} 条生词数据。`) })
  }
  const discardImport = () => { const selected = preview; setPreview(null); if (selected) void platform.data.discardPortableImport(selected.token).catch((reason) => onError(messageOf(reason))) }
  return <div className="mobile-service-settings mobile-data-settings">
    <EditorialCard className="mobile-service-card">
      <div className="mobile-service-heading"><div><h2>备份管理</h2><p>便携备份包含刊物的规范化正文与图片、设置、阅读位置、生词、收藏语境和长期学习数据；不包含原始 EPUB、开发模式、密钥、日志或可再生缓存。</p></div><StatusPill tone="success">format v2</StatusPill></div>
      <div className="mobile-service-actions"><MobileButton variant="primary" disabled={busy !== null} onClick={exportBackup}>{busy === 'export' ? '正在导出…' : '导出便携备份'}</MobileButton><MobileButton disabled={busy !== null} onClick={selectBackup}>{busy === 'select' ? '正在校验…' : '导入便携备份'}</MobileButton></div>
      <p className="settings-help">仅接受正式 format v2；不会读取 format v1、Demo format v5–v7 或其他旧格式。</p>
    </EditorialCard>
    <EditorialCard className="mobile-service-card mobile-storage-report">
      <div className="mobile-service-heading"><div><h2>存储空间</h2><p>应用程序、资源、个人数据与缓存的本机占用；统计值可能随运行状态轻微变化。</p></div><MobileButton variant="text" disabled={busy !== null} onClick={() => void run('scan', async () => setReport(await storageClient.scan()), undefined, false)}>{busy === 'scan' ? '扫描中…' : '重新扫描'}</MobileButton></div>
      {!report ? <Skeleton lines={7} /> : <>
        <div className="mobile-storage-total"><span>总占用</span><b>{formatBytes(report.totalBytes)}</b><small>扫描于 {new Date(report.scannedAt).toLocaleString('zh-CN')}</small></div>
        <div className="mobile-storage-category-grid">{report.categories.map((category) => <section key={category.id} className={`mobile-storage-category ${category.id}`}><header><b>{category.label}</b><strong>{formatBytes(category.bytes)}</strong></header>{category.entries.map((entry) => <div key={entry.id}><span>{entry.label}</span><small>{formatBytes(entry.bytes)}</small></div>)}</section>)}</div>
        <div className="mobile-service-actions"><MobileButton disabled={busy !== null} onClick={() => void run('safe-cache', async () => setReport((await storageClient.clearSafeCache()).report), '安全缓存已清理。', false)}>清理安全缓存</MobileButton><MobileButton variant="text" disabled={busy !== null} onClick={() => setConfirmAi(true)}>清理 AI 文本缓存</MobileButton></div>
      </>}
    </EditorialCard>
    <EditorialCard className="mobile-service-card"><div className="mobile-service-heading"><div><h2>跨设备同步</h2><p>发现同一局域网内的 Windows 或 Android 设备，配对后同步解析刊物、阅读位置、生词和学习数据。</p></div><StatusPill tone="success">可用</StatusPill></div><MobileButton variant="primary" disabled={busy !== null} onClick={onOpenSync}>打开跨设备同步</MobileButton></EditorialCard>
    <EditorialCard className="mobile-service-card"><div className="mobile-service-heading"><div><h2>本地数据目录</h2><p>书库、数据库、词典和缓存均保存在 Android 应用私有空间；可在系统页面查看占用或清除数据。</p></div></div><MobileButton disabled={busy !== null} onClick={() => void run('system-storage', () => platform.storage.openAppStorageSettings(), undefined, false)}>打开应用存储设置</MobileButton></EditorialCard>
    <p className="mobile-version-label">外刊阅读器 {appVersion} · Android</p>
    {preview && <ConfirmDialog title="导入此便携备份？" description={`备份创建于 ${new Date(preview.createdAt).toLocaleString('zh-CN')}，包含 ${preview.publicationCount} 本刊物（新增 ${preview.newPublicationCount} 本）、${preview.vocabularyCount} 个生词和 ${preview.studyPlanCount} 个学习计划。现有数据将按 NewerWins 合并。`} confirmLabel="合并并恢复" onCancel={discardImport} onConfirm={confirmImport} />}
    {confirmAi && <ConfirmDialog title="清理 AI 文本缓存？" description="文章译文和 AI 文中义会被删除，之后可联网重新生成。收藏、生词和学习记录不受影响。" confirmLabel="清理缓存" onCancel={() => setConfirmAi(false)} onConfirm={() => { setConfirmAi(false); void run('ai-cache', async () => setReport((await storageClient.clearAiTextCache('CLEAR_AI_TEXT_CACHE')).report), 'AI 文本缓存已清理。', false) }} />}
  </div>
}

function MobileDeveloperSettings({
  clients,
  onError,
  onNotice,
}: {
  clients: Pick<MobileAppClient, 'developer' | 'platform'>
  onError(message: string): void
  onNotice(message: string): void
}) {
  const [state, setState] = useState<DeveloperState | null>(null)
  const [appVersion, setAppVersion] = useState('1.0.0')
  const [busy, setBusy] = useState(false)
  const [studyResetText, setStudyResetText] = useState('')
  const [factoryResetText, setFactoryResetText] = useState('')
  const load = useCallback(async () => { const [next, info] = await Promise.all([clients.developer.getState(), clients.platform.appInfo.getInfo()]); setState(next); setAppVersion(info.appVersion) }, [clients])
  useEffect(() => { void load().catch((reason) => onError(messageOf(reason))) }, [load, onError])
  const run = async (action: () => Promise<unknown>, notice: string, refresh = true) => { setBusy(true); try { await action(); if (refresh) await load(); onNotice(notice) } catch (reason) { onError(messageOf(reason)) } finally { setBusy(false) } }
  if (!state) return <Skeleton lines={8} />
  const developerClient = clients.developer
  return <div className="mobile-service-settings mobile-developer-settings">
    <EditorialCard className="mobile-service-card"><div className="mobile-service-heading"><div><h2>开发与调试</h2><p>用于验证调度、收集脱敏日志和恢复应用；破坏性操作不会进入便携备份。</p></div><StatusPill tone={state.enabled ? 'success' : 'neutral'}>{state.enabled ? '已启用' : '已关闭'}</StatusPill></div><label className="mobile-toggle-row"><input type="checkbox" checked={state.enabled} disabled={busy} onChange={(event) => void run(async () => setState(await developerClient.setEnabled(event.target.checked)), event.target.checked ? '开发模式已启用。' : '开发模式与日志已关闭。', false)} /><span><b>启用开发模式</b><small>关闭后会同时停止诊断日志，但保留已有日志文件。</small></span></label></EditorialCard>
    <EditorialCard className="mobile-service-card"><h2>学习调试</h2><p>模拟学习日切换，或保留计划、生词和语境并重置全部记忆曲线。</p><div className="mobile-service-actions"><MobileButton disabled={busy || !state.enabled} onClick={() => void run(() => developerClient.forceNextStudyDay('NEXT_STUDY_DAY'), '已模拟进入下一学习日。')}>模拟下一学习日</MobileButton></div><label>输入“重置全部学习进度”确认<input value={studyResetText} disabled={busy || !state.enabled} autoComplete="off" onChange={(event) => setStudyResetText(event.target.value)} /></label><MobileButton variant="danger" disabled={busy || !state.enabled || studyResetText !== '重置全部学习进度'} onClick={() => void run(async () => { setState(await developerClient.resetAllProgress('RESET_ALL_STUDY_PROGRESS')); setStudyResetText('') }, '全部学习进度已重置。', false)}>重置全部学习进度</MobileButton></EditorialCard>
    <EditorialCard className="mobile-service-card"><div className="mobile-service-heading"><div><h2>日志模式</h2><p>仅记录脱敏后的运行事件，不记录密钥、文章文本、音频、请求正文或完整路径。</p></div><StatusPill tone={state.loggingEnabled ? 'warning' : 'neutral'}>{state.loggingEnabled ? '记录中' : '已关闭'}</StatusPill></div><label className="mobile-toggle-row"><input type="checkbox" checked={state.loggingEnabled} disabled={busy || !state.enabled} onChange={(event) => void run(async () => setState(await developerClient.setLoggingEnabled(event.target.checked)), event.target.checked ? '本地诊断日志已启用。' : '本地诊断日志已关闭。', false)} /><span><b>启用本地诊断日志</b><small>{state.logFileCount} 个文件 · {formatBytes(state.logBytes)} · 最多保留 5 个</small></span></label><div className="mobile-service-actions"><MobileButton disabled={busy || !state.enabled} onClick={() => void run(() => developerClient.shareDiagnosticBundle(), '系统分享面板已打开。', false)}>分享脱敏诊断包</MobileButton><MobileButton variant="text" disabled={busy || state.logFileCount === 0} onClick={() => void run(async () => setState(await developerClient.clearLogs()), '诊断日志已清理。', false)}>清理日志</MobileButton></div></EditorialCard>
    <EditorialCard className="mobile-service-card mobile-danger-zone"><StatusPill tone="danger">不可撤销</StatusPill><h2>恢复出厂设置</h2><p>永久删除本应用私有空间中的书库、数据库、词典、设置、API 密钥、缓存、日志和内部恢复备份。不会读取、迁移或删除旧 Demo 数据。</p><label>输入“恢复出厂设置”确认<input value={factoryResetText} disabled={busy || !state.enabled} autoComplete="off" onChange={(event) => setFactoryResetText(event.target.value)} /></label><MobileButton variant="danger" disabled={busy || !state.enabled || factoryResetText !== '恢复出厂设置'} onClick={() => void run(() => developerClient.factoryReset(factoryResetText), '恢复出厂设置已启动。', false)}>格式化并自动重启</MobileButton></EditorialCard>
    <p className="mobile-version-label">外刊阅读器 {appVersion} · Android</p>
  </div>
}

function SettingsCapabilityCard({ section }: { section: Exclude<MobileSettingsSection, 'appearance' | 'dictionary' | 'translation'> }) {
  if (section === 'study') return null
  return <EditorialCard className="settings-status-card local-product-card"><StatusPill tone="success">本地优先</StatusPill><h2>正式数据基线</h2><p>书库、目录、阅读位置、词典资源、生词和学习进度均保存在应用私有空间。应用不会读取、迁移或删除旧 Demo 数据。</p><dl><div><dt>数据库</dt><dd>schema v2</dd></div><div><dt>内容 ID</dt><dd>v2</dd></div><div><dt>便携备份</dt><dd>format v2</dd></div></dl></EditorialCard>
}

function MobileAppearanceSettings({ preferences, onBack, onChange }: { preferences: ReaderPreferences; onBack(): void; onChange(value: ReaderPreferences): void }) {
  return <div className="mobile-page appearance-settings-page">
    <TopAppBar title="阅读外观" onBack={onBack} />
    <PageHeader eyebrow="READING APPEARANCE" title="阅读版式" description="这些设置会立即应用到所有文章，并安全保存到本机。" />
    <EditorialCard className="appearance-preview" style={{ '--preview-size': `${Math.max(15, preferences.fontSize - 2) / 16}rem`, '--preview-leading': preferences.lineHeight } as CSSProperties}><small>READING PREVIEW</small><h2>The shape of a changing world</h2><p>Clear typography keeps attention on the argument, not the interface.</p><em>清晰的排版让注意力停留在内容本身。</em></EditorialCard>
    <AppearanceControls preferences={preferences} onChange={onChange} />
    <MobileButton variant="text" onClick={() => onChange(DEFAULT_MOBILE_READER_PREFERENCES)}>恢复默认阅读外观</MobileButton>
  </div>
}

export function AppearanceControls({ preferences, onChange }: { preferences: ReaderPreferences; onChange(value: ReaderPreferences): void }) {
  const columnPreset = readerColumnPreset(preferences.columnWidth)
  return <section className="appearance-controls">
    <label><span>主题<b>{preferences.theme === 'light' ? '浅色纸张' : '深色纸张'}</b></span><SegmentedControl value={preferences.theme} label="阅读主题" items={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={(theme) => onChange({ ...preferences, theme })} /></label>
    <label><span>字号<b>{preferences.fontSize}px</b></span><input type="range" min="15" max="30" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) })} /></label>
    <label><span>行距<b>{preferences.lineHeight.toFixed(1)}</b></span><input type="range" min="1.4" max="2.2" step="0.1" value={preferences.lineHeight} onChange={(event) => onChange({ ...preferences, lineHeight: Number(event.target.value) })} /></label>
    <label><span>宽屏版心<b>{columnPreset ? READER_COLUMN_PRESETS.find((item) => item.id === columnPreset)?.label : `自定义 ${preferences.columnWidth}px`}</b></span><SegmentedControl value={columnPreset ?? 'custom'} label="宽屏版心" items={READER_COLUMN_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))} onChange={(preset) => { if (preset !== 'custom') onChange({ ...preferences, columnWidth: readerColumnValue(preset) }) }} /><small>手机竖屏自动使用可用宽度；横屏、折叠屏和平板按此宽度排版。Windows 保存的自定义值会保留到你选择预设为止。</small></label>
    {preferences.theme === 'light' && <label><span>纸张暖度<b>{preferences.paperTint}</b></span><input type="range" min="0" max="100" step="1" value={preferences.paperTint} onChange={(event) => onChange({ ...preferences, paperTint: Number(event.target.value) })} /><small>数值越高，界面和正文越接近温暖米白。</small></label>}
  </section>
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message)
  return '操作失败，请重试。'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
