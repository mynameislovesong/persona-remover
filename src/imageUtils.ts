import type { BoundingBox, MatchBox } from './types'

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('이미지를 브라우저에서 열 수 없습니다.'))
    image.src = url
  })

export async function normalizeImage(file: File) {
  const inputUrl = URL.createObjectURL(file)
  try {
    const image = await loadImage(inputUrl)
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) throw new Error('이미지 크기를 확인할 수 없습니다.')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
    if (!context) throw new Error('Canvas를 사용할 수 없습니다.')
    context.drawImage(image, 0, 0, width, height)

    const sourceBlob = await canvasToBlob(canvas)
    return { sourceBlob, width, height, sourceUrl: URL.createObjectURL(sourceBlob) }
  } finally {
    URL.revokeObjectURL(inputUrl)
  }
}

export async function prepareImageForOcr(sourceUrl: string) {
  const image = await loadImage(sourceUrl)
  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  const scale = longest <= 1400 ? 2 : longest <= 2200 ? 1.5 : 1
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) throw new Error('OCR용 Canvas를 사용할 수 없습니다.')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)

  const frame = context.getImageData(0, 0, width, height)
  const data = frame.data
  const contrast = 42
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast))

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
    const adjusted = Math.max(0, Math.min(255, factor * (gray - 128) + 128))
    data[index] = adjusted
    data[index + 1] = adjusted
    data[index + 2] = adjusted
    data[index + 3] = 255
  }

  context.putImageData(frame, 0, 0)
  return { blob: await canvasToBlob(canvas), scale }
}

