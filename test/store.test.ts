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
