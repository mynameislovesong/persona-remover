import type { BoundingBox, MatchBox } from './types'

type GrayFrame = {
  width: number
  height: number
  scale: number
  data: Float32Array
}

type FeaturePoint = {
  u: number
  v: number
  value: number
}

type Candidate = {
  bbox: BoundingBox
  score: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('이미지를 브라우저에서 열 수 없습니다.'))
    image.src = url
  })

function median(values: number[]) {
  if (!values.length) return 255
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function makeGrayFrame(url: string, maxLongest = 900): Promise<GrayFrame> {
  const image = await loadImage(url)
  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  const scale = Math.min(1, maxLongest / Math.max(1, longest))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) throw new Error('Canvas를 사용할 수 없습니다.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  const data = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    data[index] = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
  }
  return { width, height, scale, data }
}

function grayAt(frame: GrayFrame, x: number, y: number) {
  const xx = clamp(Math.round(x), 0, frame.width - 1)
  const yy = clamp(Math.round(y), 0, frame.height - 1)
  return frame.data[yy * frame.width + xx]
}

function borderSamples(frame: GrayFrame, box: BoundingBox) {
  const x0 = clamp(Math.floor(box.x0), 0, frame.width - 1)
  const y0 = clamp(Math.floor(box.y0), 0, frame.height - 1)
  const x1 = clamp(Math.ceil(box.x1), x0 + 1, frame.width)
  const y1 = clamp(Math.ceil(box.y1), y0 + 1, frame.height)
  const values: number[] = []
  const stepX = Math.max(1, Math.floor((x1 - x0) / 12))
  const stepY = Math.max(1, Math.floor((y1 - y0) / 8))
  for (let x = x0; x < x1; x += stepX) {
    values.push(grayAt(frame, x, y0), grayAt(frame, x, y1 - 1))
  }
  for (let y = y0; y < y1; y += stepY) {
    values.push(grayAt(frame, x0, y), grayAt(frame, x1 - 1, y))
  }
  return values
}

function tightenSeed(frame: GrayFrame, originalBox: BoundingBox) {
  const workBox = {
    x0: clamp(originalBox.x0 * frame.scale, 0, frame.width - 1),
    y0: clamp(originalBox.y0 * frame.scale, 0, frame.height - 1),
    x1: clamp(originalBox.x1 * frame.scale, 1, frame.width),
    y1: clamp(originalBox.y1 * frame.scale, 1, frame.height),
  }
  if (workBox.x1 <= workBox.x0 || workBox.y1 <= workBox.y0) return originalBox

  const background = median(borderSamples(frame, workBox))
  const lightBackground = background >= 128
  let minX = workBox.x1
  let minY = workBox.y1
  let maxX = workBox.x0
  let maxY = workBox.y0
  let found = false

  for (let y = Math.floor(workBox.y0); y < Math.ceil(workBox.y1); y += 1) {
    for (let x = Math.floor(workBox.x0); x < Math.ceil(workBox.x1); x += 1) {
      const gray = grayAt(frame, x, y)
      const signedContrast = lightBackground ? background - gray : gray - background
      if (signedContrast < 24) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + 1)
      maxY = Math.max(maxY, y + 1)
      found = true
    }
  }

  if (!found) return originalBox
  const margin = 1
  return {
    x0: clamp((minX - margin) / frame.scale, originalBox.x0, originalBox.x1),
    y0: clamp((minY - margin) / frame.scale, originalBox.y0, originalBox.y1),
    x1: clamp((maxX + margin) / frame.scale, originalBox.x0, originalBox.x1),
    y1: clamp((maxY + margin) / frame.scale, originalBox.y0, originalBox.y1),
  }
}

function sampleEvenly<T>(items: T[], limit: number) {
  if (items.length <= limit) return items
  const stride = items.length / limit
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * stride)])
}

function makeTemplate(frame: GrayFrame, seedBox: BoundingBox) {
  const box = {
    x0: clamp(Math.floor(seedBox.x0 * frame.scale), 0, frame.width - 1),
    y0: clamp(Math.floor(seedBox.y0 * frame.scale), 0, frame.height - 1),
    x1: clamp(Math.ceil(seedBox.x1 * frame.scale), 1, frame.width),
    y1: clamp(Math.ceil(seedBox.y1 * frame.scale), 1, frame.height),
  }
  const width = Math.max(1, box.x1 - box.x0)
  const height = Math.max(1, box.y1 - box.y0)
  const background = median(borderSamples(frame, box))
  const lightBackground = background >= 128
  const ink: FeaturePoint[] = []
  const quiet: FeaturePoint[] = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gray = grayAt(frame, box.x0 + x, box.y0 + y)
      const contrast = lightBackground ? background - gray : gray - background
      const value = Math.max(0, contrast / 255)
      const point = {
        u: width <= 1 ? 0 : x / (width - 1),
        v: height <= 1 ? 0 : y / (height - 1),
        value,
      }
      if (value >= 0.11) ink.push(point)
      else if (value <= 0.025 && (x + y) % 2 === 0) quiet.push(point)
    }
  }

  if (ink.length < 8) throw new Error('선택한 영역에서 글자 모양을 충분히 찾지 못했습니다. 이름 글자만 조금 더 정확히 선택해 주세요.')
  const anchors = [...ink]
    .sort((a, b) => b.value - a.value)
    .filter((point, index, all) => all.slice(0, index).every((other) => Math.hypot(point.u - other.u, point.v - other.v) > 0.12))
    .slice(0, 7)

  return {
    originalWidth: Math.max(1, seedBox.x1 - seedBox.x0),
    originalHeight: Math.max(1, seedBox.y1 - seedBox.y0),
    lightBackground,
    ink: sampleEvenly(ink, 110),
    quiet: sampleEvenly(quiet, 45),
    anchors: anchors.length >= 4 ? anchors : sampleEvenly(ink, 6),
  }
}

