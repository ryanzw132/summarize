import { loadSettings, patchSettings } from '../../lib/settings'

// Supported URL patterns
// YouTube: regular videos, shorts, live, embed, and youtu.be short URLs
const YOUTUBE_PATTERN = /^https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)/
const TIKTOK_PATTERN = /^https?:\/\/(?:(?:www|vm|m)\.)?tiktok\.com\//
// Instagram: reels, posts, and IGTV
const INSTAGRAM_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\//

type Platform = 'youtube' | 'tiktok' | 'instagram' | null

// Content script response types
interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

type TikTokTranscriptResponse =
  | {
      ok: true
      text: string
      segments: TranscriptSegment[]
      source: 'tiktok-captions'
      durationSeconds: number | null
    }
  | { ok: false; error: string; reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' }

type InstagramTranscriptResponse =
  | {
      ok: true
      videoUrl: string
      source: 'instagram-video'
      durationSeconds: number | null
      title: string | null
    }
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'unsupported_url' }

// Metadata response types
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

// Constants
const CONTENT_SCRIPT_TIMEOUT_MS = 10000  // 10 seconds
const DAEMON_REQUEST_TIMEOUT_MS = 30000  // 30 seconds for daemon request

// Error codes for debugging
type ErrorCode =
  | 'ERR_NO_URL'
  | 'ERR_UNSUPPORTED_PLATFORM'
  | 'ERR_NO_TAB'
  | 'ERR_NO_TOKEN'
  | 'ERR_CONTENT_SCRIPT_TIMEOUT'
  | 'ERR_CONTENT_SCRIPT_FAILED'
  | 'ERR_NO_CAPTIONS'
  | 'ERR_DAEMON_UNREACHABLE'
  | 'ERR_DAEMON_TIMEOUT'
  | 'ERR_DAEMON_ERROR'
  | 'ERR_NO_TRANSCRIPT'
  | 'ERR_PARSE_FAILED'
  | 'ERR_SAFETY_TIMEOUT'
  | 'ERR_UNKNOWN'

interface DiagnosticInfo {
  code: ErrorCode
  message: string
  url: string | null
  platform: Platform
  timestamp: string
  details?: string
}

let lastDiagnostic: DiagnosticInfo | null = null

function createDiagnostic(code: ErrorCode, message: string, details?: string): DiagnosticInfo {
  const diagnostic: DiagnosticInfo = {
    code,
    message,
    url: currentUrl,
    platform: detectPlatform(currentUrl || ''),
    timestamp: new Date().toISOString(),
    details,
  }
  lastDiagnostic = diagnostic
  console.error('[Transcript]', code, message, details || '')
  return diagnostic
}

function formatDiagnosticForCopy(d: DiagnosticInfo): string {
  return `ERROR REPORT
============
Code: ${d.code}
Time: ${d.timestamp}
Platform: ${d.platform || 'unknown'}
URL: ${d.url || 'none'}
Message: ${d.message}
${d.details ? `Details: ${d.details}` : ''}`
}

function detectPlatform(url: string): Platform {
  if (YOUTUBE_PATTERN.test(url)) return 'youtube'
  if (TIKTOK_PATTERN.test(url)) return 'tiktok'
  if (INSTAGRAM_PATTERN.test(url)) return 'instagram'
  return null
}

// DOM elements
const titleEl = document.getElementById('title') as HTMLHeadingElement
const statusEl = document.getElementById('status') as HTMLSpanElement
const progressEl = document.getElementById('progress') as HTMLDivElement
const progressFillEl = document.getElementById('progressFill') as HTMLDivElement
const setupEl = document.getElementById('setup') as HTMLDivElement
const openOptionsBtn = document.getElementById('openOptions') as HTMLButtonElement
const errorEl = document.getElementById('error') as HTMLDivElement
const errorMessageEl = document.getElementById('errorMessage') as HTMLParagraphElement
const retryBtn = document.getElementById('retryBtn') as HTMLButtonElement
const unsupportedEl = document.getElementById('unsupported') as HTMLDivElement
const transcriptContainerEl = document.getElementById('transcriptContainer') as HTMLDivElement
const sourceInfoEl = document.getElementById('sourceInfo') as HTMLSpanElement
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement
const transcriptEl = document.getElementById('transcript') as HTMLDivElement
const loadingEl = document.getElementById('loading') as HTMLDivElement
const loadingStatusEl = document.getElementById('loadingStatus') as HTMLParagraphElement
const fetchBtn = document.getElementById('fetchBtn') as HTMLButtonElement
const includeDetailsCheckbox = document.getElementById('includeDetailsCheckbox') as HTMLInputElement
const includeStatsCheckbox = document.getElementById('includeStatsCheckbox') as HTMLInputElement

