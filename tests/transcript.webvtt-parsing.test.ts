import { describe, expect, it } from 'vitest'

// Copy of parseWebVtt function from tiktok.content.ts for testing
interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

function parseWebVtt(vtt: string): { text: string; segments: TranscriptSegment[] } | null {
  const lines = vtt.split(/\r?\n/)
  const segments: TranscriptSegment[] = []
  const textParts: string[] = []

  let i = 0
  // Skip WebVTT header
  while (i < lines.length && !lines[i]?.includes('-->')) {
    i++
  }

  while (i < lines.length) {
    const line = lines[i]?.trim() ?? ''

    // Check for timestamp line (HH:MM:SS.mmm format)
    const timestampMatch = line.match(
      /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
    )
    if (!timestampMatch) {
      // Also try MM:SS.mmm format
      const shortMatch = line.match(
        /^(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2})[.,](\d{3})/
      )
      if (shortMatch) {
        const startMs =
          Number(shortMatch[1]) * 60 * 1000 +
          Number(shortMatch[2]) * 1000 +
          Number(shortMatch[3])
        const endMs =
          Number(shortMatch[4]) * 60 * 1000 +
          Number(shortMatch[5]) * 1000 +
          Number(shortMatch[6])

        i++
        const cueLines: string[] = []
        while (i < lines.length && lines[i]?.trim() !== '') {
          cueLines.push(lines[i]?.trim() ?? '')
          i++
        }

        const cueText = cueLines.join(' ').replace(/<[^>]+>/g, '').trim()
        if (cueText) {
          segments.push({ startMs, endMs, text: cueText })
          textParts.push(cueText)
        }
        continue
      }
      i++
      continue
    }

    const startMs =
      Number(timestampMatch[1]) * 3600 * 1000 +
      Number(timestampMatch[2]) * 60 * 1000 +
      Number(timestampMatch[3]) * 1000 +
      Number(timestampMatch[4])
    const endMs =
      Number(timestampMatch[5]) * 3600 * 1000 +
      Number(timestampMatch[6]) * 60 * 1000 +
      Number(timestampMatch[7]) * 1000 +
      Number(timestampMatch[8])

    i++
    const cueLines: string[] = []
    while (i < lines.length && lines[i]?.trim() !== '') {
      cueLines.push(lines[i]?.trim() ?? '')
      i++
    }

    const cueText = cueLines.join(' ').replace(/<[^>]+>/g, '').trim()
    if (cueText) {
      segments.push({ startMs, endMs, text: cueText })
      textParts.push(cueText)
    }
  }

  if (segments.length === 0) {
    return null
  }

  return {
    text: textParts.join(' '),
    segments,
  }
}

describe('WebVTT Parsing', () => {
  describe('basic parsing', () => {
    it('parses standard HH:MM:SS.mmm format', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.500
Hello world

00:00:02.500 --> 00:00:05.000
This is a test
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(2)
      expect(result!.segments[0]).toEqual({
        startMs: 0,
        endMs: 2500,
        text: 'Hello world',
      })
      expect(result!.segments[1]).toEqual({
        startMs: 2500,
        endMs: 5000,
        text: 'This is a test',
      })
      expect(result!.text).toBe('Hello world This is a test')
    })

    it('parses MM:SS.mmm format', () => {
      const vtt = `WEBVTT

00:00.000 --> 00:02.500
Hello world

00:02.500 --> 00:05.000
This is a test
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(2)
      expect(result!.segments[0]).toEqual({
        startMs: 0,
        endMs: 2500,
        text: 'Hello world',
      })
    })

    it('handles commas instead of periods as decimal separator', () => {
      const vtt = `WEBVTT

00:00:00,000 --> 00:00:02,500
Hello world
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0]).toEqual({
        startMs: 0,
        endMs: 2500,
        text: 'Hello world',
      })
    })
  })

  describe('multiline cues', () => {
    it('joins multiline cue text with spaces', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
This is line one
This is line two
This is line three
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0].text).toBe('This is line one This is line two This is line three')
    })
  })

  describe('HTML tag stripping', () => {
    it('removes simple HTML tags', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
<b>Bold text</b> and <i>italic</i>
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0].text).toBe('Bold text and italic')
    })

    it('removes tags with attributes', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
<c.yellow>Colored text</c> normal
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0].text).toBe('Colored text normal')
    })

    it('removes voice/speaker tags', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Speaker1>Hello there
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0].text).toBe('Hello there')
    })
  })

  describe('edge cases', () => {
    it('returns null for empty VTT', () => {
      const vtt = `WEBVTT

`
      const result = parseWebVtt(vtt)
      expect(result).toBeNull()
    })

    it('returns null for VTT with only headers', () => {
      const vtt = `WEBVTT
Kind: captions
Language: en

`
      const result = parseWebVtt(vtt)
      expect(result).toBeNull()
    })

    it('skips empty cue text', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000


00:00:02.000 --> 00:00:04.000
Actual text
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(1)
      expect(result!.segments[0].text).toBe('Actual text')
    })

    it('handles cue identifiers', () => {
      const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
First cue

2
00:00:02.000 --> 00:00:04.000
Second cue
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(2)
    })

    it('handles Windows line endings', () => {
      const vtt = "WEBVTT\r\n\r\n00:00:00.000 --> 00:00:02.000\r\nHello world\r\n"
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0].text).toBe('Hello world')
    })

    it('handles timestamps over an hour', () => {
      const vtt = `WEBVTT

01:30:00.000 --> 01:30:05.500
After 90 minutes
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments[0]).toEqual({
        startMs: 90 * 60 * 1000, // 90 minutes
        endMs: 90 * 60 * 1000 + 5500, // 90 minutes + 5.5 seconds
        text: 'After 90 minutes',
      })
    })

    it('handles cues with only HTML tags (results in empty text)', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<b></b>

00:00:02.000 --> 00:00:04.000
Actual content
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(1)
      expect(result!.segments[0].text).toBe('Actual content')
    })
  })

  describe('TikTok-specific formats', () => {
    it('parses typical TikTok caption format', () => {
      // TikTok often uses shorter timestamps
      const vtt = `WEBVTT

00:00.100 --> 00:02.500
Hey guys welcome back

00:02.600 --> 00:04.800
to another video

00:05.000 --> 00:07.200
Today we're going to learn
`
      const result = parseWebVtt(vtt)
      expect(result).not.toBeNull()
      expect(result!.segments).toHaveLength(3)
      expect(result!.text).toBe('Hey guys welcome back to another video Today we\'re going to learn')
    })
  })
})
