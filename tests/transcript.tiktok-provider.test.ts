import { beforeEach, describe, expect, it, vi } from 'vitest'

const captions = vi.hoisted(() => ({
  extractTikTokSubtitleInfos: vi.fn(),
  extractTikTokDurationSeconds: vi.fn(),
  fetchTikTokCaptions: vi.fn(),
}))
const ytdlp = vi.hoisted(() => ({
  fetchTikTokTranscriptWithYtDlp: vi.fn(),
}))
const transcriptionStart = vi.hoisted(() => ({
  resolveTranscriptionAvailability: vi.fn(),
}))

vi.mock('../packages/core/src/content/transcript/providers/tiktok/captions.js', () => captions)
vi.mock('../packages/core/src/content/transcript/providers/tiktok/yt-dlp.js', () => ytdlp)
vi.mock('../packages/core/src/content/transcript/providers/transcription-start.js', () => transcriptionStart)

import {
  canHandle,
  fetchTranscript,
} from '../packages/core/src/content/transcript/providers/tiktok.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: null,
}

describe('TikTok transcript provider - canHandle', () => {
  it('matches tiktok.com URLs', () => {
    expect(canHandle({ url: 'https://www.tiktok.com/@user/video/1234567890', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://tiktok.com/@user/video/1234567890', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://m.tiktok.com/@user/video/1234567890', html: null, resourceKey: null })).toBe(true)
  })

  it('matches vm.tiktok.com short URLs', () => {
    expect(canHandle({ url: 'https://vm.tiktok.com/abcd123/', html: null, resourceKey: null })).toBe(true)
  })

  it('does not match non-TikTok URLs', () => {
    expect(canHandle({ url: 'https://www.youtube.com/watch?v=abc123', html: null, resourceKey: null })).toBe(false)
    expect(canHandle({ url: 'https://www.instagram.com/reel/abc123/', html: null, resourceKey: null })).toBe(false)
    expect(canHandle({ url: 'https://example.com/tiktok', html: null, resourceKey: null })).toBe(false)
  })
})

describe('TikTok transcript provider - fetchTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captions.extractTikTokSubtitleInfos.mockReturnValue([])
    captions.extractTikTokDurationSeconds.mockReturnValue(null)
    captions.fetchTikTokCaptions.mockResolvedValue(null)
    ytdlp.fetchTikTokTranscriptWithYtDlp.mockResolvedValue({
      text: null,
      provider: null,
      error: null,
      notes: [],
    })
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: false,
    })
  })

  it('returns unavailable when no transcript sources available', async () => {
    const result = await fetchTranscript(
      { url: 'https://www.tiktok.com/@user/video/1234567890', html: '<html></html>', resourceKey: null },
      baseOptions
    )

    expect(result.text).toBe(null)
    expect(result.source).toBe('unavailable')
  })

  it('uses native captions when available', async () => {
    captions.extractTikTokSubtitleInfos.mockReturnValue([
      { languageCode: 'en', url: 'https://example.com/captions.vtt', urlExpire: 12345, format: 'webvtt' }
    ])
    captions.fetchTikTokCaptions.mockResolvedValue({
      text: 'Hello from TikTok',
      segments: [{ startMs: 0, endMs: 1000, text: 'Hello from TikTok' }],
    })

    const result = await fetchTranscript(
      { url: 'https://www.tiktok.com/@user/video/1234567890', html: '<html></html>', resourceKey: null },
      baseOptions
    )

    expect(result.text).toBe('Hello from TikTok')
    expect(result.source).toBe('tiktok-captions')
    expect(result.attemptedProviders).toContain('tiktok-captions')
  })

  it('falls back to yt-dlp when captions not available', async () => {
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: true,
    })
    ytdlp.fetchTikTokTranscriptWithYtDlp.mockResolvedValue({
      text: 'Transcribed via whisper',
      provider: 'whisper',
      error: null,
      notes: [],
    })

    const result = await fetchTranscript(
      { url: 'https://www.tiktok.com/@user/video/1234567890', html: '<html></html>', resourceKey: null },
      { ...baseOptions, ytDlpPath: '/usr/local/bin/yt-dlp' }
    )

    expect(result.text).toBe('Transcribed via whisper')
    expect(result.source).toBe('yt-dlp')
  })

  it('fetches HTML if not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{}</script></html>'),
    })

    await fetchTranscript(
      { url: 'https://www.tiktok.com/@user/video/1234567890', html: null, resourceKey: null },
      { ...baseOptions, fetch: mockFetch as unknown as typeof fetch }
    )

    expect(mockFetch).toHaveBeenCalled()
  })
})
