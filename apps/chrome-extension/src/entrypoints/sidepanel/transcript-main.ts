import { loadSettings, patchSettings } from '../../lib/settings'
import { generateToken } from '../../lib/token'

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
  | {
      ok: false
      error: string
      reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' | 'is_ad' | 'is_music' | 'not_english'
      videoUrl?: string  // For Whisper fallback on FYP/Explore pages
    }

type InstagramTranscriptResponse =
  | {
      ok: true
      videoUrl: string
      source: 'instagram-video'
      durationSeconds: number | null
      title: string | null
    }
  | { ok: false; error: string; reason: 'no_video' | 'extraction_failed' | 'unsupported_url' | 'is_ad' | 'auth_required' | 'blocked' }

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
const EXTENSION_VERSION = '1.0.0'  // TODO: read from manifest

// =============================================================================
// COMPREHENSIVE ERROR REPORTING SYSTEM
// =============================================================================

// Error categories for grouping
type ErrorCategory =
  | 'CONTENT_SCRIPT'     // Injection, timeout, no response
  | 'DAEMON_CONNECTION'  // Unreachable, timeout, auth
  | 'DAEMON_PROCESSING'  // yt-dlp failed, Whisper failed, no audio
  | 'URL_VALIDATION'     // Invalid URL, unsupported platform
  | 'PLATFORM_SPECIFIC'  // Instagram CDN, TikTok hydration, YouTube captions
  | 'EXTENSION_STATE'    // Missing permissions, settings issues
  | 'NETWORK'            // DNS, CORS, SSL, offline

// Specific error codes - each maps to exactly one failure mode
type AutoScrollErrorCode =
  // Content script errors (CS_*)
  | 'CS_INJECTION_FAILED'
  | 'CS_TIMEOUT'
  | 'CS_NO_RESPONSE'
  | 'CS_SCROLL_FAILED'
  | 'CS_INVALID_RESPONSE'
  // Daemon connection errors (DC_*)
  | 'DC_UNREACHABLE'
  | 'DC_TIMEOUT'
  | 'DC_AUTH_FAILED'
  | 'DC_HTTP_4XX'
  | 'DC_HTTP_5XX'
  // Daemon processing errors (DP_*)
  | 'DP_YTDLP_FAILED'
  | 'DP_WHISPER_FAILED'
  | 'DP_NO_AUDIO'
  | 'DP_EMPTY_TRANSCRIPT'
  | 'DP_PARSE_ERROR'
  | 'DP_UNKNOWN_ERROR'
  // URL errors (URL_*)
  | 'URL_MISSING'
  | 'URL_INVALID'
  | 'URL_UNSUPPORTED_PLATFORM'
  | 'URL_VALIDATION_FAILED'
  // Platform errors (PF_*)
  | 'PF_NO_CAPTIONS'
  | 'PF_VIDEO_NOT_FOUND'
  | 'PF_EXTRACTION_FAILED'
  | 'PF_AUTH_REQUIRED'
  | 'PF_CONTENT_BLOCKED'
  // Extension state errors (EX_*)
  | 'EX_NO_TOKEN'
  | 'EX_INVALID_SETTINGS'
  | 'EX_TAB_CLOSED'
  // Network errors (NET_*)
  | 'NET_OFFLINE'
  | 'NET_DNS_FAILED'
  | 'NET_CORS_BLOCKED'
  | 'NET_SSL_ERROR'

// Legacy error codes for backwards compatibility
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

// Processing stage where error occurred
type ErrorStage =
  | 'INIT'              // Initial setup
  | 'URL_PARSE'         // Parsing/validating URL
  | 'CS_INJECT'         // Injecting content script
  | 'CS_EXTRACT'        // Content script extracting data
  | 'CS_SCROLL'         // Content script scrolling
  | 'DAEMON_REQUEST'    // Making request to daemon
  | 'DAEMON_PROCESS'    // Daemon processing (yt-dlp, Whisper)
  | 'RESPONSE_PARSE'    // Parsing daemon response
  | 'POST_PROCESS'      // Post-processing transcript
  | 'UI_RENDER'         // Rendering in UI

// Error metadata with remediation hints
interface ErrorCodeInfo {
  code: AutoScrollErrorCode
  category: ErrorCategory
  message: string
  technicalDetails: string
  userAction: string
  retryable: boolean
  severity: 'info' | 'warn' | 'error' | 'fatal'
}

