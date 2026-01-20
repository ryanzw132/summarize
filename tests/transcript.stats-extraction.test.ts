import { describe, expect, it } from 'vitest'

// Types matching the updated VideoMetadataResponse
type VideoMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
  platform: 'tiktok' | 'instagram' | 'youtube'
  stats: {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  }
}

// Copy of formatNumber from transcript-main.ts
function formatNumber(num: number | null): string | null {
  if (num === null) return null
  if (num >= 1000000000) return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return num.toString()
}

// Copy of formatWithMetadata from transcript-main.ts
function formatWithMetadata(
  transcript: string,
  metadata: VideoMetadataResponse,
  options: { includeDetails: boolean; includeStats: boolean } = { includeDetails: true, includeStats: false }
): string {
  const parts: string[] = []

  // Platform label
  const platformName = metadata.platform === 'tiktok' ? 'TikTok'
    : metadata.platform === 'instagram' ? 'Instagram'
    : metadata.platform === 'youtube' ? 'YouTube'
    : 'Unknown'
  parts.push(`Platform: ${platformName}`)

  if (options.includeDetails) {
    if (metadata.title) {
      parts.push(`Title: ${metadata.title}`)
    }
    if (metadata.creator) {
      parts.push(`Creator: ${metadata.creator}`)
    }
    if (metadata.postedAt) {
      parts.push(`Posted: ${metadata.postedAt}`)
    }
    if (metadata.hashtags && metadata.hashtags.length > 0) {
      parts.push(`Hashtags: ${metadata.hashtags.join(' ')}`)
    }
    if (metadata.description && metadata.description !== metadata.title) {
      parts.push(`Description: ${metadata.description}`)
    }
  }

  if (options.includeStats && metadata.stats) {
    const statParts: string[] = []
    if (metadata.stats.views !== null) {
      statParts.push(`${formatNumber(metadata.stats.views)} views`)
    }
    if (metadata.stats.likes !== null) {
      statParts.push(`${formatNumber(metadata.stats.likes)} likes`)
    }
    if (metadata.stats.comments !== null) {
      statParts.push(`${formatNumber(metadata.stats.comments)} comments`)
    }
    if (metadata.stats.shares !== null) {
      statParts.push(`${formatNumber(metadata.stats.shares)} shares`)
    }
    if (statParts.length > 0) {
      parts.push(`Stats: ${statParts.join(' | ')}`)
    }
  }

  if (parts.length > 0) {
    return parts.join('\n') + '\n\n---\n\n' + transcript
  }

  return transcript
}

// Copy of parseInstagramNumber for testing
function parseInstagramNumber(text: string | null): number | null {
  if (!text) return null
  const cleaned = text.replace(/,/g, '').trim().toLowerCase()
  const match = cleaned.match(/^([\d.]+)\s*([kmb]?)/)
  if (!match) return null
  const num = parseFloat(match[1])
  if (isNaN(num)) return null
  const suffix = match[2]
  if (suffix === 'k') return Math.round(num * 1000)
  if (suffix === 'm') return Math.round(num * 1000000)
  if (suffix === 'b') return Math.round(num * 1000000000)
  return Math.round(num)
}

