// Serialize persistence and coalesce intermediate slider values. An old response must
// never replace a newer preview; a failed final write restores the last saved value.
export class PreferenceWriter<T> {
  private pending: { value: T; version: number } | null = null
  private running: Promise<void> | null = null
  private version = 0

  constructor(
    private confirmed: T,
    private readonly persist: (value: T) => Promise<T>,
    private readonly preview: (value: T) => void,
    private readonly onError: (reason: unknown) => void,
  ) {}

  refreshBaseline(value: T): void {
    if (!this.running) this.confirmed = value
  }

  write(value: T): Promise<void> {
    this.pending = { value, version: ++this.version }
    this.preview(value)
    if (!this.running) this.running = Promise.resolve().then(() => this.drain())
    return this.running
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const next = this.pending
        this.pending = null
        try {
          this.confirmed = await this.persist(next.value)
          if (next.version === this.version) this.preview(this.confirmed)
        } catch (reason) {
          if (next.version === this.version) this.preview(this.confirmed)
          this.onError(reason)
        }
      }
    } finally {
      this.running = null
    }
  }
}
