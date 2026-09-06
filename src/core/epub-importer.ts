import { XMLParser } from 'fast-xml-parser'
import { load } from 'cheerio'
import sanitizeHtml from 'sanitize-html'
import type {
  ParsedArticle,
  ParsedBlock,
  ParsedPublicationPlan,
  ParsedSection,
} from '../shared/types'
import {
  EpubSourceProfileRegistry,
} from './importing/source-profiles'

export interface ContentHasher {
  sha256(value: Uint8Array | string): string
}

export interface EpubArchiveEntry {
  path: string
  directory: boolean
  compressedBytes?: number
  uncompressedBytes?: number
}

export interface EpubArchiveReader {
  listEntries(): readonly EpubArchiveEntry[]
  readText(path: string): Promise<string>
  readBinary?(path: string): Promise<Uint8Array>
}

export const CONTENT_ID_VERSION = 2

export const EPUB_SAFETY_POLICY = {
  sourceBytes: 500 * 1024 * 1024,
  entries: 4_000,
  expandedBytes: 1024 * 1024 * 1024,
  textEntryBytes: 16 * 1024 * 1024,
  rasterEntryBytes: 64 * 1024 * 1024,
  extractedRasterBytes: 750 * 1024 * 1024,
  compressionRatio: 2_000,
} as const

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
})

export class EpubImporter {
  constructor(
    private readonly hasher: ContentHasher,
    private readonly sourceProfiles = new EpubSourceProfileRegistry(),
  ) {}

  async parseArchive(archive: EpubArchiveReader, hash: string): Promise<ParsedPublicationPlan> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('EPUB 内容摘要无效')
    const entries = archive.listEntries()
    validateEpubArchiveEntries(entries)
    const entryNames = entries.filter((entry) => !entry.directory).map((entry) => normalizeArchivePath(entry.path))
    const availableEntries = new Set(entryNames)

    const containerXml = await readText(archive, 'META-INF/container.xml')
    const container = xmlParser.parse(containerXml) as Record<string, any>
    const rootfiles = asArray(container?.container?.rootfiles?.rootfile)
    const opfPath = normalizeArchivePath(String(rootfiles[0]?.['full-path'] ?? ''))
    if (!opfPath) throw new Error('EPUB 缺少有效的 OPF 包文档')

    const opfXml = await readText(archive, opfPath)
    const opf = xmlParser.parse(opfXml) as Record<string, any>
    const pkg = opf.package
    if (!pkg) throw new Error('无法解析 EPUB 包文档')
    const metadata = pkg.metadata ?? {}
    const opfDir = posixDirname(opfPath)

    const manifestItems: ManifestItem[] = asArray(pkg.manifest?.item).map((item) => ({
      id: String(item.id ?? ''),
      href: resolveArchivePath(opfDir, String(item.href ?? '')),
      mediaType: String(item['media-type'] ?? ''),
      properties: String(item.properties ?? ''),
    }))
    const manifestById = new Map(manifestItems.map((item) => [item.id, item]))
    const spineRefs = asArray(pkg.spine?.itemref)
    const spineItems = spineRefs
      .map((ref) => manifestById.get(String(ref.idref ?? '')))
      .filter((item): item is ManifestItem => Boolean(item))

    if (spineItems.length === 0) throw new Error('EPUB 没有可读取的正文顺序')

    const navigationLabels = await this.parseNavigation(archive, manifestItems, pkg.spine?.toc)
    const title = firstText(metadata.title) || '未命名刊物'
    const creator = firstText(metadata.creator) || null
    const language = firstText(metadata.language) || null
    const identifier = firstText(metadata.identifier)
    const issuedAt = firstText(metadata.date)
    const profile = this.sourceProfiles.select(title, spineItems.map((item) => item.href))
    const profileId = profile.id
    const sourceKey = identifier
      ? `${profileId}:identifier:${identifier.normalize('NFKC').trim().toLowerCase()}`
      : `${profileId}:metadata:${[title, creator ?? '', issuedAt].join('\u001f').normalize('NFKC').trim().toLowerCase() || hash}`
    const publicationId = `pub_${this.hasher.sha256(sourceKey).slice(0, 24)}`
    const coverPath = await this.findCover(archive, availableEntries, manifestItems, metadata, spineItems)