describe('formatNumber', () => {
  describe('null handling', () => {
    it('returns null for null input', () => {
      expect(formatNumber(null)).toBeNull()
    })
  })

  describe('small numbers (no abbreviation)', () => {
    it('formats 0 correctly', () => {
      expect(formatNumber(0)).toBe('0')
    })

    it('formats 1 correctly', () => {
      expect(formatNumber(1)).toBe('1')
    })

    it('formats 999 correctly', () => {
      expect(formatNumber(999)).toBe('999')
    })

    it('formats 100 correctly', () => {
      expect(formatNumber(100)).toBe('100')
    })
  })

  describe('thousands (K abbreviation)', () => {
    it('formats 1000 as 1K', () => {
      expect(formatNumber(1000)).toBe('1K')
    })

    it('formats 1500 as 1.5K', () => {
      expect(formatNumber(1500)).toBe('1.5K')
    })

    it('formats 10000 as 10K', () => {
      expect(formatNumber(10000)).toBe('10K')
    })

    it('formats 999999 as 1000K (not M)', () => {
      expect(formatNumber(999999)).toBe('1000K')
    })

    it('formats 50000 as 50K', () => {
      expect(formatNumber(50000)).toBe('50K')
    })

    it('formats 1234 as 1.2K', () => {
      expect(formatNumber(1234)).toBe('1.2K')
    })
  })

  describe('millions (M abbreviation)', () => {
    it('formats 1000000 as 1M', () => {
      expect(formatNumber(1000000)).toBe('1M')
    })

    it('formats 1500000 as 1.5M', () => {
      expect(formatNumber(1500000)).toBe('1.5M')
    })

    it('formats 10000000 as 10M', () => {
      expect(formatNumber(10000000)).toBe('10M')
    })

    it('formats 999999999 as 1000M (not B)', () => {
      expect(formatNumber(999999999)).toBe('1000M')
    })

    it('formats 2500000 as 2.5M', () => {
      expect(formatNumber(2500000)).toBe('2.5M')
    })
  })

  describe('billions (B abbreviation)', () => {
    it('formats 1000000000 as 1B', () => {
      expect(formatNumber(1000000000)).toBe('1B')
    })

    it('formats 1500000000 as 1.5B', () => {
      expect(formatNumber(1500000000)).toBe('1.5B')
    })

    it('formats 10000000000 as 10B', () => {
      expect(formatNumber(10000000000)).toBe('10B')
    })
  })

  describe('edge cases', () => {
    it('removes trailing .0 from 1.0K', () => {
      expect(formatNumber(1000)).toBe('1K')
      expect(formatNumber(1000)).not.toBe('1.0K')
    })

    it('removes trailing .0 from 1.0M', () => {
      expect(formatNumber(1000000)).toBe('1M')
      expect(formatNumber(1000000)).not.toBe('1.0M')
    })

    it('removes trailing .0 from 1.0B', () => {
      expect(formatNumber(1000000000)).toBe('1B')
      expect(formatNumber(1000000000)).not.toBe('1.0B')
    })
  })
})

describe('parseInstagramNumber (reverse of formatNumber)', () => {
  describe('null handling', () => {
    it('returns null for null input', () => {
      expect(parseInstagramNumber(null)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseInstagramNumber('')).toBeNull()
    })
  })

  describe('plain numbers', () => {
    it('parses 0', () => {
      expect(parseInstagramNumber('0')).toBe(0)
    })

    it('parses 999', () => {
      expect(parseInstagramNumber('999')).toBe(999)
    })

    it('parses numbers with commas', () => {
      expect(parseInstagramNumber('1,234')).toBe(1234)
      expect(parseInstagramNumber('1,234,567')).toBe(1234567)
    })
  })

  describe('K abbreviation', () => {
    it('parses 1K', () => {
      expect(parseInstagramNumber('1K')).toBe(1000)
    })

    it('parses 1.5K', () => {
      expect(parseInstagramNumber('1.5K')).toBe(1500)
    })

    it('parses 10K', () => {
      expect(parseInstagramNumber('10K')).toBe(10000)
    })

    it('parses lowercase k', () => {
      expect(parseInstagramNumber('1k')).toBe(1000)
    })
  })

  describe('M abbreviation', () => {
    it('parses 1M', () => {
      expect(parseInstagramNumber('1M')).toBe(1000000)
    })

    it('parses 1.5M', () => {
      expect(parseInstagramNumber('1.5M')).toBe(1500000)
    })

    it('parses 10M', () => {
      expect(parseInstagramNumber('10M')).toBe(10000000)
    })
  })

  describe('B abbreviation', () => {
    it('parses 1B', () => {
      expect(parseInstagramNumber('1B')).toBe(1000000000)
    })

    it('parses 1.5B', () => {
      expect(parseInstagramNumber('1.5B')).toBe(1500000000)
    })
  })

  describe('whitespace handling', () => {
    it('handles leading/trailing spaces', () => {
      expect(parseInstagramNumber('  1K  ')).toBe(1000)
    })

    it('handles space before suffix', () => {
      expect(parseInstagramNumber('1 K')).toBe(1000)
    })
  })
})

