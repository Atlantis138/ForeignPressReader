import fs from 'node:fs'
import path from 'node:path'
import { dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import type {
  DictionaryLookupRequest,
  DictionaryPreferences,
  DictionarySearchQuery,
  KeyStatus,
  LibraryPreferences,
  ReaderPreferences,
  ReadingPositionInput,
  RemoteSpeechProviderId,
  SpeechPreferences,
  SpeechSettings,
  SpeechSynthesisRequest,
  StudyAnswerRequest,
  StudyDeletePlanOptions,
  StudyPlanInput,
  StudyPlanStatus,
  StudyPlanWordQuery,
  StudyPreferences,
  StudyStageAnswerRequest,
  StudyTodayWordQuery,
  StudyTooEasyRequest,
  TranslationPreferences,
  TranslationSettings,
  VocabularyListQuery,
} from '../shared/types'
import type { SpeechProviderRegistry } from '../core/speech-providers'
import { SqliteApplicationRepository } from './database'
import { DeveloperService } from './developer-service'
import { DictionaryService } from './dictionary-service'
import { LanSyncService } from './lan-sync-service'
import { LibraryService } from './library-service'
import { PortableDataService } from './portable-data-service'
import { isTrustedRendererUrl } from './renderer-security'
import { SecretStore } from './secret-store'
import { SpeechSynthesisService } from './speech-service'
import { StorageService } from './storage-service'
import { StudyService } from './study-service'
import {
  TranslationService,
  type TranslationProviderRegistry,
} from './translation-service'
import { VocabularyService } from './vocabulary-service'

export function registerApplicationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  mainWindow: BrowserWindow,
  devServerUrl: string | undefined,
  library: LibraryService,
  db: SqliteApplicationRepository,
  secrets: SecretStore,
  translator: TranslationService,
  translationProviders: TranslationProviderRegistry,
  speechSynthesis: SpeechSynthesisService,
  speechProviders: SpeechProviderRegistry,
  dictionary: DictionaryService,
  vocabulary: VocabularyService,
  study: StudyService,
  portableData: PortableDataService,
  storage: StorageService,
  lanSync: LanSyncService,
  developer: DeveloperService,
  userDataPath: string,
): void {
  const assertTrustedSender = (url: string): void => {
    if (!isTrustedRendererUrl(url, devServerUrl)) throw new Error('拒绝来自未知页面的请求')
  }
  ipcMain.handle('library:importPublication', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入出版物',
      properties: ['openFile'],
      filters: library.getImportDialogOptions(),
    })
    if (result.canceled || !result.filePaths[0]) return null
    return library.importFile(result.filePaths[0])
  })
  ipcMain.handle('library:cancelImport', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    library.cancelImport()
  })
  ipcMain.handle('library:listPublications', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.listPublications()
  })
  ipcMain.handle('library:getState', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.getLibraryState()
  })
  ipcMain.handle('library:savePreferences', (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.saveLibraryPreferences(requireLibraryPreferences(input))
  })
  ipcMain.handle('library:createCategory', (event, name: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.createLibraryCategory(requireLibraryName(name))
  })
  ipcMain.handle('library:renameCategory', (event, categoryId: unknown, name: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.renameLibraryCategory(requireCategoryId(categoryId), requireLibraryName(name))
  })
  ipcMain.handle('library:deleteCategory', (event, categoryId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.deleteLibraryCategory(requireCategoryId(categoryId))
  })
  ipcMain.handle('library:renamePublication', (event, publicationId: unknown, title: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.renameLibraryPublication(requireId(publicationId), requireLibraryName(title, 200))
  })
  ipcMain.handle('library:assignPublications', (event, publicationIds: unknown, categoryId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.assignLibraryPublications(requirePublicationIds(publicationIds), categoryId == null ? null : requireCategoryId(categoryId))
  })
  ipcMain.handle('library:deletePublications', async (event, publicationIds: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    await library.removeImportedPublications(requirePublicationIds(publicationIds))
    return db.getLibraryState()
  })
  ipcMain.handle('library:getPublication', (event, id: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.getPublication(requireId(id))
  })
  ipcMain.handle('reader:getArticle', (event, id: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.getArticle(requireId(id))
  })
  ipcMain.handle(
    'reader:savePosition',
    (event, publicationId: unknown, articleId: unknown, position: unknown) => {
      assertTrustedSender(event.senderFrame?.url ?? '')
      db.savePosition(requireId(publicationId), requireId(articleId), requireReadingPosition(position))
    },
  )
  ipcMain.handle('reader:getPreferences', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.getPreferences()
  })
  ipcMain.handle('reader:savePreferences', (event, preferences: ReaderPreferences) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.savePreferences(preferences)
  })
  ipcMain.handle('speech:getPreferences', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.getSpeechPreferences()
  })
  ipcMain.handle('speech:savePreferences', (event, preferences: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return db.saveSpeechPreferences(speechProviders.normalize(preferences as Partial<SpeechPreferences>))
  })
  ipcMain.handle('speech:getSettings', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return buildSpeechSettings(db, secrets, speechProviders)
  })
  ipcMain.handle('speech:saveProviderKey', async (event, providerId: unknown, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const provider = speechProviders.getRemote(requireSpeechProviderId(providerId, speechProviders))
    if (typeof key !== 'string') throw new Error('API Key 格式无效')
    await secrets.saveApiKey(key, provider.credentialId!)
    return buildSpeechSettings(db, secrets, speechProviders)
  })
  ipcMain.handle('speech:deleteProviderKey', async (event, providerId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const provider = speechProviders.getRemote(requireSpeechProviderId(providerId, speechProviders))
    await secrets.deleteApiKey(provider.credentialId!)
    return buildSpeechSettings(db, secrets, speechProviders)
  })
  ipcMain.handle('speech:testConnection', (event, providerId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return speechSynthesis.testConnection(requireSpeechProviderId(providerId, speechProviders))
  })
  ipcMain.handle('speech:synthesize', (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return speechSynthesis.synthesize(requireSpeechSynthesisRequest(input, speechProviders))
  })
  ipcMain.handle('translation:translateArticle', (event, articleId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return translator.translateArticle(requireId(articleId))
  })
  ipcMain.handle('translation:cancel', (event, articleId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    translator.cancel(requireId(articleId))
  })
  ipcMain.handle('settings:getTranslationSettings', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return buildTranslationSettings(db, secrets, translationProviders)
  })
  ipcMain.handle('settings:saveTranslationPreferences', async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const preferences = requireTranslationPreferences(input)
    translationProviders.resolve(preferences)
    db.saveTranslationPreferences(preferences)
    return buildTranslationSettings(db, secrets, translationProviders)
  })
  ipcMain.handle('settings:saveProviderKey', async (event, providerId: unknown, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const provider = translationProviders.get(requireProviderId(providerId))
    if (typeof key !== 'string') throw new Error('API Key 格式无效')
    await secrets.saveApiKey(key, provider.id)
    return buildTranslationSettings(db, secrets, translationProviders)
  })
  ipcMain.handle('settings:deleteProviderKey', async (event, providerId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const provider = translationProviders.get(requireProviderId(providerId))
    await secrets.deleteApiKey(provider.id)
    return buildTranslationSettings(db, secrets, translationProviders)
  })
  ipcMain.handle('settings:testTranslationConnection', (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const preferences = requireTranslationPreferences(input)
    translationProviders.resolve(preferences)
    return translator.testConnection(preferences)
  })
  ipcMain.handle('settings:openDataDirectory', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const message = await shell.openPath(userDataPath)
    if (message) throw new Error(message)
  })
  ipcMain.handle('dictionary:getStatus', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.getStatus()
  })
  ipcMain.handle('dictionary:install', async (event, profile: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    await dictionary.install(requireDictionaryProfile(profile))
  })
  ipcMain.handle('dictionary:installFromLocal', async (event, profile: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 ECDICT CSV 文件',
      properties: ['openFile'],
      filters: [{ name: 'ECDICT CSV', extensions: ['csv'] }],
    })
    if (result.canceled || !result.filePaths[0]) return false
    const csvPath = result.filePaths[0]
    const siblingLemma = path.join(path.dirname(csvPath), 'lemma.en.txt')
    await dictionary.installFromLocal(csvPath, fs.existsSync(siblingLemma) ? siblingLemma : undefined, requireDictionaryProfile(profile))
    return true
  })
  ipcMain.handle('dictionary:cancelInstall', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    await dictionary.installer.cancel()
  })
  ipcMain.handle('dictionary:remove', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    await dictionary.remove()
  })
  ipcMain.handle('dictionary:removeFullExtension', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    await dictionary.removeFullExtension()
  })
  ipcMain.handle('dictionary:saveBaiduCredentials', async (event, apiKey: unknown, secretKey: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if(typeof apiKey!=='string'||typeof secretKey!=='string')throw new Error('百度词典凭据格式无效')
    try{await dictionary.saveBaiduCredentials(apiKey,secretKey);return{ok:true,message:'百度词典连接成功'}}catch(error){return{ok:false,message:error instanceof Error?error.message:'百度词典连接失败'}}
  })
  ipcMain.handle('dictionary:getCredentialStatus', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.getCredentialStatus()
  })
  ipcMain.handle('dictionary:deleteBaiduCredentials', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? ''); await dictionary.deleteBaiduCredentials()
  })
  ipcMain.handle('dictionary:testBaiduConnection', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    try{await dictionary.testBaiduConnection();return{ok:true,message:'百度词典连接成功'}}catch(error){return{ok:false,message:error instanceof Error?error.message:'百度词典连接失败'}}
  })
  ipcMain.handle('dictionary:lookup', (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.lookup(requireLookupRequest(request))
  })
  ipcMain.handle('dictionary:lookupInContext', (event, request: unknown, preferredLexemeKey: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.lookupInContext(
      requireLookupRequest(request),
      preferredLexemeKey == null ? undefined : requireLexemeKey(preferredLexemeKey),
    )
  })
  ipcMain.handle('dictionary:search', (event, query: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.search(requireDictionarySearch(query))
  })
  ipcMain.handle('dictionary:getLexeme', (event, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.getLexeme(requireLexemeKey(key))
  })
  ipcMain.handle('dictionary:listCollections', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.listCollections()
  })
  ipcMain.handle('dictionary:explainContext', (event, request: unknown, preferredLexemeKey: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.explainContext(
      requireLookupRequest(request),
      preferredLexemeKey == null ? undefined : requireLexemeKey(preferredLexemeKey),
    )
  })
  ipcMain.handle('dictionary:getPreferences', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.getPreferences()
  })
  ipcMain.handle('dictionary:savePreferences', (event, preferences: DictionaryPreferences) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return dictionary.savePreferences(preferences)
  })
  ipcMain.handle('vocabulary:getReaderState', (event, request: unknown, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return vocabulary.getReaderState(requireLookupRequest(request), requireLexemeKey(key))
  })
  ipcMain.handle('vocabulary:setFavorite', async (event, request: unknown, key: unknown, favorite: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const result = await vocabulary.setFavorite(
      requireLookupRequest(request), requireLexemeKey(key), requireBoolean(favorite),
    )
    await study.syncSources()
    return result
  })
  ipcMain.handle('vocabulary:setContextSaved', (event, request: unknown, key: unknown, saved: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return vocabulary.setContextSaved(
      requireLookupRequest(request), requireLexemeKey(key), requireBoolean(saved),
    )
  })
  ipcMain.handle('vocabulary:listFavorites', (event, query: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return vocabulary.listFavorites(requireVocabularyListQuery(query))
  })
  ipcMain.handle('vocabulary:listContexts', (event, key: unknown, offset: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return vocabulary.listContexts(requireLexemeKey(key), requireOffset(offset))
  })
  ipcMain.handle('vocabulary:removeFavorite', async (event, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    vocabulary.removeFavorite(requireLexemeKey(key))
    await study.syncSources()
  })
  ipcMain.handle('study:getDashboard', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.getDashboard() })
  ipcMain.handle('study:listPlans', (event, includeArchived: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.listPlans(includeArchived === true) })
  ipcMain.handle('study:createPlan', (event, input: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.createPlan(requireStudyPlanInput(input)) })
  ipcMain.handle('study:updatePlan', (event, id: unknown, input: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.updatePlan(requireId(id),requireStudyPlanInput(input)) })
  ipcMain.handle('study:setPlanStatus', (event, id: unknown, status: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); study.setPlanStatus(requireId(id),requireStudyPlanStatus(status)) })
  ipcMain.handle('study:getPlan', (event, id: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.getPlan(requireId(id)) })
  ipcMain.handle('study:listPlanWords', (event, id: unknown, query: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.listPlanWords(requireId(id),requireStudyPlanWordQuery(query)) })
  ipcMain.handle('study:setWordExcluded', (event, id: unknown, key: unknown, excluded: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); study.setWordExcluded(requireId(id),requireLexemeKey(key),requireBoolean(excluded)) })
  ipcMain.handle('study:setWordSuspended', (event, key: unknown, suspended: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); study.setWordSuspended(requireLexemeKey(key),requireBoolean(suspended)) })
  ipcMain.handle('study:listTodayWords', (event, id: unknown, query: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.listTodayWords(requireId(id),requireStudyTodayWordQuery(query)) })
  ipcMain.handle('study:openToday', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.openToday() })
  ipcMain.handle('study:hydrateCurrentExamples', (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const value=request as Record<string,unknown>
    return study.hydrateCurrentExamples({sessionId:requireId(value?.sessionId),itemId:requireId(value?.itemId),expectedVersion:requireOffset(value?.expectedVersion)})
  })
  ipcMain.handle('study:stageAnswer', (event, request: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.stageAnswer(requireStudyStage(request)) })
  ipcMain.handle('study:commitAnswer', (event, request: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.commitAnswer(requireStudyAnswer(request)) })
  ipcMain.handle('study:markTooEasy', (event, request: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.markTooEasy(requireStudyTooEasy(request)) })
  ipcMain.handle('study:addExtraBatch', (event, id: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.addExtraBatch(requireId(id)) })
  ipcMain.handle('study:syncSources', (event, id: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.syncSources(id==null?undefined:requireId(id)) })
  ipcMain.handle('study:getPreferences', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.getPreferences() })
  ipcMain.handle('study:savePreferences', (event, value: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.savePreferences(requireStudyPreferences(value)) })
  ipcMain.handle('study:getDebugState', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.getDebugState() })
  ipcMain.handle('study:setDeveloperMode', (event, value: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.setDeveloperMode(requireBoolean(value)) })
  ipcMain.handle('study:deletePlan', (event, id: unknown, name: unknown, options: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); study.deletePlan(requireId(id),requireShortText(name,'计划名称'),requireStudyDeletePlanOptions(options)) })
  ipcMain.handle('study:resetAllProgress', (event, token: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); study.resetAllProgress(requireShortText(token,'确认标识')) })
  ipcMain.handle('study:forceNextStudyDay', (event, token: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return study.forceNextStudyDay(requireShortText(token,'确认标识')) })
  ipcMain.handle('data:getStatus', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return portableData.getStatus()
  })
  ipcMain.handle('data:exportPortable', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const date = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出便携备份',
      defaultPath: `外刊阅读器-${date}.fprbackup`,
      filters: [{ name: '外刊阅读器便携备份', extensions: ['fprbackup'] }],
    })
    if (result.canceled || !result.filePath) return null
    return portableData.exportPortable(result.filePath)
  })
  ipcMain.handle('data:selectPortableImport', async (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择便携备份', properties: ['openFile'],
      filters: [{ name: '外刊阅读器便携备份', extensions: ['fprbackup'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return portableData.inspectImport(result.filePaths[0])
  })
  ipcMain.handle('data:confirmPortableImport', (event, token: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/i.test(token)) throw new Error('无效的导入任务')
    return portableData.confirmImport(token)
  })
  ipcMain.handle('data:cancelTransfer', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    portableData.cancel()
  })
  ipcMain.handle('storage:scan', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return storage.scan()
  })
  ipcMain.handle('storage:clearSafeCache', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return storage.clearSafeCache()
  })
  ipcMain.handle('storage:clearAiTextCache', (event, token: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return storage.clearAiTextCache(requireShortText(token, '确认标识'))
  })
  ipcMain.handle('sync:openPage', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.openPage() })
  ipcMain.handle('sync:closePage', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.closePage() })
  ipcMain.handle('sync:getState', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.getState() })
  ipcMain.handle('sync:refreshDiscovery', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.refreshDiscovery() })
  ipcMain.handle('sync:startPairing', (event, deviceId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.startPairing(requireId(deviceId)) })
  ipcMain.handle('sync:confirmPairing', (event, sessionId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.confirmPairing(requireId(sessionId)) })
  ipcMain.handle('sync:rejectPairing', (event, sessionId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.rejectPairing(requireId(sessionId)) })
  ipcMain.handle('sync:sendTo', (event, deviceId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.sendTo(requireId(deviceId)) })
  ipcMain.handle('sync:acceptIncoming', (event, transferId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.acceptIncoming(requireId(transferId)) })
  ipcMain.handle('sync:rejectIncoming', (event, transferId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.rejectIncoming(requireId(transferId)) })
  ipcMain.handle('sync:cancelOperation', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.cancelOperation() })
  ipcMain.handle('sync:discardPendingTransfer', (event, transferId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.discardPendingTransfer(requireId(transferId)) })
  ipcMain.handle('sync:revokeTrust', (event, deviceId: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return lanSync.revokeTrust(requireId(deviceId)) })
  ipcMain.handle('developer:getState', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return developer.getState() })
  ipcMain.handle('developer:setEnabled', (event, value: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return developer.setEnabled(requireBoolean(value)) })
  ipcMain.handle('developer:setLoggingEnabled', (event, value: unknown) => { assertTrustedSender(event.senderFrame?.url ?? ''); return developer.setLoggingEnabled(requireBoolean(value)) })
  ipcMain.handle('developer:openLogDirectory', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return developer.openLogDirectory() })
  ipcMain.handle('developer:clearLogs', (event) => { assertTrustedSender(event.senderFrame?.url ?? ''); return developer.clearLogs() })
  ipcMain.handle('developer:factoryReset', (event, token: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return developer.factoryReset(requireShortText(token, '确认短语'))
  })
}

