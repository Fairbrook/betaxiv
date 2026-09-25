// Types shared between the main process, preload bridge and renderer.

export type MatchMode = 'all' | 'any'
export type SortBy = 'submittedDate' | 'lastUpdatedDate' | 'relevance'

export interface ResearchLine {
  id: string
  name: string
  keywords: string[]
  /** 'all' joins keywords with AND, 'any' with OR. */
  matchMode: MatchMode
  /** Optional arXiv categories to restrict to, e.g. cs.CL, cs.LG. */
  categories: string[]
  sortBy: SortBy
  createdAt: string
}

/**
 * 'review' = fetched, waiting for you to approve it before anything is downloaded or indexed.
 * 'pending' = approved, not processed yet.
 */
export type PaperStatus = 'review' | 'pending' | 'downloading' | 'extracting' | 'indexing' | 'indexed' | 'error'

export interface Paper {
  /** arXiv identifier without version suffix, e.g. 2401.01234 or hep-th/9901001. */
  id: string
  version: string
  title: string
  authors: string[]
  abstract: string
  published: string
  updated: string
  categories: string[]
  primaryCategory?: string
  absUrl: string
  pdfUrl: string
  addedAt: string
  /** Research lines this paper belongs to. */
  lineIds: string[]
  status: PaperStatus
  error?: string
  chunkCount?: number
  /** `${provider}:${model}` the stored embeddings were built with. */
  embeddingModel?: string
  /** One-sentence contribution summary from the entity-map step. */
  tldr?: string
  /** Key entities from the title/abstract/introduction (undefined = not extracted yet). */
  entities?: PaperEntity[]
  /** Why entity extraction failed (the paper is still searchable). */
  entitiesError?: string
}

export type EntityType = 'task' | 'method' | 'model' | 'dataset' | 'metric' | 'concept'
/** How the paper relates to the entity. */
export type EntityRole = 'proposes' | 'uses' | 'evaluates-on' | 'compares-to' | 'discusses'

export interface PaperEntity {
  name: string
  type: EntityType
  role: EntityRole
}

/** An entity merged across the papers of a research line. */
export interface LineEntity {
  key: string
  name: string
  type: EntityType
  papers: { paperId: string; role: EntityRole }[]
}

/**
 * 'claude-code' answers through the Claude Agent SDK, which signs in with your
 * Claude Code login (Pro/Max plan), so no API key is needed.
 */
export type LlmProvider = 'claude-code' | 'anthropic' | 'gemini' | 'openai' | 'ollama'
/** 'local' runs a small sentence-embedding model in-process (no key needed). */
export type EmbeddingProvider = 'local' | 'openai' | 'gemini' | 'ollama'

export interface Settings {
  llmProvider: LlmProvider
  llmModel: string
  /** Model for the per-paper entity map; empty = same as llmModel. A small model keeps it cheap. */
  entityModel: string
  embeddingProvider: EmbeddingProvider
  embeddingModel: string
  apiKeys: { openai: string; gemini: string; anthropic: string }
  /** Optional long-lived token from `claude setup-token`; otherwise the local Claude Code login is used. */
  claudeOauthToken: string
  ollamaUrl: string
  /** Chunk size / overlap in (approximate) tokens — alphaxiv-open defaults are 1000 / 200. */
  chunkSize: number
  chunkOverlap: number
  /** Number of chunks passed to the LLM as context. */
  topK: number
  /** Drop the references section from extracted text before indexing. */
  stripReferences: boolean
  /** Build the per-paper entity map (one LLM call per paper). */
  extractEntities: boolean
}

export interface SourceChunk {
  /** 1-based citation number used in the answer. */
  n: number
  paperId: string
  title: string
  chunkIndex: number
  text: string
  score: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  sources?: SourceChunk[]
  /** Paper ids the question was scoped to (empty = whole research line). */
  scope?: string[]
  error?: boolean
}

export type JobStage = 'searching' | 'downloading' | 'extracting' | 'indexing' | 'mapping' | 'done' | 'error'

export interface JobProgress {
  lineId: string
  stage: JobStage
  message: string
  current?: number
  total?: number
  running: boolean
}

export interface FetchResult {
  added: number
  linked: number
  skipped: number
  exhausted: boolean
}

export interface ChatTokenEvent {
  requestId: string
  token: string
}

export interface NewLineInput {
  name: string
  keywords: string[]
  matchMode: MatchMode
  categories: string[]
  sortBy: SortBy
}

export interface BetaxivApi {
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  /** Send a tiny prompt with the given (unsaved) settings; resolves with the reply. */
  testLlm(s: Settings): Promise<string>

  listLines(): Promise<ResearchLine[]>
  createLine(input: NewLineInput): Promise<ResearchLine>
  updateLine(line: ResearchLine): Promise<ResearchLine>
  deleteLine(id: string): Promise<void>
  previewQuery(input: NewLineInput): Promise<string>

  listPapers(lineId: string): Promise<Paper[]>
  fetchNewPapers(lineId: string, n: number): Promise<FetchResult>
  processPending(lineId: string): Promise<void>
  reindexPaper(lineId: string, paperId: string): Promise<void>
  /** Approve papers awaiting review: they're downloaded, indexed and mapped like before. */
  approvePapers(lineId: string, paperIds: string[]): Promise<void>
  /** Remove papers from a line (also used to discard ones awaiting review); later fetches skip them. */
  removePapers(lineId: string, paperIds: string[]): Promise<void>
  cancelJob(lineId: string): Promise<void>
  openPdf(paperId: string): Promise<void>
  openExternal(url: string): Promise<void>
  getPaperText(paperId: string): Promise<string>
  lineMap(lineId: string): Promise<LineEntity[]>

  chatHistory(lineId: string): Promise<ChatMessage[]>
  ask(lineId: string, question: string, paperIds: string[], requestId: string): Promise<ChatMessage>
  stopAnswer(requestId: string): Promise<void>
  clearChat(lineId: string): Promise<void>

  onJobProgress(cb: (p: JobProgress) => void): () => void
  onPapersChanged(cb: (lineId: string) => void): () => void
  onChatToken(cb: (e: ChatTokenEvent) => void): () => void
}
