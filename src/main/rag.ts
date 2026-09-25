import fs from 'node:fs'
import path from 'node:path'
import { embed } from './embeddings'
import { complete, type LlmTurn } from './llm'
import { hybridSearch, type IndexedChunk } from './retrieval'
import { embeddingKey } from './settings'
import { chunkText } from './textproc'
import type { Store } from './store'
import type { ChatMessage, Paper, Settings, SourceChunk } from '../shared/types'

interface ChunkFile {
  embeddingModel: string
  dim: number
  chunks: string[]
}

/** Header prepended to every chunk so each carries its paper's identity into the embedding. */
const chunkHeader = (p: Paper) => `${p.title} (arXiv:${p.id})`

/** Chunk and embed a paper's extracted text, persisting chunks.json + embeddings.bin. */
export async function indexPaper(
  store: Store,
  settings: Settings,
  paper: Paper,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const dir = store.paperDir(paper.id)
  const text = fs.readFileSync(path.join(dir, 'paper.md'), 'utf8')
  // The abstract goes first so it's always retrievable even if extraction was poor.
  const body = `Abstract: ${paper.abstract}\n\n${text}`
  const chunks = chunkText(body, settings.chunkSize, settings.chunkOverlap)
  const vectors = await embed(
    settings,
    chunks.map((c) => `${chunkHeader(paper)}\n\n${c}`),
    'document',
    onProgress,
    signal
  )
  const dim = vectors[0]?.length ?? 0
  const matrix = new Float32Array(chunks.length * dim)
  vectors.forEach((v, i) => matrix.set(v, i * dim))
  fs.writeFileSync(path.join(dir, 'embeddings.bin'), Buffer.from(matrix.buffer))
  const meta: ChunkFile = { embeddingModel: embeddingKey(settings), dim, chunks }
  fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify(meta))
  cache.delete(paper.id)
  return chunks.length
}

// In-memory cache of loaded paper indexes, keyed by paper id.
const cache = new Map<string, { model: string; chunks: IndexedChunk[] }>()

export function forgetIndex(paperId: string): void {
  cache.delete(paperId)
}

function loadPaperIndex(store: Store, paperId: string, model: string): IndexedChunk[] {
  const hit = cache.get(paperId)
  if (hit && hit.model === model) return hit.chunks
  const dir = store.paperDir(paperId)
  let meta: ChunkFile
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'chunks.json'), 'utf8'))
  } catch {
    return []
  }
  // Vectors from a different embedding model aren't comparable: keyword search only.
  let matrix: Float32Array | null = null
  if (meta.embeddingModel === model && meta.dim > 0) {
    const buf = fs.readFileSync(path.join(dir, 'embeddings.bin'))
    matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  }
  const chunks = meta.chunks.map((text, i) => ({
    paperId,
    chunkIndex: i,
    text,
    vector: matrix ? matrix.subarray(i * meta.dim, (i + 1) * meta.dim) : null
  }))
  cache.set(paperId, { model, chunks })
  return chunks
}

const SYSTEM_PROMPT = `You are a research assistant that helps the user understand and compare academic papers from arXiv.
You are given numbered excerpts retrieved from the papers in the user's research collection. Answer the user's question using these excerpts.

Guidelines:
- Ground every claim in the excerpts and cite them inline with their numbers in square brackets, e.g. [2] or [1][4].
- When several papers are relevant, compare and synthesise them rather than summarising each in isolation.
- If the excerpts don't contain enough information to answer, say so clearly, then give the best answer you can and mark which parts are not supported by the excerpts.
- Use Markdown for structure. Use LaTeX ($...$) for math when helpful.`

function formatContext(sources: SourceChunk[]): string {
  if (!sources.length) return 'No relevant excerpts were found in the collection.'
  return sources.map((s) => `[${s.n}] ${s.title} (arXiv:${s.paperId}), excerpt ${s.chunkIndex + 1}\n${s.text}`).join('\n\n---\n\n')
}

export interface AskOptions {
  store: Store
  settings: Settings
  lineId: string
  question: string
  /** Restrict retrieval to these papers; empty means all indexed papers of the line. */
  paperIds: string[]
  history: ChatMessage[]
  onToken: (t: string) => void
  workDir: string
  signal?: AbortSignal
}

export async function ask(o: AskOptions): Promise<{ answer: string; sources: SourceChunk[] }> {
  const { store, settings } = o
  const model = embeddingKey(settings)
  const papers = store
    .papersForLine(o.lineId)
    .filter((p) => p.status === 'indexed' && (o.paperIds.length === 0 || o.paperIds.includes(p.id)))
  if (!papers.length) throw new Error('No indexed papers to search yet. Fetch some papers first.')

  const chunks = papers.flatMap((p) => loadPaperIndex(store, p.id, model))
  const hasVectors = chunks.some((c) => c.vector)
  // Fold the previous question in so follow-ups ("what about their dataset?") still retrieve well.
  const lastUser = [...o.history].reverse().find((m) => m.role === 'user')
  const retrievalQuery = lastUser ? `${lastUser.content}\n${o.question}` : o.question
  const queryVector = hasVectors ? (await embed(settings, [o.question], 'query', undefined, o.signal))[0] : null

  const titles = new Map(papers.map((p) => [p.id, p.title]))
  const hits = hybridSearch(chunks, retrievalQuery, queryVector, settings.topK)
  const sources: SourceChunk[] = hits.map((h, i) => ({
    n: i + 1,
    paperId: h.chunk.paperId,
    title: titles.get(h.chunk.paperId) ?? h.chunk.paperId,
    chunkIndex: h.chunk.chunkIndex,
    text: h.chunk.text,
    score: h.score
  }))

  const scopeNote =
    papers.length === 1
      ? `The question is about a single paper: "${papers[0].title}".`
      : `The collection being searched has ${papers.length} papers.`
  const turns: LlmTurn[] = o.history
    .filter((m) => !m.error)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content }))
  turns.push({
    role: 'user',
    content: `${scopeNote}\n\n<excerpts>\n${formatContext(sources)}\n</excerpts>\n\nQuestion: ${o.question}`
  })

  const answer = await complete(settings, { system: SYSTEM_PROMPT, messages: turns, onToken: o.onToken, signal: o.signal }, o.workDir)
  return { answer, sources }
}
