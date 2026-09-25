import type { Settings } from '../shared/types'

export interface LlmTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  system: string
  messages: LlmTurn[]
  onToken: (t: string) => void
  signal?: AbortSignal
}

/** Parse a `text/event-stream` body, yielding each event's `data:` payload. */
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, idx)
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) yield data
    }
  }
}

async function ensureOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  throw new Error(`${provider} request failed (HTTP ${res.status}): ${body.slice(0, 400)}`)
}

// ---- Claude via the Claude Agent SDK (uses your Claude Code login / plan) ---

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<AgentSdk> | null = null
const loadSdk = () => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

/** Render prior turns into the single prompt the Agent SDK takes. */
function transcriptPrompt(messages: LlmTurn[]): string {
  if (messages.length === 1) return messages[0].content
  const history = messages
    .slice(0, -1)
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join('\n')
  return `<conversation_so_far>\n${history}\n</conversation_so_far>\n\n${messages[messages.length - 1].content}`
}

async function claudeCode(s: Settings, req: LlmRequest, cwd: string): Promise<string> {
  const { query } = await loadSdk()
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'betaxiv/0.1' }
  // An API key in the environment would take precedence over the subscription login.
  delete env.ANTHROPIC_API_KEY
  if (s.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = s.claudeOauthToken

  const abortController = new AbortController()
  req.signal?.addEventListener('abort', () => abortController.abort())

  let streamed = ''
  let final = ''
  const q = query({
    prompt: transcriptPrompt(req.messages),
    options: {
      model: s.llmModel || undefined,
      systemPrompt: req.system,
      // Pure question answering over the retrieved context: no tools, one turn,
      // no user/project settings or CLAUDE.md files, no saved session transcripts.
      tools: [],
      maxTurns: 1,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      cwd,
      env,
      abortController
    }
  })
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        streamed += ev.delta.text
        req.onToken(ev.delta.text)
      }
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success' && !msg.is_error) {
        final = msg.result
      } else {
        const detail = msg.subtype === 'success' ? msg.result : msg.subtype
        throw new Error(
          `Claude Code returned an error: ${detail}. Make sure you're signed in — run \`claude\` in a terminal and use /login with your Claude account, or paste a token from \`claude setup-token\` in Settings.`
        )
      }
    }
  }
  return final || streamed
}

// ---- Anthropic Messages API (API key) ---------------------------------------

async function anthropic(s: Settings, req: LlmRequest): Promise<string> {
  if (!s.apiKeys.anthropic) throw new Error('Anthropic API key is not set (Settings → Answers)')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.apiKeys.anthropic,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: s.llmModel, max_tokens: 8192, system: req.system, messages: req.messages, stream: true }),
    signal: req.signal
  })
  await ensureOk(res, 'Anthropic')
  let out = ''
  for await (const data of sseData(res)) {
    const ev = JSON.parse(data)
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      out += ev.delta.text
      req.onToken(ev.delta.text)
    } else if (ev.type === 'error') {
      throw new Error(`Anthropic error: ${ev.error?.message ?? data}`)
    }
  }
  return out
}

// ---- Gemini (alphaxiv-open's answer model) ----------------------------------

async function gemini(s: Settings, req: LlmRequest): Promise<string> {
  if (!s.apiKeys.gemini) throw new Error('Gemini API key is not set (Settings → Answers)')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${s.llmModel}:streamGenerateContent?alt=sse`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': s.apiKeys.gemini },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: 1, topP: 0.95, topK: 40 }
    }),
    signal: req.signal
  })
  await ensureOk(res, 'Gemini')
  let out = ''
  for await (const data of sseData(res)) {
    const ev = JSON.parse(data)
    for (const part of ev.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) {
        out += part.text
        req.onToken(part.text)
      }
    }
  }
  return out
}

// ---- OpenAI -----------------------------------------------------------------

async function openai(s: Settings, req: LlmRequest): Promise<string> {
  if (!s.apiKeys.openai) throw new Error('OpenAI API key is not set (Settings → Answers)')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.apiKeys.openai}` },
    body: JSON.stringify({
      model: s.llmModel,
      stream: true,
      messages: [{ role: 'system', content: req.system }, ...req.messages]
    }),
    signal: req.signal
  })
  await ensureOk(res, 'OpenAI')
  let out = ''
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break
    const t = JSON.parse(data).choices?.[0]?.delta?.content
    if (t) {
      out += t
      req.onToken(t)
    }
  }
  return out
}

// ---- Ollama (local) ---------------------------------------------------------

async function ollama(s: Settings, req: LlmRequest): Promise<string> {
  const res = await fetch(`${s.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: s.llmModel,
      stream: true,
      messages: [{ role: 'system', content: req.system }, ...req.messages]
    }),
    signal: req.signal
  })
  await ensureOk(res, 'Ollama')
  let out = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const t = JSON.parse(line).message?.content
      if (t) {
        out += t
        req.onToken(t)
      }
    }
  }
  return out
}

/** Stream a chat completion from the configured provider; resolves with the full text. */
export function complete(s: Settings, req: LlmRequest, workDir: string): Promise<string> {
  switch (s.llmProvider) {
    case 'claude-code':
      return claudeCode(s, req, workDir)
    case 'anthropic':
      return anthropic(s, req)
    case 'gemini':
      return gemini(s, req)
    case 'openai':
      return openai(s, req)
    case 'ollama':
      return ollama(s, req)
  }
}
