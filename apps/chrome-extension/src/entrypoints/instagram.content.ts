import { defineContentScript } from 'wxt/utils/define-content-script'

// Debug flag - set to true to enable verbose logging for troubleshooting
const DEBUG = false

// Debug logging helper
function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log(`[Instagram Content Script] ${message}`, ...args)
  }
}

type InstagramTranscriptRequest = { type: 'instagram-transcript' }
type InstagramTranscriptResponse =
  | {
      ok: true
      videoUrl: string
      source: 'instagram-video'
      durationSeconds: number | null
      title: string | null
    }
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'unsupported_url' | 'auth_required' | 'blocked' | 'is_ad' }

type InstagramMetadataRequest = { type: 'instagram-metadata' }
type InstagramScrollNextRequest = { type: 'instagram-scroll-next' }
type InstagramScrollNextResponse = { ok: boolean }
type InstagramAdCheckRequest = { type: 'instagram-is-ad' }
type InstagramAdCheckResponse = { isAd: boolean; reason?: string }
type InstagramMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
  platform: 'instagram'
  stats: {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  }
}

/**
 * Check if a URL is a valid Instagram CDN URL
 */
function isValidInstagramCdnUrl(url: string): boolean {
  if (!url || !url.startsWith('https://')) return false
  return url.includes('cdninstagram.com')
    || url.includes('fbcdn.net')
    || url.includes('instagram.com')
    || url.includes('facebook.com')
}

/**
 * Decode escaped URL characters from JSON
 */
function decodeJsonUrl(url: string): string {
  if (!url) return url
  try {
    if (url.includes('\\')) {
      return JSON.parse(`"${url.replace(/"/g, '\\"')}"`) as string
    }
  } catch {
    // Fall through to manual replacement.
  }
  return url
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
}

/**
 * Try to get video URL from window.__additionalDataLoaded
 */
function extractFromAdditionalData(): string | null {
  try {
    const win = window as unknown as { __additionalDataLoaded?: Record<string, unknown> }
    if (!win.__additionalDataLoaded) return null

    const searchForVideoUrl = (obj: unknown, depth = 0): string | null => {
      if (depth > 10 || !obj || typeof obj !== 'object') return null
      const record = obj as Record<string, unknown>

      // Check for video_url
      if (typeof record.video_url === 'string' && isValidInstagramCdnUrl(record.video_url)) {
        return record.video_url
      }

      // Check for video_versions array (highest quality first)
      if (Array.isArray(record.video_versions) && record.video_versions.length > 0) {
        for (const version of record.video_versions) {
          if (version && typeof version === 'object') {
            const v = version as Record<string, unknown>
            if (typeof v.url === 'string' && isValidInstagramCdnUrl(v.url)) {
              return v.url
            }
          }
        }
      }

      // Recurse
      for (const key of Object.keys(record)) {
        const found = searchForVideoUrl(record[key], depth + 1)
        if (found) return found
      }

      return null
    }

    return searchForVideoUrl(win.__additionalDataLoaded)
  } catch {
    return null
  }
}

/**
 * Search all scripts for GraphQL video data
 */
function extractFromGraphQLScripts(): string | null {
  const scripts = document.querySelectorAll('script')

  for (const script of scripts) {
    const text = script.textContent || ''
    if (text.length < 100) continue

    // Multiple patterns for video URLs in different GraphQL formats
    const patterns = [
      // Standard video_url
      /"video_url"\s*:\s*"(https:[^"]+)"/g,
      // video_versions array
      /"video_versions"\s*:\s*\[\s*\{\s*"[^"]*"\s*:\s*\d+[^}]*"url"\s*:\s*"(https:[^"]+)"/g,
      // Alternate format
      /"playable_url(?:_quality_hd)?"\s*:\s*"(https:[^"]+)"/g,
      // Direct CDN URL pattern
      /"url"\s*:\s*"(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+\.mp4[^"]*)"/g,
    ]

    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(text)) !== null) {
        const decoded = decodeJsonUrl(match[1])
        if (isValidInstagramCdnUrl(decoded)) {
          return decoded
        }
      }
    }
  }

  return null
}

/**
 * Extract video URL from Instagram Reel page.
 * Instagram doesn't have native captions, so we extract the video URL
 * for server-side transcription with Whisper.
 */