async function buildTranslationSettings(
  db: SqliteApplicationRepository,
  secrets: SecretStore,
  providers: TranslationProviderRegistry,
): Promise<TranslationSettings> {
  const statuses = new Map<string, KeyStatus>()
  await Promise.all(providers.list().map(async (provider) => {
    statuses.set(provider.id, await secrets.status(provider.id))
  }))
  return {
    preferences: db.getTranslationPreferences(),
    providers: providers.toOptions(statuses),
  }
}

async function buildSpeechSettings(
  db: SqliteApplicationRepository,
  secrets: SecretStore,
  providers: SpeechProviderRegistry,
): Promise<SpeechSettings> {
  const statuses = new Map<string, KeyStatus>()
  await Promise.all(providers.list().filter((provider) => provider.requiresApiKey).map(async (provider) => {
    statuses.set(provider.id, await secrets.status(provider.credentialId!))
  }))
  return {
    preferences: db.getSpeechPreferences(),
    providers: providers.toOptions(statuses),
  }
}

function requireProviderId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(value)) {
    throw new Error('无效的翻译供应商')
  }
  return value
}

function requireSpeechProviderId(value: unknown, providers: SpeechProviderRegistry): RemoteSpeechProviderId {
  if (typeof value !== 'string' || value.length > 80 || !/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error('无效的语音供应商')
  }
  providers.getRemote(value)
  return value
}

