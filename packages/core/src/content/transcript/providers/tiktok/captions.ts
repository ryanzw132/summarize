import type { TranscriptSegment } from '../../../link-preview/types.js'

export interface TikTokSubtitleInfo {
  languageCode: string
  url: string
  urlExpire: number
  format: string
}

/**
 * Extract subtitle info from TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag.
 * Path: `__DEFAULT_SCOPE__ → webapp.video-detail → itemInfo → itemStruct → video → subtitleInfos`
 */
export function extractTikTokSubtitleInfos(html: string): TikTokSubtitleInfo[] {
  const scriptMatch = html.match(
    /<script[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i
  )
  if (!scriptMatch?.[1]) {
    return []
  }

  try {
    const data = JSON.parse(scriptMatch[1]) as {
      __DEFAULT_SCOPE__?: {
        'webapp.video-detail'?: {
          itemInfo?: {
            itemStruct?: {
              video?: {
                subtitleInfos?: Array<{
                  LanguageCodeName?: string
                  LanguageID?: string
                  Url?: string
                  UrlExpire?: number
                  Format?: string
                  Source?: string
                }>
              }
            }
          }
        }
      }
    }

    const subtitleInfos =
      data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct?.video?.subtitleInfos

    if (!Array.isArray(subtitleInfos) || subtitleInfos.length === 0) {
      return []
    }

    return subtitleInfos
      .filter((info) => info.Url && typeof info.Url === 'string')
      .map((info) => ({
        languageCode: info.LanguageCodeName ?? info.LanguageID ?? 'unknown',
        url: info.Url as string,
        urlExpire: typeof info.UrlExpire === 'number' ? info.UrlExpire : 0,
        format: info.Format ?? 'webvtt',
      }))
  } catch {
    return []
  }
}

/**
 * Extract video duration from TikTok's hydration data (in seconds)
 */
export function extractTikTokDurationSeconds(html: string): number | null {
  const scriptMatch = html.match(
    /<script[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i
  )
  if (!scriptMatch?.[1]) {
    return null
  }

  try {
    const data = JSON.parse(scriptMatch[1]) as {
      __DEFAULT_SCOPE__?: {
        'webapp.video-detail'?: {
          itemInfo?: {
            itemStruct?: {
              video?: {
                duration?: number
              }
            }
          }
        }
      }
    }

    const duration =
      data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct?.video?.duration

    return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? duration
      : null
  } catch {
    return null
  }
}

/**
 * Fetch TikTok captions from the subtitle URL and parse WebVTT format.
 */
export async function fetchTikTokCaptions(
  fetchImpl: typeof fetch,
  subtitleInfos: TikTokSubtitleInfo[]
): Promise<{ text: string; segments: TranscriptSegment[] } | null> {
  // Prefer English, then fall back to first available
  const englishInfo = subtitleInfos.find(
    (info) =>
      info.languageCode.toLowerCase().startsWith('en') ||
      info.languageCode.toLowerCase() === 'eng'
  )
  const selectedInfo = englishInfo ?? subtitleInfos[0]

  if (!selectedInfo?.url) {
    return null
  }

  try {
    const response = await fetchImpl(selectedInfo.url, {
      headers: {
        Accept: 'text/vtt, */*',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      },
    })

    if (!response.ok) {
      return null
    }

    const vttContent = await response.text()
    return parseWebVtt(vttContent)
  } catch {
    return null
  }
}

/**
 * Parse WebVTT content into text and segments.
 */
function parseWebVtt(vtt: string): { text: string; segments: TranscriptSegment[] } | null {
  const lines = vtt.split(/\r?\n/)
  const segments: TranscriptSegment[] = []
  const textParts: string[] = []

  let i = 0
  // Skip WebVTT header
  while (i < lines.length && !lines[i]?.includes('-->')) {
    i++
  }

  while (i < lines.length) {
    const line = lines[i]?.trim() ?? ''

    // Check for timestamp line
    const timestampMatch = line.match(
      /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
    )
    if (!timestampMatch) {
      // Also try MM:SS.mmm format
      const shortMatch = line.match(
        /^(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2})[.,](\d{3})/
      )
      if (shortMatch) {
        const startMs =
          Number(shortMatch[1]) * 60 * 1000 +
          Number(shortMatch[2]) * 1000 +
          Number(shortMatch[3])
        const endMs =
          Number(shortMatch[4]) * 60 * 1000 +
          Number(shortMatch[5]) * 1000 +
          Number(shortMatch[6])

        i++
        const cueLines: string[] = []
        while (i < lines.length && lines[i]?.trim() !== '') {
          cueLines.push(lines[i]?.trim() ?? '')
          i++
        }

        const cueText = cueLines.join(' ').replace(/<[^>]+>/g, '').trim()
        if (cueText) {
          segments.push({ startMs, endMs, text: cueText })
          textParts.push(cueText)
        }
        continue
      }
      i++
      continue
    }

    const startMs =
      Number(timestampMatch[1]) * 3600 * 1000 +
      Number(timestampMatch[2]) * 60 * 1000 +
      Number(timestampMatch[3]) * 1000 +
      Number(timestampMatch[4])
    const endMs =
      Number(timestampMatch[5]) * 3600 * 1000 +
      Number(timestampMatch[6]) * 60 * 1000 +
      Number(timestampMatch[7]) * 1000 +
      Number(timestampMatch[8])

    i++
    const cueLines: string[] = []
    while (i < lines.length && lines[i]?.trim() !== '') {
      cueLines.push(lines[i]?.trim() ?? '')
      i++
    }

    const cueText = cueLines.join(' ').replace(/<[^>]+>/g, '').trim()
    if (cueText) {
      segments.push({ startMs, endMs, text: cueText })
      textParts.push(cueText)
    }
  }

  if (segments.length === 0) {
    return null
  }

  return {
    text: textParts.join(' '),
    segments,
  }
}