function extractInstagramVideoInfo(): {
  videoUrl: string | null
  durationSeconds: number | null
  title: string | null
} {
  // Try to find video element directly
  const videoEl = document.querySelector('video') as HTMLVideoElement | null

  let videoUrl: string | null = null
  let durationSeconds: number | null = null

  if (videoEl) {
    // Get video source - prefer src attribute, fall back to source element
    videoUrl = videoEl.src || null
    if (!videoUrl) {
      const sourceEl = videoEl.querySelector('source')
      videoUrl = sourceEl?.src || null
    }

    // Get duration from video element
    if (typeof videoEl.duration === 'number' && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      durationSeconds = videoEl.duration
    }
  }

  // If we only have a blob/data URL, treat it as unusable and keep searching.
  if (videoUrl?.startsWith('blob:') || videoUrl?.startsWith('data:')) {
    videoUrl = null
  }

  // Method 1: Try __additionalDataLoaded window object
  if (!videoUrl) {
    videoUrl = extractFromAdditionalData()
  }

  // Method 2: Try to extract from Instagram's LD+JSON
  if (!videoUrl) {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]')
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent || '') as {
          '@type'?: string
          contentUrl?: string
          duration?: string
        }
        if (data['@type'] === 'VideoObject' && data.contentUrl && isValidInstagramCdnUrl(data.contentUrl)) {
          videoUrl = data.contentUrl
          // Parse duration if available (ISO 8601 format like PT30S)
          if (data.duration && !durationSeconds) {
            const match = data.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
            if (match) {
              const hours = parseInt(match[1] || '0', 10)
              const minutes = parseInt(match[2] || '0', 10)
              const seconds = parseInt(match[3] || '0', 10)
              durationSeconds = hours * 3600 + minutes * 60 + seconds
            }
          }
          break
        }
      } catch {
        // Continue to next script
      }
    }
  }

  // Method 3: Try og:video meta tag
  if (!videoUrl) {
    const ogVideo = document.querySelector('meta[property="og:video"]') as HTMLMetaElement | null
    const ogContent = ogVideo?.content || null
    if (ogContent && isValidInstagramCdnUrl(ogContent)) {
      videoUrl = ogContent
    }
  }

  // Method 4: Search all scripts for GraphQL video data
  if (!videoUrl) {
    videoUrl = extractFromGraphQLScripts()
  }

  // Get title from page
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.title
    || null

  return { videoUrl, durationSeconds, title }
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
 * Check if a value is a valid finite non-negative number.
 */
function isValidNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Parse a number from Instagram's display format (e.g., "1.2M", "500K", "1,234")
 */
function parseInstagramNumber(text: string | null): number | null {
  if (!text) return null
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

  const match = cleaned.match(/^([\d.,\s]+)\s*([kmb]?)/)
  if (!match) return null
  const num = parseFloat(normalizeCompactNumber(match[1]))
  if (!isValidNumber(num)) return null
  const suffix = match[2]
  if (suffix === 'k') return Math.round(num * 1000)
  if (suffix === 'm') return Math.round(num * 1000000)
  if (suffix === 'b') return Math.round(num * 1000000000)
  return Math.round(num)
}

/**
 * Extract stats from DOM elements
 * Instagram Reels show stats in action buttons on the right side of the video
 */
