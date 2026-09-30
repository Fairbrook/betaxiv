import { useEffect, useState } from 'react'
import type { EmbeddingProvider, ExportFormat, LlmProvider, Settings } from '@shared/types'
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_ENTITY_MODELS, DEFAULT_LLM_MODELS, RECOMMENDED_CHUNKING } from '@shared/defaults'
import { api } from '../api'
import { cleanError } from './LineView'
import Modal from './Modal'

const LLM_LABELS: Record<LlmProvider, string> = {
  'claude-code': 'Claude — your Claude plan (via Claude Code login)',
  anthropic: 'Claude — Anthropic API key',
  gemini: 'Gemini — Google API key (alphaxiv-open default)',
  openai: 'OpenAI — API key',
  ollama: 'Ollama — local model'
}

const EMB_LABELS: Record<EmbeddingProvider, string> = {
  local: 'Local — runs on this computer, no key needed',
  openai: 'OpenAI — API key (alphaxiv-open default)',
  gemini: 'Gemini — Google API key',
  ollama: 'Ollama — local server'
}

export default function SettingsDialog(props: { onClose: () => void; onImported: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('zip')
  const [exportModels, setExportModels] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    api.getSettings().then(setS)
  }, [])
  if (!s) return null

  const set = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch })
    setSaved(false)
    setTest(null)
  }
  const setKey = (k: keyof Settings['apiKeys'], v: string) => set({ apiKeys: { ...s.apiKeys, [k]: v } })

  const save = async () => {
    setS(await api.saveSettings(s))
    setSaved(true)
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      const reply = await api.testLlm(s)
      setTest({ ok: true, text: reply })
    } catch (e) {
      setTest({ ok: false, text: cleanError(e) })
    }
    setTesting(false)
  }

  const runExport = async () => {
    setExporting(true)
    setExported(null)
    try {
      const res = await api.exportData({ format: exportFormat, includeModels: exportModels })
      if (res) setExported({ ok: true, text: `Saved ${res.files} files (${formatBytes(res.bytes)}) to ${res.path}` })
    } catch (e) {
      setExported({ ok: false, text: cleanError(e) })
    }
    setExporting(false)
  }

  const runImport = async () => {
    setImporting(true)
    setExported(null)
    try {
      const res = await api.importData()
      if (res) {
        const parts = [
          `${res.lines} research line${res.lines === 1 ? '' : 's'} and ${res.papers} paper${res.papers === 1 ? '' : 's'} added`,
          res.linked ? `${res.linked} existing paper${res.linked === 1 ? '' : 's'} linked to more lines` : '',
          res.updated ? `${res.updated} unfinished paper${res.updated === 1 ? '' : 's'} replaced by indexed copies` : ''
        ]
        setExported({ ok: true, text: `Imported: ${parts.filter(Boolean).join(', ')}` })
        props.onImported()
      }
    } catch (e) {
      setExported({ ok: false, text: cleanError(e) })
    }
    setImporting(false)
  }

  const needsKey = (p: string) => ['anthropic', 'gemini', 'openai'].includes(p)

  return (
    <Modal title="Settings" onClose={props.onClose} wide>
      <h3>Answers</h3>
      <label className="field">
        <span>Provider</span>
        <select
          value={s.llmProvider}
          onChange={(e) => {
            const p = e.target.value as LlmProvider
            set({ llmProvider: p, llmModel: DEFAULT_LLM_MODELS[p], entityModel: DEFAULT_ENTITY_MODELS[p] })
          }}
        >
          {Object.entries(LLM_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Model</span>
        <input value={s.llmModel} onChange={(e) => set({ llmModel: e.target.value })} />
        {s.llmProvider === 'claude-code' && (
          <small className="muted">
            <code>sonnet</code>, <code>opus</code> or <code>haiku</code> (or a full model id).
          </small>
        )}
      </label>
      {s.llmProvider === 'claude-code' && (
        <div className="callout">
          <p>
            Answers are generated with the Claude Agent SDK and billed to your Claude subscription (Pro/Max) through
            your Claude Code sign-in — no API key needed. Sign in once by running <code>claude</code> in a terminal and
            using <code>/login</code>.
          </p>
          <label className="field">
            <span>Or paste a long-lived token (optional)</span>
            <input
              type="password"
              value={s.claudeOauthToken}
              placeholder="from `claude setup-token`"
              onChange={(e) => set({ claudeOauthToken: e.target.value })}
            />
          </label>
        </div>
      )}
      {needsKey(s.llmProvider) && (
        <label className="field">
          <span>{s.llmProvider === 'anthropic' ? 'Anthropic' : s.llmProvider === 'gemini' ? 'Google AI' : 'OpenAI'} API key</span>
          <input
            type="password"
            value={s.apiKeys[s.llmProvider as keyof Settings['apiKeys']]}
            onChange={(e) => setKey(s.llmProvider as keyof Settings['apiKeys'], e.target.value)}
          />
        </label>
      )}
      <div className="test-row">
        <button className="btn small" disabled={testing} onClick={runTest}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {test && <span className={test.ok ? 'ok-text small' : 'error-text small'}>{test.ok ? `✓ ${test.text}` : test.text}</span>}
      </div>

      <h3>Entity map</h3>
      <label className="check">
        <input type="checkbox" checked={s.extractEntities} onChange={(e) => set({ extractEntities: e.target.checked })} />
        Extract key methods, datasets, metrics… from each paper (one call per paper, abstract + introduction only)
      </label>
      {s.extractEntities && (
        <label className="field" style={{ marginTop: 10 }}>
          <span>Model for entity extraction</span>
          <input
            value={s.entityModel}
            placeholder={`same as answers (${s.llmModel})`}
            onChange={(e) => set({ entityModel: e.target.value })}
          />
          <small className="muted">A small model is plenty here — Haiku keeps token use low.</small>
        </label>
      )}

      <h3>Embeddings</h3>
      <label className="field">
        <span>Provider</span>
        <select
          value={s.embeddingProvider}
          onChange={(e) => {
            const p = e.target.value as EmbeddingProvider
            set({ embeddingProvider: p, embeddingModel: DEFAULT_EMBEDDING_MODELS[p], ...RECOMMENDED_CHUNKING[p] })
          }}
        >
          {Object.entries(EMB_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Model</span>
        <input value={s.embeddingModel} onChange={(e) => set({ embeddingModel: e.target.value })} />
        {s.embeddingProvider === 'local' && (
          <small className="muted">Downloaded from Hugging Face on first use (~35 MB), then cached.</small>
        )}
      </label>
      {(s.embeddingProvider === 'openai' || s.embeddingProvider === 'gemini') && (
        <label className="field">
          <span>{s.embeddingProvider === 'openai' ? 'OpenAI' : 'Google AI'} API key</span>
          <input
            type="password"
            value={s.apiKeys[s.embeddingProvider]}
            onChange={(e) => setKey(s.embeddingProvider as 'openai' | 'gemini', e.target.value)}
          />
        </label>
      )}
      {(s.llmProvider === 'ollama' || s.embeddingProvider === 'ollama') && (
        <label className="field">
          <span>Ollama URL</span>
          <input value={s.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} />
        </label>
      )}
      <p className="muted small">
        Changing the embedding model makes existing vectors incompatible: papers fall back to keyword search until you
        use “Process unfinished” on a research line to re-index them.
      </p>

      <h3>Indexing &amp; retrieval</h3>
      <div className="field-row">
        <label className="field">
          <span>Chunk size (tokens)</span>
          <input type="number" min={100} max={4000} value={s.chunkSize} onChange={(e) => set({ chunkSize: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Overlap (tokens)</span>
          <input type="number" min={0} max={1000} value={s.chunkOverlap} onChange={(e) => set({ chunkOverlap: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Excerpts per answer</span>
          <input type="number" min={1} max={40} value={s.topK} onChange={(e) => set({ topK: Number(e.target.value) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.stripReferences} onChange={(e) => set({ stripReferences: e.target.checked })} />
        Drop the references section before indexing
      </label>

      <h3>Export &amp; import</h3>
      <p className="muted small">
        Saves every research line with its papers, PDFs, extracted text, chunks, embeddings, entity maps and chat
        history as one archive. Settings are included without API keys or tokens.
        Importing merges an export into this library: lines and papers you already have are kept, and chats are
        combined. Papers embedded with a different model than yours fall back to keyword search until re-indexed.
      </p>
      <div className="test-row">
        <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
          <option value="zip">.zip</option>
          <option value="tar.gz">.tar.gz</option>
          <option value="tar">.tar</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={exportModels} onChange={(e) => setExportModels(e.target.checked)} />
          Include the downloaded embedding model
        </label>
        <button className="btn small" disabled={exporting} onClick={runExport}>
          {exporting ? 'Exporting…' : 'Export…'}
        </button>
        <button className="btn small" disabled={importing} onClick={runImport}>
          {importing ? 'Importing…' : 'Import…'}
        </button>
      </div>
      {exported && (
        <p className={exported.ok ? 'ok-text small' : 'error-text small'}>{exported.ok ? `✓ ${exported.text}` : exported.text}</p>
      )}

      <div className="modal-actions">
        {saved && <span className="ok-text small">Saved</span>}
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let i = -1
  do {
    n /= 1024
    i++
  } while (n >= 1024 && i < units.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}