// Auto-scroll elements
const autoScrollBtn = document.getElementById('autoScrollBtn') as HTMLButtonElement
const autoScrollContainerEl = document.getElementById('autoScrollContainer') as HTMLDivElement
const stopAutoScrollBtn = document.getElementById('stopAutoScroll') as HTMLButtonElement
const autoScrollStatusEl = document.getElementById('autoScrollStatus') as HTMLSpanElement
const autoScrollCountEl = document.getElementById('autoScrollCount') as HTMLSpanElement
const transcriptListEl = document.getElementById('transcriptList') as HTMLDivElement
const copyAllBtn = document.getElementById('copyAllBtn') as HTMLButtonElement
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement

let currentUrl: string | null = null
let currentTranscript: string | null = null
let currentPlatform: Platform = null
let abortController: AbortController | null = null
let currentFetchId = 0  // Used to detect stale fetches

// Auto-scroll state
let isAutoScrolling = false
let autoScrollAbortController: AbortController | null = null
const collectedTranscripts: Array<{
  platform: string
  transcript: string
  metadata: VideoMetadataResponse | null
}> = []

/**
 * Wrap a fetch request with a timeout.
 * Respects both the timeout and any caller-provided abort signal.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    console.log('[Transcript] Fetch timeout triggered after', timeoutMs, 'ms')
    timeoutController.abort()
  }, timeoutMs)

  // Combine caller's signal (if any) with our timeout signal
  const callerSignal = options.signal
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal

  try {
    console.log('[Transcript] Starting fetch to', url)
    const response = await fetch(url, {
      ...options,
      signal: combinedSignal,
    })
    clearTimeout(timeoutId)
    console.log('[Transcript] Fetch completed with status', response.status)
    return response
  } catch (err) {
    clearTimeout(timeoutId)
    console.log('[Transcript] Fetch error:', err)
    if (err instanceof Error) {
      // Check if aborted by caller vs timeout
      if (err.name === 'AbortError') {
        if (callerSignal?.aborted) {
          throw err // Re-throw caller's abort as-is
        }
        throw new Error('Request timed out after ' + (timeoutMs / 1000) + ' seconds')
      }
      // Network errors (daemon not running)
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('fetch')) {
        throw new Error('Cannot connect to daemon - is it running?')
      }
    }
    throw err
  }
}

/**
 * Send a message to a content script with a timeout.
 */
async function sendMessageWithTimeout<T>(
  tabId: number,
  message: { type: string },
  timeoutMs: number = CONTENT_SCRIPT_TIMEOUT_MS
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log(`[Transcript] Message timeout for ${message.type}`)
      resolve(null)
    }, timeoutMs)

    chrome.tabs.sendMessage(tabId, message)
      .then((response: T) => {
        clearTimeout(timer)
        resolve(response)
      })
      .catch((err) => {
        clearTimeout(timer)
        console.log(`[Transcript] Message error for ${message.type}:`, err)
        resolve(null)
      })
  })
}

function hideAll() {
  setupEl.classList.add('hidden')
  errorEl.classList.add('hidden')
  unsupportedEl.classList.add('hidden')
  transcriptContainerEl.classList.add('hidden')
  loadingEl.classList.add('hidden')
  progressEl.classList.add('hidden')
}

function showSetup() {
  hideAll()
  setupEl.classList.remove('hidden')
  fetchBtn.disabled = true
}

