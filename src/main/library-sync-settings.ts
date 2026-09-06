import type { DatabaseSync } from 'node:sqlite'

export const LIBRARY_CATEGORY_SETTING_PREFIX = 'library.category.'
export const LIBRARY_ITEM_SETTING_PREFIX = 'library.item.'

const CATEGORY_ID = /^category_[a-f0-9]{32}$/
const PUBLICATION_ID = /^[a-zA-Z0-9_-]{8,80}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

interface LibraryCategoryProjection {
  id: string
  name: string
  createdAt: string
}

interface LibraryItemProjection {
  customTitle: string | null
  categoryId: string | null
}

interface LibraryManagementProjection extends Record<string, unknown> {
  categories: LibraryCategoryProjection[]
  items: Record<string, LibraryItemProjection>
}

interface CategorySettingValue {
  id: string
  name: string
  createdAt: string
  state: 'present' | 'deleted'
  deletedAt: string | null
}

interface ItemSettingValue {
  publicationId: string
  customTitle: string | null
  categoryId: string | null
  state: 'present' | 'deleted'
  deletedAt: string | null
}

interface StoredSetting<T> {
  key: string
  value: T
  updatedAt: string
  deviceId: string
}

export function isLibraryEntitySettingKey(key: string): boolean {
  return key.startsWith(LIBRARY_CATEGORY_SETTING_PREFIX)
    || key.startsWith(LIBRARY_ITEM_SETTING_PREFIX)
}

export function isValidLibraryEntitySetting(key: string, value: unknown): boolean {
  return parseCategorySetting(key, value) !== null || parseItemSetting(key, value) !== null
}

/**
 * Persist the existing UI-shaped management object together with fine-grained
 * sync records. A savepoint keeps callers that already own a transaction safe.
 */
export function writeLibraryManagementSettings(
  database: DatabaseSync,
  deviceId: string,
  management: Record<string, unknown>,
  updatedAt = new Date().toISOString(),
): void {
  const normalized = normalizeManagementProjection(management)
  withSavepoint(database, () => {
    synchronizeFineGrainedSettings(database, normalized, updatedAt, deviceId)
    writeManagementMirror(database, normalized, updatedAt, deviceId)
  })
}

/**
 * Rebuild library.management after a portable/sync merge. Fine-grained v3
 * records are authoritative. A v2 management-only input is converted once so
 * old backups remain recoverable with their historical whole-record semantics.
 */
export function reconcileLibraryManagementSettings(
  database: DatabaseSync,
  options: { fineGrainedAuthoritative: boolean; legacyManagementChanged: boolean },
): void {
  if (!options.fineGrainedAuthoritative && !options.legacyManagementChanged) return
  if (options.legacyManagementChanged && !options.fineGrainedAuthoritative) {
    const legacy = readManagementRow(database)
    if (legacy) {
      synchronizeFineGrainedSettings(
        database,
        normalizeManagementProjection(parseObject(legacy.value)),
        legacy.updatedAt,
        legacy.deviceId,
      )
    }
  }
  rebuildManagementMirror(database)
}

function synchronizeFineGrainedSettings(
  database: DatabaseSync,
  management: LibraryManagementProjection,
  updatedAt: string,
  deviceId: string,
): void {
  const existingCategories = readCategorySettings(database)
  const existingItems = readItemSettings(database)
  const currentKeys = new Set<string>()

  for (const category of management.categories) {
    const key = categorySettingKey(category.id)
    currentKeys.add(key)
    upsertSetting(database, key, {
      id: category.id,
      name: category.name,
      createdAt: category.createdAt,
      state: 'present',
      deletedAt: null,
    } satisfies CategorySettingValue, updatedAt, deviceId)
  }
  for (const current of existingCategories.values()) {
    if (currentKeys.has(current.key) || current.value.state === 'deleted') continue
    upsertSetting(database, current.key, {
      ...current.value,
      state: 'deleted',
      deletedAt: updatedAt,
    }, updatedAt, deviceId)
  }

  currentKeys.clear()
  for (const [publicationId, item] of Object.entries(management.items)) {
    if (!item.customTitle && !item.categoryId) continue
    const key = itemSettingKey(publicationId)
    currentKeys.add(key)
    upsertSetting(database, key, {
      publicationId,
      customTitle: item.customTitle,
      categoryId: item.categoryId,
      state: 'present',
      deletedAt: null,
    } satisfies ItemSettingValue, updatedAt, deviceId)
  }
  for (const current of existingItems.values()) {
    if (currentKeys.has(current.key) || current.value.state === 'deleted') continue
    upsertSetting(database, current.key, {
      ...current.value,
      state: 'deleted',
      deletedAt: updatedAt,
    }, updatedAt, deviceId)
  }
}

