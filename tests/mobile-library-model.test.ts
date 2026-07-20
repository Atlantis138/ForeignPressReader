import { describe, expect, it } from 'vitest'
import {
  enterLibrarySelection,
  exitLibrarySelection,
  libraryCategoryCount,
  pruneLibrarySelection,
  selectAllLibraryPublications,
  toggleLibrarySelection,
  visibleLibraryPublications,
} from '../src/renderer/tauri/mobile-library-model'
import type { LibraryState, PublicationSummary } from '../src/shared/types'

function publication(id: string, title: string, importedAt: string, categoryId: string | null, creator: string): PublicationSummary {
  return { id, title, originalTitle: title, categoryId, creator, language: 'en', coverUrl: null, coverThumbnailUrl: null, coverThumbnailWidth: null, coverThumbnailHeight: null, importedAt, articleCount: 1, sectionCount: 1, lastArticleId: null }
}

const categoryId = `category_${'a'.repeat(32)}`
const base: LibraryState = {
  publications: [
    publication('publication_2', 'The Economist 10', '2026-02-01T00:00:00.000Z', categoryId, 'Economist'),
    publication('publication_1', 'The Economist 2', '2026-01-01T00:00:00.000Z', null, 'Economist'),
    publication('publication_3', 'Le Monde', '2026-03-01T00:00:00.000Z', null, 'Groupe Le Monde'),
  ],
  categories: [{ id: categoryId, name: '周刊', createdAt: '2026-01-01T00:00:00.000Z' }],
  preferences: { viewMode: 'grid', sortBy: 'name', sortDirection: 'asc', activeCategoryId: 'all' },
}

describe('Android E1 library presentation model', () => {
  it('applies stable locale-aware sorting without a library search model', () => {
    expect(visibleLibraryPublications(base).map((item) => item.title)).toEqual(['Le Monde', 'The Economist 2', 'The Economist 10'])
  })

  it('filters flat categories and reports category counts', () => {
    const uncategorized = { ...base, preferences: { ...base.preferences, activeCategoryId: 'uncategorized' } }
    expect(visibleLibraryPublications(uncategorized).map((item) => item.id)).toEqual(['publication_3', 'publication_1'])
    expect(libraryCategoryCount(base, 'all')).toBe(3)
    expect(libraryCategoryCount(base, 'uncategorized')).toBe(2)
    expect(libraryCategoryCount(base, categoryId)).toBe(1)
  })

  it('keeps selection mode independent from the number of selected publications', () => {
    let selection = enterLibrarySelection()
    expect(selection).toEqual({ mode: true, selectedIds: [] })
    selection = toggleLibrarySelection(selection, 'publication_1')
    expect(selection).toEqual({ mode: true, selectedIds: ['publication_1'] })
    selection = toggleLibrarySelection(selection, 'publication_1')
    expect(selection).toEqual({ mode: true, selectedIds: [] })
    expect(exitLibrarySelection()).toEqual({ mode: false, selectedIds: [] })
  })

  it('selects all visible publications, toggles them off, and prunes deleted ids', () => {
    const ids = ['publication_1', 'publication_2']
    const all = selectAllLibraryPublications(enterLibrarySelection(), ids)
    expect(all).toEqual({ mode: true, selectedIds: ids })
    expect(selectAllLibraryPublications(all, ids)).toEqual({ mode: true, selectedIds: [] })
    expect(pruneLibrarySelection({ mode: true, selectedIds: ['publication_1', 'deleted'] }, ids)).toEqual({ mode: true, selectedIds: ['publication_1'] })
  })
})
