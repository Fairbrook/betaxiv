import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BetaxivApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BetaxivApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  testLlm: (s) => ipcRenderer.invoke('settings:testLlm', s),

  listLines: () => ipcRenderer.invoke('lines:list'),
  createLine: (input) => ipcRenderer.invoke('lines:create', input),
  updateLine: (line) => ipcRenderer.invoke('lines:update', line),
  deleteLine: (id) => ipcRenderer.invoke('lines:delete', id),
  previewQuery: (input) => ipcRenderer.invoke('lines:previewQuery', input),

  listPapers: (lineId) => ipcRenderer.invoke('papers:list', lineId),
  fetchNewPapers: (lineId, n) => ipcRenderer.invoke('papers:fetchNew', lineId, n),
  processPending: (lineId) => ipcRenderer.invoke('papers:processPending', lineId),
  reindexPaper: (lineId, paperId) => ipcRenderer.invoke('papers:reindex', lineId, paperId),
  approvePapers: (lineId, paperIds) => ipcRenderer.invoke('papers:approve', lineId, paperIds),
  removePapers: (lineId, paperIds) => ipcRenderer.invoke('papers:remove', lineId, paperIds),
  cancelJob: (lineId) => ipcRenderer.invoke('job:cancel', lineId),
  openPdf: (paperId) => ipcRenderer.invoke('papers:openPdf', paperId),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getPaperText: (paperId) => ipcRenderer.invoke('papers:text', paperId),
  lineMap: (lineId) => ipcRenderer.invoke('lines:map', lineId),

  chatHistory: (lineId) => ipcRenderer.invoke('chat:history', lineId),
  ask: (lineId, question, paperIds, requestId) => ipcRenderer.invoke('chat:ask', lineId, question, paperIds, requestId),
  stopAnswer: (requestId) => ipcRenderer.invoke('chat:stop', requestId),
  clearChat: (lineId) => ipcRenderer.invoke('chat:clear', lineId),

  onJobProgress: (cb) => subscribe('job:progress', cb),
  onPapersChanged: (cb) => subscribe('papers:changed', cb),
  onChatToken: (cb) => subscribe('chat:token', cb)
}

contextBridge.exposeInMainWorld('betaxiv', api)