function extractStatsFromDOM(): { views: number | null; likes: number | null; comments: number | null; shares: number | null } {
  const stats = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null }

  // Try to find stats in aria-labels and spans
  // Instagram shows "X likes", "X views", "X comments"
  const article = document.querySelector('article') || document

  // Look for all interactive elements that might contain stats
  const allElements = article.querySelectorAll('span, button, a, section, div[role="button"]')
  for (const el of allElements) {
    const text = el.textContent?.trim() || ''
    const ariaLabel = el.getAttribute('aria-label') || ''

    // Check aria-label first (more reliable)
    if (ariaLabel) {
      // Likes: "Like", "X likes", "like this video along with X other people"
      const likesMatch = ariaLabel.match(/([\d,]+(?:\.\d+)?[KMB]?)\s*likes?/i)
        || ariaLabel.match(/along with\s*([\d,]+(?:\.\d+)?[KMB]?)\s*other/i)
      if (likesMatch && stats.likes === null) {
        stats.likes = parseInstagramNumber(likesMatch[1])
      }

      // Views/Plays
      const viewsMatch = ariaLabel.match(/([\d,]+(?:\.\d+)?[KMB]?)\s*(?:views?|plays?|watch)/i)
      if (viewsMatch && stats.views === null) {
        stats.views = parseInstagramNumber(viewsMatch[1])
      }

      // Comments
      const commentsMatch = ariaLabel.match(/([\d,]+(?:\.\d+)?[KMB]?)\s*comments?/i)
        || ariaLabel.match(/view all\s*([\d,]+(?:\.\d+)?[KMB]?)\s*comments?/i)
      if (commentsMatch && stats.comments === null) {
        stats.comments = parseInstagramNumber(commentsMatch[1])
      }

      // Shares (rarely shown but check anyway)
      const sharesMatch = ariaLabel.match(/([\d,]+(?:\.\d+)?[KMB]?)\s*shares?/i)
      if (sharesMatch && stats.shares === null) {
        stats.shares = parseInstagramNumber(sharesMatch[1])
      }
    }

    // Check text content - Instagram Reels show numbers below action buttons
    // Match standalone numbers or numbers with K/M/B suffix
    const likesTextMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)\s*likes?$/i)
    if (likesTextMatch && stats.likes === null) {
      stats.likes = parseInstagramNumber(likesTextMatch[1])
    }
    const viewsTextMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)\s*(?:views?|plays?)$/i)
    if (viewsTextMatch && stats.views === null) {
      stats.views = parseInstagramNumber(viewsTextMatch[1])
    }
    const commentsTextMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)\s*comments?$/i)
    if (commentsTextMatch && stats.comments === null) {
      stats.comments = parseInstagramNumber(commentsTextMatch[1])
    }

    // Also check for "View all X comments" link
    const viewAllCommentsMatch = text.match(/view all\s*([\d,]+(?:\.\d+)?[KMB]?)\s*comments?/i)
    if (viewAllCommentsMatch && stats.comments === null) {
      stats.comments = parseInstagramNumber(viewAllCommentsMatch[1])
    }
  }

  // Instagram Reels: Look for action buttons with counts
  // The like/comment/share buttons often have sibling spans with the count
  const actionButtons = document.querySelectorAll('[aria-label*="Like"], [aria-label*="Comment"], [aria-label*="Share"], [aria-label*="Send"]')
  for (const btn of actionButtons) {
    const ariaLabel = btn.getAttribute('aria-label') || ''
    const parent = btn.parentElement

    // Find sibling or child span with a number
    const siblingSpans = parent?.querySelectorAll('span') || []
    for (const span of siblingSpans) {
      const spanText = span.textContent?.trim() || ''
      // Match standalone numbers like "1,234" or "1.2K"
      const numberMatch = spanText.match(/^([\d,]+(?:\.\d+)?[KMB]?)$/i)
      if (numberMatch) {
        const count = parseInstagramNumber(numberMatch[1])
        if (count !== null) {
          if (ariaLabel.toLowerCase().includes('like') && stats.likes === null) {
            stats.likes = count
          } else if (ariaLabel.toLowerCase().includes('comment') && stats.comments === null) {
            stats.comments = count
          } else if ((ariaLabel.toLowerCase().includes('share') || ariaLabel.toLowerCase().includes('send')) && stats.shares === null) {
            stats.shares = count
          }
        }
      }
    }
  }

  // Instagram Reels: Look for views count in the Reels sidebar/overlay
  // Format: "X plays", "X views", or just a number with play icon
  if (stats.views === null) {
    // Try multiple selectors for view counts
    const viewSelectors = [
      // Common Reels view count locations
      '[class*="x1lliihq"][class*="x1plvlek"]', // View count in Reels
      '[class*="ViewCount"]',
      '[class*="playCount"]',
      '[class*="view-count"]',
      'span[class*="x1lliihq"]', // Generic span that often has counts
    ]

    for (const selector of viewSelectors) {
      const elements = document.querySelectorAll(selector)
      for (const el of elements) {
        const text = el.textContent?.trim() || ''
        // Match "X plays", "X views", or just a number followed by plays/views
        const playsMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)\s*(?:plays?|views?)?$/i)
        if (playsMatch) {
          const count = parseInstagramNumber(playsMatch[1])
          if (count !== null && count > 0) {
            stats.views = count
            break
          }
        }
      }
      if (stats.views !== null) break
    }
  }

  // Look for views in any span near a play icon (SVG)
  if (stats.views === null) {
    const playSvgs = document.querySelectorAll('svg[aria-label*="Play"], svg[aria-label*="play"]')
    for (const svg of playSvgs) {
      // Look at parent and siblings for a number
      const parent = svg.closest('div, span, button')
      if (parent) {
        const spans = parent.querySelectorAll('span')
        for (const span of spans) {
          const text = span.textContent?.trim() || ''
          const numberMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)$/i)
          if (numberMatch) {
            const count = parseInstagramNumber(numberMatch[1])
            if (count !== null && count > 100) { // Views should be reasonably high
              stats.views = count
              break
            }
          }
        }
      }
      if (stats.views !== null) break
    }
  }

  // Look for views count in Reels - often shown at bottom of video
  // Format: "X plays" or just a number near play icon
  if (stats.views === null) {
    const viewElements = document.querySelectorAll('[class*="view"], [class*="play"], span')
    for (const el of viewElements) {
      const text = el.textContent?.trim() || ''
      const playsMatch = text.match(/^([\d,]+(?:\.\d+)?[KMB]?)\s*(?:plays?|views?)$/i)
      if (playsMatch) {
        stats.views = parseInstagramNumber(playsMatch[1])
        break
      }
    }
  }

  // Fallback: Look for "Liked by X and Y others" pattern
  if (stats.likes === null) {
    const likedByMatch = article.textContent?.match(/liked by[^0-9]*and\s*([\d,]+(?:\.\d+)?[KMB]?)\s*others?/i)
    if (likedByMatch) {
      stats.likes = parseInstagramNumber(likedByMatch[1])
      if (stats.likes !== null) stats.likes += 1 // Add the named person
    }
  }

  debugLog('Extracted DOM stats:', stats)
  return stats
}

