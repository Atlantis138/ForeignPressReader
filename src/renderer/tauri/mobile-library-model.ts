import type { LibraryState, PublicationSummary } from '../../shared/types'

export interface LibrarySelectionState {
  mode: boolean
  selectedIds: string[]
}

export const EMPTY_LIBRARY_SELECTION: LibrarySelectionState = { mode: false, selectedIds: [] }

export function visibleLibraryPublications(state: LibraryState): PublicationSummary[] {
  const filtered = state.publications.filter((publication) => {
    const categoryMatches = state.preferences.activeCategoryId === 'all'
      || (state.preferences.activeCategoryId === 'uncategorized' && publication.categoryId === null)
      || publication.categoryId === state.preferences.activeCategoryId
    return categoryMatches
  })
  const direction = state.preferences.sortDirection === 'asc' ? 1 : -1
  return filtered.sort((left, right) => {
    const comparison = state.preferences.sortBy === 'name'
      ? left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' })
      : left.importedAt.localeCompare(right.importedAt)
    return comparison * direction || left.id.localeCompare(right.id)
  })
}

export function enterLibrarySelection(id?: string): LibrarySelectionState {
  return { mode: true, selectedIds: id ? [id] : [] }
}

export function exitLibrarySelection(): LibrarySelectionState {
  return EMPTY_LIBRARY_SELECTION
}

export function toggleLibrarySelection(state: LibrarySelectionState, id: string): LibrarySelectionState {
  const selected = new Set(state.selectedIds)
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  return { mode: true, selectedIds: [...selected] }
}

export function selectAllLibraryPublications(state: LibrarySelectionState, ids: readonly string[]): LibrarySelectionState {
  const allSelected = ids.length > 0 && ids.every((id) => state.selectedIds.includes(id))
  return { mode: true, selectedIds: allSelected ? [] : [...ids] }
}

export function pruneLibrarySelection(state: LibrarySelectionState, validIds: readonly string[]): LibrarySelectionState {
  const valid = new Set(validIds)
  const selectedIds = state.selectedIds.filter((id) => valid.has(id))
  return selectedIds.length === state.selectedIds.length ? state : { ...state, selectedIds }
}

export function libraryCategoryCount(state: LibraryState, categoryId: string): number {
  if (categoryId === 'all') return state.publications.length
  if (categoryId === 'uncategorized') return state.publications.filter((item) => item.categoryId === null).length
  return state.publications.filter((item) => item.categoryId === categoryId).length
}
