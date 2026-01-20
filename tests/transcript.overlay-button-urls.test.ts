import { describe, expect, it } from 'vitest'

/**
 * Copy of shouldShowButton logic from transcript-button.content.ts for testing.
 * Note: Some URL patterns require video elements to be present in the DOM.
 * Since tests don't have DOM access, we simulate "hasVideo" as a parameter.
 */
function shouldShowButton(url: string, hasVideo: boolean = false): boolean {
  // YouTube Shorts
  if (/youtube\.com\/shorts\//.test(url)) return true

  // TikTok videos - multiple URL patterns
  // Standard video URLs: tiktok.com/@username/video/id
  if (/tiktok\.com\/@[^/]+\/video\//.test(url)) return true
  // Short links: vm.tiktok.com/id (always redirect to videos)
  if (/vm\.tiktok\.com\//.test(url)) return true
  // Mobile video URLs: m.tiktok.com/v/id or m.tiktok.com/@user/video/id
  if (/m\.tiktok\.com\/v\//.test(url)) return true
  if (/m\.tiktok\.com\/@[^/]+\/video\//.test(url)) return true
  // TikTok FYP and Explore pages - check if a video is actually playing
  if (/tiktok\.com\/(foryou|explore|discover|following)?(\?|$)/i.test(url)) {
    return hasVideo
  }
  // TikTok search results with videos
  if (/tiktok\.com\/search/.test(url)) {
    return hasVideo
  }
  // TikTok profile pages viewing a video (modal overlay)
  if (/tiktok\.com\/@[^/]+\/?(\?|$)/.test(url)) {
    return hasVideo
  }

  // Instagram Reels and posts
  if (/instagram\.com\/(?:reel|reels|p|tv)\//.test(url)) return true
  // Instagram Explore/Feed with video modal open
  if (/instagram\.com\/(explore|reels)?\/?(\?|$)/i.test(url)) {
    return hasVideo
  }

  return false
}

describe('Overlay Button URL Matching', () => {
  describe('YouTube Shorts', () => {
    it('shows button on YouTube Shorts', () => {
      expect(shouldShowButton('https://www.youtube.com/shorts/abc123')).toBe(true)
      expect(shouldShowButton('https://youtube.com/shorts/xyz789')).toBe(true)
      expect(shouldShowButton('https://m.youtube.com/shorts/def456')).toBe(true)
    })

    it('hides button on regular YouTube videos', () => {
      expect(shouldShowButton('https://www.youtube.com/watch?v=abc123')).toBe(false)
      expect(shouldShowButton('https://youtu.be/abc123')).toBe(false)
    })

    it('hides button on YouTube homepage', () => {
      expect(shouldShowButton('https://www.youtube.com/')).toBe(false)
      expect(shouldShowButton('https://www.youtube.com/feed/subscriptions')).toBe(false)
    })
  })

  describe('TikTok', () => {
    it('shows button on TikTok video pages', () => {
      expect(shouldShowButton('https://www.tiktok.com/@username/video/1234567890')).toBe(true)
      expect(shouldShowButton('https://tiktok.com/@user/video/123')).toBe(true)
    })

    it('shows button on TikTok short links', () => {
      expect(shouldShowButton('https://vm.tiktok.com/abc123/')).toBe(true)
      expect(shouldShowButton('http://vm.tiktok.com/xyz789')).toBe(true)
    })

    it('shows button on mobile TikTok video URLs', () => {
      expect(shouldShowButton('https://m.tiktok.com/@username/video/123')).toBe(true)
      expect(shouldShowButton('https://m.tiktok.com/v/123456789')).toBe(true)
    })

    it('hides button on TikTok FYP without video element', () => {
      expect(shouldShowButton('https://www.tiktok.com/')).toBe(false)
      expect(shouldShowButton('https://www.tiktok.com/foryou')).toBe(false)
      expect(shouldShowButton('https://www.tiktok.com/explore')).toBe(false)
    })

    it('shows button on TikTok FYP with video element', () => {
      expect(shouldShowButton('https://www.tiktok.com/', true)).toBe(true)
      expect(shouldShowButton('https://www.tiktok.com/foryou', true)).toBe(true)
      expect(shouldShowButton('https://www.tiktok.com/explore', true)).toBe(true)
      expect(shouldShowButton('https://www.tiktok.com/following', true)).toBe(true)
    })

    it('hides button on TikTok profile pages without video modal', () => {
      expect(shouldShowButton('https://www.tiktok.com/@username')).toBe(false)
      expect(shouldShowButton('https://www.tiktok.com/@username/')).toBe(false)
    })

    it('shows button on TikTok profile pages with video modal', () => {
      expect(shouldShowButton('https://www.tiktok.com/@username', true)).toBe(true)
      expect(shouldShowButton('https://www.tiktok.com/@username/', true)).toBe(true)
    })

    it('hides button on TikTok search without video', () => {
      expect(shouldShowButton('https://www.tiktok.com/search?q=test')).toBe(false)
    })

    it('shows button on TikTok search with video', () => {
      expect(shouldShowButton('https://www.tiktok.com/search?q=test', true)).toBe(true)
    })

    it('hides button on mobile TikTok non-video pages', () => {
      expect(shouldShowButton('https://m.tiktok.com/')).toBe(false)
      expect(shouldShowButton('https://m.tiktok.com/@username')).toBe(false)
      expect(shouldShowButton('https://m.tiktok.com/foryou')).toBe(false)
    })
  })

  describe('Instagram', () => {
    it('shows button on Instagram Reels', () => {
      expect(shouldShowButton('https://www.instagram.com/reel/ABC123xyz/')).toBe(true)
      expect(shouldShowButton('https://instagram.com/reel/ABC123xyz')).toBe(true)
      expect(shouldShowButton('https://www.instagram.com/reels/ABC123xyz/')).toBe(true)
    })

    it('shows button on Instagram Posts', () => {
      expect(shouldShowButton('https://www.instagram.com/p/ABC123xyz/')).toBe(true)
      expect(shouldShowButton('https://instagram.com/p/ABC123xyz')).toBe(true)
    })

    it('shows button on IGTV', () => {
      expect(shouldShowButton('https://www.instagram.com/tv/ABC123xyz/')).toBe(true)
    })

    it('hides button on Instagram homepage without video', () => {
      expect(shouldShowButton('https://www.instagram.com/')).toBe(false)
    })

    it('shows button on Instagram homepage with video modal', () => {
      expect(shouldShowButton('https://www.instagram.com/', true)).toBe(true)
    })

    it('hides button on Instagram profile pages', () => {
      expect(shouldShowButton('https://www.instagram.com/username/')).toBe(false)
      expect(shouldShowButton('https://www.instagram.com/username')).toBe(false)
    })

    it('hides button on Instagram stories', () => {
      expect(shouldShowButton('https://www.instagram.com/stories/username/')).toBe(false)
    })

    it('hides button on Instagram explore without video', () => {
      expect(shouldShowButton('https://www.instagram.com/explore/')).toBe(false)
    })

    it('shows button on Instagram explore with video', () => {
      expect(shouldShowButton('https://www.instagram.com/explore/', true)).toBe(true)
    })

    it('shows button on Instagram reels feed with video', () => {
      expect(shouldShowButton('https://www.instagram.com/reels/', true)).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    it('handles empty URL', () => {
      expect(shouldShowButton('')).toBe(false)
    })

    it('handles non-video platform URLs', () => {
      expect(shouldShowButton('https://www.google.com/')).toBe(false)
      expect(shouldShowButton('https://www.twitter.com/user/status/123')).toBe(false)
    })

    it('handles URLs with query parameters', () => {
      expect(shouldShowButton('https://www.youtube.com/shorts/abc123?feature=share')).toBe(true)
      expect(shouldShowButton('https://www.instagram.com/reel/ABC123/?utm_source=test')).toBe(true)
    })

    it('handles TikTok FYP with query params', () => {
      expect(shouldShowButton('https://www.tiktok.com/foryou?lang=en', true)).toBe(true)
      expect(shouldShowButton('https://www.tiktok.com/?is_copy_url=1', true)).toBe(true)
    })
  })
})
