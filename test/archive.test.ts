import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { ARCHIVE_ROOT, exportData } from '../src/main/archive'

function makeDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-export-'))
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), data)
  }
  w('library.json', JSON.stringify({ version: 1, lines: [{ id: 'l1' }], papers: { a: {}, b: {} } }))
  w('settings.json', JSON.stringify({ topK: 8, secrets: 'ENCRYPTED', plainSecrets: { apiKeys: { openai: 'sk-x' } } }))
  w('papers/a/paper.pdf', Buffer.from('%PDF-1.7 ' + 'x'.repeat(5000)))
  w('papers/a/chunks.json', JSON.stringify({ chunks: ['hello'] }))
  w('papers/a/embeddings.bin', Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer))
  w(`papers/${'long-id-'.repeat(15)}/paper.md`, 'long path')
  w('chats/l1.json', '[]')
  w('models/model.onnx', 'weights')
  w('claude/session.json', '{}')
  w('library.json.123.tmp', 'partial')
  return root
}

/** Minimal zip reader: walks the central directory and inflates each entry. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    const body = buf.subarray(start, start + csize)
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body)
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`)
    out.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function checkContents(files: Map<string, Buffer>, root: string) {
  const names = [...files.keys()]
  assert.ok(names.every((n) => n.startsWith(`${ARCHIVE_ROOT}/`)))
  const get = (rel: string) => files.get(`${ARCHIVE_ROOT}/${rel}`)
  assert.deepEqual(get('papers/a/paper.pdf'), fs.readFileSync(path.join(root, 'papers/a/paper.pdf')))
  assert.deepEqual(get('papers/a/embeddings.bin'), fs.readFileSync(path.join(root, 'papers/a/embeddings.bin')))
  assert.equal(get(`papers/${'long-id-'.repeat(15)}/paper.md`)?.toString(), 'long path')
  assert.ok(get('chats/l1.json'))
  assert.ok(get('library.json'))
  assert.ok(!names.some((n) => n.includes('/claude/') || n.includes('/models/') || n.endsWith('.tmp')))
  const settings = JSON.parse(get('settings.json')!.toString())
  assert.equal(settings.topK, 8)
  assert.ok(!('secrets' in settings) && !('plainSecrets' in settings))
  const manifest = JSON.parse(get('manifest.json')!.toString())
  assert.equal(manifest.papers, 2)
  assert.equal(manifest.lines, 1)
}

test('zip export holds the library, PDFs and embeddings, without secrets or caches', async () => {
  const root = makeDataDir()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-out-'))
  try {
    const dest = path.join(out, 'lib.zip')
    const res = await exportData(root, dest, { format: 'zip' })
    assert.equal(res.bytes, fs.statSync(dest).size)
    const files = readZip(fs.readFileSync(dest))
    assert.equal(res.files, files.size)
    checkContents(files, root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('includeModels adds the cached embedding model', async () => {
  const root = makeDataDir()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-out-'))
  try {
    const dest = path.join(out, 'lib.zip')
    await exportData(root, dest, { format: 'zip', includeModels: true })
    assert.equal(readZip(fs.readFileSync(dest)).get(`${ARCHIVE_ROOT}/models/model.onnx`)?.toString(), 'weights')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

const hasTar = spawnSync('tar', ['--version']).status === 0

for (const format of ['tar', 'tar.gz'] as const) {
  test(`${format} export extracts with the system tar`, { skip: !hasTar && 'tar not installed' }, async () => {
    const root = makeDataDir()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-out-'))
    try {
      const dest = path.join(out, `lib.${format}`)
      await exportData(root, dest, { format })
      const x = path.join(out, 'x')
      fs.mkdirSync(x)
      const r = spawnSync('tar', [format === 'tar.gz' ? '-xzf' : '-xf', dest, '-C', x], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      const files = new Map<string, Buffer>()
      const walk = (dir: string, rel: string) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const relName = rel ? `${rel}/${d.name}` : d.name
          if (d.isDirectory()) walk(path.join(dir, d.name), relName)
          else files.set(relName, fs.readFileSync(path.join(dir, d.name)))
        }
      }
      walk(x, '')
      checkContents(files, root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
}

// ---- import -----------------------------------------------------------------

import { extractArchive, importPath } from '../src/main/archive'
import { Store } from '../src/main/store'
import type { Paper } from '../src/shared/types'

const paper = (id: string, lineIds: string[], status: Paper['status'] = 'indexed'): Paper => ({
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
  addedAt: '2026-01-01T00:00:00.000Z',
  lineIds,
  status
})

const line = (id: string) => ({ id, name: id, keywords: ['k'], matchMode: 'all' as const, categories: [], sortBy: 'relevance' as const, createdAt: '2026-01-01' })

/** A real library written through Store: lines A (papers 1, 2) and B (paper 2), with files and a chat. */
function makeLibrary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betaxiv-src-'))
  const lib = {
    version: 1,
    lines: [line('A'), line('B')],
    papers: { '1': paper('1', ['A']), 'hep-th/9901001': paper('hep-th/9901001', ['A', 'B']) },
    dismissed: { A: ['gone'] }
  }
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify(lib))
  const store = new Store(root)
  for (const id of ['1', 'hep-th/9901001']) {
    fs.mkdirSync(store.paperDir(id), { recursive: true })
    fs.writeFileSync(path.join(store.paperDir(id), 'paper.pdf'), `pdf ${id}`)
    fs.writeFileSync(path.join(store.paperDir(id), 'embeddings.bin'), Buffer.from([1, 2, 3, 4]))
  }
  store.appendChat('A', { id: 'm1', role: 'user', content: 'q', createdAt: '2026-01-02' })
  return root
}

