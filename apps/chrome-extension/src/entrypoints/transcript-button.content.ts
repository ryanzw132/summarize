import { defineContentScript } from 'wxt/utils/define-content-script'

/**
 * Overlay button content script for copying transcripts from video pages.
 * Appears as a floating button on YouTube Shorts, TikTok, and Instagram video pages.
 */

// Button states
type ButtonState = 'idle' | 'loading' | 'success' | 'error'

// CSS styles for the button
const BUTTON_STYLES = `
  .summarize-transcript-btn {
    position: fixed;
    bottom: 100px;
    right: 24px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    background: rgba(40, 40, 40, 0.9);
  }

  .summarize-transcript-btn:hover {
    transform: scale(1.1);
    background: rgba(60, 60, 60, 0.95);
  }

  .summarize-transcript-btn:active {
    transform: scale(0.95);
  }

  .summarize-transcript-btn.loading {
    cursor: wait;
    pointer-events: none;
  }

  .summarize-transcript-btn.success {
    background: #22c55e;
  }

  .summarize-transcript-btn.error {
    background: #ef4444;
  }

  .summarize-transcript-btn svg {
    width: 24px;
    height: 24px;
    fill: white;
  }

  .summarize-transcript-btn .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: summarize-spin 1s linear infinite;
  }

  @keyframes summarize-spin {
    to { transform: rotate(360deg); }
  }

  .summarize-transcript-btn .tooltip {
    position: absolute;
    right: 56px;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }

  .summarize-transcript-btn:hover .tooltip,
  .summarize-transcript-btn.success .tooltip,
  .summarize-transcript-btn.error .tooltip {
    opacity: 1;
  }
`

// SVG icons
const TRANSCRIPT_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM8 12h8v2H8v-2zm0 4h8v2H8v-2zm0-8h3v2H8V8z"/></svg>`
const CHECK_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`
const ERROR_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`

let button: HTMLButtonElement | null = null
let tooltipEl: HTMLSpanElement | null = null
let currentState: ButtonState = 'idle'

function injectStyles() {
  if (document.getElementById('summarize-transcript-btn-styles')) return

  const style = document.createElement('style')
  style.id = 'summarize-transcript-btn-styles'
  style.textContent = BUTTON_STYLES
  document.head.appendChild(style)
}

function createButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'summarize-transcript-btn'
  btn.title = 'Copy transcript'
  btn.innerHTML = TRANSCRIPT_ICON

  tooltipEl = document.createElement('span')
  tooltipEl.className = 'tooltip'
  tooltipEl.textContent = 'Copy transcript'
  btn.appendChild(tooltipEl)

  return btn
}

function updateButtonState(state: ButtonState, message?: string) {
  if (!button || !tooltipEl) return

  currentState = state
  button.classList.remove('loading', 'success', 'error')

  switch (state) {
    case 'idle':
      button.innerHTML = TRANSCRIPT_ICON
      button.appendChild(tooltipEl)
      tooltipEl.textContent = message || 'Copy transcript'
      break
    case 'loading':
      button.classList.add('loading')
      button.innerHTML = '<div class="spinner"></div>'
      button.appendChild(tooltipEl)
      tooltipEl.textContent = message || 'Copying...'
      break
    case 'success':
      button.classList.add('success')
      button.innerHTML = CHECK_ICON
      button.appendChild(tooltipEl)
      tooltipEl.textContent = message || 'Copied!'
      // Reset to idle after 2 seconds
      setTimeout(() => {
        if (currentState === 'success') {
          updateButtonState('idle')
        }
      }, 2000)
      break
    case 'error':
      button.classList.add('error')
      button.innerHTML = ERROR_ICON
      button.appendChild(tooltipEl)
      tooltipEl.textContent = message || 'Failed'
      // Reset to idle after 2 seconds
      setTimeout(() => {
        if (currentState === 'error') {
          updateButtonState('idle')
        }
      }, 2000)
      break
  }
}

async function handleButtonClick() {
  if (currentState === 'loading') return

  updateButtonState('loading', 'Extracting transcript...')

  try {
    // Send message to background script to fetch transcript with timeout
    const timeoutMs = 60000 // 60 second timeout for transcription
    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'fetch-transcript-for-button',
        url: window.location.href,
      }) as Promise<{ ok: boolean; text?: string; error?: string }>,
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'Request timed out' }), timeoutMs)
      ),
    ])

    if (response?.ok && response.text) {
      await navigator.clipboard.writeText(response.text)
      updateButtonState('success', 'Copied!')
    } else {
      const errorMsg = response?.error || 'No transcript available'
      console.log('[Transcript Button] Error:', errorMsg)
      updateButtonState('error', errorMsg.length > 30 ? 'Failed' : errorMsg)
    }
  } catch (err) {
    console.error('[Transcript Button] Error:', err)
    updateButtonState('error', 'Failed')
  }
}

