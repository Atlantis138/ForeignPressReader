import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueDateFromPath, isOnlineCatalog, localEconomistIssue, parseIssueTree } from '../src/core/online-catalog'
import { OnlineCatalogService } from '../src/main/online-catalog-service'
import { LibraryService } from '../src/main/library-service'
import { SqliteApplicationRepository } from '../src/main/database'
import { EpubImporter } from '../src/main/epub-importer'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import type { ImportProgress, PublicationSummary } from '../src/shared/types'
import vectors from '../test-vectors/online-catalog-v1.json'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const issuePath = 'te_2026.10.03/TheEconomist.2026.10.03.epub'
const sha = 'a'.repeat(40), revision = 'b'.repeat(40)

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-online-test-')); roots.push(root)
  const db = await SqliteApplicationRepository.open(root, 'test')
  const progress: ImportProgress[] = []
  const library = new LibraryService(db, new PublicationFormatRegistry([{ id:'epub',name:'EPUB',extensions:['epub'],maxBytes:64*1024*1024,importer:new EpubImporter() }]), root, value=>progress.push(value))
  const bytes = await epub()
  let fail = false
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (fail) throw new Error('network error')
    if (url.includes('/branches/')) return Response.json({commit:{sha:revision,commit:{tree:{sha}}}})
    if (url.endsWith(`trees/${sha}`)) return Response.json({truncated:false,tree:[{path:'01_economist',type:'tree',sha}]})
    if (url.endsWith('?recursive=1')) return Response.json({truncated:false,tree:[{path:issuePath,type:'blob',mode:'100644',sha,size:bytes.length}]})
    return new Response(new Uint8Array(bytes), {headers:{'content-length':String(bytes.length)}})
  })
  const service = new OnlineCatalogService({ fetch }, library, db, root, value=>progress.push(value))
  return {root,db,progress,library,bytes,fetch,service,offline:()=>{fail=true}}
}

