import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  DataTransferProgress,
  DictionaryInstallProgress,
  DictionaryPreferences,
  ReadingPositionInput,
  ReaderPreferences,
  SpeechPreferences,
  SpeechSynthesisRequest,
  TranslationProgress,
  ImportProgress,
} from '../shared/types'

const api: AppApi = {
  library: {
    getOnlineCatalog: (refresh) => ipcRenderer.invoke('library:getOnlineCatalog', refresh),
    importOnlineIssue: (issueId) => ipcRenderer.invoke('library:importOnlineIssue', issueId),
    importPublication: () => ipcRenderer.invoke('library:importPublication'),
    cancelImport: () => ipcRenderer.invoke('library:cancelImport'),
    onImportProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress) => callback(progress)
      ipcRenderer.on('library:importProgress', listener)
      return () => ipcRenderer.removeListener('library:importProgress', listener)
    },
    listPublications: () => ipcRenderer.invoke('library:listPublications'),
    getState: () => ipcRenderer.invoke('library:getState'),
    savePreferences: (preferences) => ipcRenderer.invoke('library:savePreferences', preferences),
    createCategory: (name) => ipcRenderer.invoke('library:createCategory', name),
    renameCategory: (categoryId, name) => ipcRenderer.invoke('library:renameCategory', categoryId, name),
    deleteCategory: (categoryId) => ipcRenderer.invoke('library:deleteCategory', categoryId),
    renamePublication: (publicationId, title) => ipcRenderer.invoke('library:renamePublication', publicationId, title),
    assignPublications: (publicationIds, categoryId) => ipcRenderer.invoke('library:assignPublications', publicationIds, categoryId),
    deletePublications: (publicationIds) => ipcRenderer.invoke('library:deletePublications', publicationIds),
    getPublication: (id) => ipcRenderer.invoke('library:getPublication', id),
  },
  reader: {
    searchArticles: (query) => ipcRenderer.invoke('reader:searchArticles', query),
    getReadingData: (id) => ipcRenderer.invoke('reader:getReadingData', id),
    changeReadingData: (id, change) => ipcRenderer.invoke('reader:changeReadingData', id, change),
    getArticle: (id) => ipcRenderer.invoke('reader:getArticle', id),
    savePosition: (publicationId, articleId, position) =>
      ipcRenderer.invoke('reader:savePosition', publicationId, articleId, requireReadingPosition(position)),
    getPreferences: () => ipcRenderer.invoke('reader:getPreferences'),
    savePreferences: (preferences: ReaderPreferences) =>
      ipcRenderer.invoke('reader:savePreferences', preferences),
  },
  speech: {
    getPreferences: () => ipcRenderer.invoke('speech:getPreferences'),
    savePreferences: (preferences: SpeechPreferences) => ipcRenderer.invoke('speech:savePreferences', preferences),
    getSettings: () => ipcRenderer.invoke('speech:getSettings'),
    saveProviderKey: (providerId, key) => ipcRenderer.invoke('speech:saveProviderKey', providerId, key),
    deleteProviderKey: (providerId) => ipcRenderer.invoke('speech:deleteProviderKey', providerId),
    testConnection: (providerId) => ipcRenderer.invoke('speech:testConnection', providerId),
    synthesize: (request: SpeechSynthesisRequest) => ipcRenderer.invoke('speech:synthesize', request),
  },
  translation: {
    getContents: (id) => ipcRenderer.invoke('translation:getContents', id),
    translateContents: (id, force = false) => ipcRenderer.invoke('translation:translateContents', id, force),
    cancelContents: (id) => ipcRenderer.invoke('translation:cancelContents', id),
    translateArticle: (articleId, force = false) => ipcRenderer.invoke('translation:translateArticle', articleId, force),
    cancel: (articleId) => ipcRenderer.invoke('translation:cancel', articleId),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: TranslationProgress) => callback(progress)
      ipcRenderer.on('translation:progress', listener)
      return () => ipcRenderer.removeListener('translation:progress', listener)
    },
  },
  settings: {
    deleteTranslationModel: (preferences) => ipcRenderer.invoke('settings:deleteTranslationModel', preferences),
    getTranslationSettings: () => ipcRenderer.invoke('settings:getTranslationSettings'),
    saveTranslationPreferences: (preferences) => ipcRenderer.invoke('settings:saveTranslationPreferences', preferences),
    saveProviderKey: (providerId, key) => ipcRenderer.invoke('settings:saveProviderKey', providerId, key),
    deleteProviderKey: (providerId) => ipcRenderer.invoke('settings:deleteProviderKey', providerId),
    testTranslationConnection: (preferences) => ipcRenderer.invoke('settings:testTranslationConnection', preferences),
    openDataDirectory: () => ipcRenderer.invoke('settings:openDataDirectory'),
  },
  dictionary: {
    getStatus: () => ipcRenderer.invoke('dictionary:getStatus'),
    install: (profile) => ipcRenderer.invoke('dictionary:install', profile),
    installFromLocal: (profile) => ipcRenderer.invoke('dictionary:installFromLocal', profile),
    removeFullExtension: () => ipcRenderer.invoke('dictionary:removeFullExtension'),
    cancelInstall: () => ipcRenderer.invoke('dictionary:cancelInstall'),
    remove: () => ipcRenderer.invoke('dictionary:remove'),
    lookup: (request) => ipcRenderer.invoke('dictionary:lookup', request),
    lookupInContext: (request, preferredLexemeKey) =>
      ipcRenderer.invoke('dictionary:lookupInContext', request, preferredLexemeKey),
    explainContext: (request, preferredLexemeKey) =>
      ipcRenderer.invoke('dictionary:explainContext', request, preferredLexemeKey),
    search: (query) => ipcRenderer.invoke('dictionary:search', query),
    getLexeme: (lexemeKey) => ipcRenderer.invoke('dictionary:getLexeme', lexemeKey),
    listCollections: () => ipcRenderer.invoke('dictionary:listCollections'),
    getPreferences: () => ipcRenderer.invoke('dictionary:getPreferences'),
    savePreferences: (preferences: DictionaryPreferences) =>
      ipcRenderer.invoke('dictionary:savePreferences', preferences),
    getCredentialStatus: () => ipcRenderer.invoke('dictionary:getCredentialStatus'),
    saveBaiduCredentials: (apiKey, secretKey) => ipcRenderer.invoke('dictionary:saveBaiduCredentials', apiKey, secretKey),
    deleteBaiduCredentials: () => ipcRenderer.invoke('dictionary:deleteBaiduCredentials'),
    testBaiduConnection: () => ipcRenderer.invoke('dictionary:testBaiduConnection'),
    onInstallProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: DictionaryInstallProgress) => callback(progress)
      ipcRenderer.on('dictionary:installProgress', listener)
      return () => ipcRenderer.removeListener('dictionary:installProgress', listener)
    },
  },
  vocabulary: {
    getReaderState: (request, lexemeKey) =>
      ipcRenderer.invoke('vocabulary:getReaderState', request, lexemeKey),
    setFavorite: (request, lexemeKey, favorite) =>
      ipcRenderer.invoke('vocabulary:setFavorite', request, lexemeKey, favorite),
    setContextSaved: (request, lexemeKey, saved) =>
      ipcRenderer.invoke('vocabulary:setContextSaved', request, lexemeKey, saved),
    listFavorites: (query) => ipcRenderer.invoke('vocabulary:listFavorites', query),
    listContexts: (lexemeKey, offset) =>
      ipcRenderer.invoke('vocabulary:listContexts', lexemeKey, offset),
    removeFavorite: (lexemeKey) => ipcRenderer.invoke('vocabulary:removeFavorite', lexemeKey),
  },
  study: {
    getDashboard: () => ipcRenderer.invoke('study:getDashboard'),
    listPlans: (includeArchived) => ipcRenderer.invoke('study:listPlans', includeArchived),
    createPlan: (input) => ipcRenderer.invoke('study:createPlan', input),
    updatePlan: (planId, input) => ipcRenderer.invoke('study:updatePlan', planId, input),
    setPlanStatus: (planId, status) => ipcRenderer.invoke('study:setPlanStatus', planId, status),
    getPlan: (planId) => ipcRenderer.invoke('study:getPlan', planId),
    listPlanWords: (planId, query) => ipcRenderer.invoke('study:listPlanWords', planId, query),
    setWordExcluded: (planId, lexemeKey, excluded) => ipcRenderer.invoke('study:setWordExcluded', planId, lexemeKey, excluded),
    setWordSuspended: (lexemeKey, suspended) => ipcRenderer.invoke('study:setWordSuspended', lexemeKey, suspended),
    listTodayWords: (sessionId, query) => ipcRenderer.invoke('study:listTodayWords', sessionId, query),
    openToday: () => ipcRenderer.invoke('study:openToday'),
    hydrateCurrentExamples: (request) => ipcRenderer.invoke('study:hydrateCurrentExamples', request),
    stageAnswer: (request) => ipcRenderer.invoke('study:stageAnswer', request),
    commitAnswer: (request) => ipcRenderer.invoke('study:commitAnswer', request),
    markTooEasy: (request) => ipcRenderer.invoke('study:markTooEasy', request),
    addExtraBatch: (planId) => ipcRenderer.invoke('study:addExtraBatch', planId),
    syncSources: (planId) => ipcRenderer.invoke('study:syncSources', planId),
    getPreferences: () => ipcRenderer.invoke('study:getPreferences'),
    savePreferences: (value) => ipcRenderer.invoke('study:savePreferences', value),
    getDebugState: () => ipcRenderer.invoke('study:getDebugState'),
    setDeveloperMode: (enabled) => ipcRenderer.invoke('study:setDeveloperMode', enabled),
    deletePlan: (planId, confirmationName, options) =>
      ipcRenderer.invoke('study:deletePlan', planId, confirmationName, options),
    resetAllProgress: (confirmationToken) => ipcRenderer.invoke('study:resetAllProgress', confirmationToken),
    forceNextStudyDay: (confirmationToken) => ipcRenderer.invoke('study:forceNextStudyDay', confirmationToken),
  },
  data: {
    getStatus: () => ipcRenderer.invoke('data:getStatus'),
    exportPortable: () => ipcRenderer.invoke('data:exportPortable'),
    selectPortableImport: () => ipcRenderer.invoke('data:selectPortableImport'),
    confirmPortableImport: (token) => ipcRenderer.invoke('data:confirmPortableImport', token),
    cancelTransfer: () => ipcRenderer.invoke('data:cancelTransfer'),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: DataTransferProgress) => callback(progress)
      ipcRenderer.on('data:progress', listener)
      return () => ipcRenderer.removeListener('data:progress', listener)
    },
  },
  storage: {
    scan: () => ipcRenderer.invoke('storage:scan'),
    clearSafeCache: () => ipcRenderer.invoke('storage:clearSafeCache'),
    clearAiTextCache: (confirmationToken) => ipcRenderer.invoke('storage:clearAiTextCache', confirmationToken),
  },
  sync: {
    openPage: () => ipcRenderer.invoke('sync:openPage'),
      closePage: () => ipcRenderer.invoke('sync:closePage'),
      getState: () => ipcRenderer.invoke('sync:getState'),
      refreshDiscovery: () => ipcRenderer.invoke('sync:refreshDiscovery'),
    startPairing: (deviceId) => ipcRenderer.invoke('sync:startPairing', deviceId),
    confirmPairing: (sessionId) => ipcRenderer.invoke('sync:confirmPairing', sessionId),
    rejectPairing: (sessionId) => ipcRenderer.invoke('sync:rejectPairing', sessionId),
    sendTo: (deviceId) => ipcRenderer.invoke('sync:sendTo', deviceId),
    getIncomingChanges: (transferId, offset, limit) => ipcRenderer.invoke('sync:getIncomingChanges', transferId, offset, limit),
    acceptIncoming: (transferId) => ipcRenderer.invoke('sync:acceptIncoming', transferId),
    rejectIncoming: (transferId) => ipcRenderer.invoke('sync:rejectIncoming', transferId),
      cancelOperation: () => ipcRenderer.invoke('sync:cancelOperation'),
      discardPendingTransfer: (transferId) => ipcRenderer.invoke('sync:discardPendingTransfer', transferId),
    revokeTrust: (deviceId) => ipcRenderer.invoke('sync:revokeTrust', deviceId),
  },
  developer: {
    getState: () => ipcRenderer.invoke('developer:getState'),
    setEnabled: (enabled) => ipcRenderer.invoke('developer:setEnabled', enabled),
    setLoggingEnabled: (enabled) => ipcRenderer.invoke('developer:setLoggingEnabled', enabled),
    openLogDirectory: () => ipcRenderer.invoke('developer:openLogDirectory'),
    clearLogs: () => ipcRenderer.invoke('developer:clearLogs'),
    factoryReset: (confirmationToken) => ipcRenderer.invoke('developer:factoryReset', confirmationToken),
  },
}

