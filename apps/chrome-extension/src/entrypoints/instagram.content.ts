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
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' }

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
            error: 'No video found on this Instagram page',
            reason: 'no_video',
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
        message: InstagramTranscriptRequest,
        _sender,
        sendResponse: (response: InstagramTranscriptResponse) => void
      ) => {
        if (message?.type === 'instagram-transcript') {
          extractTranscript().then(sendResponse)
          return true // Keep channel open for async response
        }
        return undefined
      }
    )
  },
})
