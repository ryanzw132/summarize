import { normalizeTranscriptText } from '../normalize.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderResult,
  TranscriptSource,
} from '../types.js'
import { resolveTranscriptionAvailability } from './transcription-start.js'
import { fetchInstagramTranscriptWithYtDlp } from './instagram/yt-dlp.js'

const INSTAGRAM_URL_PATTERN = /(?:^|\.)instagram\.com/i
const INSTAGRAM_REEL_PATH_PATTERN = /\/reel(?:s)?\/[A-Za-z0-9_-]+/i

export const canHandle = ({ url }: ProviderContext): boolean => {
  try {
    const parsed = new URL(url)
    if (!INSTAGRAM_URL_PATTERN.test(parsed.hostname)) {
      return false
    }
    // Only handle reels
    return INSTAGRAM_REEL_PATH_PATTERN.test(parsed.pathname)
  } catch {
    return false
  }
}

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: TranscriptSource[] = []
  const notes: string[] = []
  const { url } = context

  const progress = typeof options.onProgress === 'function' ? options.onProgress : null
  const pushHint = (hint: string) => {
    progress?.({ kind: 'transcript-start', url, service: 'instagram', hint })
  }

  // Instagram Reels don't have native captions, always use yt-dlp + Whisper
  const transcriptionAvailability = await resolveTranscriptionAvailability({
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
  })
  const canRunYtDlp = Boolean(options.ytDlpPath && transcriptionAvailability.hasAnyProvider)

  if (!canRunYtDlp) {
    if (!options.ytDlpPath) {
      notes.push('yt-dlp not available (required for Instagram Reels)')
    } else {
      notes.push('No transcription provider available (required for Instagram Reels)')
    }

    attemptedProviders.push('unavailable')
    return {
      text: null,
      source: 'unavailable',
      metadata: {
        provider: 'instagram',
        reason: 'no_transcript_available',
      },
      attemptedProviders,
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  pushHint('Instagram: downloading audio for transcription')
  attemptedProviders.push('yt-dlp')

  // Determine if we should try with browser cookies for potentially private reels
  const cookiesFromBrowser = options.env?.INSTAGRAM_COOKIES_FROM_BROWSER ?? null

  const ytdlpResult = await fetchInstagramTranscriptWithYtDlp({
    ytDlpPath: options.ytDlpPath,
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
    url,
    onProgress: progress,
    cookiesFromBrowser,
  })

  if (ytdlpResult.notes.length > 0) {
    notes.push(...ytdlpResult.notes)
  }

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: 'yt-dlp',
      metadata: {
        provider: 'yt-dlp',
        transcriptionProvider: ytdlpResult.provider,
        platform: 'instagram',
      },
      attemptedProviders,
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  if (ytdlpResult.error) {
    notes.push(`yt-dlp error: ${ytdlpResult.error.message}`)
  }

  attemptedProviders.push('unavailable')
  return {
    text: null,
    source: 'unavailable',
    metadata: {
      provider: 'instagram',
      reason: 'no_transcript_available',
    },
    attemptedProviders,
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}
