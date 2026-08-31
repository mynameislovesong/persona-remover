import type { BoundingBox, MatchBox, OcrWord } from './types'

export type MatchMode = 'exact' | 'contains'

const compact = (value: string) => value.replace(/\s+/g, '').normalize('NFC')
const toChars = (value: string) => Array.from(compact(value).toLocaleLowerCase())

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

  box.x0 =
    startWord.bbox.x0 +
    startWidth * (startOwner.offset / Math.max(1, startOwner.length))
  box.x1 =
    endWord.bbox.x0 +
    endWidth * ((endOwner.offset + 1) / Math.max(1, endOwner.length))

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

export function findMatches(
  words: OcrWord[],
  query: string,
  mode: MatchMode,
): MatchBox[] {
  const normalizedQuery = compact(query).toLocaleLowerCase()
  if (!normalizedQuery) return []

  const paragraphs = new Map<string, OcrWord[]>()
  for (const word of words) {
    const parts = word.lineId.split('-')
    const paragraphId = parts[0] === 'fallback' ? 'fallback' : parts.slice(0, -1).join('-')
    const paragraph = paragraphs.get(paragraphId)
    if (paragraph) paragraph.push(word)
    else paragraphs.set(paragraphId, [word])
  }

  const results: MatchBox[] = []
  const seen = new Set<string>()

  for (const paragraphWords of paragraphs.values()) {
    const ordered = [...paragraphWords]
    const pieces = ordered.map((word) => toChars(word.text).join(''))
    const text = pieces.join('')
    const owners: CharacterOwner[] = []

    ordered.forEach((word, wordIndex) => {
      const chars = toChars(word.text)
      const symbolBoxes = getSymbolCharBoxes(word)

      chars.forEach((_, offset) => {
        owners.push({
          wordIndex,
          offset,
          length: chars.length,
          bbox: symbolBoxes[offset],
        })
      })
    })

    if (mode === 'exact') {
      for (let start = 0; start < ordered.length; start += 1) {
        let candidate = ''
        for (let end = start; end < ordered.length; end += 1) {
          candidate += pieces[end]
          if (candidate === normalizedQuery) {
            const matched = ordered.slice(start, end + 1)
            const id = matched.map((word) => word.id).join('+')
            if (!seen.has(id)) {
              seen.add(id)
              results.push({
                id,
                text: matched.map((word) => word.text).join(' '),
                wordIds: matched.map((word) => word.id),
                bbox: unionWordBoxes(matched),
              })
            }
          }
          if (candidate.length >= normalizedQuery.length) break
        }
      }
      continue
    }

    let cursor = text.indexOf(normalizedQuery)
    while (cursor !== -1) {
      const startOwner = owners[cursor]
      const endOwner = owners[cursor + normalizedQuery.length - 1]

      if (startOwner && endOwner) {
        const matched = ordered.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
        const id = `${matched.map((word) => word.id).join('+')}:${cursor}`

        if (!seen.has(id)) {
          seen.add(id)
          results.push({
            id,
            text: matched.map((word) => word.text).join(' '),
            wordIds: matched.map((word) => word.id),
            bbox: partialBoundingBox(
              ordered,
              owners,
              cursor,
              cursor + normalizedQuery.length - 1,
            ),
          })
        }
      }

      cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    }
  }

  return results
}
