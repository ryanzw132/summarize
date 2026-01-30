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
  | { ok: false; error: string; reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' | 'is_ad' }

type TikTokMetadataRequest = { type: 'tiktok-metadata' }
type TikTokScrollNextRequest = { type: 'tiktok-scroll-next' }
type TikTokScrollNextResponse = { ok: boolean }
type TikTokAdCheckRequest = { type: 'tiktok-is-ad' }
type TikTokAdCheckResponse = { isAd: boolean; reason?: string }
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

    // Fallback to DOM extraction if hydration data doesn't have stats
    const domStats = extractTikTokStatsFromDOM()
    if (stats.views === null) stats.views = domStats.views
    if (stats.likes === null) stats.likes = domStats.likes
    if (stats.comments === null) stats.comments = domStats.comments
    if (stats.shares === null) stats.shares = domStats.shares

    return { title, description, creator, postedAt, hashtags, platform: 'tiktok', stats }
  } catch {
    // Try DOM extraction even if main extraction fails
    const domStats = extractTikTokStatsFromDOM()
    return {
      ...emptyResponse,
      stats: domStats,
    }
  }
}

/**
 * Parse a number string like "1.2K", "3.4M", "1,234" to an integer.
 */
function parseTikTokNumber(text: string): number | null {
  if (!text) return null
  const cleaned = text.trim().toLowerCase().replace(/\s/g, '')

  // Handle K, M, B suffixes
  const suffixMatch = cleaned.match(/^([\d.,]+)\s*([kmb])$/i)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(',', '.'))
    if (!Number.isFinite(num)) return null
    const suffix = suffixMatch[2].toLowerCase()
    if (suffix === 'k') return Math.round(num * 1000)
    if (suffix === 'm') return Math.round(num * 1000000)
    if (suffix === 'b') return Math.round(num * 1000000000)
  }

  // Handle plain numbers with commas
  const plainNum = parseInt(cleaned.replace(/[,.\s]/g, ''), 10)
  return Number.isFinite(plainNum) ? plainNum : null
}

/**
 * Extract stats from TikTok's DOM elements as fallback.
 * TikTok shows stats in the action bar on the right side of videos.
 */