    const sections: ParsedSection[] = []
    const unsectionedArticles: ParsedArticle[] = []
    let currentSection: ParsedSection | null = null
    let articlePosition = 0
    let sectionPosition = 0

    for (const item of spineItems) {
      if (!/x?html/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue
      if (profile.shouldSkipDocument(item.href, item.properties)) continue

      const html = await readText(archive, item.href)
      const $ = load(html, { xmlMode: true })
      $('script, style, iframe, object, embed, form, input, button, video, audio').remove()
      const documentTitle = cleanText($('title').first().text())
      const headingTitle = cleanText(
        $(profile.titleSelectors).first().text(),
      )
      const navTitle = navigationLabels.get(stripFragment(item.href)) ?? ''
      const itemTitle = headingTitle || documentTitle || navTitle || `文章 ${articlePosition + 1}`
      // Preserve prose wrapped in generic containers. Wrap only runs outside existing
      // semantic blocks, keeping their text-based IDs and document order unchanged.
      for (const container of $('body, div, section, article, td, th').toArray().reverse()) {
        const children = $(container).contents().toArray()
        const isInline = (node: typeof children[number]) => node.type === 'text'
          || /^(span|a|em|strong|b|i|br|sup|sub|small)$/.test(String((node as any).tagName ?? '').toLowerCase())
        if (!children.some(node => isInline(node) && cleanText($(node).text()))) continue
        let run: any[] = []
        const fragments: string[] = []
        const flush = () => {
          if (run.length && cleanText(run.map(node => $(node).text()).join(''))) {
            fragments.push(`<p>${run.map(node => $.html(node)).join('')}</p>`)
          } else fragments.push(...run.map(node => $.html(node)))
          run = []
        }
        for (const node of children) {
          if (isInline(node)) run.push(node)
          else { flush(); fragments.push($.html(node)) }
        }
        flush()
        $(container).html(fragments.join(''))
      }
      const paragraphCount = $('body p, body li, body blockquote').filter((_, element) =>
        !$(element).closest('.link_navbar').length && Boolean(cleanText($(element).text()))).length

      if (paragraphCount === 0 && !$('body img').length) {
        const sectionTitle = itemTitle
        if (sectionTitle && !looksLikeFrontmatter(sectionTitle)) {
          currentSection = {
            id: stableId(this.hasher, 'section', publicationId, item.href, sectionTitle),
            sourceKey: item.href,
            title: sectionTitle,
            position: sectionPosition++,
            articles: [],
          }
          sections.push(currentSection)
        }
        continue
      }

      const rubric = cleanText($(profile.rubricSelectors).first().text()) || null
      const publishedAt = cleanText(
        $(profile.dateSelectors).first().text(),
      ) || null
      const articleId = stableId(this.hasher, 'article', publicationId, item.href)
      const blocks = this.parseBlocks($, item.href, articleId, itemTitle, rubric)
      const article: ParsedArticle = {
        id: articleId,
        sourceKey: item.href,
        title: itemTitle,
        rubric,
        publishedAt,
        position: articlePosition++,
        sourceHref: item.href,
        blocks,
      }

      if (currentSection) currentSection.articles.push(article)
      else unsectionedArticles.push(article)
    }

    const assetPaths = new Set<string>()
    if (coverPath) {
      if (!isSupportedRasterAsset(coverPath)) throw new Error(`EPUB 包含不受支持的封面图片：${coverPath}`)
      assetPaths.add(coverPath)
    }
    for (const item of manifestItems) {
      if (!item.mediaType.startsWith('image/')) continue
      if (!isSupportedRasterAsset(item.href) || !isSupportedRasterMediaType(item.mediaType)) {
        throw new Error(`EPUB 包含不受支持的图片资源：${item.href}`)
      }
      assetPaths.add(item.href)
    }
    for (const section of sections) {
      for (const article of section.articles) {
        for (const block of article.blocks) {
          if (block.assetPath && !isSupportedRasterAsset(block.assetPath)) {
            throw new Error(`EPUB 包含不受支持的图片资源：${block.assetPath}`)
          }
          if (block.assetPath) assetPaths.add(block.assetPath)
        }
      }
    }
    for (const article of unsectionedArticles) {
      for (const block of article.blocks) {
        if (block.assetPath && !isSupportedRasterAsset(block.assetPath)) {
          throw new Error(`EPUB 包含不受支持的图片资源：${block.assetPath}`)
        }
        if (block.assetPath) assetPaths.add(block.assetPath)
      }
    }
    const filteredSections = sections.filter((section) => section.articles.length > 0)
    return {
      id: publicationId,
      hash,
      sourceKey,
      profileId,
      title,
      creator,
      language,
      coverPath: coverPath && availableEntries.has(coverPath) ? coverPath : null,
      sections: filteredSections,
      unsectionedArticles,
      assetPaths: [...assetPaths].filter((assetPath) => availableEntries.has(assetPath)).sort(),
    }
  }

