// Cheap per-paper entity map: one LLM call per paper over the title, abstract and
// introduction (instead of MiniRAG/LightRAG-style extraction over every chunk),
// merged across a research line into a browsable map of methods, datasets, etc.

import type { EntityRole, EntityType, LineEntity, Paper, PaperEntity } from '../shared/types'

export const ENTITY_TYPES: EntityType[] = ['task', 'method', 'model', 'dataset', 'metric', 'concept']
const ROLES: EntityRole[] = ['proposes', 'uses', 'evaluates-on', 'compares-to', 'discusses']

export const ENTITY_SYSTEM_PROMPT = `You extract a compact entity map from the opening of a research paper.
Return ONLY a JSON object, no prose and no code fences, with this shape:
{
  "tldr": "one sentence (max 30 words) stating what the paper contributes",
  "entities": [
    { "name": "canonical name", "type": "task|method|model|dataset|metric|concept", "role": "proposes|uses|evaluates-on|compares-to|discusses" }
  ]
}
Rules:
- 5 to 20 entities, only ones that matter for understanding or comparing the paper.
- "method" = techniques/algorithms/architectures; "model" = specific named models (e.g. GPT-4, Llama 3); "dataset" = datasets and benchmarks; "metric" = evaluation metrics; "task" = problems addressed; "concept" = other key ideas.
- Use the widely known canonical name; add the acronym in parentheses if the paper uses one, e.g. "Retrieval-Augmented Generation (RAG)".
- role is the paper's relation to the entity: "proposes" only for the paper's own new contributions (give them the name the paper uses), "evaluates-on" for datasets/benchmarks/metrics used for evaluation, "compares-to" for baselines.`

const MAX_INTRO_WORDS = 1800

/** The part of the paper the extraction looks at: everything up to ~the end of the introduction. */
export function entityPromptInput(paper: Pick<Paper, 'title' | 'abstract'>, fullText: string): string {
  let body = fullText
  // Stop at the section after the introduction when we can spot it.
  const m = body.match(/\n\n(?:2\.?|II\.?)\s+[A-Z][^\n]{2,80}\n\n/)
  if (m?.index && m.index > 500) body = body.slice(0, m.index)
  const words = body.split(/\s+/)
  if (words.length > MAX_INTRO_WORDS) body = words.slice(0, MAX_INTRO_WORDS).join(' ')
  return `Title: ${paper.title}\n\nAbstract: ${paper.abstract}\n\nOpening of the paper:\n${body}`
}

/** Parse and validate the model's JSON reply (tolerates code fences and surrounding prose). */
export function parseEntityReply(reply: string): { tldr: string; entities: PaperEntity[] } {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Entity extraction returned no JSON')
  const raw = JSON.parse(reply.slice(start, end + 1))
  const seen = new Set<string>()
  const entities: PaperEntity[] = []
  for (const e of Array.isArray(raw.entities) ? raw.entities : []) {
    const name = String(e?.name ?? '').replace(/\s+/g, ' ').trim()
    if (!name || name.length > 120) continue
    const type = ENTITY_TYPES.includes(e.type) ? (e.type as EntityType) : 'concept'
    const role = ROLES.includes(e.role) ? (e.role as EntityRole) : 'discusses'
    const key = entityKeys(name)[0]
    if (seen.has(key)) continue
    seen.add(key)
    entities.push({ name, type, role })
  }
  return { tldr: String(raw.tldr ?? '').trim(), entities: entities.slice(0, 25) }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

/**
 * Keys an entity name can be matched by: the full name, and for "Long Name (ACR)"
 * both the long name and the acronym. So "RAG" and "Retrieval-Augmented Generation (RAG)" merge.
 */
export function entityKeys(name: string): string[] {
  const keys = [norm(name)]
  const m = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/)
  if (m) {
    keys.push(norm(m[1]))
    // Short acronyms are ambiguous across types, so they only merge within a type (see buildLineMap).
    keys.push(norm(m[2]))
  }
  return [...new Set(keys.filter(Boolean))]
}

/** Merge the entity lists of a line's papers into one map, most-shared entities first. */
export function buildLineMap(papers: Pick<Paper, 'id' | 'entities'>[]): LineEntity[] {
  const byKey = new Map<string, LineEntity>()
  const all: LineEntity[] = []
  for (const p of papers) {
    for (const e of p.entities ?? []) {
      const keys = entityKeys(e.name).map((k) => `${e.type}:${k}`)
      let target = keys.map((k) => byKey.get(k)).find(Boolean)
      if (!target) {
        target = { key: keys[0], name: e.name, type: e.type, papers: [] }
        all.push(target)
      } else if (e.name.length > target.name.length && /\(/.test(e.name)) {
        // Prefer the more descriptive "Long Name (ACR)" form for display.
        target.name = e.name
      }
      for (const k of keys) byKey.set(k, target)
      if (!target.papers.some((x) => x.paperId === p.id)) target.papers.push({ paperId: p.id, role: e.role })
    }
  }
  return all.sort((a, b) => b.papers.length - a.papers.length || a.name.localeCompare(b.name))
}

/** Compact overview of the papers in scope, given to the answering model alongside the excerpts. */
export function collectionOverview(papers: Pick<Paper, 'id' | 'title' | 'tldr' | 'entities'>[], max = 40): string {
  return papers
    .slice(0, max)
    .map((p) => {
      const ents = (p.entities ?? [])
        .filter((e) => e.role !== 'discusses')
        .map((e) => `${e.name} [${e.type}, ${e.role}]`)
        .join('; ')
      return `- arXiv:${p.id} "${p.title}"${p.tldr ? ` — ${p.tldr}` : ''}${ents ? `\n  Entities: ${ents}` : ''}`
    })
    .join('\n')
}
