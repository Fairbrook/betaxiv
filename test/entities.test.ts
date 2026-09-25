import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLineMap, collectionOverview, entityKeys, entityPromptInput, parseEntityReply } from '../src/main/entities'

test('parseEntityReply tolerates fences and validates fields', () => {
  const reply = 'Here you go:\n```json\n' + JSON.stringify({
    tldr: 'We propose X.',
    entities: [
      { name: 'Retrieval-Augmented Generation (RAG)', type: 'method', role: 'uses' },
      { name: 'HotpotQA', type: 'dataset', role: 'evaluates-on' },
      { name: 'hotpotqa', type: 'dataset', role: 'uses' },
      { name: 'Weird', type: 'banana', role: 'invents' },
      { name: '', type: 'task' }
    ]
  }) + '\n```'
  const r = parseEntityReply(reply)
  assert.equal(r.tldr, 'We propose X.')
  assert.deepEqual(r.entities.map((e) => e.name), ['Retrieval-Augmented Generation (RAG)', 'HotpotQA', 'Weird'])
  assert.deepEqual(r.entities[2], { name: 'Weird', type: 'concept', role: 'discusses' })
  assert.throws(() => parseEntityReply('no json here'))
})

test('entityKeys splits "Long Name (ACR)"', () => {
  assert.deepEqual(entityKeys('Retrieval-Augmented Generation (RAG)'), ['retrievalaugmentedgenerationrag', 'retrievalaugmentedgeneration', 'rag'])
  assert.deepEqual(entityKeys('BLEU'), ['bleu'])
})

test('buildLineMap merges acronyms and long names across papers, per type', () => {
  const map = buildLineMap([
    { id: 'p1', entities: [{ name: 'RAG', type: 'method', role: 'uses' }, { name: 'HotpotQA', type: 'dataset', role: 'evaluates-on' }] },
    { id: 'p2', entities: [{ name: 'Retrieval-Augmented Generation (RAG)', type: 'method', role: 'compares-to' }] },
    { id: 'p3', entities: [{ name: 'Retrieval Augmented Generation', type: 'method', role: 'proposes' }, { name: 'RAG', type: 'concept', role: 'discusses' }] }
  ])
  const rag = map.find((e) => e.type === 'method')!
  assert.equal(rag.name, 'Retrieval-Augmented Generation (RAG)')
  assert.deepEqual(rag.papers.map((p) => p.paperId), ['p1', 'p2', 'p3'])
  assert.equal(map[0], rag) // most shared first
  assert.ok(map.some((e) => e.type === 'concept' && e.papers.length === 1))
})

test('entityPromptInput stops after the introduction', () => {
  const text = `1 Introduction\n\n${'intro words '.repeat(100)}\n\n2 Related Work\n\nshould not appear`
  const out = entityPromptInput({ title: 'T', abstract: 'A' }, text)
  assert.ok(out.includes('intro words'))
  assert.ok(!out.includes('should not appear'))
})

test('collectionOverview lists tldr and non-trivial entities', () => {
  const s = collectionOverview([
    { id: '1', title: 'Paper', tldr: 'Does X.', entities: [{ name: 'X', type: 'method', role: 'proposes' }, { name: 'Y', type: 'concept', role: 'discusses' }] }
  ])
  assert.ok(s.includes('Does X.') && s.includes('X [method, proposes]') && !s.includes('Y ['))
})
