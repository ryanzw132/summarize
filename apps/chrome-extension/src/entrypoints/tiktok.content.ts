import { defineContentScript } from 'wxt/utils/define-content-script'

interface TikTokSubtitleInfo {
  languageCode: string
  url: string
  urlExpire: number
  format: string
}

type TikTokItemStruct = {
  desc?: string
  createTime?: number | string
  author?: {
    uniqueId?: string
    nickname?: string
  }
  stats?: {
    playCount?: number
    diggCount?: number
    commentCount?: number
    shareCount?: number
  }
  video?: {
    subtitleInfos?: unknown
    duration?: number | string
  }
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

type TikTokMetadataRequest = { type: 'tiktok-metadata' }
type TikTokScrollNextRequest = { type: 'tiktok-scroll-next' }
type TikTokScrollNextResponse = { ok: boolean }
type TikTokMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
  platform: 'tiktok'
  stats: {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  }
}

/**
 * Extract subtitle info from TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag.
 */
function extractTikTokSubtitleInfos(): TikTokSubtitleInfo[] {
  const itemStruct = extractTikTokItemStruct()
  const subtitleInfos = itemStruct?.video?.subtitleInfos
  return normalizeSubtitleInfos(subtitleInfos)
}

/**
 * Extract video duration from TikTok's hydration data (in seconds)
 */
function extractTikTokDurationSeconds(): number | null {
  const itemStruct = extractTikTokItemStruct()
  const durationRaw = itemStruct?.video?.duration
  const duration = typeof durationRaw === 'string' ? Number.parseInt(durationRaw, 10) : durationRaw
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : null
}

/**
 * Extract hashtags from a text string.
 */
function extractHashtags(text: string | null): string[] {
  if (!text) return []
  // Match hashtags: # followed by word characters (letters, numbers, underscores)
  // Also supports non-ASCII characters for international hashtags
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g)
  if (!matches) return []
  // Remove duplicates and return
  return [...new Set(matches)]
}

/**
 * Extract video metadata from TikTok's hydration data.
 */
function extractTikTokMetadata(): TikTokMetadataResponse {
  const emptyResponse: TikTokMetadataResponse = {
    title: null,
    description: null,
    creator: null,
    postedAt: null,
    hashtags: [],
    platform: 'tiktok',
    stats: { views: null, likes: null, comments: null, shares: null },
  }

  try {
    const itemStruct = extractTikTokItemStruct()
    if (!itemStruct) {
      return emptyResponse
    }

    // Title and description are the same on TikTok (the video caption)
    const description = itemStruct.desc?.trim() || null
    const title = description

    // Extract hashtags from the description/caption
    const hashtags = extractHashtags(description)

    // Creator: prefer uniqueId (username), fall back to nickname
    const creator = itemStruct.author?.uniqueId
      ? `@${itemStruct.author.uniqueId}`
      : itemStruct.author?.nickname || null

    // Posted date: convert Unix timestamp to readable format
    let postedAt: string | null = null
    const createTime = itemStruct.createTime
    if (createTime) {
      const timestamp = typeof createTime === 'string' ? parseInt(createTime, 10) : createTime
      if (Number.isFinite(timestamp) && timestamp > 0) {
        const date = new Date(timestamp * 1000)
        postedAt = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      }
    }

    // Extract stats (with NaN validation)
    const statsData = itemStruct.stats
    const isValidNumber = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0
    const stats = {
      views: isValidNumber(statsData?.playCount) ? statsData.playCount : null,
      likes: isValidNumber(statsData?.diggCount) ? statsData.diggCount : null,
      comments: isValidNumber(statsData?.commentCount) ? statsData.commentCount : null,
      shares: isValidNumber(statsData?.shareCount) ? statsData.shareCount : null,
    }

    return { title, description, creator, postedAt, hashtags, platform: 'tiktok', stats }
  } catch {
    return emptyResponse
  }
}

function normalizeSubtitleInfos(raw: unknown): TikTokSubtitleInfo[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw
    .map((info) => {
      if (!info || typeof info !== 'object') return null
      const record = info as Record<string, unknown>
      const url =
        (typeof record.Url === 'string' ? record.Url : null) ??
        (typeof record.url === 'string' ? record.url : null)
      if (!url) return null
      const languageCode =
        (typeof record.LanguageCodeName === 'string' ? record.LanguageCodeName : null) ??
        (typeof record.LanguageID === 'string' ? record.LanguageID : null) ??
        (typeof record.languageCode === 'string' ? record.languageCode : null) ??
        (typeof record.language === 'string' ? record.language : null) ??
        'unknown'
      const urlExpire =
        typeof record.UrlExpire === 'number'
          ? record.UrlExpire
          : typeof record.urlExpire === 'number'
            ? record.urlExpire
            : 0
      const format =
        (typeof record.Format === 'string' ? record.Format : null) ??
        (typeof record.format === 'string' ? record.format : null) ??
        'webvtt'
      return { languageCode, url, urlExpire, format }
    })
    .filter((info): info is TikTokSubtitleInfo => Boolean(info))
}