/**
 * Extract video metadata from Instagram page.
 */
function extractInstagramMetadata(): InstagramMetadataResponse {
  const emptyStats = { views: null, likes: null, comments: null, shares: null }

  // Try to get title from og:title meta tag
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
  const title = ogTitle || document.title || null

  // Get description from og:description
  const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
  const description = ogDescription || null

  // Extract hashtags from title and description
  const titleHashtags = extractHashtags(ogTitle)
  const descHashtags = extractHashtags(ogDescription)
  const hashtags = [...new Set([...titleHashtags, ...descHashtags])]

  // Try to extract creator from page
  // Instagram URLs can be:
  // - /username/reel/xxx/ (profile-based)
  // - /reel/xxx/ (direct link)
  // - /p/xxx/ (direct post link)
  let creator: string | null = null

  // Try from URL path (e.g., https://www.instagram.com/username/reel/xxx)
  const pathMatch = window.location.pathname.match(/^\/([^/]+)\/(?:reel|reels|p|tv)\//)
  if (pathMatch?.[1] && !['reel', 'reels', 'p', 'tv'].includes(pathMatch[1])) {
    creator = `@${pathMatch[1]}`
  }

  // If not found in URL, try parsing from title (usually "Username on Instagram: caption...")
  if (!creator && ogTitle) {
    const titleMatch = ogTitle.match(/^(.+?) on Instagram:/)
    if (titleMatch?.[1]) {
      creator = `@${titleMatch[1].trim()}`
    }
  }

  // Also try parsing from description which often has "@username" mentions
  if (!creator && ogDescription) {
    const mentionMatch = ogDescription.match(/@([a-zA-Z0-9._]+)/)
    if (mentionMatch?.[1]) {
      creator = `@${mentionMatch[1]}`
    }
  }

  // Try from LD+JSON for date, author, and stats
  let postedAt: string | null = null
  let stats = { ...emptyStats }

  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || '') as {
        '@type'?: string
        uploadDate?: string
        author?: {
          name?: string
          alternateName?: string
        }
        interactionStatistic?: Array<{
          '@type'?: string
          interactionType?: { '@type'?: string } | string
          userInteractionCount?: number | string
        }>
      }
      if (data['@type'] === 'VideoObject') {
        // Get upload date if available
        if (data.uploadDate) {
          const date = new Date(data.uploadDate)
          if (!isNaN(date.getTime())) {
            postedAt = date.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          }
        }
        // Get author if we don't have one
        if (!creator && data.author?.alternateName) {
          creator = `@${data.author.alternateName}`
        } else if (!creator && data.author?.name) {
          creator = `@${data.author.name}`
        }

        // Extract stats from interactionStatistic
        if (Array.isArray(data.interactionStatistic)) {
          for (const stat of data.interactionStatistic) {
            const type = typeof stat.interactionType === 'string'
              ? stat.interactionType
              : stat.interactionType?.['@type']
            const rawCount = typeof stat.userInteractionCount === 'number'
              ? stat.userInteractionCount
              : typeof stat.userInteractionCount === 'string'
                ? parseInt(stat.userInteractionCount, 10)
                : null
            const count = rawCount !== null && isValidNumber(rawCount) ? rawCount : null

            if (count !== null) {
              if (type?.includes('Watch') || type?.includes('View')) {
                stats.views = count
              } else if (type?.includes('Like')) {
                stats.likes = count
              } else if (type?.includes('Comment')) {
                stats.comments = count
              } else if (type?.includes('Share')) {
                stats.shares = count
              }
            }
          }
        }
        break
      }
    } catch {
      // Continue to next script
    }
  }

  // Fallback: Try to extract stats from DOM if not found in LD+JSON
  const domStats = extractStatsFromDOM()
  if (stats.views === null) stats.views = domStats.views
  if (stats.likes === null) stats.likes = domStats.likes
  if (stats.comments === null) stats.comments = domStats.comments
  if (stats.shares === null) stats.shares = domStats.shares

  return { title, description, creator, postedAt, hashtags, platform: 'instagram', stats }
}

