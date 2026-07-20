import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { DictionaryInstallProgress } from '../../shared/types'
import type { MobileAppClient } from './mobile-app-client'
import type { MobileTask } from './mobile-ui'

export function useMobileGlobalTasks(
  client: MobileAppClient,
  onTask: Dispatch<SetStateAction<MobileTask | null>>,
  onError: (message: string) => void,
): void {
  useEffect(() => client.dictionary.onInstallProgress((progress) => {
    if (['completed', 'cancelled', 'error'].includes(progress.stage)) {
      onTask((current) => current?.kind === 'dictionary' ? null : current)
      return
    }
    onTask({
      id: 'dictionary-install',
      kind: 'dictionary',
      label: dictionaryInstallStageLabel(progress),
      detail: dictionaryInstallStageDetail(progress),
      progress: progress.totalBytes > 0 ? progress.downloadedBytes / progress.totalBytes : null,
      onCancel: () => void client.dictionary.cancelInstall().catch((reason) => onError(messageOf(reason))),
    })
  }), [client.dictionary, onError, onTask])
}

function dictionaryInstallStageLabel(progress: DictionaryInstallProgress): string {
  const labels: Partial<Record<DictionaryInstallProgress['stage'], string>> = {
    'downloading-dictionary': '正在下载 ECDICT 原始数据',
    'downloading-lemma': '正在下载 ECDICT 词形表',
    'indexing-entries': '正在构建标准学习包',
    'indexing-forms': '正在建立词形索引',
    finalizing: '正在校验并发布词典',
  }
  return labels[progress.stage] ?? '正在安装离线词典'
}

function dictionaryInstallStageDetail(progress: DictionaryInstallProgress): string {
  if (progress.totalBytes > 0) {
    return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)} · 安装后会自动清理原始下载文件。`
  }
  return progress.message ?? '索引在应用私有存储中构建；完成前会保留原有词典。'
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message)
  return '操作失败，请重试。'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
