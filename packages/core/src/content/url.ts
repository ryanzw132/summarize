import { isPodcastHost } from './link-preview/content/podcast-utils.js'
import { isTwitterStatusUrl } from './link-preview/content/twitter-utils.js'

export const isYouTubeUrl = (rawUrl: string): boolean => {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname.includes('youtube.com') || hostname.includes('youtu.be')
  } catch {
    const lower = rawUrl.toLowerCase()
    return lower.includes('youtube.com') || lower.includes('youtu.be')
  }
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

export function isYouTubeVideoUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()

    if (hostname === 'youtu.be') {
      return Boolean(url.pathname.split('/').filter(Boolean)[0])
    }

    if (!hostname.includes('youtube.com')) {
      return false
    }

    if (url.pathname === '/watch') {
      return Boolean(url.searchParams.get('v')?.trim())
    }

    return (
      url.pathname.startsWith('/shorts/') ||
      url.pathname.startsWith('/live/') ||
      url.pathname.startsWith('/embed/') ||
      url.pathname.startsWith('/v/')
    )
  } catch {
    return false
  }
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()
    let candidate: string | null = null
    if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/')[1] ?? null
    }
    if (hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/watch')) {
        candidate = url.searchParams.get('v')
      } else if (url.pathname.startsWith('/shorts/')) {
        candidate = url.pathname.split('/')[2] ?? null
      } else if (url.pathname.startsWith('/embed/')) {
        candidate = url.pathname.split('/')[2] ?? null
      } else if (url.pathname.startsWith('/v/')) {
        candidate = url.pathname.split('/')[2] ?? null
      }
    }

    const trimmed = candidate?.trim() ?? ''
    if (!trimmed) {
      return null
    }
    return YOUTUBE_VIDEO_ID_PATTERN.test(trimmed) ? trimmed : null
  } catch {
    // ignore parsing errors
  }
  return null
}

export function isDirectMediaUrl(url: string): boolean {
  // Check for common video/audio file extensions
  if (/\.(mp4|mov|m4v|mkv|webm|mp3|m4a|wav|flac|aac)(\?|#|$)/i.test(url)) {
    return true
  }

  // Check for known video CDN hostnames (Instagram, TikTok)
  // These often don't have file extensions in the URL
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    // Instagram CDN: scontent-xxx.cdninstagram.com, instagram.fxxx.fna.fbcdn.net
    if (hostname.includes('cdninstagram.com') || hostname.includes('fbcdn.net')) {
      return true
    }
    // TikTok CDN: v16-xxx.tiktokcdn.com, v19-xxx.tiktokcdn-us.com
    if (hostname.includes('tiktokcdn')) {
      return true
    }
  } catch {
    // ignore parsing errors
  }

  return false
}

export function shouldPreferUrlMode(url: string): boolean {
  return (
    isYouTubeVideoUrl(url) || isTwitterStatusUrl(url) || isDirectMediaUrl(url) || isPodcastHost(url)
  )
}

export { isTwitterStatusUrl, isPodcastHost }
