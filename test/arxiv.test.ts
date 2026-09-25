import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchQuery, parseAtom, splitArxivId } from '../src/main/arxiv'

test('buildSearchQuery quotes phrases and joins with the match mode', () => {
  assert.equal(
    buildSearchQuery({ keywords: ['retrieval augmented generation', 'rag'], matchMode: 'all', categories: [] }),
    '(all:"retrieval augmented generation" AND all:rag)'
  )
  assert.equal(buildSearchQuery({ keywords: ['a', 'b'], matchMode: 'any', categories: ['cs.CL', 'cs.IR'] }), '(all:a OR all:b) AND (cat:cs.CL OR cat:cs.IR)')
  assert.equal(buildSearchQuery({ keywords: ['ti:transformer'], matchMode: 'all', categories: [] }), 'ti:transformer')
  assert.throws(() => buildSearchQuery({ keywords: [' '], matchMode: 'all', categories: [] }))
})

test('splitArxivId handles new and old style ids', () => {
  assert.deepEqual(splitArxivId('http://arxiv.org/abs/2401.01234v3'), { id: '2401.01234', version: 'v3' })
  assert.deepEqual(splitArxivId('http://arxiv.org/abs/hep-th/9901001v1'), { id: 'hep-th/9901001', version: 'v1' })
  assert.deepEqual(splitArxivId('2401.01234'), { id: '2401.01234', version: 'v1' })
})

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2024-01-05T00:00:00Z</updated>
    <published>2024-01-02T00:00:00Z</published>
    <title>A  Paper
      About Things</title>
    <summary>  We study things.  </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2401.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.LG"/>
  </entry>
</feed>`

test('parseAtom extracts entries', () => {
  const page = parseAtom(FEED)
  assert.equal(page.total, 42)
  assert.equal(page.entries.length, 1)
  const e = page.entries[0]
  assert.equal(e.id, '2401.01234')
  assert.equal(e.version, 'v2')
  assert.equal(e.title, 'A Paper About Things')
  assert.equal(e.abstract, 'We study things.')
  assert.deepEqual(e.authors, ['Ada Lovelace', 'Alan Turing'])
  assert.deepEqual(e.categories, ['cs.CL', 'cs.LG'])
  assert.equal(e.primaryCategory, 'cs.CL')
  assert.equal(e.pdfUrl, 'https://arxiv.org/pdf/2401.01234v2')
})

test('parseAtom surfaces API errors', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#bad</id><summary>malformed query</summary></entry></feed>`
  assert.throws(() => parseAtom(xml), /malformed query/)
})
