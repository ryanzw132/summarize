import { normalizeTranscriptText } from '../normalize.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderResult,
  TranscriptSource,
} from '../types.js'
import { resolveTranscriptionAvailability } from './transcription-start.js'
import {
  extractTikTokDurationSeconds,
  extractTikTokSubtitleInfos,
  fetchTikTokCaptions,
} from './tiktok/captions.js'
import { fetchTikTokTranscriptWithYtDlp } from './tiktok/yt-dlp.js'

const TIKTOK_URL_PATTERN = /(?:^|\.)tiktok\.com|^vm\.tiktok\.com/i

export const canHandle = ({ url }: ProviderContext): boolean => {
  try {
    const parsed = new URL(url)
    return TIKTOK_URL_PATTERN.test(parsed.hostname)
  } catch {
    return TIKTOK_URL_PATTERN.test(url)
  }
}

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: TranscriptSource[] = []
  const notes: string[] = []
  const { url } = context
  let html = context.html

  const progress = typeof options.onProgress === 'function' ? options.onProgress : null
  const pushHint = (hint: string) => {
    progress?.({ kind: 'transcript-start', url, service: 'tiktok', hint })
  }

  // Fetch HTML if not provided
  if (!html || !html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
    try {
      pushHint('TikTok: fetching page')
      const response = await options.fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      if (response.ok) {
        html = await response.text()
      }
    } catch {
      // Ignore and continue
    }
  }

  const durationSeconds = html ? extractTikTokDurationSeconds(html) : null
  const durationMetadata =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds }
      : null

  // Try native captions first
  if (html) {
    pushHint('TikTok: checking captions')
    const subtitleInfos = extractTikTokSubtitleInfos(html)

    if (subtitleInfos.length > 0) {
      attemptedProviders.push('tiktok-captions' as TranscriptSource)
      const captionResult = await fetchTikTokCaptions(options.fetch, subtitleInfos)

      if (captionResult?.text) {
        return {
          text: normalizeTranscriptText(captionResult.text),
          source: 'tiktok-captions' as TranscriptSource,
          segments: options.transcriptTimestamps ? captionResult.segments : null,
          metadata: { provider: 'tiktok-captions', ...(durationMetadata ?? {}) },
          attemptedProviders,
        }
      }
      notes.push('TikTok captions found but empty or failed to fetch')
    }
  }

  // Fallback to yt-dlp + Whisper
  const transcriptionAvailability = await resolveTranscriptionAvailability({
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
  })
  const canRunYtDlp = Boolean(options.ytDlpPath && transcriptionAvailability.hasAnyProvider)

  if (canRunYtDlp) {
    pushHint('TikTok: downloading audio for transcription')
    attemptedProviders.push('yt-dlp')

    const ytdlpResult = await fetchTikTokTranscriptWithYtDlp({
      ytDlpPath: options.ytDlpPath,
      env: options.env,
      openaiApiKey: options.openaiApiKey,
      falApiKey: options.falApiKey,
      url,
      onProgress: progress,
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
          ...(durationMetadata ?? {}),
        },
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
      }
    }

    if (ytdlpResult.error) {
      notes.push(`yt-dlp error: ${ytdlpResult.error.message}`)
    }
  } else if (!options.ytDlpPath) {
    notes.push('yt-dlp not available for fallback')
  } else {
    notes.push('No transcription provider available for yt-dlp fallback')
  }

  attemptedProviders.push('unavailable')
  return {
    text: null,
    source: 'unavailable',
    metadata: {
      provider: 'tiktok',
      reason: 'no_transcript_available',
      ...(durationMetadata ?? {}),
    },
    attemptedProviders,
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}