function extractTikTokItemStruct(): TikTokItemStruct | null {
  const universalData = readJsonScript('__UNIVERSAL_DATA_FOR_REHYDRATION__')
  const fromUniversal = extractItemStructFromUniversal(universalData)
  if (fromUniversal) return fromUniversal

  const sigiData = readJsonScript('SIGI_STATE')
  const fromSigi = extractItemStructFromSigiState(sigiData)
  if (fromSigi) return fromSigi

  return null
}

function extractItemStructFromUniversal(data: unknown): TikTokItemStruct | null {
  if (!data || typeof data !== 'object') return null
  const scope = (data as Record<string, unknown>).__DEFAULT_SCOPE__ as Record<string, unknown> | undefined
  if (!scope) return null
  const videoDetail = (scope['webapp.video-detail'] as Record<string, unknown> | undefined)
    ?? (scope['webapp.detail'] as Record<string, unknown> | undefined)
  const itemInfo = videoDetail?.itemInfo as Record<string, unknown> | undefined
  const itemStruct = itemInfo?.itemStruct as TikTokItemStruct | undefined
  return itemStruct ?? null
}

function extractItemStructFromSigiState(data: unknown): TikTokItemStruct | null {
  if (!data || typeof data !== 'object') return null
  const itemModule = (data as Record<string, unknown>).ItemModule as Record<string, unknown> | undefined
  if (!itemModule || typeof itemModule !== 'object') return null

  const videoId = extractTikTokVideoIdFromUrl()
  const candidate = videoId ? itemModule[videoId] : null
  if (candidate && typeof candidate === 'object') {
    return candidate as TikTokItemStruct
  }

  const first = Object.values(itemModule).find((value) => value && typeof value === 'object') as TikTokItemStruct | undefined
  return first ?? null
}

function readJsonScript(id: string): unknown | null {
  const scriptEl = document.getElementById(id)
  if (!scriptEl?.textContent) return null
  try {
    return JSON.parse(scriptEl.textContent)
  } catch {
    return null
  }
}

function extractTikTokVideoIdFromUrl(): string | null {
  const url = window.location.href
  const match = url.match(/\/video\/(\d+)/) || url.match(/\/v\/(\d+)/)
  return match?.[1] ?? null
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
      /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/
    )
    if (!timestampMatch) {
      // Also try MM:SS.mmm format
      const shortMatch = line.match(
        /^(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2})[.,](\d{3})/
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
 * Includes a 10-second timeout to prevent hanging on slow/blocked requests.
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

  try {
    const response = await fetch(selectedInfo.url, {
      headers: {
        Accept: 'text/vtt, */*',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    const vttContent = await response.text()
    return parseWebVtt(vttContent)
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Scroll to the next TikTok video in feed.
 */
function scrollToNextVideo(): TikTokScrollNextResponse {
  try {
    // TikTok uses a vertical swipe to navigate between videos
    // Try to find and click the down arrow button, or simulate scroll

    // Method 1: Try to find navigation button
    const downButton = document.querySelector('[data-e2e="arrow-right"]') as HTMLElement
      || document.querySelector('button[class*="ButtonBasicButtonContainer"][class*="StyledArrowDown"]') as HTMLElement

    if (downButton) {
      downButton.click()
      return { ok: true }
    }

    // Method 2: Simulate keyboard down arrow
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
    })
    document.dispatchEvent(event)

    // Also try scrolling the container
    const videoContainer = document.querySelector('[class*="DivVideoFeedV2"]')
      || document.querySelector('[class*="DivItemContainer"]')?.parentElement
      || document.querySelector('main')

    if (videoContainer) {
      videoContainer.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    } else {
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    }

    return { ok: true }
  } catch {
    return { ok: false }
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
        message: TikTokTranscriptRequest | TikTokMetadataRequest | TikTokScrollNextRequest,
        _sender,
        sendResponse: (response: TikTokTranscriptResponse | TikTokMetadataResponse | TikTokScrollNextResponse) => void
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
        if (message?.type === 'tiktok-metadata') {
          sendResponse(extractTikTokMetadata())
          return false
        }
        if (message?.type === 'tiktok-scroll-next') {
          sendResponse(scrollToNextVideo())
          return false
        }
        return undefined
      }
    )
  },
})
