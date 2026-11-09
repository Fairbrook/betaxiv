// pdf.js for the built-in reader. Importing 'pdfjs-dist' registers `globalThis.pdfjsLib`, which
// the viewer module reads when it loads, so the viewer is imported afterwards.
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs')

let viewer: Promise<PdfViewerModule> | null = null
export const loadViewer = () => (viewer ??= import('pdfjs-dist/web/pdf_viewer.mjs'))

/** Font, CMap and colour-profile data is served by the main process (see `betaxiv://pdfjs`). */
export const DATA_URLS = {
  cMapUrl: 'betaxiv://pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'betaxiv://pdfjs/standard_fonts/',
  wasmUrl: 'betaxiv://pdfjs/wasm/',
  iccUrl: 'betaxiv://pdfjs/iccs/'
}

export { pdfjsLib }
