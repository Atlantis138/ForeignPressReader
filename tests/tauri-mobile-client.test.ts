import { describe, expect, it } from 'vitest'
import { TauriMobileReadingClient } from '../src/renderer/tauri/mobile-client'
import type { LibraryState, PublicationDetail, ReaderPreferences } from '../src/shared/types'

const publication: PublicationDetail = {
  id: 'pub_0123456789abcdef01234567',
  title: 'Fixture Weekly',
  originalTitle: 'Fixture Weekly',
  categoryId: null,
  creator: null,
  language: 'en',
  coverUrl: null,
  coverThumbnailUrl: null,
  coverThumbnailWidth: null,
  coverThumbnailHeight: null,
  importedAt: '2026-07-12T00:00:00.000Z',
  articleCount: 0,
  sectionCount: 0,
  lastArticleId: null,
  sections: [],
  unsectionedArticles: [],
}

const preferences: ReaderPreferences = {
  theme: 'dark',
  fontSize: 21,
  lineHeight: 1.9,
  columnWidth: 760,
  paperTint: 50,
}

const libraryState: LibraryState = {
  publications: [publication],
  categories: [],
  preferences: { viewMode: 'grid', sortBy: 'importedAt', sortDirection: 'desc', activeCategoryId: 'all' },
}

describe('TauriMobileReadingClient', () => {
  it('receives native online download progress and cleans listeners after cancellation', async () => {
    let callback: (progress: import('../src/shared/types').ImportProgress & {requestId:string})=>void = ()=>{}
    let finish: (value: unknown)=>void = ()=>{}
    let requestId = ''
    const calls: string[]=[]
    let unlistened=false
    const client = new TauriMobileReadingClient(async <T>(command:string,args?:Record<string,unknown>):Promise<T>=>{
      calls.push(command)
      if(command==='begin_online_epub_import') { requestId=String(args?.requestId); return new Promise(resolve=>{finish=value=>resolve(value as T)}) }
      return undefined as T
    },undefined,async fn=>{callback=fn;return ()=>{unlistened=true}})
    const progress: string[]=[]
    client.onImportProgress(value=>progress.push(value.message??''))
    const pending=client.library.importOnlineIssue('a'.repeat(40))
    await new Promise(resolve=>setTimeout(resolve,0))
    callback({requestId,stage:'downloading',completed:10,total:100,message:'10% downloaded'})
    callback({requestId:'unrelated',stage:'downloading',completed:50,total:100,message:'unrelated'})
    expect(progress).toContain('10% downloaded');expect(progress).not.toContain('unrelated')
    await client.cancelImport()
    finish({kind:'ready',sessionId:'late-session',displayName:'sample.epub',bytes:100,entries:[],contentHash:'b'.repeat(64)})
    await expect(pending).resolves.toBeNull()
    expect(unlistened).toBe(true)
    expect(calls.filter(command=>command==='cancel_epub_import')).toHaveLength(2)
    expect(calls).not.toContain('commit_epub_import')
  })
  it('maps the mobile reading slice to narrow commands and handles native de-duplication', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args })
      if (command === 'begin_epub_import') {
        return { kind: 'duplicate', result: { publication, duplicate: true } } as T
      }
      if (command === 'list_mobile_publications') return [publication] as T
      if (command === 'get_mobile_publication') return publication as T
      if (command === 'get_mobile_reader_preferences' || command === 'save_mobile_reader_preferences') {
        return preferences as T
      }
      return undefined as T
    }
    const client = new TauriMobileReadingClient(invoke)

    await expect(client.importPublication()).resolves.toEqual({ publication, duplicate: true })
    await expect(client.listPublications()).resolves.toEqual([publication])
    await expect(client.getPublication(publication.id)).resolves.toEqual(publication)
    await expect(client.getPreferences()).resolves.toEqual(preferences)
    await expect(client.savePreferences(preferences)).resolves.toEqual(preferences)
    await expect(client.savePosition(publication.id, 'article-id', {
      scrollTop: 120,
      anchorBlockId: 'block-id',
      anchorTokenIndex: 4,
      anchorFraction: 0.5,
    })).resolves.toBeUndefined()

    expect(calls.map(({ command }) => command)).toEqual([
      'begin_epub_import',
      'list_mobile_publications',
      'get_mobile_publication',
      'get_mobile_reader_preferences',
      'save_mobile_reader_preferences',
      'save_mobile_reading_position',
    ])
    expect(calls[2].args).toEqual({ publicationId: publication.id })
    expect(calls[4].args).toEqual({ preferences })
    expect(calls[5].args).toMatchObject({ publicationId: publication.id, articleId: 'article-id' })
  })

  it('preserves structured native errors and cleans up a failed request', async () => {
    const calls: string[] = []
    const native = { code: 'invalidEpub', message: 'EPUB 结构已损坏。', retryable: false }
    const client = new TauriMobileReadingClient(async <T>(command: string): Promise<T> => {
      calls.push(command)
      if (command === 'cancel_epub_import') return undefined as T
      throw native
    })

    await expect(client.importPublication()).rejects.toEqual(native)
    expect(calls).toEqual(['begin_epub_import', 'cancel_epub_import'])
  })

  it('exposes typed library and reader facets while leaving E4 service slots absent', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const client = new TauriMobileReadingClient(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args })
      if (command === 'get_mobile_library_state' || command === 'save_mobile_library_preferences'
        || command === 'create_mobile_library_category' || command === 'rename_mobile_library_category'
        || command === 'delete_mobile_library_category' || command === 'rename_mobile_publication'
        || command === 'assign_mobile_publications' || command === 'delete_mobile_publications') return libraryState as T
      if (command === 'get_mobile_reader_preferences') return preferences as T
      return undefined as T
    })

    await client.library.getState()
    await client.library.savePreferences(libraryState.preferences)
    await client.library.createCategory('周刊')
    await client.library.renameCategory('category_' + 'a'.repeat(32), '精选')
    await client.library.deleteCategory('category_' + 'a'.repeat(32))
    await client.library.renamePublication(publication.id, '精读周刊')
    await client.library.assignPublications([publication.id], null)
    await client.library.deletePublications([publication.id])
    await expect(client.reader.getPreferences()).resolves.toEqual(preferences)

    expect(client.services).toEqual({ translation: null, speech: null })
    expect(calls.map((call) => call.command)).toEqual([
      'get_mobile_library_state', 'save_mobile_library_preferences', 'create_mobile_library_category',
      'rename_mobile_library_category', 'delete_mobile_library_category', 'rename_mobile_publication',
      'assign_mobile_publications', 'delete_mobile_publications', 'get_mobile_reader_preferences',
    ])
    expect(calls[6].args).toEqual({ publicationIds: [publication.id], categoryId: null })
  })

  it('settles the parser promise when the user cancels', async () => {
    const calls: string[] = []
    const originalWorker = globalThis.Worker
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(): void {}
      terminate(): void {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    try {
      const client = new TauriMobileReadingClient(async <T>(command: string): Promise<T> => {
        calls.push(command)
        if (command === 'begin_epub_import') {
          return {
            kind: 'ready',
            sessionId: 'session-id',
            displayName: 'fixture.epub',
            bytes: 42,
            contentHash: 'a'.repeat(64),
            entries: [],
          } as T
        }
        return undefined as T
      })
      const pending = client.importPublication()
      await new Promise((resolve) => setTimeout(resolve, 0))

      await client.cancelImport()

      await expect(pending).resolves.toBeNull()
      expect(calls).toContain('cancel_epub_import')
    } finally {
      globalThis.Worker = originalWorker
    }
  })
})
