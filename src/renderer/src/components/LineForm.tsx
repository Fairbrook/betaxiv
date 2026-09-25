import { useEffect, useState } from 'react'
import type { MatchMode, NewLineInput, ResearchLine, SortBy } from '@shared/types'
import { api } from '../api'
import Modal from './Modal'

const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

export default function LineForm(props: {
  line: ResearchLine | null
  onClose: () => void
  onSaved: (l: ResearchLine) => void
}) {
  const [name, setName] = useState(props.line?.name ?? '')
  const [keywords, setKeywords] = useState(props.line?.keywords.join(', ') ?? '')
  const [matchMode, setMatchMode] = useState<MatchMode>(props.line?.matchMode ?? 'all')
  const [categories, setCategories] = useState(props.line?.categories.join(', ') ?? '')
  const [sortBy, setSortBy] = useState<SortBy>(props.line?.sortBy ?? 'submittedDate')
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')

  const input: NewLineInput = {
    name: name.trim() || splitList(keywords).slice(0, 3).join(', '),
    keywords: splitList(keywords),
    matchMode,
    categories: splitList(categories),
    sortBy
  }

  useEffect(() => {
    if (!input.keywords.length) return setPreview('')
    api
      .previewQuery(input)
      .then(setPreview)
      .catch(() => setPreview(''))
  }, [keywords, matchMode, categories])

  const save = async () => {
    setError('')
    try {
      const saved = props.line ? await api.updateLine({ ...props.line, ...input }) : await api.createLine(input)
      props.onSaved(saved)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <Modal title={props.line ? 'Edit research line' : 'New research line'} onClose={props.onClose}>
      <label className="field">
        <span>Keywords</span>
        <textarea
          autoFocus
          rows={3}
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="retrieval augmented generation, knowledge graph"
        />
        <small className="muted">
          Comma-separated. Multi-word keywords are searched as phrases. Field prefixes like <code>ti:</code>,{' '}
          <code>au:</code>, <code>abs:</code> work too.
        </small>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Match</span>
          <select value={matchMode} onChange={(e) => setMatchMode(e.target.value as MatchMode)}>
            <option value="all">All keywords (AND)</option>
            <option value="any">Any keyword (OR)</option>
          </select>
        </label>
        <label className="field">
          <span>Order</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            <option value="submittedDate">Newest first</option>
            <option value="relevance">Most relevant first</option>
            <option value="lastUpdatedDate">Recently updated</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>arXiv categories (optional)</span>
        <input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="cs.CL, cs.IR, cs.LG" />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={input.name || 'My research line'} />
      </label>
      {preview && (
        <div className="query-preview">
          <span className="muted small">arXiv query</span>
          <code>{preview}</code>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!input.keywords.length} onClick={save}>
          {props.line ? 'Save' : 'Create'}
        </button>
      </div>
    </Modal>
  )
}
