import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, cleanText, pageItemsToText, stripReferences } from '../src/main/textproc'

test('pageItemsToText separates lines and paragraphs by vertical gaps', () => {
  const out = pageItemsToText([
    { str: 'First line', y: 700, height: 10, hasEOL: false },
    { str: 'second line', y: 688, height: 10, hasEOL: false },
    { str: 'New paragraph', y: 650, height: 10, hasEOL: false }
  ])
  assert.equal(out, 'First line\nsecond line\n\nNew paragraph')
})

test('cleanText fixes hyphenation, merges wrapped lines and drops page numbers', () => {
  const raw = 'Retrieval aug-\nmented generation is\nuseful.\n\n12\n\nNext ﬁne paragraph.'
  assert.equal(cleanText(raw), 'Retrieval augmented generation is useful.\n\nNext fine paragraph.')
})

test('stripReferences removes the bibliography but keeps appendices', () => {
  const body = Array.from({ length: 10 }, (_, i) => `Body paragraph ${i}.`).join('\n\n')
  const text = `${body}\n\nReferences\n\n[1] Someone. A paper. 2020.\n\n[2] Another. 2021.\n\nA Appendix\n\nExtra results.`
  const out = stripReferences(text)
  assert.ok(!out.includes('Someone'))
  assert.ok(out.includes('Body paragraph 9.'))
  assert.ok(out.includes('Extra results.'))
})

test('chunkText respects size and overlap', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`)
  const text = [words.slice(0, 400).join(' '), words.slice(400).join(' ')].join('\n\n')
  const chunks = chunkText(text, 400, 80) // ~300 words per chunk, ~60 words overlap
  assert.ok(chunks.length >= 3)
  for (const c of chunks) assert.ok(c.split(/\s+/).length <= 300)
  // Consecutive chunks overlap.
  const lastOfFirst = chunks[0].split(/\s+/).pop()!
  assert.ok(chunks[1].split(/\s+/).includes(lastOfFirst))
  // Nothing is lost.
  const all = new Set(chunks.join(' ').split(/\s+/))
  assert.equal(all.size, 1000)
})

test('chunkText returns a single chunk for short text', () => {
  assert.deepEqual(chunkText('short text', 1000, 200), ['short text'])
})
