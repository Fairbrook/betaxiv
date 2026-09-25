import type { BetaxivApi } from '@shared/types'

declare global {
  interface Window {
    betaxiv: BetaxivApi
  }
}

export const api = window.betaxiv

export const newId = () => crypto.randomUUID()