function requireSpeechSynthesisRequest(value: unknown, providers: SpeechProviderRegistry): SpeechSynthesisRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的语音合成请求')
  const input = value as Partial<SpeechSynthesisRequest>
  const providerId = requireSpeechProviderId(input.providerId, providers)
  const locale = input.locale === 'en-GB' ? 'en-GB' : input.locale === 'en-US' ? 'en-US' : null
  if (!locale || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4_000
    || typeof input.modelId !== 'string' || input.modelId.length > 80
    || typeof input.voiceId !== 'string' || input.voiceId.length > 256 || !/^[a-zA-Z0-9_() -]+$/.test(input.voiceId)
    || typeof input.rate !== 'number' || !Number.isFinite(input.rate) || input.rate < 0.5 || input.rate > 2) {
    throw new Error('无效的语音合成请求')
  }
  const provider = providers.getRemote(providerId)
  if (!provider.models.some((model) => model.id === input.modelId)
    || !provider.voices.some((voice) => voice.id === input.voiceId && voice.locales.includes(locale))) {
    throw new Error(`${provider.name} 不支持所选模型或声音`)
  }
  return { providerId, modelId: input.modelId, text: input.text, locale, voiceId: input.voiceId, rate: input.rate }
}

function requireLibraryPreferences(value: unknown): LibraryPreferences {
  if (!value || typeof value !== 'object') throw new Error('无效的书库设置')
  const input = value as Partial<LibraryPreferences>
  if (!['grid', 'list'].includes(String(input.viewMode))
    || !['name', 'importedAt'].includes(String(input.sortBy))
    || !['asc', 'desc'].includes(String(input.sortDirection))
    || typeof input.activeCategoryId !== 'string') throw new Error('无效的书库设置')
  return input as LibraryPreferences
}

