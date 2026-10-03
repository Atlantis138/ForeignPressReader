import type { OnlineCatalog, OnlineIssue } from '../shared/online-catalog'
import type { PublicationSummary } from '../shared/types'

export const ECONOMIST_SOURCE = 'https://github.com/hehonghui/awesome-english-ebooks/tree/master/01_economist'
export const CATALOG_API = 'https://api.github.com/repos/hehonghui/awesome-english-ebooks'
export const CATALOG_TTL_MS = 60 * 60 * 1000
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024
export const MAX_ONLINE_EPUB_BYTES = 64 * 1024 * 1024

export function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
}

export function issueDateFromPath(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const match = /^(?:\d{4}\/)*te_(\d{4})\.(\d{2})\.(\d{2})\/TheEconomist\.\1\.\2\.\3\.epub$/.exec(path)
  if (!match) return null
  const date = `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : null
}

export function parseIssueTree(value: unknown): OnlineIssue[] {
  const tree = value as { truncated?: unknown; tree?: Array<{type?: unknown; mode?: unknown; path?: unknown; sha?: unknown; size?: unknown}> }
  if (!tree || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10_000) throw new Error('期刊目录不完整，请稍后刷新')
  const issues = new Map<string, OnlineIssue>()
  for (const entry of tree.tree) {
    const date = issueDateFromPath(entry?.path)
    if (entry?.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode)) || !date || !isGitSha(entry.sha)
      || !Number.isSafeInteger(entry.size) || Number(entry.size) <= 0 || Number(entry.size) > MAX_ONLINE_EPUB_BYTES) continue
    const issue = { id: entry.sha, date, path: String(entry.path), bytes: Number(entry.size) }
    // A moved archive entry can temporarily coexist with the current directory.
    if (!issues.has(date) || issue.path < issues.get(date)!.path) issues.set(date, issue)
  }
  if (!issues.size) throw new Error('来源暂时没有可识别的 EPUB 期刊，请稍后刷新')
  if (issues.size > 2_000) throw new Error('期刊目录超过数量限制')
  return [...issues.values()].sort((a, b) => b.date.localeCompare(a.date))
}

export function isOnlineCatalog(value: unknown): value is OnlineCatalog {
  const catalog = value as OnlineCatalog | null
  return Boolean(catalog && isGitSha(catalog.revision) && typeof catalog.fetchedAt === 'string'
    && Number.isFinite(Date.parse(catalog.fetchedAt)) && Array.isArray(catalog.issues)
    && catalog.issues.length > 0 && catalog.issues.length <= 2_000 && catalog.issues.every(issue =>
      issue && isGitSha(issue.id) && typeof issue.date === 'string' && issueDateFromPath(issue.path) === issue.date
      && Number.isSafeInteger(issue.bytes) && issue.bytes > 0 && issue.bytes <= MAX_ONLINE_EPUB_BYTES))
}

export function onlineIssueUrl(revision: string, issue: OnlineIssue): string {
  if (!isGitSha(revision) || typeof issue.date !== 'string' || issueDateFromPath(issue.path) !== issue.date) throw new Error('期刊来源无效，请刷新列表')
  return `https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/${revision}/01_economist/${issue.path}`
}

export function localEconomistIssue(issues: readonly PublicationSummary[], date: string): PublicationSummary | undefined {
  const expected = `theeconomist.${date.replaceAll('-', '.')}`
  // Original metadata survives user renaming, portable restores, and LAN sync.
  return issues.find(issue => issue.originalTitle.replace(/\s/g, '').toLowerCase() === expected)
}
