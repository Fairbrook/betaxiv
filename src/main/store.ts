import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './fsutil'
import type { ChatMessage, ImportResult, NewLineInput, Paper, PaperStatus, ReaderState, ResearchLine } from '../shared/types'

interface Library {
  version: 1
  lines: ResearchLine[]
  papers: Record<string, Paper>
  /** Paper ids removed from each line, so fetching doesn't bring them back. */
  dismissed?: Record<string, string[]>
  /** Bookmarked paper ids per research line. */
  bookmarks?: Record<string, string[]>
}

/** Files in a paper's folder that hold the reader's per-paper data. */
const USER_FILES = ['reader.json', 'notes.md', 'paper.annotated.pdf']

/**
 * Local, file-based library:
 *   library.json                 research lines + paper metadata
 *   papers/<id>/paper.pdf        downloaded full text
 *   papers/<id>/paper.md         extracted, cleaned text
 *   papers/<id>/chunks.json      chunk texts + embedding metadata
 *   papers/<id>/embeddings.bin   Float32 embedding matrix (chunks x dim)
 *   papers/<id>/reader.json      where the reader left off (page, scroll, zoom)
 *   papers/<id>/paper.annotated.pdf  the PDF with your highlights/text/drawings saved in
 *   papers/<id>/notes.md         your notes on the paper
 *   chats/<lineId>.json          chat history per research line
 */
export class Store {
  private lib: Library

  constructor(readonly root: string) {
    fs.mkdirSync(path.join(root, 'papers'), { recursive: true })
    fs.mkdirSync(path.join(root, 'chats'), { recursive: true })
    this.lib = readJson<Library>(this.libFile, { version: 1, lines: [], papers: {} })
    // Anything interrupted mid-pipeline by a quit gets picked up again as pending.
    for (const p of Object.values(this.lib.papers)) {
      if (p.status === 'downloading' || p.status === 'extracting' || p.status === 'indexing') p.status = 'pending'
    }
  }

  private get libFile() {
    return path.join(this.root, 'library.json')
  }

  private save() {
    writeJson(this.libFile, this.lib)
  }

  paperDir(id: string): string {
    // Old-style ids contain a slash (hep-th/9901001).
    return path.join(this.root, 'papers', this.dirName(id))
  }

  // ---- research lines -------------------------------------------------------

  listLines(): ResearchLine[] {
    return [...this.lib.lines].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getLine(id: string): ResearchLine {
    const line = this.lib.lines.find((l) => l.id === id)
    if (!line) throw new Error(`Unknown research line ${id}`)
    return line
  }

  createLine(input: NewLineInput): ResearchLine {
    const line: ResearchLine = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.lib.lines.push(line)
    this.save()
    return line
  }

  updateLine(line: ResearchLine): ResearchLine {
    const idx = this.lib.lines.findIndex((l) => l.id === line.id)
    if (idx < 0) throw new Error(`Unknown research line ${line.id}`)
    this.lib.lines[idx] = { ...line }
    this.save()
    return this.lib.lines[idx]
  }

  /** Delete a line; papers no other line references are removed from disk too. */
  deleteLine(id: string): void {
    this.lib.lines = this.lib.lines.filter((l) => l.id !== id)
    for (const p of Object.values(this.lib.papers)) {
      if (!p.lineIds.includes(id)) continue
      p.lineIds = p.lineIds.filter((l) => l !== id)
      if (p.lineIds.length === 0) {
        delete this.lib.papers[p.id]
        fs.rmSync(this.paperDir(p.id), { recursive: true, force: true })
      }
    }
    fs.rmSync(this.chatFile(id), { force: true })
    delete this.lib.dismissed?.[id]
    delete this.lib.bookmarks?.[id]
    this.save()
  }

  // ---- papers ---------------------------------------------------------------

  hasPaper(id: string): boolean {
    return id in this.lib.papers
  }

  getPaper(id: string): Paper {
    const p = this.lib.papers[id]
    if (!p) throw new Error(`Unknown paper ${id}`)
    return p
  }

  papersForLine(lineId: string): Paper[] {
    return Object.values(this.lib.papers)
      .filter((p) => p.lineIds.includes(lineId))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.published.localeCompare(a.published))
  }

  addPaper(p: Paper): void {
    this.lib.papers[p.id] = p
    this.save()
  }

  /** Attach an existing paper to another research line. Returns true if it wasn't linked yet. */
  linkPaper(paperId: string, lineId: string): boolean {
    const p = this.getPaper(paperId)
    if (p.lineIds.includes(lineId)) return false
    p.lineIds.push(lineId)
    this.save()
    return true
  }

  updatePaper(id: string, patch: Partial<Paper>): Paper {
    const p = this.getPaper(id)
    Object.assign(p, patch)
    if (patch.status && patch.status !== 'error') delete p.error
    this.save()
    return p
  }

