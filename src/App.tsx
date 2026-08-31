import {
  Check,
  Download,
  Eye,
  Images,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cleanedFilename,
  downloadBlob,
  drawImageToCanvas,
  eraseMatches,
  normalizeImage,
} from './imageUtils'
import { findManualTemplateMatches } from './manualTemplate'
import type { BoundingBox, ImageItem, MatchBox } from './types'

const ACCEPTED = /\.(png|jpe?g|webp)$/i

const statusCopy = {
  queued: '준비 중',
  ocr: '분석 중',
  detected: '준비',
  edited: '편집 완료',
  error: '오류',
} as const

type SeedSelection = {
  imageId: string
  bbox: BoundingBox
}

type Point = { x: number; y: number }

function normalizedBox(a: Point, b: Point): BoundingBox {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  }
}

function App() {
  const [items, setItems] = useState<ImageItem[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [seed, setSeed] = useState<SeedSelection>()
  const [displaySeedBox, setDisplaySeedBox] = useState<BoundingBox>()
  const [matchesById, setMatchesById] = useState<Record<string, MatchBox[]>>({})
  const [selectionMode, setSelectionMode] = useState(false)
  const [dragStart, setDragStart] = useState<Point>()
  const [draftBox, setDraftBox] = useState<BoundingBox>()
  const [similarity, setSimilarity] = useState(82)
  const [padding, setPadding] = useState(2)
  const [viewMode, setViewMode] = useState<'before' | 'after'>('before')
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [matching, setMatching] = useState(false)
  const [matchingProgress, setMatchingProgress] = useState({ done: 0, total: 0 })
  const [editingAll, setEditingAll] = useState(false)
  const [zipping, setZipping] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const itemsRef = useRef<ImageItem[]>([])
  const searchGenerationRef = useRef(0)

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

  useEffect(
    () => () => {
      searchGenerationRef.current += 1
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.sourceUrl)
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
      }
    },
    [],
  )

  const activeItem = items.find((item) => item.id === activeId) ?? items[0]
  const activeMatches = activeItem ? matchesById[activeItem.id] ?? [] : []
  const selectedMatches = useMemo(
    () => activeMatches.filter((match) => !activeItem?.excludedMatchIds.includes(match.id)),
    [activeItem?.excludedMatchIds, activeMatches],
  )
  const itemKey = useMemo(() => items.map((item) => item.id).join('|'), [items])

  const runSearch = useCallback(async () => {
    if (!seed) return
    const sourceItem = itemsRef.current.find((item) => item.id === seed.imageId)
    if (!sourceItem) return

    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    setMatching(true)
    setMatchingProgress({ done: 0, total: itemsRef.current.length })
    setMatchesById({})
    replaceItems((current) =>
      current.map((item) => {
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
        return {
          ...item,
          excludedMatchIds: [],
          resultBlob: undefined,
          resultUrl: undefined,
          status: item.status === 'error' ? item.status : 'detected',
        }
      }),
    )
    setViewMode('before')

    const nextMatches: Record<string, MatchBox[]> = {}
    let done = 0
    try {
      for (const item of itemsRef.current) {
        if (generation !== searchGenerationRef.current) return
        const result = await findManualTemplateMatches(
          sourceItem.sourceUrl,
          seed.bbox,
          item.sourceUrl,
          similarity / 100,
        )
        if (generation !== searchGenerationRef.current) return
        nextMatches[item.id] = result.matches
        if (item.id === seed.imageId) setDisplaySeedBox(result.seedBox)
        done += 1
        setMatchingProgress({ done, total: itemsRef.current.length })
        setMatchesById({ ...nextMatches })
      }

      const total = Object.values(nextMatches).reduce((sum, matches) => sum + matches.length, 0)
      if (!total) setNotice('같은 모양을 찾지 못했습니다. 이름 영역을 글자에 조금 더 딱 맞게 다시 지정해 보세요.')
      else setNotice(undefined)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '이미지 모양 탐색에 실패했습니다.')
    } finally {
      if (generation === searchGenerationRef.current) setMatching(false)
    }
  }, [replaceItems, seed, similarity])

  useEffect(() => {
    if (!seed || !itemKey) return
    const timer = window.setTimeout(() => void runSearch(), 260)
    return () => window.clearTimeout(timer)
  }, [itemKey, runSearch, seed])

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList)
      const valid = incoming.filter((file) => {
        const supportedMime = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
        return supportedMime || ACCEPTED.test(file.name)
      })
      if (valid.length !== incoming.length) setNotice('PNG, JPG, JPEG, WebP 이미지만 추가할 수 있습니다.')
      else setNotice(undefined)

      for (const file of valid) {
        try {
          const normalized = await normalizeImage(file)
          const id = `${Date.now()}-${crypto.randomUUID()}`
          const next: ImageItem = {
            id,
            originalName: file.name,
            ...normalized,
            status: 'detected',
            progress: 100,
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
        context.fillStyle = selected ? 'rgba(235, 88, 74, 0.2)' : 'rgba(75, 85, 99, 0.1)'
        context.strokeStyle = selected ? '#e14b3b' : '#7a8582'
        context.lineWidth = lineWidth
        context.fillRect(x0 - padding, y0 - padding, x1 - x0 + padding * 2, y1 - y0 + padding * 2)
        context.strokeRect(x0 - padding, y0 - padding, x1 - x0 + padding * 2, y1 - y0 + padding * 2)
      }

      if (seed?.imageId === activeItem.id && displaySeedBox) {
        const { x0, y0, x1, y1 } = displaySeedBox
        context.save()
        context.strokeStyle = '#087f71'
        context.lineWidth = lineWidth * 1.7
        context.setLineDash([8 * scale, 5 * scale])
        context.strokeRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4)
        context.restore()
      }

      if (draftBox && selectionMode) {
        const { x0, y0, x1, y1 } = draftBox
        context.save()
        context.fillStyle = 'rgba(8, 127, 113, .12)'
        context.strokeStyle = '#087f71'
        context.lineWidth = lineWidth * 1.5
        context.setLineDash([9 * scale, 6 * scale])
        context.fillRect(x0, y0, x1 - x0, y1 - y0)
        context.strokeRect(x0, y0, x1 - x0, y1 - y0)
        context.restore()
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeItem, activeMatches, displaySeedBox, draftBox, padding, seed?.imageId, selectionMode, viewMode])

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>): Point | undefined {
    if (!activeItem) return undefined
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return undefined
    return {
      x: Math.max(0, Math.min(activeItem.width, ((event.clientX - bounds.left) / bounds.width) * activeItem.width)),
      y: Math.max(0, Math.min(activeItem.height, ((event.clientY - bounds.top) / bounds.height) * activeItem.height)),
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeItem || viewMode === 'after') return
    const point = canvasPoint(event)
    if (!point) return

    if (selectionMode) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragStart(point)
      setDraftBox({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
      return
    }

    const match = [...activeMatches].reverse().find(({ bbox }) => {
      return point.x >= bbox.x0 - padding && point.x <= bbox.x1 + padding && point.y >= bbox.y0 - padding && point.y <= bbox.y1 + padding
    })
    if (!match) return
    const excluded = new Set(activeItem.excludedMatchIds)
    if (excluded.has(match.id)) excluded.delete(match.id)
    else excluded.add(match.id)
    updateItem(activeItem.id, { excludedMatchIds: [...excluded] })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!selectionMode || !dragStart) return
    const point = canvasPoint(event)
    if (!point) return
    event.preventDefault()
    setDraftBox(normalizedBox(dragStart, point))
  }

  function finishSelection(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!selectionMode || !dragStart || !activeItem) return
    const point = canvasPoint(event)
    if (!point) return
    event.preventDefault()
    const box = normalizedBox(dragStart, point)
    setDragStart(undefined)
    setDraftBox(undefined)
    if (box.x1 - box.x0 < 6 || box.y1 - box.y0 < 6) {
      setNotice('글자 전체가 들어가도록 조금 더 크게 드래그해 주세요.')
      return
    }
    searchGenerationRef.current += 1
    setSeed({ imageId: activeItem.id, bbox: box })
    setDisplaySeedBox(box)
    setMatchesById({})
    setSelectionMode(false)
    setNotice(undefined)
    setViewMode('before')
  }

  async function editItem(item: ImageItem) {
    const matches = (matchesById[item.id] ?? []).filter((match) => !item.excludedMatchIds.includes(match.id))
    if (!matches.length) return false
    try {
      const blob = await eraseMatches(item.sourceUrl, matches, padding)
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
      for (const item of itemsRef.current) await editItem(item)
      setViewMode('after')
    } finally {
      setEditingAll(false)
    }
  }

  function startSelection() {
    if (!activeItem) return
    setSelectionMode(true)
    setViewMode('before')
    setDraftBox(undefined)
    setDragStart(undefined)
    setNotice(undefined)
  }

  function cancelSelection() {
    setSelectionMode(false)
    setDraftBox(undefined)
    setDragStart(undefined)
  }

  function removeItem(id: string) {
    const target = itemsRef.current.find((item) => item.id === id)
    if (target) {
      URL.revokeObjectURL(target.sourceUrl)
      if (target.resultUrl) URL.revokeObjectURL(target.resultUrl)
    }
    searchGenerationRef.current += 1
    replaceItems((current) => current.filter((item) => item.id !== id))
    setMatchesById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    if (seed?.imageId === id) {
      setSeed(undefined)
      setDisplaySeedBox(undefined)
      setMatchesById({})
    }
    if (activeId === id) setActiveId(itemsRef.current.find((item) => item.id !== id)?.id)
  }

  function resetAll() {
    searchGenerationRef.current += 1
    for (const item of itemsRef.current) {
      URL.revokeObjectURL(item.sourceUrl)
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
    }
    replaceItems(() => [])
    setActiveId(undefined)
    setSeed(undefined)
    setDisplaySeedBox(undefined)
    setMatchesById({})
    setSelectionMode(false)
    setDraftBox(undefined)
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

  const totalMatches = Object.values(matchesById).reduce((sum, matches) => sum + matches.length, 0)
  const completedCount = items.filter((item) => item.resultBlob).length

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={18} /></span>
          <div><strong>페르소나 리무버</strong><span>Persona Remover</span></div>
        </div>
        <div className="privacy-pill"><LockKeyhole size={15} />이미지는 기기 안에서만 처리됩니다</div>
        {items.length > 0 && (
          <button className="icon-button" type="button" onClick={resetAll} title="전체 초기화" aria-label="전체 초기화">
            <RotateCcw size={18} />
          </button>
        )}
      </header>

      {matching && (
        <div className="global-progress" role="status">
          <span><LoaderCircle size={13} className="spin" /> 같은 이름 모양 찾는 중…</span>
          <strong>{matchingProgress.done} / {matchingProgress.total}</strong>
          <div className="progress-track"><span style={{ width: `${matchingProgress.total ? (matchingProgress.done / matchingProgress.total) * 100 : 0}%` }} /></div>
        </div>
      )}

      <main className={`workspace ${items.length ? '' : 'workspace-empty'}`}>
        {items.length === 0 ? (
          <section className="empty-stage" aria-labelledby="empty-title">
            <div className="empty-copy">
              <span className="section-kicker">NO OCR · NO API · LOCAL ONLY</span>
              <h1 id="empty-title">이름 하나만 찍으면<br />같은 이름을 전부 찾습니다.</h1>
              <p>로그 이미지를 올리고 이름 한 군데를 손가락이나 마우스로 지정하세요. 글자를 읽지 않고 모양 자체를 비교해서 같은 이름을 찾아냅니다.</p>
              <div className="privacy-note"><LockKeyhole size={17} /><span><strong>서버로 전송하지 않습니다.</strong> OCR API 없이 브라우저 안에서 이미지 모양만 비교하고, 결과 이미지도 기기에서 바로 만듭니다.</span></div>
            </div>
            <DropZone dragging={dragging} setDragging={setDragging} onFiles={handleFiles} onChoose={() => fileInputRef.current?.click()} />
          </section>
        ) : (
          <>
            <aside className="file-rail">
              <div className="rail-heading"><span>이미지</span><strong>{items.length}</strong></div>
              <button className="add-more" type="button" onClick={() => fileInputRef.current?.click()}><Upload size={16} />이미지 추가</button>
              <div className="file-list">
                {items.map((item, index) => (
                  <button
                    type="button"
                    className={`file-item ${activeItem?.id === item.id ? 'active' : ''}`}
                    key={item.id}
                    onClick={() => { setActiveId(item.id); setViewMode('before'); cancelSelection() }}
                  >
                    <img src={item.sourceUrl} alt="" />
                    <span className="file-meta">
                      <span className="file-name">{index + 1}. {item.originalName}</span>
                      <span className={`status status-${item.status}`}>
                        {item.status === 'edited' && <Check size={12} />}
                        {statusCopy[item.status]}{matchesById[item.id]?.length ? ` · ${matchesById[item.id].length}개` : ''}
                      </span>
                    </span>
                    <span className="remove-file" role="button" tabIndex={0} aria-label={`${item.originalName} 제거`} onClick={(event) => { event.stopPropagation(); removeItem(item.id) }} onKeyDown={(event) => { if (event.key === 'Enter') removeItem(item.id) }}><X size={15} /></span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="workbench">
              <div className="controls-bar visual-controls">
                <button className={`button ${selectionMode ? 'dark' : 'primary'}`} type="button" onClick={selectionMode ? cancelSelection : startSelection}>
                  <MousePointer2 size={17} />{selectionMode ? '선택 취소' : seed ? '이름 다시 지정' : '이름 영역 지정'}
                </button>
                <label className="similarity-control">
                  <span>일치 기준 <strong>{similarity}%</strong></span>
                  <input type="range" min="72" max="94" value={similarity} onChange={(event) => setSimilarity(Number(event.target.value))} />
                </label>
                <label className="padding-control">
                  <span>삭제 여백 <strong>{padding}px</strong></span>
                  <input type="range" min="0" max="8" value={padding} onChange={(event) => { setPadding(Number(event.target.value)); setViewMode('before') }} />
                </label>
                <button className="button secondary" type="button" disabled={!seed || matching} onClick={() => void runSearch()}><RefreshCw size={16} />다시 찾기</button>
              </div>

              <div className={`selection-banner ${selectionMode ? 'active' : ''}`}>
                {selectionMode
                  ? <><MousePointer2 size={16} /><strong>이미지에서 이름 글자만 드래그하세요.</strong><span>조사는 빼고, 이름 바깥 여백은 조금만 포함하는 게 가장 잘 잡힙니다.</span></>
                  : seed
                    ? <><Check size={16} /><strong>이름 모양 지정됨</strong><span>{matching ? '다른 이미지까지 같은 모양을 찾고 있습니다.' : `총 ${totalMatches}개 후보를 찾았습니다.`}</span></>
                    : <><Eye size={16} /><strong>먼저 이름 하나를 지정하세요.</strong><span>OCR 대신 직접 지정한 글자 모양을 기준으로 찾습니다.</span></>}
              </div>

              <div className="preview-toolbar">
                <div className="segmented view-switch" aria-label="비교 보기">
                  <button className={viewMode === 'before' ? 'active' : ''} type="button" onClick={() => setViewMode('before')}>원본</button>
                  <button className={viewMode === 'after' ? 'active' : ''} type="button" disabled={!activeItem?.resultUrl} onClick={() => setViewMode('after')}>편집 결과</button>
                </div>
                <div className="detection-summary"><span className="dot" />{seed ? `${activeMatches.length}개 후보 · ${selectedMatches.length}개 선택` : '이름 영역 미지정'}</div>
                <span className="dimensions">{activeItem?.width.toLocaleString()} × {activeItem?.height.toLocaleString()} px</span>
              </div>

              <div className="preview-area">
                {activeItem?.status === 'error' ? (
                  <div className="error-state"><strong>처리하지 못했습니다.</strong><p>{activeItem.error}</p></div>
                ) : (
                  <canvas
                    ref={canvasRef}
                    className={`${viewMode === 'before' && activeMatches.length ? 'interactive' : ''} ${selectionMode ? 'selecting' : ''}`}
                    aria-label="이미지 모양 검출 결과 미리보기"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishSelection}
                    onPointerCancel={() => { setDragStart(undefined); setDraftBox(undefined) }}
                  />
                )}
              </div>

              <div className="action-bar">
                <div className="selection-help"><Eye size={16} />빨간 박스를 누르면 삭제 대상에서 제외하거나 다시 선택할 수 있어요.</div>
                <div className="action-buttons">
                  <button className="button secondary" type="button" disabled={!activeItem?.resultBlob} onClick={() => activeItem?.resultBlob && downloadBlob(activeItem.resultBlob, cleanedFilename(activeItem.originalName))}><Download size={17} />현재 PNG</button>
                  <button className="button primary" type="button" disabled={!selectedMatches.length || matching} onClick={editActive}><Trash2 size={17} />선택 영역 지우기</button>
                </div>
              </div>
            </section>

            <aside className="text-panel guide-panel">
              <div className="panel-heading">
                <div><span>사용 방법</span><strong>3</strong></div>
                <p>글자를 읽는 대신 모양을 직접 기억합니다.</p>
              </div>
              <div className="guide-steps">
                <div className={seed ? 'done' : 'current'}><b>1</b><span><strong>이름 하나 지정</strong><small>예: ‘히사카’ 글자 부분만 드래그</small></span></div>
                <div className={seed && !matching ? 'done' : seed ? 'current' : ''}><b>2</b><span><strong>자동으로 같은 모양 찾기</strong><small>여러 이미지도 한 번에 탐색</small></span></div>
                <div className={completedCount ? 'done' : totalMatches ? 'current' : ''}><b>3</b><span><strong>확인하고 지우기</strong><small>틀린 후보는 이미지에서 탭해 제외</small></span></div>
                <div className="guide-tip"><Sparkles size={15} /><span><strong>잘 안 잡히면</strong> ‘일치 기준’을 조금 낮추고, 엉뚱한 곳까지 잡히면 조금 올려보세요.</span></div>
              </div>
              <div className="batch-actions">
                <button className="button secondary" type="button" disabled={!totalMatches || editingAll || matching} onClick={editAll}>{editingAll ? <LoaderCircle className="spin" size={17} /> : <Images size={17} />}전체 이미지 지우기</button>
                <button className="button dark" type="button" disabled={!completedCount || zipping} onClick={downloadAll}>{zipping ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}전체 다운로드 ({completedCount})</button>
              </div>
            </aside>
          </>
        )}
      </main>

      <input ref={fileInputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple onChange={(event) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = '' }} />
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
    <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={(event) => { event.preventDefault(); setDragging(false); void onFiles(event.dataTransfer.files) }}>
      <div className="upload-icon"><Upload size={27} /></div>
      <strong>이미지를 여기에 놓으세요</strong>
      <span>PNG · JPG · JPEG · WebP · 여러 장 가능</span>
      <button className="button primary" type="button" onClick={onChoose}><Images size={18} />이미지 선택</button>
      <small>업로드 후 이름 한 군데만 지정하면 됩니다.</small>
    </div>
  )
}

export default App
