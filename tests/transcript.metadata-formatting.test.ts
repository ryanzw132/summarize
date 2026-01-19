import { describe, expect, it } from 'vitest'

// Copy of VideoMetadataResponse type and formatWithMetadata from transcript-main.ts
type VideoMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
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
  if (metadata.description && metadata.description !== metadata.title) {
    parts.push(`Description: ${metadata.description}`)
  }

  if (parts.length > 0) {
    return parts.join('\n') + '\n\n---\n\n' + transcript
  }

  return transcript
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
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toContain('Title: My Amazing Video')
      expect(result).toContain('Creator: @username')
      expect(result).toContain('Posted: January 15, 2024')
      expect(result).toContain('Description: A detailed description of the video')
      expect(result).toContain('---')
      expect(result).toContain(sampleTranscript)
    })

    it('maintains correct order: Title, Creator, Posted, Description', () => {
      const metadata: VideoMetadataResponse = {
        title: 'Title',
        description: 'Desc',
        creator: '@user',
        postedAt: 'Date',
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      const titleIndex = result.indexOf('Title:')
      const creatorIndex = result.indexOf('Creator:')
      const postedIndex = result.indexOf('Posted:')
      const descIndex = result.indexOf('Description:')

      expect(titleIndex).toBeLessThan(creatorIndex)
      expect(creatorIndex).toBeLessThan(postedIndex)
      expect(postedIndex).toBeLessThan(descIndex)
    })
  })

  describe('with partial metadata', () => {
    it('handles missing title', () => {
      const metadata: VideoMetadataResponse = {
        title: null,
        description: 'A description',
        creator: '@username',
        postedAt: 'January 15, 2024',
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
      }

      const result = formatWithMetadata(sampleTranscript, metadata)

      expect(result).toBe('Title: Just a Title\n\n---\n\n' + sampleTranscript)
    })
  })

  describe('with no metadata', () => {
    it('returns transcript unchanged when all fields are null', () => {
      const metadata: VideoMetadataResponse = {
        title: null,
        description: null,
        creator: null,
        postedAt: null,
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
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      expect(result).toContain('Title: Video 🎬 with emojis')
      expect(result).toContain('Creator: @用户名')
    })

    it('handles very long text', () => {
      const longText = 'A'.repeat(10000)
      const metadata: VideoMetadataResponse = {
        title: longText,
        description: null,
        creator: null,
        postedAt: null,
      }

      const result = formatWithMetadata(sampleTranscript, metadata)
      expect(result).toContain(`Title: ${longText}`)
      expect(result).toContain(sampleTranscript)
    })
  })
})
