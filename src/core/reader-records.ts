import type { ReadingPositionSnapshot } from '../shared/types'

export type ReaderRecordKind =
  | 'position'
  | 'bookmark'
  | 'read'
  | 'translation'
  | 'translation-selection'
export interface ReaderRecord {
  recordId: string
  publicationId: string
  articleId: string
  kind: ReaderRecordKind
  payload: string
  updatedAt: string
  deviceId: string
}
export interface SavedTranslationSegment {
  versionId: string
  blockId: string
  sourceHash: string
  model: string
  promptVersion: string
  text: string
}
const id = /^[a-zA-Z0-9_-]{8,100}$/
export function validateReaderRecord(record: ReaderRecord): void {
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).length !== 7 ||
    [
      'recordId',
      'publicationId',
      'articleId',
      'kind',
      'payload',
      'updatedAt',
      'deviceId',
    ].some(
      (key) =>
        typeof (record as unknown as Record<string, unknown>)[key] !== 'string',
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      record.updatedAt,
    ) ||
    record.deviceId.length > 100 ||
    !id.test(record.publicationId) ||
    !id.test(record.articleId) ||
    record.recordId.length > 250 ||
    record.payload.length > 512_000 ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !record.deviceId
  )
    throw new Error('阅读数据记录无效')
  let value: unknown
  try {
    value = JSON.parse(record.payload)
  } catch {
    throw new Error('阅读数据内容无效')
  }
  if (record.kind === 'position') {
    const p = value as ReadingPositionSnapshot
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).length !== 4 ||
      !Number.isFinite(p.scrollTop) ||
      p.scrollTop < 0 ||
      !Number.isFinite(p.anchorFraction) ||
      p.anchorFraction < 0 ||
      p.anchorFraction > 1 ||
      !(
        p.anchorBlockId === null ||
        (typeof p.anchorBlockId === 'string' && id.test(p.anchorBlockId))
      ) ||
      !(
        p.anchorTokenIndex === null ||
        (Number.isSafeInteger(p.anchorTokenIndex) && p.anchorTokenIndex >= 0)
      )
    )
      throw new Error('文章阅读位置无效')
  } else if (record.kind === 'bookmark' || record.kind === 'read') {
    if (typeof value !== 'boolean') throw new Error('阅读标记无效')
  } else if (record.kind === 'translation-selection') {
    if (value !== null && (typeof value !== 'string' || !id.test(value)))
      throw new Error('译文版本选择无效')
  } else if (record.kind === 'translation') {
    const segment = value as SavedTranslationSegment
    if (
      !segment ||
      Object.keys(segment).length !== 6 ||
      !id.test(segment.versionId) ||
      !id.test(segment.blockId) ||
      !/^[a-f0-9]{64}$/.test(segment.sourceHash) ||
      typeof segment.text !== 'string' ||
      !segment.text.trim() ||
      typeof segment.model !== 'string' ||
      typeof segment.promptVersion !== 'string' ||
      record.recordId !== `translation:${segment.versionId}:${segment.blockId}`
    )
      throw new Error('保留译文无效')
    return
  } else throw new Error('未知阅读记录类型')
  if (record.recordId !== `${record.kind}:${record.articleId}`)
    throw new Error('阅读记录身份不匹配')
}
