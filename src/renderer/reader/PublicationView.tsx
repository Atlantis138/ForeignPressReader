import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppClient } from '../../core/app-client'
import type { PublicationDetail } from '../../shared/types'
import { contentsSegments } from '../../core/contents-segments'
import { useContentsTranslation, contentsTranslationLabel, type ContentsSnapshot } from './use-contents-translation'
export type { ContentsSnapshot } from './use-contents-translation'
import { ArrowLeftIcon, TranslateIcon } from '../ui/icons'


export function PublicationView({ id, client, snapshot, onBack, onOpenArticle, onError }: {
  id: string
  client: Pick<AppClient, 'library' | 'translation'>
  snapshot: ContentsSnapshot
  onBack(): void
  onOpenArticle(id: string): void
  onError(message: string): void
}) {
  const [publication, setPublication] = useState<PublicationDetail | null>(null)
  const translation = useContentsTranslation(id, client.translation, snapshot, onError)
  const { translations, visible, showTranslation, progress, working } = translation
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    let current = true
    setPublication(null)
    setFailed(false)
    client.library.getPublication(id)
      .then(detail => { if (current) setPublication(detail) })
      .catch(error => { if (current) { setFailed(true); onError(messageOf(error)) } })
    return () => { current = false }
  }, [attempt, client, id, onError])

  useLayoutEffect(() => {
    if (!publication || !translation.loaded) return
    const container = root.current?.closest<HTMLElement>('.main-content')
    if (!container) return
    container.scrollTop = snapshot.scrollTop
    return () => { snapshot.scrollTop = container.scrollTop }
  }, [publication, snapshot, translation.loaded])

  if (!publication) return <section className="page">{failed
    ? <button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新加载目录</button>
    : <p>正在整理目录…</p>}</section>
  const { complete, label } = contentsTranslationLabel(publication, translations)
  const hasTranslations = Object.keys(translations).length > 0
  return <section ref={root} className="page contents-page">
    <button className="back-button button-with-icon" onClick={onBack}><ArrowLeftIcon />返回书库</button>
    <div className="publication-hero">
      {publication.coverUrl && <img src={publication.coverUrl} alt="刊物封面" loading="lazy" decoding="async" />}
      <div>
        <p className="eyebrow">ISSUE CONTENTS</p><h1>{publication.title}</h1>
        <p>{publication.articleCount} 篇文章，按原刊栏目与阅读顺序整理。</p>
        <div className="button-row">
          {publication.lastArticleId && <button className="primary-button" onClick={() => onOpenArticle(publication.lastArticleId!)}>继续阅读 →</button>}
          {working ? <button className="secondary-button" onClick={translation.cancel}>取消目录翻译</button>
            : <button className="primary-button button-with-icon" disabled={!translation.loaded} onClick={() => void translation.translate(complete)}><TranslateIcon />{label}</button>}
          {hasTranslations && <button className="secondary-button" onClick={translation.toggle}>{showTranslation ? '隐藏目录译文' : '显示目录译文'}</button>}
        </div>
        {translation.failed && <button className="secondary-button" onClick={translation.retry}>重新加载目录译文</button>}
        {working && <p role="status">正在翻译目录 {progress?.completed ?? 0} / {progress?.total ?? contentsSegments(publication).length}</p>}
      </div>
    </div>
    {publication.unsectionedArticles.length > 0 && <ArticleList title="开篇" articles={publication.unsectionedArticles} translations={visible} onOpen={onOpenArticle} />}
    {publication.sections.map(section => <ArticleList key={section.id} title={section.title} translatedTitle={visible[section.id]} articles={section.articles} translations={visible} onOpen={onOpenArticle} />)}
  </section>
}

function ArticleList({ title, translatedTitle, articles, translations, onOpen }: {
  title: string; translatedTitle?: string; articles: PublicationDetail['unsectionedArticles']
  translations: Record<string, string>; onOpen(id: string): void
}) {
  return <section className="toc-section">
    <h2><span>{title}</span><small>{articles.length}</small></h2>
    {translatedTitle && <p className="toc-translation">{translatedTitle}</p>}
    <div>{articles.map((article, index) => <button key={article.id} onClick={() => onOpen(article.id)}>
      <span className="toc-number">{String(index + 1).padStart(2, '0')}</span>
      <span><b>{article.title}</b>{translations[article.id] && <span className="toc-translation">{translations[article.id]}</span>}
        {article.rubric && <small>{article.rubric}</small>}
        {translations[`${article.id}:rubric`] && <small className="toc-translation">{translations[`${article.id}:rubric`]}</small>}</span>
      <span className="toc-arrow">→</span>
    </button>)}</div>
  </section>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '目录翻译失败'
}