function extractTikTokStatsFromDOM(): { views: number | null; likes: number | null; comments: number | null; shares: number | null } {
  const stats = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null }

  try {
    // Find the active video container
    const activeVideo = findActiveVideoElement()
    const videoContainer = activeVideo?.closest('[class*="DivItemContainer"], [class*="DivVideoWrapper"], [data-e2e="recommend-list-item-container"]')
      || document.querySelector('[class*="DivItemContainer"], [class*="DivVideoWrapper"]')
      || document

    debugLog('Extracting stats from DOM, container:', videoContainer)

    // TikTok action buttons are typically in a vertical bar on the right
    // Each button has an icon and a count displayed as strong or span text

    // Method 1: Look for data-e2e attributes (most reliable)
    const likeCount = videoContainer.querySelector('[data-e2e="like-count"], [data-e2e="browse-like-count"]')
    if (likeCount) {
      stats.likes = parseTikTokNumber(likeCount.textContent || '')
      debugLog('Found likes from data-e2e:', stats.likes)
    }

    const commentCount = videoContainer.querySelector('[data-e2e="comment-count"], [data-e2e="browse-comment-count"]')
    if (commentCount) {
      stats.comments = parseTikTokNumber(commentCount.textContent || '')
      debugLog('Found comments from data-e2e:', stats.comments)
    }

    const shareCount = videoContainer.querySelector('[data-e2e="share-count"], [data-e2e="undefined-count"]')
    if (shareCount) {
      stats.shares = parseTikTokNumber(shareCount.textContent || '')
      debugLog('Found shares from data-e2e:', stats.shares)
    }

    // View count is sometimes in a different location
    const viewCount = videoContainer.querySelector('[data-e2e="video-views"], [data-e2e="browse-video-views"]')
    if (viewCount) {
      stats.views = parseTikTokNumber(viewCount.textContent || '')
      debugLog('Found views from data-e2e:', stats.views)
    }

    // Method 2: Look for strong elements near action buttons
    // TikTok often uses <strong> for the count numbers
    if (stats.likes === null || stats.comments === null || stats.shares === null) {
      const strongElements = videoContainer.querySelectorAll('strong, [class*="StrongText"]')
      for (const strong of strongElements) {
        const text = strong.textContent?.trim() || ''
        // Check if this looks like a count (number or number with K/M suffix)
        if (!text.match(/^[\d.,]+[KMB]?$/i)) continue

        const count = parseTikTokNumber(text)
        if (count === null) continue

        // Try to determine what type of stat this is by looking at nearby elements
        const parent = strong.closest('button, [role="button"], a, div')
        if (!parent) continue

        const parentClasses = parent.className?.toLowerCase() || ''
        const parentText = parent.textContent?.toLowerCase() || ''
        const ariaLabel = parent.getAttribute('aria-label')?.toLowerCase() || ''

        // Determine stat type from context
        if (stats.likes === null && (parentClasses.includes('like') || ariaLabel.includes('like') || parentText.includes('like'))) {
          stats.likes = count
          debugLog('Found likes from strong:', count)
        } else if (stats.comments === null && (parentClasses.includes('comment') || ariaLabel.includes('comment') || parentText.includes('comment'))) {
          stats.comments = count
          debugLog('Found comments from strong:', count)
        } else if (stats.shares === null && (parentClasses.includes('share') || ariaLabel.includes('share') || parentText.includes('share'))) {
          stats.shares = count
          debugLog('Found shares from strong:', count)
        }
      }
    }

    // Method 3: Look for spans with class containing "Count"
    if (stats.likes === null || stats.comments === null || stats.shares === null) {
      const countSpans = videoContainer.querySelectorAll('[class*="Count"], [class*="ActionItem"] span')
      for (const span of countSpans) {
        const text = span.textContent?.trim() || ''
        if (!text.match(/^[\d.,]+[KMB]?$/i)) continue

        const count = parseTikTokNumber(text)
        if (count === null) continue

        // Check parent for type hint
        const parent = span.closest('[class*="Like"], [class*="Comment"], [class*="Share"], [class*="ActionItem"]')
        if (!parent) continue

        const parentClasses = parent.className?.toLowerCase() || ''
        if (stats.likes === null && parentClasses.includes('like')) {
          stats.likes = count
        } else if (stats.comments === null && parentClasses.includes('comment')) {
          stats.comments = count
        } else if (stats.shares === null && parentClasses.includes('share')) {
          stats.shares = count
        }
      }
    }

    debugLog('Extracted TikTok DOM stats:', stats)
  } catch (err) {
    debugLog('Error extracting TikTok DOM stats:', err)
  }

  return stats
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

/**
 * Read JSON data from script tag or window object.
 * Tries window object first (has latest data after hydration), falls back to script tag.
 */
function readJsonScript(id: string): unknown | null {
  // First, try to read from window object via page context injection
  // This has the latest data after TikTok's client-side hydration updates
  try {
    const windowData = readFromWindowObject(id)
    if (windowData) {
      debugLog(`Read ${id} from window object`)
      return windowData
    }
  } catch {
    // Window object read failed, try script tag
  }

  // Fall back to script tag (works for initial page load)
  const scriptEl = document.getElementById(id)
  if (scriptEl?.textContent) {
    try {
      const scriptData = JSON.parse(scriptEl.textContent)
      debugLog(`Read ${id} from script tag`)
      return scriptData
    } catch {
      // Parse failed
    }
  }

  return null
}

/**
 * Inject a script into the page context to read window objects.
 * Returns the data synchronously using a data attribute hack.
 * Note: May be blocked by CSP on some pages.
 */
