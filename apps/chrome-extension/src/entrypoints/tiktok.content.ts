import { defineContentScript } from 'wxt/utils/define-content-script'

// Debug flag - set to true to enable verbose logging for troubleshooting
const DEBUG = false

// Debug logging helper
function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log(`[TikTok Content Script] ${message}`, ...args)
  }
}

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
 * Extract subtitle info from TikTok's hydration data.
 * Searches multiple schema locations for subtitle data.
 */
function extractTikTokSubtitleInfos(): TikTokSubtitleInfo[] {
  const itemStruct = extractTikTokItemStruct()
  if (!itemStruct) return []

  // Use the helper to find subtitles in various schema locations
  let subtitleInfos: unknown[] = itemStruct.video
    ? extractSubtitlesFromVideoObject(itemStruct.video)
    : []

  if (subtitleInfos.length === 0) {
    // Fallback: sometimes subtitles live at the itemStruct level
    subtitleInfos = extractSubtitlesFromVideoObject(itemStruct as unknown)
  }

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
    const parseCount = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
      if (typeof value === 'string') {
        const cleaned = value.trim().toLowerCase()
        const normalizeCompactNumber = (raw: string): string => {
          const compact = raw.replace(/[\s\u00a0]/g, '')
          const hasComma = compact.includes(',')
          const hasDot = compact.includes('.')
          if (hasComma && hasDot) {
            const lastComma = compact.lastIndexOf(',')
            const lastDot = compact.lastIndexOf('.')
            const decimalIndex = Math.max(lastComma, lastDot)
            const integerPart = compact.slice(0, decimalIndex).replace(/[.,]/g, '')
            const fractionalPart = compact.slice(decimalIndex + 1).replace(/[.,]/g, '')
            return `${integerPart}.${fractionalPart}`
          }
          if (hasComma) {
            const parts = compact.split(',')
            if (parts.length === 2 && parts[1].length <= 2) {
              return `${parts[0]}.${parts[1]}`
            }
            return compact.replace(/,/g, '')
          }
          if (hasDot) {
            const parts = compact.split('.')
            if (parts.length > 2) {
              return compact.replace(/\./g, '')
            }
          }
          return compact
        }

        const suffixMatch = cleaned.match(/([\d.,\s]+)\s*([kmb])\b/i)
        if (suffixMatch) {
          const num = Number.parseFloat(normalizeCompactNumber(suffixMatch[1]))
          if (!Number.isFinite(num) || num < 0) return null
          const suffix = suffixMatch[2].toLowerCase()
          if (suffix === 'k') return Math.round(num * 1000)
          if (suffix === 'm') return Math.round(num * 1000000)
          if (suffix === 'b') return Math.round(num * 1000000000)
        }

        const digitsOnly = normalizeCompactNumber(cleaned).replace(/[^\d]/g, '')
        if (!digitsOnly) return null
        const parsed = Number.parseInt(digitsOnly, 10)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }
    const stats = {
      views: parseCount(statsData?.playCount),
      likes: parseCount(statsData?.diggCount),
      comments: parseCount(statsData?.commentCount),
      shares: parseCount(statsData?.shareCount),
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

      // Try multiple URL keys - TikTok schema varies
      const url =
        (typeof record.Url === 'string' ? record.Url : null) ??
        (typeof record.url === 'string' ? record.url : null) ??
        (typeof record.playUrl === 'string' ? record.playUrl : null) ??
        (typeof record.source === 'string' ? record.source : null)
      if (!url) return null

      // Language code variants
      const languageCode =
        (typeof record.LanguageCodeName === 'string' ? record.LanguageCodeName : null) ??
        (typeof record.LanguageID === 'string' ? record.LanguageID : null) ??
        (typeof record.languageCode === 'string' ? record.languageCode : null) ??
        (typeof record.language === 'string' ? record.language : null) ??
        (typeof record.lang === 'string' ? record.lang : null) ??
        (typeof record.locale === 'string' ? record.locale : null) ??
        'unknown'

      // URL expiration
      const urlExpireRaw =
        (typeof record.UrlExpire === 'number' || typeof record.UrlExpire === 'string')
          ? record.UrlExpire
          : (typeof record.urlExpire === 'number' || typeof record.urlExpire === 'string')
            ? record.urlExpire
            : (typeof record.expire === 'number' || typeof record.expire === 'string')
              ? record.expire
              : 0
      let urlExpire = typeof urlExpireRaw === 'string'
        ? Number.parseInt(urlExpireRaw, 10)
        : urlExpireRaw
      if (!Number.isFinite(urlExpire)) {
        urlExpire = 0
      } else if (urlExpire > 1_000_000_000_000) {
        // Convert ms to seconds if needed
        urlExpire = Math.floor(urlExpire / 1000)
      }

      // Format - support webvtt and json
      let format =
        (typeof record.Format === 'string' ? record.Format : null) ??
        (typeof record.format === 'string' ? record.format : null) ??
        (typeof record.type === 'string' ? record.type : null) ??
        'webvtt'

      // Normalize format strings
      format = format.toLowerCase()
      if (format.includes('vtt') || format.includes('webvtt')) {
        format = 'webvtt'
      } else if (format.includes('json')) {
        format = 'json'
      }

      return { languageCode, url, urlExpire, format }
    })
    .filter((info): info is TikTokSubtitleInfo => Boolean(info))
}

