const express = require('express');
const https = require('https');
const puppeteer = require('puppeteer');
const asyncHandler = require('express-async-handler')

const { getPostId, getVideoUrl } = require('../lib/utils');
const { resolveViaEmbed, BROWSER_UA } = require('../lib/ig_client');
const { searchReels } = require('../lib/engine_search');
const { ensureObscuraServe } = require('../lib/obscura_client');
const { handleBlockedResources } = require('../lib/scraper');
const { CustomError } = require('../lib/errors');

const router = express.Router();

// Optional: paste "sessionid=...; ds_user_id=...; ..." style cookies into the
// IG_COOKIE environment variable if Instagram login-walls anonymous requests.
function optionalCookieList() {
  const raw = process.env.IG_COOKIE;
  if (!raw) {
    return [];
  }

  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq > 0 ? { name: pair.slice(0, eq), value: pair.slice(eq + 1) } : null;
    })
    .filter(Boolean);
}

// Headless-browser fallback (only used when the keyless embed resolve fails).
//
// Browser selection: Obscura first (single static Rust binary with stealth
// mode - installs on tiny VMs where Chromium cannot), full Chromium via
// puppeteer.launch() only when Obscura is unavailable.
async function resolveViaBrowser(req, postId) {
  const { scraper } = req;

  const obscuraUrl = await ensureObscuraServe();
  const usingObscura = Boolean(obscuraUrl);
  const browser = usingObscura
    ? await puppeteer.connect({
        browserURL: obscuraUrl,
        defaultViewport: { width: 1280, height: 800 },
      })
    : await scraper.ensureBrowser();

  let html;
  let currentPage;
  try {
    const postUrl = `https://www.instagram.com/p/${postId}/`;
    // Open new browser tab
    currentPage = await browser.newPage();
    // A real-looking UA plus optional session cookies drastically reduce
    // Instagram's anonymous login walls. (Obscura already fingerprints a
    // real Chrome; setUserAgent keeps parity with the Chromium path.)
    await currentPage.setUserAgent(BROWSER_UA);
    const cookies = optionalCookieList();
    if (cookies.length > 0) {
      try {
        await currentPage.setCookie(...cookies);
      } catch (cookieError) {
        console.log('Ignoring invalid IG_COOKIE:', cookieError.message); // eslint-disable-line no-console
      }
    }
    // Intercept and block certain resource types for better performance
    await currentPage.setRequestInterception(true);
    currentPage.on("request", handleBlockedResources);
    // Load post page. networkidle0 is Chromium-specific; Obscura gets a
    // domcontentloaded + fixed settle window instead.
    scraper.addActivePost(postId);
    if (usingObscura) {
      await currentPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      await currentPage.goto(postUrl, { waitUntil: 'networkidle0', timeout: 25000 });
    }
    html = await currentPage.content();
  } finally {
    scraper.removeActivePost(postId);
    if (currentPage) {
      try {
        await currentPage.close();
      } catch (closeError) {
        // Tab cleanup must never mask the real error.
      }
    }
    if (usingObscura) {
      try {
        await browser.disconnect(); // Obscura serve stays up for next time
      } catch (_) { /* ignore */ }
    }
  }

  // Parse page HTML
  return getVideoUrl(html);
}

// Resolve an Instagram post/reel URL to { videoUrl, source } (cached per post).
// Chain: keyless embed page (no browser needed) -> headless Chromium fallback.
async function resolveVideoPost(req, inputUrl) {
  const { scraper } = req;

  const postId = getPostId(inputUrl);

  // Check if cached response exists
  const cachedResponse = await scraper.isAlreadyProcessed(postId)
  if (cachedResponse) {
    return cachedResponse;
  }

  const failures = [];

  // Attempt 1: keyless embed page - plain HTTPS, no Chromium required.
  try {
    const videoUrl = await resolveViaEmbed(postId);
    const response = { videoUrl, source: 'embed' };
    scraper.setCache(postId, response);
    return response;
  } catch (embedError) {
    failures.push(`embed: ${embedError.message}`);
  }

  // Attempt 2: headless Chromium scrape (requires a working browser install).
  try {
    const videoUrl = await resolveViaBrowser(req, postId);
    const response = { videoUrl, source: 'browser' };
    scraper.setCache(postId, response);
    return response;
  } catch (browserError) {
    failures.push(`browser: ${browserError.message}`);
  }

  throw new CustomError(`Could not resolve video (${failures.join('; ')})`, 502);
}

// Pipe the resolved CDN video through this server, forwarding Range requests,
// so the client can play it even when the CDN URL is locked to the server IP.
function fetchUpstream(targetUrl, requestHeaders, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const request = https.get(targetUrl, { headers: requestHeaders }, (upstream) => {
      if (
        upstream.statusCode >= 300 &&
        upstream.statusCode < 400 &&
        upstream.headers.location &&
        redirectsLeft > 0
      ) {
        upstream.resume();
        const nextUrl = new URL(upstream.headers.location, targetUrl).toString();
        resolve(fetchUpstream(nextUrl, requestHeaders, redirectsLeft - 1));
        return;
      }
      resolve(upstream);
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new CustomError('Upstream video timed out', 504)));
  });
}

router.get('/video', asyncHandler(async (req, res) => {
  const response = await resolveVideoPost(req, req.query.url);
  return res.status(200).json(response);

}));


// GET /api/search?q={engine query}&limit=12
//
// Keyless reel discovery used by the app's canvas feature. The app builds
// per-song queries (site:instagram.com/reel "<song> <artist> edit" etc.);
// this endpoint runs each one across Bing / DuckDuckGo in parallel from the
// server's IP and returns candidate post shortcodes with nearby result
// text. Scoring vs the song happens app-side. Fail-soft: when every engine
// fails or finds nothing, an empty results list is returned (the app falls
// back to its own on-device engines).
router.get('/search', asyncHandler(async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  if (query.length < 3 || query.length > 300) {
    throw new CustomError('Provide a search query q (3-300 characters)', 400);
  }

  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 30)
    : 12;

  const results = await searchReels(query);
  return res.status(200).json({
    query,
    count: results.length,
    results: results.slice(0, limit),
  });
}));


router.get('/stream', asyncHandler(async (req, res, next) => {
  const { videoUrl } = await resolveVideoPost(req, req.query.url);

  const requestHeaders = { 'User-Agent': BROWSER_UA };
  if (req.headers.range) {
    requestHeaders.Range = req.headers.range;
  }

  let upstream;
  try {
    upstream = await fetchUpstream(videoUrl, requestHeaders, 3);
  } catch (error) {
    return next(error);
  }

  if (upstream.statusCode >= 400) {
    upstream.resume();
    return next(new CustomError(`Upstream video request failed (${upstream.statusCode})`, 502));
  }

  res.writeHead(upstream.statusCode, {
    'content-type': upstream.headers['content-type'] || 'video/mp4',
    'accept-ranges': upstream.headers['accept-ranges'] || 'bytes',
    'cache-control': 'public, max-age=3600',
    ...(upstream.headers['content-length'] ? { 'content-length': upstream.headers['content-length'] } : {}),
    ...(upstream.headers['content-range'] ? { 'content-range': upstream.headers['content-range'] } : {}),
  });
  upstream.pipe(res);
  res.on('close', () => upstream.destroy());

}));


module.exports = router;