function injectButton() {
  if (button && document.body.contains(button)) return

  injectStyles()
  button = createButton()
  button.addEventListener('click', handleButtonClick)
  document.body.appendChild(button)
}

function removeButton() {
  if (button && button.parentNode) {
    button.removeEventListener('click', handleButtonClick)
    button.parentNode.removeChild(button)
    button = null
    tooltipEl = null
  }
}

function shouldShowButton(): boolean {
  const url = window.location.href

  // YouTube Shorts
  if (/youtube\.com\/shorts\//.test(url)) return true

  // TikTok videos - multiple URL patterns
  // Standard video URLs: tiktok.com/@username/video/id
  if (/tiktok\.com\/@[^/]+\/video\//.test(url)) return true
  // Short links: vm.tiktok.com/id (always redirect to videos)
  if (/vm\.tiktok\.com\//.test(url)) return true
  // Mobile video URLs: m.tiktok.com/v/id or m.tiktok.com/@user/video/id
  if (/m\.tiktok\.com\/v\//.test(url)) return true
  if (/m\.tiktok\.com\/@[^/]+\/video\//.test(url)) return true
  // TikTok FYP and Explore pages - check if a video is actually playing
  if (/tiktok\.com\/(foryou|explore|discover|following)?(\?|$)/i.test(url)) {
    // Only show button if there's a video element on the page
    const hasVideo = document.querySelector('video') !== null
    return hasVideo
  }
  // TikTok search results with videos
  if (/tiktok\.com\/search/.test(url)) {
    const hasVideo = document.querySelector('video') !== null
    return hasVideo
  }
  // TikTok profile pages viewing a video (modal overlay)
  if (/tiktok\.com\/@[^/]+\/?(\?|$)/.test(url)) {
    // Check if video modal is open
    const hasVideoModal = document.querySelector('video') !== null
    return hasVideoModal
  }

  // Instagram Reels and posts
  if (/instagram\.com\/(?:reel|reels|p|tv)\//.test(url)) return true
  // Instagram Explore/Feed with video modal open
  if (/instagram\.com\/(explore|reels)?\/?(\?|$)/i.test(url)) {
    const hasVideo = document.querySelector('video') !== null
    return hasVideo
  }

  return false
}

function checkAndUpdateButton() {
  if (shouldShowButton()) {
    injectButton()
  } else {
    removeButton()
  }
}

export default defineContentScript({
  matches: [
    '*://*.youtube.com/*',
    '*://*.tiktok.com/*',
    '*://vm.tiktok.com/*',
    '*://*.instagram.com/*',
  ],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_transcript_button_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    // Initial check (with small delay for page to load video elements)
    setTimeout(checkAndUpdateButton, 500)

    // Watch for URL changes (SPA navigation)
    let lastUrl = window.location.href
    let lastVideoCount = document.querySelectorAll('video').length

    // Use a debounced check to avoid excessive calls
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const debouncedCheck = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const currentUrl = window.location.href
        const currentVideoCount = document.querySelectorAll('video').length

        // Check on URL change OR video element change
        if (currentUrl !== lastUrl || currentVideoCount !== lastVideoCount) {
          lastUrl = currentUrl
          lastVideoCount = currentVideoCount
          checkAndUpdateButton()
        }
      }, 150)
    }

    // Only observe if document.body exists
    if (document.body) {
      const observer = new MutationObserver(debouncedCheck)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      })
    }

    // Also listen for popstate (browser back/forward)
    window.addEventListener('popstate', checkAndUpdateButton)

    // Listen for YouTube's custom navigation event
    window.addEventListener('yt-navigate-finish', checkAndUpdateButton)

    // Fallback: periodic check for TikTok/Instagram SPA navigation
    // These apps may change content without changing URL
    setInterval(() => {
      const currentVideoCount = document.querySelectorAll('video').length
      if (currentVideoCount !== lastVideoCount) {
        lastVideoCount = currentVideoCount
        checkAndUpdateButton()
      }
    }, 1000)
  },
})
