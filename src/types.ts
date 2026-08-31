export type ImageStatus = 'queued' | 'ocr' | 'detected' | 'edited' | 'error'

export type BoundingBox = { x0: number; y0: number; x1: number; y1: number }

export type OcrSymbol = {
  text: string
  bbox: BoundingBox
}

export type OcrWord = {
  id: string
  lineId: string
  text: string
  confidence: number
  bbox: BoundingBox
  symbols?: OcrSymbol[]
}

export type MatchBox = {
  id: string
  text: string
  wordIds: string[]
  bbox: BoundingBox
}

export type ImageItem = {
  id: string
  originalName: string
  sourceBlob: Blob
  sourceUrl: string
  width: number
  height: number
  status: ImageStatus
  progress: number
  words: OcrWord[]
  excludedMatchIds: string[]
  resultBlob?: Blob
  resultUrl?: string
  error?: string
}
