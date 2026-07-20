export interface PlatformCommandError {
  code: string
  message: string
  retryable: boolean
}

const FALLBACK_ERROR: PlatformCommandError = {
  code: 'internal',
  message: '原生命令执行失败。',
  retryable: true,
}

export function normalizePlatformError(reason: unknown): PlatformCommandError {
  if (!reason || typeof reason !== 'object') return { ...FALLBACK_ERROR }
  const candidate = reason as Partial<PlatformCommandError>
  if (
    typeof candidate.code !== 'string'
    || typeof candidate.message !== 'string'
    || typeof candidate.retryable !== 'boolean'
  ) return { ...FALLBACK_ERROR }
  return { code: candidate.code, message: candidate.message, retryable: candidate.retryable }
}