function rebuildManagementMirror(database: DatabaseSync): void {
  const categories = [...readCategorySettings(database).values()]
    .filter((setting) => setting.value.state === 'present')
    .sort((left, right) => left.value.createdAt.localeCompare(right.value.createdAt)
      || left.value.id.localeCompare(right.value.id))
  const categoryIds = new Set(categories.map((setting) => setting.value.id))
  const deletedCategories = new Map([...readCategorySettings(database).values()]
    .filter((setting) => setting.value.state === 'deleted')
    .map((setting) => [setting.value.id, setting]))
  const items = readItemSettings(database)

  // Deleting a category also unassigns receiver-only publications. Persist the
  // derived relationship change so a later category revival cannot reattach it.
  for (const setting of items.values()) {
    if (setting.value.state !== 'present' || !setting.value.categoryId
      || categoryIds.has(setting.value.categoryId)) continue
    const categoryDeletion = deletedCategories.get(setting.value.categoryId)
    const changedAt = nextDerivedTimestamp(setting.updatedAt, categoryDeletion?.updatedAt)
    const changedBy = localDeviceId(database)
    const next: ItemSettingValue = {
      ...setting.value,
      categoryId: null,
      state: setting.value.customTitle ? 'present' : 'deleted',
      deletedAt: setting.value.customTitle ? null : changedAt,
    }
    upsertSetting(database, setting.key, next, changedAt, changedBy)
  }

  const managementRow = readManagementRow(database)
  const current = managementRow ? parseObject(managementRow.value) : {}
  const projectedCategories = disambiguateCategoryNames(categories.map((setting) => ({
    id: setting.value.id,
    name: setting.value.name,
    createdAt: setting.value.createdAt,
  })))
  const projectedItems: Record<string, LibraryItemProjection> = {}
  for (const setting of readItemSettings(database).values()) {
    if (setting.value.state !== 'present') continue
    const categoryId = setting.value.categoryId && categoryIds.has(setting.value.categoryId)
      ? setting.value.categoryId
      : null
    if (setting.value.customTitle || categoryId) {
      projectedItems[setting.value.publicationId] = {
        customTitle: setting.value.customTitle,
        categoryId,
      }
    }
  }
  const activeCategoryId = typeof current.activeCategoryId === 'string'
    && (current.activeCategoryId === 'all' || current.activeCategoryId === 'uncategorized'
      || categoryIds.has(current.activeCategoryId))
    ? current.activeCategoryId
    : 'all'
  const next = {
    ...current,
    activeCategoryId,
    categories: projectedCategories,
    items: projectedItems,
  }
  writeManagementMirror(database, normalizeManagementProjection(next), new Date().toISOString(), localDeviceId(database))
}