function readFromWindowObject(varName: string): unknown | null {
  try {
    // Create a unique ID for this request
    const requestId = `tiktok_data_${Date.now()}_${Math.random().toString(36).slice(2)}`

    // Create a data element to receive the result
    const dataEl = document.createElement('div')
    dataEl.id = requestId
    dataEl.style.display = 'none'
    document.body.appendChild(dataEl)

    // Inject script to read the window object
    // Only serialize the needed parts to avoid performance issues with large objects
    const script = document.createElement('script')
    script.textContent = `
      (function() {
        try {
          let data = window['${varName}'];
          const el = document.getElementById('${requestId}');
          if (!el || !data) return;

          // For SIGI_STATE, only extract ItemModule to reduce size
          if ('${varName}' === 'SIGI_STATE' && data.ItemModule) {
            data = { ItemModule: data.ItemModule };
          }

          // Limit serialization size
          const str = JSON.stringify(data);
          if (str && str.length < 1000000) {
            el.setAttribute('data-result', str);
          }
        } catch (e) {
          // Ignore serialization errors
        }
      })();
    `
    document.body.appendChild(script)
    script.remove()

    // Read the result
    const result = dataEl.getAttribute('data-result')
    dataEl.remove()

    if (result) {
      return JSON.parse(result)
    }
  } catch {
    // CSP might block inline scripts
    debugLog('Page context injection failed (possibly CSP blocked)')
  }

  return null
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
 * Find the video element that is most likely the "active" one (visible and playing).
 */
function findActiveVideoElement(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video'))

  // Prefer videos that are playing
  const playingVideo = videos.find(v => !v.paused && v.readyState >= 2)
  if (playingVideo) return playingVideo

  // Find videos in the center of the viewport
  const viewportCenter = window.innerHeight / 2
  let bestVideo: HTMLVideoElement | null = null
  let bestDistance = Infinity

  for (const video of videos) {
    const rect = video.getBoundingClientRect()
    // Check if video is visible in viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue

    const videoCenter = rect.top + rect.height / 2
    const distance = Math.abs(videoCenter - viewportCenter)

    if (distance < bestDistance) {
      bestDistance = distance
      bestVideo = video
    }
  }

  return bestVideo
}

/**
 * Extract active video ID from DOM elements on FYP/Explore/Profile pages.
 * TikTok uses data attributes to identify the active video container.
 */
function extractActiveVideoIdFromDOM(): string | null {
  debugLog('Extracting active video ID from DOM')

  // Method 1: Find the most visible/active video element first
  const activeVideo = findActiveVideoElement()
  if (activeVideo) {
    debugLog('Found active video element')
    // Walk up to find container with video ID
    let parent: Element | null = activeVideo
    while (parent) {
      const id = parent.getAttribute('data-video-id')
        || parent.getAttribute('data-item-id')
        || parent.getAttribute('data-id')
      if (id) {
        debugLog('Found video ID from parent:', id)
        return id
      }

      // Also check for ID in class names (TikTok sometimes embeds IDs there)
      const className = parent.className || ''
      const classIdMatch = className.match(/video-(\d{15,})/)
      if (classIdMatch) {
        debugLog('Found video ID from class:', classIdMatch[1])
        return classIdMatch[1]
      }

      parent = parent.parentElement
    }
  }

  // Method 2: Look for active video container with data-e2e attributes
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
    if (videoId) {
      debugLog('Found video ID from container:', videoId)
      return videoId
    }

    // Try to find it in nested elements
    const nestedWithId = container.querySelector('[data-video-id], [data-item-id], [data-id]')
    if (nestedWithId) {
      const id = nestedWithId.getAttribute('data-video-id')
        || nestedWithId.getAttribute('data-item-id')
        || nestedWithId.getAttribute('data-id')
      if (id) {
        debugLog('Found video ID from nested:', id)
        return id
      }
    }
  }

  // Method 3: Parse from any visible video link on the page
  const videoLinks = document.querySelectorAll('a[href*="/video/"]')
  for (const link of videoLinks) {
    const href = link.getAttribute('href') || ''
    const match = href.match(/\/video\/(\d+)/)
    if (match) {
      // Check if this link is in the viewport center area
      const rect = link.getBoundingClientRect()
      const viewportCenter = window.innerHeight / 2
      if (rect.top < viewportCenter && rect.bottom > viewportCenter) {
        debugLog('Found video ID from link:', match[1])
        return match[1]
      }
    }
  }

  debugLog('Could not find active video ID from DOM')
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

// Track the last seen video ID to detect changes
let lastSeenVideoId: string | null = null

/**
 * Check if the current video is an advertisement.
 * TikTok ads have specific indicators in the UI.
 *
 * IMPORTANT: Be very conservative here - only flag actual ads.
 * False positives cause ALL videos to be skipped!
 */
function isCurrentVideoAd(): TikTokAdCheckResponse {
  debugLog('Checking if current video is an ad')

  // Helper to check if element is visible
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
  }

  // Common localized "Sponsored" variants
  const sponsoredVariants = [
    'sponsored', 'ad', 'anzeige', 'gesponsert', // English, German
    'publicité', 'sponsorisé', 'annonce', // French
    'sponsorizzato', 'annuncio', // Italian
    'patrocinado', 'anuncio', // Spanish, Portuguese
    '広告', 'スポンサー', // Japanese
    '광고', '스폰서', // Korean
    '赞助', '广告', // Chinese
    'promoted', // English alternative
  ]

  // Method 1: Check itemStruct for ad indicators (most reliable)
  // TikTok's hydration data contains explicit ad flags
  const itemStruct = extractTikTokItemStruct()
  if (itemStruct) {
    const item = itemStruct as Record<string, unknown>

    // Check for explicit ad flag - this is definitive
    if (item.isAd === true) {
      debugLog('Found isAd=true in itemStruct')
      return { isAd: true, reason: 'Ad flag in video data' }
    }

    // Check author for ad virtual flag
    const author = item.author as Record<string, unknown> | undefined
    if (author?.isADVirtual === true) {
      debugLog('Found ad virtual author')
      return { isAd: true, reason: 'Ad virtual author' }
    }
  }

  // Method 2: Check for TikTok's specific ad badge element
  // Only use exact data-e2e attribute, not wildcard, and verify visibility
  const adBadge = document.querySelector('[data-e2e="video-ad-badge"]')
  if (adBadge && isVisible(adBadge)) {
    debugLog('Found visible ad badge element')
    return { isAd: true, reason: 'Ad badge detected' }
  }

  // Method 3: Look for "Sponsored" label near the active video
  // Be very specific - only check elements that are definitely ad labels
  const activeVideo = findActiveVideoElement()
  if (activeVideo) {
    const videoContainer = activeVideo.closest('[class*="DivItemContainer"], [class*="DivVideoWrapper"], [data-e2e="recommend-list-item-container"]')
    if (videoContainer) {
      // Look for spans that contain exactly sponsored text (localized)
      const allSpans = videoContainer.querySelectorAll('span')
      for (const span of allSpans) {
        const text = span.textContent?.trim().toLowerCase() || ''
        // Must be exactly a sponsored variant - not part of longer text
        if (sponsoredVariants.includes(text) && isVisible(span)) {
          debugLog('Found exact Sponsored text:', text)
          return { isAd: true, reason: 'Sponsored content' }
        }
      }
    }
  }

  debugLog('Not an ad')
  return { isAd: false }
}

