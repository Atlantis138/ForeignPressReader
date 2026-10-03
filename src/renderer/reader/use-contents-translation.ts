import { useEffect, useRef, useState } from 'react'
import type { PublicationDetail, TranslationApi, TranslationProgress } from '../../shared/types'
import { contentsSegments } from '../../core/contents-segments'

export interface ContentsSnapshot { scrollTop: number; showTranslation: boolean; collapsedSections?: string[] }

/** Shared state and failure/resume behavior for both publication screens. */
export function useContentsTranslation(id: string, client: TranslationApi, snapshot: ContentsSnapshot, onError: (message: string) => void) {
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [showTranslation, setShowTranslation] = useState(snapshot.showTranslation)
  const [progress, setProgress] = useState<TranslationProgress | null>(null)
  const [working, setWorking] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    const current = ++generation.current
    setLoaded(false)
    setFailed(false)
    setTranslations({})
    setShowTranslation(snapshot.showTranslation)
    setProgress(null)
    setWorking(false)
    pending.current = false
    void client.getContents(id).then(value => {
      if (generation.current === current) setTranslations(value)
    }).catch(error => {
      if (generation.current === current) { setFailed(true); onError(messageOf(error)) }
    }).finally(() => { if (generation.current === current) setLoaded(true) })
    const unsubscribe = client.onProgress(value => {
      if (generation.current === current && value.articleId === id) setProgress(value)
    })
    return () => {
      generation.current = current + 1
      unsubscribe()
      if (pending.current) void client.cancelContents(id).catch(() => undefined)
    }
  }, [attempt, client, id, onError, snapshot])

  const translate = async (force: boolean) => {
    if (pending.current) return
    const current = generation.current
    pending.current = true
    setWorking(true)
    setProgress(null)
    setShowTranslation(true)
    snapshot.showTranslation = true
    try {
      const value = await client.translateContents(id, force)
      if (generation.current === current) setTranslations(value)
    } catch (error) {
      if (generation.current === current) {
        onError(messageOf(error))
        try {
          const partial = await client.getContents(id)
          if (generation.current === current) setTranslations(partial)
        } catch { /* Keep the translation error visible. */ }
      }
    } finally {
      if (generation.current === current) { pending.current = false; setWorking(false) }
    }
  }
  return {
    loaded, failed, retry: () => setAttempt(value => value + 1), translations,
    visible: showTranslation ? translations : {}, showTranslation, progress, working, translate,
    cancel: () => { void client.cancelContents(id).catch(error => onError(messageOf(error))) },
    toggle: () => { snapshot.showTranslation = !showTranslation; setShowTranslation(!showTranslation) },
  }
}

export function contentsTranslationLabel(publication: PublicationDetail, translations: Record<string, string>) {
  const complete = contentsSegments(publication).every(segment => translations[segment.id])
  return { complete, label: complete ? '重新翻译目录' : Object.keys(translations).length ? '继续翻译目录' : '翻译目录' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '目录翻译失败'
}
