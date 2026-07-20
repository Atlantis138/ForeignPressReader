import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { SqliteStudyRepository } from '../src/main/study-repository'
import { mergeDailyPools, reinforcementInsertionIndex, weightedNewScore } from '../src/core/study/queue'

const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
const plan=(name='Plan A')=>({name,dailyNewLimit:20,dailyReviewLimit:100,sources:[{type:'reader_manual' as const,ref:'favorite'}]})
const word=(lemma:string,index=1)=>({lexemeKey:`lex_en_${String(index).repeat(24)}`,lemma,phonetic:null,briefMeanings:[lemma],senses:[],bnc:index,frequency:index})

describe('daily vocabulary study',()=>{
  it('stages answers, updates FSRS once and persists reinforcement recovery',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-'));roots.push(root)
    const db=await SqliteApplicationRepository.open(root,'test');let now=new Date('2026-07-07T02:00:00Z');const repo=new SqliteStudyRepository(db,()=>now)
    const first=repo.createPlan(plan()),second=repo.createPlan(plan('Plan B')),item=word('memory')
    for(const source of repo.activeSources())repo.applySourceSnapshot(String(source.source_id),[item],'reader:1')
    const page=repo.listPlanWords(first,{text:'mem',filter:'all',offset:0,limit:20})
    expect(page.total).toBe(1);expect(page.items[0].lexemeKey).toBe(item.lexemeKey)
    repo.setWordExcluded(first,page.items[0].lexemeKey,true);expect(repo.listPlanWords(first,{text:'',filter:'all',offset:0,limit:20}).total).toBe(0);repo.setWordExcluded(first,item.lexemeKey,false)
    let session=repo.openToday(),current=session.current!
    session=repo.stageAnswer({sessionId:session.sessionId,itemId:current.itemId,expectedVersion:current.version,answer:'unknown'})
    expect(session.current?.proposedAnswer).toBe('unknown')
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as {count:number}).count).toBe(0)
    const command=crypto.randomUUID();session=repo.commitAnswer({sessionId:session.sessionId,itemId:session.current!.itemId,expectedVersion:session.current!.version,commandId:command,answer:'unknown'})
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as {count:number}).count).toBe(1)
    expect(repo.commitAnswer({sessionId:session.sessionId,itemId:current.itemId,expectedVersion:0,commandId:command,answer:'unknown'}).sessionId).toBe(session.sessionId)
    session=answer(repo,session,'known');expect(session.current?.consecutiveKnown).toBe(1)
    const restored=new SqliteStudyRepository(db,()=>now).openToday();expect(restored.current?.consecutiveKnown).toBe(1)
    session=answer(repo,restored,'unknown');expect(session.current?.consecutiveKnown).toBe(0)
    session=answer(repo,session,'known');session=answer(repo,session,'known');expect(session.status).toBe('completed')
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as {count:number}).count).toBe(1)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM reinforcement_events').get() as {count:number}).count).toBe(4)
    expect(repo.getPlan(first).wordCount).toBe(1);expect(repo.getPlan(second).wordCount).toBe(1)
    db.close()
  })

  it('suspends too-easy words globally and restores them',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-easy-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test'),repo=new SqliteStudyRepository(db)
    const id=repo.createPlan(plan());repo.applySourceSnapshot(String(repo.activeSources()[0].source_id),[word('easy')],'reader:1')
    let session=repo.openToday();session=repo.markTooEasy({sessionId:session.sessionId,itemId:session.current!.itemId,expectedVersion:session.current!.version,commandId:crypto.randomUUID()})
    expect(session.status).toBe('completed');expect(repo.getPlan(id).distribution.suspended).toBe(1);expect(repo.listPlanWords(id,{text:'',filter:'suspended',offset:0,limit:20}).total).toBe(1)
    repo.setWordSuspended(word('easy').lexemeKey,false);expect(repo.getPlan(id).distribution.unseen).toBe(1);db.close()
  })

  it('keeps a session until its boundary and releases new words after carryover',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-clock-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test');let now=new Date('2026-07-07T02:00:00Z');const repo=new SqliteStudyRepository(db,()=>now)
    repo.createPlan({...plan('Carry'),dailyNewLimit:1});repo.applySourceSnapshot(String(repo.activeSources()[0].source_id),[word('alpha',1),word('beta',2)],'reader:2')
    const first=repo.openToday(),firstLemma=first.current!.lemma,boundary=String((db.getConnection().prepare('SELECT next_rollover_at FROM study_sessions WHERE session_id=?').get(first.sessionId) as {next_rollover_at:string}).next_rollover_at)
    now=new Date(Date.parse(boundary)-1000);expect(repo.openToday().sessionId).toBe(first.sessionId)
    now=new Date(Date.parse(boundary)+1000);let carried=repo.openToday();expect(carried.total).toBe(1)
    carried=answer(repo,carried,'known');expect(carried.status).toBe('active');expect(carried.total).toBe(2);expect(carried.current?.lemma).not.toBe(firstLemma);db.close()
  })

  it('debug next day advances to the next study boundary without overriding FSRS',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-next-day-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test');let now=new Date('2026-07-07T02:00:00Z');const repo=new SqliteStudyRepository(db,()=>now)
    repo.createPlan({...plan('Next day'),dailyNewLimit:1,dailyReviewLimit:10})
    repo.applySourceSnapshot(String(repo.activeSources()[0].source_id),[word('alpha',1),word('beta',2)],'reader:2')
    let session=repo.openToday()
    while(session.status==='active') session=answer(repo,session,'known')
    const firstBoundary=Date.parse(String((db.getConnection().prepare('SELECT next_rollover_at FROM study_sessions WHERE session_id=?').get(session.sessionId) as {next_rollover_at:string}).next_rollover_at))
    expect(Math.min(...(db.getConnection().prepare('SELECT due_at FROM review_cards').all() as {due_at:string}[]).map(row=>Date.parse(row.due_at)))).toBeGreaterThan(firstBoundary)
    repo.setDeveloperMode(true)
    const next=repo.forceNextStudyDay('NEXT_STUDY_DAY')
    expect((db.getConnection().prepare("SELECT COUNT(*) count FROM study_session_items WHERE session_id=? AND kind='review'").get(next.sessionId) as {count:number}).count).toBe(0)
    db.close()
  })

  it('reviews first-day unknown words on the next debug study day',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-next-day-again-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test');let now=new Date('2026-07-07T02:00:00Z');const repo=new SqliteStudyRepository(db,()=>now)
    repo.createPlan({...plan('Again next day'),dailyNewLimit:1,dailyReviewLimit:10})
    repo.applySourceSnapshot(String(repo.activeSources()[0].source_id),[word('alpha',1)],'reader:1')
    let session=repo.openToday()
    session=answer(repo,session,'unknown');session=answer(repo,session,'known');session=answer(repo,session,'known')
    expect(session.status).toBe('completed')
    repo.setDeveloperMode(true)
    const next=repo.forceNextStudyDay('NEXT_STUDY_DAY')
    expect((db.getConnection().prepare("SELECT COUNT(*) count FROM study_session_items WHERE session_id=? AND kind='review'").get(next.sessionId) as {count:number}).count).toBe(1)
    db.close()
  })

  it('debug reset clears algorithm progress without deleting plans or words',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-reset-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test'),repo=new SqliteStudyRepository(db)
    const id=repo.createPlan(plan('Reset'));repo.applySourceSnapshot(String(repo.activeSources()[0].source_id),[word('alpha',1)],'reader:1')
    let session=repo.openToday();session=answer(repo,session,'known');expect(session.status).toBe('completed')
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_cards').get() as {count:number}).count).toBe(1)
    repo.setDeveloperMode(true);repo.resetAllProgress('RESET_ALL_STUDY_PROGRESS')
    expect(repo.getPlan(id).wordCount).toBe(1)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_cards').get() as {count:number}).count).toBe(0)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as {count:number}).count).toBe(0)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM study_sessions').get() as {count:number}).count).toBe(0)
    expect(repo.openToday().current?.lemma).toBe('alpha')
    db.close()
  })

  it('debug deletes plans without blocking on active queues and can reset involved word progress',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-delete-'));roots.push(root);const db=await SqliteApplicationRepository.open(root,'test'),repo=new SqliteStudyRepository(db)
    const keep=repo.createPlan(plan('Keep')),drop=repo.createPlan(plan('Drop'))
    repo.applySourceSnapshot(String(repo.activeSources(keep)[0].source_id),[word('beta',2)],'reader:1')
    repo.applySourceSnapshot(String(repo.activeSources(drop)[0].source_id),[word('alpha',1)],'reader:1')
    expect(repo.openToday().total).toBe(2)
    repo.setDeveloperMode(true);repo.deletePlan(drop,'Drop',{resetWordProgress:false})
    expect(repo.listPlans(true).some(p=>p.planId===drop)).toBe(false)
    expect((db.getConnection().prepare("SELECT COUNT(*) count FROM study_session_items WHERE plan_id=? AND status IN ('pending','revealed')").get(drop) as {count:number}).count).toBe(0)
    expect(repo.openToday().total).toBe(1)

    const reset=repo.createPlan(plan('Reset scoped'));repo.applySourceSnapshot(String(repo.activeSources(reset)[0].source_id),[word('gamma',3)],'reader:1')
    repo.forceNextStudyDay('NEXT_STUDY_DAY')
    let session=repo.openToday();while(session.status==='active')session=answer(repo,session,'known')
    repo.setWordSuspended(word('gamma',3).lexemeKey,true)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_cards WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(1)
    const beforeScopedReset=db.exportPortableUserData()
    repo.deletePlan(reset,'Reset scoped',{resetWordProgress:true})
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM user_lexemes WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(1)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_cards WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_events WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM reinforcement_events WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    expect((db.getConnection().prepare('SELECT COUNT(*) count FROM review_suspensions WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    const afterScopedReset=db.exportPortableUserData()
    expect(afterScopedReset.studyLexemeResets).toEqual([expect.objectContaining({lexemeKey:word('gamma',3).lexemeKey})])
    const targetRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reader-study-reset-merge-'));roots.push(targetRoot)
    const target=await SqliteApplicationRepository.open(targetRoot,'test')
    target.mergePortableUserData(beforeScopedReset)
    expect((target.getConnection().prepare('SELECT COUNT(*) count FROM review_cards WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(1)
    target.mergePortableUserData(afterScopedReset)
    target.mergePortableUserData(beforeScopedReset)
    expect((target.getConnection().prepare('SELECT COUNT(*) count FROM review_cards WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    expect((target.getConnection().prepare('SELECT COUNT(*) count FROM review_events WHERE lexeme_key=?').get(word('gamma',3).lexemeKey) as {count:number}).count).toBe(0)
    target.close()
    db.close()
  })

  it('uses stable weighted selection, constrained mixing and non-immediate reinforcement',()=>{
    expect(weightedNewScore('day','word',1)).toBe(weightedNewScore('day','word',1))
    const mixed=mergeDailyPools(['r1','r2','r3','r4'],['n1','n2','n3','n4'],'mixed','day')
    expect(mixed).toHaveLength(8)
    expect(mixed.join(',')).not.toMatch(/r\d,r\d,r\d|n\d,n\d,n\d/)
    expect(reinforcementInsertionIndex('seed',5)).toBeGreaterThanOrEqual(1)
  })
})

function answer(repo:SqliteStudyRepository,session:ReturnType<SqliteStudyRepository['openToday']>,value:'known'|'unknown'){
  const staged=repo.stageAnswer({sessionId:session.sessionId,itemId:session.current!.itemId,expectedVersion:session.current!.version,answer:value})
  return repo.commitAnswer({sessionId:staged.sessionId,itemId:staged.current!.itemId,expectedVersion:staged.current!.version,commandId:crypto.randomUUID(),answer:value})
}
