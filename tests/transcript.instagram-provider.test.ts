import { beforeEach, describe, expect, it, vi } from 'vitest'

const ytdlp = vi.hoisted(() => ({
  fetchInstagramTranscriptWithYtDlp: vi.fn(),
}))
const transcriptionStart = vi.hoisted(() => ({
  resolveTranscriptionAvailability: vi.fn(),
}))

vi.mock('../packages/core/src/content/transcript/providers/instagram/yt-dlp.js', () => ytdlp)
vi.mock('../packages/core/src/content/transcript/providers/transcription-start.js', () => transcriptionStart)

import {
  canHandle,
  fetchTranscript,
} from '../packages/core/src/content/transcript/providers/instagram.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: null,
}

describe('Instagram transcript provider - canHandle', () => {
  it('matches instagram.com/reel/ URLs', () => {
    expect(canHandle({ url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://instagram.com/reel/ABC123/', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://www.instagram.com/reel/ABC123', html: null, resourceKey: null })).toBe(true)
  })

  it('matches instagram.com/reels/ URLs', () => {
    expect(canHandle({ url: 'https://www.instagram.com/reels/ABC123/', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://instagram.com/reels/ABC123', html: null, resourceKey: null })).toBe(true)
  })

  it('matches instagram.com/p/ posts (can be videos)', () => {
    expect(canHandle({ url: 'https://www.instagram.com/p/ABC123/', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://instagram.com/p/ABC123', html: null, resourceKey: null })).toBe(true)
  })

  it('matches instagram.com/tv/ IGTV videos', () => {
    expect(canHandle({ url: 'https://www.instagram.com/tv/ABC123/', html: null, resourceKey: null })).toBe(true)
    expect(canHandle({ url: 'https://instagram.com/tv/ABC123', html: null, resourceKey: null })).toBe(true)
  })

  it('does not match profile pages or homepage', () => {
    expect(canHandle({ url: 'https://www.instagram.com/username/', html: null, resourceKey: null })).toBe(false)
    expect(canHandle({ url: 'https://www.instagram.com/', html: null, resourceKey: null })).toBe(false)
  })

  it('does not match non-Instagram URLs', () => {
    expect(canHandle({ url: 'https://www.youtube.com/watch?v=abc123', html: null, resourceKey: null })).toBe(false)
    expect(canHandle({ url: 'https://www.tiktok.com/@user/video/1234567890', html: null, resourceKey: null })).toBe(false)
    expect(canHandle({ url: 'https://example.com/instagram/reel/123', html: null, resourceKey: null })).toBe(false)
  })
})

describe('Instagram transcript provider - fetchTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ytdlp.fetchInstagramTranscriptWithYtDlp.mockResolvedValue({
      text: null,
      provider: null,
      error: null,
      notes: [],
    })
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: false,
    })
  })

  it('returns unavailable when yt-dlp is not available', async () => {
    const result = await fetchTranscript(
      { url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null },
      baseOptions
    )

    expect(result.text).toBe(null)
    expect(result.source).toBe('unavailable')
    expect(result.notes).toContain('yt-dlp not available (required for Instagram Reels)')
  })

  it('returns unavailable when no transcription provider available', async () => {
    const result = await fetchTranscript(
      { url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null },
      { ...baseOptions, ytDlpPath: '/usr/local/bin/yt-dlp' }
    )

    expect(result.text).toBe(null)
    expect(result.source).toBe('unavailable')
    expect(result.notes).toContain('No transcription provider available (required for Instagram Reels)')
  })

  it('uses yt-dlp + whisper when available', async () => {
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: true,
    })
    ytdlp.fetchInstagramTranscriptWithYtDlp.mockResolvedValue({
      text: 'Hello from Instagram Reel',
      provider: 'whisper',
      error: null,
      notes: [],
    })

    const result = await fetchTranscript(
      { url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null },
      { ...baseOptions, ytDlpPath: '/usr/local/bin/yt-dlp' }
    )

    expect(result.text).toBe('Hello from Instagram Reel')
    expect(result.source).toBe('yt-dlp')
    expect(result.metadata?.transcriptionProvider).toBe('whisper')
    expect(result.metadata?.platform).toBe('instagram')
  })

  it('reports error when yt-dlp fails', async () => {
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: true,
    })
    ytdlp.fetchInstagramTranscriptWithYtDlp.mockResolvedValue({
      text: null,
      provider: null,
      error: new Error('Video is private'),
      notes: ['yt-dlp error: Video is private'],
    })

    const result = await fetchTranscript(
      { url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null },
      { ...baseOptions, ytDlpPath: '/usr/local/bin/yt-dlp' }
    )

    expect(result.text).toBe(null)
    expect(result.source).toBe('unavailable')
    expect(result.notes).toContain('yt-dlp error: Video is private')
  })

  it('passes cookies-from-browser option when configured', async () => {
    transcriptionStart.resolveTranscriptionAvailability.mockResolvedValue({
      hasAnyProvider: true,
    })
    ytdlp.fetchInstagramTranscriptWithYtDlp.mockResolvedValue({
      text: 'Private reel content',
      provider: 'whisper',
      error: null,
      notes: [],
    })

    await fetchTranscript(
      { url: 'https://www.instagram.com/reel/ABC123/', html: null, resourceKey: null },
      {
        ...baseOptions,
        ytDlpPath: '/usr/local/bin/yt-dlp',
        env: { INSTAGRAM_COOKIES_FROM_BROWSER: 'chrome' },
      }
    )

    expect(ytdlp.fetchInstagramTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({
        cookiesFromBrowser: 'chrome',
      })
    )
  })
})
