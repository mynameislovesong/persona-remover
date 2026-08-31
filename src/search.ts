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
    const text = ordered.map((word) => compact(word.text)).join('').toLocaleLowerCase()
    const owners: number[] = []
    ordered.forEach((word, index) => {
      for (let i = 0; i < compact(word.text).length; i += 1) owners.push(index)
    })

    if (mode === 'exact') {
      for (let start = 0; start < ordered.length; start += 1) {
        let candidate = ''
        for (let end = start; end < ordered.length; end += 1) {
          candidate += compact(ordered[end].text).toLocaleLowerCase()
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
        const matched = ordered.slice(startOwner, endOwner + 1)
        const id = `${matched.map((word) => word.id).join('+')}:${cursor}`
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
      cursor = text.indexOf(normalizedQuery, cursor + Math.max(1, normalizedQuery.length))
    }
  }

  return results
}
