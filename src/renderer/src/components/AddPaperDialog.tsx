import { useState } from 'react'
import type { AddPaperResult, PdfCandidate } from '@shared/types'
import { api } from '../api'
import { cleanError } from './LineView'
import Modal from './Modal'

const splitList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

const describe = (r: AddPaperResult) =>
  r.outcome === 'added'
    ? `Added "${r.title}". It's being downloaded and indexed.`
    : r.outcome === 'linked'
      ? `"${r.title}" was already in your library; it's now part of this line too.`
      : `"${r.title}" is already in this line.`

/** Add a single paper by arXiv link/id or by importing a PDF. Added papers skip review and get indexed. */
export default function AddPaperDialog(props: { lineId: string; onClose: () => void; onAdded: (message: string) => void }) {
  const [ref, setRef] = useState('')
  const [pdf, setPdf] = useState<PdfCandidate | null>(null)
  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState('')
  const [useArxiv, setUseArxiv] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const attempt = async (fn: () => Promise<AddPaperResult>) => {
    setBusy(true)
    setError('')
    try {
      props.onAdded(describe(await fn()))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    setError('')
    try {
      const c = await api.pickPdf()
      if (!c) return
      setPdf(c)
      setTitle(c.title || c.fileName.replace(/\.pdf$/i, ''))
      setAuthors(c.authors.join(', '))
      setUseArxiv(!!c.arxivId)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const addPdf = () =>
    pdf &&
    attempt(() =>
      api.addPdfPaper(props.lineId, {
        path: pdf.path,
        title,
        authors: splitList(authors),
        arxivId: useArxiv && pdf.arxivId ? pdf.arxivId : undefined
      })
    )

  const fromArxiv = !!pdf?.arxivId && useArxiv

  return (
    <Modal title="Add a paper" onClose={props.onClose}>
      <h3>From arXiv</h3>
      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (ref.trim()) attempt(() => api.addArxivPaper(props.lineId, ref))
        }}
      >
        <input
          autoFocus
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="https://arxiv.org/abs/2401.01234 or 2401.01234"
          disabled={busy}
        />
        <button className="btn primary" type="submit" disabled={busy || !ref.trim()}>
          Add
        </button>
      </form>

      <h3>From a PDF</h3>
      <div className="add-row">
        <span className="add-file muted">{pdf ? pdf.fileName : 'Any paper PDF, from arXiv or elsewhere.'}</span>
        <button className="btn" onClick={pick} disabled={busy}>
          {pdf ? 'Choose another…' : 'Choose PDF…'}
        </button>
      </div>
      {pdf && (
        <>
          {pdf.arxivId && (
            <label className="check">
              <input type="checkbox" checked={useArxiv} onChange={(e) => setUseArxiv(e.target.checked)} />
              <span>
                This looks like arXiv:{pdf.arxivId}. Use its arXiv title, authors and abstract.
              </span>
            </label>
          )}
          {!fromArxiv && (
            <>
              <label className="field">
                <span>Title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                <span>Authors</span>
                <input value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Comma-separated (optional)" />
              </label>
            </>
          )}
          <div className="modal-actions">
            <button className="btn primary" onClick={addPdf} disabled={busy || (!fromArxiv && !title.trim())}>
              Add PDF
            </button>
          </div>
        </>
      )}

      <p className="muted small">Added papers skip review: they're indexed and mapped straight away.</p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
