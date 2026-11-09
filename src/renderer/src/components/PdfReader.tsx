import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Paper, ReaderState, ResearchLine } from '@shared/types'
import { api } from '../api'
import { DATA_URLS, loadViewer, pdfjsLib, type PdfViewerModule } from '../pdfjs'
import ChatPanel from './ChatPanel'

type PdfViewer = InstanceType<PdfViewerModule['PDFViewer']>
type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type Side = 'notes' | 'chat' | 'none'
type Flusher = () => Promise<void>

const { AnnotationEditorType: EDITOR, AnnotationEditorParamsType: PARAM } = pdfjsLib

const MODES = [
  { mode: EDITOR.NONE, label: 'Select', title: 'Read and select text' },
  { mode: EDITOR.HIGHLIGHT, label: 'Highlight', title: 'Highlight text' },
  { mode: EDITOR.FREETEXT, label: 'Text', title: 'Add a text note on the page' },
  { mode: EDITOR.INK, label: 'Draw', title: 'Draw freehand' }
]
const HIGHLIGHT_COLORS = ['#FFFF98', '#53FFBC', '#80EBFF', '#FFCBE6']
const INK_COLORS = ['#1d1c1a', '#d93025', '#1a56db', '#1f7a45']
const COLOR_PARAM: Record<number, number> = {
  [EDITOR.HIGHLIGHT]: PARAM.HIGHLIGHT_COLOR,
  [EDITOR.FREETEXT]: PARAM.FREETEXT_COLOR,
  [EDITOR.INK]: PARAM.INK_COLOR
}
const COLORS: Record<number, string[]> = {
  [EDITOR.HIGHLIGHT]: HIGHLIGHT_COLORS,
  [EDITOR.FREETEXT]: INK_COLORS,
  [EDITOR.INK]: INK_COLORS
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  idle: '',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'Annotations saved',
  error: 'Saving annotations failed'
}

const readSide = (): Side => {
  try {
    const v = localStorage.getItem('readerSide')
    return v === 'notes' || v === 'chat' || v === 'none' ? v : 'notes'
  } catch {
    return 'notes'
  }
}

/** Free-text notes for one paper, saved a moment after you stop typing. */
function NotesPane(props: { paperId: string; register: (f: Flusher) => () => void }) {
  const { paperId } = props
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const latest = useRef({ text: '', dirty: false })
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!latest.current.dirty) return
    latest.current.dirty = false
    setStatus('saving')
    try {
      await api.savePaperNotes(paperId, latest.current.text)
      setStatus(latest.current.dirty ? 'dirty' : 'saved')
    } catch {
      latest.current.dirty = true
      setStatus('error')
    }
  }, [paperId])

  useEffect(() => {
    let cancelled = false
    api.paperNotes(paperId).then((t) => {
      if (cancelled) return
      latest.current = { text: t, dirty: false }
      setText(t)
      setLoaded(true)
    })
    const off = props.register(flush)
    return () => {
      cancelled = true
      off()
      void flush()
    }
  }, [paperId, flush, props.register])

  return (
    <div className="notes">
      <textarea
        value={text}
        disabled={!loaded}
        placeholder="Your notes on this paper — saved automatically."
        spellCheck
        onChange={(e) => {
          latest.current = { text: e.target.value, dirty: true }
          setText(e.target.value)
          setStatus('dirty')
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, 800)
        }}
      />
      <div className="notes-foot muted small">
        {status === 'saved' && loaded && text ? 'Saved' : status === 'saving' ? 'Saving…' : status === 'dirty' ? 'Unsaved…' : status === 'error' ? 'Saving failed' : ''}
      </div>
    </div>
  )
}

