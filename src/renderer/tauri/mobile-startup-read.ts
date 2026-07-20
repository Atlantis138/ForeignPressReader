const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_RETRY_DELAY_MS = 100

export async function readMobileStartupValue<T>(
  read: () => Promise<T>,
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let lastFailure: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withTimeout(read(), timeoutMs)
    } catch (reason) {
      lastFailure = reason
      if (attempt === 0 && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  throw lastFailure
}

function withTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('本地数据初始化超时，请重试。')),
      timeoutMs,
    )
    request.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason)
      },
    )
  })
}
