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

function levenshtein(a: string, b: string) {
  const aa = Array.from(a)
  const bb = Array.from(b)
  const previous = Array.from({ length: bb.length + 1 }, (_, index) => index)
  const current = new Array<number>(bb.length + 1)

  for (let i = 1; i <= aa.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= bb.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= bb.length; j += 1) previous[j] = current[j]
  }
  return previous[bb.length]
}

function stripParticle(value: string) {
  for (const particle of PARTICLES) {
    if (value.length > particle.length && value.endsWith(particle)) {
      return { stem: value.slice(0, -particle.length), particle }
    }
  }
  return { stem: value, particle: '' }
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

export function mergeMatchBoxes(...groups: MatchBox[][]) {
  const merged: MatchBox[] = []
  for (const match of groups.flat()) addResult(merged, match)
  return merged
}

export function findMatches(words: OcrWord[], query: string, mode: MatchMode): MatchBox[] {
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

  for (const paragraphWords of paragraphs.values()) {
    const ordered = [...paragraphWords].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    const pieces = ordered.map((word) => toChars(word.text).join(''))
    const text = pieces.join('')
    const owners: CharacterOwner[] = []
    const wordStarts: number[] = []
    let characterCursor = 0

    ordered.forEach((word, wordIndex) => {
      wordStarts[wordIndex] = characterCursor
      const chars = toChars(word.text)
      const symbolBoxes = getSymbolCharBoxes(word)
      chars.forEach((_, offset) => {
        owners.push({ wordIndex, offset, length: chars.length, bbox: symbolBoxes[offset] })
        characterCursor += 1
      })
    })

    if (mode === 'contains') {
      let cursor = text.indexOf(normalizedQuery)
      while (cursor !== -1) {
        const startOwner = owners[cursor]
        const endOwner = owners[cursor + normalizedQuery.length - 1]
        if (startOwner && endOwner) {
          const matched = ordered.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
          addResult(results, {
            id: `contains:${matched.map((word) => word.id).join('+')}:${cursor}`,
            text: matched.map((word) => word.text).join(' '),
            wordIds: matched.map((word) => word.id),
            bbox: partialBoundingBox(ordered, owners, cursor, cursor + normalizedQuery.length - 1),
          })
        }
        cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
      }
    } else {
      // Exact name matching still accepts normal Korean particles attached to the name.
      let cursor = text.indexOf(normalizedQuery)
      while (cursor !== -1) {
        const startOwner = owners[cursor]
        const endOwner = owners[cursor + normalizedQuery.length - 1]
        if (startOwner && endOwner && startOwner.offset === 0) {
          const endWordText = pieces[endOwner.wordIndex]
          const suffix = endWordText.slice(endOwner.offset + 1)
          if (!suffix || PARTICLES.includes(suffix)) {
            const matched = ordered.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
            addResult(results, {
              id: `exact:${matched.map((word) => word.id).join('+')}:${cursor}`,
              text: matched.map((word) => word.text).join(' '),
              wordIds: matched.map((word) => word.id),
              bbox: partialBoundingBox(ordered, owners, cursor, cursor + normalizedQuery.length - 1),
            })
          }
        }
        cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
      }
    }

    // OCR recovery: compare one-to-three neighboring OCR tokens with the requested name.
    // One wrong/missing glyph is accepted for names of 3+ characters, while a recognized
    // Korean particle is stripped before comparison so "히사키의" can still suggest 히사카.
    if (normalizedQuery.length >= 3) {
      for (let startWord = 0; startWord < ordered.length; startWord += 1) {
        let candidate = ''
        for (let endWord = startWord; endWord < Math.min(ordered.length, startWord + 3); endWord += 1) {
          candidate += pieces[endWord]
          const { stem } = stripParticle(candidate)
          if (stem.length >= normalizedQuery.length - 1 && stem.length <= normalizedQuery.length + 1) {
            const distance = levenshtein(stem, normalizedQuery)
            if (distance === 1) {
              const startIndex = wordStarts[startWord]
              const endIndex = startIndex + Math.min(stem.length, owners.length - startIndex) - 1
              const matched = ordered.slice(startWord, endWord + 1)
              if (endIndex >= startIndex && owners[startIndex] && owners[endIndex]) {
                addResult(results, {
                  id: `fuzzy:${matched.map((word) => word.id).join('+')}:${startIndex}`,
                  text: matched.map((word) => word.text).join(' '),
                  wordIds: matched.map((word) => word.id),
                  bbox: partialBoundingBox(ordered, owners, startIndex, endIndex),
                })
              }
            }
          }
          if (candidate.length > normalizedQuery.length + 5) break
        }
      }
    }
  }

  return results
}
