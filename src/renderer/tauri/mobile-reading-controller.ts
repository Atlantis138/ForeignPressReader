import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type {
  LibraryState,
  PublicationDetail,
  ReaderPreferences,
} from '../../shared/types'
import type { MobileAppClient } from './mobile-app-client'
import type { MobileRoute } from './mobile-shell-model'
import { DEFAULT_MOBILE_READER_PREFERENCES } from './mobile-settings-pages'
import { readMobileStartupValue } from './mobile-startup-read'
import type { MobileTask } from './mobile-ui'

const DEFAULT_LIBRARY_STATE: LibraryState = {
  publications: [],
  categories: [],
  preferences: {
    viewMode: 'grid',
    sortBy: 'importedAt',
    sortDirection: 'desc',
    activeCategoryId: 'all',
  },
}

export function useMobileReadingController({
  client,
  route,
  onNavigate,
  onReturnToLibrary,
  onBusy,
  onError,
  onNotice,
  onTask,
}: {
  client: MobileAppClient
  route: MobileRoute
  onNavigate(route: MobileRoute): void
  onReturnToLibrary(): void
  onBusy(value: boolean): void
  onError(message: string | null): void
  onNotice(message: string): void
  onTask: Dispatch<SetStateAction<MobileTask | null>>
}) {
  const [libraryState, setLibraryState] = useState<LibraryState>(DEFAULT_LIBRARY_STATE)
  const [libraryReady, setLibraryReady] = useState(false)
  const [publication, setPublication] = useState<PublicationDetail | null>(null)
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_MOBILE_READER_PREFERENCES)

  const reloadLibrary = useCallback(async () => {
    setLibraryState(await client.library.getState())
  }, [client.library])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const nextLibrary = await readMobileStartupValue(() => client.library.getState())
        if (!active) return
        setLibraryState(nextLibrary)
        setLibraryReady(true)
        const nextPreferences = await readMobileStartupValue(() => client.reader.getPreferences())
        if (active) setPreferences(nextPreferences)
      } catch (reason) {
        if (active) onError(messageOf(reason))
      } finally {
        if (active) onBusy(false)
      }
    })()
    const unsubscribe = client.library.onImportProgress((progress) => {
      if (['completed', 'cancelled', 'error'].includes(progress.stage)) {
        onTask((current) => current?.kind === 'import' ? null : current)
        if (progress.stage === 'completed') onNotice('刊物已安全导入本地书库。')
        return
      }
      onTask({
        id: 'publication-import',
        kind: 'import',
        label: progress.message ?? '正在导入刊物',
        detail: '可离开当前页面，导入将在应用内继续。',
        progress: progress.total ? progress.completed / progress.total : null,
        onCancel: () => void client.library.cancelImport().catch((reason) => onError(messageOf(reason))),
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [client.library, client.reader, onBusy, onError, onNotice, onTask])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    applyMobilePaperTone(preferences.theme === 'light' ? preferences.paperTint : null)
  }, [preferences.paperTint, preferences.theme])

  useEffect(() => {
    if (route.name !== 'publication') return
    onBusy(true)
    client.library.getPublication(route.publicationId)
      .then(setPublication)
      .catch((reason) => {
        onError(messageOf(reason))
        onReturnToLibrary()
      })
      .finally(() => onBusy(false))
  }, [client.library, onBusy, onError, onReturnToLibrary, route])

  const importPublication = useCallback(async () => {
    onError(null)
    onBusy(true)
    try {
      const result = await client.library.importPublication()
      if (!result) return
      await reloadLibrary()
      setPublication(result.publication)
      onNavigate({ name: 'publication', publicationId: result.publication.id })
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      onBusy(false)
    }
  }, [client.library, onBusy, onError, onNavigate, reloadLibrary])

  const savePreferences = useCallback(async (next: ReaderPreferences) => {
    setPreferences(next)
    try {
      setPreferences(await client.reader.savePreferences(next))
    } catch (reason) {
      onError(messageOf(reason))
    }
  }, [client.reader, onError])

  return {
    libraryState,
    setLibraryState,
    libraryReady,
    publication,
    preferences,
    reloadLibrary,
    importPublication,
    savePreferences,
  }
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message)
  return '操作失败，请重试。'
}

function applyMobilePaperTone(value: number | null): void {
  const root = document.documentElement
  if (value == null) {
    for (const key of ['--paper', '--canvas', '--translation', '--line']) root.style.removeProperty(key)
    return
  }
  const amount = Math.min(1, Math.max(0, value / 100))
  root.style.setProperty('--paper', mixMobileHex('#fffefa', '#f5eadb', amount))
  root.style.setProperty('--canvas', mixMobileHex('#f8f5ee', '#eee4d6', amount))
  root.style.setProperty('--translation', mixMobileHex('#f3f0e9', '#e8dece', amount))
  root.style.setProperty('--line', mixMobileHex('#e2ddd3', '#d5c9ba', amount))
}

function mixMobileHex(from: string, to: string, amount: number): string {
  const parse = (value: string) => [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16))
  const left = parse(from)
  const right = parse(to)
  return `rgb(${Math.round(left[0] + (right[0] - left[0]) * amount)} ${Math.round(left[1] + (right[1] - left[1]) * amount)} ${Math.round(left[2] + (right[2] - left[2]) * amount)})`
}
