// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OnlineIssuesDialog } from '../src/renderer/online/OnlineIssuesDialog'
import type { LibraryApi, PublicationSummary, ImportResult, ImportProgress } from '../src/shared/types'

afterEach(cleanup)
const issues=Array.from({length:10},(_,index)=>({id:String(index).repeat(40),date:`2026-09-${String(30-index).padStart(2,'0')}`,path:'test',bytes:1024*1024}))
const publication=(index:number)=>({id:`book-${index}`,title:'Renamed',originalTitle:`TheEconomist.${issues[index].date.replaceAll('-','.')}`} as PublicationSummary)
function setup(importIssue=vi.fn(async(id:string)=>({duplicate:false,publication:publication(Number(id[0]))} as ImportResult))) {
 let listener: (p:ImportProgress)=>void=()=>{}
 const client={getOnlineCatalog:vi.fn(async()=>({revision:'a'.repeat(40),fetchedAt:new Date().toISOString(),issues})),importOnlineIssue:importIssue,
 getState:vi.fn(async()=>({publications:[],categories:[],preferences:{}})),onImportProgress:(fn:typeof listener)=>{listener=fn;return ()=>{}},cancelImport:vi.fn(async()=>{})} as unknown as LibraryApi
 const onOpen=vi.fn(),onState=vi.fn()
 const view=render(<OnlineIssuesDialog library={client} publications={[publication(0),publication(2)]} onState={onState} onOpen={onOpen} onClose={vi.fn()}/>)
 return {client,onOpen,onState,view,emit:(p:ImportProgress)=>listener(p)}
}

it('one click fills only missing recent issues, keeping older history out of the batch',async()=>{
 const t=setup()
 fireEvent.click(await screen.findByRole('button',{name:'一键补齐 6 期'}))
 await screen.findByText(/本次已导入 6 期/)
 expect(t.client.importOnlineIssue).toHaveBeenCalledTimes(6)
 expect(vi.mocked(t.client.importOnlineIssue).mock.calls.map(call=>call[0])).toEqual([1,3,4,5,6,7].map(i=>issues[i].id))
 expect(t.onOpen).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'已全部下载'})).toBeTruthy()
})

it('opens an existing renamed issue without downloading and exposes history separately',async()=>{
 const t=setup()
 fireEvent.click((await screen.findAllByRole('button',{name:'阅读',exact:true}))[0])
 expect(t.onOpen).toHaveBeenCalledWith('book-0')
 expect(t.client.importOnlineIssue).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'查看历史期刊'}))
 expect(screen.getByText(issues[9].date.replaceAll('-','.'))).toBeTruthy()
})

it('keeps successful imports after one failure and allows retrying just that issue',async()=>{
 const importer=vi.fn(async(id:string)=>{if(id===issues[1].id)throw new Error('网络断开');return {publication:publication(Number(id[0])),duplicate:false} as ImportResult})
 const t=setup(importer)
 fireEvent.click(await screen.findByRole('button',{name:'一键补齐 6 期'}))
 await screen.findByText(/本次已导入 5 期，1 期失败/)
 expect(t.onState).toHaveBeenCalledTimes(5)
 importer.mockResolvedValueOnce({publication:publication(1),duplicate:false} as ImportResult)
 fireEvent.click(screen.getByRole('button',{name:'重试下载'}))
 await waitFor(()=>expect(t.onOpen).toHaveBeenCalledWith('book-1'))
})

it('stopping a batch never advances to the next issue and retains earlier imports',async()=>{
 let finish!:(result:ImportResult|null)=>void
 const importer=vi.fn(async(id:string)=>({publication:publication(Number(id[0])),duplicate:false} as ImportResult)).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 const t=setup(importer)
 fireEvent.click(await screen.findByRole('button',{name:'一键补齐 6 期'}))
 await screen.findByRole('button',{name:'停止下载'})
 fireEvent.click(screen.getByRole('button',{name:'停止下载'}))
 await act(async()=>finish(null))
 await screen.findByText(/已停止/)
 expect(importer).toHaveBeenCalledTimes(1)
 expect(t.client.cancelImport).toHaveBeenCalledTimes(1)
})