function candidateBackground(frame: GrayFrame, x: number, y: number, width: number, height: number) {
  const x1 = x + width - 1
  const y1 = y + height - 1
  const mx = x + width / 2
  const my = y + height / 2
  return median([
    grayAt(frame, x, y), grayAt(frame, x1, y), grayAt(frame, x, y1), grayAt(frame, x1, y1),
    grayAt(frame, mx, y), grayAt(frame, mx, y1), grayAt(frame, x, my), grayAt(frame, x1, my),
  ])
}

function overlapRatio(a: BoundingBox, b: BoundingBox) {
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

export type ManualTemplateSearchResult = {
  seedBox: BoundingBox
  matches: MatchBox[]
}

export async function findManualTemplateMatches(
  seedSourceUrl: string,
  rawSeedBox: BoundingBox,
  targetSourceUrl: string,
  similarity = 0.82,
): Promise<ManualTemplateSearchResult> {
  const [seedFrame, targetFrame] = await Promise.all([
    makeGrayFrame(seedSourceUrl, 1100),
    makeGrayFrame(targetSourceUrl, 900),
  ])
  const seedBox = tightenSeed(seedFrame, rawSeedBox)
  const template = makeTemplate(seedFrame, seedBox)
  const candidates: Candidate[] = []
  const sizeVariants = [0.92, 0.96, 1, 1.04, 1.08]

  for (const variant of sizeVariants) {
    const width = Math.max(4, Math.round(template.originalWidth * targetFrame.scale * variant))
    const height = Math.max(3, Math.round(template.originalHeight * targetFrame.scale * variant))
    if (width >= targetFrame.width || height >= targetFrame.height) continue

    for (let y = 0; y <= targetFrame.height - height; y += 1) {
      for (let x = 0; x <= targetFrame.width - width; x += 1) {
        const background = candidateBackground(targetFrame, x, y, width, height)
        const lightBackground = background >= 128
        if (lightBackground !== template.lightBackground) continue

        let anchorHits = 0
        for (const anchor of template.anchors) {
          const xx = x + anchor.u * (width - 1)
          const yy = y + anchor.v * (height - 1)
          const gray = grayAt(targetFrame, xx, yy)
          const contrast = lightBackground ? background - gray : gray - background
          const value = Math.max(0, contrast / 255)
          if (value >= Math.max(0.055, anchor.value * 0.34)) anchorHits += 1
        }
        if (anchorHits < Math.max(3, Math.ceil(template.anchors.length * 0.55))) continue

        let inkDifference = 0
        let missingInk = 0
        for (const point of template.ink) {
          const gray = grayAt(targetFrame, x + point.u * (width - 1), y + point.v * (height - 1))
          const contrast = lightBackground ? background - gray : gray - background
          const value = Math.max(0, contrast / 255)
          inkDifference += Math.abs(point.value - value)
          if (value < 0.045) missingInk += 1
        }
        inkDifference /= template.ink.length
        missingInk /= template.ink.length

        let backgroundInk = 0
        for (const point of template.quiet) {
          const gray = grayAt(targetFrame, x + point.u * (width - 1), y + point.v * (height - 1))
          const contrast = lightBackground ? background - gray : gray - background
          backgroundInk += Math.max(0, contrast / 255)
        }
        if (template.quiet.length) backgroundInk /= template.quiet.length

        const score = 1 - inkDifference * 1.08 - missingInk * 0.34 - backgroundInk * 0.48
        if (score < similarity) continue
        candidates.push({
          score,
          bbox: {
            x0: x / targetFrame.scale,
            y0: y / targetFrame.scale,
            x1: (x + width) / targetFrame.scale,
            y1: (y + height) / targetFrame.scale,
          },
        })
      }
    }
  }

  if (seedSourceUrl === targetSourceUrl) {
    candidates.push({ bbox: seedBox, score: 1 })
  }

  const accepted: Candidate[] = []
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (accepted.some((existing) => overlapRatio(existing.bbox, candidate.bbox) > 0.48)) continue
    accepted.push(candidate)
    if (accepted.length >= 80) break
  }

  return {
    seedBox,
    matches: accepted.map((candidate, index) => ({
      id: `visual:${index}:${Math.round(candidate.bbox.x0)}:${Math.round(candidate.bbox.y0)}`,
      text: `이미지 유사도 ${Math.round(candidate.score * 100)}%`,
      wordIds: [],
      bbox: candidate.bbox,
    })),
  }
}