describe('formatWithMetadata with stats', () => {
  const sampleTranscript = 'This is a test transcript.'

  const fullMetadata: VideoMetadataResponse = {
    title: 'Amazing Video Title',
    description: 'A great description',
    creator: '@testuser',
    postedAt: 'January 15, 2024',
    hashtags: ['#fyp', '#viral'],
    platform: 'tiktok',
    stats: {
      views: 1500000,
      likes: 50000,
      comments: 1234,
      shares: 500,
    },
  }

  describe('platform label', () => {
    it('always includes platform label for TikTok', () => {
      const result = formatWithMetadata(sampleTranscript, { ...fullMetadata, platform: 'tiktok' }, { includeDetails: false, includeStats: false })
      expect(result).toContain('Platform: TikTok')
    })

    it('always includes platform label for Instagram', () => {
      const result = formatWithMetadata(sampleTranscript, { ...fullMetadata, platform: 'instagram' }, { includeDetails: false, includeStats: false })
      expect(result).toContain('Platform: Instagram')
    })

    it('always includes platform label for YouTube', () => {
      const result = formatWithMetadata(sampleTranscript, { ...fullMetadata, platform: 'youtube' }, { includeDetails: false, includeStats: false })
      expect(result).toContain('Platform: YouTube')
    })

    it('platform label comes first', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: true })
      expect(result.indexOf('Platform:')).toBe(0)
    })
  })

  describe('includeDetails option', () => {
    it('includes details when includeDetails is true', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: false })
      expect(result).toContain('Title: Amazing Video Title')
      expect(result).toContain('Creator: @testuser')
      expect(result).toContain('Posted: January 15, 2024')
      expect(result).toContain('Hashtags: #fyp #viral')
    })

    it('excludes details when includeDetails is false', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: false, includeStats: false })
      expect(result).not.toContain('Title:')
      expect(result).not.toContain('Creator:')
      expect(result).not.toContain('Posted:')
      expect(result).not.toContain('Hashtags:')
    })
  })

  describe('includeStats option', () => {
    it('includes stats when includeStats is true', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats:')
      expect(result).toContain('1.5M views')
      expect(result).toContain('50K likes')
      expect(result).toContain('1.2K comments')
      expect(result).toContain('500 shares')
    })

    it('excludes stats when includeStats is false', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: false })
      expect(result).not.toContain('Stats:')
      expect(result).not.toContain('views')
      expect(result).not.toContain('likes')
    })

    it('formats stats with pipe separator', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats: 1.5M views | 50K likes | 1.2K comments | 500 shares')
    })
  })

  describe('both options enabled', () => {
    it('includes both details and stats', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: true })
      expect(result).toContain('Platform: TikTok')
      expect(result).toContain('Title: Amazing Video Title')
      expect(result).toContain('Creator: @testuser')
      expect(result).toContain('Stats:')
      expect(result).toContain('1.5M views')
    })

    it('maintains correct order: Platform, Title, Creator, Posted, Hashtags, Description, Stats', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: true })
      const platformIdx = result.indexOf('Platform:')
      const titleIdx = result.indexOf('Title:')
      const creatorIdx = result.indexOf('Creator:')
      const postedIdx = result.indexOf('Posted:')
      const hashtagsIdx = result.indexOf('Hashtags:')
      const statsIdx = result.indexOf('Stats:')

      expect(platformIdx).toBeLessThan(titleIdx)
      expect(titleIdx).toBeLessThan(creatorIdx)
      expect(creatorIdx).toBeLessThan(postedIdx)
      expect(postedIdx).toBeLessThan(hashtagsIdx)
      expect(hashtagsIdx).toBeLessThan(statsIdx)
    })
  })

  describe('partial stats', () => {
    it('handles only views', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: 1000, likes: null, comments: null, shares: null },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats: 1K views')
      expect(result).not.toContain('likes')
      expect(result).not.toContain('comments')
      expect(result).not.toContain('shares')
    })

    it('handles only likes', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: null, likes: 500, comments: null, shares: null },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats: 500 likes')
      expect(result).not.toContain('views')
    })

    it('handles views and likes only', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: 1000000, likes: 50000, comments: null, shares: null },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats: 1M views | 50K likes')
      expect(result).not.toContain('comments')
      expect(result).not.toContain('shares')
    })

    it('handles all stats as null', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: null, likes: null, comments: null, shares: null },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).not.toContain('Stats:')
    })

    it('handles zero values', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: 0, likes: 0, comments: 0, shares: 0 },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('Stats: 0 views | 0 likes | 0 comments | 0 shares')
    })
  })

  describe('edge cases', () => {
    it('handles very large numbers', () => {
      const metadata: VideoMetadataResponse = {
        ...fullMetadata,
        stats: { views: 5000000000, likes: 100000000, comments: 10000000, shares: 1000000 },
      }
      const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })
      expect(result).toContain('5B views')
      expect(result).toContain('100M likes')
      expect(result).toContain('10M comments')
      expect(result).toContain('1M shares')
    })

    it('includes transcript after separator', () => {
      const result = formatWithMetadata(sampleTranscript, fullMetadata, { includeDetails: true, includeStats: true })
      expect(result).toContain('---')
      expect(result).toContain(sampleTranscript)
      expect(result.indexOf('---')).toBeLessThan(result.indexOf(sampleTranscript))
    })
  })
})