function showError(message: string, code?: ErrorCode, details?: string) {
  hideAll()
  const diagnostic = code ? createDiagnostic(code, message, details) : createDiagnostic('ERR_UNKNOWN', message, details)

  // Show user-friendly message
  errorMessageEl.textContent = message

  // Add copy button for error report
  const existingCopyBtn = errorEl.querySelector('.copy-error-btn')
  if (existingCopyBtn) {
    existingCopyBtn.remove()
  }

  const copyErrorBtn = document.createElement('button')
  copyErrorBtn.className = 'btn copy-error-btn'
  copyErrorBtn.textContent = 'Copy Error Report'
  copyErrorBtn.style.marginTop = '8px'
  copyErrorBtn.style.fontSize = '12px'
  copyErrorBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(formatDiagnosticForCopy(diagnostic))
      copyErrorBtn.textContent = 'Copied!'
      setTimeout(() => { copyErrorBtn.textContent = 'Copy Error Report' }, 2000)
    } catch {
      copyErrorBtn.textContent = 'Copy failed'
    }
  }

  // Insert after error message
  errorMessageEl.parentNode?.insertBefore(copyErrorBtn, errorMessageEl.nextSibling)

  errorEl.classList.remove('hidden')
  fetchBtn.disabled = false
}

function showUnsupported() {
  hideAll()
  unsupportedEl.classList.remove('hidden')
  fetchBtn.disabled = true
}

function showLoading(status: string) {
  hideAll()
  loadingStatusEl.textContent = status
  loadingEl.classList.remove('hidden')
  progressEl.classList.remove('hidden')
  progressFillEl.style.width = '30%'
  fetchBtn.disabled = true
}

function showTranscript(text: string, platform: Platform, source?: string) {
  hideAll()
  currentTranscript = text
  currentPlatform = platform
  transcriptEl.textContent = text

  const platformName = platform === 'youtube' ? 'YouTube'
    : platform === 'tiktok' ? 'TikTok'
    : platform === 'instagram' ? 'Instagram'
    : 'Unknown'

  const sourceLabel = source ? ` (${source})` : ''
  sourceInfoEl.textContent = `${platformName}${sourceLabel}`

  transcriptContainerEl.classList.remove('hidden')
  fetchBtn.disabled = false
  copyBtn.textContent = 'Copy'
  copyBtn.classList.remove('copied')
}

function setStatus(text: string) {
  statusEl.textContent = text
}

function setProgress(percent: number) {
  progressFillEl.style.width = `${percent}%`
}

async function copyTranscript() {
  if (!currentTranscript) return

  // Disable button and show loading state if fetching metadata
  const includeDetails = includeDetailsCheckbox.checked
  const includeStats = includeStatsCheckbox.checked
  const needsMetadata = (includeDetails || includeStats) && currentPlatform

  if (needsMetadata) {
    copyBtn.textContent = 'Loading...'
    copyBtn.disabled = true
  }

  try {
    let textToCopy = currentTranscript

    // If any checkbox is checked, try to fetch and prepend metadata
    if (needsMetadata) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        const metadata = await fetchVideoMetadata(tab.id, currentPlatform)
        if (metadata) {
          textToCopy = formatWithMetadata(currentTranscript, metadata, { includeDetails, includeStats })
        }
      }
    }

    await navigator.clipboard.writeText(textToCopy)
    copyBtn.textContent = 'Copied!'
    copyBtn.classList.add('copied')
    copyBtn.disabled = false
    setTimeout(() => {
      copyBtn.textContent = 'Copy'
      copyBtn.classList.remove('copied')
    }, 2000)
  } catch {
    copyBtn.textContent = 'Failed'
    copyBtn.disabled = false
    setTimeout(() => {
      copyBtn.textContent = 'Copy'
    }, 2000)
  }
}

/**
 * Inject a content script dynamically if needed.
 */
async function ensureContentScriptInjected(tabId: number, scriptFile: string): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    })
    // Small delay to let the script initialize
    await new Promise(resolve => setTimeout(resolve, 100))
    return true
  } catch (err) {
    console.log(`[Transcript] Failed to inject ${scriptFile}:`, err)
    return false
  }
}

/**
 * Try to send a message to content script, with fallback to dynamic injection.
 */
async function tryContentScriptMessage<T>(
  tabId: number,
  messageType: string,
  scriptFile: string
): Promise<T | null> {
  // First try with existing content script
  let response = await sendMessageWithTimeout<T>(tabId, { type: messageType })

  if (response === null) {
    // Content script might not be injected, try to inject it
    console.log(`[Transcript] Content script not responding for ${messageType}, injecting...`)
    if (await ensureContentScriptInjected(tabId, scriptFile)) {
      response = await sendMessageWithTimeout<T>(tabId, { type: messageType })
      if (response === null) {
        console.log(`[Transcript] Content script still not responding after injection`)
      }
    }
  }

  return response
}

