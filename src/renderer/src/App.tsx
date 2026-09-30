import { useCallback, useEffect, useState } from 'react'
import type { ResearchLine } from '@shared/types'
import { api } from './api'
import LineForm from './components/LineForm'
import LineView from './components/LineView'
import SettingsDialog from './components/SettingsDialog'

export default function App() {
  const [lines, setLines] = useState<ResearchLine[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  const refresh = useCallback(async () => {
    const ls = await api.listLines()
    setLines(ls)
    setSelectedId((cur) => (cur && ls.some((l) => l.id === cur) ? cur : (ls[0]?.id ?? null)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selected = lines.find((l) => l.id === selectedId) ?? null

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
            {lines.map((l) => (
              <button
                key={l.id}
                className={`line-item ${l.id === selectedId ? 'active' : ''}`}
                title={collapsed ? l.name : undefined}
                onClick={() => setSelectedId(l.id)}
              >
                {collapsed ? (
                  <span className="line-initial">{l.name.trim().charAt(0).toUpperCase() || '?'}</span>
                ) : (
                  <>
                    <span className="line-name">{l.name}</span>
                    <span className="line-kw">{l.keywords.join(l.matchMode === 'all' ? ' · ' : ' | ')}</span>
                  </>
                )}
              </button>
            ))}
            {lines.length === 0 && !collapsed && <p className="muted small pad">No research lines yet.</p>}
          </nav>
        </div>
        <button className="sidebar-footer" title="Settings" onClick={() => setShowSettings(true)}>
          {collapsed ? '⚙' : '⚙ Settings'}
        </button>
      </aside>

      <main className="main">
        {selected ? (
          <LineView
            key={selected.id}
            line={selected}
            onEdit={() => setEditing(selected)}
            onDeleted={refresh}
          />
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
            setSelectedId(l.id)
          }}
        />
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onImported={refresh} />}
    </div>
  )
}
