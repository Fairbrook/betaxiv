import { useCallback, useEffect, useRef, useState } from 'react'
import type { Paper, ResearchLine } from '@shared/types'
import { api } from './api'
import LineForm from './components/LineForm'
import LineView from './components/LineView'
import ReaderTab from './components/ReaderTab'
import SettingsDialog from './components/SettingsDialog'

/** A paper opened in the reader; shown as a child of its research line in the sidebar. */
interface PaperTab {
  id: string
  title: string
}

interface UiState {
  tabs: Record<string, PaperTab[]>
  expanded: Record<string, boolean>
  selectedId: string | null
  paperId: string | null
}

const UI_KEY = 'readerUi'

function loadUi(): UiState {
  const empty: UiState = { tabs: {}, expanded: {}, selectedId: null, paperId: null }
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return empty
    const tabs: UiState['tabs'] = {}
    for (const [lineId, list] of Object.entries(raw.tabs ?? {})) {
      if (!Array.isArray(list)) continue
      tabs[lineId] = list.filter((t): t is PaperTab => !!t && typeof t.id === 'string' && typeof t.title === 'string')
    }
    return {
      tabs,
      expanded: raw.expanded && typeof raw.expanded === 'object' ? raw.expanded : {},
      selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null,
      paperId: typeof raw.paperId === 'string' ? raw.paperId : null
    }
  } catch {
    return empty
  }
}

