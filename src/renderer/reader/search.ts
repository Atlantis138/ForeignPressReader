import type { ContentBlock } from '../../shared/types'

export type SearchMatchKind = 'source' | 'translation'

export interface ReaderSearchMatch {
  blockId: string
  kind: SearchMatchKind
  start: number
  end: number
}

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/
const SEARCH_HIGHLIGHT_STYLE_ID = 'reader-search-highlight-style'

export function queryIncludesChinese(query: string): boolean {
  return CJK_PATTERN.test(query)
}

export function findArticleMatches(blocks: ContentBlock[], rawQuery: string): ReaderSearchMatch[] {
  const query = rawQuery.trim()
  if (!query) return []
  const includeTranslations = queryIncludesChinese(query)
  const matches: ReaderSearchMatch[] = []
  for (const block of blocks) {
    if (block.text) matches.push(...findTextMatches(block.id, 'source', block.text, query))
    if (includeTranslations && block.translation) {
      matches.push(...findTextMatches(block.id, 'translation', block.translation, query))
    }
  }
  return matches
}

function findTextMatches(blockId: string, kind: SearchMatchKind, text: string, query: string): ReaderSearchMatch[] {
  const source = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: ReaderSearchMatch[] = []
  let cursor = 0
  while (cursor <= source.length - needle.length) {
    const start = source.indexOf(needle, cursor)
    if (start < 0) break
    matches.push({ blockId, kind, start, end: start + needle.length })
    cursor = start + Math.max(needle.length, 1)
  }
  return matches
}

export function applyReaderSearchHighlights(
  root: HTMLElement,
  matches: ReaderSearchMatch[],
  activeIndex: number,
): HTMLElement | null {
  clearReaderSearchHighlights()
  const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!HighlightConstructor || !registry || matches.length === 0) return null
  ensureReaderSearchHighlightStyles()
  const passiveRanges: Range[] = []
  const activeRanges: Range[] = []
  let activeElement: HTMLElement | null = null
  matches.forEach((match, index) => {
    const attribute = match.kind === 'source' ? 'data-source-block-id' : 'data-translation-block-id'
    const container = root.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(match.blockId)}"]`)
    if (!container) return
    const range = rangeForOffsets(container, match.start, match.end)
    if (!range) return
    if (index === activeIndex) {
      activeRanges.push(range)
      activeElement = range.startContainer.parentElement ?? container
    } else passiveRanges.push(range)
  })
  if (passiveRanges.length) registry.set('reader-search-results', new HighlightConstructor(...passiveRanges))
  if (activeRanges.length) registry.set('reader-search-active', new HighlightConstructor(...activeRanges))
  return activeElement
}

export function clearReaderSearchHighlights(): void {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  registry?.delete('reader-search-results')
  registry?.delete('reader-search-active')
}

function ensureReaderSearchHighlightStyles(): void {
  if (document.getElementById(SEARCH_HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SEARCH_HIGHLIGHT_STYLE_ID
  style.textContent = [
    '::highlight(reader-search-results) { background: color-mix(in srgb, #f2c94c 62%, transparent); color: inherit; }',
    '::highlight(reader-search-active) { background: #f09b32; color: #21180c; }',
  ].join('\n')
  document.head.appendChild(style)
}

function rangeForOffsets(container: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode: Text | null = null
  let endNode: Text | null = null
  let startOffset = 0
  let endOffset = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    const text = current as Text
    const next = offset + text.data.length
    if (!startNode && start >= offset && start <= next) {
      startNode = text
      startOffset = Math.min(text.data.length, start - offset)
    }
    if (end >= offset && end <= next) {
      endNode = text
      endOffset = Math.min(text.data.length, end - offset)
      break
    }
    offset = next
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}
