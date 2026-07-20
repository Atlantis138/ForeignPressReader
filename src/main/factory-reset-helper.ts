import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

interface Marker {
  token: string
  target: string
  installRoot: string
  executable: string
  parentPid: number
  relaunchArgs: string[]
}

if (require.main === module) void run().catch(() => process.exit(1))

async function run(): Promise<void> {
  const markerPath = process.argv[2]
  const expectedToken = process.argv[3]
  if (!markerPath || !expectedToken || !path.basename(markerPath).startsWith('foreign-reader-reset-')) throw new Error('invalid marker')
  const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as Marker
  if (marker.token !== expectedToken) throw new Error('invalid token')
  const target = path.resolve(marker.target)
  const installRoot = path.resolve(marker.installRoot)
  if (!isSafeResetTarget(target, installRoot, process.env.USERPROFILE ?? '')) throw new Error('unsafe reset target')
  for (let attempt = 0; attempt < 120 && processExists(marker.parentPid); attempt += 1) await delay(250)
  if (processExists(marker.parentPid)) throw new Error('parent did not exit')
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  await fs.promises.rm(markerPath, { force: true })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  spawn(marker.executable, marker.relaunchArgs, { detached: true, stdio: 'ignore', env: environment }).unref()
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function isSafeResetTarget(targetValue: string, installValue: string, homeValue: string): boolean {
  const target = path.resolve(targetValue)
  const installRoot = path.resolve(installValue)
  const home = homeValue ? path.resolve(homeValue) : ''
  const parsed = path.parse(target)
  return target !== parsed.root && target !== home && target !== installRoot
    && !installRoot.startsWith(`${target}${path.sep}`) && target.length >= parsed.root.length + 8
}
