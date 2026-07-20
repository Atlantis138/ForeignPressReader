export type ReaderColumnPreset = 'compact' | 'standard' | 'wide'

export const READER_COLUMN_PRESETS: ReadonlyArray<{ id: ReaderColumnPreset; label: string; value: number }> = [
  { id: 'compact', label: '紧凑', value: 640 },
  { id: 'standard', label: '标准', value: 760 },
  { id: 'wide', label: '宽阔', value: 900 },
]

export function readerColumnPreset(value: number): ReaderColumnPreset | null {
  return READER_COLUMN_PRESETS.find((preset) => preset.value === value)?.id ?? null
}

export function readerColumnValue(preset: ReaderColumnPreset): number {
  return READER_COLUMN_PRESETS.find((item) => item.id === preset)?.value ?? 760
}