  private parseBlocks(
    $: ReturnType<typeof load>,
    sourceHref: string,
    articleId: string,
    title: string,
    rubric: string | null,
  ): ParsedBlock[] {
    const blocks: ParsedBlock[] = []
    const sourceKeyCounts = new Map<string, number>()
    const pushTextBlock = (type: ParsedBlock['type'], text: string, html: string | null) => {
      const cleaned = cleanText(text)
      if (!cleaned) return
      const position = blocks.length
      const baseSourceKey = `${type}:${this.hasher.sha256(cleaned).slice(0, 20)}`
      const ordinal = sourceKeyCounts.get(baseSourceKey) ?? 0
      sourceKeyCounts.set(baseSourceKey, ordinal + 1)
      const sourceKey = `${baseSourceKey}:${ordinal}`
      blocks.push({
        id: stableId(this.hasher, 'block', articleId, sourceKey),
        sourceKey,
        type,
        position,
        text: cleaned,
        html,
        assetPath: null,
        alt: null,
      })
    }

    pushTextBlock('title', title, escapeHtml(title))
    if (rubric) pushTextBlock('rubric', rubric, escapeHtml(rubric))

    const nodes = $('body h2, body h3, body p, body blockquote, body li, body img, body figcaption').toArray()
    for (const node of nodes) {
      const element = $(node)
      const tag = String((node as any).tagName ?? (node as any).name ?? '').toLowerCase()
      const className = String(element.attr('class') ?? '')
      if (/te_article_(title|rubric|datePublished)|te_section_title/i.test(className)) continue
      if (element.closest('.link_navbar').length || element.hasClass('link_navbar')) continue
      if (element.find('.producer_link, .origin_link').length || element.hasClass('producer_link')) continue
      if (tag === 'p' && element.closest('blockquote, li').length) continue
      if (tag === 'li' && element.parents('li').length) continue
      if (tag === 'figcaption' && element.parents('figcaption').length) continue

      if (tag === 'img') {
        const src = String(element.attr('src') ?? '').trim()
        if (!src || /^(data:|https?:)/i.test(src)) continue
        const assetPath = resolveArchivePath(posixDirname(sourceHref), src)
        const position = blocks.length
        const baseSourceKey = `image:${assetPath}`
        const ordinal = sourceKeyCounts.get(baseSourceKey) ?? 0
        sourceKeyCounts.set(baseSourceKey, ordinal + 1)
        const sourceKey = `${baseSourceKey}:${ordinal}`
        blocks.push({
          id: stableId(this.hasher, 'block', articleId, sourceKey),
          sourceKey,
          type: 'image',
          position,
          text: null,
          html: null,
          assetPath,
          alt: cleanText(String(element.attr('alt') ?? '')) || null,
        })
        continue
      }

      const text = cleanText(element.text())
      const inline = safeInlineHtml(element.html() ?? '')
      if (tag === 'h2' || tag === 'h3') pushTextBlock('heading', text, inline)
      else if (tag === 'blockquote') pushTextBlock('quote', text, inline)
      else if (tag === 'li') pushTextBlock('list-item', text, inline)
      else if (tag === 'figcaption') pushTextBlock('caption', text, inline)
      else if (tag === 'p') pushTextBlock('paragraph', text, inline)
    }
    return blocks
  }

