import type { BoundingBox, MatchBox, OcrWord } from './types'

export type MatchMode = 'exact' | 'contains'

const compact = (value: string) => value.replace(/\s+/g, '').normalize('NFC')
const toChars = (value: string) => Array.from(compact(value).toLocaleLowerCase())

const PARTICLES = [
  '한테서', '에게서', '이라도', '이라고', '이라면', '으로서', '으로써',
  '에게', '한테', '께서', '에서', '부터', '까지', '처럼', '보다', '이라', '라고',
  '으로', '이랑', '하고', '이면', '라도', '마저', '조차',
  '은', '는', '이', '가', '을', '를', '의', '에', '께', '로', '와', '과', '도', '만', '야', '아', '랑', '면',
].sort((a, b) => b.length - a.length)

function unionBoxes(boxes: BoundingBox[]): BoundingBox {
  return {
    x0: Math.min(...boxes.map((box) => box.x0)),
    y0: Math.min(...boxes.map((box) => box.y0)),
    x1: Math.max(...boxes.map((box) => box.x1)),
    y1: Math.max(...boxes.map((box) => box.y1)),
  }
}

function unionWordBoxes(words: OcrWord[]): BoundingBox {
  return unionBoxes(words.map((word) => word.bbox))
}

type CharacterOwner = {
  wordIndex: number
  offset: number
  length: number
  bbox?: BoundingBox
}

function getSymbolCharBoxes(word: OcrWord): (BoundingBox | undefined)[] {
  const wordChars = toChars(word.text)
  const symbols = (word.symbols ?? []).filter((symbol) => compact(symbol.text).length > 0)
  if (!symbols.length) return []

  const symbolBoxes = symbols.flatMap((symbol) => {
    const chars = toChars(symbol.text)
    return chars.map(() => symbol.bbox)
  })

  if (symbolBoxes.length !== wordChars.length) return []
  return symbolBoxes
}

function fallbackPartialBoundingBox(
  words: OcrWord[],
  startOwner: CharacterOwner,
  endOwner: CharacterOwner,
): BoundingBox {
  const matched = words.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
  const box = unionWordBoxes(matched)
  const startWord = words[startOwner.wordIndex]
  const endWord = words[endOwner.wordIndex]

  const startWidth = startWord.bbox.x1 - startWord.bbox.x0
  const endWidth = endWord.bbox.x1 - endWord.bbox.x0

  box.x0 = startWord.bbox.x0 + startWidth * (startOwner.offset / Math.max(1, startOwner.length))
  box.x1 = endWord.bbox.x0 + endWidth * ((endOwner.offset + 1) / Math.max(1, endOwner.length))
  return box
}

function partialBoundingBox(
  words: OcrWord[],
  owners: CharacterOwner[],
  startIndex: number,
  endIndex: number,
): BoundingBox {
  const matchedOwners = owners.slice(startIndex, endIndex + 1)
  if (matchedOwners.length && matchedOwners.every((owner) => owner.bbox)) {
    return unionBoxes(matchedOwners.map((owner) => owner.bbox!))
  }
  return fallbackPartialBoundingBox(words, owners[startIndex], owners[endIndex])
}

function boxOverlap(a: BoundingBox, b: BoundingBox) {
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  if (x1 <= x0 || y1 <= y0) return 0
  const intersection = (x1 - x0) * (y1 - y0)
  const areaA = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0))
  const areaB = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0))
  return intersection / Math.min(areaA, areaB)
}

function addResult(results: MatchBox[], result: MatchBox) {
  const duplicate = results.some((existing) => boxOverlap(existing.bbox, result.bbox) > 0.72)
  if (!duplicate) results.push(result)
}

// Visual-template candidates turned out to be too aggressive for real logs.
// Keep this helper for compatibility with App.tsx, but only trust the OCR-backed group.
export function mergeMatchBoxes(...groups: MatchBox[][]) {
  const merged: MatchBox[] = []
  const trusted = groups[0] ?? []
  for (const match of trusted) addResult(merged, match)
  return merged
}

export function findMatches(words: OcrWord[], query: string, mode: MatchMode): MatchBox[] {
  const normalizedQuery = compact(query).toLocaleLowerCase()
  if (!normalizedQuery) return []

  const lines = new Map<string, OcrWord[]>()
  for (const word of words) {
    const line = lines.get(word.lineId)
    if (line) line.push(word)
    else lines.set(word.lineId, [word])
  }

  const results: MatchBox[] = []

  for (const lineWords of lines.values()) {
    const ordered = [...lineWords].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    const pieces = ordered.map((word) => toChars(word.text).join(''))
    const text = pieces.join('')
    const owners: CharacterOwner[] = []

    ordered.forEach((word, wordIndex) => {
      const chars = toChars(word.text)
      const symbolBoxes = getSymbolCharBoxes(word)
      chars.forEach((_, offset) => {
        owners.push({ wordIndex, offset, length: chars.length, bbox: symbolBoxes[offset] })
      })
    })

    let cursor = text.indexOf(normalizedQuery)
    while (cursor !== -1) {
      const startOwner = owners[cursor]
      const endOwner = owners[cursor + normalizedQuery.length - 1]

      if (startOwner && endOwner) {
        const endWordText = pieces[endOwner.wordIndex]
        const suffix = endWordText.slice(endOwner.offset + 1)
        const startsAtTokenBoundary = startOwner.offset === 0
        const acceptableSuffix = !suffix || PARTICLES.includes(suffix)
        const acceptable = mode === 'contains' || (startsAtTokenBoundary && acceptableSuffix)

        if (acceptable) {
          const matched = ordered.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
          addResult(results, {
            id: `${mode}:${matched.map((word) => word.id).join('+')}:${cursor}`,
            text: matched.map((word) => word.text).join(' '),
            wordIds: matched.map((word) => word.id),
            bbox: partialBoundingBox(ordered, owners, cursor, cursor + normalizedQuery.length - 1),
          })
        }
      }

      cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    }
  }

  return results
}
