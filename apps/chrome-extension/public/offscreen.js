/* global chrome */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'offscreen-copy') return

  const text = typeof message.text === 'string' ? message.text : ''

  ;(async () => {
    try {
      await navigator.clipboard.writeText(text)
      sendResponse({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Clipboard write failed'
      sendResponse({ ok: false, error: errorMessage })
    }
  })()

  return true
})