  private async parseNavigation(
    archive: EpubArchiveReader,
    manifest: ManifestItem[],
    spineToc: unknown,
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>()
    const navItem = manifest.find((item) => item.properties.split(/\s+/).includes('nav'))
    if (navItem) {
      const $ = load(await readText(archive, navItem.href), { xmlMode: true })
      const nav = $('nav').filter((_, element) => {
        const type = String($(element).attr('epub:type') ?? $(element).attr('type') ?? '')
        return type === 'toc'
      }).first()
      const root = nav.length ? nav : $('nav').first()
      root.find('a[href]').each((_, element) => {
        const href = resolveArchivePath(posixDirname(navItem.href), String($(element).attr('href')))
        labels.set(stripFragment(href), cleanText($(element).text()))
      })
      if (labels.size > 0) return labels
    }

    const ncx = manifest.find((item) => item.id === String(spineToc ?? ''))
      ?? manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncx) {
      const $ = load(await readText(archive, ncx.href), { xmlMode: true })
      $('navPoint').each((_, element) => {
        const src = String($(element).children('content').first().attr('src') ?? '')
        const label = cleanText($(element).children('navLabel').first().text())
        if (src && label) {
          labels.set(stripFragment(resolveArchivePath(posixDirname(ncx.href), src)), label)
        }
      })
    }
    return labels
  }

  private async findCover(
    archive: EpubArchiveReader,
    availableEntries: ReadonlySet<string>,
    manifest: ManifestItem[],
    metadata: Record<string, any>,
    spine: ManifestItem[],
  ): Promise<string | null> {
    let cover = manifest.find((item) => item.properties.split(/\s+/).includes('cover-image'))
    if (!cover) {
      const metas = asArray(metadata.meta)
      const coverId = String(metas.find((meta) => meta.name === 'cover')?.content ?? '')
      cover = manifest.find((item) => item.id === coverId)
    }
    if (cover && availableEntries.has(cover.href)) return cover.href

    const coverDocument = spine.find((item) => /cover/i.test(item.id) || /cover/i.test(item.href))
    if (coverDocument) {
      const $ = load(await readText(archive, coverDocument.href), { xmlMode: true })
      const src = String($('img').first().attr('src') ?? '')
      if (src) {
        const resolved = resolveArchivePath(posixDirname(coverDocument.href), src)
        if (availableEntries.has(resolved)) return resolved
      }
    }
    return null
  }
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function firstText(value: unknown): string {
  const first = asArray(value as any)[0]
  if (first == null) return ''
  if (typeof first === 'object') return cleanText(String((first as any)['#text'] ?? ''))
  return cleanText(String(first))
}

async function readText(archive: EpubArchiveReader, name: string): Promise<string> {
  const normalized = normalizeArchivePath(name)
  const value = await archive.readText(normalized)
  if (new TextEncoder().encode(value).byteLength > EPUB_SAFETY_POLICY.textEntryBytes) {
    throw new Error(`EPUB 文本条目超过 16 MiB 限制：${normalized}`)
  }
  return value
}