function requireLibraryName(value: unknown, maxLength = 100): string {
  if (typeof value !== 'string') throw new Error('名称格式无效')
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
  if (!normalized) throw new Error('名称不能为空')
  return normalized
}

function requireCategoryId(value: unknown): string {
  if (typeof value !== 'string' || !/^category_[a-f0-9]{32}$/.test(value)) throw new Error('无效的分类标识')
  return value
}

function requirePublicationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) throw new Error('请选择有效的书籍')
  return [...new Set(value.map(requireId))]
}

function requireTranslationPreferences(value: unknown): TranslationPreferences {
  if (!value || typeof value !== 'object') throw new Error('无效的翻译设置')
  const input = value as Partial<TranslationPreferences>
  if (typeof input.modelId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(input.modelId)) {
    throw new Error('无效的翻译模型')
  }
  return {
    providerId: requireProviderId(input.providerId),
    modelId: input.modelId,
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
    throw new Error('无效的内容标识')
  }
  return value
}

function requireReadingPosition(value: unknown): ReadingPositionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid reading position')
  }
  const keys = Object.keys(value)
  const allowedKeys = new Set(['scrollTop', 'anchorBlockId', 'anchorTokenIndex', 'anchorFraction'])
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error('Invalid reading position')
  }
  const input = value as Partial<ReadingPositionInput>
  if (typeof input.scrollTop !== 'number' || !Number.isFinite(input.scrollTop) || input.scrollTop < 0) {
    throw new Error('Invalid reading scroll offset')
  }
  const anchorBlockId = input.anchorBlockId === null ? null : requireId(input.anchorBlockId)
  if (input.anchorTokenIndex !== null
    && (typeof input.anchorTokenIndex !== 'number'
      || !Number.isSafeInteger(input.anchorTokenIndex)
      || input.anchorTokenIndex < 0
      || input.anchorTokenIndex > 1_000_000)) {
    throw new Error('Invalid reading token anchor')
  }
  if (anchorBlockId === null && input.anchorTokenIndex !== null) {
    throw new Error('Invalid reading token anchor')
  }
  if (typeof input.anchorFraction !== 'number'
    || !Number.isFinite(input.anchorFraction)
    || input.anchorFraction < 0
    || input.anchorFraction > 1) {
    throw new Error('Invalid reading block fraction')
  }
  return {
    scrollTop: input.scrollTop,
    anchorBlockId,
    anchorTokenIndex: input.anchorTokenIndex,
    anchorFraction: input.anchorFraction,
  }
}

