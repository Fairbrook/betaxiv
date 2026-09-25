import type { Settings } from '../shared/types'

export type EmbedKind = 'document' | 'query'

let modelCacheDir = ''
export function setModelCacheDir(dir: string): void {
  modelCacheDir = dir
}

function normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Embedding request failed (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  return res.json()
}

// ---- local (transformers.js, runs in-process on CPU) -------------------------

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
const extractors = new Map<string, Promise<Extractor>>()

function loadExtractor(model: string): Promise<Extractor> {
  let p = extractors.get(model)
  if (!p) {
    p = (async () => {
      const tf = await import('@huggingface/transformers')
      if (modelCacheDir) tf.env.cacheDir = modelCacheDir
      tf.env.allowLocalModels = false
      return (await tf.pipeline('feature-extraction', model, { dtype: 'q8' })) as unknown as Extractor
    })()
    p.catch(() => extractors.delete(model))
    extractors.set(model, p)
  }
  return p
}

async function embedLocal(model: string, texts: string[], kind: EmbedKind): Promise<number[][]> {
  const extractor = await loadExtractor(model)
  // BGE/E5-style models expect an instruction prefix on queries.
  const prefixed = /bge|e5/i.test(model) && kind === 'query'
    ? texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`)
    : texts
  const out = await extractor(prefixed, { pooling: 'mean', normalize: true })
  return out.tolist()
}

// ---- remote providers ------------------------------------------------------

async function embedOpenAI(s: Settings, texts: string[]): Promise<number[][]> {
  if (!s.apiKeys.openai) throw new Error('OpenAI API key is not set (Settings → Embeddings)')
  const json = await postJson(
    'https://api.openai.com/v1/embeddings',
    { model: s.embeddingModel, input: texts },
    { Authorization: `Bearer ${s.apiKeys.openai}` }
  )
  return (json.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

async function embedGemini(s: Settings, texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (!s.apiKeys.gemini) throw new Error('Gemini API key is not set (Settings → Embeddings)')
  const model = s.embeddingModel.startsWith('models/') ? s.embeddingModel : `models/${s.embeddingModel}`
  const json = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`,
    {
      requests: texts.map((text) => ({
        model,
        content: { parts: [{ text }] },
        taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
      }))
    },
    { 'x-goog-api-key': s.apiKeys.gemini }
  )
  return (json.embeddings as { values: number[] }[]).map((e) => normalize(e.values))
}

async function embedOllama(s: Settings, texts: string[], kind: EmbedKind): Promise<number[][]> {
  // nomic-embed-text is trained with task prefixes.
  const input = /nomic/i.test(s.embeddingModel)
    ? texts.map((t) => `${kind === 'query' ? 'search_query' : 'search_document'}: ${t}`)
    : texts
  const json = await postJson(`${s.ollamaUrl.replace(/\/$/, '')}/api/embed`, { model: s.embeddingModel, input })
  return (json.embeddings as number[][]).map(normalize)
}

const BATCH: Record<Settings['embeddingProvider'], number> = { local: 16, openai: 96, gemini: 64, ollama: 32 }

/** Embed texts with the configured provider. Vectors are L2-normalised. */
export async function embed(
  s: Settings,
  texts: string[],
  kind: EmbedKind,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<number[][]> {
  const out: number[][] = []
  const size = BATCH[s.embeddingProvider]
  for (let i = 0; i < texts.length; i += size) {
    signal?.throwIfAborted()
    const batch = texts.slice(i, i + size)
    let vecs: number[][]
    switch (s.embeddingProvider) {
      case 'local':
        vecs = await embedLocal(s.embeddingModel, batch, kind)
        break
      case 'openai':
        vecs = await embedOpenAI(s, batch)
        break
      case 'gemini':
        vecs = await embedGemini(s, batch, kind)
        break
      case 'ollama':
        vecs = await embedOllama(s, batch, kind)
        break
    }
    out.push(...vecs)
    onProgress?.(out.length, texts.length)
  }
  return out
}
