# Transcript Providers - Future Work

## Current Status (2026-01-19)

### YouTube Shorts
- **Status:** Working
- Native captions (youtubei/captionTracks) work for most videos
- yt-dlp + whisper.cpp fallback works with `--cookies-from-browser chrome`

### TikTok
- **Status:** Partially Working (via content script)
- **Content Script (NEW):** Extracts native captions directly from page when available
  - File: `apps/chrome-extension/src/entrypoints/tiktok.content.ts`
  - Extracts from `__UNIVERSAL_DATA_FOR_REHYDRATION__` in page context
  - Fetches WebVTT captions without IP blocking
- **Server-side (blocked):** IP blocked, yt-dlp fallback doesn't work
- ~60-70% of TikTok videos have native captions

### Instagram Reels
- **Status:** In Progress - Content Script + CDN URL Pass-through
- **Content Script:** Extracts video URL from page
  - File: `apps/chrome-extension/src/entrypoints/instagram.content.ts`
  - Gets video src from `<video>` element or `og:video` meta tag
- **CDN URL Pass-through:** If content script finds an Instagram CDN URL (https://scontent-*.cdninstagram.com/...),
  it's passed to the daemon for direct transcription
- **Limitation:** Instagram has no native captions, requires Whisper transcription
- **Server-side (blocked):** yt-dlp returns empty response even with cookies
- **Needs Testing:** Does the CDN URL approach work? Does the generic provider handle video URLs?

---

## What Was Implemented

### Content Scripts (Chrome Extension)
1. **TikTok Content Script** (`apps/chrome-extension/src/entrypoints/tiktok.content.ts`)
   - Extracts native captions from page's hydration data
   - Fetches and parses WebVTT captions
   - Works when user has the TikTok page open
   - Bypasses IP blocking since it runs in user's browser context

2. **Instagram Content Script** (`apps/chrome-extension/src/entrypoints/instagram.content.ts`)
   - Extracts video URL from authenticated page
   - Can capture video blob from page
   - Ready for future enhancement to send video for transcription

3. **Sidepanel Integration** (`apps/chrome-extension/src/entrypoints/sidepanel/transcript-main.ts`)
   - Tries content script extraction first for TikTok/Instagram
   - Falls back to daemon if content script fails
   - Progress indicators for multi-step extraction
   - Dynamic content script injection if scripts aren't loaded

4. **URL Pattern Improvements**
   - YouTube: Added support for `/live/`, `/embed/`, `/v/`, `youtu.be`, and `m.youtube.com`
   - TikTok: Added support for `m.tiktok.com` mobile URLs
   - Instagram: Added support for `/tv/` (IGTV) and `/p/` (posts with videos)

### Browser Cookies for yt-dlp
- YouTube and Instagram providers now use `--cookies-from-browser chrome` by default
- Helps with bot detection on YouTube
- Can be disabled via environment variables

---

## Future Improvements Needed

### Priority 1: Instagram Audio Transcription via Content Script
The Instagram content script extracts video URLs but can't transcribe without Whisper.
Options:
- **Send video URL to daemon** for transcription (if URL is accessible)
- **Download video blob in content script**, convert to base64, send to daemon
- **Use Web Audio API** to capture audio stream and send for transcription

### Priority 2: TikTok Fallback for Videos Without Captions
~30-40% of TikTok videos don't have native captions. Options:
- Same approach as Instagram: extract video URL/blob for daemon transcription
- Enhance content script to also extract video for Whisper fallback

### 3. Browser Automation for TikTok/Instagram (Alternative Approach)
Both platforms actively block server-side requests. Options:

**Option A: Puppeteer/Playwright Integration**
- Launch headless browser to fetch page HTML
- Extract native captions from rendered page
- More reliable than direct HTTP requests
- Heavier dependency, slower

**Option B: Browser Extension Content Script**
- Have Chrome extension inject content script into TikTok/Instagram pages
- Extract transcript data directly from the page's JavaScript context
- Faster, no extra dependencies
- Only works when user has the page open

### 2. Proxy Support for yt-dlp
- Add `--proxy` flag support to yt-dlp calls
- Allow users to configure residential proxy in daemon.json
- Would help bypass IP blocks on TikTok

### 3. TikTok API Authentication
- TikTok has an official API for some use cases
- Investigate if transcript/caption data is accessible via API
- Would require user authentication flow

### 4. Instagram Graph API
- Instagram's official API may provide video data
- Requires Facebook developer account and app approval
- Limited to business/creator accounts

### 5. Alternative Caption Sources

**For TikTok:**
- Some third-party services scrape TikTok captions
- Could integrate as fallback (e.g., tikwm.com, ssstik.io)
- Reliability and terms of service concerns

**For Instagram:**
- Similar third-party scrapers exist
- Same reliability concerns

### 6. Browser Cookie Export
Current `--cookies-from-browser chrome` requires:
- Chrome to be installed
- User to be logged into the platform
- Chrome not running (can't access cookies while Chrome is open on some systems)

Alternative approach:
- Add manual cookie file support (`--cookies cookies.txt`)
- Provide instructions for exporting cookies via browser extension
- More portable across systems

---

## Files Reference

```
packages/core/src/content/transcript/providers/
├── youtube.ts          # YouTube provider (working)
├── youtube/
│   ├── api.ts          # youtubei transcript endpoint
│   ├── captions.ts     # captionTracks extraction
│   └── yt-dlp.ts       # Audio download + whisper fallback
├── tiktok.ts           # TikTok provider (blocked)
├── tiktok/
│   ├── captions.ts     # Native caption extraction (blocked)
│   └── yt-dlp.ts       # Audio fallback (IP blocked)
├── instagram.ts        # Instagram provider (blocked)
└── instagram/
    └── yt-dlp.ts       # Audio transcription (API blocked)
```

## Environment Variables

```bash
# Disable browser cookies for yt-dlp (if causing issues)
YOUTUBE_COOKIES_FROM_BROWSER=none
INSTAGRAM_COOKIES_FROM_BROWSER=none

# Or specify different browser
YOUTUBE_COOKIES_FROM_BROWSER=firefox
INSTAGRAM_COOKIES_FROM_BROWSER=safari
```
