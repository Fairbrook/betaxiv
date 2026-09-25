import fs from 'node:fs'
import path from 'node:path'
import { ARXIV_DELAY_MS, buildSearchQuery, searchArxiv } from './arxiv'
import { downloadPdf, pdfToText } from './pdf'
import { ENTITY_SYSTEM_PROMPT, entityPromptInput, parseEntityReply } from './entities'
import { complete } from './llm'
import { forgetIndex, indexPaper } from './rag'
import { embeddingKey, getSettings } from './settings'
import type { Store } from './store'
import type { FetchResult, JobProgress, Paper } from '../shared/types'

export interface PipelineEvents {
  progress(p: JobProgress): void
  papersChanged(lineId: string): void
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason)
    })
  })

const ENTITY_TIMEOUT_MS = 180_000

// Safety cap on how deep we page through arXiv results looking for new papers.
const MAX_SCAN = 2000

export class Pipeline {
  private jobs = new Map<string, AbortController>()

  constructor(
    private store: Store,
    private events: PipelineEvents,
    /** Working directory for the Claude Agent SDK. */
    private workDir: string
  ) {}

  isRunning(lineId: string): boolean {
    return this.jobs.has(lineId)
  }

  cancel(lineId: string): void {
    this.jobs.get(lineId)?.abort(new Error('Cancelled'))
  }

