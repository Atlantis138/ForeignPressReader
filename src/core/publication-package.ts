import type { ParsedPublicationPlan } from '../shared/types'

export const PUBLICATION_PACKAGE_FORMAT = 'foreign-press-reader-publication' as const
export const PUBLICATION_PACKAGE_VERSION = 2 as const
export const PUBLICATION_PACKAGE_CONTENT_ID_VERSION = 2 as const

export interface PublicationPackageFile {
  path: string
  size: number
  sha256: string
  kind: 'plan' | 'asset'
}

export interface PublicationPackageManifest {
  format: typeof PUBLICATION_PACKAGE_FORMAT
  formatVersion: typeof PUBLICATION_PACKAGE_VERSION
  contentIdVersion: typeof PUBLICATION_PACKAGE_CONTENT_ID_VERSION
  publicationId: string
  sourceFormat: string
  sourceContentSha256: string
  /** First time this publication entered any Foreign Press Reader library. */
  firstImportedAt: string
  planPath: 'publication.json'
  files: PublicationPackageFile[]
}

export function validatePublicationPackageManifest(value: unknown): PublicationPackageManifest {
  if (!value || typeof value !== 'object') throw new Error('刊物包清单格式无效')
  const manifest = value as PublicationPackageManifest
  if (!hasExactKeys(manifest, [
    'format', 'formatVersion', 'contentIdVersion', 'publicationId', 'sourceFormat',
    'sourceContentSha256', 'firstImportedAt', 'planPath', 'files',
  ])) throw new Error('刊物包清单字段无效')
  if (manifest.format !== PUBLICATION_PACKAGE_FORMAT
    || manifest.formatVersion !== PUBLICATION_PACKAGE_VERSION
    || manifest.contentIdVersion !== PUBLICATION_PACKAGE_CONTENT_ID_VERSION
    || manifest.planPath !== 'publication.json') throw new Error('不受支持的刊物包版本')
  if (typeof manifest.firstImportedAt !== 'string' || !isTimestamp(manifest.firstImportedAt)) {
    throw new Error('刊物包首次导入时间无效')
  }
  if (!isSafePublicationId(manifest.publicationId)
    || typeof manifest.sourceContentSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(manifest.sourceContentSha256)
    || typeof manifest.sourceFormat !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(manifest.sourceFormat)
    || !Array.isArray(manifest.files)) throw new Error('刊物包清单字段无效')
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || !hasExactKeys(file, ['path', 'size', 'sha256', 'kind'])
      || typeof file.path !== 'string' || !isPackagePath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || (file.kind !== 'plan' && file.kind !== 'asset')) throw new Error('刊物包文件记录无效')
    if (file.kind === 'plan' && file.path !== manifest.planPath) throw new Error('刊物包解析计划路径无效')
    if (file.kind === 'asset' && !file.path.startsWith('assets/')) throw new Error('刊物包资源路径无效')
    paths.add(file.path)
  }
  if (!paths.has(manifest.planPath) || manifest.files.filter((file) => file.kind === 'plan').length !== 1) {
    throw new Error('刊物包缺少唯一解析计划')
  }
  return manifest
}

export function validateParsedPublicationPlan(value: unknown): ParsedPublicationPlan {
  if (!value || typeof value !== 'object') throw new Error('刊物解析计划格式无效')
  const plan = value as ParsedPublicationPlan
  if (!hasExactKeys(plan, [
    'id', 'hash', 'sourceKey', 'profileId', 'title', 'creator', 'language', 'coverPath',
    'sections', 'unsectionedArticles', 'assetPaths',
  ]) || !isSafePublicationId(plan.id) || typeof plan.hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(plan.hash) || typeof plan.sourceKey !== 'string' || !plan.sourceKey
    || typeof plan.profileId !== 'string' || !plan.profileId || typeof plan.title !== 'string'
    || !plan.title || !Array.isArray(plan.sections) || !Array.isArray(plan.unsectionedArticles)
    || !Array.isArray(plan.assetPaths) || !isNullableString(plan.creator)
    || !isNullableString(plan.language) || !isNullableString(plan.coverPath)) {
    throw new Error('刊物解析计划字段无效')
  }
  const assetPaths = new Set<string>()
  for (const assetPath of plan.assetPaths) {
    if (!isAssetPath(assetPath) || assetPaths.has(assetPath)) throw new Error('刊物解析资源路径无效')
    assetPaths.add(assetPath)
  }
  const ids = new Set<string>([plan.id])
  const validateArticle = (article: ParsedPublicationPlan['unsectionedArticles'][number]) => {
    if (!article || typeof article !== 'object' || !hasExactKeys(article, [
      'id', 'sourceKey', 'title', 'rubric', 'publishedAt', 'position', 'sourceHref', 'blocks',
    ]) || typeof article.id !== 'string' || !article.id || ids.has(article.id)
      || typeof article.sourceKey !== 'string' || !article.sourceKey
      || typeof article.title !== 'string' || !article.title || !isNullableString(article.rubric)
      || !isNullableString(article.publishedAt) || typeof article.sourceHref !== 'string'
      || !Number.isSafeInteger(article.position) || !Array.isArray(article.blocks)) {
      throw new Error('刊物文章记录无效')
    }
    ids.add(article.id)
    for (const block of article.blocks) {
      if (!block || typeof block !== 'object' || !hasExactKeys(block, [
        'id', 'sourceKey', 'type', 'position', 'text', 'html', 'assetPath', 'alt',
      ]) || typeof block.id !== 'string' || !block.id || ids.has(block.id)
        || typeof block.sourceKey !== 'string' || !block.sourceKey
        || !BLOCK_TYPES.has(block.type) || !Number.isSafeInteger(block.position)
        || !isNullableString(block.text) || !isNullableString(block.html)
        || !isNullableString(block.assetPath) || !isNullableString(block.alt)) {
        throw new Error('刊物内容块记录无效')
      }
      ids.add(block.id)
      if (block.assetPath && !assetPaths.has(block.assetPath)) throw new Error('刊物内容引用了缺失资源')
    }
  }
  for (const section of plan.sections) {
    if (!section || typeof section !== 'object' || !hasExactKeys(section, [
      'id', 'sourceKey', 'title', 'position', 'articles',
    ]) || typeof section.id !== 'string' || !section.id || ids.has(section.id)
      || typeof section.sourceKey !== 'string' || !section.sourceKey
      || typeof section.title !== 'string' || !section.title
      || !Number.isSafeInteger(section.position) || !Array.isArray(section.articles)) {
      throw new Error('刊物栏目记录无效')
    }
    ids.add(section.id)
    section.articles.forEach(validateArticle)
  }
  plan.unsectionedArticles.forEach(validateArticle)
  if (plan.coverPath && !assetPaths.has(plan.coverPath)) throw new Error('刊物封面资源缺失')
  if (plan.sections.reduce((sum, section) => sum + section.articles.length, 0) + plan.unsectionedArticles.length === 0) {
    throw new Error('刊物解析计划不含文章')
  }
  return plan
}

export function isAssetPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Publication IDs may become directory names during restore and deletion. */
export function isSafePublicationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)
}

function isPackagePath(value: string): boolean {
  return value === 'publication.json' || (value.startsWith('assets/') && isAssetPath(value.slice('assets/'.length)))
}

const BLOCK_TYPES = new Set(['title', 'rubric', 'heading', 'paragraph', 'image', 'caption', 'list-item', 'quote'])

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}
