export interface TranscriptViewOptions {
  containerEl: HTMLElement
  onCopy?: () => void
}

export interface TranscriptViewController {
  setTranscript(text: string | null, metadata?: Record<string, unknown> | null): void
  clear(): void
  isVisible(): boolean
  show(): void
  hide(): void
}

export function createTranscriptView(options: TranscriptViewOptions): TranscriptViewController {
  const { containerEl, onCopy } = options

  // Create view elements
  const viewEl = document.createElement('div')
  viewEl.className = 'transcriptView hidden'
  viewEl.innerHTML = `
    <div class="transcriptView__header">
      <span class="transcriptView__title">Transcript</span>
      <button type="button" class="ghost transcriptView__copyBtn" aria-label="Copy transcript">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        <span class="transcriptView__copyLabel">Copy</span>
      </button>
    </div>
    <div class="transcriptView__content"></div>
    <div class="transcriptView__meta"></div>
  `

  containerEl.appendChild(viewEl)

  const contentEl = viewEl.querySelector('.transcriptView__content') as HTMLDivElement
  const metaEl = viewEl.querySelector('.transcriptView__meta') as HTMLDivElement
  const copyBtn = viewEl.querySelector('.transcriptView__copyBtn') as HTMLButtonElement
  const copyLabelEl = viewEl.querySelector('.transcriptView__copyLabel') as HTMLSpanElement

  let currentTranscript: string | null = null
  let copyTimeout: number | null = null

  async function copyToClipboard() {
    if (!currentTranscript) return

    try {
      await navigator.clipboard.writeText(currentTranscript)
      copyLabelEl.textContent = 'Copied!'
      copyBtn.classList.add('copied')

      if (copyTimeout) {
        window.clearTimeout(copyTimeout)
      }
      copyTimeout = window.setTimeout(() => {
        copyLabelEl.textContent = 'Copy'
        copyBtn.classList.remove('copied')
        copyTimeout = null
      }, 2000)

      onCopy?.()
    } catch {
      copyLabelEl.textContent = 'Failed'
      if (copyTimeout) {
        window.clearTimeout(copyTimeout)
      }
      copyTimeout = window.setTimeout(() => {
        copyLabelEl.textContent = 'Copy'
        copyTimeout = null
      }, 2000)
    }
  }

  copyBtn.addEventListener('click', copyToClipboard)

  return {
    setTranscript(text: string | null, metadata?: Record<string, unknown> | null) {
      currentTranscript = text

      if (!text) {
        contentEl.textContent = 'No transcript available'
        contentEl.classList.add('empty')
        metaEl.textContent = ''
        return
      }

      contentEl.textContent = text
      contentEl.classList.remove('empty')

      // Build metadata display
      const metaParts: string[] = []
      if (metadata?.durationSeconds && typeof metadata.durationSeconds === 'number') {
        const mins = Math.floor(metadata.durationSeconds / 60)
        const secs = Math.floor(metadata.durationSeconds % 60)
        metaParts.push(`${mins}:${secs.toString().padStart(2, '0')}`)
      }
      if (metadata?.provider && typeof metadata.provider === 'string') {
        metaParts.push(metadata.provider)
      }
      metaEl.textContent = metaParts.length > 0 ? metaParts.join(' · ') : ''
    },

    clear() {
      currentTranscript = null
      contentEl.textContent = ''
      contentEl.classList.remove('empty')
      metaEl.textContent = ''
    },

    isVisible() {
      return !viewEl.classList.contains('hidden')
    },

    show() {
      viewEl.classList.remove('hidden')
    },

    hide() {
      viewEl.classList.add('hidden')
    },
  }
}

/**
 * Auto-copy transcript to clipboard if enabled
 */
export async function autoCopyTranscript(
  text: string | null,
  enabled: boolean
): Promise<boolean> {
  if (!enabled || !text) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
