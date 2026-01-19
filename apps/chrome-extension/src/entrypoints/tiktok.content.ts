import { defineContentScript } from 'wxt/utils/define-content-script'

interface TikTokSubtitleInfo {
  languageCode: string
  url: string
  urlExpire: number
  format: string
}

interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

type TikTokTranscriptRequest = { type: 'tiktok-transcript' }
type TikTokTranscriptResponse =
  | {
      ok: true
      text: string
      segments: TranscriptSegment[]
      source: 'tiktok-captions'
      durationSeconds: number | null
    }
  | { ok: false; error: string; reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' }

/**
 * Extract subtitle info from TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag.
 */
function extractTikTokSubtitleInfos(): TikTokSubtitleInfo[] {
  const scriptEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
  if (!scriptEl?.textContent) {
    return []
  }

  try {
    const data = JSON.parse(scriptEl.textContent) as {
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
function extractTikTokDurationSeconds(): number | null {
  const scriptEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
  if (!scriptEl?.textContent) {
    return null
  }

  try {
    const data = JSON.parse(scriptEl.textContent) as {
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

    // Check for timestamp line (HH:MM:SS.mmm format)
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

/**
 * Fetch and parse TikTok captions from the subtitle URL.
 */
async function fetchTikTokCaptions(
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
    const response = await fetch(selectedInfo.url, {
      headers: {
        Accept: 'text/vtt, */*',
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

async function extractTranscript(): Promise<TikTokTranscriptResponse> {
  const subtitleInfos = extractTikTokSubtitleInfos()
  const durationSeconds = extractTikTokDurationSeconds()

  if (subtitleInfos.length === 0) {
    return {
      ok: false,
      error: 'No captions available for this TikTok video',
      reason: 'no_captions',
    }
  }

  const captions = await fetchTikTokCaptions(subtitleInfos)

  if (!captions) {
    return {
      ok: false,
      error: 'Failed to fetch or parse TikTok captions',
      reason: 'fetch_failed',
    }
  }

  return {
    ok: true,
    text: captions.text,
    segments: captions.segments,
    source: 'tiktok-captions',
    durationSeconds,
  }
}

export default defineContentScript({
  matches: ['*://*.tiktok.com/*', '*://vm.tiktok.com/*'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_tiktok_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    chrome.runtime.onMessage.addListener(
      (
        message: TikTokTranscriptRequest,
        _sender,
        sendResponse: (response: TikTokTranscriptResponse) => void
      ) => {
        if (message?.type === 'tiktok-transcript') {
          extractTranscript()
            .then(sendResponse)
            .catch((err) => {
              console.error('[TikTok Content Script] Extraction error:', err)
              sendResponse({
                ok: false,
                error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
                reason: 'extraction_error',
              })
            })
          return true // Keep channel open for async response
        }
        return undefined
      }
    )
  },
})
