# Transcript Providers - Future Work

## Current Status (2026-01-19)

### YouTube Shorts
- **Status:** Working
- Native captions (youtubei/captionTracks) work for most videos
- yt-dlp + whisper.cpp fallback works with `--cookies-from-browser chrome`

### TikTok
- **Status:** Blocked by IP
- Server-side HTML fetch returns empty (can't extract native captions)
- yt-dlp returns "Your IP address is blocked from accessing this post"
- Native caption extraction code exists in `tiktok/captions.ts` but can't reach TikTok servers

### Instagram Reels
- **Status:** Blocked by API changes
- yt-dlp returns "Instagram sent an empty media response" even with cookies
- Known ongoing issue with yt-dlp and Instagram's API

---

## Future Improvements Needed

### 1. Browser Automation for TikTok/Instagram
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
