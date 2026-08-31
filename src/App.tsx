import {
  Check,
  Download,
  Eye,
  FileImage,
  Images,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import {
  cleanedFilename,
  downloadBlob,
  drawImageToCanvas,
  eraseMatches,
  normalizeImage,
} from './imageUtils'
import { findMatches, type MatchMode } from './search'
import type { BoundingBox, ImageItem, OcrWord } from './types'

const ACCEPTED = /\.(png|jpe?g|webp)$/i

const statusCopy = {
  queued: '대기',
  ocr: 'OCR 중',
  detected: '검출 완료',
  edited: '편집 완료',
  error: '오류',
} as const

type TesseractWordLike = {
  text?: string
  confidence?: number
  bbox?: BoundingBox
}

type TesseractLineLike = {
  words?: TesseractWordLike[]
}

type TesseractParagraphLike = {
  lines?: TesseractLineLike[]
}

type TesseractBlockLike = {
  paragraphs?: TesseractParagraphLike[]
}

function extractWords(data: unknown): OcrWord[] {
  const shaped = data as { blocks?: TesseractBlockLike[]; words?: TesseractWordLike[] }
  const words: OcrWord[] = []

  if (shaped.blocks) {
    shaped.blocks.forEach((block, blockIndex) => {
      block.paragraphs?.forEach((paragraph, paragraphIndex) => {
        paragraph.lines?.forEach((line, lineIndex) => {
          line.words?.forEach((word, wordIndex) => {
            if (!word.text?.trim() || !word.bbox) return
            words.push({
              id: `${blockIndex}-${paragraphIndex}-${lineIndex}-${wordIndex}`,
              lineId: `${blockIndex}-${paragraphIndex}-${lineIndex}`,
              text: word.text.trim(),
              confidence: word.confidence ?? 0,
              bbox: word.bbox,
            })
          })
        })
      })
    })
  } else if (shaped.words) {
    shaped.words.forEach((word, index) => {
      if (!word.text?.trim() || !word.bbox) return
      words.push({
        id: `word-${index}`,
        lineId: `fallback-${Math.round(word.bbox.y0 / 16)}`,
        text: word.text.trim(),
        confidence: word.confidence ?? 0,
        bbox: word.bbox,
      })
    })
  }
  return words
}

function App() {
  const [items, setItems] = useState<ImageItem[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [query, setQuery] = useState('')
  const [matchMode, setMatchMode] = useState<MatchMode>('exact')
  const [editMode, setEditMode] = useState<'erase' | 'mask'>('erase')
  const [replacementText, setReplacementText] = useState('□□')
  const [padding, setPadding] = useState(3)
  const [viewMode, setViewMode] = useState<'before' | 'after'>('before')
  const [highlightedWord, setHighlightedWord] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [editingAll, setEditingAll] = useState(false)
  const [zipping, setZipping] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const itemsRef = useRef<ImageItem[]>([])
  const workerRef = useRef<Promise<Worker> | null>(null)
  const ocrBusyRef = useRef(false)
  const ocrImageIdRef = useRef<string | undefined>(undefined)

  const replaceItems = useCallback((updater: (current: ImageItem[]) => ImageItem[]) => {
    setItems((current) => {
      const next = updater(current)
      itemsRef.current = next
      return next
    })
  }, [])

  const updateItem = useCallback(
    (id: string, patch: Partial<ImageItem>) => {
      replaceItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    },
    [replaceItems],
  )

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = createWorker(['kor', 'eng'], OEM.LSTM_ONLY, {
        logger(message) {
          if (message.status !== 'recognizing text' || !ocrImageIdRef.current) return
          updateItem(ocrImageIdRef.current, { progress: Math.round((message.progress ?? 0) * 100) })
        },
      }).then(async (worker) => {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
        return worker
      })
    }
    return workerRef.current
  }, [updateItem])

  useEffect(() => {
    const queued = items.find((item) => item.status === 'queued')
    if (!queued || ocrBusyRef.current) return
    ocrBusyRef.current = true
    ocrImageIdRef.current = queued.id
    updateItem(queued.id, { status: 'ocr', progress: 0, error: undefined })

    void (async () => {
      try {
        const worker = await getWorker()
        const result = await worker.recognize(queued.sourceBlob, {}, { blocks: true })
        const words = extractWords(result.data)
        updateItem(queued.id, { status: 'detected', progress: 100, words })
      } catch (error) {
        const message = error instanceof Error ? error.message : '알 수 없는 OCR 오류'
        updateItem(queued.id, {
          status: 'error',
          error: `OCR 분석에 실패했습니다. 네트워크 연결과 브라우저 메모리를 확인해 주세요. (${message})`,
        })
      } finally {
        ocrImageIdRef.current = undefined
        ocrBusyRef.current = false
        setItems((current) => [...current])
      }
    })()
  }, [getWorker, items, updateItem])

  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.sourceUrl)
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
      }
      void workerRef.current?.then((worker) => worker.terminate())
    },
    [],
  )

  const activeItem = items.find((item) => item.id === activeId) ?? items[0]
  const activeMatches = useMemo(
    () => findMatches(activeItem?.words ?? [], query, matchMode),
    [activeItem?.words, matchMode, query],
  )
  const selectedMatches = useMemo(
    () => activeMatches.filter((match) => !activeItem?.excludedMatchIds.includes(match.id)),
    [activeItem?.excludedMatchIds, activeMatches],
  )

  const matchesFor = useCallback(
    (item: ImageItem) => findMatches(item.words, query, matchMode),
    [matchMode, query],
  )

  const invalidateResults = useCallback((preserveSelection = false) => {
    replaceItems((current) =>
      current.map((item) => {
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
        return {
          ...item,
          excludedMatchIds: preserveSelection ? item.excludedMatchIds : [],
          resultBlob: undefined,
          resultUrl: undefined,
          status: item.status === 'edited' ? 'detected' : item.status,
        }
      }),
    )
    setViewMode('before')
  }, [replaceItems])

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList)
      const valid = incoming.filter((file) => {
        const supportedMime = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
        return supportedMime || ACCEPTED.test(file.name)
      })
      if (valid.length !== incoming.length) {
        setNotice('PNG, JPG, JPEG, WebP 이미지만 추가할 수 있습니다.')
      } else {
        setNotice(undefined)
      }

      for (const file of valid) {
        try {
          const normalized = await normalizeImage(file)
          const id = `${Date.now()}-${crypto.randomUUID()}`
          const next: ImageItem = {
            id,
            originalName: file.name,
            ...normalized,
            status: 'queued',
            progress: 0,
            words: [],
            excludedMatchIds: [],
          }
          replaceItems((current) => [...current, next])
          setActiveId((current) => current ?? id)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : `${file.name} 처리에 실패했습니다.`)
        }
      }
    },
    [replaceItems],
  )

  useEffect(() => {
    if (!activeItem || !canvasRef.current) return
    const canvas = canvasRef.current
    const previewUrl = viewMode === 'after' && activeItem.resultUrl ? activeItem.resultUrl : activeItem.sourceUrl
    let cancelled = false

    void drawImageToCanvas(previewUrl, canvas).then((context) => {
      if (cancelled || viewMode === 'after') return
      const scale = Math.max(activeItem.width, activeItem.height) / 1400
      const lineWidth = Math.max(2, scale * 2)

      for (const match of activeMatches) {
        const selected = !activeItem.excludedMatchIds.includes(match.id)
        const { x0, y0, x1, y1 } = match.bbox
        context.fillStyle = selected ? 'rgba(235, 88, 74, 0.24)' : 'rgba(75, 85, 99, 0.12)'
        context.strokeStyle = selected ? '#e14b3b' : '#6b7280'
        context.lineWidth = lineWidth
        context.fillRect(x0 - padding, y0 - padding, x1 - x0 + padding * 2, y1 - y0 + padding * 2)
        context.strokeRect(x0 - padding, y0 - padding, x1 - x0 + padding * 2, y1 - y0 + padding * 2)
      }

      const word = activeItem.words.find((candidate) => candidate.id === highlightedWord)
      if (word) {
        const { x0, y0, x1, y1 } = word.bbox
        context.strokeStyle = '#087f71'
        context.lineWidth = lineWidth * 2
        context.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6)
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeItem, activeMatches, highlightedWord, padding, viewMode])

  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!activeItem || viewMode === 'after') return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - bounds.left) / bounds.width) * activeItem.width
    const y = ((event.clientY - bounds.top) / bounds.height) * activeItem.height
    const match = [...activeMatches].reverse().find(({ bbox }) => {
      return x >= bbox.x0 - padding && x <= bbox.x1 + padding && y >= bbox.y0 - padding && y <= bbox.y1 + padding
    })
    if (!match) return
    const excluded = new Set(activeItem.excludedMatchIds)
    if (excluded.has(match.id)) excluded.delete(match.id)
    else excluded.add(match.id)
    updateItem(activeItem.id, { excludedMatchIds: [...excluded] })
  }

  async function editItem(item: ImageItem) {
    const matches = matchesFor(item).filter((match) => !item.excludedMatchIds.includes(match.id))
    if (!matches.length) return
    try {
      const blob = await eraseMatches(
        item.sourceUrl,
        matches,
        padding,
        editMode === 'mask' ? replacementText : undefined,
      )
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
      updateItem(item.id, { status: 'edited', resultBlob: blob, resultUrl: URL.createObjectURL(blob) })
      return true
    } catch (error) {
      updateItem(item.id, {
        status: 'error',
        error: error instanceof Error ? error.message : '이미지 편집에 실패했습니다.',
      })
      return false
    }
  }

  async function editActive() {
    if (!activeItem) return
    const success = await editItem(activeItem)
    if (success) setViewMode('after')
  }

  async function editAll() {
    setEditingAll(true)
    try {
      for (const item of itemsRef.current) {
        if (item.status === 'detected' || item.status === 'edited') await editItem(item)
      }
      setViewMode('after')
    } finally {
      setEditingAll(false)
    }
  }

  function removeItem(id: string) {
    const target = itemsRef.current.find((item) => item.id === id)
    if (target) {
      URL.revokeObjectURL(target.sourceUrl)
      if (target.resultUrl) URL.revokeObjectURL(target.resultUrl)
    }
    replaceItems((current) => current.filter((item) => item.id !== id))
    if (activeId === id) setActiveId(itemsRef.current.find((item) => item.id !== id)?.id)
  }

  function resetAll() {
    for (const item of itemsRef.current) {
      URL.revokeObjectURL(item.sourceUrl)
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
    }
    replaceItems(() => [])
    setActiveId(undefined)
    setQuery('')
    setViewMode('before')
    setNotice(undefined)
  }

  async function downloadAll() {
    const completed = items.filter((item) => item.resultBlob)
    if (!completed.length) return
    setZipping(true)
    try {
      const zip = new JSZip()
      completed.forEach((item) => zip.file(cleanedFilename(item.originalName), item.resultBlob!))
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
      downloadBlob(blob, 'cleaned_images.zip')
    } finally {
      setZipping(false)
    }
  }

  const ocrItem = items.find((item) => item.status === 'ocr')
  const ocrPosition = ocrItem ? items.findIndex((item) => item.id === ocrItem.id) + 1 : 0
  const completedCount = items.filter((item) => item.resultBlob).length
  const activeMatchCount = activeMatches.length

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={18} /></span>
          <div><strong>페르소나 리무버</strong><span>Persona Remover</span></div>
        </div>
        <div className="privacy-pill"><LockKeyhole size={15} />이미지는 서버로 전송되지 않습니다</div>
        {items.length > 0 && (
          <button className="icon-button" type="button" onClick={resetAll} title="전체 초기화" aria-label="전체 초기화">
            <RotateCcw size={18} />
          </button>
        )}
      </header>

      {ocrItem && (
        <div className="global-progress" role="status">
          <span>OCR 분석 중... {ocrItem.progress}%</span>
          <strong>{ocrPosition} / {items.length} 분석 중</strong>
          <div className="progress-track"><span style={{ width: `${ocrItem.progress}%` }} /></div>
        </div>
      )}

      <main className={`workspace ${items.length ? '' : 'workspace-empty'}`}>
        {items.length === 0 ? (
          <section className="empty-stage" aria-labelledby="empty-title">
            <div className="empty-copy">
              <h1 id="empty-title">Persona Remover</h1>
              <p>채팅·RP 로그 이미지를 올리면 브라우저 안에서 이름 위치를 찾고, 확인한 영역만 주변 배경색으로 덮습니다.</p>
              <div className="privacy-note"><LockKeyhole size={17} /><span><strong>완전히 로컬에서 처리됩니다.</strong> 이미지 파일과 OCR 결과는 서버에 업로드되거나 저장되지 않습니다.</span></div>
            </div>
            <DropZone
              dragging={dragging}
              setDragging={setDragging}
              onFiles={handleFiles}
              onChoose={() => fileInputRef.current?.click()}
            />
          </section>
        ) : (
          <>
            <aside className="file-rail">
              <div className="rail-heading"><span>이미지</span><strong>{items.length}</strong></div>
              <button className="add-more" type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} />이미지 추가
              </button>
              <div className="file-list">
                {items.map((item, index) => (
                  <button
                    type="button"
                    className={`file-item ${activeItem?.id === item.id ? 'active' : ''}`}
                    key={item.id}
                    onClick={() => { setActiveId(item.id); setHighlightedWord(undefined); setViewMode('before') }}
                  >
                    <img src={item.sourceUrl} alt="" />
                    <span className="file-meta">
                      <span className="file-name">{index + 1}. {item.originalName}</span>
                      <span className={`status status-${item.status}`}>
                        {item.status === 'ocr' && <LoaderCircle size={12} className="spin" />}
                        {item.status === 'edited' && <Check size={12} />}
                        {statusCopy[item.status]}{item.status === 'ocr' ? ` ${item.progress}%` : ''}
                      </span>
                    </span>
                    <span
                      className="remove-file"
                      role="button"
                      tabIndex={0}
                      aria-label={`${item.originalName} 제거`}
                      onClick={(event) => { event.stopPropagation(); removeItem(item.id) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') removeItem(item.id) }}
                    ><X size={15} /></span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="workbench">
              <div className="controls-bar">
                <label className="search-field">
                  <Search size={18} />
                  <input
                    value={query}
                    onChange={(event) => { invalidateResults(); setQuery(event.target.value) }}
                    placeholder="찾을 이름 (예: 뤼붕이)"
                    aria-label="찾을 이름"
                  />
                  {query && <button type="button" onClick={() => { invalidateResults(); setQuery('') }} aria-label="검색어 지우기"><X size={16} /></button>}
                </label>
                <div className="segmented" aria-label="검색 모드">
                  <button className={matchMode === 'exact' ? 'active' : ''} type="button" onClick={() => { invalidateResults(); setMatchMode('exact') }}>정확히</button>
                  <button className={matchMode === 'contains' ? 'active' : ''} type="button" onClick={() => { invalidateResults(); setMatchMode('contains') }}>포함</button>
                </div>
                <div className="segmented edit-mode" aria-label="처리 방식">
                  <button className={editMode === 'erase' ? 'active' : ''} type="button" onClick={() => { invalidateResults(true); setEditMode('erase') }}>완전 삭제</button>
                  <button className={editMode === 'mask' ? 'active' : ''} type="button" onClick={() => { invalidateResults(true); setEditMode('mask') }}>텍스트로 치환</button>
                </div>
                {editMode === 'mask' && (
                  <label className="replacement-field">
                    <span>치환값</span>
                    <input
                      value={replacementText}
                      maxLength={32}
                      onChange={(event) => { invalidateResults(true); setReplacementText(event.target.value) }}
                      placeholder="□□"
                      aria-label="치환할 텍스트"
                    />
                  </label>
                )}
                <label className="padding-control">
                  <span>여백 <strong>{padding}px</strong></span>
                  <input type="range" min="0" max="16" value={padding} onChange={(event) => { invalidateResults(true); setPadding(Number(event.target.value)) }} />
                </label>
              </div>

              <div className="preview-toolbar">
                <div className="segmented view-switch" aria-label="비교 보기">
                  <button className={viewMode === 'before' ? 'active' : ''} type="button" onClick={() => setViewMode('before')}>원본</button>
                  <button className={viewMode === 'after' ? 'active' : ''} type="button" disabled={!activeItem?.resultUrl} onClick={() => setViewMode('after')}>편집 결과</button>
                </div>
                <div className="detection-summary">
                  <span className="dot" />{query ? `${activeMatchCount}개 검출 · ${selectedMatches.length}개 선택` : '이름을 입력해 주세요'}
                </div>
                <span className="dimensions">{activeItem?.width.toLocaleString()} × {activeItem?.height.toLocaleString()} px</span>
              </div>

              <div className="preview-area">
                {activeItem?.status === 'error' ? (
                  <div className="error-state"><strong>분석을 완료하지 못했습니다.</strong><p>{activeItem.error}</p><button type="button" onClick={() => updateItem(activeItem.id, { status: 'queued', error: undefined })}>OCR 다시 시도</button></div>
                ) : (
                  <canvas ref={canvasRef} onClick={handleCanvasClick} className={viewMode === 'before' && activeMatchCount ? 'interactive' : ''} aria-label="이미지 검출 결과 미리보기" />
                )}
              </div>

              <div className="action-bar">
                <div className="selection-help"><Eye size={16} />박스를 눌러 처리 대상에서 제외하거나 다시 선택하세요.</div>
                <div className="action-buttons">
                  <button className="button secondary" type="button" disabled={!activeItem?.resultBlob} onClick={() => activeItem?.resultBlob && downloadBlob(activeItem.resultBlob, cleanedFilename(activeItem.originalName))}>
                    <Download size={17} />현재 PNG
                  </button>
                  <button className="button primary" type="button" disabled={!selectedMatches.length || activeItem?.status === 'ocr' || (editMode === 'mask' && !replacementText)} onClick={editActive}>
                    <Trash2 size={17} />{editMode === 'erase' ? '선택 영역 지우기' : '선택 영역 치환'}
                  </button>
                </div>
              </div>
            </section>

            <aside className="text-panel">
              <div className="panel-heading">
                <div><span>OCR 텍스트</span><strong>{activeItem?.words.length ?? 0}</strong></div>
                <p>텍스트를 누르면 이미지에서 위치를 표시합니다.</p>
              </div>
              <div className="word-list">
                {activeItem?.status === 'ocr' || activeItem?.status === 'queued' ? (
                  <div className="panel-empty"><LoaderCircle className="spin" size={22} /><span>텍스트를 읽는 중입니다.</span></div>
                ) : activeItem?.words.length ? (
                  activeItem.words.map((word) => (
                    <button type="button" key={word.id} className={`${highlightedWord === word.id ? 'active' : ''} ${activeMatches.some((match) => match.wordIds.includes(word.id)) ? 'matched' : ''}`} onClick={() => { setHighlightedWord(word.id); setViewMode('before') }}>
                      <span>{word.text}</span><small>{Math.round(word.confidence)}%</small>
                    </button>
                  ))
                ) : (
                  <div className="panel-empty"><FileImage size={24} /><span>인식된 텍스트가 없습니다.<br />더 선명한 이미지를 시도해 주세요.</span></div>
                )}
              </div>
              <div className="batch-actions">
                <button className="button secondary" type="button" disabled={!items.some((item) => matchesFor(item).length) || editingAll || (editMode === 'mask' && !replacementText)} onClick={editAll}>
                  {editingAll ? <LoaderCircle className="spin" size={17} /> : <Images size={17} />}전체 이미지 편집
                </button>
                <button className="button dark" type="button" disabled={!completedCount || zipping} onClick={downloadAll}>
                  {zipping ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}전체 다운로드 ({completedCount})
                </button>
              </div>
            </aside>
          </>
        )}
      </main>

      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        multiple
        onChange={(event) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = '' }}
      />
      {notice && <div className="toast" role="alert">{notice}<button type="button" onClick={() => setNotice(undefined)} aria-label="알림 닫기"><X size={15} /></button></div>}
    </div>
  )
}

type DropZoneProps = {
  dragging: boolean
  setDragging: (value: boolean) => void
  onFiles: (files: FileList | File[]) => Promise<void>
  onChoose: () => void
}

function DropZone({ dragging, setDragging, onFiles, onChoose }: DropZoneProps) {
  return (
    <div
      className={`drop-zone ${dragging ? 'dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void onFiles(event.dataTransfer.files) }}
    >
      <div className="upload-icon"><Upload size={27} /></div>
      <strong>이미지를 여기에 놓으세요</strong>
      <span>PNG · JPG · JPEG · WebP · 여러 장 가능</span>
      <button className="button primary" type="button" onClick={onChoose}><Images size={18} />이미지 선택</button>
      <small>원본 해상도를 유지하고 EXIF 방향을 바로잡습니다.</small>
    </div>
  )
}

export default App
