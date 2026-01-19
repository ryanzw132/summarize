import { describe, expect, it, vi } from 'vitest'

import {
  extractTikTokSubtitleInfos,
  extractTikTokDurationSeconds,
  fetchTikTokCaptions,
} from '../packages/core/src/content/transcript/providers/tiktok/captions.js'

describe('TikTok captions - extractTikTokSubtitleInfos', () => {
  it('extracts subtitle info from valid hydration data', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {
                    subtitleInfos: [
                      {
                        LanguageCodeName: 'eng-US',
                        Url: 'https://example.com/captions.vtt',
                        UrlExpire: 1234567890,
                        Format: 'webvtt',
                      },
                      {
                        LanguageCodeName: 'spa',
                        Url: 'https://example.com/captions-es.vtt',
                        UrlExpire: 1234567890,
                        Format: 'webvtt',
                      },
                    ],
                  },
                },
              },
            },
          },
        })}
      </script>
    `

    const result = extractTikTokSubtitleInfos(html)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      languageCode: 'eng-US',
      url: 'https://example.com/captions.vtt',
      urlExpire: 1234567890,
      format: 'webvtt',
    })
    expect(result[1]?.languageCode).toBe('spa')
  })

  it('returns empty array when script tag is missing', () => {
    const html = '<html><body>No hydration data</body></html>'
    expect(extractTikTokSubtitleInfos(html)).toEqual([])
  })

  it('returns empty array when subtitleInfos is not present', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {},
                },
              },
            },
          },
        })}
      </script>
    `
    expect(extractTikTokSubtitleInfos(html)).toEqual([])
  })

  it('returns empty array on invalid JSON', () => {
    const html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">not valid json</script>'
    expect(extractTikTokSubtitleInfos(html)).toEqual([])
  })

  it('filters out entries without URL', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {
                    subtitleInfos: [
                      { LanguageCodeName: 'eng', Format: 'webvtt' },
                      { LanguageCodeName: 'spa', Url: 'https://example.com/valid.vtt', Format: 'webvtt' },
                    ],
                  },
                },
              },
            },
          },
        })}
      </script>
    `

    const result = extractTikTokSubtitleInfos(html)
    expect(result).toHaveLength(1)
    expect(result[0]?.languageCode).toBe('spa')
  })
})

describe('TikTok captions - extractTikTokDurationSeconds', () => {
  it('extracts duration from valid hydration data', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {
                    duration: 45,
                  },
                },
              },
            },
          },
        })}
      </script>
    `

    expect(extractTikTokDurationSeconds(html)).toBe(45)
  })

  it('returns null when duration is missing', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {},
                },
              },
            },
          },
        })}
      </script>
    `

    expect(extractTikTokDurationSeconds(html)).toBe(null)
  })

  it('returns null for invalid duration values', () => {
    const html = `
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        ${JSON.stringify({
          __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
              itemInfo: {
                itemStruct: {
                  video: {
                    duration: -5,
                  },
                },
              },
            },
          },
        })}
      </script>
    `

    expect(extractTikTokDurationSeconds(html)).toBe(null)
  })
})

describe('TikTok captions - fetchTikTokCaptions', () => {
  it('prefers English captions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`WEBVTT

00:00.000 --> 00:02.000
Hello world`),
    })

    const subtitleInfos = [
      { languageCode: 'spa', url: 'https://example.com/es.vtt', urlExpire: 0, format: 'webvtt' },
      { languageCode: 'eng-US', url: 'https://example.com/en.vtt', urlExpire: 0, format: 'webvtt' },
    ]

    await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, subtitleInfos)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/en.vtt',
      expect.any(Object)
    )
  })

  it('falls back to first caption when no English available', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`WEBVTT

00:00.000 --> 00:02.000
Hola mundo`),
    })

    const subtitleInfos = [
      { languageCode: 'spa', url: 'https://example.com/es.vtt', urlExpire: 0, format: 'webvtt' },
    ]

    await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, subtitleInfos)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/es.vtt',
      expect.any(Object)
    )
  })

  it('parses WebVTT content correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`WEBVTT

00:00:00.000 --> 00:00:02.000
First line

00:00:02.000 --> 00:00:04.500
Second line`),
    })

    const subtitleInfos = [
      { languageCode: 'eng', url: 'https://example.com/en.vtt', urlExpire: 0, format: 'webvtt' },
    ]

    const result = await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, subtitleInfos)
    expect(result).not.toBe(null)
    expect(result?.text).toBe('First line Second line')
    expect(result?.segments).toHaveLength(2)
    expect(result?.segments[0]).toEqual({ startMs: 0, endMs: 2000, text: 'First line' })
    expect(result?.segments[1]).toEqual({ startMs: 2000, endMs: 4500, text: 'Second line' })
  })

  it('handles short timestamp format (MM:SS.mmm)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`WEBVTT

01:30.000 --> 01:35.500
Ninety seconds in`),
    })

    const subtitleInfos = [
      { languageCode: 'eng', url: 'https://example.com/en.vtt', urlExpire: 0, format: 'webvtt' },
    ]

    const result = await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, subtitleInfos)
    expect(result?.segments[0]).toEqual({
      startMs: 90000,
      endMs: 95500,
      text: 'Ninety seconds in',
    })
  })

  it('returns null on fetch error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })

    const subtitleInfos = [
      { languageCode: 'eng', url: 'https://example.com/en.vtt', urlExpire: 0, format: 'webvtt' },
    ]

    const result = await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, subtitleInfos)
    expect(result).toBe(null)
  })

  it('returns null when no subtitle infos provided', async () => {
    const mockFetch = vi.fn()
    const result = await fetchTikTokCaptions(mockFetch as unknown as typeof fetch, [])
    expect(result).toBe(null)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
