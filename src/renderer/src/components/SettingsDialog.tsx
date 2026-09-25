import { useEffect, useState } from 'react'
import type { EmbeddingProvider, LlmProvider, Settings } from '@shared/types'
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_LLM_MODELS, RECOMMENDED_CHUNKING } from '@shared/defaults'
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

export default function SettingsDialog(props: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

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
            set({ llmProvider: p, llmModel: DEFAULT_LLM_MODELS[p] })
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
