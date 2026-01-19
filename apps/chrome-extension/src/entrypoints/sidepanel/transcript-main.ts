import { loadSettings } from '../../lib/settings'

// Supported URL patterns
const YOUTUBE_PATTERN = /^https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)/
const TIKTOK_PATTERN = /^https?:\/\/(?:www\.|vm\.)?tiktok\.com\//
const INSTAGRAM_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\//

type Platform = 'youtube' | 'tiktok' | 'instagram' | null

// Content script response types
type TikTokTranscriptResponse =
  | {
      ok: true
      text: string
      source: 'tiktok-captions'
      durationSeconds: number | null
    }
  | { ok: false; error: string; reason: string }

type InstagramTranscriptResponse =
  | {
      ok: true
      videoUrl: string
      source: 'instagram-video'
      durationSeconds: number | null
      title: string | null
    }
  | { ok: false; error: string; reason: string }

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

let currentUrl: string | null = null
let currentTranscript: string | null = null
let abortController: AbortController | null = null

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

  try {
    await navigator.clipboard.writeText(currentTranscript)
    copyBtn.textContent = 'Copied!'
    copyBtn.classList.add('copied')
    setTimeout(() => {
      copyBtn.textContent = 'Copy'
      copyBtn.classList.remove('copied')
    }, 2000)
  } catch {
    copyBtn.textContent = 'Failed'
    setTimeout(() => {
      copyBtn.textContent = 'Copy'
    }, 2000)
  }
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
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'tiktok-transcript' }) as TikTokTranscriptResponse
      if (response?.ok && response.text) {
        return { text: response.text, source: 'tiktok-captions' }
      }
      // Content script couldn't get captions, fall back to daemon
      console.log('[Transcript] TikTok content script:', response?.ok ? 'empty' : response?.reason)
    } catch (err) {
      // Content script not injected or error
      console.log('[Transcript] TikTok content script error:', err)
    }
  }

  if (platform === 'instagram') {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'instagram-transcript' }) as InstagramTranscriptResponse
      if (response?.ok && response.videoUrl) {
        // Instagram returns video URL - check if it's a usable CDN URL
        const videoUrl = response.videoUrl
        // CDN URLs from Instagram are typically accessible without auth
        if (videoUrl.startsWith('https://') && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:')) {
          console.log('[Transcript] Instagram video URL extracted:', videoUrl.slice(0, 100) + '...')
          return { videoUrl, source: 'instagram-video' }
        }
        console.log('[Transcript] Instagram video URL is not a CDN URL, cannot use')
      }
    } catch (err) {
      console.log('[Transcript] Instagram content script error:', err)
    }
  }

  return null
}

async function fetchTranscript() {
  if (!currentUrl) return

  const platform = detectPlatform(currentUrl)
  if (!platform) {
    showUnsupported()
    return
  }

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

    if (!token) {
      showSetup()
      return
    }

    showLoading(`Fetching ${platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram'} transcript...`)
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
    if ((err as Error).name === 'AbortError') return

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

// Listen for tab changes
chrome.tabs.onActivated.addListener(() => {
  checkCurrentTab()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    checkCurrentTab()
  }
})

// Initial check
checkCurrentTab()
