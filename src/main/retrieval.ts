// Pure hybrid retrieval: dense (cosine) + sparse (BM25) rankings fused with
// reciprocal rank fusion. This stands in for alphaxiv-open's MiniRAG "hybrid"
// query mode, and keeps its keyword fallback when no embeddings are usable.

export interface IndexedChunk {
  paperId: string
  chunkIndex: number
  text: string
  /** Normalised embedding, or null when the paper's embeddings are missing/stale. */
  vector: Float32Array | null
}

export interface Scored {
  chunk: IndexedChunk
  score: number
}

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why with does do did can could should would about into than then there these those their them they we our you your i not no'.split(
    ' '
  )
)

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9\-]*[a-z0-9]|[a-z0-9]/g) ?? []).filter((t) => !STOPWORDS.has(t))
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Okapi BM25 scores for every chunk against the query. */
export function bm25Scores(query: string, docs: string[], k1 = 1.5, b = 0.75): number[] {
  const qTerms = [...new Set(tokenize(query))]
  if (!qTerms.length || !docs.length) return docs.map(() => 0)
  const docTokens = docs.map(tokenize)
  const avgLen = docTokens.reduce((s, d) => s + d.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const toks of docTokens) {
    for (const t of new Set(toks)) if (qTerms.includes(t)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return docTokens.map((toks) => {
    const tf = new Map<string, number>()
    for (const t of toks) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of qTerms) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen))
    }
    return score
  })
}

/**
 * Rank chunks for a query. Dense and BM25 rankings are fused with RRF (k=60),
 * and the result is capped at `maxPerPaper` chunks per paper for diversity.
 */
export function hybridSearch(
  chunks: IndexedChunk[],
  query: string,
  queryVector: number[] | null,
  topK: number,
  maxPerPaper = Math.max(3, Math.ceil(topK / 2))
): Scored[] {
  if (!chunks.length) return []
  const RRF_K = 60
  const fused = new Map<IndexedChunk, number>()
  const addRanking = (scores: number[]) => {
    const order = scores
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
    order.forEach(([, i], rank) => fused.set(chunks[i], (fused.get(chunks[i]) ?? 0) + 1 / (RRF_K + rank + 1)))
  }

  if (queryVector) addRanking(chunks.map((c) => (c.vector ? cosine(queryVector, c.vector) : 0)))
  addRanking(bm25Scores(query, chunks.map((c) => c.text)))

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1])
  const perPaper = new Map<string, number>()
  const out: Scored[] = []
  for (const [chunk, score] of ranked) {
    const n = perPaper.get(chunk.paperId) ?? 0
    if (n >= maxPerPaper) continue
    perPaper.set(chunk.paperId, n + 1)
    out.push({ chunk, score })
    if (out.length >= topK) break
  }
  return out
}