/**
 * Try to extract transcript directly from page via content script.
 * Returns the transcript text if successful, or video URL for further processing.
 */
async function tryContentScriptExtraction(
  tabId: number,
  platform: Platform
): Promise<{ text: string; source: string } | { videoUrl: string; source: string } | null> {
  if (platform === 'tiktok') {
    console.log('[Transcript] Sending tiktok-transcript message to content script...')
    const response = await tryContentScriptMessage<TikTokTranscriptResponse>(
      tabId,
      'tiktok-transcript',
      'content-scripts/tiktok.js'
    )

    if (response === null) {
      console.log('[Transcript] TikTok content script did not respond (timeout or not injected)')
      createDiagnostic('ERR_CONTENT_SCRIPT_TIMEOUT', 'TikTok content script did not respond', `tabId: ${tabId}`)
    } else if (response.ok && response.text) {
      console.log('[Transcript] TikTok captions extracted successfully, length:', response.text.length)
      return { text: response.text, source: 'tiktok-captions' }
    } else if (!response.ok) {
      console.log('[Transcript] TikTok content script:', response.reason, '-', response.error)
      createDiagnostic('ERR_NO_CAPTIONS', `TikTok: ${response.reason}`, response.error)
    }
  }

  if (platform === 'instagram') {
    console.log('[Transcript] Sending instagram-transcript message to content script...')
    const response = await tryContentScriptMessage<InstagramTranscriptResponse>(
      tabId,
      'instagram-transcript',
      'content-scripts/instagram.js'
    )

    if (response === null) {
      console.log('[Transcript] Instagram content script did not respond (timeout or not injected)')
      createDiagnostic('ERR_CONTENT_SCRIPT_TIMEOUT', 'Instagram content script did not respond', `tabId: ${tabId}`)
    } else if (response.ok && response.videoUrl) {
      const videoUrl = response.videoUrl
      // Only accept proper HTTPS CDN URLs (not blob: or data:)
      if (videoUrl.startsWith('https://')) {
        console.log('[Transcript] Instagram video URL extracted:', videoUrl.slice(0, 100) + '...')
        return { videoUrl, source: 'instagram-video' }
      }
      console.log('[Transcript] Instagram video URL is not usable:', videoUrl.slice(0, 50))
      createDiagnostic('ERR_CONTENT_SCRIPT_FAILED', 'Instagram video URL not usable', `URL type: ${videoUrl.slice(0, 10)}...`)
    } else if (!response.ok) {
      console.log('[Transcript] Instagram content script:', response.reason, '-', response.error)
      createDiagnostic('ERR_NO_CAPTIONS', `Instagram: ${response.reason}`, response.error)
    }
  }

  return null
}

/**
 * Fetch video metadata from content script.
 */
async function fetchVideoMetadata(
  tabId: number,
  platform: Platform
): Promise<VideoMetadataResponse | null> {
  if (platform === 'tiktok') {
    const response = await tryContentScriptMessage<VideoMetadataResponse>(
      tabId,
      'tiktok-metadata',
      'content-scripts/tiktok.js'
    )
    return response
  }

  if (platform === 'instagram') {
    const response = await tryContentScriptMessage<VideoMetadataResponse>(
      tabId,
      'instagram-metadata',
      'content-scripts/instagram.js'
    )
    return response
  }

  if (platform === 'youtube') {
    const response = await tryContentScriptMessage<VideoMetadataResponse>(
      tabId,
      'youtube-metadata',
      'content-scripts/youtube.js'
    )
    return response
  }

  return null
}

/**
 * Format a number for display (e.g., 1234567 -> "1.2M")
 */
function formatNumber(num: number | null): string | null {
  if (num === null) return null
  if (num >= 1000000000) return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return num.toString()
}

/**
 * Format metadata and transcript for copying.
 */
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

