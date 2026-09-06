import { useEffect, useRef } from 'react'

const dialogs: HTMLElement[] = []
const selector =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'

export function useDialogFocus<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
) {
  const ref = useRef<T | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    dialogs.push(root)
    const focusable = () =>
      [...root.querySelectorAll<HTMLElement>(selector)].filter(
        (element) =>
          !element.hidden &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.getClientRects().length > 0,
      )
    ;(focusable()[0] ?? root).focus()
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== root) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable(),
        first = items[0],
        last = items.at(-1)
      if (!first) {
        event.preventDefault()
        root.focus()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault()
        last?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      dialogs.splice(dialogs.indexOf(root), 1)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return ref
}
