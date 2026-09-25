import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './fsutil'
import type { ChatMessage, NewLineInput, Paper, ResearchLine } from '../shared/types'

interface Library {
  version: 1
  lines: ResearchLine[]
  papers: Record<string, Paper>
}

/**
 * Local, file-based library:
 *   library.json                 research lines + paper metadata
 *   papers/<id>/paper.pdf        downloaded full text
 *   papers/<id>/paper.md         extracted, cleaned text
 *   papers/<id>/chunks.json      chunk texts + embedding metadata
 *   papers/<id>/embeddings.bin   Float32 embedding matrix (chunks x dim)
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
    return path.join(this.root, 'papers', id.replace(/\//g, '_'))
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
