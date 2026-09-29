import { XMLParser } from 'fast-xml-parser'
import type { NewLineInput, Paper } from '../shared/types'

const API_URL = 'https://export.arxiv.org/api/query'
// arXiv asks API clients to wait ~3 seconds between consecutive requests.
export const ARXIV_DELAY_MS = 3000
export const USER_AGENT = 'betaxiv/0.1 (desktop research assistant)'

export type ArxivEntry = Omit<Paper, 'addedAt' | 'lineIds' | 'status'>

export interface ArxivPage {
  total: number
  entries: ArxivEntry[]
}

const FIELD_PREFIX = /^(ti|au|abs|co|jr|cat|rn|id|all):/i

/** Turn a single user keyword into an arXiv query term. */
function keywordTerm(raw: string): string | null {
  const kw = raw.trim()
  if (!kw) return null
  // Advanced users can type field-prefixed terms (ti:transformer, au:"Hinton") verbatim.
  if (FIELD_PREFIX.test(kw)) return kw
  const clean = kw.replace(/"/g, '')
  return /\s/.test(clean) ? `all:"${clean}"` : `all:${clean}`
}

/** Build the arXiv `search_query` string for a research line. */
export function buildSearchQuery(line: Pick<NewLineInput, 'keywords' | 'matchMode' | 'categories'>): string {
  const terms = line.keywords.map(keywordTerm).filter((t): t is string => !!t)
  if (terms.length === 0) throw new Error('A research line needs at least one keyword')
  const joiner = line.matchMode === 'any' ? ' OR ' : ' AND '
  let query = terms.length > 1 ? `(${terms.join(joiner)})` : terms[0]
  const cats = line.categories.map((c) => c.trim()).filter(Boolean)
  if (cats.length) {
    const catQuery = cats.map((c) => `cat:${c}`).join(' OR ')
    query += ` AND (${catQuery})`
  }
  return query
}

/** Split an arXiv abs URL / id into its version-less id and version. */
export function splitArxivId(raw: string): { id: string; version: string } {
  const tail = raw.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '').replace(/\.pdf$/i, '').trim()
  const m = tail.match(/^(.*?)(v(\d+))?$/)
  const id = m?.[1] ?? tail
  return { id, version: m?.[2] ?? 'v1' }
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const squash = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim()

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
})

/** Parse an arXiv Atom API response. */
export function parseAtom(xml: string): ArxivPage {
  const doc = parser.parse(xml)
  const feed = doc.feed ?? {}
  const total = Number(feed.totalResults ?? 0) || 0
  const entries: ArxivEntry[] = []
  for (const e of asArray<any>(feed.entry)) {
    // The API returns a single pseudo-entry titled "Error" for malformed queries.
    if (typeof e.id === 'string' && e.id.includes('/api/errors')) {
      throw new Error(`arXiv API error: ${squash(e.summary)}`)
    }
    const { id, version } = splitArxivId(String(e.id ?? ''))
    if (!id) continue
    const links = asArray<any>(e.link)
    const pdfLink = links.find((l) => l['@_title'] === 'pdf' || l['@_type'] === 'application/pdf')
    entries.push({
      id,
      version,
      title: squash(e.title),
      authors: asArray<any>(e.author).map((a) => squash(a.name)).filter(Boolean),
      abstract: squash(e.summary),
      published: String(e.published ?? ''),
      updated: String(e.updated ?? ''),
      categories: asArray<any>(e.category).map((c) => String(c['@_term'])).filter(Boolean),
      primaryCategory: e.primary_category?.['@_term'],
      absUrl: `https://arxiv.org/abs/${id}`,
      pdfUrl: pdfLink?.['@_href']?.replace(/^http:/, 'https:') ?? `https://arxiv.org/pdf/${id}`
    })
  }
  return { total, entries }
}

export async function searchArxiv(
  query: string,
  start: number,
  maxResults: number,
  sortBy: string,
  signal?: AbortSignal
): Promise<ArxivPage> {
  const params = new URLSearchParams({
    search_query: query,
    start: String(start),
    max_results: String(maxResults),
    sortBy,
    sortOrder: 'descending'
  })
  const res = await fetch(`${API_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal })
  if (!res.ok) throw new Error(`arXiv API returned HTTP ${res.status}`)
  return parseAtom(await res.text())
}

// New-style ids (2401.01234, 0704.0001) and old-style ones (hep-th/9901001, math.GT/0309136).
const NEW_ID = /(\d{4}\.\d{4,5})(v\d+)?/
const OLD_ID = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/

/**
 * Pull an arXiv id out of whatever the user pasted: a bare id, "arXiv:2401.01234v2",
 * or an abs/pdf/html link on arxiv.org (or a mirror such as alphaxiv.org).
 */
export function parseArxivRef(raw: string): { id: string; version?: string } | null {
  const s = raw.trim().replace(/^arxiv:\s*/i, '')
  if (!s) return null
  let text = s
  if (/^https?:\/\//i.test(s)) {
    // In a URL, only look at the path so query strings can't masquerade as ids.
    try {
      text = new URL(s).pathname.replace(/^\/(abs|pdf|html|overview)\//, '').replace(/\.pdf$/i, '').replace(/\/$/, '')
    } catch {
      return null
    }
  }
  const anchored = (re: RegExp) => new RegExp(`^${re.source}$`)
  const m = text.match(anchored(NEW_ID)) ?? text.match(anchored(OLD_ID))
  if (!m) return null
  return m[2] ? { id: m[1], version: m[2] } : { id: m[1] }
}

/** Find the arXiv id stamped on a paper's first page ("arXiv:2401.01234v2 [cs.CL] 5 Jan 2024"). */
export function findArxivIdInText(text: string): string | null {
  const m = text.match(new RegExp(`arXiv:\\s*(?:${NEW_ID.source}|${OLD_ID.source})`))
  return m ? (m[1] ?? m[3]) : null
}

/** Look up one paper's metadata by id. */
export async function fetchArxivEntry(id: string, signal?: AbortSignal): Promise<ArxivEntry> {
  const params = new URLSearchParams({ id_list: id, max_results: '1' })
  const res = await fetch(`${API_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal })
  if (!res.ok) throw new Error(`arXiv API returned HTTP ${res.status}`)
  const entry = parseAtom(await res.text()).entries.find((e) => e.id === id)
  // Unknown ids come back as an empty entry without a title.
  if (!entry || !entry.title) throw new Error(`arXiv has no paper with id ${id}`)
  return entry
}
