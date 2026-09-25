# betaxiv

A desktop research assistant built with Electron. You define a **line of research** (a set of keywords), pull in
new arXiv papers for it, and the app downloads their full text, indexes it and lets you ask questions across all
the papers, with answers citing the excerpts they came from.

The ingestion and question-answering flow follows [alphaxiv-open](https://github.com/AsyncFuncAI/alphaxiv-open),
rewritten in TypeScript so it runs inside the app, with no Python server to start.

## Flow

1. **Research line.** Pick keywords (AND/OR), and optionally arXiv categories and a sort order. The form shows the
   exact arXiv query it will run.
2. **Fetch N new papers.** The app queries the arXiv API and pages through the results. Papers already in your
   library are skipped: they don't count toward N, and a paper that another line already has is linked to this line
   too. Paging continues until N new papers are added or arXiv runs out of results. Requests are spaced 3 seconds
   apart, as arXiv asks.
3. **Download the full text.** Each paper's PDF is saved locally.
4. **Build the RAG index** (alphaxiv-open pipeline):
   PDF → text (alphaxiv-open uses markitdown, betaxiv uses pdf.js) → clean-up (hyphenation, wrapped lines, ligatures,
   optional removal of the references section) → overlapping chunks → embeddings.
5. **Ask questions** across the whole line, or tick specific papers to narrow the scope. Retrieval is hybrid: dense
   vectors plus BM25 keyword scores, merged with reciprocal rank fusion and capped per paper so one paper can't fill
   every slot. alphaxiv-open does the same job with MiniRAG's `hybrid` mode and falls back to keyword search. The
   retrieved excerpts go to the LLM with a prompt adapted from alphaxiv-open, and the answer streams in with `[n]`
   citations you can click to see the excerpt.

## Answers on your Claude plan

The default answer provider is **Claude via the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)**,
the engine behind Claude Code and the Claude ACP adapter. It signs in with your **Claude Code login**, so answers
count against your Pro/Max plan and you don't need an API key.

One-time setup:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have Claude Code yet
claude                                     # then run /login and sign in with your Claude account
```

Alternatively, run `claude setup-token` and paste the token into **Settings → Answers**.
`ANTHROPIC_API_KEY` is removed from the SDK's environment so the subscription login is always used. The SDK runs
with no tools, one turn, and no saved session files, so it only answers questions.

> Anthropic's terms let you use your own subscription this way for personal use. Don't redistribute the app as a
> product that signs other people in with their claude.ai accounts.

Other answer providers are available in Settings: the Anthropic API (key), Gemini (alphaxiv-open's default), OpenAI,
or a local Ollama model.

### Embeddings

A Claude plan doesn't include an embeddings endpoint, so embeddings run **locally** by default using
`Xenova/bge-small-en-v1.5` through transformers.js. The model (~35 MB) downloads on first use and is then cached.
Local chunks default to 400 tokens with 80 overlap, because the model reads at most 512 tokens. You can switch to
OpenAI `text-embedding-3-small` (alphaxiv-open's default, with its 1000/200 chunking), Gemini, or Ollama.

If you change the embedding model later, existing papers fall back to keyword-only search until you re-index them
with **Process unfinished**.

## Development

```bash
npm install
npm run dev        # start the app with hot reload
npm test           # unit tests (arXiv parsing, text processing, chunking, retrieval)
npm run typecheck
npm run dist       # package an installer for the current OS (electron-builder)
```

Requires Node 20+.

## Where data lives

Everything is stored under the app's user-data folder (`BETAXIV_DATA_DIR` overrides it):

```
data/
  library.json              research lines + paper metadata
  settings.json             settings (API keys encrypted with the OS keychain)
  papers/<id>/paper.pdf     full text
  papers/<id>/paper.md      extracted, cleaned text
  papers/<id>/chunks.json   chunks + embedding model
  papers/<id>/embeddings.bin
  chats/<lineId>.json       conversation history per research line
  models/                   cached local embedding model
```

## Project layout

```
src/main/        Electron main process
  arxiv.ts         arXiv API query building + Atom parsing
  pdf.ts           PDF download + pdf.js text extraction
  textproc.ts      text clean-up, reference stripping, chunking
  embeddings.ts    local / OpenAI / Gemini / Ollama embeddings
  retrieval.ts     cosine + BM25 hybrid search (RRF)
  rag.ts           indexing and question answering
  llm.ts           Claude Agent SDK, Anthropic, Gemini, OpenAI, Ollama streaming
  pipeline.ts      fetch-until-N-new → download → extract → index jobs
  store.ts         file-based library
src/preload/     IPC bridge (context-isolated)
src/renderer/    React UI
```

## Differences from alphaxiv-open

- One desktop app. There is no FastAPI backend, MiniRAG server, or Next.js frontend to run.
- It works on a collection of papers rather than one paper at a time.
- Retrieval is vector + BM25 hybrid search. It does not build MiniRAG's LLM-extracted knowledge graph, which would
  cost several LLM calls per paper.
