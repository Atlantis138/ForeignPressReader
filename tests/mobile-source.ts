import { readFile } from 'node:fs/promises'

const readText = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

export async function readMobileAppSource(): Promise<string> {
  return (await Promise.all([
    'src/renderer/tauri/mobile-app.tsx',
    'src/renderer/tauri/mobile-library-page.tsx',
    'src/renderer/tauri/mobile-reader-pages.tsx',
    'src/renderer/tauri/mobile-settings-pages.tsx',
  ].map(readText))).join('\n')
}

export async function readMobileCssSource(): Promise<string> {
  return (await Promise.all([
    'src/renderer/tauri/mobile-css/tokens-theme.css',
    'src/renderer/tauri/mobile-css/base-shell-shared.css',
    'src/renderer/tauri/mobile-css/library-reader.css',
    'src/renderer/tauri/mobile-css/dictionary.css',
    'src/renderer/tauri/mobile-css/study.css',
    'src/renderer/tauri/mobile-css/settings-sync.css',
    'src/renderer/tauri/mobile-css/responsive-accessibility.css',
  ].map(readText))).join('\n')
}
