import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  MOBILE_DICTIONARY_CENTER_CONTRACT_VERSION,
  MOBILE_LEARNING_CONTRACT_VERSION,
  MOBILE_STUDY_MANAGEMENT_CONTRACT_VERSION,
  type MobileDictionaryCenterClient,
  type MobileDictionaryClient,
  type MobileStudyManagementClient,
} from '../src/shared/mobile-learning'
import type { DictionarySearchQuery, StudyDashboard } from '../src/shared/types'
import { TauriMobileDictionaryClient, TauriMobileStudyClient } from '../src/renderer/tauri/mobile-learning-client'

describe('Android formal parity client contracts', () => {
  it('versions the formal dictionary and study clients independently', () => {
    expect(MOBILE_LEARNING_CONTRACT_VERSION).toBe(1)
    expect(MOBILE_DICTIONARY_CENTER_CONTRACT_VERSION).toBe(1)
    expect(MOBILE_STUDY_MANAGEMENT_CONTRACT_VERSION).toBe(1)
    expectTypeOf<MobileDictionaryClient['getDictionaryPackStatus']>().toBeFunction()
  })

  it('reuses platform-neutral dictionary and study DTOs', () => {
    expectTypeOf<Parameters<MobileDictionaryCenterClient['search']>[0]>().toEqualTypeOf<DictionarySearchQuery>()
    expectTypeOf<Awaited<ReturnType<MobileStudyManagementClient['getDashboard']>>>().toEqualTypeOf<StudyDashboard>()
    expectTypeOf<TauriMobileDictionaryClient>().toMatchTypeOf<MobileDictionaryCenterClient>()
    expectTypeOf<TauriMobileStudyClient>().toMatchTypeOf<MobileStudyManagementClient>()
  })

  it('does not expose storage implementation, provider endpoints or credentials', () => {
    const contract = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'mobile-learning.ts'), 'utf8')
    expect(contract).toContain('interface MobileDictionaryCenterClient')
    expect(contract).toContain('interface MobileStudyManagementClient')
    expect(contract).not.toMatch(/\|\s*'deletePlan'/)
    expect(contract).not.toMatch(/(?:databasePath|filePath|absolutePath|sql\s*[:(]|https?:\/\/|apiKey|secretKey)/i)
  })
})
