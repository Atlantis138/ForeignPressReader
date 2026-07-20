import path from 'node:path'

export const APP_CACHE_DIRECTORY = 'app-cache'

export function appCachePath(userDataPath: string, ...parts: string[]): string {
  return path.join(userDataPath, APP_CACHE_DIRECTORY, ...parts)
}
