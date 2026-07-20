import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DictionaryLookupRequest,
  DictionaryLookupResult,
  ReaderVocabularyState,
} from '../../shared/types'
import { getAppClient } from '../app-client'

const appClient = getAppClient()

export function useVocabularyActions(
  request: DictionaryLookupRequest | null,
  result: DictionaryLookupResult | null,
  onError: (message: string) => void,
) {
  const [state, setState] = useState<ReaderVocabularyState | null>(null)
  const [busy, setBusy] = useState(false)
  const errorHandler = useRef(onError)
  errorHandler.current = onError
  const requestRef = useRef(request)
  requestRef.current = request
  const lexemeKey = result?.found && !result.requiresSelection ? result.lexemeKey : null
  const requestKey = request
    ? `${request.articleId}\u001f${request.blockId}\u001f${request.tokenIndex}\u001f${request.surface}`
    : ''

  useEffect(() => {
    let active = true
    setState(null)
    const currentRequest = requestRef.current
    if (!currentRequest || !lexemeKey) return () => { active = false }
    appClient.vocabulary.getReaderState(currentRequest, lexemeKey)
      .then((next) => { if (active) setState(next) })
      .catch((reason) => { if (active) errorHandler.current(messageOf(reason)) })
    return () => { active = false }
  }, [lexemeKey, requestKey])

  const mutate = useCallback(async (kind: 'favorite' | 'context', value: boolean) => {
    const currentRequest = requestRef.current
    if (!currentRequest || !lexemeKey || busy) return
    setBusy(true)
    try {
      const next = kind === 'favorite'
        ? await appClient.vocabulary.setFavorite(currentRequest, lexemeKey, value)
        : await appClient.vocabulary.setContextSaved(currentRequest, lexemeKey, value)
      setState(next)
    } catch (reason) {
      errorHandler.current(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, lexemeKey])

  return useMemo(() => ({
    state,
    busy,
    available: Boolean(request && lexemeKey),
    toggleFavorite: () => mutate('favorite', !(state?.favorite ?? false)),
    toggleContext: () => mutate('context', !(state?.contextSaved ?? false)),
  }), [busy, mutate, request, lexemeKey, state])
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  return String(reason)
}
