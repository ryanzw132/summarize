/* global chrome */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'offscreen-copy') return

  const text = typeof message.text === 'string' ? message.text : ''

  ;(async () => {
    // Try modern Clipboard API first
    try {
      await navigator.clipboard.writeText(text)
      sendResponse({ ok: true })
      return
    } catch (clipboardErr) {
      console.log('[Offscreen] Clipboard API failed, trying execCommand:', clipboardErr)
    }

    // Fallback to execCommand with textarea
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, text.length)

      const success = document.execCommand('copy')
      document.body.removeChild(textarea)

      if (success) {
        sendResponse({ ok: true })
        return
      }
      throw new Error('execCommand returned false')
    } catch (execErr) {
      const errorMessage = execErr instanceof Error ? execErr.message : 'Clipboard write failed'
      sendResponse({ ok: false, error: errorMessage })
    }
  })()

  return true
})