export default function PdfReader(props: {
  line: ResearchLine
  paper: Paper
  papers: Paper[]
  bookmarked: boolean
  onToggleBookmark: () => void
}) {
  const { paper } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const viewerRef = useRef<PdfViewer | null>(null)
  const eventBusRef = useRef<InstanceType<PdfViewerModule['EventBus']> | null>(null)

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [mode, setMode] = useState<number>(EDITOR.NONE)
  const [colors, setColors] = useState<Record<number, string>>({
    [EDITOR.HIGHLIGHT]: HIGHLIGHT_COLORS[0],
    [EDITOR.FREETEXT]: INK_COLORS[0],
    [EDITOR.INK]: INK_COLORS[1]
  })
  const [find, setFind] = useState('')
  const [findCount, setFindCount] = useState<{ current: number; total: number } | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [side, setSideState] = useState<Side>(readSide)

  const setSide = (s: Side) => {
    setSideState(s)
    try {
      localStorage.setItem('readerSide', s)
    } catch {}
  }

  // Everything that has to be written out before the window closes.
  const flushers = useRef(new Set<Flusher>())
  const register = useCallback((f: Flusher) => {
    flushers.current.add(f)
    return () => void flushers.current.delete(f)
  }, [])
  useEffect(
    () => api.onBeforeClose(async () => void (await Promise.all([...flushers.current].map((f) => f().catch(() => {}))))),
    []
  )

  useEffect(() => {
    let disposed = false
    let doc: PDFDocumentProxy | null = null
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null
    let pdfViewer: PdfViewer | null = null
    let ready = false
    let pendingState: ReaderState | null = null
    let stateTimer: ReturnType<typeof setTimeout> | undefined
    let annotTimer: ReturnType<typeof setTimeout> | undefined
    let dirty = false
    let saving: Promise<void> | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeFrame = 0

    const writeState = async () => {
      clearTimeout(stateTimer)
      stateTimer = undefined
      const s = pendingState
      pendingState = null
      if (s) await api.saveReaderState(paper.id, s).catch(() => {})
    }

    const writeAnnotations = async (): Promise<void> => {
      clearTimeout(annotTimer)
      if (!doc) return
      if (saving) await saving
      if (!dirty) return
      const d = doc
      dirty = false
      // pdf.js only reports the first edit after a reset, so reset before saving.
      d.annotationStorage.resetModified()
      setSaveStatus('saving')
      const run = (async () => {
        try {
          const bytes = await d.saveDocument()
          await api.saveAnnotations(paper.id, bytes)
          if (!disposed) setSaveStatus(dirty ? 'dirty' : 'saved')
        } catch {
          dirty = true
          if (!disposed) setSaveStatus('error')
        }
      })()
      saving = run
      await run
      if (saving === run) saving = null
    }

    const flush: Flusher = async () => {
      // A stroke or text box you're still working on only counts once its tool is left.
      if (pdfViewer && pdfViewer.annotationEditorMode.mode !== EDITOR.NONE) {
        pdfViewer.annotationEditorMode = { mode: EDITOR.NONE }
        await new Promise((r) => setTimeout(r, 150))
      }
      await writeState()
      await writeAnnotations()
    }
    const unregister = register(flush)

    ;(async () => {
      try {
        const [viewerLib, state, hasPdf] = await Promise.all([loadViewer(), api.readerState(paper.id), api.hasPdf(paper.id)])
        if (disposed) return
        if (!hasPdf) throw new Error(paper.status === 'review' || paper.status === 'pending' ? "This paper's PDF hasn't been downloaded yet." : 'The PDF file is missing.')
        const res = await fetch(`betaxiv://paper/${encodeURIComponent(paper.id)}`)
        if (!res.ok) throw new Error('The PDF file could not be read.')
        const data = new Uint8Array(await res.arrayBuffer())
        if (disposed) return

        task = pdfjsLib.getDocument({ data, ...DATA_URLS })
        doc = await task.promise
        if (disposed) return
        const d = doc

        const eventBus = new viewerLib.EventBus()
        eventBusRef.current = eventBus
        const linkService = new viewerLib.PDFLinkService({ eventBus, externalLinkTarget: viewerLib.LinkTarget.BLANK })
        const findController = new viewerLib.PDFFindController({ linkService, eventBus })
        pdfViewer = new viewerLib.PDFViewer({
          container: containerRef.current!,
          viewer: viewerElRef.current!,
          eventBus,
          linkService,
          findController,
          annotationEditorMode: EDITOR.NONE,
          annotationEditorHighlightColors: 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6',
          enableHighlightFloatingButton: true
        } as ConstructorParameters<PdfViewerModule['PDFViewer']>[0])
        viewerRef.current = pdfViewer
        linkService.setViewer(pdfViewer)

        eventBus.on('pagesinit', () => {
          if (disposed || !pdfViewer) return
          pdfViewer.currentScaleValue = state?.scale ?? 'page-width'
          if (state) {
            const pageNumber = Math.min(state.page, d.numPages)
            if (state.top !== null && pageNumber === state.page) {
              pdfViewer.scrollPageIntoView({
                pageNumber,
                destArray: [null, { name: 'XYZ' }, state.left ?? 0, state.top, null],
                ignoreDestinationZoom: true
              })
            } else pdfViewer.currentPageNumber = pageNumber
          }
          ready = true
          setPages(d.numPages)
          setZoom(Math.round(pdfViewer.currentScale * 100))
          setPhase('ready')
        })
        eventBus.on('pagechanging', (e: { pageNumber: number }) => {
          setPage(e.pageNumber)
          setPageInput(String(e.pageNumber))
        })
        eventBus.on('scalechanging', (e: { scale: number }) => setZoom(Math.round(e.scale * 100)))
        eventBus.on('updateviewarea', (e: { location?: { pageNumber: number; top: number | null; left: number | null } }) => {
          const l = e.location
          if (!ready || !l || !pdfViewer) return
          pendingState = { page: l.pageNumber, top: l.top, left: l.left, scale: String(pdfViewer.currentScaleValue), updatedAt: '' }
          stateTimer ??= setTimeout(writeState, 500)
        })
        const onMatches = (e: { matchesCount?: { current: number; total: number } }) => setFindCount(e.matchesCount ?? null)
        eventBus.on('updatefindmatchescount', onMatches)
        eventBus.on('updatefindcontrolstate', onMatches)

        // Annotations are saved a moment after the last edit into an annotated copy of the PDF.
        ;(d.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => {
          dirty = true
          setSaveStatus('dirty')
          clearTimeout(annotTimer)
          annotTimer = setTimeout(writeAnnotations, 1500)
        }

        // pdf.js doesn't re-fit "page width" etc. when its container changes size (window resized,
        // side panel toggled), so do it here.
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame)
          resizeFrame = requestAnimationFrame(() => {
            if (!ready || !pdfViewer) return
            const cur = String(pdfViewer.currentScaleValue)
            if (cur === 'auto' || cur === 'page-fit' || cur === 'page-width' || cur === 'page-actual') pdfViewer.currentScaleValue = cur
            else pdfViewer.update()
          })
        })
        resizeObserver.observe(containerRef.current!)

        pdfViewer.setDocument(d)
        linkService.setDocument(d)
      } catch (e) {
        if (disposed) return
        setError(String((e as Error)?.message ?? e))
        setPhase('error')
      }
    })()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      cancelAnimationFrame(resizeFrame)
      unregister()
      // Write out the position and any annotations first, then let the document go.
      void flush().finally(() => {
        pdfViewer?.setDocument(null as never)
        void task?.destroy()
      })
      viewerRef.current = null
      eventBusRef.current = null
    }
  }, [paper.id, register])

  // Ctrl/Cmd+F searches the paper instead of doing nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        findRef.current?.focus()
        findRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runFind = (query: string, again: boolean, previous = false) => {
    eventBusRef.current?.dispatch('find', {
      source: window,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: true
    })
  }

  const applyColor = (m: number, color: string) => {
    const type = COLOR_PARAM[m]
    if (type) eventBusRef.current?.dispatch('switchannotationeditorparams', { source: window, type, value: color })
  }

  const chooseMode = (m: number) => {
    const v = viewerRef.current
    if (!v) return
    v.annotationEditorMode = { mode: m }
    setMode(m)
    const color = colors[m]
    if (color) applyColor(m, color)
  }

  const goToPage = () => {
    const n = Math.round(Number(pageInput))
    const v = viewerRef.current
    if (v && n >= 1 && n <= pages) v.currentPageNumber = n
    else setPageInput(String(page))
  }

  const swatches = COLORS[mode]
  const ready = phase === 'ready'

  return (
    <div className="reader">
      <div className="reader-toolbar">
        <div className="reader-group">
          <input
            className="page-input"
            value={pageInput}
            disabled={!ready}
            aria-label="Page number"
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={goToPage}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="muted small">/ {pages || '–'}</span>
        </div>
        <div className="reader-group">
          <button className="icon-btn" disabled={!ready} title="Zoom out" onClick={() => viewerRef.current?.decreaseScale()}>
            −
          </button>
          <button className="reader-zoom" disabled={!ready} title="Fit to width" onClick={() => viewerRef.current && (viewerRef.current.currentScaleValue = 'page-width')}>
            {zoom}%
          </button>
          <button className="icon-btn" disabled={!ready} title="Zoom in" onClick={() => viewerRef.current?.increaseScale()}>
            +
          </button>
        </div>
        <div className="reader-group find">
          <input
            ref={findRef}
            className="search"
            placeholder="Find in paper…"
            value={find}
            disabled={!ready}
            onChange={(e) => {
              setFind(e.target.value)
              runFind(e.target.value, false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runFind(find, true, e.shiftKey)
              if (e.key === 'Escape') {
                setFind('')
                runFind('', false)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          {find && findCount && (
            <span className="muted small" title="Enter: next · Shift+Enter: previous">
              {findCount.total ? `${findCount.current}/${findCount.total}` : 'No matches'}
            </span>
          )}
        </div>
        <div className="reader-group modes" role="group" aria-label="Annotation tools">
          {MODES.map((m) => (
            <button key={m.mode} className={`mode-btn ${mode === m.mode ? 'active' : ''}`} disabled={!ready} title={m.title} onClick={() => chooseMode(m.mode)}>
              {m.label}
            </button>
          ))}
          {swatches && (
            <span className="color-swatches">
              {swatches.map((c) => (
                <button
                  key={c}
                  className={`color-swatch ${colors[mode] === c ? 'active' : ''}`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  onClick={() => {
                    setColors({ ...colors, [mode]: c })
                    applyColor(mode, c)
                  }}
                />
              ))}
            </span>
          )}
        </div>
        <span className="spacer" />
        <span className={`muted small save-status ${saveStatus}`}>{SAVE_LABEL[saveStatus]}</span>
        <div className="reader-group">
          <button
            className={`btn small subtle bookmark-btn ${props.bookmarked ? 'on' : ''}`}
            title={props.bookmarked ? 'Remove bookmark' : 'Bookmark this paper'}
            aria-pressed={props.bookmarked}
            onClick={props.onToggleBookmark}
          >
            {props.bookmarked ? '★' : '☆'}
          </button>
          <button className={`btn small ${side === 'notes' ? 'primary' : 'subtle'}`} onClick={() => setSide(side === 'notes' ? 'none' : 'notes')}>
            Notes
          </button>
          <button className={`btn small ${side === 'chat' ? 'primary' : 'subtle'}`} onClick={() => setSide(side === 'chat' ? 'none' : 'chat')}>
            Ask
          </button>
          <button className="btn small subtle" title="Open in your system's PDF viewer" onClick={() => api.openPdf(paper.id)}>
            Open externally
          </button>
        </div>
      </div>

      <div className="reader-body">
        <div className="reader-main">
          <div className="reader-viewer" ref={containerRef}>
            <div className="pdfViewer" ref={viewerElRef} />
          </div>
          {phase === 'loading' && (
            <div className="reader-overlay muted">
              <span className="spinner" /> Opening “{paper.title}”…
            </div>
          )}
          {phase === 'error' && (
            <div className="reader-overlay">
              <p className="error-text">{error}</p>
              {paper.absUrl && (
                <button className="btn" onClick={() => api.openExternal(paper.absUrl)}>
                  arXiv page
                </button>
              )}
            </div>
          )}
        </div>
        {side !== 'none' && (
          <aside className="reader-side">
            {side === 'notes' ? (
              <NotesPane key={paper.id} paperId={paper.id} register={register} />
            ) : paper.status === 'indexed' ? (
              <ChatPanel line={props.line} papers={props.papers} scope={[paper.id]} setScope={() => {}} lockScope />
            ) : (
              <p className="muted pad">This paper isn't indexed yet, so there's nothing to ask about. Process it from the research line first.</p>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
