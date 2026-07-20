import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReadingPositionInput, ReadingPositionSnapshot } from '../../shared/types'

interface CapturedAnchor {
  position: ReadingPositionInput
  viewportY: number
}

const EMPTY_ANCHOR = {
  anchorBlockId: null,
  anchorTokenIndex: null,
  anchorFraction: 0,
} as const

export function scrollOnlyReadingPosition(scrollTop: number): ReadingPositionSnapshot {
  return { scrollTop: finiteScrollTop(scrollTop), ...EMPTY_ANCHOR }
}

/** Capture the stable block/token intersecting the viewport's vertical anchor line. */
export function captureReadingPosition(
  article: HTMLElement,
  container: HTMLElement,
): ReadingPositionInput {
  return captureDomAnchor(article, container, false)?.position
    ?? scrollOnlyReadingPosition(container.scrollTop)
}

/** Restore by stable content anchor first, with the desktop pixel offset as a fallback. */
export function restoreReadingPosition(
  article: HTMLElement,
  container: HTMLElement,
  position: ReadingPositionSnapshot,
): boolean {
  return restoreDomAnchor(article, container, position, viewportAnchorLine(container))
}

export function useReadingAnchor(
  articleRef: React.RefObject<HTMLElement | null>,
  layoutDependencies: readonly unknown[],
) {
  const snapshot = useRef<CapturedAnchor | null>(null)
  const pendingRestore = useRef(false)
  const correcting = useRef(false)

  const scrollContainer = useCallback(
    () => articleRef.current?.closest<HTMLElement>('.main-content') ?? null,
    [articleRef],
  )

  const capture = useCallback(() => {
    const article = articleRef.current
    const container = scrollContainer()
    if (!article || !container) return
    snapshot.current = captureDomAnchor(article, container, true)
  }, [articleRef, scrollContainer])

  const requestRestore = useCallback(() => {
    capture()
    pendingRestore.current = true
  }, [capture])

  const restore = useCallback(() => {
    if (!pendingRestore.current || !snapshot.current) return
    const article = articleRef.current
    const container = scrollContainer()
    if (!article || !container) return
    correcting.current = true
    restoreDomAnchor(article, container, snapshot.current.position, snapshot.current.viewportY)
    pendingRestore.current = false
    requestAnimationFrame(() => {
      correcting.current = false
      capture()
    })
  }, [articleRef, capture, scrollContainer])

  const getReadingPosition = useCallback((): ReadingPositionInput => {
    const article = articleRef.current
    const container = scrollContainer()
    if (!article || !container) return scrollOnlyReadingPosition(0)
    return captureReadingPosition(article, container)
  }, [articleRef, scrollContainer])

  const restoreSavedPosition = useCallback((position: ReadingPositionSnapshot): boolean => {
    const article = articleRef.current
    const container = scrollContainer()
    if (!article || !container) return false
    const restored = restoreReadingPosition(article, container, position)
    snapshot.current = captureDomAnchor(article, container, false)
    return restored
  }, [articleRef, scrollContainer])

  useLayoutEffect(() => {
    if (!pendingRestore.current) return
    const frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
    // The dependency list is intentionally supplied by ReaderView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, layoutDependencies)

  useEffect(() => {
    const container = scrollContainer()
    if (!container) return
    let frame = 0
    const remember = () => {
      if (correcting.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(capture)
    }
    const resize = () => {
      if (!snapshot.current) capture()
      pendingRestore.current = true
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(restore)
    }
    container.addEventListener('scroll', remember, { passive: true })
    window.addEventListener('resize', resize)
    capture()
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('scroll', remember)
      window.removeEventListener('resize', resize)
    }
    // Rebind when ReaderView replaces the article DOM after an async load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, restore, scrollContainer, ...layoutDependencies])

  return {
    captureAnchor: requestRestore,
    refreshAnchor: capture,
    getReadingPosition,
    restoreReadingPosition: restoreSavedPosition,
  }
}

function captureDomAnchor(
  article: HTMLElement,
  container: HTMLElement,
  preferActiveToken: boolean,
): CapturedAnchor | null {
  const blocks = [...article.querySelectorAll<HTMLElement>('[data-reader-block-id]')]
  if (blocks.length === 0) return null

  const line = viewportAnchorLine(container)
  const activeToken = preferActiveToken
    ? article.querySelector<HTMLElement>('.lookup-word.active')
    : null
  const activeBlock = activeToken?.closest<HTMLElement>('[data-reader-block-id]') ?? null
  const block = activeBlock ?? blockAtLine(blocks, line)
  const blockId = block?.dataset.readerBlockId
  if (!block || !blockId) return null

  const token = activeToken && activeBlock === block
    ? activeToken
    : tokenAtLine(block, line)
  const tokenIndex = token == null ? null : parseTokenIndex(token.dataset.tokenIndex)
  const referenceY = token == null ? line : rectCenter(token.getBoundingClientRect())
  const blockRect = block.getBoundingClientRect()
  return {
    position: {
      scrollTop: finiteScrollTop(container.scrollTop),
      anchorBlockId: blockId,
      anchorTokenIndex: tokenIndex,
      anchorFraction: fractionWithin(blockRect, referenceY),
    },
    viewportY: referenceY,
  }
}

function restoreDomAnchor(
  article: HTMLElement,
  container: HTMLElement,
  position: ReadingPositionSnapshot,
  viewportY: number,
): boolean {
  if (position.anchorBlockId) {
    const block = article.querySelector<HTMLElement>(
      `[data-reader-block-id="${escapeSelectorValue(position.anchorBlockId)}"]`,
    )
    if (block) {
      const token = position.anchorTokenIndex == null
        ? null
        : block.querySelector<HTMLElement>(
          `.lookup-word[data-token-index="${position.anchorTokenIndex}"]`,
        )
      const blockRect = block.getBoundingClientRect()
      const targetY = token
        ? rectCenter(token.getBoundingClientRect())
        : blockRect.top + blockRect.height * clampFraction(position.anchorFraction)
      container.scrollTop = clampScrollTop(
        container,
        finiteScrollTop(container.scrollTop) + targetY - viewportY,
      )
      return true
    }
  }
  // Let the browser retain the requested offset while late layout (fonts/images)
  // is still increasing scrollHeight; eagerly clamping here can collapse a
  // valid persisted desktop offset to zero during the first animation frame.
  container.scrollTop = finiteScrollTop(position.scrollTop)
  return false
}

function blockAtLine(blocks: HTMLElement[], line: number): HTMLElement | null {
  const intersecting = blocks.find((block) => {
    const rect = block.getBoundingClientRect()
    return rect.top <= line && rect.bottom >= line
  })
  if (intersecting) return intersecting
  return blocks.find((block) => block.getBoundingClientRect().bottom >= line)
    ?? blocks.at(-1)
    ?? null
}

function tokenAtLine(block: HTMLElement, line: number): HTMLElement | null {
  const tokens = [...block.querySelectorAll<HTMLElement>('.lookup-word[data-token-index]')]
  if (tokens.length === 0) return null
  return tokens.find((token) => {
    const rect = token.getBoundingClientRect()
    return rect.top <= line && rect.bottom >= line
  }) ?? null
}

function viewportAnchorLine(container: HTMLElement): number {
  const rect = container.getBoundingClientRect()
  return rect.top + container.clientHeight / 2
}

function fractionWithin(rect: DOMRect, point: number): number {
  if (!Number.isFinite(rect.height) || rect.height <= 0) return 0
  return clampFraction((point - rect.top) / rect.height)
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function finiteScrollTop(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clampScrollTop(container: HTMLElement, value: number): number {
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight)
  return Math.min(maximum, finiteScrollTop(value))
}

function rectCenter(rect: DOMRect): number {
  return rect.top + rect.height / 2
}

function parseTokenIndex(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null
  const tokenIndex = Number(value)
  return Number.isSafeInteger(tokenIndex) && tokenIndex <= 1_000_000 ? tokenIndex : null
}

function escapeSelectorValue(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}
