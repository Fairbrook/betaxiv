import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bm25Scores, cosine, hybridSearch, type IndexedChunk } from '../src/main/retrieval'

test('cosine similarity', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
})

test('bm25 prefers documents containing the query terms', () => {
  const s = bm25Scores('graph neural network', ['a graph neural network model', 'a transformer model', 'graph theory'])
  assert.ok(s[0] > s[2] && s[2] > s[1])
  assert.equal(s[1], 0)
})

test('hybridSearch fuses dense and keyword rankings and caps per paper', () => {
  const mk = (paperId: string, i: number, text: string, v: number[] | null): IndexedChunk => ({
    paperId,
    chunkIndex: i,
    text,
    vector: v ? Float32Array.from(v) : null
  })
  const chunks = [
    mk('a', 0, 'we evaluate on the HotpotQA dataset', [1, 0]),
    mk('a', 1, 'unrelated text about optimisers', [0, 1]),
    mk('a', 2, 'more dataset details', [0.9, 0.1]),
    mk('b', 0, 'our dataset is new', [0.8, 0.2])
  ]
  const hits = hybridSearch(chunks, 'which dataset', [1, 0], 3, 2)
  assert.equal(hits.length, 3)
  assert.equal(hits[0].chunk.text, 'we evaluate on the HotpotQA dataset')
  assert.ok(hits.some((h) => h.chunk.paperId === 'b'))
  assert.ok(hits.filter((h) => h.chunk.paperId === 'a').length <= 2)
})

test('hybridSearch works with keyword search only', () => {
  const chunks: IndexedChunk[] = [
    { paperId: 'a', chunkIndex: 0, text: 'contrastive learning', vector: null },
    { paperId: 'a', chunkIndex: 1, text: 'reinforcement learning from feedback', vector: null }
  ]
  const hits = hybridSearch(chunks, 'reinforcement feedback', null, 5)
  assert.equal(hits[0].chunk.chunkIndex, 1)
})
