import { expect, it, vi } from 'vitest'
import { PreferenceWriter } from '../src/renderer/preference-writer'

it('coalesces pending values, persists in order, and never previews stale responses', async () => {
  let finish!: (value: number) => void
  const save = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve }))
    .mockImplementation(async (value: number) => value)
  const preview = vi.fn()
  const writer = new PreferenceWriter(0, save, preview, vi.fn())
  const done = writer.write(1)
  await Promise.resolve()
  void writer.write(2)
  void writer.write(3)
  finish(1)
  await done
  expect(save.mock.calls).toEqual([[1], [3]])
  expect(preview.mock.calls.map(([value]) => value)).toEqual([1, 2, 3, 3])
})

it('rolls back a failed latest save and permits retry', async () => {
  const save = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(3)
  const preview = vi.fn(), error = vi.fn()
  const writer = new PreferenceWriter(0, save, preview, error)
  await writer.write(1)
  await writer.write(2)
  expect(preview).toHaveBeenLastCalledWith(1)
  expect(error).toHaveBeenCalledTimes(1)
  await writer.write(3)
  expect(preview).toHaveBeenLastCalledWith(3)
})