function requireReadingPosition(value: unknown): ReadingPositionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid reading position')
  }
  const keys = Object.keys(value)
  const allowedKeys = new Set(['scrollTop', 'anchorBlockId', 'anchorTokenIndex', 'anchorFraction'])
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Invalid reading position')
  }
  const input = value as Partial<ReadingPositionInput>
  if (typeof input.scrollTop !== 'number' || !Number.isFinite(input.scrollTop) || input.scrollTop < 0) {
    throw new TypeError('Invalid reading scroll offset')
  }
  if (input.anchorBlockId !== null
    && (typeof input.anchorBlockId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.anchorBlockId))) {
    throw new TypeError('Invalid reading block anchor')
  }
  if (input.anchorTokenIndex !== null
    && (typeof input.anchorTokenIndex !== 'number'
      || !Number.isSafeInteger(input.anchorTokenIndex)
      || input.anchorTokenIndex < 0
      || input.anchorTokenIndex > 1_000_000)) {
    throw new TypeError('Invalid reading token anchor')
  }
  if (input.anchorBlockId === null && input.anchorTokenIndex !== null) {
    throw new TypeError('Invalid reading token anchor')
  }
  if (typeof input.anchorFraction !== 'number'
    || !Number.isFinite(input.anchorFraction)
    || input.anchorFraction < 0
    || input.anchorFraction > 1) {
    throw new TypeError('Invalid reading block fraction')
  }
  return {
    scrollTop: input.scrollTop,
    anchorBlockId: input.anchorBlockId,
    anchorTokenIndex: input.anchorTokenIndex,
    anchorFraction: input.anchorFraction,
  }
}

contextBridge.exposeInMainWorld('readerApi', api)
