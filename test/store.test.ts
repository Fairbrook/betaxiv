import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/store'
import type { Paper } from '../src/shared/types'

const paper = (id: string, lineIds: string[]): Paper => ({
  id,
  version: 'v1',
  title: `Paper ${id}`,
  authors: [],
  abstract: '',
  published: '',
  updated: '',
  categories: [],
  absUrl: '',
  pdfUrl: '',
  addedAt: new Date().toISOString(),
  lineIds,
  status: 'review'
})

test('removePaper dismisses the paper and deletes it once no line uses it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-'))
  try {
    const store = new Store(root)
    store.addPaper(paper('1', ['a', 'b']))
    fs.mkdirSync(store.paperDir('1'), { recursive: true })

    assert.equal(store.removePaper('1', 'a'), false)
    assert.deepEqual(store.getPaper('1').lineIds, ['b'])
    assert.ok(store.isDismissed('1', 'a'))
    assert.ok(!store.isDismissed('1', 'b'))

    assert.equal(store.removePaper('1', 'b'), true)
    assert.ok(!store.hasPaper('1'))
    assert.ok(!fs.existsSync(store.paperDir('1')))

    // Dismissals survive a reload.
    assert.ok(new Store(root).isDismissed('1', 'b'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('undismiss lets a removed paper be added back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-'))
  try {
    const store = new Store(root)
    store.addPaper(paper('1', ['a']))
    store.removePaper('1', 'a')
    assert.ok(store.isDismissed('1', 'a'))
    store.undismiss('1', 'a')
    assert.ok(!store.isDismissed('1', 'a'))
    assert.ok(!new Store(root).isDismissed('1', 'a'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const withStore = (fn: (store: Store, root: string) => void) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-'))
  try {
    fn(new Store(root), root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const newLine = (store: Store, name: string) =>
  store.createLine({ name, keywords: [name], matchMode: 'all', categories: [], sortBy: 'submittedDate' })

test('bookmarks are per line, persist, and go away with the paper or the line', () => {
  withStore((store, root) => {
    const a = newLine(store, 'a')
    const b = newLine(store, 'b')
    store.addPaper(paper('1', [a.id, b.id]))
    store.addPaper(paper('2', [a.id]))
    for (const id of ['1', '2']) fs.mkdirSync(store.paperDir(id), { recursive: true })

    assert.deepEqual(store.setBookmark(a.id, '1', true), ['1'])
    assert.deepEqual(store.setBookmark(a.id, '1', true), ['1'], 'bookmarking twice is a no-op')
    store.setBookmark(a.id, '2', true)
    assert.deepEqual(store.bookmarks(b.id), [], 'bookmarks do not leak across lines')
    assert.throws(() => store.setBookmark(b.id, '2', true), /not in this research line/)
    assert.deepEqual(new Store(root).bookmarks(a.id), ['1', '2'])

    assert.deepEqual(store.setBookmark(a.id, '2', false), ['1'])
    store.setBookmark(b.id, '1', true)
    store.removePaper('1', a.id)
    assert.deepEqual(store.bookmarks(a.id), [])
    assert.deepEqual(store.bookmarks(b.id), ['1'], 'still bookmarked in the line that keeps it')

    store.deleteLine(b.id)
    assert.deepEqual(store.bookmarks(b.id), [])
  })
})

test('reader position, notes and annotated PDF round-trip and are tied to known papers', () => {
  withStore((store, root) => {
    const line = newLine(store, 'a')
    store.addPaper(paper('1', [line.id]))
    fs.mkdirSync(store.paperDir('1'), { recursive: true })
    fs.writeFileSync(path.join(store.paperDir('1'), 'paper.pdf'), '%PDF-1.7 original')

    assert.equal(store.readerState('1'), null)
    store.saveReaderState('1', { page: 7, top: 120.5, left: null, scale: '1.25', updatedAt: '' })
    const again = new Store(root).readerState('1')
    assert.deepEqual({ ...again, updatedAt: '' }, { page: 7, top: 120.5, left: null, scale: '1.25', updatedAt: '' })

    assert.equal(store.notes('1'), '')
    store.saveNotes('1', 'key idea: x')
    assert.equal(new Store(root).notes('1'), 'key idea: x')
    store.saveNotes('1', '  ')
    assert.equal(store.notes('1'), '', 'blank notes remove the file')

    assert.equal(store.pdfFile('1'), path.join(store.paperDir('1'), 'paper.pdf'))
    assert.throws(() => store.saveAnnotatedPdf('1', new TextEncoder().encode('nope')), /Not a PDF/)
    store.saveAnnotatedPdf('1', new TextEncoder().encode('%PDF-1.7 annotated'))
    assert.equal(store.pdfFile('1'), path.join(store.paperDir('1'), 'paper.annotated.pdf'))
    assert.equal(fs.readFileSync(path.join(store.paperDir('1'), 'paper.pdf'), 'utf8'), '%PDF-1.7 original')

    for (const f of [() => store.readerState('../x'), () => store.notes('../x'), () => store.pdfFile('../x')]) {
      assert.throws(f, /Unknown paper/)
    }
  })
})

test('importFrom merges bookmarks and keeps your reader files on an updated paper', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-src-'))
  try {
    withStore((store) => {
      const line = newLine(store, 'a')
      store.addPaper(paper('1', [line.id])) // review: not indexed here
      store.addPaper(paper('2', [line.id]))
      fs.mkdirSync(store.paperDir('1'), { recursive: true })
      store.saveNotes('1', 'my notes')

      const other = new Store(src)
      other.createLine({ name: 'x', keywords: [], matchMode: 'all', categories: [], sortBy: 'submittedDate' })
      // Same line id as ours, so the imported papers/bookmarks belong to a known line.
      const lib = JSON.parse(fs.readFileSync(path.join(src, 'library.json'), 'utf8'))
      lib.lines = [{ ...lib.lines[0], id: line.id }]
      lib.papers = {
        '1': { ...paper('1', [line.id]), status: 'indexed' },
        '2': { ...paper('2', [line.id]), status: 'indexed' },
        '3': { ...paper('3', [line.id]), status: 'indexed' }
      }
      lib.bookmarks = { [line.id]: ['2', '3', 'ghost'] }
      fs.writeFileSync(path.join(src, 'library.json'), JSON.stringify(lib))
      for (const id of ['1', '2', '3']) {
        fs.mkdirSync(path.join(src, 'papers', id), { recursive: true })
        fs.writeFileSync(path.join(src, 'papers', id, 'chunks.json'), '[]')
      }

      store.importFrom(src)
      assert.deepEqual(store.bookmarks(line.id).sort(), ['2', '3'])
      assert.equal(store.getPaper('1').status, 'indexed', 'took the imported, indexed copy')
      assert.equal(store.notes('1'), 'my notes', 'but kept your notes')
      assert.ok(fs.existsSync(path.join(store.paperDir('1'), 'chunks.json')))
    })
  } finally {
    fs.rmSync(src, { recursive: true, force: true })
  }
})
