import { describe, expect, it } from 'vitest'

/**
 * Tests for URL pattern detection across platforms.
 * These ensure the transcript extractor correctly identifies supported platforms.
 */

// Copy of URL patterns from transcript-main.ts
const YOUTUBE_PATTERN = /^https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)/
const TIKTOK_PATTERN = /^https?:\/\/(?:(?:www|vm|m)\.)?tiktok\.com\//
const INSTAGRAM_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\//

type Platform = 'youtube' | 'tiktok' | 'instagram' | null

function detectPlatform(url: string): Platform {
  if (YOUTUBE_PATTERN.test(url)) return 'youtube'
  if (TIKTOK_PATTERN.test(url)) return 'tiktok'
  if (INSTAGRAM_PATTERN.test(url)) return 'instagram'
  return null
}

describe('YouTube URL Detection', () => {
  describe('regular videos', () => {
    it('detects youtube.com/watch URLs', () => {
      expect(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
      expect(detectPlatform('https://youtube.com/watch?v=abc123')).toBe('youtube')
      expect(detectPlatform('http://www.youtube.com/watch?v=xyz')).toBe('youtube')
    })

    it('detects mobile youtube URLs', () => {
      expect(detectPlatform('https://m.youtube.com/watch?v=abc123')).toBe('youtube')
    })
  })

  describe('YouTube Shorts', () => {
    it('detects youtube.com/shorts URLs', () => {
      expect(detectPlatform('https://www.youtube.com/shorts/abc123')).toBe('youtube')
      expect(detectPlatform('https://youtube.com/shorts/xyz789')).toBe('youtube')
    })

    it('detects mobile shorts URLs', () => {
      expect(detectPlatform('https://m.youtube.com/shorts/abc123')).toBe('youtube')
    })
  })

  describe('live streams', () => {
    it('detects youtube.com/live URLs', () => {
      expect(detectPlatform('https://www.youtube.com/live/abc123')).toBe('youtube')
    })
  })

  describe('embed URLs', () => {
    it('detects youtube.com/embed URLs', () => {
      expect(detectPlatform('https://www.youtube.com/embed/abc123')).toBe('youtube')
    })

    it('detects youtube.com/v URLs', () => {
      expect(detectPlatform('https://www.youtube.com/v/abc123')).toBe('youtube')
    })
  })

  describe('short URLs', () => {
    it('detects youtu.be URLs', () => {
      expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube')
      expect(detectPlatform('http://youtu.be/abc123')).toBe('youtube')
    })
  })

  describe('non-matching URLs', () => {
    it('does not match YouTube homepage', () => {
      expect(detectPlatform('https://www.youtube.com')).toBe(null)
      expect(detectPlatform('https://www.youtube.com/')).toBe(null)
    })

    it('does not match YouTube search', () => {
      expect(detectPlatform('https://www.youtube.com/results?search_query=test')).toBe(null)
    })

    it('does not match YouTube channel pages', () => {
      expect(detectPlatform('https://www.youtube.com/@channelname')).toBe(null)
      expect(detectPlatform('https://www.youtube.com/channel/UCabc123')).toBe(null)
    })
  })
})

describe('TikTok URL Detection', () => {
  describe('video URLs', () => {
    it('detects tiktok.com video URLs', () => {
      expect(detectPlatform('https://www.tiktok.com/@user/video/1234567890')).toBe('tiktok')
      expect(detectPlatform('https://tiktok.com/@username/video/9876543210')).toBe('tiktok')
    })

    it('detects mobile TikTok URLs', () => {
      expect(detectPlatform('https://m.tiktok.com/@user/video/1234567890')).toBe('tiktok')
    })

    it('detects vm.tiktok.com short URLs', () => {
      expect(detectPlatform('https://vm.tiktok.com/ZMaBcDeF/')).toBe('tiktok')
      expect(detectPlatform('http://vm.tiktok.com/xyz123')).toBe('tiktok')
    })
  })

  describe('other TikTok pages', () => {
    it('matches TikTok profile pages', () => {
      expect(detectPlatform('https://www.tiktok.com/@username')).toBe('tiktok')
    })

    it('matches TikTok discover page', () => {
      expect(detectPlatform('https://www.tiktok.com/discover')).toBe('tiktok')
    })
  })

  describe('non-matching URLs', () => {
    it('does not match other domains', () => {
      expect(detectPlatform('https://tiktok.org/')).toBe(null)
      expect(detectPlatform('https://not-tiktok.com/')).toBe(null)
    })
  })
})

describe('Instagram URL Detection', () => {
  describe('Reels', () => {
    it('detects instagram.com/reel URLs', () => {
      expect(detectPlatform('https://www.instagram.com/reel/abc123/')).toBe('instagram')
      expect(detectPlatform('https://instagram.com/reel/xyz789')).toBe('instagram')
    })

    it('detects instagram.com/reels URLs', () => {
      expect(detectPlatform('https://www.instagram.com/reels/abc123/')).toBe('instagram')
    })
  })

  describe('Posts', () => {
    it('detects instagram.com/p URLs', () => {
      expect(detectPlatform('https://www.instagram.com/p/abc123/')).toBe('instagram')
      expect(detectPlatform('https://instagram.com/p/xyz')).toBe('instagram')
    })
  })

  describe('IGTV', () => {
    it('detects instagram.com/tv URLs', () => {
      expect(detectPlatform('https://www.instagram.com/tv/abc123/')).toBe('instagram')
    })
  })

  describe('non-matching URLs', () => {
    it('does not match Instagram homepage', () => {
      expect(detectPlatform('https://www.instagram.com')).toBe(null)
      expect(detectPlatform('https://www.instagram.com/')).toBe(null)
    })

    it('does not match Instagram profiles', () => {
      expect(detectPlatform('https://www.instagram.com/username')).toBe(null)
      expect(detectPlatform('https://www.instagram.com/@username')).toBe(null)
    })

    it('does not match Instagram stories', () => {
      expect(detectPlatform('https://www.instagram.com/stories/username/123')).toBe(null)
    })

    it('does not match Instagram explore', () => {
      expect(detectPlatform('https://www.instagram.com/explore/')).toBe(null)
    })
  })
})

describe('Unsupported Platforms', () => {
  it('returns null for Twitter/X', () => {
    expect(detectPlatform('https://twitter.com/user/status/123')).toBe(null)
    expect(detectPlatform('https://x.com/user/status/123')).toBe(null)
  })

  it('returns null for Facebook', () => {
    expect(detectPlatform('https://www.facebook.com/video/123')).toBe(null)
  })

  it('returns null for Vimeo', () => {
    expect(detectPlatform('https://vimeo.com/123456')).toBe(null)
  })

  it('returns null for random URLs', () => {
    expect(detectPlatform('https://example.com')).toBe(null)
    expect(detectPlatform('https://google.com')).toBe(null)
  })

  it('returns null for empty string', () => {
    expect(detectPlatform('')).toBe(null)
  })

  it('returns null for invalid URLs', () => {
    expect(detectPlatform('not-a-url')).toBe(null)
    expect(detectPlatform('file:///path/to/file')).toBe(null)
  })
})

describe('Edge Cases', () => {
  it('handles URLs with query parameters', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc123&t=120')).toBe('youtube')
    expect(detectPlatform('https://www.tiktok.com/@user/video/123?lang=en')).toBe('tiktok')
    expect(detectPlatform('https://www.instagram.com/reel/abc/?utm_source=ig')).toBe('instagram')
  })

  it('handles URLs with fragments', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc123#start')).toBe('youtube')
  })

  it('handles URLs with trailing slashes', () => {
    expect(detectPlatform('https://www.youtube.com/shorts/abc123/')).toBe('youtube')
    expect(detectPlatform('https://www.tiktok.com/@user/video/123/')).toBe('tiktok')
  })

  it('handles URLs with mixed case', () => {
    expect(detectPlatform('HTTPS://WWW.YOUTUBE.COM/watch?v=abc')).toBe(null) // Regex is case-sensitive for protocol
    expect(detectPlatform('https://WWW.YOUTUBE.COM/watch?v=abc')).toBe(null) // Domain is case-sensitive in regex
  })
})
