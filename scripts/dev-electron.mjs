import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import waitOn from 'wait-on'

const require = createRequire(import.meta.url)
let electron, compiler, timer, building = false, dirty = false, stopping = false
const watchers = []

async function rebuild() {
  if (building || stopping) { dirty = true; return }
  building = true
  dirty = false
  try {
    console.log('[dev] Compiling Electron main and preload')
    compiler = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.electron.json'], { stdio: 'inherit', windowsHide: true })
    const [code] = await once(compiler, 'exit')
    compiler = null
    if (code !== 0 || stopping) return
    console.log('[dev] Waiting for the local Vite server')
    await waitOn({ resources: ['http://127.0.0.1:5173'], timeout: 30000, proxy: false })
    if (stopping) return
    if (electron && electron.exitCode === null) {
      const exited = once(electron, 'exit')
      electron.kill()
      await exited
    }
    electron = spawn(require('electron'), ['.'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
    })
    console.log('[dev] Electron started after successful compilation')
  } catch (error) { console.error(error.message) }
  finally { building = false; if (dirty && !stopping) void rebuild() }
}

for (const directory of ['src/main', 'src/preload', 'src/core', 'src/shared']) {
  watchers.push(watch(directory, { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), 250)
  }))
}
function stop() {
  stopping = true
  clearTimeout(timer)
  watchers.forEach(watcher => watcher.close())
  compiler?.kill()
  electron?.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('exit', stop)
await rebuild()
