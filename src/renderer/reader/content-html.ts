import { tokenizeEnglish } from '../../shared/word-utils'

export function escapeInlineText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Preserve safe inline markup while assigning deterministic word indexes. */
export function tokenizedInlineHtml(html: string): string {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current: Node | null
  while ((current = walker.nextNode())) textNodes.push(current as Text)
  let globalIndex = 0
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? ''
    const tokens = tokenizeEnglish(value)
    if (tokens.length === 0) continue
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const token of tokens) {
      fragment.append(value.slice(cursor, token.start))
      const span = document.createElement('span')
      span.className = 'lookup-word'
      span.dataset.surface = token.surface
      span.dataset.tokenIndex = String(globalIndex++)
      span.textContent = token.surface
      fragment.append(span)
      cursor = token.end
    }
    fragment.append(value.slice(cursor))
    textNode.replaceWith(fragment)
  }
  return document.body.innerHTML
}
