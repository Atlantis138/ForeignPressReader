import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  validateParsedPublicationPlan,
  validatePublicationPackageManifest,
} from '../src/core/publication-package'

describe('publication package v2 cross-platform vector', () => {
  it('keeps normalized plan serialization and manifest records identical on both platforms', () => {
    const vectors = path.join(process.cwd(), 'test-vectors')
    const packageVector = JSON.parse(fs.readFileSync(
      path.join(vectors, 'publication-package-v2.json'),
      'utf8',
    )) as {
      planVector: string
      assetFixtureHex: string
      expectedPlanJsonSize: number
      expectedPlanJsonSha256: string
      expectedManifest: unknown
    }
    const plan = validateParsedPublicationPlan(JSON.parse(fs.readFileSync(
      path.join(vectors, packageVector.planVector),
      'utf8',
    )).expectedPlan)
    const bytes = Buffer.from(JSON.stringify(plan))
    const asset = Buffer.from(packageVector.assetFixtureHex, 'hex')

    expect(bytes.length).toBe(packageVector.expectedPlanJsonSize)
    expect(sha256(bytes)).toBe(packageVector.expectedPlanJsonSha256)
    expect(sha256(asset)).toBe('32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af')
    expect(validatePublicationPackageManifest(packageVector.expectedManifest)).toEqual(packageVector.expectedManifest)
    const legacy = structuredClone(packageVector.expectedManifest) as Record<string, unknown>
    legacy.formatVersion = 1
    delete legacy.firstImportedAt
    expect(() => validatePublicationPackageManifest(legacy)).toThrow()

    const unsafeManifest = structuredClone(packageVector.expectedManifest) as Record<string, unknown>
    unsafeManifest.publicationId = '..\\..\\outside'
    expect(() => validatePublicationPackageManifest(unsafeManifest)).toThrow()
    expect(() => validateParsedPublicationPlan({ ...plan, id: '../../outside' })).toThrow()
  })
})

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}
