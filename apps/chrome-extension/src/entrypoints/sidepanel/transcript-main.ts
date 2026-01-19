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
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'blob_too_large' }

// Metadata response types
type VideoMetadataResponse = {
  title: string | null
  description: string | null
  creator: string | null
  postedAt: string | null
}

// Constants
const CONTENT_SCRIPT_TIMEOUT_MS = 10000  // 10 seconds
const MAX_BLOB_SIZE_BYTES = 50 * 1024 * 1024  // 50MB max for data URL encoding

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

let currentUrl: string | null = null
let currentTranscript: string | null = null
let currentPlatform: Platform = null
let abortController: AbortController | null = null
let currentFetchId = 0  // Used to detect stale fetches

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

function showError(message: string) {
  hideAll()
  errorMessageEl.textContent = message
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
  const needsMetadata = includeDetailsCheckbox.checked && currentPlatform
  if (needsMetadata) {
    copyBtn.textContent = 'Loading...'
    copyBtn.disabled = true
  }

  try {
    let textToCopy = currentTranscript

    // If "include video details" is checked, try to fetch and prepend metadata
    if (needsMetadata) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        const metadata = await fetchVideoMetadata(tab.id, currentPlatform)
        if (metadata) {
          textToCopy = formatWithMetadata(currentTranscript, metadata)
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
    const response = await tryContentScriptMessage<TikTokTranscriptResponse>(
      tabId,
      'tiktok-transcript',
      'content-scripts/tiktok.js'
    )

    if (response?.ok && response.text) {
      return { text: response.text, source: 'tiktok-captions' }
    }
    if (response && !response.ok) {
      console.log('[Transcript] TikTok content script:', response.reason, '-', response.error)
    }
  }

  if (platform === 'instagram') {
    const response = await tryContentScriptMessage<InstagramTranscriptResponse>(
      tabId,
      'instagram-transcript',
      'content-scripts/instagram.js'
    )

    if (response?.ok && response.videoUrl) {
      const videoUrl = response.videoUrl
      // Only accept proper HTTPS CDN URLs (not blob: or data:)
      if (videoUrl.startsWith('https://')) {
        console.log('[Transcript] Instagram video URL extracted:', videoUrl.slice(0, 100) + '...')
        return { videoUrl, source: 'instagram-video' }
      }
      console.log('[Transcript] Instagram video URL is not usable:', videoUrl.slice(0, 50))
    }
    if (response && !response.ok) {
      console.log('[Transcript] Instagram content script:', response.reason, '-', response.error)
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

  // YouTube metadata not implemented yet via content script
  return null
}

/**
 * Format metadata and transcript for copying.
 */
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

async function fetchTranscript() {
  if (!currentUrl) return

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
      if (isStale()) return

      if (contentResult && 'text' in contentResult) {
        // Got transcript text directly (TikTok captions)
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

    // Use extracted video URL if available (for Instagram CDN URLs)
    // This allows the daemon to transcribe the video directly without needing auth
    const urlToFetch = extractedVideoUrl || currentUrl

    // Make request to daemon
    const response = await fetch('http://127.0.0.1:8787/v1/summarize', {
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
    })

    // Check for stale fetch after daemon request
    if (isStale()) return

    setProgress(60)
    setStatus('Processing...')

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    const data = await response.json() as {
      ok?: boolean
      error?: string
      extracted?: {
        content?: string
        transcriptTimedText?: string
      }
    }

    // Check for stale fetch after parsing response
    if (isStale()) return

    if (!data.ok) {
      throw new Error(data.error || 'Failed to fetch transcript')
    }

    setProgress(90)

    // Extract transcript text
    let transcriptText = data.extracted?.content || data.extracted?.transcriptTimedText || null

    // If we got timed text, clean it up (remove timestamps)
    if (transcriptText && transcriptText.includes('[')) {
      transcriptText = transcriptText
        .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, '')
        .replace(/\n+/g, ' ')
        .trim()
    }

    setProgress(100)

    if (!transcriptText || transcriptText.trim().length === 0) {
      throw new Error('No transcript available for this video')
    }

    setStatus('Done')
    showTranscript(transcriptText.trim(), platform, 'extracted')

  } catch (err) {
    // Ignore errors from aborted or stale fetches
    if ((err as Error).name === 'AbortError') return
    if (isStale()) return

    const message = err instanceof Error ? err.message : 'Unknown error'
    setStatus('Error')

    if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
      showError('Cannot connect to daemon. Make sure it\'s running: summarize daemon status')
    } else {
      showError(message)
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

// Persist checkbox setting
includeDetailsCheckbox.addEventListener('change', () => {
  patchSettings({ includeVideoDetails: includeDetailsCheckbox.checked })
})

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
}

// Initial setup
initCheckboxState()
checkCurrentTab()