/**
 * Extract subtitles from various schema locations in video object
 */
function extractSubtitlesFromVideoObject(video: unknown): unknown[] {
  if (!video || typeof video !== 'object') return []
  const record = video as Record<string, unknown>

  // Try multiple possible subtitle keys
  const possibleKeys = [
    'subtitleInfos',
    'subtitleInfo',
    'subTitles',
    'subtitles',
    'captions',
    'captionInfos',
    'closedCaptions',
  ]

  for (const key of possibleKeys) {
    const value = record[key]
    if (Array.isArray(value) && value.length > 0) {
      return value
    }
  }

  return []
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
  const record = data as Record<string, unknown>
  const itemModule = record.ItemModule as Record<string, unknown> | undefined
  if (!itemModule || typeof itemModule !== 'object') return null

  // Get video ID from URL or DOM (for FYP/Explore pages)
  const videoId = getActiveVideoId()

  // Try direct lookup by video ID
  if (videoId) {
    const candidate = itemModule[videoId]
    if (candidate && typeof candidate === 'object') {
      return candidate as TikTokItemStruct
    }
  }

  // Try to find by matching itemStruct.id or video.id
  for (const [key, value] of Object.entries(itemModule)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>

    // Check if this item's ID matches
    const itemId = item.id || item.videoId || (item.video as Record<string, unknown>)?.id
    if (videoId && itemId === videoId) {
      return item as TikTokItemStruct
    }

    // If we have no video ID, return the first valid item
    if (!videoId && item.video) {
      return item as TikTokItemStruct
    }
  }

  // Last resort: return first item with video data
  const first = Object.values(itemModule).find((value) => {
    if (!value || typeof value !== 'object') return false
    const item = value as Record<string, unknown>
    return item.video || item.desc !== undefined
  }) as TikTokItemStruct | undefined
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

/**
 * Extract video ID from URL path
 */
function extractTikTokVideoIdFromUrl(): string | null {
  const url = window.location.href
  const match = url.match(/\/video\/(\d+)/) || url.match(/\/v\/(\d+)/)
  return match?.[1] ?? null
}

/**
 * Extract active video ID from DOM elements on FYP/Explore/Profile pages.
 * TikTok uses data attributes to identify the active video container.
 */
function extractActiveVideoIdFromDOM(): string | null {
  // Method 1: Look for active video container with data-e2e attributes
  const activeContainers = [
    // FYP/Explore active video
    document.querySelector('[data-e2e="recommend-list-item-container"][class*="active"]'),
    document.querySelector('[data-e2e="browse-video"][class*="active"]'),
    document.querySelector('[data-e2e="video-container"][class*="active"]'),
    // Video player wrapper with video ID
    document.querySelector('[data-e2e="video-player-container"]'),
    // Currently playing video (check for playing state)
    document.querySelector('video[src]:not([src=""])')?.closest('[data-e2e*="video"]'),
  ]

  for (const container of activeContainers) {
    if (!container) continue

    // Try to get video ID from data attributes
    const videoId = container.getAttribute('data-video-id')
      || container.getAttribute('data-item-id')
      || container.getAttribute('data-id')
    if (videoId) return videoId

    // Try to find it in nested elements
    const nestedWithId = container.querySelector('[data-video-id], [data-item-id], [data-id]')
    if (nestedWithId) {
      const id = nestedWithId.getAttribute('data-video-id')
        || nestedWithId.getAttribute('data-item-id')
        || nestedWithId.getAttribute('data-id')
      if (id) return id
    }
  }

  // Method 2: Find the video element that's currently visible/playing
  const videos = document.querySelectorAll('video')
  for (const video of videos) {
    // Check if video is playing or has substantial playback
    if (!video.paused || video.currentTime > 0) {
      // Walk up to find container with video ID
      let parent: Element | null = video
      while (parent) {
        const id = parent.getAttribute('data-video-id')
          || parent.getAttribute('data-item-id')
          || parent.getAttribute('data-id')
        if (id) return id

        // Also check for ID in class names (TikTok sometimes embeds IDs there)
        const className = parent.className || ''
        const classIdMatch = className.match(/video-(\d{15,})/)
        if (classIdMatch) return classIdMatch[1]

        parent = parent.parentElement
      }
    }
  }

  // Method 3: Parse from any visible video link on the page
  const videoLinks = document.querySelectorAll('a[href*="/video/"]')
  for (const link of videoLinks) {
    const href = link.getAttribute('href') || ''
    const match = href.match(/\/video\/(\d+)/)
    if (match) {
      // Check if this link is in the viewport (likely the active one)
      const rect = link.getBoundingClientRect()
      if (rect.top >= 0 && rect.top < window.innerHeight) {
        return match[1]
      }
    }
  }

  return null
}

/**
 * Get the best video ID - from URL first, then from DOM
 */
function getActiveVideoId(): string | null {
  // URL is most reliable when available
  const urlId = extractTikTokVideoIdFromUrl()
  if (urlId) return urlId

  // Fall back to DOM extraction for FYP/Explore pages
  return extractActiveVideoIdFromDOM()
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
      /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})(?:\s+.*)?$/
    )
    if (!timestampMatch) {
      // Also try MM:SS.mmm format
      const shortMatch = line.match(
        /^(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2})[.,](\d{3})(?:\s+.*)?$/
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

function isEnglishSubtitle(languageCode: string): boolean {
  const lower = languageCode.toLowerCase()
  return lower === 'eng'
    || lower.startsWith('en')
    || lower.includes('english')
}

function selectBestSubtitleInfo(subtitleInfos: TikTokSubtitleInfo[]): TikTokSubtitleInfo | null {
  if (!Array.isArray(subtitleInfos) || subtitleInfos.length === 0) return null

  const nowSeconds = Math.floor(Date.now() / 1000)
  const nonExpired = subtitleInfos.filter((info) => {
    if (!info.urlExpire || info.urlExpire <= 0) return true
    return info.urlExpire > nowSeconds + 5
  })
  const candidates = nonExpired.length > 0 ? nonExpired : subtitleInfos

  const englishInfo = candidates.find((info) => isEnglishSubtitle(info.languageCode))
  return englishInfo ?? candidates[0] ?? null
}

/**
 * Parse JSON transcript format into segments
 */
function parseJsonTranscript(json: string): { text: string; segments: TranscriptSegment[] } | null {
  try {
    const data = JSON.parse(json)

    // Handle various JSON transcript formats
    let segments: TranscriptSegment[] = []

    // Format 1: Array of {start, end/duration, text}
    if (Array.isArray(data)) {
      segments = data
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return null
          const record = item as Record<string, unknown>

          const text = typeof record.text === 'string' ? record.text.trim()
            : typeof record.content === 'string' ? record.content.trim()
            : typeof record.words === 'string' ? record.words.trim()
            : null
          if (!text) return null

          const startMs = typeof record.start === 'number' ? record.start * 1000
            : typeof record.startTime === 'number' ? record.startTime
            : typeof record.from === 'number' ? record.from
            : 0

          const endMs = typeof record.end === 'number' ? record.end * 1000
            : typeof record.endTime === 'number' ? record.endTime
            : typeof record.to === 'number' ? record.to
            : typeof record.duration === 'number' ? startMs + record.duration * 1000
            : startMs + 3000

          return { startMs, endMs, text }
        })
        .filter((seg): seg is TranscriptSegment => seg !== null)
    }
    // Format 2: Object with segments/cues array
    else if (data && typeof data === 'object') {
      const cues = (data as Record<string, unknown>).segments
        || (data as Record<string, unknown>).cues
        || (data as Record<string, unknown>).transcript
      if (Array.isArray(cues)) {
        return parseJsonTranscript(JSON.stringify(cues))
      }
    }

    if (segments.length === 0) return null

    const text = segments.map(s => s.text).join(' ')
    return { text, segments }
  } catch {
    return null
  }
}

