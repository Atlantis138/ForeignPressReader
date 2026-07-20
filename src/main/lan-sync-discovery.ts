import crypto from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import {
  LAN_SYNC_LIMITS,
  LAN_SYNC_MULTICAST_GROUP,
  LAN_SYNC_PORT,
  isLanSyncDiscoveryAnnouncementV2,
  type LanSyncDiscoveryAnnouncementV2,
} from '../core/sync-wire'

export interface LanSyncIpv4Interface {
  name: string
  address: string
  netmask: string
  broadcast: string
}

export interface LanSyncDiscoveryCandidate {
  announcement: LanSyncDiscoveryAnnouncementV2
  host: string
  source: 'udp-multicast' | 'udp-broadcast' | 'udp-unicast'
  receivedAt: string
}

export class LanSyncDiscoveryMessageCache {
  private readonly recentMessages = new Map<string, number>()

  accept(messageId: string, now = Date.now()): boolean {
    for (const [id, seenAt] of this.recentMessages) {
      if (now - seenAt >= LAN_SYNC_LIMITS.candidateRetentionMs) this.recentMessages.delete(id)
    }
    if (this.recentMessages.has(messageId)) return false
    this.recentMessages.set(messageId, now)
    return true
  }

  clear(): void {
    this.recentMessages.clear()
  }
}

export function listLanSyncIpv4Interfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanSyncIpv4Interface[] {
  const result: LanSyncIpv4Interface[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !net.isIPv4(entry.address) || !net.isIPv4(entry.netmask)) continue
      if (entry.address.startsWith('169.254.') || entry.address === '0.0.0.0') continue
      const address = ipv4ToNumber(entry.address)
      const mask = ipv4ToNumber(entry.netmask)
      if (mask === 0 || mask === 0xffffffff) continue
      result.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        broadcast: numberToIpv4((address & mask) | (~mask >>> 0)),
      })
    }
  }
  return result.sort((left, right) => interfaceScore(right.name) - interfaceScore(left.name)
    || left.name.localeCompare(right.name)
    || left.address.localeCompare(right.address))
}

export function lanSyncScanHosts(interfaces = listLanSyncIpv4Interfaces(), maximum = 254): string[] {
  const hosts = new Set<string>()
  for (const item of interfaces) {
    const own = ipv4ToNumber(item.address)
    const prefix24 = (own & 0xffffff00) >>> 0
    for (let suffix = 1; suffix <= 254 && hosts.size < maximum; suffix += 1) {
      const candidate = (prefix24 | suffix) >>> 0
      if (candidate !== own) hosts.add(numberToIpv4(candidate))
    }
    if (hosts.size >= maximum) break
  }
  return [...hosts]
}

export class LanSyncActiveDiscovery {
  private socket: dgram.Socket | null = null
  private interfaces: LanSyncIpv4Interface[] = []
  private timers = new Set<NodeJS.Timeout>()
  private readonly messageCache = new LanSyncDiscoveryMessageCache()

  constructor(
    private readonly local: Omit<LanSyncDiscoveryAnnouncementV2, 'messageId' | 'kind'>,
    private readonly onCandidate: (candidate: LanSyncDiscoveryCandidate) => void,
    private readonly onDiagnostic: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.socket) return
    this.interfaces = listLanSyncIpv4Interfaces()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (error) => this.onDiagnostic(`UDP 发现不可用：${error.message}`))
    socket.on('message', (payload, remote) => this.onMessage(payload, remote))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { socket.off('listening', onListening); reject(error) }
      const onListening = () => { socket.off('error', onError); resolve() }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(LAN_SYNC_PORT, '0.0.0.0')
    })
    socket.setBroadcast(true)
    socket.setMulticastTTL(1)
    socket.setMulticastLoopback(false)
    for (const item of this.interfaces) {
      try { socket.addMembership(LAN_SYNC_MULTICAST_GROUP, item.address) }
      catch (error) { this.onDiagnostic(`网卡 ${item.name} 无法加入组播：${error instanceof Error ? error.message : String(error)}`) }
    }
    this.scheduleBurst()
    this.schedule(() => this.broadcast('announce'), LAN_SYNC_LIMITS.discoveryHeartbeatMs, true)
  }

  refresh(): void {
    this.broadcast('probe')
    this.schedule(() => this.broadcast('probe'), 500)
    this.schedule(() => this.broadcast('probe'), 2_000)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    const socket = this.socket
    this.socket = null
    if (socket) runIgnoringError(() => socket.close())
    this.messageCache.clear()
  }

  private scheduleBurst(): void {
    this.broadcast('probe')
    this.schedule(() => this.broadcast('probe'), 500)
    this.schedule(() => this.broadcast('probe'), 2_000)
  }

  private schedule(action: () => void, milliseconds: number, recurring = false): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
      if (recurring && this.socket) this.schedule(action, milliseconds, true)
    }, milliseconds)
    this.timers.add(timer)
  }

  private broadcast(kind: LanSyncDiscoveryAnnouncementV2['kind']): void {
    const socket = this.socket
    if (!socket) return
    const payload = Buffer.from(JSON.stringify({
      ...this.local,
      kind,
      messageId: crypto.randomUUID(),
    } satisfies LanSyncDiscoveryAnnouncementV2), 'utf8')
    if (payload.length > 4 * 1024) {
      this.onDiagnostic('本机设备发现报文过大')
      return
    }
    this.send(payload, LAN_SYNC_MULTICAST_GROUP, LAN_SYNC_PORT)
    for (const item of this.interfaces) this.send(payload, item.broadcast, LAN_SYNC_PORT)
  }

  private onMessage(payload: Buffer, remote: dgram.RemoteInfo): void {
    if (payload.length === 0 || payload.length > 4 * 1024 || !net.isIPv4(remote.address)) return
    let value: unknown
    try { value = JSON.parse(payload.toString('utf8')) }
    catch { return }
    if (!isLanSyncDiscoveryAnnouncementV2(value) || value.deviceId === this.local.deviceId) return
    const now = Date.now()
    if (!this.messageCache.accept(value.messageId, now)) return
    this.onCandidate({
      announcement: value,
      host: remote.address,
      source: remote.address === LAN_SYNC_MULTICAST_GROUP ? 'udp-multicast' : 'udp-unicast',
      receivedAt: new Date(now).toISOString(),
    })
    if (value.kind === 'probe') {
      const response = Buffer.from(JSON.stringify({
        ...this.local,
        kind: 'announce',
        messageId: crypto.randomUUID(),
      } satisfies LanSyncDiscoveryAnnouncementV2), 'utf8')
      this.send(response, remote.address, remote.port)
    }
  }

  private send(payload: Buffer, host: string, port: number): void {
    this.socket?.send(payload, port, host, (error) => {
      if (error) this.onDiagnostic(`无法发送局域网发现报文：${error.message}`)
    })
  }
}

function ipv4ToNumber(value: string): number {
  return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0)
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

function interfaceScore(name: string): number {
  const value = name.toLowerCase()
  if (/virtual|vmware|virtualbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tunnel/.test(value)) return -20
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(value)) return 20
  return 0
}

function runIgnoringError(action: () => void): void {
  try { action() } catch { /* Best-effort page-scoped cleanup. */ }
}
