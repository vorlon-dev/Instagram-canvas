# Instagram Video Scraper API

Scrape instagram videos with no login required using puppeteer and express.

## Description

This is a powerful Instagram video scraper built using Express.js and Puppeteer. It allows you to extract video URL's from Instagram posts/reels with ease. Whether you want to create a personal video collection or analyze content for research, this tool makes the process straightforward.

## Getting Started

Clone the repository

```bash
git clone https://github.com/riad-azz/instagram-video-scraper.git
```

Install dependencies

```bash
cd instagram-video-scraper && npm install
```

Running the server

```bash
# Development
npm run dev

# Production
npm start
```

> The `start` script is Linux-safe (plain `node ./src/bin/www`), so it deploys
> cleanly on Linux serverless platforms. `NODE_ENV` defaults to `production`.

### How it resolves videos

1. **Keyless embed resolve (primary, no browser needed):** fetches the public
   `instagram.com/reel/{id}/embed/captioned/` page with a desktop Chrome UA
   and extracts the CDN `video_url`. Verified to work from datacenter IPs.
2. **Headless Chromium (fallback):** the original puppeteer scrape, used only
   if the embed page contains no video URL.
3. Every successful resolve is cached in memory for 1 hour per post.

### Environment variables (all optional)

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (defaults to `3000`). |
| `IG_COOKIE` | Raw cookie header (e.g. `sessionid=...; ds_user_id=...`) used when Instagram login-walls anonymous scraping. |

## API Endpoints

- `GET /`: Health check, returns `{ "status": "ok" }`.
- `GET /api/diag[?launch=1]`: Environment diagnostics (node version, Chromium presence, optional real launch test).
- `GET /api/video?url={POST_URL}`: Resolves the direct video URL of an Instagram Post/Reel, returns `{ "videoUrl": "...", "source": "embed" }`.
- `GET /api/stream?url={POST_URL}`: Resolves the post, then proxies the video bytes through this server with `Range` support - use when the client cannot play the CDN URL directly.
## Optional: Obscura stealth browser (recommended)

Put the single static binary at `bin/obscura` (or let the service auto-download it on boot - enabled by default) and the service gains:

- **JS-challenge-proof engine search**: a challenged Bing/DuckDuckGo response is transparently re-fetched through Obscura's stealth render (real Chrome-145 fingerprint, TLS impersonation).
- **A working browser fallback without Chromium**: the embed-failure fallback connects to `obscura --stealth serve --port 9222` via puppeteer.connect, so it deploys on VMs where Chromium cannot.

Env knobs: `OBSCURA_ENABLED`, `OBSCURA_PATH`, `OBSCURA_DIR`, `OBSCURA_AUTO_DOWNLOAD`, `OBSCURA_PORT`, `OBSCURA_VERSION`. Check `/api/diag` (`obscura` block) and `/api/diag?obscura=1` (starts + verifies the CDP server).

- `GET /api/search?q={QUERY}&limit=12`: Keyless web-engine reel discovery (Bing + DuckDuckGo in parallel, wrapped links decoded, 30-min per-query cache). Returns `{ query, count, results: [{ code, text, isReel }] }`. Used by the app's per-song canvas search; scoring happens app-side.

## Examples

### Request Example

```javascript
const fetch = require('node-fetch');

const postUrl = 'https://www.instagram.com/p/{shortcode}/';
const apiUrl = `http://localhost:3000/api/video?url=${postUrl}`;

fetch(apiUrl)
  .then(response => response.json())
  .then(data => {
    // Handle the scraped data here
    mp4Url = data.videoUrl;
    console.log(mp4Url);
  })
  .catch(error => {
    console.error(error);
  });
```

### Response Example

```json
{
  "videoUrl": "https://scontent.cdninstagram.com/v/t50.2886-16/385047357_643...mp4?...",
}
```

## License

This Instagram Video Scraper is licensed under the MIT License - see the LICENSE file for details.