async function fetchTranscript() {
  if (!currentUrl) {
    showError('No URL detected. Please refresh the page.', 'ERR_NO_URL')
    return
  }

  const platform = detectPlatform(currentUrl)
  if (!platform) {
    showUnsupported()
    return
  }

  // Increment fetchId to detect stale fetches
  const thisFetchId = ++currentFetchId

  // Helper to check if this fetch is still current
  const isStale = () => thisFetchId !== currentFetchId

  abortController?.abort()
  abortController = new AbortController()

  // Safety timeout - if nothing happens for 45 seconds, show error
  const safetyTimeoutId = setTimeout(() => {
    if (!isStale()) {
      showError(
        'Request timed out. Please check if the daemon is running.',
        'ERR_SAFETY_TIMEOUT',
        'No response received within 45 seconds'
      )
    }
  }, 45000)

  try {
    const settings = await loadSettings()
    const token = settings.token?.trim()

    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const title = tab?.title || null
    const tabId = tab?.id

    // For TikTok and Instagram, try content script extraction first
    let extractedVideoUrl: string | null = null
    if ((platform === 'tiktok' || platform === 'instagram') && tabId) {
      const platformLabel = platform === 'tiktok' ? 'TikTok' : 'Instagram'
      showLoading(`Checking ${platformLabel} for captions...`)
      setStatus('Extracting from page...')
      setProgress(20)

      const contentResult = await tryContentScriptExtraction(tabId, platform)

      // Check for stale fetch after async operation
      if (isStale()) {
        clearTimeout(safetyTimeoutId)
        return
      }

      if (contentResult && 'text' in contentResult) {
        // Got transcript text directly (TikTok captions)
        clearTimeout(safetyTimeoutId)
        setProgress(100)
        setStatus('Done')
        showTranscript(contentResult.text, platform, contentResult.source)
        return
      }
      if (contentResult && 'videoUrl' in contentResult) {
        // Got video URL (Instagram) - will send to daemon for transcription
        extractedVideoUrl = contentResult.videoUrl
        setStatus('Video found, transcribing...')
        setProgress(30)
      } else {
        // Content script didn't get transcript, fall back to daemon
        setStatus('No captions found, trying server...')
        setProgress(30)
      }
    }

    // Check token before making daemon request
    if (!token) {
      clearTimeout(safetyTimeoutId)
      showSetup()
      return
    }

    // For YouTube, show loading immediately since we always use daemon
    if (platform === 'youtube') {
      showLoading('Fetching YouTube transcript...')
    } else {
      showLoading(`Fetching ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} transcript...`)
    }
    setStatus('Connecting to daemon...')
    console.log('[Transcript] Making daemon request...')

    // Use extracted video URL if available (for Instagram CDN URLs)
    // This allows the daemon to transcribe the video directly without needing auth
    const urlToFetch = extractedVideoUrl || currentUrl

    // Make request to daemon with timeout
    const response = await fetchWithTimeout(
      'http://127.0.0.1:8787/v1/summarize',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: urlToFetch,
          title,
          mode: 'url',
          extractOnly: true,
          timestamps: true,
          maxCharacters: null,
          // When we have a direct video URL (from Instagram content script),
          // enable transcript mode to force media transcription via yt-dlp/whisper
          ...(extractedVideoUrl ? { videoMode: 'transcript' } : {}),
        }),
        signal: abortController.signal,
      },
      DAEMON_REQUEST_TIMEOUT_MS
    )

    // Check for stale fetch after daemon request
    console.log('[Transcript] Checking if stale after daemon request...')
    if (isStale()) {
      console.log('[Transcript] Request is stale, aborting')
      clearTimeout(safetyTimeoutId)
      return
    }

    setProgress(60)
    setStatus('Processing...')
    console.log('[Transcript] Processing daemon response...')

    if (!response.ok) {
      console.log('[Transcript] Response not OK, status:', response.status)
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    // Parse JSON with timeout protection
    console.log('[Transcript] Parsing JSON response...')
    let data: {
      ok?: boolean
      error?: string
      extracted?: {
        content?: string
        transcriptTimedText?: string
      }
    }

    try {
      const jsonPromise = response.json()
      let jsonTimeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        jsonTimeoutId = setTimeout(() => reject(new Error('JSON parsing timed out')), 15000)
      })
      data = await Promise.race([jsonPromise, timeoutPromise]) as typeof data
      clearTimeout(jsonTimeoutId)
      console.log('[Transcript] JSON parsed successfully, ok:', data.ok)
    } catch (parseErr) {
      console.error('[Transcript] JSON parse error:', parseErr)
      throw new Error('Failed to parse daemon response: ' + (parseErr instanceof Error ? parseErr.message : 'unknown'))
    }

    // Check for stale fetch after parsing response
    if (isStale()) {
      console.log('[Transcript] Request is stale after parsing, aborting')
      clearTimeout(safetyTimeoutId)
      return
    }

    if (!data.ok) {
      console.log('[Transcript] Daemon returned error:', data.error)
      throw new Error(data.error || 'Failed to fetch transcript')
    }

    setProgress(90)

    // Extract transcript text
    let transcriptText = data.extracted?.content || data.extracted?.transcriptTimedText || null
    console.log('[Transcript] Extracted text length:', transcriptText?.length || 0)

    // If we got timed text, clean it up (remove timestamps in various formats)
    // Formats: [MM:SS], [HH:MM:SS], [H:MM:SS], [M:SS], etc.
    if (transcriptText && transcriptText.includes('[')) {
      transcriptText = transcriptText
        .replace(/\[\d{1,3}:\d{2}(?::\d{2})?\]\s*/g, '')  // [M:SS], [MM:SS], [H:MM:SS], [HH:MM:SS]
        .replace(/\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')  // Collapse multiple spaces
        .trim()
    }

    setProgress(100)

    if (!transcriptText || transcriptText.trim().length === 0) {
      throw new Error('No transcript available for this video')
    }

    // Validate transcript is actually content, not an error/status message
    const trimmedText = transcriptText.trim()
    const MIN_TRANSCRIPT_LENGTH = 30  // Lowered since short videos exist

    // Check for suspiciously short "transcripts" that are likely error messages
    if (trimmedText.length < MIN_TRANSCRIPT_LENGTH) {
      // Check for common error/status patterns with word boundaries
      // Only reject if text looks like it's ONLY an error message
      const errorPatterns = [
        /^please wait/i,
        /^loading/i,
        /^error/i,
        /^failed/i,
        /^unavailable/i,
        /^not found/i,
        /^no transcript/i,
        /^try again/i,
        /please.*wait/i,
        /loading.*please/i,
      ]
      const looksLikeError = errorPatterns.some(pattern => pattern.test(trimmedText))

      if (looksLikeError) {
        console.error('[Transcript] Daemon returned error/loading text instead of transcript:', trimmedText)
        throw new Error(
          'Could not transcribe this video. It may have no captions, or the platform ' +
          'blocked the download. Try a different video or check daemon logs for details.'
        )
      }
      // Even if it doesn't match patterns, warn about short text
      console.warn('[Transcript] Warning: transcript is short:', trimmedText.length, 'chars')
    }

    clearTimeout(safetyTimeoutId)
    setStatus('Done')
    showTranscript(transcriptText.trim(), platform, 'extracted')

  } catch (err) {
    clearTimeout(safetyTimeoutId)

    // Ignore errors from aborted or stale fetches
    if ((err as Error).name === 'AbortError') return
    if (isStale()) return

    const message = err instanceof Error ? err.message : 'Unknown error'
    const stack = err instanceof Error ? err.stack : undefined
    setStatus('Error')

    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      showError(
        'Cannot connect to daemon. Make sure it\'s running:\nsummarize daemon start',
        'ERR_DAEMON_UNREACHABLE',
        `Original error: ${message}`
      )
    } else if (message.includes('timed out') || message.includes('timeout')) {
      showError(
        'Request timed out. The daemon may be busy or not running.',
        'ERR_DAEMON_TIMEOUT',
        `Timeout after ${DAEMON_REQUEST_TIMEOUT_MS}ms`
      )
    } else if (message.includes('No transcript available')) {
      showError(
        'No transcript available. This video may not have captions.',
        'ERR_NO_TRANSCRIPT'
      )
    } else if (message.includes('HTTP 4') || message.includes('HTTP 5')) {
      showError(
        `Daemon error: ${message}`,
        'ERR_DAEMON_ERROR',
        stack
      )
    } else {
      showError(message, 'ERR_UNKNOWN', stack)
    }
  }
}

