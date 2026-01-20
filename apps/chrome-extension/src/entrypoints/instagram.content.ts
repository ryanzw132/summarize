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
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'blob_too_large' }

type InstagramMetadataRequest = { type: 'instagram-metadata' }
type InstagramMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
}

// Maximum blob size to convert to data URL (50MB)
const MAX_BLOB_SIZE_BYTES = 50 * 1024 * 1024

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
 * Extract video metadata from Instagram page.
 */
function extractInstagramMetadata(): InstagramMetadataResponse {
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

  // Try from LD+JSON
  let postedAt: string | null = null
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
        break
      }
    } catch {
      // Continue to next script
    }
  }

  return { title, description, creator, postedAt, hashtags }
}

/**
 * Try to capture video blob from network requests.
 * This intercepts the video that's already loaded in the player.
 */
async function captureVideoBlob(): Promise<{ blob: Blob; url: string } | null> {
  const videoEl = document.querySelector('video') as HTMLVideoElement | null
  if (!videoEl?.src) return null

  try {
    // If it's a blob URL, we can access it directly
    if (videoEl.src.startsWith('blob:')) {
      const response = await fetch(videoEl.src)
      const blob = await response.blob()
      return { blob, url: videoEl.src }
    }

    // For regular URLs, try to fetch (may be CORS blocked)
    const response = await fetch(videoEl.src, { mode: 'cors' })
    if (response.ok) {
      const blob = await response.blob()
      return { blob, url: videoEl.src }
    }
  } catch {
    // CORS or network error
  }

  return null
}

async function extractTranscript(): Promise<InstagramTranscriptResponse> {
  const { videoUrl, durationSeconds, title } = extractInstagramVideoInfo()

  if (!videoUrl) {
    // Try to capture video blob as fallback
    const captured = await captureVideoBlob()
    if (captured) {
      // Check blob size before converting to data URL
      if (captured.blob.size > MAX_BLOB_SIZE_BYTES) {
        const sizeMB = (captured.blob.size / 1024 / 1024).toFixed(1)
        return {
          ok: false,
          error: `Video is too large (${sizeMB}MB) to process. Max size is 50MB.`,
          reason: 'blob_too_large',
        }
      }

      // Convert blob to base64 data URL for transport
      return new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => {
          resolve({
            ok: true,
            videoUrl: reader.result as string, // data:video/mp4;base64,...
            source: 'instagram-video',
            durationSeconds,
            title,
          })
        }
        reader.onerror = () => {
          resolve({
            ok: false,
            error: 'Failed to read video data',
            reason: 'extraction_failed',
          })
        }
        reader.readAsDataURL(captured.blob)
      })
    }

    return {
      ok: false,
      error: 'No video found on this Instagram page',
      reason: 'no_video',
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
        message: InstagramTranscriptRequest | InstagramMetadataRequest,
        _sender,
        sendResponse: (response: InstagramTranscriptResponse | InstagramMetadataResponse) => void
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
        return undefined
      }
    )
  },
})
