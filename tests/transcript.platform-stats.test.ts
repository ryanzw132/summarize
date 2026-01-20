import { describe, expect, it } from 'vitest'

/**
 * Tests for platform-specific stats extraction logic.
 * These tests verify the parsing functions work correctly with real-world data structures.
 */

// ============================================================================
// TikTok Stats Extraction
// ============================================================================

describe('TikTok Stats Extraction', () => {
  // Simulate the data structure from __UNIVERSAL_DATA_FOR_REHYDRATION__
  interface TikTokHydrationData {
    __DEFAULT_SCOPE__?: {
      'webapp.video-detail'?: {
        itemInfo?: {
          itemStruct?: {
            desc?: string
            createTime?: number | string
            author?: {
              uniqueId?: string
              nickname?: string
            }
            stats?: {
              playCount?: number
              diggCount?: number
              commentCount?: number
              shareCount?: number
            }
          }
        }
      }
    }
  }

  function extractTikTokStats(data: TikTokHydrationData): {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  } {
    const statsData = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct?.stats
    return {
      views: typeof statsData?.playCount === 'number' ? statsData.playCount : null,
      likes: typeof statsData?.diggCount === 'number' ? statsData.diggCount : null,
      comments: typeof statsData?.commentCount === 'number' ? statsData.commentCount : null,
      shares: typeof statsData?.shareCount === 'number' ? statsData.shareCount : null,
    }
  }

  describe('with complete stats', () => {
    it('extracts all stats correctly', () => {
      const data: TikTokHydrationData = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                stats: {
                  playCount: 1500000,
                  diggCount: 75000,
                  commentCount: 3500,
                  shareCount: 1200,
                },
              },
            },
          },
        },
      }

      const stats = extractTikTokStats(data)

      expect(stats.views).toBe(1500000)
      expect(stats.likes).toBe(75000)
      expect(stats.comments).toBe(3500)
      expect(stats.shares).toBe(1200)
    })

    it('handles zero values', () => {
      const data: TikTokHydrationData = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                stats: {
                  playCount: 0,
                  diggCount: 0,
                  commentCount: 0,
                  shareCount: 0,
                },
              },
            },
          },
        },
      }

      const stats = extractTikTokStats(data)

      expect(stats.views).toBe(0)
      expect(stats.likes).toBe(0)
      expect(stats.comments).toBe(0)
      expect(stats.shares).toBe(0)
    })

    it('handles very large numbers (viral videos)', () => {
      const data: TikTokHydrationData = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                stats: {
                  playCount: 500000000, // 500M views
                  diggCount: 25000000, // 25M likes
                  commentCount: 500000, // 500K comments
                  shareCount: 1000000, // 1M shares
                },
              },
            },
          },
        },
      }

      const stats = extractTikTokStats(data)

      expect(stats.views).toBe(500000000)
      expect(stats.likes).toBe(25000000)
      expect(stats.comments).toBe(500000)
      expect(stats.shares).toBe(1000000)
    })
  })

  describe('with missing data', () => {
    it('returns all null when no data', () => {
      const stats = extractTikTokStats({})

      expect(stats.views).toBeNull()
      expect(stats.likes).toBeNull()
      expect(stats.comments).toBeNull()
      expect(stats.shares).toBeNull()
    })

    it('returns all null when stats object is missing', () => {
      const data: TikTokHydrationData = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                desc: 'Video description',
                // stats object missing
              },
            },
          },
        },
      }

      const stats = extractTikTokStats(data)

      expect(stats.views).toBeNull()
      expect(stats.likes).toBeNull()
      expect(stats.comments).toBeNull()
      expect(stats.shares).toBeNull()
    })

    it('handles partial stats', () => {
      const data: TikTokHydrationData = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                stats: {
                  playCount: 1000,
                  // other stats missing
                },
              },
            },
          },
        },
      }

      const stats = extractTikTokStats(data)

      expect(stats.views).toBe(1000)
      expect(stats.likes).toBeNull()
      expect(stats.comments).toBeNull()
      expect(stats.shares).toBeNull()
    })
  })

  describe('type validation', () => {
    it('rejects string values for stats', () => {
      const data = {
        __DEFAULT_SCOPE__: {
          'webapp.video-detail': {
            itemInfo: {
              itemStruct: {
                stats: {
                  playCount: '1000' as unknown as number, // string instead of number
                  diggCount: 500,
                },
              },
            },
          },
        },
      } as TikTokHydrationData

      const stats = extractTikTokStats(data)

      // Should reject string, return null
      expect(stats.views).toBeNull()
      expect(stats.likes).toBe(500)
    })
  })
})