  private async run<T>(lineId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(lineId)) throw new Error('A job is already running for this research line')
    const ctrl = new AbortController()
    this.jobs.set(lineId, ctrl)
    try {
      return await fn(ctrl.signal)
    } catch (err) {
      const cancelled = ctrl.signal.aborted
      this.emit(lineId, cancelled ? 'done' : 'error', cancelled ? 'Cancelled' : (err as Error).message)
      if (cancelled) return undefined as T
      throw err
    } finally {
      this.jobs.delete(lineId)
      this.events.papersChanged(lineId)
    }
  }

  private emit(lineId: string, stage: JobProgress['stage'], message: string, current?: number, total?: number) {
    const running = stage !== 'done' && stage !== 'error'
    this.events.progress({ lineId, stage, message, current, total, running })
  }

  /**
   * Search arXiv for the line's keywords and add `n` papers that aren't in the
   * library yet, paging further through the results whenever the ones found are
   * already known. Then download, extract and index each new paper.
   */
  fetchNew(lineId: string, n: number): Promise<FetchResult> {
    return this.run(lineId, async (signal) => {
      const line = this.store.getLine(lineId)
      const query = buildSearchQuery(line)
      const pageSize = Math.min(100, Math.max(25, n * 2))
      const result: FetchResult = { added: 0, linked: 0, skipped: 0, exhausted: false }
      const newIds: string[] = []
      let start = 0

      while (result.added < n) {
        this.emit(lineId, 'searching', `Searching arXiv (results ${start + 1}–${start + pageSize})…`, result.added, n)
        const page = await searchArxiv(query, start, pageSize, line.sortBy, signal)
        for (const entry of page.entries) {
          if (result.added >= n) break
          if (this.store.hasPaper(entry.id)) {
            // Already in the system: don't count it, but make sure it's part of this line.
            if (this.store.linkPaper(entry.id, lineId)) result.linked++
            else result.skipped++
            continue
          }
          const paper: Paper = { ...entry, addedAt: new Date().toISOString(), lineIds: [lineId], status: 'pending' }
          this.store.addPaper(paper)
          newIds.push(paper.id)
          result.added++
        }
        this.events.papersChanged(lineId)
        start += pageSize
        if (page.entries.length === 0 || start >= page.total || start >= MAX_SCAN) {
          result.exhausted = result.added < n
          break
        }
        if (result.added < n) await sleep(ARXIV_DELAY_MS, signal)
      }

      await this.processPapers(lineId, newIds, signal)
      const parts = [`Added ${result.added} new paper${result.added === 1 ? '' : 's'}`]
      if (result.linked) parts.push(`linked ${result.linked} already in your library`)
      if (result.skipped) parts.push(`skipped ${result.skipped} already in this line`)
      if (result.exhausted) parts.push('no more matching results on arXiv')
      this.emit(lineId, 'done', parts.join(', '))
      return result
    })
  }

  /** Retry everything in the line that isn't indexed with the current embedding model. */
  processPending(lineId: string): Promise<void> {
    return this.run(lineId, async (signal) => {
      const settings = getSettings()
      const model = embeddingKey(settings)
      const ids = this.store
        .papersForLine(lineId)
        .filter(
          (p) =>
            p.status !== 'indexed' ||
            p.embeddingModel !== model ||
            (settings.extractEntities && (p.entities === undefined || !!p.entitiesError))
        )
        .map((p) => p.id)
      await this.processPapers(lineId, ids, signal)
      this.emit(lineId, 'done', ids.length ? `Processed ${ids.length} paper${ids.length === 1 ? '' : 's'}` : 'Nothing to process')
    })
  }

  reindex(lineId: string, paperId: string): Promise<void> {
    return this.run(lineId, async (signal) => {
      // A manual re-index also refreshes the entity map.
      this.store.updatePaper(paperId, { status: 'pending', entities: undefined, tldr: undefined, entitiesError: undefined })
      await this.processPapers(lineId, [paperId], signal)
      this.emit(lineId, 'done', 'Re-indexed paper')
    })
  }

  private async processPapers(lineId: string, ids: string[], signal: AbortSignal): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      signal.throwIfAborted()
      const paper = this.store.getPaper(ids[i])
      const label = `[${i + 1}/${ids.length}] ${paper.title}`
      try {
        await this.processPaper(lineId, paper, label, i, ids.length, signal)
      } catch (err) {
        if (signal.aborted) {
          this.store.updatePaper(paper.id, { status: 'pending' })
          throw err
        }
        this.store.updatePaper(paper.id, { status: 'error', error: (err as Error).message })
      }
      this.events.papersChanged(lineId)
    }
  }

  private async processPaper(lineId: string, paper: Paper, label: string, i: number, total: number, signal: AbortSignal) {
    const settings = getSettings()
    const dir = this.store.paperDir(paper.id)
    fs.mkdirSync(dir, { recursive: true })
    const pdfPath = path.join(dir, 'paper.pdf')
    const mdPath = path.join(dir, 'paper.md')

    if (!fs.existsSync(pdfPath)) {
      this.store.updatePaper(paper.id, { status: 'downloading' })
      this.events.papersChanged(lineId)
      this.emit(lineId, 'downloading', `Downloading full text ${label}`, i, total)
      const pdf = await downloadPdf(paper.pdfUrl, signal)
      fs.writeFileSync(pdfPath, pdf)
      // Be polite to arxiv.org between downloads.
      if (i < total - 1) await sleep(1000, signal)
    }

    if (!fs.existsSync(mdPath)) {
      this.store.updatePaper(paper.id, { status: 'extracting' })
      this.emit(lineId, 'extracting', `Extracting text ${label}`, i, total)
      const text = await pdfToText(new Uint8Array(fs.readFileSync(pdfPath)), { stripReferences: settings.stripReferences })
      if (text.length < 500) throw new Error('Could not extract meaningful text from the PDF (scanned document?)')
      const header = `# ${paper.title}\n\n${paper.authors.join(', ')}\n\narXiv:${paper.id}${paper.version} — ${paper.absUrl}\n\n`
      fs.writeFileSync(mdPath, header + text)
    }

    const current = this.store.getPaper(paper.id)
    if (current.status !== 'indexed' || current.embeddingModel !== embeddingKey(settings)) {
      this.store.updatePaper(paper.id, { status: 'indexing' })
      this.events.papersChanged(lineId)
      this.emit(lineId, 'indexing', `Embedding ${label}`, i, total)
      forgetIndex(paper.id)
      const count = await indexPaper(
        this.store,
        settings,
        paper,
        (done, all) => this.emit(lineId, 'indexing', `Embedding ${label} (${done}/${all} chunks)`, i, total),
        signal
      )
      this.store.updatePaper(paper.id, { status: 'indexed', chunkCount: count, embeddingModel: embeddingKey(settings) })
    }

    const latest = this.store.getPaper(paper.id)
    if (settings.extractEntities && (latest.entities === undefined || latest.entitiesError)) {
      this.events.papersChanged(lineId)
      this.emit(lineId, 'mapping', `Mapping entities ${label}`, i, total)
      const timeout = AbortSignal.timeout(ENTITY_TIMEOUT_MS)
      try {
        const text = fs.readFileSync(mdPath, 'utf8')
        const reply = await complete(
          { ...settings, llmModel: settings.entityModel || settings.llmModel },
          {
            system: ENTITY_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: entityPromptInput(paper, text) }],
            onToken: () => {},
            // One stuck call must not stall the whole job.
            signal: AbortSignal.any([signal, timeout])
          },
          this.workDir
        )
        const { tldr, entities } = parseEntityReply(reply)
        this.store.updatePaper(paper.id, { tldr, entities, entitiesError: undefined })
      } catch (err) {
        if (signal.aborted) throw err
        if (timeout.aborted) err = new Error('Entity extraction timed out')
        // Non-fatal: the paper stays searchable, the map just lacks it.
        this.store.updatePaper(paper.id, { entitiesError: (err as Error).message })
      }
    }
  }
}