async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url || ''

    currentUrl = url
    const platform = detectPlatform(url)

    if (!platform) {
      titleEl.textContent = 'Transcript'
      showUnsupported()
      return
    }

    const platformName = platform === 'youtube' ? 'YouTube'
      : platform === 'tiktok' ? 'TikTok'
      : 'Instagram'

    titleEl.textContent = `${platformName} Transcript`

    // Check if we have a token
    const settings = await loadSettings()
    if (!settings.token?.trim()) {
      showSetup()
      return
    }

    // Ready to fetch
    hideAll()
    fetchBtn.disabled = false
    setStatus('Ready')

  } catch {
    showError('Failed to get current tab')
  }
}

// Event listeners
fetchBtn.addEventListener('click', fetchTranscript)
retryBtn.addEventListener('click', fetchTranscript)
copyBtn.addEventListener('click', copyTranscript)
openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

// Persist checkbox settings
includeDetailsCheckbox.addEventListener('change', () => {
  patchSettings({ includeVideoDetails: includeDetailsCheckbox.checked })
})
includeStatsCheckbox.addEventListener('change', () => {
  patchSettings({ includeVideoStats: includeStatsCheckbox.checked })
})

// Auto-scroll event listeners
autoScrollBtn?.addEventListener('click', startAutoScroll)
stopAutoScrollBtn?.addEventListener('click', stopAutoScroll)
copyAllBtn?.addEventListener('click', copyAllTranscripts)
downloadBtn?.addEventListener('click', downloadTranscripts)

