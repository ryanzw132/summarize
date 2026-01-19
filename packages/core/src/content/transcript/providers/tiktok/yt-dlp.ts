import type { LinkPreviewProgressEvent } from '../../../link-preview/deps.js'
import { fetchTranscriptWithYtDlp } from '../youtube/yt-dlp.js'

export type TikTokYtDlpRequest = {
  ytDlpPath: string | null
  env?: Record<string, string | undefined>
  openaiApiKey: string | null
  falApiKey: string | null
  url: string
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}

export type TikTokYtDlpResult = {
  text: string | null
  provider: string | null
  error: Error | null
  notes: string[]
}

/**
 * Fetch TikTok transcript using yt-dlp (audio download) + Whisper transcription.
 * This reuses the YouTube yt-dlp infrastructure.
 */
export async function fetchTikTokTranscriptWithYtDlp({
  ytDlpPath,
  env,
  openaiApiKey,
  falApiKey,
  url,
  onProgress,
}: TikTokYtDlpRequest): Promise<TikTokYtDlpResult> {
  return fetchTranscriptWithYtDlp({
    ytDlpPath,
    env,
    openaiApiKey,
    falApiKey,
    url,
    onProgress,
    service: 'tiktok' as 'youtube' | 'podcast' | 'generic',
  })
}
