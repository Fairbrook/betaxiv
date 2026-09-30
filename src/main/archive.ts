import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ExportFormat, ExportOptions, ExportResult } from '../shared/types'

const deflateRaw = promisify(zlib.deflateRaw)

/** Top-level folder inside the archive; its layout mirrors the data folder. */
export const ARCHIVE_ROOT = 'betaxiv-data'

interface Entry {
  /** Path inside the archive, with forward slashes. */
  name: string
  mtime: Date
  /** A file on disk, or generated content. */
  file?: string
  data?: Buffer
  size: number
}

export const archiveExtension = (format: ExportFormat): string => (format === 'zip' ? 'zip' : format)

/**
 * Collect everything worth keeping from the data folder: library.json, chats and each paper's
 * PDF, extracted text, chunks and embeddings. Skips the Claude working folder, temp files and
 * (unless asked) the cached embedding model. settings.json is rewritten without its secrets:
 * they're encrypted with this machine's keychain, so they'd be useless (or, unencrypted, a leak).
 */
export function collectEntries(root: string, opts: ExportOptions, exclude: string[] = []): Entry[] {
  const skipDirs = new Set(['claude', ...(opts.includeModels ? [] : ['models'])])
  const skipFiles = new Set(exclude.map((f) => path.resolve(f)))
  const entries: Entry[] = []

  const walk = (dir: string, rel: string) => {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, d.name)
      const relName = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        // *.tmp folders are imports being unpacked.
        if (!rel && (skipDirs.has(d.name) || d.name.endsWith('.tmp'))) continue
        walk(abs, relName)
      } else if (d.isFile()) {
        if (d.name.endsWith('.tmp') || skipFiles.has(path.resolve(abs))) continue
        if (!rel && d.name === 'settings.json') continue
        try {
          const st = fs.statSync(abs)
          entries.push({ name: `${ARCHIVE_ROOT}/${relName}`, file: abs, size: st.size, mtime: st.mtime })
        } catch {
          // Removed while we were walking (e.g. a paper was deleted): leave it out.
        }
      }
    }
  }
  walk(root, '')

  const now = new Date()
  const add = (name: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value, null, 2))
    entries.unshift({ name: `${ARCHIVE_ROOT}/${name}`, data, size: data.length, mtime: now })
  }
  const settingsFile = path.join(root, 'settings.json')
  if (fs.existsSync(settingsFile)) {
    try {
      const { secrets: _s, plainSecrets: _p, ...rest } = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      add('settings.json', rest)
    } catch {
      // Unreadable settings aren't worth failing the export over.
    }
  }
  add('manifest.json', {
    format: 'betaxiv-export',
    version: 1,
    exportedAt: now.toISOString(),
    ...libraryCounts(root),
    includesModels: !!opts.includeModels,
    note: `Extract and point BETAXIV_DATA_DIR at the ${ARCHIVE_ROOT} folder, or copy its contents into the app's data folder.`
  })
  return entries
}

function libraryCounts(root: string): { lines: number; papers: number } {
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8'))
    return { lines: lib.lines?.length ?? 0, papers: Object.keys(lib.papers ?? {}).length }
  } catch {
    return { lines: 0, papers: 0 }
  }
}

