import { describe, expect, it } from 'vitest'
import {
  captureReadingPosition,
  restoreReadingPosition,
} from '../src/renderer/reader/use-reading-anchor'

describe('cross-platform reading anchors', () => {
  it('captures and restores the token intersecting the viewport anchor line', () => {
    const token = fakeElement({ top: 290, height: 20 }, { tokenIndex: '7' })
    const block = fakeElement({ top: 250, height: 200 }, { readerBlockId: 'block_00000001' }, [token])
    token.parentBlock = block
    const article = fakeArticle([block])
    const container = fakeContainer(100, 400, 2_000, 80)

    const captured = captureReadingPosition(article, container)
    expect(captured).toEqual({
      scrollTop: 80,
      anchorBlockId: 'block_00000001',
      anchorTokenIndex: 7,
      anchorFraction: 0.25,
    })

    block.rect = rect(400, 200)
    token.rect = rect(450, 20)
    container.scrollTop = 100
    expect(restoreReadingPosition(article, container, captured)).toBe(true)
    expect(container.scrollTop).toBe(260)
  })

  it('falls back to a stable fraction within the block when no word crosses the anchor line', () => {
    const token = fakeElement({ top: 330, height: 20 }, { tokenIndex: '2' })
    const block = fakeElement({ top: 250, height: 200 }, { readerBlockId: 'block_00000002' }, [token])
    token.parentBlock = block
    const article = fakeArticle([block])
    const container = fakeContainer(100, 400, 2_000, 80)

    const captured = captureReadingPosition(article, container)
    expect(captured.anchorTokenIndex).toBeNull()
    expect(captured.anchorFraction).toBe(0.25)

    block.rect = rect(500, 400)
    container.scrollTop = 100
    expect(restoreReadingPosition(article, container, captured)).toBe(true)
    expect(container.scrollTop).toBe(400)
  })

  it('uses the legacy pixel offset when the stable block no longer exists', () => {
    const article = fakeArticle([])
    const container = fakeContainer(0, 400, 2_000, 0)

    expect(restoreReadingPosition(article, container, {
      scrollTop: 345,
      anchorBlockId: 'missing_00000001',
      anchorTokenIndex: 4,
      anchorFraction: 0.5,
    })).toBe(false)
    expect(container.scrollTop).toBe(345)
  })
})

type RectInput = { top: number; height: number }

interface FakeElement {
  rect: DOMRect
  dataset: DOMStringMap
  tokens: FakeElement[]
  parentBlock: FakeElement | null
  getBoundingClientRect(): DOMRect
  querySelectorAll<T extends Element>(selector: string): T[]
  querySelector<T extends Element>(selector: string): T | null
  closest<T extends Element>(selector: string): T | null
}

function fakeElement(
  input: RectInput,
  dataset: Record<string, string>,
  tokens: FakeElement[] = [],
): FakeElement {
  return {
    rect: rect(input.top, input.height),
    dataset: dataset as DOMStringMap,
    tokens,
    parentBlock: null,
    getBoundingClientRect() { return this.rect },
    querySelectorAll<T extends Element>(selector: string): T[] {
      return selector === '.lookup-word[data-token-index]' ? this.tokens as unknown as T[] : []
    },
    querySelector<T extends Element>(selector: string): T | null {
      const tokenIndex = selector.match(/data-token-index="(\d+)"/)?.[1]
      return (this.tokens.find((token) => token.dataset.tokenIndex === tokenIndex) ?? null) as T | null
    },
    closest<T extends Element>(selector: string): T | null {
      return (selector === '[data-reader-block-id]' ? this.parentBlock : null) as T | null
    },
  }
}

function fakeArticle(blocks: FakeElement[]): HTMLElement {
  return {
    querySelectorAll<T extends Element>(selector: string): T[] {
      return selector === '[data-reader-block-id]' ? blocks as unknown as T[] : []
    },
    querySelector<T extends Element>(selector: string): T | null {
      const blockId = selector.match(/data-reader-block-id="([^"]+)"/)?.[1]
      return (blocks.find((block) => block.dataset.readerBlockId === blockId) ?? null) as T | null
    },
  } as unknown as HTMLElement
}

function fakeContainer(
  top: number,
  clientHeight: number,
  scrollHeight: number,
  scrollTop: number,
): HTMLElement {
  return {
    clientHeight,
    scrollHeight,
    scrollTop,
    getBoundingClientRect: () => rect(top, clientHeight),
  } as unknown as HTMLElement
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}
