import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatMessage, Paper, ResearchLine, SourceChunk } from '@shared/types'
import { api, newId } from '../api'
import { cleanError } from './LineView'

marked.setOptions({ gfm: true, breaks: false })

/** Render markdown safely and turn [n] citations into clickable chips. */
function renderAnswer(md: string): string {
  const html = DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
  // Only touch text outside of tags and code blocks.
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]+>)/g)
    .map((part) => (part.startsWith('<') ? part : part.replace(/\[(\d{1,2})\]/g, '<button class="cite" data-n="$1">$1</button>')))
    .join('')
}

function Sources(props: { sources: SourceChunk[]; active: number | null; setActive: (n: number | null) => void }) {
  const byPaper = useMemo(() => {
    const m = new Map<string, SourceChunk[]>()
    for (const s of props.sources) m.set(s.paperId, [...(m.get(s.paperId) ?? []), s])
    return [...m.values()]
  }, [props.sources])
  if (!props.sources.length) return null
  const active = props.sources.find((s) => s.n === props.active)
  return (
    <div className="sources">
      <div className="sources-list">
        {byPaper.map((group) => (
          <div key={group[0].paperId} className="source-paper">
            <span className="source-title" title={group[0].title}>
              {group[0].title}
            </span>
            <span className="source-nums">
              {group.map((s) => (
                <button
                  key={s.n}
                  className={`cite ${props.active === s.n ? 'active' : ''}`}
                  onClick={() => props.setActive(props.active === s.n ? null : s.n)}
                >
                  {s.n}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
      {active && (
        <blockquote className="source-excerpt">
          <div className="muted small">
            [{active.n}] {active.title} · arXiv:{active.paperId} · excerpt {active.chunkIndex + 1}
          </div>
          <p>{active.text}</p>
        </blockquote>
      )}
    </div>
  )
}

function Message(props: { msg: ChatMessage }) {
  const [active, setActive] = useState<number | null>(null)
  const { msg } = props
  if (msg.role === 'user') return <div className="msg user">{msg.content}</div>
  return (
    <div className={`msg assistant ${msg.error ? 'error' : ''}`}>
      <div
        className="md"
        dangerouslySetInnerHTML={{ __html: renderAnswer(msg.content) }}
        onClick={(e) => {
          const n = (e.target as HTMLElement).closest('button.cite')?.getAttribute('data-n')
          if (n) setActive(active === Number(n) ? null : Number(n))
        }}
      />
      {msg.sources && <Sources sources={msg.sources} active={active} setActive={setActive} />}
    </div>
  )
}

export default function ChatPanel(props: {
  line: ResearchLine
  papers: Paper[]
  scope: string[]
  setScope: (s: string[]) => void
}) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<{ requestId: string; question: string; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.chatHistory(props.line.id).then(setHistory)
  }, [props.line.id])

  useEffect(() => {
    return api.onChatToken((e) =>
      setPending((p) => (p && p.requestId === e.requestId ? { ...p, text: p.text + e.token } : p))
    )
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [history, pending?.text])

  const indexed = props.papers.filter((p) => p.status === 'indexed')
  const scoped = props.scope.map((id) => props.papers.find((p) => p.id === id)).filter((p): p is Paper => !!p)

  const send = async () => {
    const question = input.trim()
    if (!question || pending) return
    const requestId = newId()
    setInput('')
    setPending({ requestId, question, text: '' })
    try {
      await api.ask(props.line.id, question, props.scope, requestId)
    } catch (e) {
      alert(cleanError(e))
    }
    setHistory(await api.chatHistory(props.line.id))
    setPending(null)
  }

  const clear = async () => {
    if (!confirm('Clear this conversation?')) return
    await api.clearChat(props.line.id)
    setHistory([])
  }

  return (
    <section className="chat">
      <div className="panel-head chat-head">
        <div className="scope">
          {scoped.length === 0 ? (
            <span className="muted small">Asking across all {indexed.length} indexed papers</span>
          ) : (
            <>
              <span className="muted small">Asking about:</span>
              {scoped.map((p) => (
                <span key={p.id} className="chip removable" title={p.title}>
                  {p.title.length > 40 ? `${p.title.slice(0, 40)}…` : p.title}
                  <button onClick={() => props.setScope(props.scope.filter((x) => x !== p.id))}>×</button>
                </span>
              ))}
              <button className="link" onClick={() => props.setScope([])}>
                all papers
              </button>
            </>
          )}
        </div>
        {history.length > 0 && (
          <button className="btn subtle small" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      <div className="messages" ref={scrollRef}>
        {history.length === 0 && !pending && (
          <div className="chat-empty">
            <p>Ask anything about the papers in this research line.</p>
            <ul className="muted small">
              <li>What are the main approaches, and how do they differ?</li>
              <li>Which datasets and metrics are used for evaluation?</li>
              <li>What open problems do the authors mention?</li>
            </ul>
          </div>
        )}
        {history.map((m) => (
          <Message key={m.id} msg={m} />
        ))}
        {pending && (
          <>
            <div className="msg user">{pending.question}</div>
            <div className="msg assistant">
              {pending.text ? (
                <div className="md" dangerouslySetInnerHTML={{ __html: renderAnswer(pending.text) }} />
              ) : (
                <div className="muted small thinking">
                  <span className="spinner" /> Searching papers and thinking…
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={input}
          placeholder={indexed.length ? 'Ask a question… (Enter to send, Shift+Enter for newline)' : 'Fetch and index some papers first'}
          disabled={!indexed.length}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {pending ? (
          <button className="btn" onClick={() => api.stopAnswer(pending.requestId)}>
            Stop
          </button>
        ) : (
          <button className="btn primary" disabled={!input.trim() || !indexed.length} onClick={send}>
            Ask
          </button>
        )}
      </div>
    </section>
  )
}
