import { listRecoverySnapshots, restoreStartupSnapshot } from './startup-recovery'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  net,
  protocol,
  shell,
} from 'electron'
import type {
  DictionaryInstallProgress,
  DataTransferProgress,
  TranslationProgress,
  ImportProgress,
} from '../shared/types'
import { SqliteApplicationRepository } from './database'
import { EpubImporter } from './epub-importer'
import { LibraryService } from './library-service'
import { SecretStore } from './secret-store'
import {
  TranslationService,
} from './translation-service'
import { DesktopTranslationProviderRegistry } from './desktop-translation-models'
import { PublicationFormatRegistry } from '../core/importing/publication-formats'
import { DictionaryService } from './dictionary-service'
import { PortableDataService } from './portable-data-service'
import { VocabularyService } from './vocabulary-service'
import { SqliteVocabularyRepository } from './vocabulary-repository'
import { SqliteStudyRepository } from './study-repository'
import { StudyService } from './study-service'
import { createDefaultSpeechProviderRegistry } from '../core/speech-providers'
import { SpeechSynthesisService } from './speech-service'
import { SpeechAudioCache } from './speech-audio-cache'
import { createDefaultSpeechAdapterRegistry } from './speech-provider-adapters'
import { ElectronNetworkClient } from './electron-network-client'
import { StorageService } from './storage-service'
import { DiagnosticLogger } from './diagnostic-logger'
import { DeveloperService } from './developer-service'
import { SyncDataService } from './sync-data-service'
import { LanSyncService } from './lan-sync-service'
import { registerRendererProtocol } from './renderer-protocol'
import { createMainWindow } from './main-window'
import { createTrustedIpcMain } from './trusted-ipc'
import { registerApplicationIpc } from './ipc-registration'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'reader-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: 'fpr-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
])

app.setName('外刊阅读器')
app.setPath(
  'userData',
  process.env.READER_USER_DATA_PATH || path.join(app.getPath('appData'), '外刊阅读器'),
)

let mainWindow: BrowserWindow | null = null
let database: SqliteApplicationRepository | null = null
let dictionaryService: DictionaryService | null = null
let portableDataService: PortableDataService | null = null
let lanSyncService: LanSyncService | null = null
let diagnosticLogger: DiagnosticLogger | null = null
const ipcMain = createTrustedIpcMain(
  electronIpcMain,
  () => mainWindow,
  process.env.VITE_DEV_SERVER_URL,
)

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  diagnosticLogger = new DiagnosticLogger(userDataPath)
  const network = new ElectronNetworkClient(diagnosticLogger)
  await network.initialize()
  database = await SqliteApplicationRepository.open(userDataPath, app.getVersion())
  const secrets = new SecretStore(userDataPath)
  const importFormats = new PublicationFormatRegistry([{
    id: 'epub',
    name: 'EPUB 电子刊物',
    extensions: ['epub'],
    maxBytes: 500 * 1024 * 1024,
    importer: new EpubImporter(),
  }])
  const library = new LibraryService(database, importFormats, userDataPath, emitImportProgress)
  const sourceCleanup = await library.removeRetainedSources()
  await diagnosticLogger.log('info', 'library', 'parsed-only-source-cleanup', sourceCleanup)
  const translationProviders = new DesktopTranslationProviderRegistry()
  const speechProviders = createDefaultSpeechProviderRegistry()
  const speechCache = new SpeechAudioCache(userDataPath)
  const speechSynthesis = new SpeechSynthesisService(
    secrets,
    speechProviders,
    createDefaultSpeechAdapterRegistry(),
    network,
    speechCache,
  )
  const translator = new TranslationService(database, secrets, () => database!.getTranslationPreferences(), (progress) => {
    emitTranslationProgress(progress)
  }, network, translationProviders)
  dictionaryService = new DictionaryService(database, secrets, userDataPath, (progress) => {
    emitDictionaryProgress(progress)
  }, network, (texts)=>translator.translateTexts(texts), {
    identity: () => translator.getSelectionIdentity(),
    complete: (systemPrompt, payload) => translator.completeJson(systemPrompt, payload),
  })
  const vocabulary = new VocabularyService(new SqliteVocabularyRepository(database), dictionaryService)
  const study = new StudyService(new SqliteStudyRepository(database), dictionaryService)
  portableDataService = new PortableDataService(database, library, userDataPath, app.getVersion(), (progress) => {
    emitDataProgress(progress)
  })
  const syncData = new SyncDataService(database, library, userDataPath)
  lanSyncService = new LanSyncService(syncData, userDataPath)
  const storage = new StorageService(
    database, userDataPath, speechCache,
    () => !portableDataService!.busy && !dictionaryService!.installer.installing,
  )
  const developer = new DeveloperService(database, diagnosticLogger, () => scheduleFactoryReset(userDataPath))
  await developer.initialize()

  registerAssetProtocol(userDataPath)
  if (!process.env.VITE_DEV_SERVER_URL) {
    registerRendererProtocol(path.join(__dirname, '..', '..', 'dist'))
  }
  mainWindow = createMainWindow({
    preloadPath: path.join(__dirname, '..', 'preload', 'index.js'),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    onRendererGone: (details) => {
      void diagnosticLogger?.log('error', 'renderer', 'process-gone', {
        reason: details.reason, exitCode: details.exitCode,
      })
      if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: 'error', title: '页面已停止运行',
          message: '阅读页面意外关闭，已保存的数据仍保留在本机。',
          buttons: ['重新加载', '关闭应用'], defaultId: 0, cancelId: 1,
        }).then(({ response }) => {
          if (response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
          else app.quit()
        })
      }
    },
    onUnresponsive: () => { void diagnosticLogger?.log('warn', 'renderer', 'unresponsive') },
  })
  registerApplicationIpc(
    ipcMain, mainWindow, process.env.VITE_DEV_SERVER_URL,
    library, database, secrets, translator, translationProviders, speechSynthesis, speechProviders,
    dictionaryService, vocabulary, study, portableDataService, storage, lanSyncService, developer, userDataPath,
  )
}


