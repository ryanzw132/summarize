import { defineContentScript } from 'wxt/utils/define-content-script'

type InstagramTranscriptRequest = { type: 'instagram-transcript' }
type InstagramTranscriptResponse =
  | {
      ok: true
      videoUrl: string
      source: 'instagram-video'
      durationSeconds: number | null
      title: string | null
    }
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'unsupported_url' }

type InstagramMetadataRequest = { type: 'instagram-metadata' }
type InstagramScrollNextRequest = { type: 'instagram-scroll-next' }
type InstagramScrollNextResponse = { ok: boolean }
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

  // Try to extract from Instagram's shared data (embedded in page)
  if (!videoUrl) {
    // Look for video URL in page scripts
    const scripts = document.querySelectorAll('script[type="application/ld+json"]')
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent || '') as {
          '@type'?: string
          contentUrl?: string
          duration?: string
        }
        if (data['@type'] === 'VideoObject' && data.contentUrl) {
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

  // Try meta tags
  if (!videoUrl) {
    const ogVideo = document.querySelector('meta[property="og:video"]') as HTMLMetaElement | null
    videoUrl = ogVideo?.content || null
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
  const cleaned = text.replace(/,/g, '').trim().toLowerCase()
  const match = cleaned.match(/^([\d.]+)\s*([kmb]?)/)
  if (!match) return null
  const num = parseFloat(match[1])
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
 */
function scrollToNextReel(): InstagramScrollNextResponse {
  try {
    // Instagram Reels uses a vertical swipe interface
    // Try multiple methods

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
  } catch {
    return { ok: false }
  }
}

async function extractTranscript(): Promise<InstagramTranscriptResponse> {
  const { videoUrl, durationSeconds, title } = extractInstagramVideoInfo()

  if (!videoUrl) {
    return {
      ok: false,
      error: 'No downloadable video URL found on this Instagram page',
      reason: 'no_video',
    }
  }

  if (!videoUrl.startsWith('https://')) {
    return {
      ok: false,
      error: 'Instagram video URL is not downloadable',
      reason: 'unsupported_url',
    }
  }

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

    chrome.runtime.onMessage.addListener(
      (
        message: InstagramTranscriptRequest | InstagramMetadataRequest | InstagramScrollNextRequest,
        _sender,
        sendResponse: (response: InstagramTranscriptResponse | InstagramMetadataResponse | InstagramScrollNextResponse) => void
      ) => {
        if (message?.type === 'instagram-transcript') {
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
        return undefined
      }
    )
  },
})