// Listen for tab changes
chrome.tabs.onActivated.addListener(() => {
  checkCurrentTab()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    checkCurrentTab()
  }
})

// Initialize checkbox state from settings
async function initCheckboxState() {
  const settings = await loadSettings()
  includeDetailsCheckbox.checked = settings.includeVideoDetails
  includeStatsCheckbox.checked = settings.includeVideoStats
}

/**
 * Scroll to the next video in feed via content script.
 */
async function scrollToNextVideo(tabId: number, platform: Platform): Promise<boolean> {
  if (!platform) return false

  try {
    // Send message to content script to scroll to next video
    const response = await chrome.tabs.sendMessage(tabId, {
      type: `${platform}-scroll-next`,
    }) as { ok: boolean } | undefined

    return response?.ok ?? false
  } catch {
    return false
  }
}

/**
 * Start auto-scroll mode to collect transcripts.
 */
async function startAutoScroll() {
  if (isAutoScrolling) return

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url || ''
  const platform = detectPlatform(url)

  if (!platform || !tab?.id) {
    showError('Auto-scroll is only supported on YouTube Shorts, TikTok, and Instagram Reels')
    return
  }

  isAutoScrolling = true
  autoScrollAbortController = new AbortController()
  collectedTranscripts.length = 0

  // Update UI
  hideAll()
  autoScrollContainerEl?.classList.remove('hidden')
  autoScrollBtn.disabled = true
  fetchBtn.disabled = true
  updateAutoScrollUI()

  const tabId = tab.id

  // Auto-scroll loop
  while (isAutoScrolling) {
    try {
      autoScrollStatusEl.textContent = 'Extracting transcript...'

      // Get transcript for current video
      const transcriptResult = await getTranscriptForCurrentVideo(tabId, platform)

      if (transcriptResult && isAutoScrolling) {
        // Get metadata
        const metadata = await fetchVideoMetadata(tabId, platform)

        collectedTranscripts.push({
          platform: platform,
          transcript: transcriptResult.text,
          metadata,
        })

        updateAutoScrollUI()
        addTranscriptToList(transcriptResult.text, metadata)
      }

      if (!isAutoScrolling) break

      // Scroll to next video
      autoScrollStatusEl.textContent = 'Scrolling to next video...'
      const scrolled = await scrollToNextVideo(tabId, platform)

      if (!scrolled) {
        autoScrollStatusEl.textContent = 'Reached end of feed or scroll failed'
        await new Promise(resolve => setTimeout(resolve, 2000))
        stopAutoScroll()
        break
      }

      // Wait for video to load
      await new Promise(resolve => setTimeout(resolve, 2500))

    } catch (err) {
      console.error('[AutoScroll] Error:', err)
      autoScrollStatusEl.textContent = 'Error: ' + (err instanceof Error ? err.message : 'Unknown')
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}

/**
 * Stop auto-scroll mode.
 */
function stopAutoScroll() {
  isAutoScrolling = false
  autoScrollAbortController?.abort()
  autoScrollAbortController = null

  autoScrollStatusEl.textContent = `Stopped. Collected ${collectedTranscripts.length} transcripts.`
  autoScrollBtn.disabled = false
  fetchBtn.disabled = false
}

/**
 * Update auto-scroll UI with current count.
 */
function updateAutoScrollUI() {
  const count = collectedTranscripts.length
  autoScrollCountEl.textContent = `${count} video${count !== 1 ? 's' : ''}`
}

/**
 * Add a transcript item to the list UI.
 */
function addTranscriptToList(text: string, metadata: VideoMetadataResponse | null) {
  const item = document.createElement('div')
  item.className = 'transcript-item'

  const header = document.createElement('div')
  header.className = 'transcript-item-header'

  const platformLabel = document.createElement('span')
  platformLabel.className = 'transcript-item-platform'
  platformLabel.textContent = metadata?.platform || 'Unknown'
  header.appendChild(platformLabel)

  if (metadata?.stats) {
    const statsLabel = document.createElement('span')
    statsLabel.className = 'transcript-item-stats'
    const statParts: string[] = []
    if (metadata.stats.views !== null) statParts.push(`${formatNumber(metadata.stats.views)} views`)
    if (metadata.stats.likes !== null) statParts.push(`${formatNumber(metadata.stats.likes)} likes`)
    if (metadata.stats.comments !== null) statParts.push(`${formatNumber(metadata.stats.comments)} comments`)
    if (metadata.stats.shares !== null) statParts.push(`${formatNumber(metadata.stats.shares)} shares`)
    statsLabel.textContent = statParts.join(' · ')
    header.appendChild(statsLabel)
  }

  item.appendChild(header)

  const content = document.createElement('div')
  content.className = 'transcript-item-content'
  content.textContent = text.slice(0, 500) + (text.length > 500 ? '...' : '')
  item.appendChild(content)

  transcriptListEl?.appendChild(item)
  transcriptListEl?.scrollTo(0, transcriptListEl.scrollHeight)
}

/**
 * Get transcript for the current video without full fetch flow.
 */
async function getTranscriptForCurrentVideo(
  tabId: number,
  platform: Platform
): Promise<{ text: string; source: string } | null> {
  // Try content script extraction first
  const contentResult = await tryContentScriptExtraction(tabId, platform)

  if (contentResult && 'text' in contentResult) {
    return { text: contentResult.text, source: contentResult.source }
  }

  // For videos without native captions, we'd need to call the daemon
  // For now, return null to skip videos without captions in auto-scroll mode
  return null
}

/**
 * Copy all collected transcripts to clipboard.
 */
async function copyAllTranscripts() {
  if (collectedTranscripts.length === 0) return

  const includeDetails = includeDetailsCheckbox.checked
  const includeStats = includeStatsCheckbox.checked

  const allText = collectedTranscripts.map((item, index) => {
    let text = `--- Video ${index + 1} ---\n\n`
    if (item.metadata) {
      text += formatWithMetadata(item.transcript, item.metadata, { includeDetails, includeStats })
    } else {
      text += item.transcript
    }
    return text
  }).join('\n\n')

  try {
    await navigator.clipboard.writeText(allText)
    copyAllBtn.textContent = 'Copied!'
    copyAllBtn.classList.add('copied')
    setTimeout(() => {
      copyAllBtn.textContent = 'Copy All'
      copyAllBtn.classList.remove('copied')
    }, 2000)
  } catch {
    copyAllBtn.textContent = 'Failed'
    setTimeout(() => {
      copyAllBtn.textContent = 'Copy All'
    }, 2000)
  }
}

/**
 * Download all collected transcripts as a .txt file.
 */
function downloadTranscripts() {
  if (collectedTranscripts.length === 0) return

  const includeDetails = includeDetailsCheckbox.checked
  const includeStats = includeStatsCheckbox.checked

  const allText = collectedTranscripts.map((item, index) => {
    let text = `--- Video ${index + 1} ---\n\n`
    if (item.metadata) {
      text += formatWithMetadata(item.transcript, item.metadata, { includeDetails, includeStats })
    } else {
      text += item.transcript
    }
    return text
  }).join('\n\n')

  const blob = new Blob([allText], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transcripts-${new Date().toISOString().split('T')[0]}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Initial setup
initCheckboxState()
checkCurrentTab()