function requireLookupRequest(value: unknown): DictionaryLookupRequest {
  if (!value || typeof value !== 'object') throw new Error('无效的查词请求')
  const request = value as Partial<DictionaryLookupRequest>
  const articleId = requireId(request.articleId)
  const blockId = requireId(request.blockId)
  if (typeof request.surface !== 'string' || request.surface.length < 1 || request.surface.length > 100) {
    throw new Error('无效的单词')
  }
  const tokenIndex = Number(request.tokenIndex)
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 10_000) throw new Error('无效的词元位置')
  return { articleId, blockId, surface: request.surface, tokenIndex }
}

function requireLexemeKey(value: unknown): string {
  if (typeof value !== 'string' || !/^lex_[a-z]{2,8}_[a-f0-9]{24}$/.test(value)) throw new Error('无效的词条标识')
  return value
}

function requireOffset(value: unknown): number {
  if (value == null) return 0
  const offset = Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('无效的分页位置')
  return offset
}

function requireDictionaryProfile(value: unknown): 'standard'|'full' {
  return value === 'full' ? 'full' : 'standard'
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('无效的布尔参数')
  return value
}

function requireVocabularyListQuery(value: unknown): VocabularyListQuery {
  if (!value || typeof value !== 'object') throw new Error('无效的生词列表条件')
  const input = value as Partial<VocabularyListQuery>
  return {
    text: typeof input.text === 'string' ? input.text.normalize('NFKC').trim().slice(0, 100) : '',
    offset: requireOffset(input.offset),
    limit: Math.min(50, Math.max(1, Number(input.limit) || 30)),
  }
}