/**
 * Get the current active video's identifier (ID or src hash).
 */
function getCurrentVideoIdentifier(): string | null {
  // Try video ID first
  const videoId = getActiveVideoId()
  if (videoId) return videoId

  // Fall back to video src as identifier
  const activeVideo = findActiveVideoElement()
  if (activeVideo?.src) {
    // Use a hash of the src as identifier
    return activeVideo.src.slice(0, 100)
  }

  return null
}

/**
 * Scroll to the next TikTok video in feed.
 */
function scrollToNextVideo(): TikTokScrollNextResponse {
  try {
    // Remember current video to detect if scroll worked
    lastSeenVideoId = getCurrentVideoIdentifier()
    debugLog('Current video before scroll:', lastSeenVideoId)

    // TikTok uses a vertical swipe to navigate between videos
    // Try multiple methods

    // Method 1: Try to find navigation button (down arrow)
    const downButton = document.querySelector('[data-e2e="arrow-right"]') as HTMLElement
      || document.querySelector('[data-e2e="arrow-down"]') as HTMLElement
      || document.querySelector('button[data-e2e="down-arrow"]') as HTMLElement
      || document.querySelector('button[class*="ButtonBasicButtonContainer"][class*="StyledArrowDown"]') as HTMLElement
      || document.querySelector('button[class*="DivArrowContainer"]:last-child') as HTMLElement

    if (downButton) {
      debugLog('Found down button, clicking')
      downButton.click()
      return { ok: true }
    }

    // Method 2: Simulate keyboard down arrow
    debugLog('Simulating ArrowDown key')
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
    })
    document.dispatchEvent(event)

    // Also dispatch on the video container
    const videoContainer = document.querySelector('[class*="DivVideoFeedV2"]')
      || document.querySelector('[class*="DivItemContainer"]')?.parentElement
      || document.querySelector('[id*="main-content-video_detail"]')
      || document.querySelector('main')

    if (videoContainer) {
      videoContainer.dispatchEvent(event)
      debugLog('Also scrolling container')
      videoContainer.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    } else {
      debugLog('Scrolling window')
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    }

    return { ok: true }
  } catch (err) {
    debugLog('Scroll error:', err)
    return { ok: false }
  }
}

