// Pure text-processing helpers: turning positioned PDF text into clean prose,
// and splitting it into overlapping chunks for embedding (the alphaxiv-open flow:
// PDF -> markdown -> clean -> chunk(1000, overlap 200) -> embed).

export interface PositionedText {
  str: string
  /** Baseline y (PDF units, grows upwards). */
  y: number
  /** Glyph height. */
  height: number
  hasEOL: boolean
}

/**
 * Rebuild lines and paragraphs from the text items of one PDF page.
 * A vertical gap noticeably larger than the line height starts a new paragraph.
 */
export function pageItemsToText(items: PositionedText[]): string {
  let out = ''
  let lastY: number | null = null
  let lineHeight = 0
  for (const it of items) {
    if (lastY !== null && it.str.length > 0) {
      const dy = Math.abs(lastY - it.y)
      const h = it.height || lineHeight || 10
      if (dy > h * 1.8) out += '\n\n'
      else if (dy > h * 0.5 && !out.endsWith('\n')) out += '\n'
    }
    out += it.str
    if (it.hasEOL && !out.endsWith('\n')) out += '\n'
    if (it.str.length > 0) {
      lastY = it.y
      if (it.height) lineHeight = it.height
    }
  }
  return out
}

/** Normalise extracted text: fix hyphenation, merge wrapped lines, collapse whitespace. */
export function cleanText(raw: string): string {
  const text = raw
    .replace(/\r/g, '')
    .replace(/­/g, '') // soft hyphens
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    // word-\nbreak -> wordbreak (only when the next line continues in lowercase)
    .replace(/([a-z])-\n([a-z])/g, '$1$2')

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    )
    .filter((p) => p.length > 0)
    // Drop lone page numbers and similar debris.
    .filter((p) => !/^\d{1,4}$/.test(p))

  return paragraphs.join('\n\n')
}

const REF_HEADING = /^(?:\d+\.?\s*|[IVX]+\.?\s*)?(references|bibliography|reference)\s*$/i
const APPENDIX_HEADING = /^(?:[A-Z]\.?\s+|\d+\.?\s*)?(appendix|appendices|supplementary material)\b/i

/**
 * Remove the bibliography: it's mostly citation strings that pollute keyword and
 * vector retrieval. Keeps any appendix that follows the references.
 */
export function stripReferences(text: string): string {
  const paras = text.split('\n\n')
  let refIdx = -1
  for (let i = paras.length - 1; i >= Math.floor(paras.length * 0.3); i--) {
    if (REF_HEADING.test(paras[i].trim())) {
      refIdx = i
      break
    }
  }
  if (refIdx < 0) return text
  let endIdx = paras.length
  for (let i = refIdx + 1; i < paras.length; i++) {
    if (paras[i].length < 120 && APPENDIX_HEADING.test(paras[i].trim())) {
      endIdx = i
      break
    }
  }
  return [...paras.slice(0, refIdx), ...paras.slice(endIdx)].join('\n\n')
}

/** Rough token estimate (~0.75 words per token for English prose). */
export function estimateTokens(s: string): number {
  const words = s.split(/\s+/).filter(Boolean).length
  return Math.ceil(words / 0.75)
}

/**
 * Split text into chunks of ~`size` tokens with ~`overlap` tokens of overlap,
 * preferring paragraph boundaries and falling back to word windows for huge paragraphs.
 */
export function chunkText(text: string, size = 1000, overlap = 200): string[] {
  const maxWords = Math.max(20, Math.floor(size * 0.75))
  const overlapWords = Math.max(0, Math.min(Math.floor(overlap * 0.75), maxWords - 1))

  // Explode paragraphs into word arrays, splitting oversize paragraphs so that a
  // piece plus the carried-over overlap always fits in one chunk.
  const maxUnit = maxWords - overlapWords
  const units: string[][] = []
  for (const p of text.split(/\n\s*\n/)) {
    const words = p.split(/\s+/).filter(Boolean)
    if (!words.length) continue
    for (let i = 0; i < words.length; i += maxUnit) units.push(words.slice(i, i + maxUnit))
  }

  const chunks: string[] = []
  let current: string[][] = []
  let count = 0
  const flush = () => {
    if (!current.length) return
    chunks.push(current.map((u) => u.join(' ')).join('\n\n'))
    // Carry the tail of this chunk into the next one as overlap.
    const tail: string[][] = []
    let kept = 0
    for (let i = current.length - 1; i >= 0 && kept < overlapWords; i--) {
      const u = current[i]
      const take = Math.min(u.length, overlapWords - kept)
      tail.unshift(u.slice(u.length - take))
      kept += take
    }
    current = tail
    count = kept
  }
  for (const u of units) {
    if (count + u.length > maxWords && count > overlapWords) flush()
    current.push(u)
    count += u.length
  }
  if (count > overlapWords || chunks.length === 0) {
    if (current.length) chunks.push(current.map((u) => u.join(' ')).join('\n\n'))
  }
  return chunks
}
