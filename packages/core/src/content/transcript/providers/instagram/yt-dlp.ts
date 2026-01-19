import type { LinkPreviewProgressEvent } from '../../../link-preview/deps.js'
import { fetchTranscriptWithYtDlp } from '../youtube/yt-dlp.js'

export type InstagramYtDlpRequest = {
  ytDlpPath: string | null
  env?: Record<string, string | undefined>
  openaiApiKey: string | null
  falApiKey: string | null
  url: string
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
  cookiesFromBrowser?: string | null
}

export type InstagramYtDlpResult = {
  text: string | null
  provider: string | null
  error: Error | null
  notes: string[]
}

/**
 * Fetch Instagram Reel transcript using yt-dlp (audio download) + Whisper transcription.
 * This reuses the YouTube yt-dlp infrastructure.
 *
 * Note: Instagram may require authentication for private reels.
 * The `cookiesFromBrowser` option can be used to pass browser cookies
 * via yt-dlp's --cookies-from-browser flag.
 */
export async function fetchInstagramTranscriptWithYtDlp({
  ytDlpPath,
  env,
  openaiApiKey,
  falApiKey,
  url,
  onProgress,
  cookiesFromBrowser,
}: InstagramYtDlpRequest): Promise<InstagramYtDlpResult> {
  // Build extra args for Instagram-specific handling
  const extraArgs: string[] = []

  // Add cookies-from-browser if specified for private reels
  if (cookiesFromBrowser) {
    extraArgs.push('--cookies-from-browser', cookiesFromBrowser)
  }

  return fetchTranscriptWithYtDlp({
    ytDlpPath,
    env,
    openaiApiKey,
    falApiKey,
    url,
    onProgress,
    service: 'instagram' as 'youtube' | 'podcast' | 'generic',
    extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
  })
}
