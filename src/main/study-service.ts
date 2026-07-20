import type {
  StudyAnswerRequest, StudyDashboard, StudyDebugState, StudyPlanDetail, StudyPlanInput,
  StudyPlanStatus, StudyPlanSummary, StudyPlanWordPage, StudyPlanWordQuery, StudyPreferences,
  StudySessionState, StudySourceSyncResult, StudyStageAnswerRequest, StudyTodayWordPage,
  StudyTodayWordQuery, StudyTooEasyRequest, StudyDeletePlanOptions,
} from '../shared/types'
import type { DictionaryService } from './dictionary-service'
import type { SqliteStudyRepository } from './study-repository'

export class StudyService {
  private syncing: Promise<StudySourceSyncResult> | null = null
  private syncAllRequested = false
  private readonly pendingPlanSyncs = new Set<string>()
  constructor(private readonly repository: SqliteStudyRepository, private readonly dictionary: DictionaryService) {}

  getDashboard(): StudyDashboard { return this.repository.getDashboard() }
  listPlans(includeArchived=false):StudyPlanSummary[]{return this.repository.listPlans(includeArchived)}
  async createPlan(input:StudyPlanInput):Promise<StudyPlanDetail>{const id=this.repository.createPlan(input);await this.syncSources(id);return this.repository.getPlan(id)}
  async updatePlan(id:string,input:StudyPlanInput):Promise<StudyPlanDetail>{this.repository.updatePlan(id,input);await this.syncSources(id);return this.repository.getPlan(id)}
  setPlanStatus(id:string,status:StudyPlanStatus):void{this.repository.setPlanStatus(id,status)}
  getPlan(id:string):StudyPlanDetail{return this.repository.getPlan(id)}
  listPlanWords(id:string,q:StudyPlanWordQuery):StudyPlanWordPage{return this.repository.listPlanWords(id,q)}
  setWordExcluded(id:string,key:string,value:boolean):void{this.repository.setWordExcluded(id,key,value)}
  setWordSuspended(key:string,value:boolean):void{this.repository.setWordSuspended(key,value)}
  listTodayWords(id:string,q:StudyTodayWordQuery):StudyTodayWordPage{return this.repository.listTodayWords(id,q)}
  openToday():StudySessionState{return this.repository.openToday()}
  async hydrateCurrentExamples(request:{sessionId:string;itemId:string;expectedVersion:number}){
    const key=this.repository.currentLexemeForHydration(request),existing=this.repository.listLexemeExamples(key)
    if(existing.length)return existing
    return this.repository.saveLexemeExamples(key,await this.dictionary.enrichLexemeExamples(key))
  }
  stageAnswer(r:StudyStageAnswerRequest):StudySessionState{return this.repository.stageAnswer(r)}
  commitAnswer(r:StudyAnswerRequest):StudySessionState{return this.repository.commitAnswer(r)}
  markTooEasy(r:StudyTooEasyRequest):StudySessionState{return this.repository.markTooEasy(r)}
  addExtraBatch(id:string):StudySessionState{return this.repository.addExtraBatch(id)}
  getPreferences():StudyPreferences{return this.repository.getPreferences()}
  savePreferences(v:StudyPreferences):StudyPreferences{return this.repository.savePreferences(v)}
  getDebugState():StudyDebugState{return this.repository.getDebugState()}
  setDeveloperMode(v:boolean):StudyDebugState{return this.repository.setDeveloperMode(v)}
  deletePlan(id:string,name:string,options?:StudyDeletePlanOptions):void{this.repository.deletePlan(id,name,options)}
  resetAllProgress(token:string):void{this.repository.resetAllProgress(token)}
  forceNextStudyDay(token:string):StudySessionState{return this.repository.forceNextStudyDay(token)}

  syncSources(planId?:string):Promise<StudySourceSyncResult>{
    if(planId)this.pendingPlanSyncs.add(planId)
    else this.syncAllRequested=true
    if(this.syncing)return this.syncing
    this.syncing=this.drainSyncQueue().finally(()=>{this.syncing=null})
    return this.syncing
  }
  private async drainSyncQueue():Promise<StudySourceSyncResult>{
    const total:StudySourceSyncResult={syncedSources:0,failedSources:0}
    while(this.syncAllRequested||this.pendingPlanSyncs.size){
      const all=this.syncAllRequested,plans=[...this.pendingPlanSyncs]
      this.syncAllRequested=false;this.pendingPlanSyncs.clear()
      const requests=all?[undefined]:plans
      for(const plan of requests){const result=await this.performSync(plan);total.syncedSources+=result.syncedSources;total.failedSources+=result.failedSources}
    }
    return total
  }
  private async performSync(planId?:string):Promise<StudySourceSyncResult>{
    const sources=this.repository.activeSources(planId),status=this.dictionary.getStatus();let syncedSources=0,failedSources=0
    for(const source of sources){
      const id=String(source.source_id),type=String(source.source_type)
      const version=type==='reader_manual'?this.repository.readerSourceRevision():`${status.version??'missing'}:${source.source_ref}`
      if(!this.repository.sourceNeedsSync(source,version))continue
      if(type==='exam_collection'&&!status.installed)continue
      this.repository.beginSourceSync(id)
      try{
        if(type==='reader_manual')this.repository.applySourceSnapshot(id,this.repository.readerSourceItems(),version)
        else{
          const items=[];let offset=0
          while(true){const page=await this.dictionary.listCollectionMembers(String(source.source_ref),offset,500);items.push(...page.items);offset+=page.items.length;if(!page.items.length||offset>=page.total)break}
          this.repository.applySourceSnapshot(id,items,version)
        }
        syncedSources++
      }catch(error){failedSources++;this.repository.failSourceSync(id,error instanceof Error?error.message:String(error))}
    }
    return{syncedSources,failedSources}
  }
}