/**
 * Scroll to the next Instagram Reel.
 * Handles both vertical feed scroll and horizontal modal navigation.
 */
function scrollToNextReel(): InstagramScrollNextResponse {
  try {
    // Check if we're in a modal/dialog view that contains a video (reel modal)
    // Be specific to avoid triggering on login/share dialogs
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]')
    const isReelModal = dialog && (
      dialog.querySelector('video') !== null ||
      dialog.querySelector('button[aria-label*="Next"]') !== null ||
      dialog.querySelector('svg[aria-label*="Next"]') !== null
    )

    debugLog('Scroll mode:', isReelModal ? 'modal (horizontal)' : 'feed (vertical)')

    if (isReelModal && dialog) {
      // Modal view uses LEFT/RIGHT arrow buttons for navigation
      const container = dialog as Element

      // Method 1: Find and click the "Next" button with various aria-labels
      const nextButton =
        container.querySelector('button[aria-label="Next"]') as HTMLElement ??
        container.querySelector('button[aria-label="Next reel"]') as HTMLElement ??
        container.querySelector('button[aria-label="Next post"]') as HTMLElement ??
        container.querySelector('button[aria-label*="Next"]') as HTMLElement ??
        // Try finding by SVG icon (right chevron/arrow)
        container.querySelector('svg[aria-label="Next"]')?.closest('button, [role="button"]') as HTMLElement ??
        container.querySelector('svg[aria-label*="Next"]')?.closest('button, [role="button"]') as HTMLElement ??
        // Fallback: look for buttons with right-pointing chevron classes
        container.querySelector('[class*="RightChevron"], [class*="rightChevron"], [class*="NextButton"]')?.closest('button, [role="button"]') as HTMLElement

      if (nextButton) {
        debugLog('Found next button, clicking')
        nextButton.click()
        return { ok: true }
      }

      // Method 2: Try keyboard ArrowRight (for horizontal modal navigation)
      // Make dialog focusable and focus it
      if (dialog instanceof HTMLElement) {
        dialog.tabIndex = -1
        dialog.focus()
      }

      // Also try focusing the video element inside
      const videoEl = container.querySelector('video') as HTMLVideoElement
      if (videoEl) {
        videoEl.focus()
      }

      const rightEvent = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 39,
        which: 39,
        bubbles: true,
      })
      document.dispatchEvent(rightEvent)
      container.dispatchEvent(rightEvent)
      debugLog('Dispatched ArrowRight key event')

      return { ok: true }
    }

    // Feed view (vertical scroll) - e.g., /reels/ page
    // Method 1: Try to find and click next button
    const nextButton = document.querySelector('button[aria-label*="Next"]') as HTMLElement
      || document.querySelector('[class*="DownChevron"]')?.closest('button') as HTMLElement

    if (nextButton) {
      nextButton.click()
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

    // Method 3: Scroll the reels container or page
    const reelsContainer = document.querySelector('[class*="x1cy8zhl"]')
      || document.querySelector('article')?.parentElement
      || document.querySelector('main')

    if (reelsContainer) {
      reelsContainer.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    } else {
      window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
    }

    return { ok: true }
  } catch (err) {
    debugLog('Scroll error:', err)
    return { ok: false }
  }
}