// ============================================================================
// Instagram Stats Extraction
// ============================================================================

describe('Instagram Stats Extraction', () => {
  // Simulate Instagram number parsing (from display format)
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

  // Simulate extracting stats from LD+JSON interactionStatistic
  interface LdJsonInteractionStat {
    '@type'?: string
    interactionType?: { '@type'?: string } | string
    userInteractionCount?: number | string
  }

  function extractFromLdJson(interactionStatistic: LdJsonInteractionStat[]): {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  } {
    const stats = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null }

    for (const stat of interactionStatistic) {
      const type = typeof stat.interactionType === 'string'
        ? stat.interactionType
        : stat.interactionType?.['@type']
      const count = typeof stat.userInteractionCount === 'number'
        ? stat.userInteractionCount
        : typeof stat.userInteractionCount === 'string'
          ? parseInt(stat.userInteractionCount, 10)
          : null

      if (count !== null && !isNaN(count)) {
        if (type?.includes('Watch') || type?.includes('View')) {
          stats.views = count
        } else if (type?.includes('Like')) {
          stats.likes = count
        } else if (type?.includes('Comment')) {
          stats.comments = count
        } else if (type?.includes('Share')) {
          stats.shares = count
        }
      }
    }

    return stats
  }

  describe('parseInstagramNumber', () => {
    it('parses plain numbers', () => {
      expect(parseInstagramNumber('1234')).toBe(1234)
      expect(parseInstagramNumber('0')).toBe(0)
      expect(parseInstagramNumber('999')).toBe(999)
    })

    it('parses K suffix', () => {
      expect(parseInstagramNumber('1.5K')).toBe(1500)
      expect(parseInstagramNumber('10k')).toBe(10000)
      expect(parseInstagramNumber('999K')).toBe(999000)
    })

    it('parses M suffix', () => {
      expect(parseInstagramNumber('1.2M')).toBe(1200000)
      expect(parseInstagramNumber('5m')).toBe(5000000)
      expect(parseInstagramNumber('100M')).toBe(100000000)
    })

    it('parses B suffix', () => {
      expect(parseInstagramNumber('1B')).toBe(1000000000)
      expect(parseInstagramNumber('1.5b')).toBe(1500000000)
    })

    it('handles commas in numbers', () => {
      expect(parseInstagramNumber('1,234')).toBe(1234)
      expect(parseInstagramNumber('1,234,567')).toBe(1234567)
    })

    it('handles whitespace', () => {
      expect(parseInstagramNumber('  1.5K  ')).toBe(1500)
      expect(parseInstagramNumber('1 K')).toBe(1000)
    })

    it('returns null for invalid input', () => {
      expect(parseInstagramNumber(null)).toBeNull()
      expect(parseInstagramNumber('')).toBeNull()
      expect(parseInstagramNumber('abc')).toBeNull()
      expect(parseInstagramNumber('likes')).toBeNull()
    })
  })

  describe('LD+JSON extraction', () => {
    it('extracts all stats from complete data', () => {
      const interactionStatistic: LdJsonInteractionStat[] = [
        { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: 500000 },
        { '@type': 'InteractionCounter', interactionType: { '@type': 'LikeAction' }, userInteractionCount: 25000 },
        { '@type': 'InteractionCounter', interactionType: { '@type': 'CommentAction' }, userInteractionCount: 1000 },
      ]

      const stats = extractFromLdJson(interactionStatistic)

      expect(stats.views).toBe(500000)
      expect(stats.likes).toBe(25000)
      expect(stats.comments).toBe(1000)
    })

    it('handles string interaction types', () => {
      const interactionStatistic: LdJsonInteractionStat[] = [
        { '@type': 'InteractionCounter', interactionType: 'WatchAction', userInteractionCount: 100000 },
        { '@type': 'InteractionCounter', interactionType: 'LikeAction', userInteractionCount: 5000 },
      ]

      const stats = extractFromLdJson(interactionStatistic)

      expect(stats.views).toBe(100000)
      expect(stats.likes).toBe(5000)
    })

    it('handles string counts', () => {
      const interactionStatistic: LdJsonInteractionStat[] = [
        { '@type': 'InteractionCounter', interactionType: 'ViewAction', userInteractionCount: '750000' },
      ]

      const stats = extractFromLdJson(interactionStatistic)

      expect(stats.views).toBe(750000)
    })

    it('returns nulls for empty array', () => {
      const stats = extractFromLdJson([])

      expect(stats.views).toBeNull()
      expect(stats.likes).toBeNull()
      expect(stats.comments).toBeNull()
      expect(stats.shares).toBeNull()
    })
  })

  describe('DOM text patterns', () => {
    // Test common Instagram display patterns
    const patterns = [
      { text: '1,234 likes', expected: { type: 'likes', value: 1234 } },
      { text: '50K likes', expected: { type: 'likes', value: 50000 } },
      { text: '1.2M views', expected: { type: 'views', value: 1200000 } },
      { text: '500 comments', expected: { type: 'comments', value: 500 } },
      { text: '10,000 views', expected: { type: 'views', value: 10000 } },
    ]

    patterns.forEach(({ text, expected }) => {
      it(`parses "${text}" correctly`, () => {
        const match = text.match(/([\d,]+(?:\.\d+)?[KMB]?)\s*(?:views?|plays?|likes?|comments?)/i)
        expect(match).not.toBeNull()
        if (match) {
          const value = parseInstagramNumber(match[1])
          expect(value).toBe(expected.value)
        }
      })
    })
  })
})