async function scheduleFactoryReset(userDataPath: string): Promise<void> {
  const token = crypto.randomUUID()
  const markerPath = path.join(os.tmpdir(), `foreign-reader-reset-${token}.json`)
  const marker = {
    token, target: path.resolve(userDataPath), installRoot: path.resolve(path.dirname(process.execPath)),
    executable: process.execPath, parentPid: process.pid,
    relaunchArgs: app.isPackaged ? [] : [app.getAppPath()],
  }
  await fs.promises.writeFile(markerPath, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 })
  const helper = path.join(__dirname, 'factory-reset-helper.js')
  spawn(process.execPath, [helper, markerPath, token], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref()
  setTimeout(() => app.quit(), 50)
}

function registerAssetProtocol(userDataPath: string): void {
  protocol.handle('reader-asset', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'asset') return new Response('Not found', { status: 404 })
      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
      const publicationId = parts.shift()
      if (!publicationId || !/^[a-zA-Z0-9_-]+$/.test(publicationId) || parts.length === 0) {
        return new Response('Not found', { status: 404 })
      }
      const assetsRoot = path.resolve(userDataPath, 'library', publicationId, 'assets')
      const filePath = path.resolve(assetsRoot, ...parts)
      if (!filePath.startsWith(`${assetsRoot}${path.sep}`) || !fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 })
      }
      const response = await net.fetch(pathToFileURL(filePath).toString(), { cache: 'no-store' })
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store, max-age=0')
      headers.set('Pragma', 'no-cache')
      headers.set('Expires', '0')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

function emitTranslationProgress(progress: TranslationProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('translation:progress', progress)
  }
}

function emitImportProgress(progress: ImportProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:importProgress', progress)
}

function emitDictionaryProgress(progress: DictionaryInstallProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dictionary:installProgress', progress)
  }
}

function emitDataProgress(progress: DataTransferProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:progress', progress)
}

app.whenReady().then(bootstrap).catch(async (error) => {
  const message = error instanceof Error ? error.message : '应用无法启动'
  if (!database && !/Demo|旧版数据库|架构代次/.test(message)) {
    const userDataPath = app.getPath('userData')
    for (;;) {
      const response = await dialog.showMessageBox({ type: 'error', title: '无法打开阅读数据', message,
        detail: '可选择正式版数据库快照恢复。恢复前会验证快照；当前数据库及其日志会另外保存，刊物文件会保留。',
        buttons: ['选择备份恢复', '打开数据目录', '退出'], defaultId: 0, cancelId: 2 })
      if (response.response === 2) break
      if (response.response === 1) { await shell.openPath(userDataPath); continue }
      const snapshots = listRecoverySnapshots(userDataPath)
      const selection = await dialog.showOpenDialog({ title: '选择正式版数据库快照', defaultPath: snapshots[0]?.path ?? path.join(userDataPath,'backups','migrations'), filters: [{ name: 'SQLite 数据库快照', extensions: ['sqlite'] }], properties: ['openFile'] })
      if (selection.canceled || !selection.filePaths[0]) continue
      try {
        const preserved = await restoreStartupSnapshot(userDataPath,selection.filePaths[0],app.getVersion())
        await dialog.showMessageBox({ type: 'info', message: '备份已恢复，即将重新启动', detail: '原始数据库已保存在：'+preserved, buttons: ['重新启动'] })
        app.relaunch(); app.quit(); return
      } catch (reason) { dialog.showErrorBox('未能恢复备份',reason instanceof Error ? reason.message : '恢复失败，原数据已保留') }
    }
  } else dialog.showErrorBox('启动失败', message)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
let shutdownStarted = false
let shutdownComplete = false
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void (async () => {
    await diagnosticLogger?.log('info', 'app', 'shutdown')
    portableDataService?.close()
    dictionaryService?.close()
    await lanSyncService?.closePage()
    database?.close()
    shutdownComplete = true
    app.quit()
  })().catch((error) => {
    void diagnosticLogger?.log('error', 'app', 'shutdown-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    shutdownComplete = true
    database?.close()
    app.quit()
  })
})

process.on('uncaughtException', (error) => { void diagnosticLogger?.log('error', 'process', 'uncaught-exception', { error: error.message }) })
process.on('unhandledRejection', (reason) => { void diagnosticLogger?.log('error', 'process', 'unhandled-rejection', { error: reason instanceof Error ? reason.message : String(reason) }) })