function requireStudyPlanInput(value: unknown): StudyPlanInput {
  if (!value || typeof value !== 'object') throw new Error('无效的学习计划')
  const input = value as Partial<StudyPlanInput>
  if (!Array.isArray(input.sources)) throw new Error('无效的学习计划')
  const sources = input.sources.map((source) => {
    if (!source || !['reader_manual','exam_collection'].includes(String(source.type)) || typeof source.ref !== 'string') throw new Error('无效的词汇来源')
    if (source.type === 'reader_manual' && source.ref !== 'favorite') throw new Error('无效的生词来源')
    if (source.type === 'exam_collection' && !/^[a-z0-9-]{1,40}$/i.test(source.ref)) throw new Error('无效的考试词集')
    return { type: source.type, ref: source.ref } as StudyPlanInput['sources'][number]
  })
  return {
    name: typeof input.name === 'string' ? input.name : '',
    dailyNewLimit: Number(input.dailyNewLimit), dailyReviewLimit: Number(input.dailyReviewLimit),
    sources,
  }
}
function requireStudyPlanStatus(value: unknown): StudyPlanStatus {
  if (!['active','paused','archived'].includes(String(value))) throw new Error('无效的计划状态')
  return value as StudyPlanStatus
}
function requireStudyPlanWordQuery(value: unknown): StudyPlanWordQuery {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<StudyPlanWordQuery>
  const filter = ['all','due','unseen','learning','consolidating','mature','suspended','excluded'].includes(String(input.filter)) ? input.filter! : 'all'
  return { text: typeof input.text === 'string' ? input.text.slice(0,100) : '', filter, offset: requireOffset(input.offset), limit: Math.min(100,Math.max(1,Number(input.limit)||50)) }
}
function requireStudyDeletePlanOptions(value: unknown): StudyDeletePlanOptions {
  if (value == null) return { resetWordProgress: false }
  if (!value || typeof value !== 'object') throw new Error('无效的删除计划选项')
  return { resetWordProgress: (value as Partial<StudyDeletePlanOptions>).resetWordProgress === true }
}
function requireStudyAnswer(value: unknown): StudyAnswerRequest {
  if (!value || typeof value !== 'object') throw new Error('无效的学习回答')
  const input=value as Partial<StudyAnswerRequest>
  if (!['known','unknown'].includes(String(input.answer)) || typeof input.commandId!=='string' || !/^[a-f0-9-]{36}$/i.test(input.commandId)) throw new Error('无效的学习回答')
  return { sessionId: requireId(input.sessionId), itemId: requireId(input.itemId), commandId: input.commandId, expectedVersion: requireOffset(input.expectedVersion), answer: input.answer as 'known'|'unknown' }
}
function requireStudyStage(value: unknown): StudyStageAnswerRequest {
  if (!value || typeof value !== 'object') throw new Error('无效的学习回答')
  const input=value as Partial<StudyStageAnswerRequest>
  if(!['known','unknown'].includes(String(input.answer))) throw new Error('无效的学习回答')
  return { sessionId: requireId(input.sessionId), itemId: requireId(input.itemId), expectedVersion: requireOffset(input.expectedVersion), answer: input.answer as 'known'|'unknown' }
}
function requireStudyTooEasy(value: unknown): StudyTooEasyRequest {
  if (!value || typeof value !== 'object') throw new Error('无效的太简单请求')
  const input=value as Partial<StudyTooEasyRequest>
  if(typeof input.commandId!=='string'||!/^[a-f0-9-]{36}$/i.test(input.commandId)) throw new Error('无效的太简单请求')
  return {sessionId:requireId(input.sessionId),itemId:requireId(input.itemId),expectedVersion:requireOffset(input.expectedVersion),commandId:input.commandId}
}
function requireStudyTodayWordQuery(value:unknown):StudyTodayWordQuery{
  const input=(value&&typeof value==='object'?value:{}) as Partial<StudyTodayWordQuery>
  const filter=['all','new','review','known','unknown','too_easy'].includes(String(input.filter))?input.filter!:'all'
  return{filter,offset:requireOffset(input.offset),limit:Math.min(100,Math.max(1,Number(input.limit)||50))}
}
function requireStudyPreferences(value: unknown): StudyPreferences {
  if (!value || typeof value !== 'object') throw new Error('无效的学习设置')
  const input=value as Partial<StudyPreferences>
  return { cutoffHour:Number(input.cutoffHour), requestRetention:Number(input.requestRetention), maximumInterval:Number(input.maximumInterval), queueOrder:input.queueOrder as StudyPreferences['queueOrder'] }
}