export function validateEpubArchiveEntries(
  entries: readonly EpubArchiveEntry[],
  options: { requireSizes?: boolean } = {},
): void {
  if (entries.length > EPUB_SAFETY_POLICY.entries) throw new Error('EPUB 内文件数量异常')
  const seen = new Set<string>()
  let expandedBytes = 0
  for (const entry of entries) {
    const rawPath = entry.directory ? entry.path.replace(/\/$/, '') : entry.path
    if (!rawPath && entry.directory) continue
    validateArchivePath(rawPath)
    const normalized = normalizeArchivePath(rawPath)
    if (normalized !== rawPath.replace(/\\/g, '/')) throw new Error('EPUB 包含非规范或混淆文件路径')
    if (seen.has(normalized)) throw new Error('EPUB 包含重复文件路径')
    seen.add(normalized)
    if (entry.directory) continue
    const compressed = entry.compressedBytes
    const expanded = entry.uncompressedBytes
    if (options.requireSizes && (compressed == null || expanded == null)) {
      throw new Error('EPUB 中央目录缺少条目大小')
    }
    if (compressed == null || expanded == null) continue
    if (!Number.isSafeInteger(compressed) || compressed < 0
      || !Number.isSafeInteger(expanded) || expanded < 0) {
      throw new Error('EPUB 中央目录包含无效条目大小')
    }
    expandedBytes += expanded
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > EPUB_SAFETY_POLICY.expandedBytes) {
      throw new Error('EPUB 解压后超过 1 GiB 限制')
    }
    if (expanded > 0 && (compressed === 0 || expanded > compressed * EPUB_SAFETY_POLICY.compressionRatio)) {
      throw new Error(`EPUB 条目压缩比异常：${normalized}`)
    }
    if (isTextEntry(normalized) && expanded > EPUB_SAFETY_POLICY.textEntryBytes) {
      throw new Error(`EPUB 文本条目超过 16 MiB 限制：${normalized}`)
    }
    if (isSupportedRasterAsset(normalized) && expanded > EPUB_SAFETY_POLICY.rasterEntryBytes) {
      throw new Error(`EPUB 图片超过 64 MiB 限制：${normalized}`)
    }
  }
}

export function isSupportedRasterAsset(value: string): boolean {
  return /\.(?:jpe?g|png|gif|webp)$/i.test(stripFragment(value))
}

function isSupportedRasterMediaType(value: string): boolean {
  return /^(?:image\/jpeg|image\/jpg|image\/png|image\/gif|image\/webp)$/i.test(value.trim())
}

function isTextEntry(value: string): boolean {
  return /\.(?:xml|opf|xhtml|html?|ncx)$/i.test(stripFragment(value))
}

function normalizeArchivePath(value: string): string {
  const decoded = safeDecode(value.replace(/\\/g, '/').split('#')[0].split('?')[0])
  if (decoded.startsWith('/') || /^[a-z]:/i.test(decoded)) {
    throw new Error('EPUB 包含无效文件路径')
  }
  const normalized = normalizePosix(decoded).replace(/^\.\//, '')
  validateArchivePath(normalized)
  return normalized
}

function resolveArchivePath(base: string, value: string): string {
  const cleanValue = safeDecode(value.replace(/\\/g, '/').split('#')[0].split('?')[0])
  return normalizeArchivePath([base === '.' ? '' : base, cleanValue].filter(Boolean).join('/'))
}

function posixDirname(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function normalizePosix(value: string): string {
  const output: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (output.length > 0 && output[output.length - 1] !== '..') output.pop()
      else output.push(segment)
    } else output.push(segment)
  }
  return output.join('/')
}

function validateArchivePath(value: string): void {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('EPUB 包含无效文件路径')
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('EPUB 包含越界文件路径')
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripFragment(value: string): string {
  return value.split('#')[0]
}

function stableId(hasher: ContentHasher, ...values: string[]): string {
  return hasher.sha256(values.join('\u001f')).slice(0, 28)
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function safeInlineHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ['strong', 'b', 'em', 'i', 'span', 'br', 'sup', 'sub', 'small'],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  }).trim()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function looksLikeFrontmatter(title: string): boolean {
  return /^(contents?|table of contents|cover)$/i.test(title)
}