// Error code registry - THE source of truth for all error information
const ERROR_CODE_REGISTRY: Record<AutoScrollErrorCode, Omit<ErrorCodeInfo, 'code'>> = {
  // Content script errors
  CS_INJECTION_FAILED: {
    category: 'CONTENT_SCRIPT',
    message: 'Failed to inject content script into page',
    technicalDetails: 'chrome.scripting.executeScript failed. Page may have CSP restrictions or extension lacks permissions.',
    userAction: 'Refresh the page and try again. If it persists, check that the extension has permission for this site.',
    retryable: true,
    severity: 'error',
  },
  CS_TIMEOUT: {
    category: 'CONTENT_SCRIPT',
    message: 'Content script did not respond in time',
    technicalDetails: 'sendMessage timeout after 10 seconds. Script may not be loaded or page is blocking message passing.',
    userAction: 'Refresh the page. If on a slow connection, wait for the page to fully load before trying.',
    retryable: true,
    severity: 'warn',
  },
  CS_NO_RESPONSE: {
    category: 'CONTENT_SCRIPT',
    message: 'Content script returned no data',
    technicalDetails: 'Content script responded but with null/undefined. Likely a bug in the content script or page structure changed.',
    userAction: 'Try refreshing the page. If the problem persists, report this error.',
    retryable: true,
    severity: 'error',
  },
  CS_SCROLL_FAILED: {
    category: 'CONTENT_SCRIPT',
    message: 'Failed to scroll to next video',
    technicalDetails: 'Scroll command sent but video did not change. May have reached end of feed or page structure changed.',
    userAction: 'Manually scroll to the next video, or this may be the end of the feed.',
    retryable: false,
    severity: 'warn',
  },
  CS_INVALID_RESPONSE: {
    category: 'CONTENT_SCRIPT',
    message: 'Content script returned invalid data',
    technicalDetails: 'Response did not match expected schema. Content script may be outdated or page structure changed.',
    userAction: 'Try refreshing the page. If it persists, the extension may need an update.',
    retryable: true,
    severity: 'error',
  },

  // Daemon connection errors
  DC_UNREACHABLE: {
    category: 'DAEMON_CONNECTION',
    message: 'Cannot connect to transcription daemon',
    technicalDetails: 'fetch() failed with network error. Daemon may not be running or port 8787 is blocked.',
    userAction: 'Start the daemon with: summarize daemon start',
    retryable: true,
    severity: 'fatal',
  },
  DC_TIMEOUT: {
    category: 'DAEMON_CONNECTION',
    message: 'Daemon request timed out',
    technicalDetails: 'Request exceeded 120 second timeout. Video may be too long or Whisper is overloaded.',
    userAction: 'Try a shorter video, or wait and retry. Check daemon logs for details.',
    retryable: true,
    severity: 'error',
  },
  DC_AUTH_FAILED: {
    category: 'DAEMON_CONNECTION',
    message: 'Daemon authentication failed',
    technicalDetails: 'HTTP 401/403 returned. Token may be incorrect or expired.',
    userAction: 'Check your token in settings. Run: summarize daemon install --token YOUR_TOKEN',
    retryable: false,
    severity: 'fatal',
  },
  DC_HTTP_4XX: {
    category: 'DAEMON_CONNECTION',
    message: 'Daemon rejected the request',
    technicalDetails: 'HTTP 4xx error. Request may be malformed or URL is invalid.',
    userAction: 'Check the URL is a valid video URL. Try a different video.',
    retryable: false,
    severity: 'error',
  },
  DC_HTTP_5XX: {
    category: 'DAEMON_CONNECTION',
    message: 'Daemon encountered an internal error',
    technicalDetails: 'HTTP 5xx error. Server-side failure in daemon.',
    userAction: 'Retry in a few seconds. Check daemon logs: ~/.summarize/logs/daemon.err.log',
    retryable: true,
    severity: 'error',
  },

  // Daemon processing errors
  DP_YTDLP_FAILED: {
    category: 'DAEMON_PROCESSING',
    message: 'Failed to download video',
    technicalDetails: 'yt-dlp returned an error. Video may be private, region-locked, or the platform blocked the download.',
    userAction: 'Check if the video is public. Try a different video. Update yt-dlp: pip install -U yt-dlp',
    retryable: true,
    severity: 'error',
  },
  DP_WHISPER_FAILED: {
    category: 'DAEMON_PROCESSING',
    message: 'Whisper transcription failed',
    technicalDetails: 'Whisper process crashed or returned an error. Audio may be corrupted or unsupported format.',
    userAction: 'Try a different video. Check daemon logs for Whisper errors.',
    retryable: true,
    severity: 'error',
  },
  DP_NO_AUDIO: {
    category: 'DAEMON_PROCESSING',
    message: 'Video has no audio track',
    technicalDetails: 'Media file contains no audio stream. Cannot transcribe silent video.',
    userAction: 'This video has no audio. Try a video with speech.',
    retryable: false,
    severity: 'warn',
  },
  DP_EMPTY_TRANSCRIPT: {
    category: 'DAEMON_PROCESSING',
    message: 'Transcription returned empty text',
    technicalDetails: 'Whisper ran but produced no output. Audio may be too quiet, music-only, or non-speech.',
    userAction: 'Video may not contain speech. Try a video with clear spoken content.',
    retryable: false,
    severity: 'warn',
  },
  DP_PARSE_ERROR: {
    category: 'DAEMON_PROCESSING',
    message: 'Failed to parse daemon response',
    technicalDetails: 'JSON parsing failed or response schema mismatch. Daemon may have returned malformed data.',
    userAction: 'Retry. If it persists, check daemon logs and report this error.',
    retryable: true,
    severity: 'error',
  },
  DP_UNKNOWN_ERROR: {
    category: 'DAEMON_PROCESSING',
    message: 'Unknown daemon error',
    technicalDetails: 'Daemon returned an error that does not match known patterns.',
    userAction: 'Check daemon logs: ~/.summarize/logs/daemon.err.log',
    retryable: true,
    severity: 'error',
  },

  // URL errors
  URL_MISSING: {
    category: 'URL_VALIDATION',
    message: 'No URL detected',
    technicalDetails: 'currentUrl is null or empty. Tab may not have a URL or is a special page.',
    userAction: 'Navigate to a video page on YouTube, TikTok, or Instagram.',
    retryable: false,
    severity: 'error',
  },
  URL_INVALID: {
    category: 'URL_VALIDATION',
    message: 'URL is not valid',
    technicalDetails: 'URL parsing failed or scheme is not http/https.',
    userAction: 'Make sure you are on a valid video page URL.',
    retryable: false,
    severity: 'error',
  },
  URL_UNSUPPORTED_PLATFORM: {
    category: 'URL_VALIDATION',
    message: 'Platform not supported',
    technicalDetails: 'URL does not match YouTube, TikTok, or Instagram patterns.',
    userAction: 'Auto-scroll only works on YouTube Shorts, TikTok, and Instagram Reels.',
    retryable: false,
    severity: 'info',
  },
  URL_VALIDATION_FAILED: {
    category: 'URL_VALIDATION',
    message: 'URL failed security validation',
    technicalDetails: 'URL did not pass platform-specific host validation. May be a phishing or lookalike site.',
    userAction: 'Make sure you are on the official YouTube, TikTok, or Instagram website.',
    retryable: false,
    severity: 'error',
  },

  // Platform-specific errors
  PF_NO_CAPTIONS: {
    category: 'PLATFORM_SPECIFIC',
    message: 'No native captions available',
    technicalDetails: 'Platform does not provide captions for this video. Will fall back to Whisper.',
    userAction: 'This is normal - Whisper will transcribe the audio instead.',
    retryable: false,
    severity: 'info',
  },
  PF_VIDEO_NOT_FOUND: {
    category: 'PLATFORM_SPECIFIC',
    message: 'Video not found on page',
    technicalDetails: 'Could not locate video element or video data in page. Page may still be loading or structure changed.',
    userAction: 'Wait for the video to fully load, then retry.',
    retryable: true,
    severity: 'error',
  },
  PF_EXTRACTION_FAILED: {
    category: 'PLATFORM_SPECIFIC',
    message: 'Failed to extract video data',
    technicalDetails: 'Content script found video but could not extract required data. DOM structure may have changed.',
    userAction: 'Try refreshing the page. The platform may have updated their page structure.',
    retryable: true,
    severity: 'error',
  },
  PF_AUTH_REQUIRED: {
    category: 'PLATFORM_SPECIFIC',
    message: 'Login required to view this content',
    technicalDetails: 'Platform requires authentication to access this video.',
    userAction: 'Log in to the platform and try again.',
    retryable: false,
    severity: 'warn',
  },
  PF_CONTENT_BLOCKED: {
    category: 'PLATFORM_SPECIFIC',
    message: 'Content is blocked or unavailable',
    technicalDetails: 'Video is private, deleted, region-locked, or age-restricted.',
    userAction: 'This video is not accessible. Try a different video.',
    retryable: false,
    severity: 'warn',
  },

  // Extension state errors
  EX_NO_TOKEN: {
    category: 'EXTENSION_STATE',
    message: 'Daemon token not configured',
    technicalDetails: 'No authentication token found in extension settings.',
    userAction: 'Set up the daemon: Copy the token from settings and run summarize daemon install --token TOKEN',
    retryable: false,
    severity: 'fatal',
  },
  EX_INVALID_SETTINGS: {
    category: 'EXTENSION_STATE',
    message: 'Extension settings are invalid',
    technicalDetails: 'Settings failed validation. Storage may be corrupted.',
    userAction: 'Try resetting extension settings in the options page.',
    retryable: false,
    severity: 'error',
  },
  EX_TAB_CLOSED: {
    category: 'EXTENSION_STATE',
    message: 'Tab was closed during processing',
    technicalDetails: 'chrome.tabs.get failed because the tab no longer exists.',
    userAction: 'Open a new tab and try again.',
    retryable: false,
    severity: 'warn',
  },

  // Network errors
  NET_OFFLINE: {
    category: 'NETWORK',
    message: 'No internet connection',
    technicalDetails: 'navigator.onLine is false or network request failed with offline error.',
    userAction: 'Check your internet connection.',
    retryable: true,
    severity: 'fatal',
  },
  NET_DNS_FAILED: {
    category: 'NETWORK',
    message: 'DNS lookup failed',
    technicalDetails: 'Could not resolve hostname. DNS server may be unreachable.',
    userAction: 'Check your network connection and DNS settings.',
    retryable: true,
    severity: 'error',
  },
  NET_CORS_BLOCKED: {
    category: 'NETWORK',
    message: 'Request blocked by CORS policy',
    technicalDetails: 'Cross-origin request was blocked. This should not happen for daemon requests.',
    userAction: 'Check that the daemon is running on http://127.0.0.1:8787',
    retryable: false,
    severity: 'error',
  },
  NET_SSL_ERROR: {
    category: 'NETWORK',
    message: 'SSL/TLS error',
    technicalDetails: 'Certificate validation failed or SSL handshake error.',
    userAction: 'Check your network for MITM proxies or certificate issues.',
    retryable: false,
    severity: 'error',
  },
}

// Comprehensive error report structure
interface AutoScrollErrorReport {
  // Identity
  reportId: string
  errorCode: AutoScrollErrorCode
  category: ErrorCategory
  severity: 'info' | 'warn' | 'error' | 'fatal'

  // Timing
  timestamp: string
  elapsedMs: number
  stage: ErrorStage

  // Context
  videoIndex: number
  platform: Platform
  url: string | null
  normalizedUrl: string | null

  // Attempt info
  attemptNumber: number
  maxAttempts: number
  retryable: boolean

  // Messages
  message: string
  technicalDetails: string
  userAction: string