describe('Stats Extraction Types Validation', () => {
  describe('TikTok metadata response', () => {
    it('should have all required fields', () => {
      const tikTokMetadata: VideoMetadataResponse = {
        title: 'TikTok Video',
        description: 'Description',
        creator: '@tiktokuser',
        postedAt: 'January 1, 2024',
        hashtags: ['#fyp'],
        platform: 'tiktok',
        stats: {
          views: 1000000,
          likes: 50000,
          comments: 1000,
          shares: 500,
        },
      }
      expect(tikTokMetadata.platform).toBe('tiktok')
      expect(tikTokMetadata.stats).toBeDefined()
      expect(tikTokMetadata.stats.views).toBe(1000000)
      expect(tikTokMetadata.stats.likes).toBe(50000)
      expect(tikTokMetadata.stats.comments).toBe(1000)
      expect(tikTokMetadata.stats.shares).toBe(500)
    })
  })

  describe('Instagram metadata response', () => {
    it('should have all required fields', () => {
      const instagramMetadata: VideoMetadataResponse = {
        title: 'Instagram Reel',
        description: 'Description',
        creator: '@instagramuser',
        postedAt: 'January 1, 2024',
        hashtags: ['#reels'],
        platform: 'instagram',
        stats: {
          views: 500000,
          likes: 25000,
          comments: 500,
          shares: null, // Instagram often doesn't expose shares
        },
      }
      expect(instagramMetadata.platform).toBe('instagram')
      expect(instagramMetadata.stats).toBeDefined()
      expect(instagramMetadata.stats.views).toBe(500000)
      expect(instagramMetadata.stats.likes).toBe(25000)
      expect(instagramMetadata.stats.comments).toBe(500)
      expect(instagramMetadata.stats.shares).toBeNull()
    })
  })

  describe('YouTube metadata response', () => {
    it('should have all required fields', () => {
      const youtubeMetadata: VideoMetadataResponse = {
        title: 'YouTube Shorts',
        description: 'Description',
        creator: '@youtuber',
        postedAt: 'January 1, 2024',
        hashtags: ['#shorts'],
        platform: 'youtube',
        stats: {
          views: 2000000,
          likes: 100000,
          comments: 5000,
          shares: null, // YouTube doesn't expose shares
        },
      }
      expect(youtubeMetadata.platform).toBe('youtube')
      expect(youtubeMetadata.stats).toBeDefined()
      expect(youtubeMetadata.stats.views).toBe(2000000)
      expect(youtubeMetadata.stats.likes).toBe(100000)
      expect(youtubeMetadata.stats.comments).toBe(5000)
      expect(youtubeMetadata.stats.shares).toBeNull()
    })
  })
})

