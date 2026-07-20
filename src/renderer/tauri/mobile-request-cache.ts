const DEFAULT_TTL_MS = 30_000

export class MobileRequestCache<T> {
  private value: T | undefined
  private expiresAt = 0
  private request: Promise<T> | null = null

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  peek(): T | undefined {
    return this.value
  }

  get(load: () => Promise<T>, force = false): Promise<T> {
    if (!force && this.value !== undefined && Date.now() < this.expiresAt) {
      return Promise.resolve(this.value)
    }
    if (this.request) return this.request
    this.request = load().then((value) => {
      this.value = value
      this.expiresAt = Date.now() + this.ttlMs
      return value
    }).finally(() => {
      this.request = null
    })
    return this.request
  }

  invalidate(): void {
    this.expiresAt = 0
  }

  clear(): void {
    this.value = undefined
    this.expiresAt = 0
  }
}