/**
 * Check if page indicates login is required
 */
function isAuthRequired(): boolean {
  // Check for login wall elements
  const loginSelectors = [
    '[data-testid="login-button"]',
    'input[name="username"]',
    'a[href*="/accounts/login"]',
    '[class*="LoginForm"]',
    '[class*="loginForm"]',
  ]

  for (const selector of loginSelectors) {
    if (document.querySelector(selector)) {
      // Make sure we're not just seeing a login button in the nav
      const loginForm = document.querySelector('form[action*="login"]')
        || document.querySelector('[class*="LoginForm"]')
        || document.querySelector('[class*="loginForm"]')
      if (loginForm) return true
    }
  }

  // Check for "Log in to continue" type messages
  const pageText = document.body?.textContent?.toLowerCase() || ''
  const authPhrases = [
    'log in to see',
    'log in to continue',
    'sign up to see',
    'login required',
    'create an account',
  ]

  for (const phrase of authPhrases) {
    if (pageText.includes(phrase)) {
      // Verify there's no video element (to avoid false positives)
      if (!document.querySelector('video')) return true
    }
  }

  return false
}

/**
 * Check if content is blocked (age-gated, geo-restricted, etc.)
 */
function isContentBlocked(): { blocked: boolean; reason?: string } {
  const pageText = document.body?.textContent?.toLowerCase() || ''

  // Check for common block messages
  const blockPhrases = [
    { pattern: 'age-restricted', reason: 'Age-restricted content' },
    { pattern: 'sensitive content', reason: 'Sensitive content warning' },
    { pattern: 'content isn\'t available', reason: 'Content not available' },
    { pattern: 'this content isn\'t available', reason: 'Content not available' },
    { pattern: 'this page isn\'t available', reason: 'Page not available' },
    { pattern: 'sorry, this page isn\'t available', reason: 'Page not available' },
    { pattern: 'this account is private', reason: 'Private account' },
    { pattern: 'account is private', reason: 'Private account' },
    { pattern: 'restricted your account', reason: 'Account restricted' },
    { pattern: 'violates our community guidelines', reason: 'Content removed' },
    { pattern: 'content has been removed', reason: 'Content removed' },
    { pattern: 'video has been removed', reason: 'Video removed' },
    { pattern: 'not available in your', reason: 'Geo-restricted content' },
  ]

  for (const { pattern, reason } of blockPhrases) {
    if (pageText.includes(pattern)) {
      return { blocked: true, reason }
    }
  }

  // Check for error page indicators
  const errorSelectors = [
    '[data-testid="error-message"]',
    '[class*="ErrorPage"]',
    '[class*="errorPage"]',
    '[class*="NotAvailable"]',
  ]

  for (const selector of errorSelectors) {
    if (document.querySelector(selector)) {
      return { blocked: true, reason: 'Content not available' }
    }
  }

  return { blocked: false }
}

/**
 * Check if the current video/reel is an advertisement.
 * Instagram ads have a "Sponsored" label.
 */