describe('online Economist catalog', () => {
  it('shares safe path/date vectors, ignores other assets and rejects incomplete trees', () => {
    for (const vector of vectors.paths) expect(issueDateFromPath(vector.path)).toBe(vector.date)
    const tree = {truncated:false,tree: vectors.paths.map((v,i)=>({path:v.path,sha:String(i).repeat(40),type:'blob',mode:'100644',size:100}))}
    expect(parseIssueTree(tree).map(i=>i.date)).toEqual(['2026-10-03','2025-12-27','2024-02-29'])
    expect(()=>parseIssueTree({...tree,truncated:true})).toThrow('不完整')
    expect(()=>parseIssueTree({truncated:false,tree:[{path:issuePath,sha,type:'blob',mode:'120000',size:50}]})).toThrow('没有')
    expect(isOnlineCatalog({revision,fetchedAt:new Date().toISOString(),issues:[{id:sha,path:'../x',date:null,bytes:10}]})).toBe(false)
    const oversized = Array.from({length:2001}, (_, index) => {
      const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0,10).replaceAll('-', '.')
      return {path:`te_${date}/TheEconomist.${date}.epub`,sha,type:'blob',mode:'100644',size:100}
    })
    expect(()=>parseIssueTree({truncated:false,tree:oversized})).toThrow('数量限制')
  })

  it('recognizes manually imported and renamed copies by original metadata', () => {
    const publications = [{id:'existing',title:'我的精读',originalTitle:'The Economist.2026.10.03'}] as PublicationSummary[]
    expect(localEconomistIssue(publications,'2026-10-03')?.id).toBe('existing')
    expect(localEconomistIssue(publications,'2026-09-26')).toBeUndefined()
  })

  it('persists a bounded catalog, reuses it across restarts, and falls back offline', async () => {
    const t=await setup()
    try {
      const [first,second]=await Promise.all([t.service.getCatalog(),t.service.getCatalog()])
      expect(first).toEqual(second);expect(t.fetch).toHaveBeenCalledTimes(3)
      t.offline()
      const restarted=new OnlineCatalogService({fetch:t.fetch},t.library,t.db,t.root)
      expect(await restarted.getCatalog()).toEqual(first)
      expect(t.fetch).toHaveBeenCalledTimes(3)
      expect(await restarted.getCatalog(true)).toMatchObject({stale:true,issues:first.issues})
    } finally {t.db.close()}
  })

  it('downloads a pinned revision, imports once and removes temporary EPUBs', async () => {
    const t=await setup()
    try {
      const result=await t.service.importIssue(sha)
      expect(result?.publication.originalTitle).toBe('TheEconomist.2026.10.03')
      expect(t.fetch.mock.calls.at(-1)?.[0]).toContain(`/${revision}/01_economist/${issuePath}`)
      expect(t.progress.some(p=>p.stage==='downloading' && p.completed===t.bytes.length)).toBe(true)
      expect(fs.readdirSync(path.join(t.root,'app-cache','online-downloads'))).toEqual([])
      const requests=t.fetch.mock.calls.length
      t.db.renameLibraryPublication(result!.publication.id,'我改过的名字')
      expect(await t.service.importIssue(sha)).toMatchObject({duplicate:true,publication:{id:result!.publication.id}})
      expect(t.fetch).toHaveBeenCalledTimes(requests)
      const files=fs.readdirSync(path.join(t.root,'library'),{recursive:true}).map(String)
      expect(files.some(name=>name.endsWith('.epub'))).toBe(false)
    } finally {t.db.close()}
  })

  it('rejects truncation and oversize before parsing, cleans up, and can retry', async () => {
    const t=await setup()
    try {
      await t.service.getCatalog()
      t.fetch.mockImplementationOnce(async()=>new Response(new Uint8Array(t.bytes.subarray(0,20))))
      await expect(t.service.importIssue(sha)).rejects.toThrow('下载未完成')
      expect(t.db.listPublications()).toEqual([])
      expect(fs.readdirSync(path.join(t.root,'app-cache','online-downloads'))).toEqual([])
      t.fetch.mockImplementationOnce(async()=>new Response(new Uint8Array(t.bytes.length+1)))
      await expect(t.service.importIssue(sha)).rejects.toThrow('超过')
      await expect(t.service.importIssue(sha)).resolves.toMatchObject({duplicate:false})
    } finally {t.db.close()}
  })

  it('cancels pending downloads without importing and blocks a concurrent local import', async () => {
    const t=await setup()
    try {
      await t.service.getCatalog()
      let started!:()=>void
      const ready=new Promise<void>(resolve=>{started=resolve})
      t.fetch.mockImplementationOnce(async(_url, init)=>new Promise((_resolve,reject)=>{
        started(); init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})
      }))
      const pending=t.service.importIssue(sha)
      await ready
      await expect(t.library.importFile('unused.epub')).rejects.toThrow('已有')
      t.service.cancelImport()
      await expect(pending).resolves.toBeNull()
      expect(t.db.listPublications()).toEqual([])
      expect(fs.readdirSync(path.join(t.root,'app-cache','online-downloads'))).toEqual([])
    } finally {t.db.close()}
  })

  it('rejects arbitrary URLs and unsafe or overlarge metadata', async () => {
    const t=await setup()
    try {
      await expect(t.service.importIssue('http://localhost/secret')).rejects.toThrow('编号')
      expect(t.fetch).not.toHaveBeenCalled()
      t.fetch.mockImplementationOnce(async()=>new Response('x'.repeat(2*1024*1024+1)))
      await expect(t.service.getCatalog()).rejects.toThrow('大小限制')
      expect(t.fetch).toHaveBeenCalledTimes(1)
    } finally {t.db.close()}
  })
})

async function epub() {
  const zip=new JSZip()
  zip.file('mimetype','application/epub+zip')
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
  zip.file('content.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>TheEconomist.2026.10.03</dc:title><dc:identifier>online-test-2026-10-03</dc:identifier></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>')
  zip.file('a.xhtml','<html><head><title>Test news</title></head><body><h1>Test news</h1><p>A short synthetic article for checking online imports.</p></body></html>')
  return zip.generateAsync({type:'nodebuffer'})
}