  isDismissed(paperId: string, lineId: string): boolean {
    return !!this.lib.dismissed?.[lineId]?.includes(paperId)
  }

  /** Forget that a paper was removed from a line (it's being added back by hand). */
  undismiss(paperId: string, lineId: string): void {
    const list = this.lib.dismissed?.[lineId]
    if (!list?.includes(paperId)) return
    list.splice(list.indexOf(paperId), 1)
    this.save()
  }

  /**
   * Take a paper out of a line and remember it as dismissed there. Once no line
   * references it, it's deleted from the library and disk. Returns true if deleted.
   */
  removePaper(paperId: string, lineId: string): boolean {
    const dismissed = (this.lib.dismissed ??= {})
    const list = (dismissed[lineId] ??= [])
    if (!list.includes(paperId)) list.push(paperId)
    this.dropBookmark(paperId, lineId)
    const p = this.lib.papers[paperId]
    let deleted = false
    if (p) {
      p.lineIds = p.lineIds.filter((l) => l !== lineId)
      if (p.lineIds.length === 0) {
        delete this.lib.papers[paperId]
        fs.rmSync(this.paperDir(paperId), { recursive: true, force: true })
        deleted = true
      }
    }
    this.save()
    return deleted
  }

  // ---- bookmarks ------------------------------------------------------------

  bookmarks(lineId: string): string[] {
    return [...(this.lib.bookmarks?.[lineId] ?? [])]
  }

  /** Bookmark (or un-bookmark) a paper within one research line. Returns the line's bookmarks. */
  setBookmark(lineId: string, paperId: string, on: boolean): string[] {
    this.getLine(lineId)
    if (on && !this.getPaper(paperId).lineIds.includes(lineId)) throw new Error('That paper is not in this research line')
    if (on) {
      const list = ((this.lib.bookmarks ??= {})[lineId] ??= [])
      if (!list.includes(paperId)) list.push(paperId)
      this.save()
    } else this.dropBookmark(paperId, lineId, true)
    return this.bookmarks(lineId)
  }

  private dropBookmark(paperId: string, lineId: string, save = false): void {
    const list = this.lib.bookmarks?.[lineId]
    if (!list?.includes(paperId)) return
    list.splice(list.indexOf(paperId), 1)
    if (!list.length) delete this.lib.bookmarks![lineId]
    if (save) this.save()
  }

  // ---- reader: position, annotations, notes ---------------------------------

