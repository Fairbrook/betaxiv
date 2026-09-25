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
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">β</span>
          <span>betaxiv</span>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span>Research lines</span>
            <button className="icon-btn" title="New research line" onClick={() => setEditing('new')}>
              +
            </button>
          </div>
          <nav className="line-list">
            {lines.map((l) => (
              <button
                key={l.id}
                className={`line-item ${l.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(l.id)}
              >
                <span className="line-name">{l.name}</span>
                <span className="line-kw">{l.keywords.join(l.matchMode === 'all' ? ' · ' : ' | ')}</span>
              </button>
            ))}
            {lines.length === 0 && <p className="muted small pad">No research lines yet.</p>}
          </nav>
        </div>
        <button className="sidebar-footer" onClick={() => setShowSettings(true)}>
          ⚙ Settings
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
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  )
}
