import { safeStorage } from 'electron'
import { readJson, writeJson } from './fsutil'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import type { Settings } from '../shared/types'

// Secrets are encrypted with the OS keychain (safeStorage) when it's available.
interface StoredSettings extends Omit<Settings, 'apiKeys' | 'claudeOauthToken'> {
  secrets?: string
  plainSecrets?: Pick<Settings, 'apiKeys' | 'claudeOauthToken'>
}

let file = ''
let cached: Settings | null = null

export function initSettings(path: string): void {
  file = path
  cached = null
}

export function getSettings(): Settings {
  if (cached) return cached
  const stored = readJson<Partial<StoredSettings>>(file, {})
  let secrets: Pick<Settings, 'apiKeys' | 'claudeOauthToken'> = {
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys },
    claudeOauthToken: ''
  }
  try {
    if (stored.secrets && safeStorage.isEncryptionAvailable()) {
      secrets = JSON.parse(safeStorage.decryptString(Buffer.from(stored.secrets, 'base64')))
    } else if (stored.plainSecrets) {
      secrets = stored.plainSecrets
    }
  } catch {
    // Unreadable secrets (e.g. keychain changed): fall back to empty keys.
  }
  const { secrets: _s, plainSecrets: _p, ...rest } = stored
  cached = {
    ...DEFAULT_SETTINGS,
    ...rest,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...secrets.apiKeys },
    claudeOauthToken: secrets.claudeOauthToken ?? ''
  }
  return cached
}

export function saveSettings(next: Settings): Settings {
  const { apiKeys, claudeOauthToken, ...rest } = next
  const secrets = { apiKeys, claudeOauthToken }
  const stored: StoredSettings = { ...rest }
  if (safeStorage.isEncryptionAvailable()) {
    stored.secrets = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')
  } else {
    stored.plainSecrets = secrets
  }
  writeJson(file, stored)
  cached = { ...next }
  return cached
}

export const embeddingKey = (s: Settings): string => `${s.embeddingProvider}:${s.embeddingModel}`
