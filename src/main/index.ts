import { app, BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSearchQuery } from './arxiv'
import { setModelCacheDir } from './embeddings'
import { Pipeline } from './pipeline'
import { buildLineMap } from './entities'
import { complete } from './llm'
import { ask } from './rag'
import { getSettings, initSettings, saveSettings } from './settings'
import { Store } from './store'
import type { ChatMessage, NewLineInput, ResearchLine, Settings } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'betaxiv',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Links in rendered answers open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

app.whenReady().then(() => {
  const dataDir = process.env.BETAXIV_DATA_DIR || path.join(app.getPath('userData'), 'data')
  const store = new Store(dataDir)
  initSettings(path.join(dataDir, 'settings.json'))
  setModelCacheDir(path.join(dataDir, 'models'))
  const workDir = path.join(dataDir, 'claude')
  fs.mkdirSync(workDir, { recursive: true })

  const pipeline = new Pipeline(store, {
    progress: (p) => send('job:progress', p),
    papersChanged: (lineId) => send('papers:changed', lineId)
  }, workDir)
  const chatAborts = new Map<string, AbortController>()

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, s: Settings) => saveSettings(s))
  ipcMain.handle('settings:testLlm', async (_e, s: Settings) => {
    const reply = await complete(
      s,
      { system: 'You are a connectivity check.', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], onToken: () => {} },
      workDir
    )
    return `${s.llmProvider} / ${s.llmModel} replied: ${reply.trim().slice(0, 80)}`
  })

  ipcMain.handle('lines:list', () => store.listLines())
  ipcMain.handle('lines:create', (_e, input: NewLineInput) => {
    buildSearchQuery(input) // validate
    return store.createLine(input)
  })
  ipcMain.handle('lines:update', (_e, line: ResearchLine) => {
    buildSearchQuery(line)
    return store.updateLine(line)
  })
  ipcMain.handle('lines:delete', (_e, id: string) => {
    pipeline.cancel(id)
    store.deleteLine(id)
  })
  ipcMain.handle('lines:previewQuery', (_e, input: NewLineInput) => buildSearchQuery(input))

  ipcMain.handle('papers:list', (_e, lineId: string) => store.papersForLine(lineId))
  ipcMain.handle('papers:fetchNew', (_e, lineId: string, n: number) =>
    pipeline.fetchNew(lineId, Math.max(1, Math.min(200, Math.floor(n))))
  )
  ipcMain.handle('papers:processPending', (_e, lineId: string) => pipeline.processPending(lineId))
  ipcMain.handle('papers:reindex', (_e, lineId: string, paperId: string) => pipeline.reindex(lineId, paperId))
  ipcMain.handle('papers:approve', (_e, lineId: string, paperIds: string[]) => pipeline.approve(lineId, paperIds))
  ipcMain.handle('papers:remove', (_e, lineId: string, paperIds: string[]) => pipeline.remove(lineId, paperIds))
  ipcMain.handle('job:cancel', (_e, lineId: string) => pipeline.cancel(lineId))
  ipcMain.handle('papers:openPdf', async (_e, paperId: string) => {
    const file = path.join(store.paperDir(paperId), 'paper.pdf')
    if (fs.existsSync(file)) await shell.openPath(file)
    else await shell.openExternal(store.getPaper(paperId).pdfUrl)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https:\/\/(arxiv\.org|export\.arxiv\.org)\//.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle('lines:map', (_e, lineId: string) => buildLineMap(store.papersForLine(lineId)))
  ipcMain.handle('papers:text', (_e, paperId: string) => {
    try {
      return fs.readFileSync(path.join(store.paperDir(paperId), 'paper.md'), 'utf8')
    } catch {
      return ''
    }
  })

  ipcMain.handle('chat:history', (_e, lineId: string) => store.chatHistory(lineId))
  ipcMain.handle('chat:clear', (_e, lineId: string) => store.clearChat(lineId))
  ipcMain.handle('chat:ask', async (_e, lineId: string, question: string, paperIds: string[], requestId: string) => {
    const history = store.chatHistory(lineId)
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
      scope: paperIds
    }
    const ctrl = new AbortController()
    chatAborts.set(requestId, ctrl)
    let reply: ChatMessage
    try {
      const { answer, sources } = await ask({
        store,
        settings: getSettings(),
        lineId,
        question,
        paperIds,
        history,
        workDir,
        signal: ctrl.signal,
        onToken: (token) => send('chat:token', { requestId, token })
      })
      reply = { id: randomUUID(), role: 'assistant', content: answer, sources, createdAt: new Date().toISOString() }
    } catch (err) {
      reply = {
        id: randomUUID(),
        role: 'assistant',
        content: ctrl.signal.aborted ? 'Stopped.' : `**Error:** ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
        error: true
      }
    } finally {
      chatAborts.delete(requestId)
    }
    store.appendChat(lineId, userMsg, reply)
    return reply
  })
  ipcMain.handle('chat:stop', (_e, requestId: string) => chatAborts.get(requestId)?.abort())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