function requireShortText(value:unknown,label:string):string{if(typeof value!=='string'||!value.length||value.length>100)throw new Error(`${label}无效`);return value}

function requireDictionarySearch(value: unknown): DictionarySearchQuery {
  if (!value || typeof value !== 'object') throw new Error('无效的词典搜索条件')
  const input = value as Partial<DictionarySearchQuery>
  const text = typeof input.text === 'string' ? input.text.normalize('NFKC').trim().slice(0, 100) : ''
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.filter((tag): tag is string => typeof tag === 'string' && /^[a-z0-9-]{1,20}$/i.test(tag)))].slice(0, 12)
    : []
  const nullableInteger = (item: unknown, min: number, max: number) => {
    if (item == null || item === '') return null
    const number = Number(item)
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('词典筛选数值无效')
    return number
  }
  return {
    text, tags, tagMatch: input.tagMatch === 'all' ? 'all' : 'any',
    oxfordOnly: input.oxfordOnly === true,
    collinsMin: nullableInteger(input.collinsMin, 1, 5),
    bncMax: nullableInteger(input.bncMax, 1, 1_000_000),
    contemporaryMax: nullableInteger(input.contemporaryMax, 1, 1_000_000),
    sort: ['relevance', 'frequency', 'alphabetical'].includes(String(input.sort))
      ? input.sort as DictionarySearchQuery['sort'] : 'relevance',
    offset: requireOffset(input.offset), limit: Math.min(50, Math.max(1, Number(input.limit) || 30)),
  }
}