  /** The PDF the reader should show: your annotated copy if there is one, else the original. */
  pdfFile(id: string): string | null {
    const dir = this.knownPaperDir(id)
    for (const name of ['paper.annotated.pdf', 'paper.pdf']) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) return file
    }
    return null
  }

  readerState(id: string): ReaderState | null {
    const s = readJson<Partial<ReaderState> | null>(path.join(this.knownPaperDir(id), 'reader.json'), null)
    if (!s || !Number.isInteger(s.page) || (s.page as number) < 1) return null
    return {
      page: s.page as number,
      top: typeof s.top === 'number' ? s.top : null,
      left: typeof s.left === 'number' ? s.left : null,
      scale: typeof s.scale === 'string' && s.scale ? s.scale : 'page-width',
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : ''
    }
  }

  saveReaderState(id: string, state: ReaderState): void {
    const dir = this.knownPaperDir(id)
    if (!fs.existsSync(dir)) return // paper was deleted while the reader was open
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    writeJson(path.join(dir, 'reader.json'), {
      page: Math.max(1, Math.floor(Number(state.page)) || 1),
      top: num(state.top),
      left: num(state.left),
      scale: String(state.scale || 'page-width').slice(0, 20),
      updatedAt: new Date().toISOString()
    } satisfies ReaderState)
  }

  /** Save the annotated copy of the PDF. The original paper.pdf is left alone. */
  saveAnnotatedPdf(id: string, data: Uint8Array): void {
    const dir = this.knownPaperDir(id)
    if (!fs.existsSync(dir)) return
    if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') throw new Error('Not a PDF')
    const file = path.join(dir, 'paper.annotated.pdf')
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  }

  notes(id: string): string {
    const dir = this.knownPaperDir(id)
    try {
      return fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')
    } catch {
      return ''
    }
  }

  saveNotes(id: string, text: string): void {
    const dir = this.knownPaperDir(id)
    if (!fs.existsSync(dir)) return
    const file = path.join(dir, 'notes.md')
    if (!text.trim()) return void fs.rmSync(file, { force: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }

  // ---- import ---------------------------------------------------------------

  /**
   * Merge another data folder (an unpacked export) into this library. Nothing here is
   * deleted or overwritten, except a paper that isn't indexed yet, which takes the imported
   * copy when that one is indexed. Files are moved out of `src`, so it's spent afterwards.
   */
  importFrom(src: string): ImportResult {
    const other = readJson<Partial<Library> | null>(path.join(src, 'library.json'), null)
    if (!other || !Array.isArray(other.lines) || !other.papers || typeof other.papers !== 'object') {
      throw new Error('This archive has no betaxiv library in it')
    }
    const result: ImportResult = { lines: 0, papers: 0, linked: 0, updated: 0 }
    for (const l of other.lines) {
      if (!l || typeof l.id !== 'string' || this.lib.lines.some((x) => x.id === l.id)) continue
      this.lib.lines.push(l)
      result.lines++
    }
    const lineIds = new Set(this.lib.lines.map((l) => l.id))
    const busy = (s: PaperStatus) => s === 'downloading' || s === 'extracting' || s === 'indexing'

    for (const p of Object.values(other.papers)) {
      if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(p.id) || /^\.+$/.test(this.dirName(p.id))) continue
      const ids = (Array.isArray(p.lineIds) ? p.lineIds : []).filter((id) => lineIds.has(id))
      if (!ids.length) continue
      const from = path.join(src, 'papers', this.dirName(p.id))
      const status: PaperStatus = busy(p.status) ? 'pending' : p.status
      const cur = this.lib.papers[p.id]
      if (!cur) {
        this.lib.papers[p.id] = { ...p, lineIds: ids, status }
        this.moveDir(from, this.paperDir(p.id))
        result.papers++
        continue
      }
      const added = ids.filter((id) => !cur.lineIds.includes(id))
      cur.lineIds.push(...added)
      if (added.length) result.linked++
      if (cur.status !== 'indexed' && !busy(cur.status) && status === 'indexed' && fs.existsSync(from)) {
        // Keep what you made here (reading position, notes, annotations) over the imported copy's.
        const mineDir = this.paperDir(p.id)
        for (const name of USER_FILES) {
          const mine = path.join(mineDir, name)
          if (fs.existsSync(mine)) fs.copyFileSync(mine, path.join(from, name))
        }
        fs.rmSync(mineDir, { recursive: true, force: true })
        this.moveDir(from, mineDir)
        Object.assign(cur, { ...p, lineIds: cur.lineIds, addedAt: cur.addedAt, status })
        delete cur.error
        result.updated++
      }
    }

    for (const [lineId, list] of Object.entries(other.dismissed ?? {})) {
      if (!lineIds.has(lineId) || !Array.isArray(list)) continue
      const mine = ((this.lib.dismissed ??= {})[lineId] ??= [])
      for (const id of list) {
        if (typeof id === 'string' && !mine.includes(id) && !this.lib.papers[id]?.lineIds.includes(lineId)) mine.push(id)
      }
    }

    for (const [lineId, list] of Object.entries(other.bookmarks ?? {})) {
      if (!lineIds.has(lineId) || !Array.isArray(list)) continue
      const mine = ((this.lib.bookmarks ??= {})[lineId] ??= [])
      for (const id of list) {
        if (typeof id === 'string' && !mine.includes(id) && this.lib.papers[id]?.lineIds.includes(lineId)) mine.push(id)
      }
      if (!mine.length) delete this.lib.bookmarks![lineId]
    }

    for (const lineId of lineIds) {
      const theirs = readJson<ChatMessage[]>(path.join(src, 'chats', `${lineId}.json`), [])
      if (!Array.isArray(theirs) || !theirs.length) continue
      const mine = this.chatHistory(lineId)
      const seen = new Set(mine.map((m) => m.id))
      const merged = [...mine, ...theirs.filter((m) => m && !seen.has(m.id))]
      if (merged.length === mine.length) continue
      merged.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      writeJson(this.chatFile(lineId), merged)
    }

    // A bundled embedding model saves re-downloading it; keep any copy that's already here.
    this.moveMissing(path.join(src, 'models'), path.join(this.root, 'models'))
    this.save()
    return result
  }

  /** A paper's folder; throws for ids that aren't in the library. */
  private knownPaperDir(id: string): string {
    this.getPaper(id)
    return this.paperDir(id)
  }

  private dirName(id: string): string {
    return id.replace(/\//g, '_')
  }

  private moveDir(from: string, to: string) {
    if (!fs.existsSync(from)) return
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  }

  private moveMissing(from: string, to: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(from, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const a = path.join(from, e.name)
      const b = path.join(to, e.name)
      if (!fs.existsSync(b)) this.moveDir(a, b)
      else if (e.isDirectory()) this.moveMissing(a, b)
    }
  }

  // ---- chats ----------------------------------------------------------------

  private chatFile(lineId: string) {
    return path.join(this.root, 'chats', `${lineId}.json`)
  }

  chatHistory(lineId: string): ChatMessage[] {
    return readJson<ChatMessage[]>(this.chatFile(lineId), [])
  }

  appendChat(lineId: string, ...msgs: ChatMessage[]): void {
    writeJson(this.chatFile(lineId), [...this.chatHistory(lineId), ...msgs])
  }

  clearChat(lineId: string): void {
    fs.rmSync(this.chatFile(lineId), { force: true })
  }
}
