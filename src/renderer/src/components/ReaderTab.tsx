import { lazy, Suspense, useEffect, useState } from 'react'
import type { Paper, ResearchLine } from '@shared/types'
import { api } from '../api'

// pdf.js is large; only load it once a paper is actually opened.
const PdfReader = lazy(() => import('./PdfReader'))

/** The reader for one paper of a research line (what a sidebar paper tab shows). */
export default function ReaderTab(props: {
  line: ResearchLine
  paperId: string
  bookmarked: boolean
  onToggleBookmark: () => void
}) {
  const { line, paperId } = props
  const [papers, setPapers] = useState<Paper[] | null>(null)

  useEffect(() => {
    const load = () => api.listPapers(line.id).then(setPapers)
    load()
    return api.onPapersChanged((id) => id === line.id && load())
  }, [line.id])

  if (!papers) return <div className="reader-overlay muted">Loading…</div>
  const paper = papers.find((p) => p.id === paperId)
  if (!paper) return <div className="reader-overlay muted">This paper is no longer in the research line.</div>
  return (
    <Suspense fallback={<div className="reader-overlay muted">Loading reader…</div>}>
      <PdfReader
        key={paper.id}
        line={line}
        paper={paper}
        papers={papers}
        bookmarked={props.bookmarked}
        onToggleBookmark={props.onToggleBookmark}
      />
    </Suspense>
  )
}
