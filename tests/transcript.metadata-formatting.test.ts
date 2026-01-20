import { describe, expect, it } from 'vitest'

// Copy of VideoMetadataResponse type and formatWithMetadata from transcript-main.ts
type VideoMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
  hashtags: string[]
}

function formatWithMetadata(transcript: string, metadata: VideoMetadataResponse): string {
  const parts: string[] = []

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

  if (parts.length > 0) {
    return parts.join('\n') + '\n\n---\n\n' + transcript
  }

  return transcript
}

// Copy of extractHashtags function for testing
function extractHashtags(text: string | null): string[] {
  if (!text) return []
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g)
  if (!matches) return []
  return [...new Set(matches)]
}

describe('Metadata Formatting', () => {
  const sampleTranscript = 'Hello world this is a test transcript.'

  describe('with full metadata', () => {
    it('formats all fields correctly', () => {
      const metadata: VideoMetadataResponse = {
        title: 'My Amazing Video',
        description: 'A detailed description of the video',
        creator: '@username',
        postedAt: 'January 15, 2024',
        hashtags: ['#fyp', '#viral', '#trending'],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toContain('Title: My Amazing Video')
      expect(result).toContain('Creator: @username')
      expect(result).toContain('Posted: January 15, 2024')
      expect(result).toContain('Hashtags: #fyp #viral #trending')
      expect(result).toContain('Description: A detailed description of the video')
      expect(result).toContain('---')
      expect(result).toContain(sampleTranscript)
    })

    it('maintains correct order: Title, Creator, Posted, Hashtags, Description', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Title',
        description: 'Desc',
        creator: '@user',
        postedAt: 'Date',
        hashtags: ['#test'],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      const titleIndex = result.indexOf('Title:')
      const creatorIndex = result.indexOf('Creator:')
      const postedIndex = result.indexOf('Posted:')
      const hashtagsIndex = result.indexOf('Hashtags:')
      const descIndex = result.indexOf('Description:')

      expect(titleIndex).toBeLessThan(creatorIndex)
      expect(creatorIndex).toBeLessThan(postedIndex)
      expect(postedIndex).toBeLessThan(hashtagsIndex)
      expect(hashtagsIndex).toBeLessThan(descIndex)
    })
  })

  describe('with partial metadata', () => {
    it('handles missing title', () => {
      const metadata: VideoMetadataResponse = {
        title: null,
        description: 'A description',
        creator: '@username',
        postedAt: 'January 15, 2024',
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).not.toContain('Title:')
      expect(result).toContain('Creator: @username')
      expect(result).toContain('---')
    })

    it('handles missing creator', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Video Title',
        description: 'A description',
        creator: null,
        postedAt: 'January 15, 2024',
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toContain('Title: Video Title')
      expect(result).not.toContain('Creator:')
    })

    it('handles missing date', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Video Title',
        description: null,
        creator: '@username',
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).not.toContain('Posted:')
      expect(result).toContain('Title: Video Title')
    })

    it('handles only title', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Just a Title',
        description: null,
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toBe('Title: Just a Title\n\n---\n\n' + sampleTranscript)
    })

    it('handles only hashtags', () => {
      const metadata: VideoMetadataResponse = {
        title: null,
        description: null,
        creator: null,
        postedAt: null,
        hashtags: ['#fyp', '#viral'],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toBe('Hashtags: #fyp #viral\n\n---\n\n' + sampleTranscript)
    })

    it('handles empty hashtags array', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Title',
        description: null,
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).not.toContain('Hashtags:')
      expect(result).toContain('Title: Title')
    })
  })

  describe('with no metadata', () => {
    it('returns transcript unchanged when all fields are null/empty', () => {
      const metadata: VideoMetadataResponse = {
        title: null,
        description: null,
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toBe(sampleTranscript)
      expect(result).not.toContain('---')
    })

    it('returns transcript unchanged when all fields are empty strings', () => {
      const metadata: VideoMetadataResponse = {
        title: '',
        description: '',
        creator: '',
        postedAt: '',
        hashtags: [],
      } as unknown as VideoMetadataResponse // Cast to allow empty strings for test

      const result = formatWithMetadata(sampleTranscript, metadata)

      // Empty strings are falsy, so they should be skipped
      expect(result).toBe(sampleTranscript)
    })
  })

  describe('description deduplication', () => {
    it('excludes description when it matches title', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Same Text',
        description: 'Same Text',
        creator: '@username',
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toContain('Title: Same Text')
      expect(result).not.toContain('Description:')
    })

    it('includes description when different from title', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Video Title',
        description: 'Different description here',
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toContain('Title: Video Title')
      expect(result).toContain('Description: Different description here')
    })
  })

  describe('special characters', () => {
    it('handles newlines in metadata fields', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Title with\nnewline',
        description: null,
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      expect(result).toContain('Title: Title with\nnewline')
    })

    it('handles unicode characters', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Video 🎬 with emojis',
        description: null,
        creator: '@用户名',
        postedAt: null,
        hashtags: ['#日本語', '#한국어'],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      expect(result).toContain('Title: Video 🎬 with emojis')
      expect(result).toContain('Creator: @用户名')
      expect(result).toContain('Hashtags: #日本語 #한국어')
    })

    it('handles very long text', () => {
      const longText = 'A'.repeat(10000)
      const metadata: VideoMetadataResponse = {
        title: longText,
        description: null,
        creator: null,
        postedAt: null,
        hashtags: [],
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      expect(result).toContain(`Title: ${longText}`)
      expect(result).toContain(sampleTranscript)
    })
  })
})

