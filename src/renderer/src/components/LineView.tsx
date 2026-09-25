import { useCallback, useEffect, useState } from 'react'
import type { JobProgress, Paper, ResearchLine } from '@shared/types'
import { api } from '../api'
import ChatPanel from './ChatPanel'
import EntityMap from './EntityMap'
import PaperList from './PaperList'

export const cleanError = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function LineView(props: { line: ResearchLine; onEdit: () => void; onDeleted: () => void }) {
  const { line } = props
  const [papers, setPapers] = useState<Paper[]>([])
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [count, setCount] = useState(5)
  const [scope, setScope] = useState<string[]>([])
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [extractEntities, setExtractEntities] = useState(false)
  const [tab, setTab] = useState<'papers' | 'map'>('papers')
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null)

  const reload = useCallback(() => api.listPapers(line.id).then(setPapers), [line.id])

  useEffect(() => {
    api.getSettings().then((s) => {
      setEmbeddingModel(`${s.embeddingProvider}:${s.embeddingModel}`)
      setExtractEntities(s.extractEntities)
    })
  }, [papers])

  // Drop removed papers from the chat scope.
  useEffect(() => {
    setScope((s) => {
      const kept = s.filter((id) => papers.some((p) => p.id === id))
      return kept.length === s.length ? s : kept
    })
  }, [papers])

  useEffect(() => {
    reload()
    const offPapers = api.onPapersChanged((id) => id === line.id && reload())
    const offJob = api.onJobProgress((p) => p.lineId === line.id && setProgress(p))
    return () => {
      offPapers()
      offJob()
    }
  }, [line.id, reload])

  const running = progress?.running ?? false
  const indexed = papers.filter((p) => p.status === 'indexed').length
  const inReview = papers.filter((p) => p.status === 'review').length
  const unfinished = papers.filter(
    (p) =>
      p.status === 'pending' ||
      p.status === 'error' ||
      (p.status === 'indexed' && embeddingModel && p.embeddingModel !== embeddingModel) ||
      (p.status === 'indexed' && extractEntities && (p.entities === undefined || !!p.entitiesError))
  ).length

  const runJob = async (fn: () => Promise<unknown>) => {
    setProgress({ lineId: line.id, stage: 'searching', message: 'Starting…', running: true })
    try {
      await fn()
    } catch (e) {
      setProgress({ lineId: line.id, stage: 'error', message: cleanError(e), running: false })
    }
  }

  const remove = async () => {
    if (!confirm(`Delete "${line.name}"? Papers that only belong to this line are removed from disk.`)) return
    await api.deleteLine(line.id)
    props.onDeleted()
  }

  const pct =
    progress?.total && progress.current !== undefined ? Math.round((progress.current / progress.total) * 100) : null

  return (
    <div className="line-view">
      <header className="line-header">
        <div className="line-title">
          <h1>{line.name}</h1>
          <div className="chips">
            {line.keywords.map((k) => (
              <span key={k} className="chip">
                {k}
              </span>
            ))}
            <span className="chip ghost">{line.matchMode === 'all' ? 'match all' : 'match any'}</span>
            {line.categories.map((c) => (
              <span key={c} className="chip ghost">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="line-actions">
          <button className="btn subtle" onClick={props.onEdit}>
            Edit
          </button>
          <button className="btn subtle danger" onClick={remove}>
            Delete
          </button>
        </div>
      </header>

      <section className="fetch-bar">
        <div className="fetch-controls">
          <span>Fetch</span>
          <input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(Number(e.target.value) || 1)}
            disabled={running}
          />
          <span>new papers</span>
          <button className="btn primary" disabled={running} onClick={() => runJob(() => api.fetchNewPapers(line.id, count))}>
            Fetch from arXiv
          </button>
          {unfinished > 0 && !running && (
            <button className="btn" onClick={() => runJob(() => api.processPending(line.id))}>
              Process {unfinished} unfinished
            </button>
          )}
          {running && (
            <button className="btn subtle" onClick={() => api.cancelJob(line.id)}>
              Cancel
            </button>
          )}
          <span className="spacer" />
          <span className="muted small">
            {papers.length - inReview} papers · {indexed} indexed{inReview ? ` · ${inReview} to review` : ''}
          </span>
        </div>
        {progress && (
          <div className={`progress ${progress.stage}`}>
            <div className="progress-text">
              {running && <span className="spinner" />}
              <span>{progress.message}</span>
            </div>
            {running && (
              <div className="progress-track">
                <div className={`progress-fill ${pct === null ? 'indeterminate' : ''}`} style={{ width: pct === null ? undefined : `${Math.max(pct, 3)}%` }} />
              </div>
            )}
          </div>
        )}
      </section>

      <div className="split">
        <div className="left-pane">
          <div className="tabs">
            <button className={tab === 'papers' ? 'active' : ''} onClick={() => setTab('papers')}>
              Papers
            </button>
            <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
              Entity map
            </button>
          </div>
          {tab === 'papers' ? (
            <PaperList lineId={line.id} papers={papers} scope={scope} setScope={setScope} busy={running} runJob={runJob} />
          ) : (
            <EntityMap
              lineId={line.id}
              papers={papers}
              onSelectPapers={setScope}
              onAsk={(ids, question) => {
                setScope(ids)
                setDraft({ text: question, nonce: Date.now() })
              }}
            />
          )}
        </div>
        <ChatPanel line={line} papers={papers} scope={scope} setScope={setScope} draft={draft} />
      </div>
    </div>
  )
}