function normalizeManagementProjection(value: Record<string, unknown>): LibraryManagementProjection {
  const categories: LibraryCategoryProjection[] = []
  const categoryIds = new Set<string>()
  for (const candidate of Array.isArray(value.categories) ? value.categories : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    const id = typeof object.id === 'string' ? object.id : ''
    const name = normalizeText(object.name, 100)
    const createdAt = validTimestamp(object.createdAt) ? object.createdAt : new Date(0).toISOString()
    if (!CATEGORY_ID.test(id) || !name || categoryIds.has(id)) continue
    categoryIds.add(id)
    categories.push({ id, name, createdAt })
  }
  const items: Record<string, LibraryItemProjection> = {}
  if (value.items && typeof value.items === 'object' && !Array.isArray(value.items)) {
    for (const [publicationId, candidate] of Object.entries(value.items)) {
      if (!PUBLICATION_ID.test(publicationId) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const object = candidate as Record<string, unknown>
      const customTitle = normalizeText(object.customTitle, 200) || null
      const categoryId = typeof object.categoryId === 'string' && categoryIds.has(object.categoryId)
        ? object.categoryId
        : null
      if (customTitle || categoryId) items[publicationId] = { customTitle, categoryId }
    }
  }
  return { ...value, categories, items }
}

function disambiguateCategoryNames(categories: LibraryCategoryProjection[]): LibraryCategoryProjection[] {
  const result: LibraryCategoryProjection[] = []
  const used = new Set<string>()
  for (const category of [...categories].sort((left, right) => left.id.localeCompare(right.id))) {
    let name = category.name
    let folded = name.toLocaleLowerCase('zh-CN')
    if (used.has(folded)) {
      const suffix = ` (${category.id.slice(-6)})`
      name = `${truncateCodePoints(name, Math.max(1, 100 - suffix.length))}${suffix}`
      folded = name.toLocaleLowerCase('zh-CN')
      let index = 2
      while (used.has(folded)) {
        const numbered = ` ${index++}`
        name = `${truncateCodePoints(name, Math.max(1, 100 - numbered.length))}${numbered}`
        folded = name.toLocaleLowerCase('zh-CN')
      }
    }
    used.add(folded)
    result.push({ ...category, name })
  }
  return result.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function readCategorySettings(database: DatabaseSync): Map<string, StoredSetting<CategorySettingValue>> {
  const result = new Map<string, StoredSetting<CategorySettingValue>>()
  for (const row of readSettingRows(database, LIBRARY_CATEGORY_SETTING_PREFIX)) {
    const value = parseCategorySetting(row.key, parseJson(row.value))
    if (value) result.set(row.key, { ...row, value })
  }
  return result
}

function readItemSettings(database: DatabaseSync): Map<string, StoredSetting<ItemSettingValue>> {
  const result = new Map<string, StoredSetting<ItemSettingValue>>()
  for (const row of readSettingRows(database, LIBRARY_ITEM_SETTING_PREFIX)) {
    const value = parseItemSetting(row.key, parseJson(row.value))
    if (value) result.set(row.key, { ...row, value })
  }
  return result
}

function readSettingRows(database: DatabaseSync, prefix: string): Array<StoredSetting<string>> {
  return (database.prepare(`
    SELECT key,value,updated_at,device_id FROM settings
    WHERE key LIKE ? ESCAPE '\\' ORDER BY key
  `).all(`${escapeLike(prefix)}%`) as Array<Record<string, unknown>>).map((row) => ({
    key: String(row.key),
    value: String(row.value),
    updatedAt: String(row.updated_at),
    deviceId: String(row.device_id),
  }))
}

function readManagementRow(database: DatabaseSync): StoredSetting<string> | null {
  const row = database.prepare(`
    SELECT key,value,updated_at,device_id FROM settings WHERE key='library.management'
  `).get() as Record<string, unknown> | undefined
  return row ? {
    key: 'library.management',
    value: String(row.value),
    updatedAt: String(row.updated_at),
    deviceId: String(row.device_id),
  } : null
}

function writeManagementMirror(
  database: DatabaseSync,
  management: LibraryManagementProjection,
  updatedAt: string,
  deviceId: string,
): void {
  upsertEncodedSetting(database, 'library.management', JSON.stringify(management), updatedAt, deviceId)
}

function upsertSetting(
  database: DatabaseSync,
  key: string,
  value: CategorySettingValue | ItemSettingValue,
  updatedAt: string,
  deviceId: string,
): void {
  upsertEncodedSetting(database, key, JSON.stringify(value), updatedAt, deviceId)
}

function upsertEncodedSetting(
  database: DatabaseSync,
  key: string,
  value: string,
  updatedAt: string,
  deviceId: string,
): void {
  database.prepare(`
    INSERT INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id
    WHERE settings.value<>excluded.value
  `).run(key, value, updatedAt, deviceId)
}

function parseCategorySetting(key: string, value: unknown): CategorySettingValue | null {
  if (!key.startsWith(LIBRARY_CATEGORY_SETTING_PREFIX) || !isObject(value)) return null
  const id = key.slice(LIBRARY_CATEGORY_SETTING_PREFIX.length)
  if (!CATEGORY_ID.test(id) || value.id !== id || !exactKeys(value, ['id', 'name', 'createdAt', 'state', 'deletedAt'])) return null
  const name = normalizeText(value.name, 100)
  if (!name || value.name !== name || !validTimestamp(value.createdAt)
    || (value.state !== 'present' && value.state !== 'deleted')) return null
  const deletedAt = value.deletedAt === null ? null : validTimestamp(value.deletedAt) ? value.deletedAt : undefined
  if (deletedAt === undefined || (value.state === 'present' && deletedAt !== null)
    || (value.state === 'deleted' && deletedAt === null)) return null
  return { id, name, createdAt: value.createdAt, state: value.state, deletedAt }
}

function parseItemSetting(key: string, value: unknown): ItemSettingValue | null {
  if (!key.startsWith(LIBRARY_ITEM_SETTING_PREFIX) || !isObject(value)) return null
  const publicationId = key.slice(LIBRARY_ITEM_SETTING_PREFIX.length)
  if (!PUBLICATION_ID.test(publicationId) || value.publicationId !== publicationId
    || !exactKeys(value, ['publicationId', 'customTitle', 'categoryId', 'state', 'deletedAt'])) return null
  const customTitle = value.customTitle === null ? null : normalizeText(value.customTitle, 200)
  const categoryId = value.categoryId === null ? null : typeof value.categoryId === 'string' && CATEGORY_ID.test(value.categoryId)
    ? value.categoryId
    : undefined
  if (customTitle === '' || (value.customTitle !== null && value.customTitle !== customTitle)
    || categoryId === undefined || (value.state !== 'present' && value.state !== 'deleted')) return null
  const deletedAt = value.deletedAt === null ? null : validTimestamp(value.deletedAt) ? value.deletedAt : undefined
  if (deletedAt === undefined || (value.state === 'present' && deletedAt !== null)
    || (value.state === 'deleted' && deletedAt === null)) return null
  if (value.state === 'present' && !customTitle && !categoryId) return null
  return { publicationId, customTitle, categoryId, state: value.state, deletedAt }
}

function categorySettingKey(categoryId: string): string { return `${LIBRARY_CATEGORY_SETTING_PREFIX}${categoryId}` }
function itemSettingKey(publicationId: string): string { return `${LIBRARY_ITEM_SETTING_PREFIX}${publicationId}` }

function localDeviceId(database: DatabaseSync): string {
  const row = database.prepare("SELECT value FROM app_metadata WHERE key='device_id'").get() as { value?: unknown } | undefined
  return String(row?.value ?? 'unknown-device')
}

function withSavepoint(database: DatabaseSync, action: () => void): void {
  database.exec('SAVEPOINT library_management_sync')
  try {
    action()
    database.exec('RELEASE SAVEPOINT library_management_sync')
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT library_management_sync')
    database.exec('RELEASE SAVEPOINT library_management_sync')
    throw error
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value)
  return isObject(parsed) ? parsed : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function normalizeText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? truncateCodePoints(value.trim().replace(/\s+/g, ' '), limit)
    : ''
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value))
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

function nextDerivedTimestamp(...values: Array<string | undefined>): string {
  let milliseconds = Date.now()
  for (const value of values) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) milliseconds = Math.max(milliseconds, parsed + 1)
  }
  return new Date(milliseconds).toISOString()
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