async function extractTranscript(): Promise<TikTokTranscriptResponse> {
  debugLog('Starting transcript extraction')
  debugLog('URL:', window.location.href)

  // On FYP/explore pages, we might need to retry as data loads dynamically
  const maxRetries = 3
  let subtitleInfos: TikTokSubtitleInfo[] = []
  let durationSeconds: number | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const videoId = getActiveVideoId()
    debugLog(`Attempt ${attempt + 1}: Active video ID:`, videoId)

    subtitleInfos = extractTikTokSubtitleInfos()
    durationSeconds = extractTikTokDurationSeconds()

    debugLog('Found subtitle infos:', subtitleInfos.length)
    debugLog('Video duration:', durationSeconds)

    if (subtitleInfos.length > 0) {
      break
    }

    // Wait a bit and retry (data might be loading)
    if (attempt < maxRetries - 1) {
      debugLog('No subtitles found, waiting before retry...')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  if (subtitleInfos.length === 0) {
    debugLog('No captions found after retries')
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
        message: TikTokTranscriptRequest | TikTokMetadataRequest | TikTokScrollNextRequest | TikTokAdCheckRequest,
        _sender,
        sendResponse: (response: TikTokTranscriptResponse | TikTokMetadataResponse | TikTokScrollNextResponse | TikTokAdCheckResponse) => void
      ) => {
        if (message?.type === 'tiktok-transcript') {
          // First check if it's an ad
          const adCheck = isCurrentVideoAd()
          if (adCheck.isAd) {
            sendResponse({
              ok: false,
              error: `Skipping ad: ${adCheck.reason}`,
              reason: 'is_ad',
            })
            return false
          }

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
        if (message?.type === 'tiktok-is-ad') {
          sendResponse(isCurrentVideoAd())
          return false
        }
        return undefined
      }
    )
  },
})
