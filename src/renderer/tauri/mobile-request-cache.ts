const DEFAULT_TTL_MS = 30_000

export class MobileRequestCache<T> {
  private value: T | undefined
  private expiresAt = 0
  private request: Promise<T> | null = null
  private generation = 0

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  peek(): T | undefined {
    return this.value
  }

  get(load: () => Promise<T>, force = false): Promise<T> {
    if (force) this.invalidate()
    if (!force && this.value !== undefined && Date.now() < this.expiresAt) {
      return Promise.resolve(this.value)
    }
    if (this.request) return this.request
    const generation = this.generation
    const request = load().then((value) => {
      if (generation === this.generation) {
        this.value = value
        this.expiresAt = Date.now() + this.ttlMs
      }
      return value
    }).finally(() => {
      if (this.request === request) this.request = null
    })
    this.request = request
    return this.request
  }

  invalidate(): void {
    this.generation++
    this.request = null
    this.expiresAt = 0
  }

  clear(): void {
    this.invalidate()
    this.value = undefined
    this.expiresAt = 0
  }
}
