import { describe, expect, it } from 'vitest'

// Copy of shouldShowButton logic from transcript-button.content.ts for testing
function shouldShowButton(url: string): boolean {
  // YouTube Shorts
  if (/youtube\.com\/shorts\//.test(url)) return true

  // TikTok videos
  // Standard video URLs: tiktok.com/@username/video/id
  if (/tiktok\.com\/@[^/]+\/video\//.test(url)) return true
  // Short links: vm.tiktok.com/id (always redirect to videos)
  if (/vm\.tiktok\.com\//.test(url)) return true
  // Mobile video URLs: m.tiktok.com/v/id or m.tiktok.com/@user/video/id
  if (/m\.tiktok\.com\/v\//.test(url)) return true
  if (/m\.tiktok\.com\/@[^/]+\/video\//.test(url)) return true

  // Instagram Reels and posts
  if (/instagram\.com\/(?:reel|reels|p|tv)\//.test(url)) return true

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

    it('hides button on mobile TikTok non-video pages', () => {
      expect(shouldShowButton('https://m.tiktok.com/')).toBe(false)
      expect(shouldShowButton('https://m.tiktok.com/@username')).toBe(false)
      expect(shouldShowButton('https://m.tiktok.com/foryou')).toBe(false)
    })

    it('hides button on TikTok profile pages', () => {
      expect(shouldShowButton('https://www.tiktok.com/@username')).toBe(false)
    })

    it('hides button on TikTok homepage', () => {
      expect(shouldShowButton('https://www.tiktok.com/')).toBe(false)
      expect(shouldShowButton('https://www.tiktok.com/foryou')).toBe(false)
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

    it('hides button on Instagram homepage', () => {
      expect(shouldShowButton('https://www.instagram.com/')).toBe(false)
    })

    it('hides button on Instagram profile pages', () => {
      expect(shouldShowButton('https://www.instagram.com/username/')).toBe(false)
      expect(shouldShowButton('https://www.instagram.com/username')).toBe(false)
    })

    it('hides button on Instagram stories', () => {
      expect(shouldShowButton('https://www.instagram.com/stories/username/')).toBe(false)
    })

    it('hides button on Instagram explore', () => {
      expect(shouldShowButton('https://www.instagram.com/explore/')).toBe(false)
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
  })
})
