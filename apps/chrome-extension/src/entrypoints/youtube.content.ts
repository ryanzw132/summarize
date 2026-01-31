import { defineContentScript } from 'wxt/utils/define-content-script'

// Debug flag - set to true to enable verbose logging for troubleshooting
const DEBUG = false

// Debug logging helper
function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log(`[YouTube Content Script] ${message}`, ...args)
  }
}

type YouTubeMetadataRequest = { type: 'youtube-metadata' }
type YouTubeScrollNextRequest = { type: 'youtube-scroll-next' }
type YouTubeTranscriptRequest = { type: 'youtube-transcript' }
type YouTubeScrollNextResponse = { ok: boolean }

interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

type YouTubeTranscriptResponse =
  | {
      ok: true
      text: string
      segments: TranscriptSegment[]
      source: 'youtube-captions'
      durationSeconds: number | null
    }
  | { ok: false; error: string; reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' | 'is_ad' | 'is_music' | 'not_english' }

type YouTubeAdCheckRequest = { type: 'youtube-is-ad' }
type YouTubeAdCheckResponse = { isAd: boolean; reason?: string }

type YouTubeMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
  platform: 'youtube'
  stats: {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  }
}

/**
 * Check if a value is a valid finite non-negative number.
 */
function isValidNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Parse a number from YouTube's display format (e.g., "1.2M", "500K", "1,234")
 * Also handles localized formats by stripping non-numeric characters
 */
function parseYouTubeNumber(text: string | null): number | null {
  if (!text) return null

  // Normalize: remove spaces and convert to lowercase
  const cleaned = text.trim().toLowerCase()

  const normalizeCompactNumber = (value: string): string => {
    const compact = value.replace(/[\s\u00a0]/g, '')
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

  // Handle K/M/B suffixes first (before removing separators)
  const suffixMatch = cleaned.match(/([\d.,\s]+)\s*([kmb])\b/i)
  if (suffixMatch) {
    // Remove all non-digit chars except decimal point
    const numStr = normalizeCompactNumber(suffixMatch[1])
    const num = parseFloat(numStr)
    if (!isValidNumber(num)) return null
    const suffix = suffixMatch[2].toLowerCase()
    if (suffix === 'k') return Math.round(num * 1000)
    if (suffix === 'm') return Math.round(num * 1000000)
    if (suffix === 'b') return Math.round(num * 1000000000)
  }

  // Remove all non-digit characters (handles localized number formats)
  // Keep only digits
  const digitsOnly = normalizeCompactNumber(cleaned).replace(/[^\d]/g, '')
  if (!digitsOnly) return null

  const num = parseInt(digitsOnly, 10)
  return isValidNumber(num) ? num : null
}

/**
 * Extract hashtags from a text string.
 */
function extractHashtags(text: string | null): string[] {
  if (!text) return []
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g)
  if (!matches) return []
  return [...new Set(matches)]
}

/**
 * Type for YouTube player response data
 */
interface YTPlayerResponse {
  videoDetails?: {
    title?: string
    shortDescription?: string
    author?: string
    viewCount?: string
    lengthSeconds?: string
  }
  microformat?: {
    playerMicroformatRenderer?: {
      publishDate?: string
      ownerChannelName?: string
      viewCount?: string
      likeCount?: number
    }
  }
}

/**
 * Try to get ytInitialPlayerResponse from window object or page scripts
 */
function getYTPlayerResponse(): YTPlayerResponse | null {
  // Method 1: Try window object directly (faster and more reliable)
  try {
    const win = window as unknown as { ytInitialPlayerResponse?: YTPlayerResponse }
    if (win.ytInitialPlayerResponse) {
      return win.ytInitialPlayerResponse
    }
  } catch {
    // Window access failed
  }

  // Method 2: Parse from script tags
  const scripts = document.querySelectorAll('script')
  for (const script of scripts) {
    const text = script.textContent || ''

    // Try multiple patterns - YouTube's format varies
    const patterns = [
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|let|const|<\/script>)/s,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
      /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match?.[1]) {
        try {
          return JSON.parse(match[1]) as YTPlayerResponse
        } catch {
          continue
        }
      }
    }
  }

  return null
}

