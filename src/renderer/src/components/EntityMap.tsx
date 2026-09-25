import { useEffect, useMemo, useState } from 'react'
import type { EntityRole, EntityType, LineEntity, Paper } from '@shared/types'
import { api } from '../api'

const TYPE_ORDER: EntityType[] = ['task', 'method', 'model', 'dataset', 'metric', 'concept']
const TYPE_LABEL: Record<EntityType, string> = {
  task: 'Tasks',
  method: 'Methods',
  model: 'Models',
  dataset: 'Datasets & benchmarks',
  metric: 'Metrics',
  concept: 'Concepts'
}
const ROLE_LABEL: Record<EntityRole, string> = {
  proposes: 'proposes',
  uses: 'uses',
  'evaluates-on': 'evaluates on',
  'compares-to': 'compares to',
  discusses: 'discusses'
}

function suggestedQuestion(e: LineEntity): string {
  switch (e.type) {
    case 'dataset':
      return `How do these papers use ${e.name}, and how do their results on it compare?`
    case 'metric':
      return `Which papers report ${e.name}, and what values do they get?`
    case 'task':
      return `What approaches do these papers take to ${e.name}, and how do they differ?`
    default:
      return `How is ${e.name} used or extended across these papers, and how do they compare?`
  }
}

export default function EntityMap(props: {
  lineId: string
  papers: Paper[]
  onAsk: (paperIds: string[], question: string) => void
  onSelectPapers: (paperIds: string[]) => void
}) {
  const [map, setMap] = useState<LineEntity[]>([])
  const [type, setType] = useState<EntityType | 'all'>('all')
  const [sharedOnly, setSharedOnly] = useState(true)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api.lineMap(props.lineId).then(setMap)
  }, [props.lineId, props.papers])

  const titles = useMemo(() => new Map(props.papers.map((p) => [p.id, p.title])), [props.papers])
  const mapped = props.papers.filter((p) => p.entities !== undefined && !p.entitiesError).length
  const failed = props.papers.filter((p) => p.entitiesError).length

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return map.filter(
      (e) =>
        (type === 'all' || e.type === type) &&
        (!sharedOnly || e.papers.length > 1 || q) &&
        (!q || e.name.toLowerCase().includes(q))
    )
  }, [map, type, sharedOnly, filter])

  const groups = TYPE_ORDER.map((t) => ({ type: t, items: shown.filter((e) => e.type === t) })).filter((g) => g.items.length)
  const maxCount = Math.max(1, ...map.map((e) => e.papers.length))

  return (
    <section className="papers entity-map">
      <div className="panel-head map-head">
        <input className="search" placeholder="Filter entities…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="map-filters">
          <select value={type} onChange={(e) => setType(e.target.value as EntityType | 'all')}>
            <option value="all">All types</option>
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <label className="check small">
            <input type="checkbox" checked={sharedOnly} onChange={(e) => setSharedOnly(e.target.checked)} />
            In 2+ papers
          </label>
        </div>
      </div>
      <div className="paper-scroll">
        <p className="muted small pad map-status">
          {mapped} of {props.papers.length} papers mapped
          {failed ? ` · ${failed} failed (use “Process unfinished” to retry)` : ''}
          {mapped < props.papers.length - failed ? ' · the rest are mapped after indexing' : ''}
        </p>
        {groups.length === 0 && (
          <p className="muted pad">
            {map.length === 0
              ? 'No entities yet. They are extracted from each paper’s abstract and introduction after indexing.'
              : sharedOnly
                ? 'No entity appears in more than one paper yet — untick “In 2+ papers” to see all.'
                : 'No entities match.'}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.type} className="entity-group">
            <h4>
              {TYPE_LABEL[g.type]} <span className="muted">{g.items.length}</span>
            </h4>
            {g.items.map((e) => {
              const expanded = open === e.key
              const ids = e.papers.map((p) => p.paperId)
              return (
                <div key={e.key} className={`entity ${expanded ? 'expanded' : ''}`}>
                  <button className="entity-row" onClick={() => setOpen(expanded ? null : e.key)}>
                    <span className="entity-name">{e.name}</span>
                    <span className="entity-bar">
                      <span style={{ width: `${(e.papers.length / maxCount) * 100}%` }} />
                    </span>
                    <span className="entity-count">{e.papers.length}</span>
                  </button>
                  {expanded && (
                    <div className="entity-detail">
                      {e.papers.map((p) => (
                        <div key={p.paperId} className="entity-paper">
                          <span className={`role ${p.role}`}>{ROLE_LABEL[p.role]}</span>
                          <span className="entity-paper-title">{titles.get(p.paperId) ?? p.paperId}</span>
                        </div>
                      ))}
                      <div className="paper-actions">
                        <button className="btn small primary" onClick={() => props.onAsk(ids, suggestedQuestion(e))}>
                          Ask about {e.papers.length > 1 ? 'these papers' : 'this paper'}
                        </button>
                        <button className="btn small" onClick={() => props.onSelectPapers(ids)}>
                          Select papers
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}
