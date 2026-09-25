import { USER_AGENT } from './arxiv'
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
