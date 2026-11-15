const https = require('https');
const { CustomError } = require('./errors');

// A generic desktop Chrome user agent (puppeteer's default advertises
// "HeadlessChrome", which Instagram is quick to login-wall).
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

// Optional: paste "sessionid=...; ds_user_id=...; ..." style cookies into the
// IG_COOKIE environment variable if Instagram login-walls anonymous requests.
function optionalCookieHeader() {
  const raw = process.env.IG_COOKIE;
  if (!raw) {
    return null;
  }
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .join('; ');
}

// Minimal keyless HTTPS GET with redirect following and a body size cap.
function httpGet(targetUrl, headers, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(targetUrl, { headers }, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location &&
        redirectsLeft > 0
      ) {
        response.resume();
        const nextUrl = new URL(response.headers.location, targetUrl).toString();
        resolve(httpGet(nextUrl, headers, redirectsLeft - 1));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) {
          chunks.push(chunk);
        } else {
          response.destroy();
        }
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new CustomError('Instagram request timed out', 504));
    });
  });
}

// Decode \uXXXX escapes, then drop remaining backslash artifacts from any
// JSON escaping depth (Instagram serves the same URL at 1-3 escape levels).
function decodeEscapedString(value) {
  const decoded = value.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return decoded.replace(/\\/g, '');
}

// Pull the direct CDN video URL out of an Instagram embed page. The embed
// payload embeds the media JSON at variable escaping depths, so extraction
// is position-based instead of pattern-greedy.
function extractVideoUrl(html) {
  const candidates = [];

  // Strategy 1 (proven): "video_url" / "playable_url" keys in embedded JSON.
  for (const key of ['video_url', 'playable_url', 'videoUrl']) {
    let searchFrom = 0;
    for (let guard = 0; guard < 5; guard += 1) {
      const keyIndex = html.indexOf(key, searchFrom);
      if (keyIndex === -1) {
        break;
      }
      searchFrom = keyIndex + key.length;
      const httpIndex = html.indexOf('http', keyIndex);
      if (httpIndex === -1 || httpIndex > keyIndex + key.length + 40) {
        continue;
      }
      let endIndex = html.indexOf('"', httpIndex);
      if (endIndex === -1) {
        endIndex = Math.min(html.length, httpIndex + 2000);
      }
      const url = decodeEscapedString(html.slice(httpIndex, endIndex)).trim();
      if (url.startsWith('http') && url.length > 40) {
        candidates.push(url);
        break;
      }
    }
  }

  // Strategy 2: any .mp4 URL with its query string, any escape depth.
  const mp4Regex = /https:[^"']{10,2500}?\.mp4[^"']*/g;
  let mp4Match;
  while ((mp4Match = mp4Regex.exec(html)) !== null) {
    const url = decodeEscapedString(mp4Match[0]).trim();
    if (url.startsWith('http') && url.length > 40) {
      candidates.push(url);
    }
    if (candidates.length > 4) {
      break;
    }
  }

  // Strategy 3: <video src="..."> rendered tag.
  const tagMatch = html.match(/<video[^>]+src="([^"]+)"/);
  if (tagMatch) {
    candidates.push(tagMatch[1]);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate.startsWith('http') && !seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
  return null;
}

// Keyless resolution via the public embed page (no browser, no login).
// Verified working from datacenter IPs with plain HTTPS GET.
async function resolveViaEmbed(postId) {
  const headers = {
    'user-agent': BROWSER_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'upgrade-insecure-requests': '1',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
  };
  const cookie = optionalCookieHeader();
  if (cookie) {
    headers.cookie = cookie;
  }

  const embedUrls = [
    `https://www.instagram.com/reel/${postId}/embed/captioned/`,
    `https://www.instagram.com/p/${postId}/embed/captioned/`,
  ];

  let lastError = 'embed page unavailable';
  for (const embedUrl of embedUrls) {
    try {
      const response = await httpGet(embedUrl, headers);
      if (response.statusCode !== 200) {
        lastError = `embed HTTP ${response.statusCode}`;
        continue;
      }
      const videoUrl = extractVideoUrl(response.body);
      if (videoUrl) {
        return videoUrl;
      }
      lastError = 'embed page contained no video URL';
    } catch (error) {
      lastError = error && error.message ? error.message : 'embed request failed';
    }
  }

  throw new CustomError(`Embed resolve failed: ${lastError}`, 502);
}

module.exports = {
  BROWSER_UA,
  extractVideoUrl,
  httpGet,
  resolveViaEmbed,
};