function isCurrentVideoAd(): InstagramAdCheckResponse {
  debugLog('Checking if current content is an ad')

  // Helper to check if element is visible
  const isVisible = (el: Element | null): boolean => {
    if (!el) return false
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
  }

  // Common localized "Sponsored" variants
  const sponsoredVariants = [
    'sponsored', 'anzeige', 'gesponsert', // English, German
    'publicité', 'sponsorisé', 'commandité', // French
    'sponsorizzato', // Italian
    'patrocinado', // Spanish, Portuguese
    '広告', 'スポンサー', // Japanese
    '광고', '스폰서', // Korean
    '赞助', '广告', // Chinese
  ]

  // The current article/post container
  const article = document.querySelector('article') || document

  // Method 1: Check for exact "Sponsored" text label (localized)
  // Instagram shows "Sponsored" as a standalone label below the username for ads
  // We need to be very specific - only match elements where the ENTIRE text is a sponsored variant
  const allSpans = article.querySelectorAll('span, a')
  for (const el of allSpans) {
    const text = el.textContent?.trim().toLowerCase() || ''
    // Must be exactly a sponsored variant with no other text
    if (sponsoredVariants.includes(text) && isVisible(el)) {
      // Verify this is in the header area (near username) not elsewhere
      const nearHeader = el.closest('header') || el.closest('[class*="Header"]')
      if (nearHeader) {
        debugLog('Found Sponsored label in header:', text)
        return { isAd: true, reason: 'Sponsored content' }
      }
    }
  }

  // Method 2: Check for data attributes that specifically indicate ads
  // Only check for very specific ad-related data attributes
  const adDataElements = article.querySelectorAll('[data-ad-id], [data-ad-preview]')
  for (const el of adDataElements) {
    if (isVisible(el)) {
      debugLog('Found visible ad data attribute')
      return { isAd: true, reason: 'Ad data attribute' }
    }
  }

  // Note: We intentionally do NOT check for:
  // - aria-label containing "Ad" (matches "Add", "Adjust", etc.)
  // - Paid partnerships (creator content, not ads)
  // - Generic class names

  debugLog('Not an ad')
  return { isAd: false }
}

async function extractTranscript(): Promise<InstagramTranscriptResponse> {
  debugLog('Starting transcript extraction')
  debugLog('URL:', window.location.href)

  // First check for auth/blocked states before extraction
  if (isAuthRequired()) {
    debugLog('Auth required detected')
    return {
      ok: false,
      error: 'Login required to view this Instagram content',
      reason: 'auth_required',
    }
  }

  const blockStatus = isContentBlocked()
  if (blockStatus.blocked) {
    debugLog('Content blocked:', blockStatus.reason)
    return {
      ok: false,
      error: blockStatus.reason || 'This content is not available',
      reason: 'blocked',
    }
  }

  const { videoUrl, durationSeconds, title } = extractInstagramVideoInfo()
  debugLog('Extracted video info:', { hasUrl: !!videoUrl, durationSeconds, title })

  if (!videoUrl) {
    // Double-check if it's actually an auth issue we missed
    if (isAuthRequired()) {
      debugLog('Auth required detected on second check')
      return {
        ok: false,
        error: 'Login required to view this Instagram content',
        reason: 'auth_required',
      }
    }

    debugLog('No video URL found')
    return {
      ok: false,
      error: 'No downloadable video URL found on this Instagram page',
      reason: 'no_video',
    }
  }

  if (!videoUrl.startsWith('https://')) {
    debugLog('Non-HTTPS video URL:', videoUrl.substring(0, 50))
    return {
      ok: false,
      error: 'Instagram video URL is not downloadable',
      reason: 'unsupported_url',
    }
  }

  debugLog('Successfully extracted video URL:', videoUrl.substring(0, 100))
  return {
    ok: true,
    videoUrl,
    source: 'instagram-video',
    durationSeconds,
    title,
  }
}

export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_instagram_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    // Announce that content script is ready
    void chrome.runtime.sendMessage({ type: 'content-script-ready', scriptType: 'instagram' }).catch(() => {
      // Ignore errors (background may not be ready yet)
    })

    chrome.runtime.onMessage.addListener(
      (
        message: InstagramTranscriptRequest | InstagramMetadataRequest | InstagramScrollNextRequest | InstagramAdCheckRequest,
        _sender,
        sendResponse: (response: InstagramTranscriptResponse | InstagramMetadataResponse | InstagramScrollNextResponse | InstagramAdCheckResponse) => void
      ) => {
        if (message?.type === 'instagram-transcript') {
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
              console.error('[Instagram Content Script] Extraction error:', err)
              sendResponse({
                ok: false,
                error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
                reason: 'extraction_failed',
              })
            })
          return true // Keep channel open for async response
        }
        if (message?.type === 'instagram-metadata') {
          sendResponse(extractInstagramMetadata())
          return false
        }
        if (message?.type === 'instagram-scroll-next') {
          sendResponse(scrollToNextReel())
          return false
        }
        if (message?.type === 'instagram-is-ad') {
          sendResponse(isCurrentVideoAd())
          return false
        }
        return undefined
      }
    )
  },
})