const tmpDirs: string[] = []
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

for (const format of ['zip', 'tar.gz', 'tar'] as const) {
  test(`${format} export imports into an empty library`, async () => {
    const src = makeLibrary()
    tmpDirs.push(src)
    const out = tmp('betaxiv-out-')
    const file = path.join(out, `lib.${format}`)
    await exportData(src, file, { format })

    const dest = tmp('betaxiv-dest-')
    const store = new Store(dest)
    const unpacked = path.join(dest, 'import-x.tmp')
    await extractArchive(file, unpacked)
    assert.deepEqual(store.importFrom(unpacked), { lines: 2, papers: 2, linked: 0, updated: 0 })

    const reloaded = new Store(dest)
    assert.deepEqual(reloaded.listLines().map((l) => l.id).sort(), ['A', 'B'])
    assert.deepEqual(reloaded.getPaper('hep-th/9901001').lineIds, ['A', 'B'])
    assert.equal(fs.readFileSync(path.join(reloaded.paperDir('hep-th/9901001'), 'paper.pdf'), 'utf8'), 'pdf hep-th/9901001')
    assert.deepEqual([...fs.readFileSync(path.join(reloaded.paperDir('1'), 'embeddings.bin'))], [1, 2, 3, 4])
    assert.equal(reloaded.chatHistory('A')[0].id, 'm1')
    assert.ok(reloaded.isDismissed('gone', 'A'))
  })
}

test('import merges into an existing library without losing anything', () => {
  const src = makeLibrary()
  tmpDirs.push(src)
  const dest = tmp('betaxiv-dest-')
  fs.writeFileSync(
    path.join(dest, 'library.json'),
    JSON.stringify({
      version: 1,
      lines: [{ ...line('A'), name: 'mine' }, line('C')],
      // Paper 1 is here but not indexed yet; the other one is indexed here, in line C only.
      papers: { '1': paper('1', ['A'], 'pending'), 'hep-th/9901001': paper('hep-th/9901001', ['C']) }
    })
  )
  const store = new Store(dest)
  fs.mkdirSync(store.paperDir('hep-th/9901001'), { recursive: true })
  fs.writeFileSync(path.join(store.paperDir('hep-th/9901001'), 'paper.pdf'), 'my copy')
  store.appendChat('A', { id: 'm0', role: 'user', content: 'mine', createdAt: '2026-01-01' })

  assert.deepEqual(store.importFrom(src), { lines: 1, papers: 0, linked: 1, updated: 1 })
  assert.equal(store.getLine('A').name, 'mine')
  assert.deepEqual(store.listLines().map((l) => l.id).sort(), ['A', 'B', 'C'])
  assert.equal(store.getPaper('1').status, 'indexed')
  assert.equal(fs.readFileSync(path.join(store.paperDir('1'), 'paper.pdf'), 'utf8'), 'pdf 1')
  assert.deepEqual(store.getPaper('hep-th/9901001').lineIds, ['C', 'A', 'B'])
  assert.equal(fs.readFileSync(path.join(store.paperDir('hep-th/9901001'), 'paper.pdf'), 'utf8'), 'my copy')
  assert.deepEqual(store.chatHistory('A').map((m) => m.id), ['m0', 'm1'])
})

