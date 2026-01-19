import { describe, expect, it } from 'vitest'

// Copy of patterns from transcript-main.ts for testing
// YouTube: regular videos, shorts, live, embed, and youtu.be short URLs
const YOUTUBE_PATTERN = /^https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)/
const TIKTOK_PATTERN = /^https?:\/\/(?:(?:www|vm|m)\.)?tiktok\.com\//
// Instagram: reels, posts, and IGTV
const INSTAGRAM_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\//

type Platform = 'youtube' | 'tiktok' | 'instagram' | null

function detectPlatform(url: string): Platform {
  if (YOUTUBE_PATTERN.test(url)) return 'youtube'
  if (TIKTOK_PATTERN.test(url)) return 'tiktok'
  if (INSTAGRAM_PATTERN.test(url)) return 'instagram'
  return null
}

describe('URL Pattern Matching - YouTube', () => {
  describe('should match valid YouTube URLs', () => {
    const validUrls = [
      // Standard watch URLs
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=abc123&list=PLxyz',

      // Mobile URLs
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',

      // Shorts
      'https://www.youtube.com/shorts/abc123def45',
      'https://youtube.com/shorts/abc123',
      'https://m.youtube.com/shorts/xyz789',

      // Live
      'https://www.youtube.com/live/abc123',
      'https://youtube.com/live/xyz789',

      // Embed
      'https://www.youtube.com/embed/abc123',
      'https://youtube.com/embed/xyz789',

      // Old /v/ format
      'https://www.youtube.com/v/abc123',
      'https://youtube.com/v/xyz789',

      // youtu.be short links
      'https://youtu.be/dQw4w9WgXcQ',
      'http://youtu.be/abc123',
      'https://youtu.be/xyz789?t=30',
    ]

    validUrls.forEach((url) => {
      it(`matches: ${url}`, () => {
        expect(detectPlatform(url)).toBe('youtube')
      })
    })
  })

  describe('should NOT match invalid YouTube URLs', () => {
    const invalidUrls = [
      // Homepage/browse
      'https://www.youtube.com/',
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/channel/UCxyz123',
      'https://www.youtube.com/@username',
      'https://www.youtube.com/playlist?list=PLxyz',

      // Results/search
      'https://www.youtube.com/results?search_query=test',

      // Not YouTube
      'https://notyoutube.com/watch?v=abc',
      'https://www.fakeyoutube.com/watch?v=abc',
      'youtube.com/watch?v=abc', // missing protocol
    ]

    invalidUrls.forEach((url) => {
      it(`does not match: ${url}`, () => {
        expect(detectPlatform(url)).not.toBe('youtube')
      })
    })
  })
})

describe('URL Pattern Matching - TikTok', () => {
  describe('should match valid TikTok URLs', () => {
    const validUrls = [
      // Standard video URLs
      'https://www.tiktok.com/@username/video/1234567890123456789',
      'https://tiktok.com/@user/video/123',
      'http://www.tiktok.com/@user/video/123',

      // Mobile URLs
      'https://m.tiktok.com/@username/video/123',

      // VM short links
      'https://vm.tiktok.com/abc123/',
      'http://vm.tiktok.com/xyz789',

      // Other TikTok pages (we match all tiktok.com for now)
      'https://www.tiktok.com/@username',
      'https://tiktok.com/trending',
    ]

    validUrls.forEach((url) => {
      it(`matches: ${url}`, () => {
        expect(detectPlatform(url)).toBe('tiktok')
      })
    })
  })

  describe('should NOT match invalid TikTok URLs', () => {
    const invalidUrls = [
      'https://nottiktok.com/@user/video/123',
      'tiktok.com/@user/video/123', // missing protocol
      'https://www.faketiktok.com/video/123',
    ]

    invalidUrls.forEach((url) => {
      it(`does not match: ${url}`, () => {
        expect(detectPlatform(url)).not.toBe('tiktok')
      })
    })
  })
})

describe('URL Pattern Matching - Instagram', () => {
  describe('should match valid Instagram URLs', () => {
    const validUrls = [
      // Reels
      'https://www.instagram.com/reel/ABC123xyz/',
      'https://instagram.com/reel/ABC123xyz',
      'http://www.instagram.com/reel/xyz789',

      // Reels (alternate path)
      'https://www.instagram.com/reels/ABC123xyz/',
      'https://instagram.com/reels/ABC123xyz',

      // Posts (can contain videos)
      'https://www.instagram.com/p/ABC123xyz/',
      'https://instagram.com/p/ABC123xyz',
      'http://www.instagram.com/p/xyz789',

      // IGTV
      'https://www.instagram.com/tv/ABC123xyz/',
      'https://instagram.com/tv/ABC123xyz',
    ]

    validUrls.forEach((url) => {
      it(`matches: ${url}`, () => {
        expect(detectPlatform(url)).toBe('instagram')
      })
    })
  })

  describe('should NOT match invalid Instagram URLs', () => {
    const invalidUrls = [
      // Homepage/browse
      'https://www.instagram.com/',
      'https://instagram.com/',

      // Profile pages
      'https://www.instagram.com/username/',
      'https://instagram.com/username',

      // Stories (not supported)
      'https://www.instagram.com/stories/username/',

      // Direct/messaging
      'https://www.instagram.com/direct/inbox/',

      // Explore
      'https://www.instagram.com/explore/',

      // Not Instagram
      'https://notinstagram.com/reel/abc',
      'instagram.com/reel/abc', // missing protocol
    ]

    invalidUrls.forEach((url) => {
      it(`does not match: ${url}`, () => {
        expect(detectPlatform(url)).not.toBe('instagram')
      })
    })
  })
})

describe('URL Pattern Matching - Edge Cases', () => {
  it('returns null for empty string', () => {
    expect(detectPlatform('')).toBe(null)
  })

  it('returns null for non-URL strings', () => {
    expect(detectPlatform('not a url')).toBe(null)
    expect(detectPlatform('youtube')).toBe(null)
    expect(detectPlatform('tiktok.com')).toBe(null)
  })

  it('returns null for other video platforms', () => {
    expect(detectPlatform('https://www.vimeo.com/123456')).toBe(null)
    expect(detectPlatform('https://www.dailymotion.com/video/xyz')).toBe(null)
    expect(detectPlatform('https://www.twitch.tv/videos/123')).toBe(null)
  })

  it('handles URLs with special characters', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc-_123')).toBe('youtube')
    expect(detectPlatform('https://www.instagram.com/reel/ABC-123_xyz/')).toBe('instagram')
  })

  it('handles URLs with query parameters', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc&t=30&list=PL123')).toBe('youtube')
    expect(detectPlatform('https://youtu.be/abc?t=60')).toBe('youtube')
  })

  it('handles URLs with fragments', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc#section')).toBe('youtube')
  })
})
