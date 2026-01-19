import { loadSettings } from '../../lib/settings'

// Supported URL patterns
const YOUTUBE_PATTERN = /^https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)/
const TIKTOK_PATTERN = /^https?:\/\/(?:www\.|vm\.)?tiktok\.com\//
const INSTAGRAM_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels)\//

type Platform = 'youtube' | 'tiktok' | 'instagram' | null

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

    if (!token) {
      showSetup()
      return
    }

    showLoading(`Fetching ${platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram'} transcript...`)
    setStatus('Connecting...')

    // Get the active tab's title
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const title = tab?.title || null

    // Make request to daemon
    const response = await fetch('http://127.0.0.1:8787/v1/summarize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: currentUrl,
        title,
        mode: 'url',
        extractOnly: true,
        timestamps: true,
        maxCharacters: null,
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
