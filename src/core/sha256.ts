import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/** Platform-neutral synchronous SHA-256 used by content ID v2. */
export function sha256Hex(value: Uint8Array | string): string {
  return bytesToHex(sha256(typeof value === 'string' ? encoder.encode(value) : value))
}

export const portableContentHasher = { sha256: sha256Hex }