/** Write the data folder to `dest` as a zip, tar.gz or tar. The file only appears once complete. */
export async function exportData(root: string, dest: string, opts: ExportOptions): Promise<ExportResult> {
  const tmp = `${dest}.${process.pid}.tmp`
  const entries = collectEntries(root, opts, [dest])
  const source = Readable.from(opts.format === 'zip' ? zipStream(entries) : tarStream(entries))
  try {
    if (opts.format === 'tar.gz') await pipeline(source, zlib.createGzip(), fs.createWriteStream(tmp))
    else await pipeline(source, fs.createWriteStream(tmp))
    fs.renameSync(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  return { path: dest, files: entries.length, bytes: fs.statSync(dest).size }
}

// ---- tar (POSIX ustar, with pax headers for long names) -------------------

function tarHeader(name: string, size: number, mtime: Date, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(512)
  const octal = (value: number, offset: number, len: number) => h.write(value.toString(8).padStart(len - 1, '0') + '\0', offset, len, 'ascii')
  h.write(name, 0, 100, 'utf8')
  octal(0o644, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(Math.floor(mtime.getTime() / 1000), 136, 12)
  h.write('        ', 148, 8, 'ascii')
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  // The length prefix counts itself, so grow it until it's stable.
  let len = Buffer.byteLength(body)
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return Buffer.from(`${len}${body}`)
}

const padding = (size: number) => Buffer.alloc((512 - (size % 512)) % 512)

async function* entryContent(e: Entry): AsyncGenerator<Buffer> {
  if (e.data) {
    yield e.data
    return
  }
  // Stream files so large PDFs never sit in memory; stop at the size we already announced.
  let sent = 0
  for await (const chunk of fs.createReadStream(e.file!)) {
    const buf = chunk as Buffer
    const take = buf.subarray(0, Math.max(0, e.size - sent))
    sent += take.length
    if (take.length) yield take
    if (sent >= e.size) break
  }
  if (sent < e.size) throw new Error(`${e.name} changed while exporting; try again`)
}

async function* tarStream(entries: Entry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    let name = e.name
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord('path', name)
      yield tarHeader('PaxHeader', pax.length, e.mtime, 'x')
      yield pax
      yield padding(pax.length)
      name = name.slice(0, 100)
    }
    yield tarHeader(name, e.size, e.mtime, '0')
    yield* entryContent(e)
    yield padding(e.size)
  }
  yield Buffer.alloc(1024)
}

// ---- zip ------------------------------------------------------------------

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

const MAX32 = 0xffffffff

async function* zipStream(entries: Entry[]): AsyncGenerator<Buffer> {
  if (entries.length > 0xffff) throw new Error('Too many files for a zip archive; export as tar.gz instead')
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = e.data ?? fs.readFileSync(e.file!)
    const crc = zlib.crc32(raw)
    const deflated = await deflateRaw(raw)
    // PDFs and embeddings barely compress; store them as-is when deflate doesn't help.
    const stored = deflated.length >= raw.length
    const body = stored ? raw : deflated
    if (offset + body.length + 1024 > MAX32 || raw.length > MAX32) {
      throw new Error('The library is larger than 4 GB, which zip can’t hold; export as tar.gz instead')
    }
    const name = Buffer.from(e.name, 'utf8')
    const { time, date } = dosDateTime(e.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix, so the permissions below apply
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(stored ? 0 : 8, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // regular file, rw-r--r--
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    yield local
    yield name
    yield body
    offset += local.length + name.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  yield cdBuf
  yield end
}

// ---- import ---------------------------------------------------------------

/**
 * Unpack a betaxiv export (zip, tar.gz or tar, detected from its first bytes) into `destDir`.
 * Only files under betaxiv-data/ with plain relative paths are written; settings.json, the
 * manifest and anything that would land outside `destDir` are skipped.
 */
export async function extractArchive(file: string, destDir: string): Promise<number> {
  const head = Buffer.alloc(512)
  const fd = fs.openSync(file, 'r')
  let headLen: number
  try {
    headLen = fs.readSync(fd, head, 0, 512, 0)
  } finally {
    fs.closeSync(fd)
  }
  fs.mkdirSync(destDir, { recursive: true })
  let written = 0
  const write = (name: string, data: Buffer | Iterable<Buffer>) => {
    const rel = importPath(name)
    if (!rel) return
    const target = path.join(destDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.isBuffer(data) ? data : Buffer.concat([...data]))
    written++
  }
  if (head.readUInt32LE(0) === 0x04034b50) readZip(file, write)
  else if (head[0] === 0x1f && head[1] === 0x8b) await readTar(fs.createReadStream(file).pipe(zlib.createGunzip()), write)
  else if (headLen === 512 && head.toString('ascii', 257, 262) === 'ustar') await readTar(fs.createReadStream(file), write)
  else throw new Error('Not a zip, tar.gz or tar archive')
  if (!fs.existsSync(path.join(destDir, 'library.json'))) {
    throw new Error('This archive has no betaxiv library in it (betaxiv-data/library.json is missing)')
  }
  return written
}

const SEGMENT = /^[A-Za-z0-9._-]+$/

/** Map an archive entry to a safe path relative to the data folder, or null to skip it. */
export function importPath(name: string): string | null {
  const prefix = `${ARCHIVE_ROOT}/`
  if (!name.startsWith(prefix)) return null
  const rel = name.slice(prefix.length)
  const parts = rel.split('/')
  if (parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) return null
  if (parts.length === 1 && (rel === 'settings.json' || rel === 'manifest.json')) return null
  if (parts[0] === 'claude' || parts[parts.length - 1].endsWith('.tmp')) return null
  return rel
}

function readZip(file: string, write: (name: string, data: Buffer) => void) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, pos)
      return b
    }
    const tailLen = Math.min(size, 0xffff + 22)
    const tail = read(size - tailLen, tailLen)
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (at < 0) throw new Error('Damaged zip archive (no central directory)')
    const count = tail.readUInt16LE(at + 10)
    const cdSize = tail.readUInt32LE(at + 12)
    const cdOffset = tail.readUInt32LE(at + 16)
    if (count === 0xffff || cdOffset === MAX32) throw new Error('Zip64 archives aren’t supported; export as tar.gz instead')
    const cd = read(cdOffset, cdSize)
    let p = 0
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip archive')
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const csize = cd.readUInt32LE(p + 20)
      const nameLen = cd.readUInt16LE(p + 28)
      const skip = nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
      const offset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      p += 46 + skip
      if (name.endsWith('/') || !importPath(name)) continue
      const local = read(offset, 30)
      const body = read(offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), csize)
      let data: Buffer
      if (method === 0) data = body
      else if (method === 8) data = zlib.inflateRawSync(body)
      else throw new Error(`${name} uses an unsupported zip compression method`)
      if (zlib.crc32(data) !== crc) throw new Error(`${name} is damaged (checksum mismatch)`)
      write(name, data)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Streaming tar reader: ustar, pax ('x') and GNU long-name ('L') headers; only regular files are kept. */