// ============================================================================
// YouTube Stats Extraction
// ============================================================================

describe('YouTube Stats Extraction', () => {
  function parseYouTubeNumber(text: string | null): number | null {
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

  interface YouTubePlayerResponse {
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

  function extractFromPlayerResponse(data: YouTubePlayerResponse): {
    title: string | null
    creator: string | null
    views: number | null
    postedAt: string | null
  } {
    const result = {
      title: null as string | null,
      creator: null as string | null,
      views: null as number | null,
      postedAt: null as string | null,
    }

    if (data.videoDetails) {
      result.title = data.videoDetails.title || null
      result.creator = data.videoDetails.author ? `@${data.videoDetails.author}` : null
      if (data.videoDetails.viewCount) {
        const parsed = parseInt(data.videoDetails.viewCount, 10)
        result.views = isNaN(parsed) ? null : parsed
      }
    }

    if (data.microformat?.playerMicroformatRenderer?.publishDate) {
      const date = new Date(data.microformat.playerMicroformatRenderer.publishDate)
      if (!isNaN(date.getTime())) {
        result.postedAt = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      }
    }

    return result
  }

  describe('parseYouTubeNumber', () => {
    it('parses view counts with commas', () => {
      expect(parseYouTubeNumber('1,234,567')).toBe(1234567)
      expect(parseYouTubeNumber('500,000')).toBe(500000)
    })

    it('parses abbreviated numbers', () => {
      expect(parseYouTubeNumber('1.5M')).toBe(1500000)
      expect(parseYouTubeNumber('500K')).toBe(500000)
      expect(parseYouTubeNumber('2.3B')).toBe(2300000000)
    })

    it('returns null for invalid input', () => {
      expect(parseYouTubeNumber(null)).toBeNull()
      expect(parseYouTubeNumber('')).toBeNull()
      expect(parseYouTubeNumber('No views')).toBeNull()
    })
  })

  describe('Player response extraction', () => {
    it('extracts complete data', () => {
      const data: YouTubePlayerResponse = {
        videoDetails: {
          title: 'Amazing Science Fact #shorts',
          shortDescription: 'Did you know this?',
          author: 'ScienceChannel',
          viewCount: '5000000',
        },
        microformat: {
          playerMicroformatRenderer: {
            publishDate: '2024-01-15',
            ownerChannelName: 'Science Channel',
          },
        },
      }

      const result = extractFromPlayerResponse(data)

      expect(result.title).toBe('Amazing Science Fact #shorts')
      expect(result.creator).toBe('@ScienceChannel')
      expect(result.views).toBe(5000000)
      // Date may vary by timezone, just check it contains the year and month
      expect(result.postedAt).toContain('2024')
      expect(result.postedAt).toContain('January')
    })

    it('handles missing fields gracefully', () => {
      const data: YouTubePlayerResponse = {
        videoDetails: {
          title: 'Quick Video',
        },
      }

      const result = extractFromPlayerResponse(data)

      expect(result.title).toBe('Quick Video')
      expect(result.creator).toBeNull()
      expect(result.views).toBeNull()
      expect(result.postedAt).toBeNull()
    })

    it('handles empty object', () => {
      const result = extractFromPlayerResponse({})

      expect(result.title).toBeNull()
      expect(result.creator).toBeNull()
      expect(result.views).toBeNull()
      expect(result.postedAt).toBeNull()
    })

    it('handles very large view counts', () => {
      const data: YouTubePlayerResponse = {
        videoDetails: {
          viewCount: '10000000000', // 10 billion
        },
      }

      const result = extractFromPlayerResponse(data)

      expect(result.views).toBe(10000000000)
    })
  })

  describe('DOM extraction patterns', () => {
    // Test common YouTube display patterns
    const viewCountPatterns = [
      { text: '1,234,567 views', expected: 1234567 },
      { text: '500K views', expected: 500000 },
      { text: '1.2M views', expected: 1200000 },
      { text: '5B views', expected: 5000000000 },
    ]

    viewCountPatterns.forEach(({ text, expected }) => {
      it(`parses "${text}" correctly`, () => {
        const match = text.match(/([\d,.]+[KMB]?)\s*views?/i)
        expect(match).not.toBeNull()
        if (match) {
          const value = parseYouTubeNumber(match[1])
          expect(value).toBe(expected)
        }
      })
    })

    const likeButtonPatterns = [
      { ariaLabel: 'like this video along with 50,000 other people', expected: 50000 },
      { ariaLabel: '1.2M likes', expected: 1200000 },
    ]

    likeButtonPatterns.forEach(({ ariaLabel, expected }) => {
      it(`extracts likes from aria-label "${ariaLabel}"`, () => {
        // Regex that handles both comma-separated numbers and abbreviated (1.2M)
        const match = ariaLabel.match(/([\d,.]+[KMB]?)/i)
        expect(match).not.toBeNull()
        if (match) {
          const value = parseYouTubeNumber(match[1])
          expect(value).toBe(expected)
        }
      })
    })
  })
})

// ============================================================================
// Cross-Platform Stats Consistency
// ============================================================================

describe('Cross-Platform Stats Consistency', () => {
  // Stats structure should be consistent across all platforms
  interface UnifiedStats {
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
  }

  function validateStatsStructure(stats: UnifiedStats): boolean {
    const hasValidViews = stats.views === null || (typeof stats.views === 'number' && stats.views >= 0)
    const hasValidLikes = stats.likes === null || (typeof stats.likes === 'number' && stats.likes >= 0)
    const hasValidComments = stats.comments === null || (typeof stats.comments === 'number' && stats.comments >= 0)
    const hasValidShares = stats.shares === null || (typeof stats.shares === 'number' && stats.shares >= 0)
    return hasValidViews && hasValidLikes && hasValidComments && hasValidShares
  }

  it('TikTok stats structure is valid', () => {
    const tiktokStats: UnifiedStats = {
      views: 1000000,
      likes: 50000,
      comments: 1000,
      shares: 500,
    }
    expect(validateStatsStructure(tiktokStats)).toBe(true)
  })

  it('Instagram stats structure is valid (often missing shares)', () => {
    const instagramStats: UnifiedStats = {
      views: 500000,
      likes: 25000,
      comments: 500,
      shares: null, // Instagram doesn't always expose shares
    }
    expect(validateStatsStructure(instagramStats)).toBe(true)
  })

  it('YouTube stats structure is valid (no shares)', () => {
    const youtubeStats: UnifiedStats = {
      views: 2000000,
      likes: 100000,
      comments: 5000,
      shares: null, // YouTube doesn't expose shares
    }
    expect(validateStatsStructure(youtubeStats)).toBe(true)
  })

  it('empty stats structure is valid', () => {
    const emptyStats: UnifiedStats = {
      views: null,
      likes: null,
      comments: null,
      shares: null,
    }
    expect(validateStatsStructure(emptyStats)).toBe(true)
  })

  it('rejects negative stats', () => {
    const invalidStats: UnifiedStats = {
      views: -1,
      likes: 1000,
      comments: 100,
      shares: 10,
    }
    expect(validateStatsStructure(invalidStats)).toBe(false)
  })
})
