import { beforeEach, describe, expect, it } from 'vitest'

import {
  defaultSettings,
  loadSettings,
  patchSettings,
  saveSettings,
} from '../apps/chrome-extension/src/lib/settings.js'

type Storage = Record<string, unknown>

describe('chrome/settings', () => {
  let storage: Storage

  beforeEach(() => {
    storage = {}
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storage[key] }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(storage, obj)
          },
        },
      },
    }
  })

  it('loads defaults when storage is empty', async () => {
    const s = await loadSettings()
    expect(s).toEqual(defaultSettings)
  })

  it('normalizes model/length/language on save', async () => {
    await saveSettings({
      ...defaultSettings,
      token: 't',
      model: 'Auto',
      length: 'S',
      language: ' German ',
    })

    const raw = storage.settings as Record<string, unknown>
    expect(raw.model).toBe('auto')
    expect(raw.length).toBe('short')
    expect(raw.language).toBe('German')

    const loaded = await loadSettings()
    expect(loaded.model).toBe('auto')
    expect(loaded.length).toBe('short')
    expect(loaded.language).toBe('German')
  })

  it('patches settings and persists them', async () => {
    await patchSettings({ token: 'x', length: '20k', language: 'en' })
    const loaded = await loadSettings()
    expect(loaded.token).toBe('x')
    expect(loaded.length).toBe('20k')
    expect(loaded.language).toBe('en')
  })

  it('normalizes advanced overrides on save', async () => {
    await saveSettings({
      ...defaultSettings,
      requestMode: 'URL',
      firecrawlMode: 'Always',
      markdownMode: 'LLM',
      preprocessMode: 'AUTO',
      youtubeMode: 'No-Auto',
      timeout: ' 90s ',
      retries: 3.9,
      maxOutputTokens: ' 2k ',
    })

    const raw = storage.settings as Record<string, unknown>
    expect(raw.requestMode).toBe('url')
    expect(raw.firecrawlMode).toBe('always')
    expect(raw.markdownMode).toBe('llm')
    expect(raw.preprocessMode).toBe('auto')
    expect(raw.youtubeMode).toBe('no-auto')
    expect(raw.timeout).toBe('90s')
    expect(raw.retries).toBe(3)
    expect(raw.maxOutputTokens).toBe('2k')

    const loaded = await loadSettings()
    expect(loaded.requestMode).toBe('url')
    expect(loaded.firecrawlMode).toBe('always')
    expect(loaded.markdownMode).toBe('llm')
    expect(loaded.preprocessMode).toBe('auto')
    expect(loaded.youtubeMode).toBe('no-auto')
    expect(loaded.timeout).toBe('90s')
    expect(loaded.retries).toBe(3)
    expect(loaded.maxOutputTokens).toBe('2k')
  })

  it('persists includeVideoDetails setting', async () => {
    await patchSettings({ includeVideoDetails: true })
    const loaded = await loadSettings()
    expect(loaded.includeVideoDetails).toBe(true)

    await patchSettings({ includeVideoDetails: false })
    const loaded2 = await loadSettings()
    expect(loaded2.includeVideoDetails).toBe(false)
  })

  it('persists includeVideoStats setting', async () => {
    await patchSettings({ includeVideoStats: true })
    const loaded = await loadSettings()
    expect(loaded.includeVideoStats).toBe(true)

    await patchSettings({ includeVideoStats: false })
    const loaded2 = await loadSettings()
    expect(loaded2.includeVideoStats).toBe(false)
  })

  it('defaults includeVideoStats to false', async () => {
    const loaded = await loadSettings()
    expect(loaded.includeVideoStats).toBe(false)
  })

  it('handles invalid includeVideoStats values', async () => {
    storage.settings = { includeVideoStats: 'invalid' }
    const loaded = await loadSettings()
    expect(loaded.includeVideoStats).toBe(false)
  })

  it('handles both video detail settings together', async () => {
    await patchSettings({ includeVideoDetails: true, includeVideoStats: true })
    const loaded = await loadSettings()
    expect(loaded.includeVideoDetails).toBe(true)
    expect(loaded.includeVideoStats).toBe(true)
  })
})
