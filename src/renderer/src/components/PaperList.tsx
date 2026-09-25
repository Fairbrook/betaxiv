import { useMemo, useState } from 'react'
import type { Paper, PaperStatus } from '@shared/types'
import { api } from '../api'
import { cleanError } from './LineView'
import Modal from './Modal'

const STATUS_LABEL: Record<PaperStatus, string> = {
  review: 'To review',
  pending: 'Pending',
  downloading: 'Downloading',
  extracting: 'Extracting',
  indexing: 'Indexing',
  indexed: 'Indexed',
  error: 'Failed'
}

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

function authorsShort(a: string[]) {
  if (a.length <= 3) return a.join(', ')
  return `${a.slice(0, 3).join(', ')} +${a.length - 3}`
}

export default function PaperList(props: {
  lineId: string
  papers: Paper[]
  scope: string[]
  setScope: (s: string[]) => void
  busy: boolean
  runJob: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [textView, setTextView] = useState<{ title: string; text: string } | null>(null)

  const matching = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return props.papers
    return props.papers.filter((p) =>
      `${p.title} ${p.authors.join(' ')} ${p.abstract} ${p.id}`.toLowerCase().includes(q)
    )
  }, [filter, props.papers])
  const review = matching.filter((p) => p.status === 'review')
  const shown = matching.filter((p) => p.status !== 'review')

  const approve = (ids: string[]) => {
    // A running job picks newly approved papers up by itself.
    if (props.busy) api.approvePapers(props.lineId, ids).catch((e) => alert(cleanError(e)))
    else props.runJob(() => api.approvePapers(props.lineId, ids))
  }

  const remove = async (ids: string[], ask?: string) => {
    if (ask && !confirm(ask)) return
    try {
      await api.removePapers(props.lineId, ids)
    } catch (e) {
      alert(cleanError(e))
    }
  }

  const toggle = (id: string) =>
    props.setScope(props.scope.includes(id) ? props.scope.filter((x) => x !== id) : [...props.scope, id])

  const viewText = async (p: Paper) => setTextView({ title: p.title, text: (await api.getPaperText(p.id)) || '(no extracted text yet)' })

  return (
    <section className="papers">
      <div className="panel-head">
        <input className="search" placeholder="Filter papers…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="paper-scroll">
        {review.length > 0 && (
          <div className="review">
            <div className="review-head">
              <strong>Awaiting review ({review.length})</strong>
              <span className="muted small">Approved papers are downloaded, indexed and mapped.</span>
              <span className="spacer" />
              <button className="btn small primary" onClick={() => approve(review.map((p) => p.id))}>
                Approve all
              </button>
              <button
                className="btn small subtle danger"
                onClick={() => remove(review.map((p) => p.id), `Discard ${review.length} paper${review.length === 1 ? '' : 's'}? Future fetches will skip them.`)}
              >
                Discard all
              </button>
            </div>
            {review.map((p) => (
              <article key={p.id} className="paper review-paper">
                <div className="paper-title">{p.title}</div>
                <div className="paper-meta">
                  {authorsShort(p.authors)} · {fmtDate(p.published)} · {p.id}
                  {p.primaryCategory ? ` · ${p.primaryCategory}` : ''}
                </div>
                <p className="abstract">{p.abstract}</p>
                <div className="paper-actions">
                  <button className="btn small primary" onClick={() => approve([p.id])}>
                    Approve
                  </button>
                  <button className="btn small subtle danger" onClick={() => remove([p.id])}>
                    Discard
                  </button>
                  <span className="spacer" />
                  <button className="btn small subtle" onClick={() => api.openExternal(p.absUrl)}>
                    arXiv page
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {shown.length === 0 && review.length === 0 && (
          <p className="muted pad">{props.papers.length ? 'No papers match the filter.' : 'No papers yet — fetch some from arXiv.'}</p>
        )}
        {shown.map((p) => {
          const expanded = open === p.id
          const inScope = props.scope.includes(p.id)
          return (
            <article key={p.id} className={`paper ${expanded ? 'expanded' : ''} ${inScope ? 'in-scope' : ''}`}>
              <div className="paper-row">
                <input
                  type="checkbox"
                  title={p.status === 'indexed' ? 'Limit questions to selected papers' : 'Not indexed yet'}
                  checked={inScope}
                  disabled={p.status !== 'indexed'}
                  onChange={() => toggle(p.id)}
                />
                <button className="paper-main" onClick={() => setOpen(expanded ? null : p.id)}>
                  <span className="paper-title">{p.title}</span>
                  <span className="paper-meta">
                    {authorsShort(p.authors)} · {fmtDate(p.published)} · {p.id}
                  </span>
                </button>
                <span className={`status ${p.status}`} title={p.error}>
                  {STATUS_LABEL[p.status]}
                </span>
              </div>
              {expanded && (
                <div className="paper-detail">
                  {p.error && <p className="error-text small">{p.error}</p>}
                  {p.tldr && (
                    <p className="tldr">
                      <strong>TL;DR</strong> {p.tldr}
                    </p>
                  )}
                  {p.entities && p.entities.length > 0 && (
                    <div className="paper-entities">
                      {p.entities.map((e) => (
                        <span key={e.name} className={`chip entity-chip ${e.role}`} title={`${e.type} · ${e.role}`}>
                          {e.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.entitiesError && <p className="muted small">Entity map failed: {p.entitiesError}</p>}
                  <p className="abstract">{p.abstract}</p>
                  <div className="paper-cats">
                    {p.categories.map((c) => (
                      <span key={c} className="chip ghost small">
                        {c}
                      </span>
                    ))}
                    {p.chunkCount ? <span className="muted small">{p.chunkCount} chunks</span> : null}
                  </div>
                  <div className="paper-actions">
                    <button className="btn small" onClick={() => api.openPdf(p.id)}>
                      Open PDF
                    </button>
                    <button className="btn small" onClick={() => api.openExternal(p.absUrl)}>
                      arXiv page
                    </button>
                    <button className="btn small" onClick={() => viewText(p)}>
                      Extracted text
                    </button>
                    {p.status === 'indexed' && (
                      <button className="btn small primary" onClick={() => props.setScope([p.id])}>
                        Ask about this paper
                      </button>
                    )}
                    <button className="btn small subtle" disabled={props.busy} onClick={() => api.reindexPaper(props.lineId, p.id).catch(() => {})}>
                      Re-index
                    </button>
                    <button
                      className="btn small subtle danger"
                      onClick={() =>
                        remove(
                          [p.id],
                          `Delete "${p.title}" from this line? Its files and index are removed unless another line uses it, and future fetches will skip it.`
                        )
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
      {textView && (
        <Modal title={textView.title} onClose={() => setTextView(null)} wide>
          <pre className="paper-text">{textView.text}</pre>
        </Modal>
      )}
    </section>
  )
}