  // Response data (if applicable)
  httpStatus?: number
  responseBody?: string  // Truncated to 2000 chars
  daemonError?: string

  // Debug info
  contentScriptLoaded?: boolean
  tabId?: number
  stackTrace?: string

  // State
  tokenConfigured: boolean
  online: boolean

  // Environment
  extensionVersion: string
  browserVersion: string
  platform_os: string
}

// Generate a unique report ID
function generateReportId(): string {
  return `ASE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

// Error report history for session (bounded)
const errorHistory: AutoScrollErrorReport[] = []
const MAX_ERROR_HISTORY = 50

// Current error state for UI
let currentAutoScrollError: AutoScrollErrorReport | null = null

// Create a comprehensive error report
function createAutoScrollError(
  code: AutoScrollErrorCode,
  stage: ErrorStage,
  context: {
    videoIndex?: number
    url?: string | null
    normalizedUrl?: string | null
    platform?: Platform
    attemptNumber?: number
    maxAttempts?: number
    elapsedMs?: number
    httpStatus?: number
    responseBody?: string
    daemonError?: string
    contentScriptLoaded?: boolean
    tabId?: number
    stackTrace?: string
  } = {}
): AutoScrollErrorReport {
  const info = ERROR_CODE_REGISTRY[code]

  const report: AutoScrollErrorReport = {
    // Identity
    reportId: generateReportId(),
    errorCode: code,
    category: info.category,
    severity: info.severity,

    // Timing
    timestamp: new Date().toISOString(),
    elapsedMs: context.elapsedMs ?? 0,
    stage,

    // Context
    videoIndex: context.videoIndex ?? 0,
    platform: context.platform ?? detectPlatform(context.url || currentUrl || ''),
    url: context.url ?? currentUrl,
    normalizedUrl: context.normalizedUrl ?? null,

    // Attempt info
    attemptNumber: context.attemptNumber ?? 1,
    maxAttempts: context.maxAttempts ?? 1,
    retryable: info.retryable,

    // Messages
    message: info.message,
    technicalDetails: info.technicalDetails,
    userAction: info.userAction,

    // Response data
    httpStatus: context.httpStatus,
    responseBody: context.responseBody?.slice(0, 2000),
    daemonError: context.daemonError,

    // Debug info
    contentScriptLoaded: context.contentScriptLoaded,
    tabId: context.tabId,
    stackTrace: context.stackTrace,

    // State
    tokenConfigured: false, // Will be set below
    online: navigator.onLine,

    // Environment
    extensionVersion: EXTENSION_VERSION,
    browserVersion: navigator.userAgent,
    platform_os: navigator.platform,
  }

  // Check token
  loadSettings().then(settings => {
    report.tokenConfigured = Boolean(settings.token?.trim())
  }).catch(() => {
    report.tokenConfigured = false
  })

  // Store in history
  errorHistory.push(report)
  if (errorHistory.length > MAX_ERROR_HISTORY) {
    errorHistory.shift()
  }

  // Set as current error
  currentAutoScrollError = report

  // Log to console with structured format
  console.error(
    `[AutoScroll Error] ${code}`,
    '\n  Report ID:', report.reportId,
    '\n  Stage:', stage,
    '\n  Message:', info.message,
    '\n  Video:', context.videoIndex ?? 'N/A',
    '\n  URL:', (context.url || currentUrl || 'N/A').slice(0, 80),
    '\n  HTTP:', context.httpStatus ?? 'N/A',
    '\n  Daemon Error:', context.daemonError ?? 'N/A',
    '\n  Technical:', info.technicalDetails,
    '\n  Action:', info.userAction
  )

  return report
}

// Format error report for clipboard (machine + human readable)
function formatErrorReportForCopy(report: AutoScrollErrorReport): string {
  return `═══════════════════════════════════════════════════════════════════
AUTO-SCROLL ERROR REPORT
═══════════════════════════════════════════════════════════════════
Report ID: ${report.reportId}
Time: ${report.timestamp}
Severity: ${report.severity.toUpperCase()}

ERROR: [${report.errorCode}] ${report.message}

───────────────────────────────────────────────────────────────────
CONTEXT
───────────────────────────────────────────────────────────────────
Platform: ${report.platform ?? 'unknown'}
Video #: ${report.videoIndex}
Stage: ${report.stage}
Attempt: ${report.attemptNumber}/${report.maxAttempts}
Elapsed: ${report.elapsedMs}ms

URL: ${report.url ?? 'none'}
${report.normalizedUrl && report.normalizedUrl !== report.url ? `Normalized: ${report.normalizedUrl}` : ''}

───────────────────────────────────────────────────────────────────
DIAGNOSIS
───────────────────────────────────────────────────────────────────
${report.technicalDetails}

${report.httpStatus ? `HTTP Status: ${report.httpStatus}` : ''}
${report.daemonError ? `Daemon Error: ${report.daemonError}` : ''}
${report.responseBody ? `Response (truncated): ${report.responseBody.slice(0, 500)}` : ''}

───────────────────────────────────────────────────────────────────
RECOMMENDED ACTION
───────────────────────────────────────────────────────────────────
${report.userAction}

Retryable: ${report.retryable ? 'Yes' : 'No'}

───────────────────────────────────────────────────────────────────
ENVIRONMENT
───────────────────────────────────────────────────────────────────
Extension: v${report.extensionVersion}
Token Configured: ${report.tokenConfigured ? 'Yes' : 'No'}
Online: ${report.online ? 'Yes' : 'No'}
Tab ID: ${report.tabId ?? 'N/A'}
Content Script: ${report.contentScriptLoaded === undefined ? 'Unknown' : report.contentScriptLoaded ? 'Loaded' : 'Not Loaded'}
OS: ${report.platform_os}
Browser: ${report.browserVersion.slice(0, 100)}

───────────────────────────────────────────────────────────────────
STACK TRACE
───────────────────────────────────────────────────────────────────
${report.stackTrace ?? 'Not available'}

═══════════════════════════════════════════════════════════════════
JSON (for automated processing):
${JSON.stringify(report, null, 2)}
═══════════════════════════════════════════════════════════════════`
}

// Map daemon error messages to error codes
function classifyDaemonError(
  error: string | undefined,
  httpStatus?: number
): AutoScrollErrorCode {
  if (!error && !httpStatus) return 'DP_UNKNOWN_ERROR'

  const errorLower = (error || '').toLowerCase()

  // HTTP status based classification
  if (httpStatus === 401 || httpStatus === 403) return 'DC_AUTH_FAILED'
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) return 'DC_HTTP_4XX'
  if (httpStatus && httpStatus >= 500) return 'DC_HTTP_5XX'

  // Error message based classification
  if (errorLower.includes('yt-dlp') || errorLower.includes('ytdlp') || errorLower.includes('download')) {
    return 'DP_YTDLP_FAILED'
  }
  if (errorLower.includes('whisper') || errorLower.includes('transcri')) {
    return 'DP_WHISPER_FAILED'
  }
  if (errorLower.includes('no audio') || errorLower.includes('audio track')) {
    return 'DP_NO_AUDIO'
  }
  if (errorLower.includes('empty') || errorLower.includes('no transcript')) {
    return 'DP_EMPTY_TRANSCRIPT'
  }
  if (errorLower.includes('timeout')) {
    return 'DC_TIMEOUT'
  }
  if (errorLower.includes('auth') || errorLower.includes('unauthorized') || errorLower.includes('token')) {
    return 'DC_AUTH_FAILED'
  }
  if (errorLower.includes('private') || errorLower.includes('unavailable') || errorLower.includes('blocked')) {
    return 'PF_CONTENT_BLOCKED'
  }
  if (errorLower.includes('login') || errorLower.includes('sign in')) {
    return 'PF_AUTH_REQUIRED'
  }

  return 'DP_UNKNOWN_ERROR'
}

// Map network errors to error codes
function classifyNetworkError(error: Error): AutoScrollErrorCode {
  const msg = error.message.toLowerCase()

  if (!navigator.onLine) return 'NET_OFFLINE'
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'DC_UNREACHABLE'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'DC_TIMEOUT'
  if (msg.includes('cors')) return 'NET_CORS_BLOCKED'
  if (msg.includes('ssl') || msg.includes('certificate')) return 'NET_SSL_ERROR'
  if (msg.includes('dns') || msg.includes('resolve')) return 'NET_DNS_FAILED'

  return 'DC_UNREACHABLE'
}

// Legacy diagnostic system (kept for backwards compatibility)
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

// =============================================================================
// ERROR UI DISPLAY FUNCTIONS
// =============================================================================

/**
 * Display an error report in the auto-scroll error panel.
 */
function showAutoScrollError(report: AutoScrollErrorReport): void {
  if (!autoScrollErrorEl) return

  // Update error code badge
  if (errorCodeBadgeEl) {
    errorCodeBadgeEl.textContent = report.errorCode
  }

  // Update severity badge
  if (errorSeverityEl) {
    errorSeverityEl.textContent = report.severity
    errorSeverityEl.className = `error-severity ${report.severity}`
  }

  // Update message
  if (autoScrollErrorMessageEl) {
    autoScrollErrorMessageEl.textContent = report.message
  }

  // Update technical details
  if (autoScrollErrorTechnicalEl) {
    autoScrollErrorTechnicalEl.textContent = `${report.technicalDetails}

─── Context ───
Stage: ${report.stage}
Video: #${report.videoIndex}
Platform: ${report.platform ?? 'unknown'}
URL: ${report.url ?? 'none'}
${report.normalizedUrl && report.normalizedUrl !== report.url ? `Normalized URL: ${report.normalizedUrl}` : ''}
Attempt: ${report.attemptNumber}/${report.maxAttempts}
Elapsed: ${report.elapsedMs}ms

─── Response ───
${report.httpStatus ? `HTTP Status: ${report.httpStatus}` : 'HTTP Status: N/A'}
${report.daemonError ? `Daemon Error: ${report.daemonError}` : ''}
${report.responseBody ? `Response Body:\n${report.responseBody.slice(0, 500)}${report.responseBody.length > 500 ? '...' : ''}` : ''}

─── Environment ───
Report ID: ${report.reportId}
Tab ID: ${report.tabId ?? 'N/A'}
Token Configured: ${report.tokenConfigured ? 'Yes' : 'No'}
Online: ${report.online ? 'Yes' : 'No'}
Content Script: ${report.contentScriptLoaded === undefined ? 'Unknown' : report.contentScriptLoaded ? 'Loaded' : 'Not Loaded'}`
  }

  // Update action
  if (autoScrollErrorActionEl) {
    autoScrollErrorActionEl.textContent = `💡 ${report.userAction}`
  }

  // Show the error panel
  autoScrollErrorEl.classList.remove('hidden')

  // Update error history summary
  updateErrorHistorySummary()
}

/**
 * Hide the auto-scroll error panel.
 */
function hideAutoScrollError(): void {
  if (autoScrollErrorEl) {
    autoScrollErrorEl.classList.add('hidden')
  }
}

/**
 * Update the error history summary display.
 */
function updateErrorHistorySummary(): void {
  if (!errorHistorySummaryEl || !errorHistoryCountEl) return

  const errorCount = errorHistory.length
  if (errorCount > 0) {
    errorHistoryCountEl.textContent = `${errorCount} error${errorCount === 1 ? '' : 's'} this session`
    errorHistorySummaryEl.classList.remove('hidden')
  } else {
    errorHistorySummaryEl.classList.add('hidden')
  }
}

/**
 * Copy the current error report to clipboard.
 */
async function copyCurrentErrorReport(): Promise<void> {
  if (!currentAutoScrollError) return

  try {
    const reportText = formatErrorReportForCopy(currentAutoScrollError)
    await navigator.clipboard.writeText(reportText)

    if (copyErrorReportBtn) {
      const originalText = copyErrorReportBtn.textContent
      copyErrorReportBtn.textContent = 'Copied!'
      setTimeout(() => {
        copyErrorReportBtn.textContent = originalText
      }, 2000)
    }
  } catch (err) {
    console.error('Failed to copy error report:', err)
    if (copyErrorReportBtn) {
      copyErrorReportBtn.textContent = 'Copy Failed'
      setTimeout(() => {
        copyErrorReportBtn.textContent = 'Copy Error Report'
      }, 2000)
    }
  }
}

/**
 * Show error history modal.
 */
function showErrorHistoryModal(): void {
  // Create modal element
  const modal = document.createElement('div')
  modal.className = 'error-history-modal'
  modal.innerHTML = `
    <div class="error-history-content">
      <div class="error-history-header">
        <h3>Error History (${errorHistory.length})</h3>
        <button class="btn btn-small close-modal-btn">Close</button>
      </div>
      <div class="error-history-list">
        ${errorHistory.length === 0
          ? '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No errors recorded</p>'
          : errorHistory.slice().reverse().map(err => `
            <div class="error-history-item">
              <div class="error-history-item-header">
                <span class="error-code-badge">${err.errorCode}</span>
                <span class="error-severity ${err.severity}">${err.severity}</span>
                <span class="error-history-item-time">${new Date(err.timestamp).toLocaleTimeString()}</span>
              </div>
              <div class="error-history-item-message">${err.message}</div>
            </div>
          `).join('')
        }
      </div>
      <div class="error-history-actions">
        <button class="btn btn-small copy-all-errors-btn">Copy All Errors</button>
        <button class="btn btn-small btn-secondary clear-errors-btn">Clear History</button>
      </div>
    </div>
  `

  // Add event listeners
  const closeBtn = modal.querySelector('.close-modal-btn')
  closeBtn?.addEventListener('click', () => modal.remove())

  const copyAllBtn = modal.querySelector('.copy-all-errors-btn')
  copyAllBtn?.addEventListener('click', async () => {
    const allReports = errorHistory.map(formatErrorReportForCopy).join('\n\n' + '='.repeat(70) + '\n\n')
    try {
      await navigator.clipboard.writeText(allReports)
      if (copyAllBtn instanceof HTMLButtonElement) {
        copyAllBtn.textContent = 'Copied!'
        setTimeout(() => { copyAllBtn.textContent = 'Copy All Errors' }, 2000)
      }
    } catch {
      if (copyAllBtn instanceof HTMLButtonElement) {
        copyAllBtn.textContent = 'Failed'
      }
    }
  })

  const clearBtn = modal.querySelector('.clear-errors-btn')
  clearBtn?.addEventListener('click', () => {
    errorHistory.length = 0
    updateErrorHistorySummary()
    modal.remove()
  })

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove()
  })

  document.body.appendChild(modal)
}

// DOM elements
const titleEl = document.getElementById('title') as HTMLHeadingElement
const statusEl = document.getElementById('status') as HTMLSpanElement
const progressEl = document.getElementById('progress') as HTMLDivElement
const progressFillEl = document.getElementById('progressFill') as HTMLDivElement
const setupEl = document.getElementById('setup') as HTMLDivElement
const openOptionsBtn = document.getElementById('openOptions') as HTMLButtonElement
const tokenDisplayEl = document.getElementById('tokenDisplay') as HTMLSpanElement
const daemonCmdEl = document.getElementById('daemonCmd') as HTMLElement
const copyInstallCmdBtn = document.getElementById('copyInstallCmd') as HTMLButtonElement
const copyDaemonCmdBtn = document.getElementById('copyDaemonCmd') as HTMLButtonElement
const installCmdEl = document.getElementById('installCmd') as HTMLElement
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

// Error reporting UI elements
const autoScrollErrorEl = document.getElementById('autoScrollError') as HTMLDivElement
const errorCodeBadgeEl = document.getElementById('errorCodeBadge') as HTMLSpanElement
const errorSeverityEl = document.getElementById('errorSeverity') as HTMLSpanElement
const autoScrollErrorMessageEl = document.getElementById('autoScrollErrorMessage') as HTMLParagraphElement
const autoScrollErrorTechnicalEl = document.getElementById('autoScrollErrorTechnical') as HTMLDivElement
const autoScrollErrorActionEl = document.getElementById('autoScrollErrorAction') as HTMLParagraphElement
const copyErrorReportBtn = document.getElementById('copyErrorReportBtn') as HTMLButtonElement
const dismissErrorBtn = document.getElementById('dismissErrorBtn') as HTMLButtonElement
const errorHistorySummaryEl = document.getElementById('errorHistorySummary') as HTMLDivElement
const errorHistoryCountEl = document.getElementById('errorHistoryCount') as HTMLSpanElement
const viewErrorHistoryBtn = document.getElementById('viewErrorHistoryBtn') as HTMLButtonElement

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
  let combinedSignal: AbortSignal = timeoutController.signal
  let onCallerAbort: (() => void) | null = null
  if (callerSignal) {
    if (typeof AbortSignal.any === 'function') {
      combinedSignal = AbortSignal.any([callerSignal, timeoutController.signal])
    } else {
      if (callerSignal.aborted) {
        timeoutController.abort()
      } else {
        onCallerAbort = () => timeoutController.abort()
        callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }
    }
  }

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
  } finally {
    if (onCallerAbort && callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort)
    }
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

async function ensureToken(): Promise<string> {
  const settings = await loadSettings()
  if (settings.token?.trim()) return settings.token.trim()
  const token = generateToken()
  await patchSettings({ token })
  return token
}

async function showSetup() {
  hideAll()
  setupEl.classList.remove('hidden')
  fetchBtn.disabled = true

  // Generate and display token
  const token = await ensureToken()
  if (tokenDisplayEl) {
    tokenDisplayEl.textContent = token
  }
}

// Setup copy button handlers
if (copyInstallCmdBtn && installCmdEl) {
  copyInstallCmdBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(installCmdEl.textContent || '')
      copyInstallCmdBtn.textContent = 'Copied!'
      setTimeout(() => { copyInstallCmdBtn.textContent = 'Copy' }, 2000)
    } catch {
      copyInstallCmdBtn.textContent = 'Failed'
    }
  })
}

if (copyDaemonCmdBtn && daemonCmdEl) {
  copyDaemonCmdBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(daemonCmdEl.textContent || '')
      copyDaemonCmdBtn.textContent = 'Copied!'
      setTimeout(() => { copyDaemonCmdBtn.textContent = 'Copy' }, 2000)
    } catch {
      copyDaemonCmdBtn.textContent = 'Failed'
    }
  })
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
// YouTube transcript response type (matches youtube.content.ts)
type YouTubeTranscriptResponse =
  | {
      ok: true
      text: string
      segments: Array<{ startMs: number; endMs: number; text: string }>
      source: 'youtube-captions'
      durationSeconds: number | null
    }
  | { ok: false; error: string; reason: 'no_captions' | 'fetch_failed' | 'parse_failed' | 'extraction_error' | 'is_ad' | 'is_music' | 'not_english' }

// Return type includes special flags for various skip conditions
type ContentScriptExtractionResult =
  | { text: string; source: string }
  | { videoUrl: string; source: string }
  | { isAd: true; reason: string }
  | { skipSilent: true; reason: string }  // Silent skip - don't count or log (non-English)
  | { authRequired: true; reason: string }  // Instagram login required
  | { blocked: true; reason: string }  // Content blocked
  | null

async function tryContentScriptExtraction(
  tabId: number,
  platform: Platform
): Promise<ContentScriptExtractionResult> {
  if (platform === 'youtube') {
    console.log('[Transcript] Sending youtube-transcript message to content script...')
    const response = await tryContentScriptMessage<YouTubeTranscriptResponse>(
      tabId,
      'youtube-transcript',
      'content-scripts/youtube.js'
    )

    if (response === null) {
      console.log('[Transcript] YouTube content script did not respond (timeout or not injected)')
      createDiagnostic('ERR_CONTENT_SCRIPT_TIMEOUT', 'YouTube content script did not respond', `tabId: ${tabId}`)
    } else if (response.ok && response.text) {
      console.log('[Transcript] YouTube captions extracted successfully, length:', response.text.length)
      return { text: response.text, source: 'youtube-captions' }
    } else if (!response.ok) {
      // Check for skip reasons - ad, music, or non-English
      if (response.reason === 'is_ad') {
        console.log('[Transcript] YouTube video is an ad, skipping:', response.error)
        return { isAd: true, reason: response.error }
      }
      if (response.reason === 'is_music') {
        console.log('[Transcript] YouTube video is music, skipping:', response.error)
        return { isAd: true, reason: 'Music video - skipped' }
      }
      if (response.reason === 'not_english') {
        // Silent skip - don't log or count non-English videos
        return { skipSilent: true, reason: 'Non-English video' }
      }
      console.log('[Transcript] YouTube content script:', response.reason, '-', response.error)
      createDiagnostic('ERR_NO_CAPTIONS', `YouTube: ${response.reason}`, response.error)
    }
  }

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
      // Check for skip reasons - ad, music, or non-English
      if (response.reason === 'is_ad') {
        console.log('[Transcript] TikTok video is an ad, skipping:', response.error)
        return { isAd: true, reason: response.error }
      }
      if (response.reason === 'is_music') {
        console.log('[Transcript] TikTok video is music, skipping:', response.error)
        return { isAd: true, reason: 'Music video - skipped' }
      }
      if (response.reason === 'not_english') {
        // Silent skip - don't log or count non-English videos
        return { skipSilent: true, reason: 'Non-English video' }
      }
      // If no captions but we have a video URL, return it for Whisper fallback
      if (response.reason === 'no_captions' && response.videoUrl) {
        console.log('[Transcript] TikTok no captions, using video URL for Whisper:', response.videoUrl)
        return { videoUrl: response.videoUrl, source: 'tiktok-video' }
      }
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
      // Check if it's an ad - skip without error
      if (response.reason === 'is_ad') {
        console.log('[Transcript] Instagram content is an ad, skipping:', response.error)
        return { isAd: true, reason: response.error }
      }
      // Check for auth/blocked - these are terminal errors, don't fall through to daemon
      if (response.reason === 'auth_required') {
        console.log('[Transcript] Instagram requires authentication:', response.error)
        // Return a special marker that the caller can detect
        return { authRequired: true, reason: response.error } as unknown as ContentScriptExtractionResult
      }
      if (response.reason === 'blocked') {
        console.log('[Transcript] Instagram content is blocked:', response.error)
        return { blocked: true, reason: response.error } as unknown as ContentScriptExtractionResult
      }
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
    let needsWhisperFallback = false  // Track if we need to force Whisper mode
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

      // Check for terminal errors first (auth required, blocked)
      if (contentResult && 'authRequired' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('Login required to view this Instagram content. Please log in to Instagram and try again.')
        return
      }
      if (contentResult && 'blocked' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('This Instagram content is not available. ' + (contentResult.reason || 'It may have been deleted or made private.'))
        return
      }

      // Check for skip reasons that should stop manual fetch too
      if (contentResult && 'isAd' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('This video is an advertisement. Skipping.')
        return
      }
      if (contentResult && 'skipSilent' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('This video is not in English. Only English content is transcribed.')
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
        // Got video URL (Instagram/TikTok) - will send to daemon for transcription
        extractedVideoUrl = contentResult.videoUrl
        needsWhisperFallback = true
        setStatus('Video found, transcribing...')
        setProgress(30)
      } else {
        // Content script didn't get transcript, fall back to daemon with Whisper
        needsWhisperFallback = true  // No captions found, need Whisper
        setStatus('No captions found, transcribing audio...')
        setProgress(30)
      }
    }

    // For YouTube, also try content script extraction first
    if (platform === 'youtube' && tabId) {
      showLoading('Checking YouTube for captions...')
      setStatus('Extracting from page...')
      setProgress(20)

      const contentResult = await tryContentScriptExtraction(tabId, platform)

      if (isStale()) {
        clearTimeout(safetyTimeoutId)
        return
      }

      // Check for skip reasons that should stop manual fetch too
      if (contentResult && 'isAd' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('This video is an advertisement. Skipping.')
        return
      }
      if (contentResult && 'skipSilent' in contentResult) {
        clearTimeout(safetyTimeoutId)
        setProgress(0)
        showError('This video is not in English. Only English content is transcribed.')
        return
      }

      if (contentResult && 'text' in contentResult) {
        // Got captions directly from YouTube
        clearTimeout(safetyTimeoutId)
        setProgress(100)
        setStatus('Done')
        showTranscript(contentResult.text, platform, contentResult.source)
        return
      }

      // No YouTube captions, need Whisper fallback
      needsWhisperFallback = true
      setStatus('No captions found, transcribing audio...')
      setProgress(30)
    }

    // Check token before making daemon request
    if (!token) {
      clearTimeout(safetyTimeoutId)
      showSetup()
      return
    }

    // Show loading status for daemon request
    if (!needsWhisperFallback) {
      // Haven't checked for captions yet (shouldn't happen, but just in case)
      showLoading(`Fetching ${platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram'} transcript...`)
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
          // When no native captions are available, force Whisper transcription
          // This is critical - without this, daemon only tries to extract captions
          ...(needsWhisperFallback ? { videoMode: 'transcript' } : {}),
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
        transcriptSource?: string | null
        transcriptCharacters?: number | null
        transcriptLines?: number | null
      }
    }

    let jsonTimeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const jsonPromise = response.json()
      const timeoutPromise = new Promise<never>((_, reject) => {
        jsonTimeoutId = setTimeout(() => reject(new Error('JSON parsing timed out')), 15000)
      })
      data = await Promise.race([jsonPromise, timeoutPromise]) as typeof data
      console.log('[Transcript] JSON parsed successfully, ok:', data.ok)
    } catch (parseErr) {
      console.error('[Transcript] JSON parse error:', parseErr)
      throw new Error('Failed to parse daemon response: ' + (parseErr instanceof Error ? parseErr.message : 'unknown'))
    } finally {
      if (jsonTimeoutId) {
        clearTimeout(jsonTimeoutId)
      }
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
    const hasTranscript = Boolean(data.extracted?.transcriptSource)
      || (data.extracted?.transcriptCharacters ?? 0) > 0
      || (data.extracted?.transcriptLines ?? 0) > 0
      || Boolean(data.extracted?.transcriptTimedText)
    let transcriptText = data.extracted?.transcriptTimedText
      || (hasTranscript ? data.extracted?.content : null)

    if (transcriptText && transcriptText.trim().toLowerCase().startsWith('transcript:')) {
      transcriptText = transcriptText.replace(/^transcript:\s*/i, '')
    }
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

// Error reporting event listeners
copyErrorReportBtn?.addEventListener('click', copyCurrentErrorReport)
dismissErrorBtn?.addEventListener('click', hideAutoScrollError)
viewErrorHistoryBtn?.addEventListener('click', showErrorHistoryModal)

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
 * Includes content script injection fallback if not loaded.
 */
async function scrollToNextVideo(tabId: number, platform: Platform): Promise<boolean> {
  if (!platform) return false

  const messageType = `${platform}-scroll-next`
  const scriptFile = `content-scripts/${platform}.js`

  try {
    // First try with existing content script
    let response = await sendMessageWithTimeout<{ ok: boolean }>(
      tabId,
      { type: messageType },
      5000 // 5 second timeout for scroll
    )

    if (response === null) {
      // Content script might not be injected, try to inject it
      console.log(`[AutoScroll] Content script not responding for ${messageType}, injecting...`)
      if (await ensureContentScriptInjected(tabId, scriptFile)) {
        response = await sendMessageWithTimeout<{ ok: boolean }>(
          tabId,
          { type: messageType },
          5000
        )
      }
    }

    if (response?.ok) {
      console.log(`[AutoScroll] Scroll successful for ${platform}`)
      return true
    }

    console.log(`[AutoScroll] Scroll failed for ${platform}:`, response)
    return false
  } catch (err) {
    console.error(`[AutoScroll] Scroll error for ${platform}:`, err)
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

  // Clear any previous errors
  hideAutoScrollError()
  errorHistory.length = 0
  updateErrorHistorySummary()

  // Update UI
  hideAll()
  autoScrollContainerEl?.classList.remove('hidden')
  autoScrollBtn.disabled = true
  fetchBtn.disabled = true
  updateAutoScrollUI()

  const tabId = tab.id

  // Track video count for logging
  let videoCount = 0
  let failedCount = 0
  let consecutiveSilentSkips = 0
  const maxConsecutiveSilentSkips = 20  // Prevent infinite loop if all videos are non-English

  console.log(`[AutoScroll] Starting auto-scroll on ${platform}`)

  // Auto-scroll loop
  while (isAutoScrolling) {
    try {
      // Get transcript for current video first to check if we should count it
      const transcriptResult = await getTranscriptForCurrentVideo(tabId, platform, videoCount + 1)

      // Check for terminal errors that should stop auto-scroll
      if (transcriptResult && 'skip' in transcriptResult) {
        if (transcriptResult.skip === 'auth_required') {
          console.log('[AutoScroll] Instagram auth required, stopping:', transcriptResult.reason)
          autoScrollStatusEl.textContent = 'Stopped: Login required for Instagram'
          stopAutoScroll()
          break
        }
        if (transcriptResult.skip === 'blocked') {
          console.log('[AutoScroll] Content blocked, stopping:', transcriptResult.reason)
          autoScrollStatusEl.textContent = 'Stopped: Content not available'
          stopAutoScroll()
          break
        }
      }

      // Check for silent skip (e.g., non-English) - don't count or log, just move on
      if (transcriptResult && 'skip' in transcriptResult && transcriptResult.skip === 'silent') {
        consecutiveSilentSkips++

        // Guard against infinite loop
        if (consecutiveSilentSkips >= maxConsecutiveSilentSkips) {
          console.log(`[AutoScroll] Too many consecutive silent skips (${consecutiveSilentSkips}), stopping`)
          autoScrollStatusEl.textContent = 'Stopped: too many non-English videos in a row'
          stopAutoScroll()
          break
        }

        // Silently scroll to next without counting or updating UI
        await scrollToNextVideo(tabId, platform)
        await new Promise(resolve => setTimeout(resolve, 2500))  // Same as normal scroll delay
        continue
      }

      // Reset silent skip counter on successful processing
      consecutiveSilentSkips = 0

      // Now we know we're processing this video, so increment count
      videoCount++
      autoScrollStatusEl.textContent = `Processing video ${videoCount}...`
      console.log(`[AutoScroll] Processing video ${videoCount}`)

      // Check for other skip reasons (ad or no audio)
      if (transcriptResult && 'skip' in transcriptResult) {
        if (transcriptResult.skip === 'ad') {
          console.log(`[AutoScroll] Skipping ad video ${videoCount}: ${transcriptResult.reason}`)
          autoScrollStatusEl.textContent = `Video ${videoCount}: skipping ad...`
        } else if (transcriptResult.skip === 'no_audio') {
          console.log(`[AutoScroll] Skipping video ${videoCount} with no words: ${transcriptResult.reason}`)
          autoScrollStatusEl.textContent = `Video ${videoCount}: no words detected, skipping...`
        }
        // Brief delay to show status
        await new Promise(resolve => setTimeout(resolve, 500))
      } else if (transcriptResult && 'text' in transcriptResult && isAutoScrolling) {
        console.log(`[AutoScroll] Got transcript for video ${videoCount}, source: ${transcriptResult.source}`)

        // Check for duplicate transcript (scroll might have failed silently)
        const transcriptText = transcriptResult.text
        const isDuplicate = collectedTranscripts.some(t =>
          t.transcript === transcriptText ||
          (transcriptText.length > 50 && t.transcript.startsWith(transcriptText.slice(0, 50)))
        )

        if (isDuplicate) {
          console.log(`[AutoScroll] Duplicate transcript detected for video ${videoCount}, skipping`)
          autoScrollStatusEl.textContent = `Video ${videoCount}: duplicate detected, scrolling...`
          // Don't count this as a new video, scroll didn't work properly
          videoCount--
        } else {
          // Get metadata
          const metadata = await fetchVideoMetadata(tabId, platform)

          collectedTranscripts.push({
            platform: platform,
            transcript: transcriptText,
            metadata,
          })

          updateAutoScrollUI()
          addTranscriptToList(transcriptText, metadata)
          autoScrollStatusEl.textContent = `Collected ${collectedTranscripts.length} transcripts`
        }
      } else if (isAutoScrolling) {
        failedCount++
        console.log(`[AutoScroll] Failed to get transcript for video ${videoCount} (total failed: ${failedCount})`)
        autoScrollStatusEl.textContent = `Video ${videoCount}: transcription failed, moving on...`
        // Small delay to show status before scrolling
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      if (!isAutoScrolling) break

      // Scroll to next video
      autoScrollStatusEl.textContent = 'Scrolling to next video...'
      const scrolled = await scrollToNextVideo(tabId, platform)

      if (!scrolled) {
        console.log(`[AutoScroll] Scroll failed after video ${videoCount}`)
        const report = createAutoScrollError('CS_SCROLL_FAILED', 'CS_SCROLL', {
          videoIndex: videoCount,
          platform,
          tabId,
        })
        showAutoScrollError(report)
        autoScrollStatusEl.textContent = 'Reached end of feed or scroll failed'
        await new Promise(resolve => setTimeout(resolve, 2000))
        stopAutoScroll()
        break
      }

      // Wait for video to load
      await new Promise(resolve => setTimeout(resolve, 2500))

    } catch (err) {
      console.error('[AutoScroll] Error:', err)
      // Create a general error report for unexpected errors
      const errorCode = err instanceof Error ? classifyNetworkError(err) : 'DP_UNKNOWN_ERROR'
      const report = createAutoScrollError(errorCode, 'DAEMON_PROCESS', {
        videoIndex: videoCount,
        platform,
        tabId,
        stackTrace: err instanceof Error ? err.stack : String(err),
      })
      showAutoScrollError(report)
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
 * Check if hostname matches a domain (exact or subdomain).
 */
function hasHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Validate URL is safe to send to daemon (prevent SSRF).
 * Only allows https:// URLs from known video platforms.
 */
function isValidDaemonUrl(url: string, platform: Platform): boolean {
  if (!url || !platform) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // Must be http or https
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false
  }

  // Block http except for localhost
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    return false
  }

  const host = parsed.hostname.toLowerCase()

  // Validate host matches platform (using suffix matching to prevent false positives)
  switch (platform) {
    case 'youtube':
      return (
        hasHost(host, 'youtube.com') ||
        hasHost(host, 'youtu.be') ||
        hasHost(host, 'googlevideo.com') ||
        hasHost(host, 'youtube-nocookie.com')
      )
    case 'tiktok':
      return (
        hasHost(host, 'tiktok.com') ||
        hasHost(host, 'tiktokcdn.com') ||
        hasHost(host, 'tiktokcdn-us.com') ||
        hasHost(host, 'tiktokv.com')
      )
    case 'instagram':
      return (
        hasHost(host, 'instagram.com') ||
        hasHost(host, 'cdninstagram.com') ||
        hasHost(host, 'fbcdn.net') ||
        host === 'instagr.am' ||
        host === 'l.instagram.com'
      )
    default:
      return false
  }
}

/**
 * Normalize URL for better yt-dlp compatibility.
 * Converts YouTube Shorts URLs to standard watch?v= format.
 */
function normalizeUrlForDaemon(url: string, platform: Platform): string {
  try {
    const parsed = new URL(url)

    // Convert YouTube Shorts URLs to watch?v= format for better yt-dlp compatibility
    if (platform === 'youtube' && parsed.pathname.startsWith('/shorts/')) {
      const videoId = parsed.pathname.split('/')[2]
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`
      }
    }

    return url
  } catch {
    return url
  }
}

// Return type for getTranscriptForCurrentVideo - includes skip reasons
type TranscriptResult =
  | { text: string; source: string }
  | { skip: 'ad'; reason: string }
  | { skip: 'no_audio'; reason: string }
  | { skip: 'silent'; reason: string }  // Silent skip - don't count or log (e.g., non-English)
  | { skip: 'auth_required'; reason: string }  // Instagram login required - stop auto-scroll
  | { skip: 'blocked'; reason: string }  // Content blocked - stop auto-scroll
  | null

/**
 * Get transcript for the current video without full fetch flow.
 * Falls back to daemon (Whisper) when no native captions are available.
 * Uses comprehensive error reporting for debugging.
 */
async function getTranscriptForCurrentVideo(
  tabId: number,
  platform: Platform,
  videoIndex: number = 0
): Promise<TranscriptResult> {
  const startTime = Date.now()

  // Helper to calculate elapsed time
  const elapsed = () => Date.now() - startTime

  // Try content script extraction first (native captions)
  const contentResult = await tryContentScriptExtraction(tabId, platform)

  // Check if this is an ad - skip immediately
  // Use explicit === true check to avoid false positives if isAd property exists but is false
  if (contentResult && 'isAd' in contentResult && contentResult.isAd === true) {
    console.log('[AutoScroll] Skipping ad:', contentResult.reason)
    return { skip: 'ad', reason: contentResult.reason }
  }

  // Check if this should be silently skipped (e.g., non-English)
  // Use explicit === true check for safety
  if (contentResult && 'skipSilent' in contentResult && contentResult.skipSilent === true) {
    return { skip: 'silent', reason: contentResult.reason }
  }

  // Check for auth required (Instagram) - terminal error, stop auto-scroll
  if (contentResult && 'authRequired' in contentResult && contentResult.authRequired === true) {
    console.log('[AutoScroll] Instagram auth required:', contentResult.reason)
    return { skip: 'auth_required', reason: contentResult.reason }
  }

  // Check for blocked content - terminal error, stop auto-scroll
  if (contentResult && 'blocked' in contentResult && contentResult.blocked === true) {
    console.log('[AutoScroll] Content blocked:', contentResult.reason)
    return { skip: 'blocked', reason: contentResult.reason }
  }

  // Check if we got valid text (not empty/whitespace)
  if (contentResult && 'text' in contentResult && contentResult.text?.trim().length > 0) {
    // Clear any previous error on success
    hideAutoScrollError()
    return { text: contentResult.text, source: contentResult.source }
  }

  // Log that we're falling back (info level, not an error)
  const noCaptionsReport = createAutoScrollError('PF_NO_CAPTIONS', 'CS_EXTRACT', {
    videoIndex,
    platform,
    tabId,
    elapsedMs: elapsed(),
  })
  console.log('[AutoScroll] Info:', noCaptionsReport.message, '- using Whisper fallback')

  // Get token for daemon auth
  const settings = await loadSettings()
  const token = settings.token?.trim()
  if (!token) {
    const report = createAutoScrollError('EX_NO_TOKEN', 'INIT', {
      videoIndex,
      platform,
      tabId,
      elapsedMs: elapsed(),
    })
    showAutoScrollError(report)
    return null
  }

  // Determine the URL to send to daemon
  let urlForDaemon: string | null = null

  try {
    if (contentResult && 'videoUrl' in contentResult) {
      // Instagram: use the extracted CDN video URL
      urlForDaemon = contentResult.videoUrl
      console.log('[AutoScroll] Using Instagram video URL for daemon')
    } else {
      // YouTube/TikTok: use the page URL (daemon uses yt-dlp)
      const tab = await chrome.tabs.get(tabId)
      urlForDaemon = tab?.url || null
      console.log('[AutoScroll] Using page URL for daemon:', urlForDaemon?.slice(0, 60))
    }
  } catch (tabErr) {
    const report = createAutoScrollError('EX_TAB_CLOSED', 'URL_PARSE', {
      videoIndex,
      platform,
      tabId,
      elapsedMs: elapsed(),
      stackTrace: tabErr instanceof Error ? tabErr.stack : String(tabErr),
    })
    showAutoScrollError(report)
    return null
  }

  if (!urlForDaemon) {
    const report = createAutoScrollError('URL_MISSING', 'URL_PARSE', {
      videoIndex,
      platform,
      tabId,
      elapsedMs: elapsed(),
    })
    showAutoScrollError(report)
    return null
  }

  // Validate URL to prevent SSRF
  if (!isValidDaemonUrl(urlForDaemon, platform)) {
    const report = createAutoScrollError('URL_VALIDATION_FAILED', 'URL_PARSE', {
      videoIndex,
      platform,
      url: urlForDaemon,
      tabId,
      elapsedMs: elapsed(),
    })
    showAutoScrollError(report)
    return null
  }

  // Normalize URL for better yt-dlp compatibility (e.g., YouTube Shorts to watch?v=)
  const normalizedUrl = normalizeUrlForDaemon(urlForDaemon, platform)
  console.log('[AutoScroll] Normalized URL:', normalizedUrl.slice(0, 80))

  // Retry logic for transient failures
  const maxRetries = 1
  let lastError: Error | null = null
  let lastHttpStatus: number | undefined
  let lastResponseBody: string | undefined
  let lastDaemonError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[AutoScroll] Retrying daemon request (attempt ${attempt + 1}/${maxRetries + 1})`)
      // Exponential backoff: 2s for first retry
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
    }

    try {
      if (autoScrollStatusEl) {
        autoScrollStatusEl.textContent = attempt === 0
          ? 'Transcribing via Whisper...'
          : `Retrying transcription (${attempt + 1}/${maxRetries + 1})...`
      }

      const response = await fetchWithTimeout(
        'http://127.0.0.1:8787/v1/summarize',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: normalizedUrl,
            mode: 'url',
            extractOnly: true,
            timestamps: true,
            maxCharacters: null,
            // ALWAYS force transcript mode to ensure Whisper is used
            // This is critical - without this, the daemon may skip transcription
            videoMode: 'transcript',
            // Tell daemon to retry internally on transient failures
            retries: 1,
            // Daemon-side timeout (slightly less than client timeout)
            timeout: 110000,
          }),
          signal: autoScrollAbortController?.signal,
        },
        120000 // 120 second timeout for yt-dlp download + Whisper transcription
      )

      lastHttpStatus = response.status

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string }
        lastDaemonError = errorData.error
        lastResponseBody = JSON.stringify(errorData)
        console.log('[AutoScroll] Daemon error:', response.status, errorData.error)

        // Don't retry 4xx errors (bad URL, unauthorized, etc.)
        if (response.status >= 400 && response.status < 500) {
          const errorCode = classifyDaemonError(errorData.error, response.status)
          const report = createAutoScrollError(errorCode, 'DAEMON_REQUEST', {
            videoIndex,
            platform,
            url: urlForDaemon,
            normalizedUrl,
            tabId,
            attemptNumber: attempt + 1,
            maxAttempts: maxRetries + 1,
            elapsedMs: elapsed(),
            httpStatus: response.status,
            responseBody: lastResponseBody,
            daemonError: errorData.error,
          })
          showAutoScrollError(report)
          return null
        }

        // Retry on 5xx errors
        lastError = new Error(`HTTP ${response.status}: ${errorData.error || 'Server error'}`)
        continue
      }

      // Parse JSON with fallback for malformed responses
      let data: {
        ok?: boolean
        error?: string
        extracted?: {
          content?: string
          transcriptTimedText?: string
          transcriptSource?: string | null
        }
      }

      try {
        data = await response.json()
      } catch (parseErr) {
        console.log('[AutoScroll] Failed to parse daemon response as JSON:', parseErr)
        lastError = new Error('Failed to parse daemon response')
        const report = createAutoScrollError('DP_PARSE_ERROR', 'RESPONSE_PARSE', {
          videoIndex,
          platform,
          url: urlForDaemon,
          normalizedUrl,
          tabId,
          attemptNumber: attempt + 1,
          maxAttempts: maxRetries + 1,
          elapsedMs: elapsed(),
          httpStatus: response.status,
          stackTrace: parseErr instanceof Error ? parseErr.stack : undefined,
        })
        // Only show error on last attempt
        if (attempt === maxRetries) {
          showAutoScrollError(report)
        }
        continue
      }

      if (!data.ok) {
        console.log('[AutoScroll] Daemon returned error:', data.error)
        lastDaemonError = data.error

        // Some daemon errors are retryable
        if (data.error?.includes('timeout') || data.error?.includes('network')) {
          lastError = new Error(data.error)
          continue
        }

        // Non-retryable daemon error
        const errorCode = classifyDaemonError(data.error, undefined)
        const report = createAutoScrollError(errorCode, 'DAEMON_PROCESS', {
          videoIndex,
          platform,
          url: urlForDaemon,
          normalizedUrl,
          tabId,
          attemptNumber: attempt + 1,
          maxAttempts: maxRetries + 1,
          elapsedMs: elapsed(),
          daemonError: data.error,
        })
        showAutoScrollError(report)
        return null
      }

      // Extract transcript text
      let transcriptText = data.extracted?.transcriptTimedText || data.extracted?.content

      if (!transcriptText || transcriptText.trim().length === 0) {
        console.log('[AutoScroll] Daemon returned empty transcript - no words in video, skipping')
        // Don't show error for empty transcripts (e.g., music-only videos)
        // Just skip to next video silently
        return { skip: 'no_audio', reason: 'No spoken words detected in video (may be music-only)' }
      }

      // Clean up transcript prefix if present
      if (transcriptText.trim().toLowerCase().startsWith('transcript:')) {
        transcriptText = transcriptText.replace(/^transcript:\s*/i, '')
      }

      // Remove timestamps from timed text
      if (transcriptText.includes('[')) {
        transcriptText = transcriptText
          .replace(/\[\d{1,3}:\d{2}(?::\d{2})?\]\s*/g, '')
          .replace(/\n+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
      }

      const source = data.extracted?.transcriptSource || 'whisper'
      console.log('[AutoScroll] Daemon transcription successful, source:', source, 'length:', transcriptText.length)

      // Clear any previous error on success
      hideAutoScrollError()
      return { text: transcriptText.trim(), source }

    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.log('[AutoScroll] Daemon request aborted')
        return null
      }

      console.error('[AutoScroll] Daemon request failed:', err)
      lastError = err instanceof Error ? err : new Error(String(err))

      // Classify and potentially show network error
      const errorCode = classifyNetworkError(lastError)

      // Network errors are retryable
      if (err instanceof Error && (err.message.includes('timeout') || err.message.includes('network') || err.message.includes('fetch'))) {
        // Only show error on last attempt
        if (attempt === maxRetries) {
          const report = createAutoScrollError(errorCode, 'DAEMON_REQUEST', {
            videoIndex,
            platform,
            url: urlForDaemon,
            normalizedUrl,
            tabId,
            attemptNumber: attempt + 1,
            maxAttempts: maxRetries + 1,
            elapsedMs: elapsed(),
            stackTrace: lastError.stack,
          })
          showAutoScrollError(report)
        }
        continue
      }

      // Other errors - don't retry, show immediately
      const report = createAutoScrollError(errorCode, 'DAEMON_REQUEST', {
        videoIndex,
        platform,
        url: urlForDaemon,
        normalizedUrl,
        tabId,
        attemptNumber: attempt + 1,
        maxAttempts: maxRetries + 1,
        elapsedMs: elapsed(),
        stackTrace: lastError.stack,
      })
      showAutoScrollError(report)
      break
    } finally {
      // Reset status on completion/error (only on last attempt or success)
      if (autoScrollStatusEl && isAutoScrolling && (attempt === maxRetries || !lastError)) {
        autoScrollStatusEl.textContent = 'Processing...'
      }
    }
  }

  // All retries exhausted - show final error if not already shown
  if (lastError && !currentAutoScrollError) {
    const errorCode = classifyNetworkError(lastError)
    const report = createAutoScrollError(errorCode, 'DAEMON_REQUEST', {
      videoIndex,
      platform,
      url: urlForDaemon,
      normalizedUrl,
      tabId,
      attemptNumber: maxRetries + 1,
      maxAttempts: maxRetries + 1,
      elapsedMs: elapsed(),
      httpStatus: lastHttpStatus,
      responseBody: lastResponseBody,
      daemonError: lastDaemonError,
      stackTrace: lastError.stack,
    })
    showAutoScrollError(report)
  }

  console.log('[AutoScroll] All retries exhausted, last error:', lastError?.message)
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
