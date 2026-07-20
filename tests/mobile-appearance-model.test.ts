import { describe, expect, it } from 'vitest'
import { readerColumnPreset, readerColumnValue, READER_COLUMN_PRESETS } from '../src/renderer/tauri/mobile-appearance-model'

describe('Android E1 reader column presets', () => {
  it('maps compact, standard and wide presets to the Windows-compatible widths', () => {
    expect(READER_COLUMN_PRESETS).toEqual([
      { id: 'compact', label: '紧凑', value: 640 },
      { id: 'standard', label: '标准', value: 760 },
      { id: 'wide', label: '宽阔', value: 900 },
    ])
    expect(readerColumnValue('compact')).toBe(640)
    expect(readerColumnValue('standard')).toBe(760)
    expect(readerColumnValue('wide')).toBe(900)
  })

  it('preserves a custom Windows width until the user selects a preset', () => {
    expect(readerColumnPreset(760)).toBe('standard')
    expect(readerColumnPreset(812)).toBeNull()
  })
})
