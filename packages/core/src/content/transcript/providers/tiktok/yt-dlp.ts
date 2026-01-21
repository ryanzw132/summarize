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
 * Browser configurations to try for TikTok downloads.
 * Each config is tried in order until one succeeds.
 * Impersonation requires curl_cffi to be installed for yt-dlp.
 */
const BROWSER_FALLBACK_CONFIGS: { browser: string; impersonate: boolean }[] = [
  // Try with impersonation first (requires curl_cffi)
  { browser: 'chrome', impersonate: true },
  { browser: 'firefox', impersonate: true },
  { browser: 'safari', impersonate: true },
  // Fallback without impersonation (if curl_cffi not installed)
  { browser: 'chrome', impersonate: false },
  { browser: 'firefox', impersonate: false },
  { browser: 'safari', impersonate: false },
]

/**
 * Fetch TikTok transcript using yt-dlp (audio download) + Whisper transcription.
 * This reuses the YouTube yt-dlp infrastructure.
 *
 * TikTok aggressively blocks yt-dlp downloads. To work around this:
 * - Uses --cookies-from-browser to leverage the user's logged-in session
 * - Falls back through Chrome, Firefox, Safari with and without impersonation
 * - Finally tries with no browser cookies as last resort
 */
export async function fetchTikTokTranscriptWithYtDlp({
  ytDlpPath,
  env,
  openaiApiKey,
  falApiKey,
  url,
  onProgress,
}: TikTokYtDlpRequest): Promise<TikTokYtDlpResult> {
  const errors: string[] = []

  // Try each browser configuration in order
  for (const config of BROWSER_FALLBACK_CONFIGS) {
    const extraArgs: string[] = ['--cookies-from-browser', config.browser]
    if (config.impersonate) {
      extraArgs.push('--impersonate', config.browser)
    }

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath,
      env,
      openaiApiKey,
      falApiKey,
      url,
      onProgress,
      service: 'tiktok' as 'youtube' | 'podcast' | 'generic',
      extraArgs,
    })

    // Success - return the result
    if (result.text && !result.error) {
      return result
    }

    // Track errors for debugging but continue trying
    const errorMsg = result.error?.message || 'Unknown error'
    const configDesc = config.impersonate
      ? `${config.browser}+impersonate`
      : config.browser
    errors.push(`${configDesc}: ${errorMsg}`)

    // If error indicates missing browser/cookies, skip to next browser type
    // These errors mean the browser isn't available, not a TikTok block
    const isBrowserMissing = errorMsg.includes('could not find')
      || errorMsg.includes('no cookies')
      || errorMsg.includes('not found')
      || errorMsg.includes('not installed')

    // If error indicates missing curl_cffi, skip remaining impersonate attempts
    const isCurlCffiMissing = errorMsg.includes('curl_cffi')
      || errorMsg.includes('impersonate')

    if (isCurlCffiMissing && config.impersonate) {
      // Skip ahead to non-impersonate configs
      continue
    }

    if (isBrowserMissing) {
      // Skip to next browser entirely
      continue
    }
  }

  // Last resort: try without any browser cookies or impersonation
  const fallbackResult = await fetchTranscriptWithYtDlp({
    ytDlpPath,
    env,
    openaiApiKey,
    falApiKey,
    url,
    onProgress,
    service: 'tiktok' as 'youtube' | 'podcast' | 'generic',
    extraArgs: [],
  })

  if (fallbackResult.text && !fallbackResult.error) {
    return fallbackResult
  }

  errors.push(`no-auth: ${fallbackResult.error?.message || 'Unknown error'}`)

  // All attempts failed - return the last result with accumulated notes
  return {
    text: null,
    provider: null,
    error: new Error(`TikTok download failed after trying all browser configurations`),
    notes: [`Attempted configurations: ${errors.join('; ')}`],
  }
}
