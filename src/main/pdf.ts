import { findArxivIdInText, USER_AGENT } from './arxiv'
import { cleanText, pageItemsToText, stripReferences, type PositionedText } from './textproc'

export async function downloadPdf(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal })
  if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  // arXiv serves an HTML page when a PDF isn't available yet (e.g. still being generated).
  const magic = new TextDecoder().decode(buf.slice(0, 5))
  if (magic !== '%PDF-') throw new Error('Downloaded file is not a PDF (full text may not be available yet)')
  return buf
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | null = null
// pdfjs-dist is ESM-only; load it lazily from the CommonJS main bundle.
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

/** Extract the full text of a PDF as cleaned, paragraph-separated markdown-ish text. */
export async function pdfToText(data: Uint8Array, opts: { stripReferences: boolean }): Promise<string> {
  const pdfjs = await loadPdfJs()
  const doc = await pdfjs.getDocument({
    // pdfjs transfers (detaches) the buffer, so hand it a copy.
    data: data.slice(),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  }).promise
  try {
    const pages: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const items: PositionedText[] = []
      for (const it of content.items) {
        if (!('str' in it)) continue
        items.push({ str: it.str, y: it.transform[5], height: it.height, hasEOL: it.hasEOL })
      }
      pages.push(pageItemsToText(items))
      page.cleanup()
    }
    let text = cleanText(pages.join('\n\n'))
    if (opts.stripReferences) text = stripReferences(text)
    return text
  } finally {
    await doc.destroy()
  }
}

export interface PdfInfo {
  title: string
  authors: string[]
  arxivId: string | null
}

// Title metadata that's really a file or tool name rather than the paper's title.
const JUNK_TITLE = /(\.(pdf|dvi|tex|docx?)$)|^(untitled|microsoft word|arxiv)|^[\w-]+$/i

/** Guess a PDF's title and authors (document metadata, else the biggest text on page 1) and spot an arXiv stamp. */
export async function inspectPdf(data: Uint8Array): Promise<PdfInfo> {
  const pdfjs = await loadPdfJs()
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string }
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((it): it is Extract<typeof it, { str: string }> => 'str' in it && !!it.str.trim())
    const firstPage = items.map((it) => it.str).join(' ')
    page.cleanup()

    let title = String(info.Title ?? '').replace(/\s+/g, ' ').trim()
    if (!title || title.length < 6 || JUNK_TITLE.test(title)) {
      // The title is usually set in the largest font near the top of the first page.
      // Skip rotated text such as the arXiv stamp in the left margin.
      const upright = items.filter((it) => it.transform[1] === 0 && it.transform[2] === 0 && !/^arXiv:/.test(it.str.trim()))
      const maxH = Math.max(0, ...upright.map((it) => it.height))
      title = upright
        .filter((it) => it.height >= maxH * 0.95)
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300)
    }
    const authors = String(info.Author ?? '')
      .split(/\s*(?:;|,|\band\b)\s*/)
      .map((a) => a.trim())
      .filter((a) => a.length > 1)
    return { title, authors, arxivId: findArxivIdInText(firstPage) }
  } finally {
    await doc.destroy()
  }
}
