import { describe, expect, it } from 'vitest'

// Test the URL path matching logic for Instagram creator extraction
function extractCreatorFromPath(pathname: string): string | null {
  // Try from URL path (e.g., /username/reel/xxx)
  const pathMatch = pathname.match(/^\/([^/]+)\/(?:reel|reels|p|tv)\//)
  if (pathMatch?.[1] && !['reel', 'reels', 'p', 'tv'].includes(pathMatch[1])) {
    return `@${pathMatch[1]}`
  }
  return null
}

// Test the title parsing logic for Instagram
function extractCreatorFromTitle(ogTitle: string | null): string | null {
  if (!ogTitle) return null
  const titleMatch = ogTitle.match(/^(.+?) on Instagram:/)
  if (titleMatch?.[1]) {
    return `@${titleMatch[1].trim()}`
  }
  return null
}

// Test the description mention extraction
function extractCreatorFromDescription(description: string | null): string | null {
  if (!description) return null
  const mentionMatch = description.match(/@([a-zA-Z0-9._]+)/)
  if (mentionMatch?.[1]) {
    return `@${mentionMatch[1]}`
  }
  return null
}

describe('Instagram Metadata Extraction', () => {
  describe('extractCreatorFromPath', () => {
    it('extracts username from profile-based reel URLs', () => {
      expect(extractCreatorFromPath('/username/reel/ABC123/')).toBe('@username')
      expect(extractCreatorFromPath('/cool_user123/reel/xyz/')).toBe('@cool_user123')
    })

    it('extracts username from profile-based post URLs', () => {
      expect(extractCreatorFromPath('/username/p/ABC123/')).toBe('@username')
    })

    it('extracts username from profile-based reels URLs', () => {
      expect(extractCreatorFromPath('/username/reels/ABC123/')).toBe('@username')
    })

    it('extracts username from IGTV URLs', () => {
      expect(extractCreatorFromPath('/username/tv/ABC123/')).toBe('@username')
    })

    it('returns null for direct reel URLs (no username in path)', () => {
      expect(extractCreatorFromPath('/reel/ABC123/')).toBe(null)
      expect(extractCreatorFromPath('/reels/ABC123/')).toBe(null)
    })

    it('returns null for direct post URLs', () => {
      expect(extractCreatorFromPath('/p/ABC123/')).toBe(null)
    })

    it('returns null for profile pages', () => {
      expect(extractCreatorFromPath('/username/')).toBe(null)
      expect(extractCreatorFromPath('/username')).toBe(null)
    })

    it('returns null for homepage', () => {
      expect(extractCreatorFromPath('/')).toBe(null)
    })

    it('handles usernames with dots and underscores', () => {
      expect(extractCreatorFromPath('/user.name/reel/ABC/')).toBe('@user.name')
      expect(extractCreatorFromPath('/user_name/reel/ABC/')).toBe('@user_name')
      expect(extractCreatorFromPath('/user.name_123/p/ABC/')).toBe('@user.name_123')
    })
  })

  describe('extractCreatorFromTitle', () => {
    it('extracts username from standard Instagram title format', () => {
      expect(extractCreatorFromTitle('John Doe on Instagram: "Check this out!"'))
        .toBe('@John Doe')
    })

    it('extracts username with special characters', () => {
      expect(extractCreatorFromTitle('Cool_User123 on Instagram: "Video caption"'))
        .toBe('@Cool_User123')
    })

    it('handles titles with emojis in username', () => {
      expect(extractCreatorFromTitle('User 🎬 on Instagram: "Caption"'))
        .toBe('@User 🎬')
    })

    it('returns null for non-standard titles', () => {
      expect(extractCreatorFromTitle('Just a regular title')).toBe(null)
      expect(extractCreatorFromTitle('Instagram')).toBe(null)
    })

    it('returns null for null/empty input', () => {
      expect(extractCreatorFromTitle(null)).toBe(null)
      expect(extractCreatorFromTitle('')).toBe(null)
    })

    it('trims whitespace from extracted username', () => {
      expect(extractCreatorFromTitle('  User  on Instagram: "Caption"'))
        .toBe('@User')
    })
  })

  describe('extractCreatorFromDescription', () => {
    it('extracts first @mention from description', () => {
      expect(extractCreatorFromDescription('Check out @username for more content'))
        .toBe('@username')
    })

    it('extracts username with dots and underscores', () => {
      expect(extractCreatorFromDescription('Video by @user.name_123'))
        .toBe('@user.name_123')
    })

    it('returns first mention when multiple present', () => {
      expect(extractCreatorFromDescription('@first_user and @second_user collab'))
        .toBe('@first_user')
    })

    it('returns null when no mention present', () => {
      expect(extractCreatorFromDescription('No mentions here')).toBe(null)
    })

    it('returns null for null/empty input', () => {
      expect(extractCreatorFromDescription(null)).toBe(null)
      expect(extractCreatorFromDescription('')).toBe(null)
    })

    it('does not match invalid username characters', () => {
      // @ followed by space should not match
      expect(extractCreatorFromDescription('Email us @ support')).toBe(null)
    })
  })

  describe('fallback chain priority', () => {
    // This tests the intended behavior of the extraction chain
    it('URL path should be tried first', () => {
      // If URL path has username, use it
      const fromPath = extractCreatorFromPath('/realuser/reel/ABC/')
      expect(fromPath).toBe('@realuser')
    })

    it('title should be tried second when path fails', () => {
      // Direct URLs don't have username in path
      const fromPath = extractCreatorFromPath('/reel/ABC/')
      expect(fromPath).toBe(null)

      // Fall back to title
      const fromTitle = extractCreatorFromTitle('ActualCreator on Instagram: "Caption"')
      expect(fromTitle).toBe('@ActualCreator')
    })

    it('description mentions should be last resort', () => {
      const fromPath = extractCreatorFromPath('/reel/ABC/')
      expect(fromPath).toBe(null)

      const fromTitle = extractCreatorFromTitle('Some generic title')
      expect(fromTitle).toBe(null)

      // Fall back to description
      const fromDesc = extractCreatorFromDescription('Posted by @hidden_user')
      expect(fromDesc).toBe('@hidden_user')
    })
  })
})
