import { useCallback, useRef } from 'react'
import { PreferenceWriter } from './preference-writer'

export function usePreferenceWriter<T>(
  value: T,
  preview: (value: T) => void,
  persist: (value: T) => Promise<T>,
  onError: (reason: unknown) => void,
) {
  const latest = useRef({ value, preview, persist, onError })
  latest.current = { value, preview, persist, onError }
  const writer = useRef<PreferenceWriter<T> | null>(null)
  return useCallback(async (next: T) => {
    writer.current ??= new PreferenceWriter(
      latest.current.value,
      (value) => latest.current.persist(value),
      (value) => latest.current.preview(value),
      (reason) => latest.current.onError(reason),
    )
    writer.current.refreshBaseline(latest.current.value)
    await writer.current.write(next)
  }, [])
}