/**
 * Extract metadata from ytInitialPlayerResponse.
 */
function extractFromPlayerResponse(): Partial<YouTubeMetadataResponse> {
  const result: Partial<YouTubeMetadataResponse> = {}

  const data = getYTPlayerResponse()
  if (!data) return result

  if (data.videoDetails) {
    result.title = data.videoDetails.title || null
    result.description = data.videoDetails.shortDescription || null
    result.creator = data.videoDetails.author
      ? `@${data.videoDetails.author}`
      : null

    if (data.videoDetails.viewCount) {
      const viewCount = parseInt(data.videoDetails.viewCount, 10)
      if (isValidNumber(viewCount)) {
        result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
        result.stats.views = viewCount
      }
    }
  }

  if (data.microformat?.playerMicroformatRenderer) {
    const micro = data.microformat.playerMicroformatRenderer
    if (micro.publishDate) {
      const date = new Date(micro.publishDate)
      if (!isNaN(date.getTime())) {
        result.postedAt = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      }
    }
    if (!result.creator && micro.ownerChannelName) {
      result.creator = `@${micro.ownerChannelName}`
    }

    // Some responses include like count in microformat
    if (typeof micro.likeCount === 'number' && isValidNumber(micro.likeCount)) {
      result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
      result.stats.likes = micro.likeCount
    }

    // Fallback view count from microformat
    if (micro.viewCount && !result.stats?.views) {
      const viewCount = parseInt(micro.viewCount, 10)
      if (isValidNumber(viewCount)) {
        result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
        result.stats.views = viewCount
      }
    }
  }

  // Extract hashtags from description
  if (result.description) {
    result.hashtags = extractHashtags(result.description)
  }

  return result
}

/**
 * Try to get ytInitialData from window object or page scripts
 */
function getYTInitialData(): unknown | null {
  // Method 1: Try window object directly
  try {
    const win = window as unknown as { ytInitialData?: unknown }
    if (win.ytInitialData) {
      return win.ytInitialData
    }
  } catch {
    // Window access failed
  }

  // Method 2: Parse from script tags
  const scripts = document.querySelectorAll('script')
  for (const script of scripts) {
    const text = script.textContent || ''
    const patterns = [
      /var\s+ytInitialData\s*=\s*(\{[\s\S]+?\});\s*(?:var|let|const|<\/script>)/,
      /var\s+ytInitialData\s*=\s*(\{[\s\S]+?\});/,
      /ytInitialData\s*=\s*(\{[\s\S]+?\});/,
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match?.[1]) {
        try {
          return JSON.parse(match[1])
        } catch {
          continue
        }
      }
    }
  }

  return null
}

/**
 * Extract metadata from ytInitialData (for Shorts specifically).
 */