async function readTar(stream: AsyncIterable<Buffer | string>, write: (name: string, data: Buffer[]) => void) {
  let buf = Buffer.alloc(0)
  let longName: string | null = null
  // Current entry: remaining body bytes, padding to skip and where its data goes.
  let body: { remaining: number; pad: number; kind: 'file' | 'meta' | 'skip'; type: string; name: string; parts: Buffer[] } | null = null

  const finish = (e: NonNullable<typeof body>) => {
    if (e.kind === 'file') write(e.name, e.parts)
    else if (e.kind === 'meta') {
      const text = Buffer.concat(e.parts).toString('utf8')
      if (e.type === 'L') longName = text.replace(/\0.*$/s, '')
      else {
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
        if (m) longName = m[1]
      }
    }
  }

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk)
    for (;;) {
      if (body) {
        const take = Math.min(body.remaining, buf.length)
        if (body.kind !== 'skip' && take) body.parts.push(Buffer.from(buf.subarray(0, take)))
        body.remaining -= take
        buf = buf.subarray(take)
        if (body.remaining > 0) break
        if (buf.length < body.pad) break
        buf = buf.subarray(body.pad)
        finish(body)
        body = null
        continue
      }
      if (buf.length < 512) break
      const h = buf.subarray(0, 512)
      buf = buf.subarray(512)
      if (h.every((b) => b === 0)) continue // end-of-archive blocks
      const str = (o: number, l: number) => h.toString('utf8', o, o + l).replace(/\0.*$/s, '')
      const size = parseInt(str(124, 12).trim() || '0', 8)
      if (!Number.isFinite(size)) throw new Error('Damaged tar archive')
      const type = String.fromCharCode(h[156]) || '0'
      const prefix = h.toString('ascii', 257, 262) === 'ustar' ? str(345, 155) : ''
      let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)
      let kind: 'file' | 'meta' | 'skip' = 'skip'
      if (type === 'x' || type === 'L') kind = 'meta'
      else {
        if (longName !== null) name = longName
        longName = null
        if ((type === '0' || type === '\0') && importPath(name)) kind = 'file'
      }
      body = { remaining: size, pad: (512 - (size % 512)) % 512, kind, type, name, parts: [] }
      if (size === 0) {
        finish(body)
        body = null
      }
    }
  }
  if (body) throw new Error('The tar archive ends early; it may be incomplete')
}
