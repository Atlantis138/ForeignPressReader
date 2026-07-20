import type { ContextDefinition, DictionaryLookupResult, ReaderVocabularyState } from '../../shared/types'
import { LexemeBadges, LexemeExamples, LexemeSenses } from '../dictionary/LexemeContent'
import { PronounceButton } from '../speech/PronounceButton'

export type DrawerPhase = 'opening' | 'open' | 'closing'

export function DictionaryDrawer({
  phase,
  loading,
  contextLoading,
  result,
  contextEnabled,
  vocabularyState,
  vocabularyBusy,
  vocabularyAvailable,
  onExplain,
  onToggleFavorite,
  onToggleContext,
  onClose,
  onClosed,
  onSettings,
  onSelectCandidate,
}: {
  phase: DrawerPhase
  loading: boolean
  contextLoading: boolean
  result: DictionaryLookupResult | null
  contextEnabled: boolean
  vocabularyState: ReaderVocabularyState | null
  vocabularyBusy: boolean
  vocabularyAvailable: boolean
  onExplain(): void
  onToggleFavorite(): void
  onToggleContext(): void
  onClose(): void
  onClosed(): void
  onSettings(): void
  onSelectCandidate(lexemeKey: string): void
}) {
  return (
    <aside
      className="dictionary-drawer"
      data-state={phase}
      onClick={(event) => event.stopPropagation()}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'transform' && phase === 'closing') onClosed()
      }}
    >
      <header><p>DICTIONARY</p><button onClick={onClose} aria-label="关闭查词">×</button></header>
      {loading && <DrawerLoading label="正在查词…" />}
      {!loading && result && (
        <div className="dictionary-content">
            <div className={`dictionary-word ${wordLengthClass(result.surface)}`}>
              <div className="dictionary-word-heading">
                <div className="dictionary-spoken-word"><h2>{result.surface}</h2><PronounceButton sourceId="reader-dictionary" itemId={result.surface} text={result.surface}/></div>
              <button
                className={`vocabulary-toggle ${vocabularyState?.favorite ? 'active' : ''}`}
                disabled={!vocabularyAvailable || !vocabularyState || vocabularyBusy}
                onClick={onToggleFavorite}
              >
                {vocabularyState?.favorite ? '★ 已收藏' : '☆ 收藏生词'}
              </button>
            </div>
            {result.lemma !== result.normalized && <span>原形 {result.lemma}</span>}
            {result.entries[0]?.phonetic && <p>/{result.entries[0].phonetic}/</p>}
          </div>
          <div className="context-sentence">
            <div className="context-sentence-heading">
              <small>原文语境</small>
              <button
                className={`context-save-toggle ${vocabularyState?.contextSaved ? 'active' : ''}`}
                disabled={!vocabularyAvailable || !vocabularyState || vocabularyBusy}
                onClick={onToggleContext}
              >
                {vocabularyState?.contextSaved ? '已收藏语境' : '收藏语境'}
              </button>
            </div>
            <p>{result.sentence}</p>
          </div>
          {result.requiresSelection && (
            <div className="dictionary-candidates">
              <h3>请选择当前词形对应的词条</h3>
              {result.candidates.map((candidate) => (
                <button key={candidate.lexemeKey} onClick={() => onSelectCandidate(candidate.lexemeKey)}>
                  <b>{candidate.lemma}</b><span>{candidate.briefMeanings.join('；')}</span>
                </button>
              ))}
            </div>
            )}
            <LexemeBadges {...result.metadata}/>
          {result.contextDefinition && <ContextDefinitionCard value={result.contextDefinition} />}
          {contextEnabled && !result.contextDefinition && (
            <button className="context-button" disabled={contextLoading} onClick={onExplain}>
              {contextLoading ? '正在分析文中义…' : '分析文中义'}
            </button>
          )}
          {!result.dictionaryVersion ? (
            <div className="dictionary-missing"><h3>尚未安装本地词典</h3><p>请先在设置中下载并建立 ECDICT 本地索引。</p><button className="primary-button" onClick={onSettings}>前往设置</button></div>
          ) : result.found ? (
            <div className="dictionary-entries">
              {result.entries.map((entry, entryIndex) => (
                <section key={`${entry.word}-${entryIndex}`}>
                   {result.entries.length > 1 && <h3>{entry.word}</h3>}
                  <LexemeSenses senses={entry.senses}/>
                </section>
              ))}
              {result.metadata.forms.length > 0 && <div className="lexeme-forms"><h3>词形</h3><p>{result.metadata.forms.join(' · ')}</p></div>}
            </div>
          ) : (
            <div className="dictionary-missing"><h3>本地词典未收录</h3>{result.suggestions.length > 0 && <p>相近词：{result.suggestions.join('、')}</p>}</div>
          )}
          <LexemeExamples examples={result.examples}/>
          {result.dictionaryVersion && <footer>{result.resolvedProviderId==='baidu'?'百度增强 + ECDICT':result.localProfile==='full'?'ECDICT 完整扩展':'ECDICT 标准包'} · {result.dictionaryVersion}{result.fallbackUsed?' · 百度不可用，已回退本地':''}</footer>}
        </div>
      )}
    </aside>
  )
}

function ContextDefinitionCard({ value }: { value: ContextDefinition }) {
  return (
    <section className="context-definition">
      <div><small>文中义</small><span className={`confidence ${value.confidence}`}>{value.cached ? '已缓存' : value.confidence}</span></div>
      <h3>{value.meaningZh}</h3>
      <b>{value.partOfSpeech}</b>
      <p>{value.explanationZh}</p>
      {value.phrase && <p className="phrase">搭配：{value.phrase}</p>}
    </section>
  )
}

function wordLengthClass(value: string): string {
  if (value.length >= 22) return 'very-long-word'
  if (value.length >= 15) return 'long-word'
  return ''
}

function DrawerLoading({ label }: { label: string }) {
  return <div className="loading"><span /><p>{label}</p></div>
}