function extractFromInitialData(): Partial<YouTubeMetadataResponse> {
  const result: Partial<YouTubeMetadataResponse> = {}

  const data = getYTInitialData()
  if (!data || typeof data !== 'object') return result

  // Helper to find a value by key in nested objects
  const findValue = (obj: unknown, targetKey: string, depth = 0): unknown => {
    if (depth > 15 || !obj || typeof obj !== 'object') return null
    const o = obj as Record<string, unknown>

    if (targetKey in o) return o[targetKey]

    for (const key of Object.keys(o)) {
      if (typeof o[key] === 'object' && o[key] !== null) {
        const found = findValue(o[key], targetKey, depth + 1)
        if (found !== null) return found
      }
    }

    return null
  }

  // Helper to extract text from YouTube's text format
  const extractText = (textObj: unknown): string | null => {
    if (!textObj || typeof textObj !== 'object') return null
    const o = textObj as Record<string, unknown>
    if (typeof o.simpleText === 'string') return o.simpleText
    if (Array.isArray(o.runs)) {
      return (o.runs as Array<{ text?: string }>).map(r => r.text || '').join('')
    }
    return null
  }

  // Find view count
  const viewCountObj = findValue(data, 'viewCount') || findValue(data, 'viewCountText')
  const viewCountText = extractText(viewCountObj)
  if (viewCountText) {
    const viewMatch = viewCountText.match(/([\d,.]+[KMB]?)\s*views?/i)
      || viewCountText.match(/^([\d,.]+[KMB]?)$/)
    if (viewMatch) {
      result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
      result.stats.views = parseYouTubeNumber(viewMatch[1])
    }
  }

  // Find like count (for Shorts)
  const likeCountObj = findValue(data, 'likeCount') || findValue(data, 'likeCountText')
  const likeCountText = extractText(likeCountObj)
  if (likeCountText) {
    const likeMatch = likeCountText.match(/([\d,.]+[KMB]?)/i)
    if (likeMatch) {
      result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
      if (!result.stats.likes) {
        result.stats.likes = parseYouTubeNumber(likeMatch[1])
      }
    }
  }

  // Find comment count
  const commentCountObj = findValue(data, 'commentCount') || findValue(data, 'commentCountText')
  const commentCountText = extractText(commentCountObj)
  if (commentCountText) {
    const commentMatch = commentCountText.match(/([\d,.]+[KMB]?)/i)
    if (commentMatch) {
      result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
      if (!result.stats.comments) {
        result.stats.comments = parseYouTubeNumber(commentMatch[1])
      }
    }
  }

  return result
}

/**
 * Caption track info from YouTube's player response
 */
interface CaptionTrack {
  baseUrl: string
  languageCode: string
  name?: { simpleText?: string }
  kind?: string // 'asr' for auto-generated
}

/**
 * Read data from window object via page-context script injection.
 * Note: This may be blocked by CSP on some sites. Falls back gracefully.
 */