/**
 * Fetch and parse TikTok captions from the subtitle URL.
 * Supports WebVTT and JSON formats with retry logic.
 */
async function fetchTikTokCaptions(
  subtitleInfos: TikTokSubtitleInfo[]
): Promise<{ text: string; segments: TranscriptSegment[] } | null> {
  const selectedInfo = selectBestSubtitleInfo(subtitleInfos)

  if (!selectedInfo?.url) {
    return null
  }

  // Retry logic with cache-busting for stale URLs
  const maxRetries = 2
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    try {
      // Add cache-busting on retry
      let url = selectedInfo.url
      if (attempt > 0 && !url.includes('_retry=')) {
        url += (url.includes('?') ? '&' : '?') + '_retry=' + Date.now()
      }

      const response = await fetch(url, {
        headers: {
          Accept: selectedInfo.format === 'json'
            ? 'application/json, text/plain, */*'
            : 'text/vtt, text/plain, */*',
        },
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'include',
      })

      if (!response.ok) {
        // If URL might be expired, try next attempt
        if (response.status === 403 || response.status === 410) {
          continue
        }
        return null
      }

      const content = await response.text()

      // Parse based on format or auto-detect
      if (selectedInfo.format === 'json' || content.trim().startsWith('{') || content.trim().startsWith('[')) {
        const jsonResult = parseJsonTranscript(content)
        if (jsonResult) return jsonResult
      }

      // Try WebVTT
      const vttResult = parseWebVtt(content)
      if (vttResult) return vttResult

      // If neither worked, try the other format
      if (selectedInfo.format !== 'json') {
        const jsonResult = parseJsonTranscript(content)
        if (jsonResult) return jsonResult
      }

    } catch {
      // Continue to next retry
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return null
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
  debugLog('Starting transcript extraction')
  debugLog('URL:', window.location.href)

  const subtitleInfos = extractTikTokSubtitleInfos()
  const durationSeconds = extractTikTokDurationSeconds()

  debugLog('Found subtitle infos:', subtitleInfos.length)
  debugLog('Video duration:', durationSeconds)

  if (subtitleInfos.length === 0) {
    debugLog('No captions found')
    return {
      ok: false,
      error: 'No captions available for this TikTok video',
      reason: 'no_captions',
    }
  }

  debugLog('Fetching captions from:', subtitleInfos.map((s) => ({ lang: s.languageCode, format: s.format })))
  const captions = await fetchTikTokCaptions(subtitleInfos)

  if (!captions) {
    debugLog('Failed to fetch or parse captions')
    return {
      ok: false,
      error: 'Failed to fetch or parse TikTok captions',
      reason: 'fetch_failed',
    }
  }

  debugLog('Successfully extracted transcript:', { textLength: captions.text.length, segments: captions.segments.length })
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

    // Announce that content script is ready
    void chrome.runtime.sendMessage({ type: 'content-script-ready', scriptType: 'tiktok' }).catch(() => {
      // Ignore errors (background may not be ready yet)
    })

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