describe('Real-world Stats Scenarios', () => {
  const sampleTranscript = 'Video transcript content here.'

  it('formats typical TikTok viral video stats', () => {
    const metadata: VideoMetadataResponse = {
      title: 'POV: when the code finally works',
      description: 'POV: when the code finally works #coding #programmer #fyp',
      creator: '@techcreator',
      postedAt: 'December 15, 2023',
      hashtags: ['#coding', '#programmer', '#fyp'],
      platform: 'tiktok',
      stats: {
        views: 2500000,
        likes: 350000,
        comments: 8500,
        shares: 15000,
      },
    }

    const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: true, includeStats: true })

    expect(result).toContain('Platform: TikTok')
    expect(result).toContain('Stats: 2.5M views | 350K likes | 8.5K comments | 15K shares')
    expect(result).toContain('Creator: @techcreator')
    expect(result).toContain('Hashtags: #coding #programmer #fyp')
  })

  it('formats typical Instagram Reel stats', () => {
    const metadata: VideoMetadataResponse = {
      title: 'Beautiful sunset in Bali',
      description: 'Incredible views from Uluwatu',
      creator: '@travelphotographer',
      postedAt: 'January 10, 2024',
      hashtags: ['#bali', '#travel', '#sunset'],
      platform: 'instagram',
      stats: {
        views: 850000,
        likes: 45000,
        comments: 1200,
        shares: null,
      },
    }

    const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: true, includeStats: true })

    expect(result).toContain('Platform: Instagram')
    expect(result).toContain('Stats: 850K views | 45K likes | 1.2K comments')
    expect(result).not.toContain('shares') // null shares should be omitted
  })

  it('formats typical YouTube Shorts stats', () => {
    const metadata: VideoMetadataResponse = {
      title: 'Mind-blowing science fact #shorts',
      description: 'Did you know this about quantum physics?',
      creator: '@sciencechannel',
      postedAt: 'January 5, 2024',
      hashtags: ['#shorts', '#science', '#facts'],
      platform: 'youtube',
      stats: {
        views: 5000000,
        likes: 250000,
        comments: 12000,
        shares: null,
      },
    }

    const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: true, includeStats: true })

    expect(result).toContain('Platform: YouTube')
    expect(result).toContain('Stats: 5M views | 250K likes | 12K comments')
  })

  it('handles small creator video with low stats', () => {
    const metadata: VideoMetadataResponse = {
      title: 'My first video',
      description: 'Just getting started!',
      creator: '@newcreator',
      postedAt: 'January 20, 2024',
      hashtags: ['#firstpost'],
      platform: 'tiktok',
      stats: {
        views: 150,
        likes: 12,
        comments: 3,
        shares: 1,
      },
    }

    const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: true, includeStats: true })

    expect(result).toContain('Stats: 150 views | 12 likes | 3 comments | 1 shares')
  })

  it('handles video with only partial stats available', () => {
    const metadata: VideoMetadataResponse = {
      title: 'Quick tip',
      description: 'Helpful hint',
      creator: '@helper',
      postedAt: 'January 18, 2024',
      hashtags: [],
      platform: 'instagram',
      stats: {
        views: null, // View count hidden
        likes: 5000,
        comments: null, // Comments disabled
        shares: null,
      },
    }

    const result = formatWithMetadata(sampleTranscript, metadata, { includeDetails: false, includeStats: true })

    expect(result).toContain('Stats: 5K likes')
    expect(result).not.toContain('views')
    expect(result).not.toContain('comments')
    expect(result).not.toContain('shares')
  })
})
