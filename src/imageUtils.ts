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