export default function App() {
  const [initial] = useState(loadUi)
  const [lines, setLines] = useState<ResearchLine[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId)
  const [paperId, setPaperId] = useState<string | null>(initial.paperId)
  const [tabs, setTabs] = useState(initial.tabs)
  const [expanded, setExpanded] = useState(initial.expanded)
  const [bookmarks, setBookmarks] = useState<Record<string, string[]>>({})
  const [editing, setEditing] = useState<ResearchLine | 'new' | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1'
    } catch {
      return false
    }
  })

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('sidebarCollapsed', c ? '0' : '1')
      } catch {}
      return !c
    })
  }, [])

  // Ctrl/Cmd+B toggles the sidebar, as in most editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  // Open tabs and the current view survive a restart.
  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tabs, expanded, selectedId, paperId } satisfies UiState))
    } catch {}
  }, [tabs, expanded, selectedId, paperId])

  const refresh = useCallback(async () => {
    const ls = await api.listLines()
    setLines(ls)
    const ids = new Set(ls.map((l) => l.id))
    // Tabs of deleted lines go away with them.
    setTabs((t) => (Object.keys(t).every((id) => ids.has(id)) ? t : Object.fromEntries(Object.entries(t).filter(([id]) => ids.has(id)))))
    setSelectedId((cur) => (cur && ids.has(cur) ? cur : (ls[0]?.id ?? null)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A paper tab only makes sense while its line is selected.
  useEffect(() => {
    if (lines.length && paperId && !(tabs[selectedId ?? '']?.some((t) => t.id === paperId))) setPaperId(null)
  }, [lines.length, paperId, selectedId, tabs])

  /** Re-read a line's papers and bookmarks: drop tabs of removed papers, refresh titles and stars. */
  const syncLine = useCallback(async (lineId: string) => {
    const [papers, marks] = await Promise.all([api.listPapers(lineId), api.listBookmarks(lineId)]).catch(() => [null, null] as const)
    if (!papers || !marks) return
    const byId = new Map(papers.map((p) => [p.id, p]))
    setBookmarks((b) => (JSON.stringify(b[lineId] ?? []) === JSON.stringify(marks) ? b : { ...b, [lineId]: marks }))
    setTabs((all) => {
      const cur = all[lineId]
      if (!cur) return all
      const next = cur.filter((t) => byId.has(t.id)).map((t) => ({ id: t.id, title: byId.get(t.id)!.title }))
      return JSON.stringify(next) === JSON.stringify(cur) ? all : { ...all, [lineId]: next }
    })
  }, [])

  const tabLineIds = Object.keys(tabs).filter((id) => tabs[id].length).join(',')
  useEffect(() => {
    for (const id of tabLineIds.split(',').filter(Boolean)) void syncLine(id)
  }, [tabLineIds, syncLine])
  useEffect(() => api.onPapersChanged((lineId) => void syncLine(lineId)), [syncLine])

  const selectLine = (id: string) => {
    setSelectedId(id)
    setPaperId(null)
  }

  const openPaper = useCallback(
    (lineId: string, paper: Paper) => {
      setTabs((all) => (all[lineId]?.some((t) => t.id === paper.id) ? all : { ...all, [lineId]: [...(all[lineId] ?? []), { id: paper.id, title: paper.title }] }))
      setExpanded((e) => ({ ...e, [lineId]: true }))
      setSelectedId(lineId)
      setPaperId(paper.id)
      void syncLine(lineId)
    },
    [syncLine]
  )

  const closeTab = (lineId: string, id: string) => {
    setTabs((all) => ({ ...all, [lineId]: (all[lineId] ?? []).filter((t) => t.id !== id) }))
    if (selectedId === lineId && paperId === id) setPaperId(null)
  }

  const toggleBookmark = async (lineId: string, id: string) => {
    const on = !(bookmarks[lineId] ?? []).includes(id)
    try {
      // Optimistic; the reply below is authoritative.
      setBookmarks((b) => ({ ...b, [lineId]: on ? [...(b[lineId] ?? []), id] : (b[lineId] ?? []).filter((x) => x !== id) }))
      const list = await api.setBookmark(lineId, id, on)
      setBookmarks((b) => ({ ...b, [lineId]: list }))
    } catch {
      void syncLine(lineId)
    }
  }

  const selected = lines.find((l) => l.id === selectedId) ?? null
  const activePaper = selected && paperId && tabs[selected.id]?.some((t) => t.id === paperId) ? paperId : null

  // Keep a stable handle for LineView so it doesn't re-render for every tab change.
  const openRef = useRef(openPaper)
  openRef.current = openPaper
  const onOpenPaper = useCallback(
    (p: Paper) => {
      if (selected) openRef.current(selected.id, p)
    },
    [selected]
  )

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">β</span>
          {!collapsed && <span>betaxiv</span>}
          <button
            className="icon-btn sidebar-toggle"
            title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            {!collapsed && <span>Research lines</span>}
            <button className="icon-btn" title="New research line" onClick={() => setEditing('new')}>
              +
            </button>
          </div>
          <nav className="line-list">
            {lines.map((l) => {
              const children = tabs[l.id] ?? []
              const open = !!expanded[l.id] && children.length > 0 && !collapsed
              const lineActive = l.id === selectedId
              return (
                <div key={l.id} className="line-group">
                  <div className={`line-item ${lineActive && !activePaper ? 'active' : ''} ${lineActive && activePaper ? 'parent' : ''}`}>
                    <button className="line-main" title={collapsed ? l.name : undefined} onClick={() => selectLine(l.id)}>
                      {collapsed ? (
                        <span className="line-initial">{l.name.trim().charAt(0).toUpperCase() || '?'}</span>
                      ) : (
                        <>
                          <span className="line-name">{l.name}</span>
                          <span className="line-kw">{l.keywords.join(l.matchMode === 'all' ? ' · ' : ' | ')}</span>
                        </>
                      )}
                    </button>
                    {!collapsed && children.length > 0 && (
                      <button
                        className="line-chevron"
                        aria-label={open ? 'Hide open papers' : 'Show open papers'}
                        aria-expanded={open}
                        title={`${children.length} open paper${children.length === 1 ? '' : 's'}`}
                        onClick={() => setExpanded((e) => ({ ...e, [l.id]: !open }))}
                      >
                        {open ? '▾' : '▸'}
                      </button>
                    )}
                  </div>
                  {open &&
                    children.map((t) => {
                      const active = lineActive && t.id === activePaper
                      const starred = (bookmarks[l.id] ?? []).includes(t.id)
                      return (
                        <div
                          key={t.id}
                          className={`tab-item ${active ? 'active' : ''}`}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault()
                              closeTab(l.id, t.id)
                            }
                          }}
                        >
                          <button
                            className="tab-main"
                            title={t.title}
                            onClick={() => {
                              setSelectedId(l.id)
                              setPaperId(t.id)
                            }}
                          >
                            <span className="tab-icon" aria-hidden>
                              {starred ? '★' : '📄'}
                            </span>
                            <span className="tab-title">{t.title}</span>
                          </button>
                          <button className="tab-close" aria-label={`Close ${t.title}`} title="Close" onClick={() => closeTab(l.id, t.id)}>
                            ×
                          </button>
                        </div>
                      )
                    })}
                </div>
              )
            })}
            {lines.length === 0 && !collapsed && <p className="muted small pad">No research lines yet.</p>}
          </nav>
        </div>
        <button className="sidebar-footer" title="Settings" onClick={() => setShowSettings(true)}>
          {collapsed ? '⚙' : '⚙ Settings'}
        </button>
      </aside>

      <main className="main">
        {selected ? (
          <>
            {/* Stays mounted behind the reader so the filter, chat scope and progress aren't lost. */}
            <div className={`pane ${activePaper ? 'pane-hidden' : ''}`}>
              <LineView
                key={selected.id}
                line={selected}
                onEdit={() => setEditing(selected)}
                onDeleted={refresh}
                onOpenPaper={onOpenPaper}
              />
            </div>
            {activePaper && (
              <ReaderTab
                key={`${selected.id}/${activePaper}`}
                line={selected}
                paperId={activePaper}
                bookmarked={(bookmarks[selected.id] ?? []).includes(activePaper)}
                onToggleBookmark={() => toggleBookmark(selected.id, activePaper)}
              />
            )}
          </>
        ) : (
          <div className="empty-state">
            <h1>Start a line of research</h1>
            <p className="muted">
              Pick a few keywords. betaxiv will pull matching papers from arXiv, download their full text, index them,
              and let you ask questions across all of them.
            </p>
            <button className="btn primary" onClick={() => setEditing('new')}>
              New research line
            </button>
          </div>
        )}
      </main>

      {editing && (
        <LineForm
          line={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (l) => {
            setEditing(null)
            await refresh()
            selectLine(l.id)
          }}
        />
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onImported={refresh} />}
    </div>
  )
}
