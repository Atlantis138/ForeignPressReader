import type { AppApi } from './types'

declare global {
  interface Window {
    readerApi: AppApi
  }
}

export {}
