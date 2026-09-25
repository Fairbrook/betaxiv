import type { EmbeddingProvider, LlmProvider, Settings } from './types'

export const DEFAULT_LLM_MODELS: Record<LlmProvider, string> = {
  // Claude Code model aliases: 'sonnet', 'opus', 'haiku' (or a full model id).
  'claude-code': 'sonnet',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
  ollama: 'llama3.1'
}

/** Cheaper model used for entity extraction ('' = reuse the answer model). */
export const DEFAULT_ENTITY_MODELS: Record<LlmProvider, string> = {
  'claude-code': 'haiku',
  anthropic: 'claude-haiku-4-5',
  gemini: '',
  openai: '',
  ollama: ''
}

/** Quick-switch choices shown next to the chat box. */
export const QUICK_MODELS: Partial<Record<LlmProvider, { value: string; label: string }[]>> = {
  'claude-code': [
    { value: 'haiku', label: 'Haiku (fewest tokens)' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus (most capable)' }
  ],
  anthropic: [
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' }
  ]
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  // 512-token context; small enough to run on CPU.
  local: 'Xenova/bge-small-en-v1.5',
  // alphaxiv-open's default embedding model.
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
  ollama: 'nomic-embed-text'
}

/**
 * Recommended chunk sizes (approx. tokens) per embedding provider. alphaxiv-open
 * uses 1000/200 with OpenAI embeddings (8k context); small local models only see
 * ~512 tokens, so their chunks must be smaller or the tail would be ignored.
 */
export const RECOMMENDED_CHUNKING: Record<EmbeddingProvider, { chunkSize: number; chunkOverlap: number }> = {
  local: { chunkSize: 400, chunkOverlap: 80 },
  openai: { chunkSize: 1000, chunkOverlap: 200 },
  gemini: { chunkSize: 1000, chunkOverlap: 200 },
  ollama: { chunkSize: 1000, chunkOverlap: 200 }
}

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: 'claude-code',
  llmModel: DEFAULT_LLM_MODELS['claude-code'],
  entityModel: DEFAULT_ENTITY_MODELS['claude-code'],
  embeddingProvider: 'local',
  embeddingModel: DEFAULT_EMBEDDING_MODELS.local,
  apiKeys: { openai: '', gemini: '', anthropic: '' },
  claudeOauthToken: '',
  ollamaUrl: 'http://localhost:11434',
  ...RECOMMENDED_CHUNKING.local,
  topK: 10,
  stripReferences: true,
  extractEntities: true
}
