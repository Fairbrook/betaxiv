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
