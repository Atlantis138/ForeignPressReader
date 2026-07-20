import 'reflect-metadata'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from '@peculiar/x509'
import type { LanSyncPlatform, LanSyncPeerIdentity } from '../core/sync-wire'

export interface SyncLocalIdentity {
  deviceId: string
  certificatePem: string
  privateKeyPem: string
  certificateDerBase64: string
  certificateSha256: string
  createdAt: string
}

export interface SyncTrustedPeer extends LanSyncPeerIdentity {
  token: string
  pairedAt: string
}

interface SyncIdentityFile {
  version: 1
  identity: SyncLocalIdentity
  peers: Record<string, SyncTrustedPeer>
}

export class SyncIdentityStore {
  private readonly filePath: string
  private state: SyncIdentityFile | null = null

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'sync-identity.bin')
  }

  async initialize(deviceId: string): Promise<SyncLocalIdentity> {
    if (this.state) return this.state.identity
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('当前系统无法使用安全设备身份存储')
    }
    const loaded = await this.read().catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('已保存的同步设备身份无法读取；请在开发与调试中恢复应用后重试')
    })
    if (loaded && loaded.identity.deviceId === deviceId) {
      this.state = loaded
      return loaded.identity
    }
    const identity = await createIdentity(deviceId)
    this.state = { version: 1, identity, peers: {} }
    await this.write()
    return identity
  }

  get identity(): SyncLocalIdentity {
    if (!this.state) throw new Error('同步设备身份尚未初始化')
    return this.state.identity
  }

  get currentIdentity(): SyncLocalIdentity | null {
    return this.state?.identity ?? null
  }

  listPeers(): SyncTrustedPeer[] {
    if (!this.state) return []
    return Object.values(this.state.peers).sort((left, right) => left.name.localeCompare(right.name))
  }

  getPeer(deviceId: string): SyncTrustedPeer | null {
    return this.state?.peers[deviceId] ?? null
  }

  async trust(peer: LanSyncPeerIdentity, token: string): Promise<SyncTrustedPeer> {
    assertPeerIdentity(peer)
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('同步信任令牌无效')
    const trusted: SyncTrustedPeer = { ...peer, token, pairedAt: new Date().toISOString() }
    this.requireState().peers[peer.deviceId] = trusted
    await this.write()
    return trusted
  }

  async revoke(deviceId: string): Promise<void> {
    const state = this.requireState()
    delete state.peers[deviceId]
    await this.write()
  }

  private requireState(): SyncIdentityFile {
    if (!this.state) throw new Error('同步设备身份尚未初始化')
    return this.state
  }

  private async read(): Promise<SyncIdentityFile> {
    const encrypted = await fs.promises.readFile(this.filePath)
    const decrypted = await safeStorage.decryptStringAsync(encrypted)
    const parsed = JSON.parse(decrypted.result) as Partial<SyncIdentityFile>
    if (parsed.version !== 1 || !parsed.identity || !parsed.peers || typeof parsed.peers !== 'object') {
      throw new Error('unsupported sync identity')
    }
    validateIdentity(parsed.identity)
    for (const peer of Object.values(parsed.peers)) {
      assertPeerIdentity(peer)
      if (!/^[a-f0-9]{64}$/.test(peer.token) || !Number.isFinite(Date.parse(peer.pairedAt))) {
        throw new Error('invalid trusted peer')
      }
    }
    if (decrypted.shouldReEncrypt) {
      this.state = parsed as SyncIdentityFile
      await this.write()
    }
    return parsed as SyncIdentityFile
  }

  private async write(): Promise<void> {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(this.requireState()))
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
      await fs.promises.rename(temporary, this.filePath)
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
  }
}

async function createIdentity(deviceId: string): Promise<SyncLocalIdentity> {
  const webcrypto = crypto.webcrypto as unknown as Crypto
  const subtle = webcrypto.subtle
  const keyAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const
  const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' } as const
  const keys = await subtle.generateKey(keyAlgorithm, true, ['sign', 'verify'])
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomBytes(16).toString('hex'),
    name: `CN=${deviceId}`,
    notBefore,
    notAfter,
    signingAlgorithm,
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyAgreement, true),
      new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
      new SubjectAlternativeNameExtension([{ type: 'dns', value: 'fprsync.local' }], false),
    ],
  }, webcrypto)
  const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', keys.privateKey))
  const certificateDer = new Uint8Array(certificate.rawData)
  const identity: SyncLocalIdentity = {
    deviceId,
    certificatePem: certificate.toString('pem'),
    privateKeyPem: pem('PRIVATE KEY', privateKey),
    certificateDerBase64: Buffer.from(certificateDer).toString('base64'),
    certificateSha256: crypto.createHash('sha256').update(certificateDer).digest('hex'),
    createdAt: new Date().toISOString(),
  }
  validateIdentity(identity)
  return identity
}

function pem(label: string, bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`
}

function validateIdentity(identity: SyncLocalIdentity): void {
  if (!identity.deviceId || !identity.certificatePem.includes('BEGIN CERTIFICATE')
    || !identity.privateKeyPem.includes('BEGIN PRIVATE KEY')
    || !/^[a-f0-9]{64}$/.test(identity.certificateSha256)
    || !identity.certificateDerBase64 || !Number.isFinite(Date.parse(identity.createdAt))) {
    throw new Error('invalid sync identity')
  }
  const actual = crypto.createHash('sha256')
    .update(Buffer.from(identity.certificateDerBase64, 'base64')).digest('hex')
  if (actual !== identity.certificateSha256) throw new Error('invalid sync certificate')
}

function assertPeerIdentity(peer: LanSyncPeerIdentity | SyncTrustedPeer): void {
  const platforms = new Set<LanSyncPlatform>(['windows', 'android'])
  if (!peer || !peer.deviceId || !peer.name || !platforms.has(peer.platform)
    || !/^[a-f0-9]{64}$/.test(peer.certificateSha256) || !peer.certificateDerBase64) {
    throw new Error('同步设备身份无效')
  }
  const actual = crypto.createHash('sha256')
    .update(Buffer.from(peer.certificateDerBase64, 'base64')).digest('hex')
  if (actual !== peer.certificateSha256) throw new Error('同步设备证书无效')
}