function readFromPageContext(expression: string): unknown | null {
  try {
    const requestId = `yt_data_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const dataEl = document.createElement('div')
    dataEl.id = requestId
    dataEl.style.display = 'none'
    document.body.appendChild(dataEl)

    const script = document.createElement('script')
    // Use a safer serialization that handles potential issues
    script.textContent = `
      (function() {
        try {
          const data = ${expression};
          const el = document.getElementById('${requestId}');
          if (el && data !== undefined && data !== null) {
            // Limit serialization size to prevent performance issues
            const str = JSON.stringify(data);
            if (str && str.length < 500000) {
              el.setAttribute('data-result', str);
            }
          }
        } catch (e) {
          // Ignore serialization errors (circular refs, etc.)
        }
      })();
    `
    document.body.appendChild(script)
    script.remove()

    const result = dataEl.getAttribute('data-result')
    dataEl.remove()

    if (result) {
      return JSON.parse(result)
    }
  } catch {
    // CSP might block inline scripts, fall back to script tag parsing
    debugLog('Page context injection failed (possibly CSP blocked)')
  }
  return null
}

/**
 * Extract caption tracks from YouTube's player response.
 */
function extractCaptionTracks(): CaptionTrack[] {
  // Try to read from window.ytInitialPlayerResponse via page context
  const playerResponse = readFromPageContext('window.ytInitialPlayerResponse')

  if (!playerResponse || typeof playerResponse !== 'object') {
    debugLog('Could not read ytInitialPlayerResponse from page context')
    // Fall back to script tag parsing (used by getYTPlayerResponse)
    const scriptData = getYTPlayerResponse()
    if (!scriptData) return []

    const captions = (scriptData as Record<string, unknown>).captions as Record<string, unknown> | undefined
    const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
    const tracks = renderer?.captionTracks as CaptionTrack[] | undefined
    return Array.isArray(tracks) ? tracks : []
  }

  const record = playerResponse as Record<string, unknown>
  const captions = record.captions as Record<string, unknown> | undefined
  const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
  const tracks = renderer?.captionTracks as CaptionTrack[] | undefined

  return Array.isArray(tracks) ? tracks : []
}

/**
 * Select the best caption track (prefer English manual captions over auto-generated).
 */
function selectBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null

  // ONLY select English tracks - skip non-English content entirely
  // Prefer English manual captions
  const englishManual = tracks.find(t =>
    t.languageCode.startsWith('en') && t.kind !== 'asr'
  )
  if (englishManual) return englishManual

  // Then any English (including auto-generated)
  const english = tracks.find(t => t.languageCode.startsWith('en'))
  if (english) return english

  // No English available - return null to skip this video
  debugLog('No English captions available, skipping video')
  return null
}

/**
 * Parse YouTube's TimedText XML format.
 */
function parseTimedTextXml(xml: string): { text: string; segments: TranscriptSegment[] } | null {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xml, 'text/xml')
    const textElements = doc.querySelectorAll('text')

    if (textElements.length === 0) return null

    const segments: TranscriptSegment[] = []
    const textParts: string[] = []

    for (const el of textElements) {
      const start = parseFloat(el.getAttribute('start') || '0')
      const dur = parseFloat(el.getAttribute('dur') || '0')
      const text = el.textContent?.replace(/&#\d+;/g, match => {
        const code = parseInt(match.slice(2, -1), 10)
        return String.fromCharCode(code)
      }).replace(/<[^>]+>/g, '').trim() || ''

      if (text) {
        segments.push({
          startMs: Math.round(start * 1000),
          endMs: Math.round((start + dur) * 1000),
          text,
        })
        textParts.push(text)
      }
    }

    if (segments.length === 0) return null

    return {
      text: textParts.join(' '),
      segments,
    }
  } catch {
    return null
  }
}

/**
 * Parse YouTube's JSON3 caption format.
 */
function parseJson3Captions(json: string): { text: string; segments: TranscriptSegment[] } | null {
  try {
    const data = JSON.parse(json) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> }
    if (!data.events) return null

    const segments: TranscriptSegment[] = []
    const textParts: string[] = []

    for (const event of data.events) {
      if (!event.segs) continue

      const startMs = event.tStartMs || 0
      const durationMs = event.dDurationMs || 0
      const text = event.segs.map(seg => seg.utf8 || '').join('').trim()

      if (text && text !== '\n') {
        segments.push({
          startMs,
          endMs: startMs + durationMs,
          text,
        })
        textParts.push(text)
      }
    }

    if (segments.length === 0) return null

    return {
      text: textParts.join(' '),
      segments,
    }
  } catch {
    return null
  }
}

/**
 * Fetch and parse captions from YouTube.
 * Tries JSON3 format first, falls back to original URL (usually XML).
 */
async function fetchYouTubeCaptions(track: CaptionTrack): Promise<{ text: string; segments: TranscriptSegment[] } | null> {
  // Try JSON3 format first (easier to parse)
  try {
    const json3Url = new URL(track.baseUrl)
    json3Url.searchParams.set('fmt', 'json3')

    debugLog('Fetching captions (JSON3) from:', json3Url.toString().slice(0, 100))

    const response = await fetch(json3Url.toString(), {
      credentials: 'include',
    })

    if (response.ok) {
      const text = await response.text()
      if (text.trim().startsWith('{')) {
        const result = parseJson3Captions(text)
        if (result) {
          debugLog('Successfully parsed JSON3 captions')
          return result
        }
      }
    }
  } catch (err) {
    debugLog('JSON3 fetch failed, trying original URL:', err)
  }

  // Fall back to original URL (usually XML format)
  try {
    debugLog('Fetching captions (original) from:', track.baseUrl.slice(0, 100))

    const response = await fetch(track.baseUrl, {
      credentials: 'include',
    })

    if (!response.ok) {
      debugLog('Caption fetch failed:', response.status)
      return null
    }

    const text = await response.text()

    // Try XML parsing
    const xmlResult = parseTimedTextXml(text)
    if (xmlResult) {
      debugLog('Successfully parsed XML captions')
      return xmlResult
    }

    // Maybe it's JSON after all
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      const jsonResult = parseJson3Captions(text)
      if (jsonResult) return jsonResult
    }

    debugLog('Could not parse caption response')
    return null
  } catch (err) {
    debugLog('Caption fetch error:', err)
    return null
  }
}

/**
 * Extract video duration from player response or video element.
 */
function extractVideoDuration(): number | null {
  // Try from player response
  const playerResponse = readFromPageContext('window.ytInitialPlayerResponse?.videoDetails?.lengthSeconds')
  if (typeof playerResponse === 'string') {
    const seconds = parseInt(playerResponse, 10)
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }
  if (typeof playerResponse === 'number' && Number.isFinite(playerResponse)) {
    return playerResponse
  }

  // Try from video element
  const video = document.querySelector('video') as HTMLVideoElement | null
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    return Math.round(video.duration)
  }

  return null
}

// Music detection removed - user will manually review music content

/**
 * Extract transcript from YouTube video captions.
 */
async function extractYouTubeTranscript(): Promise<YouTubeTranscriptResponse> {
  debugLog('Starting YouTube transcript extraction')
  debugLog('URL:', window.location.href)

  // Wait for video element to be ready (important for first video after page load)
  const waitForVideo = async (maxWait = 2000): Promise<HTMLVideoElement | null> => {
    const startTime = Date.now()
    while (Date.now() - startTime < maxWait) {
      const video = document.querySelector('video') as HTMLVideoElement | null
      // Video should exist and have some data loaded
      if (video && (video.readyState >= 1 || video.duration > 0)) {
        debugLog('Video element ready:', { readyState: video.readyState, duration: video.duration })
        return video
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return document.querySelector('video') as HTMLVideoElement | null
  }

  // Wait for video to be ready first
  await waitForVideo()

  // Try to get caption tracks with retries (YouTube data loads asynchronously)
  let tracks: CaptionTrack[] = []
  const maxRetries = 4
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    tracks = extractCaptionTracks()
    debugLog(`Attempt ${attempt + 1}/${maxRetries}: Found caption tracks:`, tracks.length)
    if (tracks.length > 0) break
    if (attempt < maxRetries - 1) {
      const waitTime = attempt < 2 ? 600 : 300
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }
  }

  if (tracks.length === 0) {
    return {
      ok: false,
      error: 'No captions available for this YouTube video',
      reason: 'no_captions',
    }
  }

  const selectedTrack = selectBestCaptionTrack(tracks)
  if (!selectedTrack) {
    // No English track available
    return {
      ok: false,
      error: 'No English captions available - skipping non-English content',
      reason: 'not_english',
    }
  }

  debugLog('Selected track:', selectedTrack.languageCode, selectedTrack.kind || 'manual')

  const captions = await fetchYouTubeCaptions(selectedTrack)
  if (!captions) {
    return {
      ok: false,
      error: 'Failed to fetch or parse YouTube captions',
      reason: 'fetch_failed',
    }
  }

  const durationSeconds = extractVideoDuration()

  debugLog('Successfully extracted transcript:', { textLength: captions.text.length, segments: captions.segments.length })
  return {
    ok: true,
    text: captions.text,
    segments: captions.segments,
    source: 'youtube-captions',
    durationSeconds,
  }
}

/**
 * Extract stats from DOM elements.
 */
function extractStatsFromDOM(): { views: number | null; likes: number | null; comments: number | null; shares: number | null } {
  const stats = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null }

  // For YouTube Shorts, look for specific elements
  const isShorts = window.location.pathname.startsWith('/shorts/')

  if (isShorts) {
    // Shorts has a different layout - stats are in the action bar on the right
    debugLog('Extracting stats for Shorts')

    // Find the active reel renderer
    const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]')
    const searchRoot = activeReel || document

    // YouTube Shorts shows stats as text inside the action buttons
    // Each button has a span/text with the count

    // Method 1: Look for action button containers and extract text directly
    const actionButtons = searchRoot.querySelectorAll('#actions button, #actions [role="button"], ytd-reel-player-overlay-renderer button')
    for (const btn of actionButtons) {
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
      const allText = btn.textContent?.trim() || ''

      // Extract just the number from the button text
      const numberMatch = allText.match(/^([\d,.]+[KMB]?)/i)
      const count = numberMatch ? parseYouTubeNumber(numberMatch[1]) : null

      if (count !== null) {
        if (ariaLabel.includes('like') && !ariaLabel.includes('dislike') && stats.likes === null) {
          stats.likes = count
          debugLog('Found likes from action button:', count)
        } else if (ariaLabel.includes('comment') && stats.comments === null) {
          stats.comments = count
          debugLog('Found comments from action button:', count)
        } else if (ariaLabel.includes('share') && stats.shares === null) {
          stats.shares = count
          debugLog('Found shares from action button:', count)
        }
      }

      // Also check aria-label for counts embedded in the label
      if (stats.likes === null && ariaLabel.includes('like')) {
        const likeMatch = ariaLabel.match(/with\s*([\d,]+[KMB]?)\s*other/i)
          || ariaLabel.match(/([\d,]+[KMB]?)\s*likes?/i)
        if (likeMatch) {
          stats.likes = parseYouTubeNumber(likeMatch[1])
          debugLog('Found likes from aria-label:', stats.likes)
        }
      }
      if (stats.comments === null && ariaLabel.includes('comment')) {
        const commentMatch = ariaLabel.match(/([\d,]+[KMB]?)\s*comments?/i)
        if (commentMatch) {
          stats.comments = parseYouTubeNumber(commentMatch[1])
          debugLog('Found comments from aria-label:', stats.comments)
        }
      }
    }

    // Method 2: Look for spans/text within known button IDs
    const buttonIds = ['#like-button', '#dislike-button', '#comments-button', '#share-button']
    for (const id of buttonIds) {
      const container = searchRoot.querySelector(id)
      if (!container) continue

      // Find text elements within
      const textEls = container.querySelectorAll('span, yt-formatted-string')
      for (const el of textEls) {
        const text = el.textContent?.trim() || ''
        if (text.match(/^[\d,.]+[KMB]?$/i)) {
          const count = parseYouTubeNumber(text)
          if (count !== null) {
            if (id === '#like-button' && stats.likes === null) {
              stats.likes = count
              debugLog('Found likes from #like-button:', count)
            } else if (id === '#comments-button' && stats.comments === null) {
              stats.comments = count
              debugLog('Found comments from #comments-button:', count)
            } else if (id === '#share-button' && stats.shares === null) {
              stats.shares = count
              debugLog('Found shares from #share-button:', count)
            }
          }
        }
      }
    }

    // Method 3: Look for view count in the video overlay/title area
    const viewSelectors = [
      'ytd-reel-video-renderer[is-active] .ytd-reel-player-overlay-renderer',
      'ytd-reel-video-renderer[is-active] #factoids',
      '.reel-video-in-sequence[is-active] .factoid',
      '#info-container span',
      '.view-count',
    ]

    for (const selector of viewSelectors) {
      const viewEls = document.querySelectorAll(selector)
      for (const el of viewEls) {
        const text = el.textContent || ''
        const viewMatch = text.match(/([\d,.]+[KMB]?)\s*views?/i)
        if (viewMatch && stats.views === null) {
          stats.views = parseYouTubeNumber(viewMatch[1])
          debugLog('Found views:', stats.views)
          break
        }
      }
      if (stats.views !== null) break
    }

  } else {
    // Regular YouTube video
    // View count
    const viewCountEl = document.querySelector('#count .ytd-video-view-count-renderer, .view-count')
    if (viewCountEl) {
      const text = viewCountEl.textContent || ''
      const match = text.match(/([\d,.]+[KMB]?)\s*views?/i)
      if (match) {
        stats.views = parseYouTubeNumber(match[1])
      }
    }

    // Likes - look for like button (but NOT dislike)
    // Use more specific selectors and verify aria-label doesn't contain "dislike"
    const likeButtonCandidates = document.querySelectorAll('like-button-view-model button, #segmented-like-button button, ytd-toggle-button-renderer#top-level-buttons-computed button[aria-label]')
    for (const button of likeButtonCandidates) {
      const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase()
      // Skip if it's the dislike button
      if (ariaLabel.includes('dislike')) continue
      // Only process if it contains "like"
      if (!ariaLabel.includes('like')) continue

      const text = button.textContent || ''
      const likeMatch = ariaLabel.match(/(\d[\d,]*[KMB]?)/i) || text.match(/([\d,]+[KMB]?)/i)
      if (likeMatch) {
        stats.likes = parseYouTubeNumber(likeMatch[1])
        debugLog('Found likes from like button:', stats.likes)
        break
      }
    }

    // Comment count
    const commentHeader = document.querySelector('#comments #count, ytd-comments-header-renderer #title')
    if (commentHeader) {
      const text = commentHeader.textContent || ''
      const match = text.match(/([\d,.]+[KMB]?)\s*comments?/i) || text.match(/([\d,.]+[KMB]?)/)
      if (match) {
        stats.comments = parseYouTubeNumber(match[1])
      }
    }
  }

  debugLog('Extracted DOM stats:', stats)
  return stats
}

/**
 * Check if the current video is an advertisement.
 * YouTube Shorts ads have specific indicators.
 *
 * IMPORTANT: Be VERY conservative here - only flag actual ads.
 * False positives cause ALL videos to be skipped!
 */
function isCurrentVideoAd(): YouTubeAdCheckResponse {
  debugLog('Checking if current video is an ad')

  // Method 1: Check if the video player is in ad-showing state
  // This is THE most reliable indicator - YouTube adds this class ONLY during actual ads
  const player = document.querySelector('#movie_player')
  if (player) {
    const classList = player.className || ''
    if (classList.includes('ad-showing') || classList.includes('ad-interrupting')) {
      debugLog('Player in ad state')
      return { isAd: true, reason: 'Player showing ad' }
    }
  }

  // Method 2: For Shorts, check for ad-specific elements in active reel
  const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]')
  if (activeReel) {
    // Check for ad slot renderer - this is the definitive indicator for Shorts ads
    const adSlot = activeReel.querySelector('ytd-ad-slot-renderer')
    if (adSlot) {
      // Check if the ad slot actually has content (not just an empty container)
      const hasAdContent = adSlot.querySelector('ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, [class*="ad-container"]')
      if (hasAdContent) {
        debugLog('Ad slot with content found in active reel')
        return { isAd: true, reason: 'Ad slot in reel' }
      }
    }

    // Check for "Sponsored" label specifically in the metadata area
    const sponsoredLabels = activeReel.querySelectorAll('[class*="ytd-badge-supported-renderer"]')
    const sponsoredVariants = ['sponsored', 'ad', 'anzeige', 'gesponsert', 'publicité', 'sponsorisé', 'patrocinado']
    for (const label of sponsoredLabels) {
      const text = label.textContent?.trim().toLowerCase() || ''
      if (sponsoredVariants.includes(text)) {
        debugLog('Found Sponsored/Ad badge:', text)
        return { isAd: true, reason: 'Sponsored badge' }
      }
    }
  }

  // REMOVED: The .ytp-ad-overlay-container check was causing false positives
  // These containers exist on ALL videos but are usually empty/inactive

  debugLog('Not an ad')
  return { isAd: false }
}

/**
 * Scroll to the next YouTube Shorts video.
 */
function scrollToNextShort(): YouTubeScrollNextResponse {
  try {
    const isShorts = window.location.pathname.startsWith('/shorts/')

    if (isShorts) {
      // Method 1: Try to find and click the down/next button
      const nextButton = document.querySelector('button[aria-label*="Next video"]') as HTMLElement
        || document.querySelector('#navigation-button-down button') as HTMLElement
        || document.querySelector('[class*="navigation-button"]') as HTMLElement

      if (nextButton) {
        nextButton.click()
        return { ok: true }
      }

      // Method 2: Simulate keyboard down arrow (YouTube Shorts supports this)
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        keyCode: 40,
        which: 40,
        bubbles: true,
      })
      document.dispatchEvent(event)

      // Method 3: Scroll the shorts container
      const shortsContainer = document.querySelector('ytd-shorts')
        || document.querySelector('#shorts-container')
        || document.querySelector('ytd-reel-video-renderer')?.parentElement

      if (shortsContainer) {
        shortsContainer.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
      } else {
        window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
      }

      return { ok: true }
    }

    // Not on Shorts page, can't auto-scroll
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * Extract video metadata from YouTube page.
 */
function extractYouTubeMetadata(): YouTubeMetadataResponse {
  debugLog('Starting metadata extraction')
  debugLog('URL:', window.location.href)

  // Get data from player response
  const playerData = extractFromPlayerResponse()
  debugLog('Player response data:', { hasTitle: !!playerData.title, hasStats: !!playerData.stats })

  // Get data from initial data (mainly for Shorts)
  const initialData = extractFromInitialData()
  debugLog('Initial data:', { hasStats: !!initialData.stats })

  // Get stats from DOM
  const domStats = extractStatsFromDOM()
  debugLog('DOM stats:', domStats)

  // Merge all sources
  const result: YouTubeMetadataResponse = {
    title: playerData.title || null,
    description: playerData.description || null,
    creator: playerData.creator || null,
    postedAt: playerData.postedAt || null,
    hashtags: playerData.hashtags || [],
    platform: 'youtube',
    stats: {
      views: playerData.stats?.views ?? initialData.stats?.views ?? domStats.views,
      likes: playerData.stats?.likes ?? initialData.stats?.likes ?? domStats.likes,
      comments: playerData.stats?.comments ?? initialData.stats?.comments ?? domStats.comments,
      shares: playerData.stats?.shares ?? initialData.stats?.shares ?? domStats.shares,
    },
  }

  // Fallback: get title from meta tags if not found
  if (!result.title) {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    result.title = ogTitle || document.title.replace(/ - YouTube$/, '') || null
  }

  // Fallback: get description from meta tags
  if (!result.description) {
    const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
    result.description = ogDesc || null
    if (result.description && result.hashtags.length === 0) {
      result.hashtags = extractHashtags(result.description)
    }
  }

  debugLog('Final result:', { title: result.title, stats: result.stats })
  return result
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_youtube_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    // Announce that content script is ready
    void chrome.runtime.sendMessage({ type: 'content-script-ready', scriptType: 'youtube' }).catch(() => {
      // Ignore errors (background may not be ready yet)
    })

    chrome.runtime.onMessage.addListener(
      (
        message: YouTubeMetadataRequest | YouTubeScrollNextRequest | YouTubeTranscriptRequest | YouTubeAdCheckRequest,
        _sender,
        sendResponse: (response: YouTubeMetadataResponse | YouTubeScrollNextResponse | YouTubeTranscriptResponse | YouTubeAdCheckResponse) => void
      ) => {
        if (message?.type === 'youtube-metadata') {
          sendResponse(extractYouTubeMetadata())
          return false
        }
        if (message?.type === 'youtube-scroll-next') {
          sendResponse(scrollToNextShort())
          return false
        }
        if (message?.type === 'youtube-is-ad') {
          sendResponse(isCurrentVideoAd())
          return false
        }
        if (message?.type === 'youtube-transcript') {
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

          extractYouTubeTranscript()
            .then(sendResponse)
            .catch((err) => {
              console.error('[YouTube Content Script] Transcript extraction error:', err)
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
