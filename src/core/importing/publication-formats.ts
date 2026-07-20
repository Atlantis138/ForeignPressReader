import type { PublicationImporter } from '../ports'

export interface PublicationFormatAdapter {
  id: string
  name: string
  extensions: readonly string[]
  maxBytes: number
  importer: PublicationImporter
}

export class PublicationFormatRegistry {
  private readonly formats = new Map<string, PublicationFormatAdapter>()

  constructor(formats: readonly PublicationFormatAdapter[] = []) {
    for (const format of formats) this.register(format)
  }

  register(format: PublicationFormatAdapter): void {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(format.id)) throw new Error('出版物格式 ID 无效')
    if (format.extensions.length === 0) throw new Error(`${format.name} 未配置文件扩展名`)
    if (!Number.isSafeInteger(format.maxBytes) || format.maxBytes <= 0) throw new Error(`${format.name} 的大小限制无效`)
    if (this.formats.has(format.id)) throw new Error(`出版物格式 ${format.id} 已注册`)
    const normalizedExtensions = format.extensions.map(normalizeExtension)
    for (const existing of this.formats.values()) {
      if (existing.extensions.some((extension) => normalizedExtensions.includes(normalizeExtension(extension)))) {
        throw new Error(`${format.name} 的文件扩展名已被其他格式注册`)
      }
    }
    this.formats.set(format.id, { ...format, extensions: normalizedExtensions })
  }

  resolve(fileName: string): PublicationFormatAdapter {
    const lower = fileName.toLowerCase()
    const format = [...this.formats.values()].find((candidate) =>
      candidate.extensions.some((extension) => lower.endsWith(`.${normalizeExtension(extension)}`)),
    )
    if (!format) throw new Error(`不支持该文件格式；当前支持：${this.listExtensions().join('、')}`)
    return format
  }

  list(): PublicationFormatAdapter[] {
    return [...this.formats.values()]
  }

  listExtensions(): string[] {
    return this.list().flatMap((format) => format.extensions.map((extension) => `.${extension}`))
  }
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\./, '')
  if (!/^[a-z0-9]+$/.test(normalized)) throw new Error('出版物文件扩展名无效')
  return normalized
}