export async function drawImageToCanvas(url: string, canvas: HTMLCanvasElement) {
  const image = await loadImage(url)
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
  if (!context) throw new Error('Canvas를 사용할 수 없습니다.')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
  return context
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function paddedBox(box: BoundingBox, padding: number, width: number, height: number) {
  return {
    x0: clamp(Math.floor(box.x0 - padding), 0, width),
    y0: clamp(Math.floor(box.y0 - padding), 0, height),
    x1: clamp(Math.ceil(box.x1 + padding), 0, width),
    y1: clamp(Math.ceil(box.y1 + padding), 0, height),
  }
}

function median(values: number[]) {
  if (!values.length) return 255
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function estimateBackground(
  data: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  box: BoundingBox,
) {
  const ring = Math.max(2, Math.min(6, Math.round(Math.min(box.x1 - box.x0, box.y1 - box.y0) / 8)))
  const outer = paddedBox(box, ring, canvasWidth, canvasHeight)
  const samples: [number, number, number, number][] = []

  for (let y = outer.y0; y < outer.y1; y += 1) {
    for (let x = outer.x0; x < outer.x1; x += 1) {
      if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue
      const index = (y * canvasWidth + x) * 4
      samples.push([data[index], data[index + 1], data[index + 2], data[index + 3]])
    }
  }

  if (!samples.length) return [255, 255, 255, 255] as const
  const buckets = new Map<string, typeof samples>()
  for (const sample of samples) {
    const key = sample.map((channel) => Math.round(channel / 16)).join(':')
    const bucket = buckets.get(key)
    if (bucket) bucket.push(sample)
    else buckets.set(key, [sample])
  }
  const dominant = [...buckets.values()].sort((a, b) => b.length - a.length)[0] ?? samples
  return [
    median(dominant.map((pixel) => pixel[0])),
    median(dominant.map((pixel) => pixel[1])),
    median(dominant.map((pixel) => pixel[2])),
    median(dominant.map((pixel) => pixel[3])),
  ] as const
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

function darkness(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const index = (y * width + x) * 4
  const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
  return Math.max(0, Math.min(1, (248 - gray) / 248))
}

type TemplatePoint = { x: number; y: number; value: number }
type TemplateCandidate = { bbox: BoundingBox; score: number }

function samplePoints(points: TemplatePoint[], limit: number) {
  if (points.length <= limit) return points
  const stride = points.length / limit
  return Array.from({ length: limit }, (_, index) => points[Math.floor(index * stride)])
}

// Uses one or more OCR-confirmed name boxes as a visual template and searches the same
// screenshot for repeated glyph shapes. This is intentionally lightweight and local: the
// image never leaves the browser, and it mainly helps chat logs where the same font/scale
// repeats many times but OCR misses a few occurrences.
export async function findTemplateMatches(
  sourceUrl: string,
  seedMatches: MatchBox[],
  existingMatches: MatchBox[],
) {
  const validSeeds = seedMatches.filter((match) => {
    const width = match.bbox.x1 - match.bbox.x0
    const height = match.bbox.y1 - match.bbox.y0
    return width >= 12 && height >= 8
  })
  if (!validSeeds.length) return [] as MatchBox[]

  const image = await loadImage(sourceUrl)
  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  const scale = Math.min(0.45, 900 / Math.max(1, longest))
  const workWidth = Math.max(1, Math.round(image.naturalWidth * scale))
  const workHeight = Math.max(1, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = workWidth
  canvas.height = workHeight
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) return [] as MatchBox[]
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, workWidth, workHeight)
  context.drawImage(image, 0, 0, workWidth, workHeight)
  const frame = context.getImageData(0, 0, workWidth, workHeight)

  const widths = validSeeds.map((match) => match.bbox.x1 - match.bbox.x0).sort((a, b) => a - b)
  const medianWidth = widths[Math.floor(widths.length / 2)]
  const seeds = [...validSeeds]
    .sort((a, b) => Math.abs((a.bbox.x1 - a.bbox.x0) - medianWidth) - Math.abs((b.bbox.x1 - b.bbox.x0) - medianWidth))
    .slice(0, 3)

  const candidates: TemplateCandidate[] = []

  for (const seed of seeds) {
    const x0 = clamp(Math.round(seed.bbox.x0 * scale), 0, workWidth - 1)
    const y0 = clamp(Math.round(seed.bbox.y0 * scale), 0, workHeight - 1)
    const x1 = clamp(Math.round(seed.bbox.x1 * scale), x0 + 1, workWidth)
    const y1 = clamp(Math.round(seed.bbox.y1 * scale), y0 + 1, workHeight)
    const templateWidth = x1 - x0
    const templateHeight = y1 - y0
    if (templateWidth < 4 || templateHeight < 3) continue

    const ink: TemplatePoint[] = []
    const background: TemplatePoint[] = []
    for (let y = 0; y < templateHeight; y += 1) {
      for (let x = 0; x < templateWidth; x += 1) {
        const value = darkness(frame.data, workWidth, x0 + x, y0 + y)
        if (value > 0.1) ink.push({ x, y, value })
        else if ((x + y) % 3 === 0) background.push({ x, y, value })
      }
    }
    const inkPoints = samplePoints(ink, 150)
    const backgroundPoints = samplePoints(background, 80)
    if (inkPoints.length < 8) continue

    const probe = inkPoints[Math.floor(inkPoints.length / 2)]
    for (let y = 0; y <= workHeight - templateHeight; y += 1) {
      for (let x = 0; x <= workWidth - templateWidth; x += 1) {
        if (darkness(frame.data, workWidth, x + probe.x, y + probe.y) < 0.04) continue

        let inkDifference = 0
        for (const point of inkPoints) {
          inkDifference += Math.abs(point.value - darkness(frame.data, workWidth, x + point.x, y + point.y))
        }
        inkDifference /= inkPoints.length

        let backgroundDifference = 0
        for (const point of backgroundPoints) {
          backgroundDifference += Math.abs(point.value - darkness(frame.data, workWidth, x + point.x, y + point.y))
        }
        if (backgroundPoints.length) backgroundDifference /= backgroundPoints.length

        const score = 1 - inkDifference * 0.78 - backgroundDifference * 0.22
        if (score < 0.87) continue

        candidates.push({
          score,
          bbox: {
            x0: x / scale,
            y0: y / scale,
            x1: (x + templateWidth) / scale,
            y1: (y + templateHeight) / scale,
          },
        })
      }
    }
  }

  const accepted: TemplateCandidate[] = []
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (existingMatches.some((match) => overlapRatio(match.bbox, candidate.bbox) > 0.55)) continue
    if (accepted.some((item) => overlapRatio(item.bbox, candidate.bbox) > 0.45)) continue
    accepted.push(candidate)
    if (accepted.length >= 30) break
  }

  return accepted.map((candidate, index) => ({
    id: `template:${index}:${Math.round(candidate.bbox.x0)}:${Math.round(candidate.bbox.y0)}`,
    text: '이미지 유사도 후보',
    wordIds: [],
    bbox: candidate.bbox,
  }))
}

export async function eraseMatches(
  sourceUrl: string,
  matches: MatchBox[],
  padding: number,
  replacement?: string,
) {
  const canvas = document.createElement('canvas')
  const context = await drawImageToCanvas(sourceUrl, canvas)
  const frame = context.getImageData(0, 0, canvas.width, canvas.height)
  const processed: { match: MatchBox; fill: readonly [number, number, number, number] }[] = []

  for (const match of matches) {
    const box = paddedBox(match.bbox, padding, canvas.width, canvas.height)
    if (box.x1 <= box.x0 || box.y1 <= box.y0) continue
    const fill = estimateBackground(frame.data, canvas.width, canvas.height, box)
    processed.push({ match, fill })
    for (let y = box.y0; y < box.y1; y += 1) {
      for (let x = box.x0; x < box.x1; x += 1) {
        const index = (y * canvas.width + x) * 4
        frame.data[index] = fill[0]
        frame.data[index + 1] = fill[1]
        frame.data[index + 2] = fill[2]
        frame.data[index + 3] = fill[3]
      }
    }
  }
  context.putImageData(frame, 0, 0)

  if (replacement) {
    context.save()
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const { match, fill } of processed) {
      const width = match.bbox.x1 - match.bbox.x0 + padding * 2
      const height = match.bbox.y1 - match.bbox.y0
      let fontSize = Math.max(8, Math.round(height * 0.88))
      context.font = `600 ${fontSize}px system-ui, sans-serif`
      while (fontSize > 8 && context.measureText(replacement).width > width) {
        fontSize -= 1
        context.font = `600 ${fontSize}px system-ui, sans-serif`
      }
      const luminance = fill[0] * 0.299 + fill[1] * 0.587 + fill[2] * 0.114
      context.fillStyle = luminance > 145 ? 'rgba(35, 42, 40, 0.9)' : 'rgba(250, 252, 251, 0.92)'
      context.fillText(
        replacement,
        (match.bbox.x0 + match.bbox.x1) / 2,
        (match.bbox.y0 + match.bbox.y1) / 2,
        Math.max(1, width),
      )
    }
    context.restore()
  }
  return canvasToBlob(canvas)
}

export function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG 생성에 실패했습니다.'))),
      'image/png',
    )
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function cleanedFilename(originalName: string) {
  const base = originalName.replace(/\.[^.]+$/, '') || 'image'
  return `${base}_cleaned.png`
}