describe('Hashtag Extraction', () => {
  describe('basic extraction', () => {
    it('extracts single hashtag', () => {
      expect(extractHashtags('Check out #fyp')).toEqual(['#fyp'])
    })

    it('extracts multiple hashtags', () => {
      expect(extractHashtags('#fyp #viral #trending')).toEqual(['#fyp', '#viral', '#trending'])
    })

    it('extracts hashtags from mixed text', () => {
      expect(extractHashtags('Amazing video! #fyp Check this out #viral'))
        .toEqual(['#fyp', '#viral'])
    })

    it('removes duplicate hashtags', () => {
      expect(extractHashtags('#fyp #viral #fyp #trending #viral'))
        .toEqual(['#fyp', '#viral', '#trending'])
    })
  })

  describe('edge cases', () => {
    it('returns empty array for null input', () => {
      expect(extractHashtags(null)).toEqual([])
    })

    it('returns empty array for empty string', () => {
      expect(extractHashtags('')).toEqual([])
    })

    it('returns empty array when no hashtags present', () => {
      expect(extractHashtags('Just a normal sentence')).toEqual([])
    })

    it('handles hashtags with numbers', () => {
      expect(extractHashtags('#2024 #top10 #number1')).toEqual(['#2024', '#top10', '#number1'])
    })

    it('handles hashtags with underscores', () => {
      expect(extractHashtags('#my_hashtag #another_one')).toEqual(['#my_hashtag', '#another_one'])
    })

    it('handles international hashtags', () => {
      expect(extractHashtags('#日本 #한국 #中国')).toEqual(['#日本', '#한국', '#中国'])
    })

    it('handles emoji-adjacent hashtags', () => {
      expect(extractHashtags('🔥 #fyp 🎬 #viral')).toEqual(['#fyp', '#viral'])
    })

    it('does not match # alone or with space', () => {
      expect(extractHashtags('# alone # with space')).toEqual([])
    })

    it('handles hashtags at start and end', () => {
      expect(extractHashtags('#start middle #end')).toEqual(['#start', '#end'])
    })

    it('handles hashtags with newlines', () => {
      expect(extractHashtags('#first\n#second\n#third')).toEqual(['#first', '#second', '#third'])
    })
  })

  describe('TikTok-style captions', () => {
    it('extracts from typical TikTok caption', () => {
      const caption = 'POV: when the code finally works 💻 #coding #programmer #fyp #viral #tech'
      expect(extractHashtags(caption)).toEqual(['#coding', '#programmer', '#fyp', '#viral', '#tech'])
    })

    it('handles captions with many hashtags', () => {
      const caption = '#fyp #foryou #foryoupage #viral #trending #funny #comedy #relatable'
      expect(extractHashtags(caption)).toEqual([
        '#fyp', '#foryou', '#foryoupage', '#viral', '#trending', '#funny', '#comedy', '#relatable'
      ])
    })
  })

  describe('Instagram-style captions', () => {
    it('extracts from typical Instagram caption', () => {
      const caption = 'Beautiful sunset 🌅 #photography #nature #sunset #travel #explore'
      expect(extractHashtags(caption)).toEqual([
        '#photography', '#nature', '#sunset', '#travel', '#explore'
      ])
    })
  })
})