test('import ignores paper ids that would escape the papers folder', () => {
  const src = tmp('betaxiv-evil-')
  fs.writeFileSync(
    path.join(src, 'library.json'),
    JSON.stringify({ version: 1, lines: [line('A')], papers: { '..': paper('..', ['A']), '../x': paper('../x', ['A']) } })
  )
  const dest = tmp('betaxiv-dest-')
  const store = new Store(dest)
  assert.equal(store.importFrom(src).papers, 1) // '../x' becomes the harmless folder '.._x'
  assert.ok(!store.hasPaper('..'))
  assert.equal(store.paperDir('../x'), path.join(dest, 'papers', '.._x'))
})

test('importPath keeps only plain paths inside betaxiv-data', () => {
  assert.equal(importPath('betaxiv-data/papers/1/paper.pdf'), 'papers/1/paper.pdf')
  for (const bad of [
    'betaxiv-data/../x',
    'betaxiv-data/papers/../../x',
    'betaxiv-data//etc/passwd',
    '/betaxiv-data/library.json',
    'other/library.json',
    'betaxiv-data/settings.json',
    'betaxiv-data/manifest.json',
    'betaxiv-data/claude/x.json',
    'betaxiv-data/papers/1\\..\\x'
  ]) {
    assert.equal(importPath(bad), null, bad)
  }
})

test('extractArchive reads archives made by other tools and skips unsafe entries', { skip: !hasTar && 'tar not installed' }, async () => {
  const work = tmp('betaxiv-tools-')
  const d = path.join(work, 'betaxiv-data')
  const deep = `papers/${'x'.repeat(120)}`
  fs.mkdirSync(path.join(d, deep), { recursive: true })
  fs.writeFileSync(path.join(d, 'library.json'), '{}')
  fs.writeFileSync(path.join(d, deep, 'paper.md'), 'long name')
  // GNU tar writes directory entries and GNU long-name headers.
  const tgz = path.join(work, 'x.tgz')
  let r = spawnSync('tar', ['-czf', tgz, '-C', work, 'betaxiv-data'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = path.join(work, 'out')
  await extractArchive(tgz, out)
  assert.equal(fs.readFileSync(path.join(out, deep, 'paper.md'), 'utf8'), 'long name')

  const hasPython = spawnSync('python3', ['--version']).status === 0
  if (hasPython) {
    // Hand-made archives with entries that try to escape the destination.
    const evilTar = path.join(work, 'evil.tar')
    const evilZip = path.join(work, 'evil.zip')
    r = spawnSync('python3', ['-c', `
import io, sys, tarfile, zipfile
names = ['betaxiv-data/library.json', 'betaxiv-data/../../evil.txt', 'betaxiv-data/papers/../../evil.txt', '/evil.txt']
with tarfile.open(sys.argv[1], 'w', format=tarfile.PAX_FORMAT) as t:
    for n in names:
        i = tarfile.TarInfo(n); i.size = 2; t.addfile(i, io.BytesIO(b'{}'))
    link = tarfile.TarInfo('betaxiv-data/papers/l'); link.type = tarfile.SYMTYPE; link.linkname = '/etc'; t.addfile(link)
with zipfile.ZipFile(sys.argv[2], 'w') as z:
    for n in names: z.writestr(n, '{}')
`, evilTar, evilZip], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    for (const f of [evilTar, evilZip]) {
      const o = path.join(work, `o-${path.basename(f)}`, 'a', 'b')
      await extractArchive(f, o)
      const found: string[] = []
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(dir, e.name))
          else found.push(path.relative(work, path.join(dir, e.name)))
        }
      }
      walk(path.join(work, `o-${path.basename(f)}`))
      assert.deepEqual(found, [path.join(`o-${path.basename(f)}`, 'a', 'b', 'library.json')])
    }

    const zip = path.join(work, 'x.zip')
    r = spawnSync('python3', ['-c', `import shutil; shutil.make_archive(${JSON.stringify(zip.slice(0, -4))}, 'zip', ${JSON.stringify(work)}, 'betaxiv-data')`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out2 = path.join(work, 'out2')
    await extractArchive(zip, out2)
    assert.equal(fs.readFileSync(path.join(out2, deep, 'paper.md'), 'utf8'), 'long name')
  }
})

test('extractArchive rejects files that aren\'t betaxiv exports', async () => {
  const work = tmp('betaxiv-bad-')
  fs.writeFileSync(path.join(work, 'x.zip'), 'hello')
  await assert.rejects(extractArchive(path.join(work, 'x.zip'), path.join(work, 'o')), /Not a zip/)
  const other = path.join(work, 'other')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'a.txt'), 'a')
  const tar = path.join(work, 'x.tar')
  if (hasTar) {
    spawnSync('tar', ['-cf', tar, '-C', work, 'other'])
    await assert.rejects(extractArchive(tar, path.join(work, 'o2')), /no betaxiv library/)
  }
})
