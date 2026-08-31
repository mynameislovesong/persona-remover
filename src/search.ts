import type { BoundingBox, MatchBox, OcrWord } from './types'

export type MatchMode = 'exact' | 'contains'

function unionBoxes(words: OcrWord[]): BoundingBox {
  return {
    x0: Math.min(...words.map((word) => word.bbox.x0)),
    y0: Math.min(...words.map((word) => word.bbox.y0)),
    x1: Math.max(...words.map((word) => word.bbox.x1)),
    y1: Math.max(...words.map((word) => word.bbox.y1)),
  }
}

const compact = (value: string) => value.replace(/\s+/g, '').normalize('NFC')

type CharacterOwner = {
  wordIndex: number
  offset: number
  length: number
}

function partialBoundingBox(
  words: OcrWord[],
  startOwner: CharacterOwner,
  endOwner: CharacterOwner,
): BoundingBox {
  const matched = words.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
  const box = unionBoxes(matched)
  const startWord = words[startOwner.wordIndex]
  const endWord = words[endOwner.wordIndex]

  // Tesseract often returns Korean particles attached to the name as one word
  // (for example "뤼붕이를"). When the search only matches part of that word,
  // estimate the matched character range inside the word box instead of
  // erasing the whole OCR token. Hangul glyphs are close to fixed-width, so
  // this is substantially more accurate for chat-log screenshots.
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
    const pieces = ordered.map((word) => compact(word.text).toLocaleLowerCase())
    const text = pieces.join('')
    const owners: CharacterOwner[] = []

    pieces.forEach((piece, wordIndex) => {
      for (let offset = 0; offset < piece.length; offset += 1) {
        owners.push({ wordIndex, offset, length: piece.length })
      }
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
                bbox: unionBoxes(matched),
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
      if (startOwner !== undefined && endOwner !== undefined) {
        const matched = ordered.slice(startOwner.wordIndex, endOwner.wordIndex + 1)
        const id = `${matched.map((word) => word.id).join('+')}:${cursor}`
        if (!seen.has(id)) {
          seen.add(id)
          results.push({
            id,
            text: matched.map((word) => word.text).join(' '),
            wordIds: matched.map((word) => word.id),
            bbox: partialBoundingBox(ordered, startOwner, endOwner),
          })
        }
      }
      cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    }
  }

  return results
}
