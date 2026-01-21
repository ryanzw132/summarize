import { defineContentScript } from 'wxt/utils/define-content-script'

type YouTubeMetadataRequest = { type: 'youtube-metadata' }
type YouTubeScrollNextRequest = { type: 'youtube-scroll-next' }
type YouTubeScrollNextResponse = { ok: boolean }
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
 */
function parseYouTubeNumber(text: string | null): number | null {
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
 * Extract hashtags from a text string.
 */
function extractHashtags(text: string | null): string[] {
  if (!text) return []
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g)
  if (!matches) return []
  return [...new Set(matches)]
}

/**
 * Extract metadata from ytInitialPlayerResponse.
 */
function extractFromPlayerResponse(): Partial<YouTubeMetadataResponse> {
  const result: Partial<YouTubeMetadataResponse> = {}

  // Try to find ytInitialPlayerResponse in page scripts
  const scripts = document.querySelectorAll('script')
  for (const script of scripts) {
    const text = script.textContent || ''
    const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/)
    if (match?.[1]) {
      try {
        const data = JSON.parse(match[1]) as {
          videoDetails?: {
            title?: string
            shortDescription?: string
            author?: string
            viewCount?: string
          }
          microformat?: {
            playerMicroformatRenderer?: {
              publishDate?: string
              ownerChannelName?: string
            }
          }
        }

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
        }

        // Extract hashtags from description
        if (result.description) {
          result.hashtags = extractHashtags(result.description)
        }

        break
      } catch {
        // Continue to next script
      }
    }
  }

  return result
}

/**
 * Extract metadata from ytInitialData (for Shorts specifically).
 */
function extractFromInitialData(): Partial<YouTubeMetadataResponse> {
  const result: Partial<YouTubeMetadataResponse> = {}

  const scripts = document.querySelectorAll('script')
  for (const script of scripts) {
    const text = script.textContent || ''
    const match = text.match(/var\s+ytInitialData\s*=\s*(\{[\s\S]+?\});/)
    if (match?.[1]) {
      try {
        const data = JSON.parse(match[1])

        // Navigate to engagement panel for stats (structure varies)
        // Try to find view count in various locations
        const findViewCount = (obj: unknown, depth = 0): string | null => {
          if (depth > 10 || !obj || typeof obj !== 'object') return null
          const o = obj as Record<string, unknown>

          // Check for viewCount text
          if (typeof o.viewCount === 'object' && o.viewCount !== null) {
            const vc = o.viewCount as Record<string, unknown>
            if (typeof vc.simpleText === 'string') return vc.simpleText
            if (typeof vc.runs === 'object' && Array.isArray(vc.runs)) {
              const texts = (vc.runs as Array<{ text?: string }>)
                .map(r => r.text || '')
                .join('')
              if (texts) return texts
            }
          }

          // Check for viewCountText
          if (typeof o.viewCountText === 'object' && o.viewCountText !== null) {
            const vct = o.viewCountText as Record<string, unknown>
            if (typeof vct.simpleText === 'string') return vct.simpleText
            if (typeof vct.runs === 'object' && Array.isArray(vct.runs)) {
              const texts = (vct.runs as Array<{ text?: string }>)
                .map(r => r.text || '')
                .join('')
              if (texts) return texts
            }
          }

          // Recurse into object
          for (const key of Object.keys(o)) {
            if (typeof o[key] === 'object' && o[key] !== null) {
              const found = findViewCount(o[key], depth + 1)
              if (found) return found
            }
          }

          return null
        }

        const viewCountText = findViewCount(data)
        if (viewCountText) {
          const viewMatch = viewCountText.match(/([\d,.]+[KMB]?)\s*views?/i)
          if (viewMatch) {
            result.stats = result.stats || { views: null, likes: null, comments: null, shares: null }
            result.stats.views = parseYouTubeNumber(viewMatch[1])
          }
        }

        break
      } catch {
        // Continue to next script
      }
    }
  }

  return result
}

/**
 * Extract stats from DOM elements.
 */
function extractStatsFromDOM(): { views: number | null; likes: number | null; comments: number | null; shares: number | null } {
  const stats = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null }

  // For YouTube Shorts, look for specific elements
  const isShorts = window.location.pathname.startsWith('/shorts/')

  if (isShorts) {
    // Shorts has a different layout - stats are in the action bar
    // Look for like button with count
    const actionButtons = document.querySelectorAll('ytd-reel-video-renderer[is-active] ytd-toggle-button-renderer, #actions ytd-toggle-button-renderer, ytd-shorts-player-controls button')

    for (const btn of actionButtons) {
      const ariaLabel = btn.getAttribute('aria-label') || ''
      const text = btn.textContent || ''

      // Check aria-label for "like this video along with X other people"
      const likeMatch = ariaLabel.match(/like.*?(\d[\d,]*[KMB]?)/i) || text.match(/^([\d,]+[KMB]?)$/i)
      if (likeMatch && stats.likes === null) {
        stats.likes = parseYouTubeNumber(likeMatch[1])
      }

      // Comments - look for comment count
      const commentMatch = ariaLabel.match(/(\d[\d,]*[KMB]?)\s*comments?/i)
      if (commentMatch && stats.comments === null) {
        stats.comments = parseYouTubeNumber(commentMatch[1])
      }
    }

    // Look for view count in various places
    const viewElements = document.querySelectorAll(
      'ytd-reel-video-renderer[is-active] .ytd-reel-video-renderer, ' +
      'span.view-count, .ytd-video-view-count-renderer, ' +
      '#info-container span'
    )
    for (const el of viewElements) {
      const text = el.textContent || ''
      const viewMatch = text.match(/([\d,.]+[KMB]?)\s*views?/i)
      if (viewMatch && stats.views === null) {
        stats.views = parseYouTubeNumber(viewMatch[1])
      }
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

    // Likes - look for like button
    const likeButton = document.querySelector('ytd-toggle-button-renderer#top-level-buttons-computed [aria-label*="like"], like-button-view-model button, #segmented-like-button button')
    if (likeButton) {
      const ariaLabel = likeButton.getAttribute('aria-label') || ''
      const text = likeButton.textContent || ''
      const likeMatch = ariaLabel.match(/(\d[\d,]*[KMB]?)/i) || text.match(/([\d,]+[KMB]?)/i)
      if (likeMatch) {
        stats.likes = parseYouTubeNumber(likeMatch[1])
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

  return stats
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
  const emptyResponse: YouTubeMetadataResponse = {
    title: null,
    description: null,
    creator: null,
    postedAt: null,
    hashtags: [],
    platform: 'youtube',
    stats: { views: null, likes: null, comments: null, shares: null },
  }

  // Get data from player response
  const playerData = extractFromPlayerResponse()

  // Get data from initial data (mainly for Shorts)
  const initialData = extractFromInitialData()

  // Get stats from DOM
  const domStats = extractStatsFromDOM()

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

  return result
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_youtube_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    chrome.runtime.onMessage.addListener(
      (
        message: YouTubeMetadataRequest | YouTubeScrollNextRequest,
        _sender,
        sendResponse: (response: YouTubeMetadataResponse | YouTubeScrollNextResponse) => void
      ) => {
        if (message?.type === 'youtube-metadata') {
          sendResponse(extractYouTubeMetadata())
          return false
        }
        if (message?.type === 'youtube-scroll-next') {
          sendResponse(scrollToNextShort())
          return false
        }
        return undefined
      }
    )
  },
})
