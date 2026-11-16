// Keyless web-engine reel discovery for GET /api/search.
//
// The app asks this endpoint with a per-song engine query (e.g.
// `site:instagram.com/reel "High On You Arijit Singh" edit`). This module
// runs the query across Bing / DuckDuckGo (html + lite) IN PARALLEL from
// the server's own IP (usually far cleaner than a phone's), decodes both
// direct and engine-wrapped result links, and returns reel/post shortcodes
// with nearby result text. Scoring happens app-side (the app knows the
// song). Fully fail-soft: engines that fail just yield fewer candidates;
// when every engine fails an empty list is returned so the app falls back
// to its own on-device engines.

const { httpGet, BROWSER_UA } = require('./ig_client');
const { fetchHtmlViaCli, obscuraBinaryPresent } = require('./obscura_client');

// A browser-like mobile UA — engines are friendlier to it than to defaults.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; Redmi Note 9) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// URL of any Instagram post kind, capturing the code.
const POST_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]{5,25})/g;
// Bing result links look like  .../ck/a?!&amp;&amp;p=...&amp;u=a1aHR0cHM6...
// In the HTML the ampersands are ENTITIES (&amp;), so the old /&u=a1.../
// never matched and every Bing page yielded zero links.
const BING_WRAP_RE = /[?&;]u=a1([A-Za-z0-9_\-%]{20,})/g;
// The visible <cite> breadcrumb:  instagram.com › reel › DfuUTROyNNV
const CITE_RE =
  /instagram\.com\s*(?:›|&rsaquo;|&#8250;|&#x203A;|&gt;)\s*(reels?|p)\s*(?:›|&rsaquo;|&#8250;|&#x203A;|&gt;)\s*([A-Za-z0-9_-]{5,25})/gi;
const DDG_WRAP_RE = /uddg=([A-Za-z0-9_%\-.]{10,400})/g;
const GOOGLE_WRAP_RE = /\/url\?q=([^&"'\s]{10,400})/g;

const ENGINES = [
  {
    name: 'bing',
    url: (q) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&mkt=en-US&setlang=en`,
    headers: {
      'User-Agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie: 'SRCHHPGUSR=SRCHLANG=en',
    },
  },
  {
    name: 'ddg-html',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    headers: {
      'User-Agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  },
  {
    // Mojeek runs its own index and is far friendlier to datacenter IPs
    // than Bing / DDG; supports the site: operator and returns plain
    // direct result links.
    name: 'mojeek',
    url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
    headers: {
      'User-Agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  },
  {
    name: 'brave',
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    headers: {
      'User-Agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  },
  {
    name: 'ddg-lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    headers: {
      'User-Agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  },
];

// 30-minute cache per query — the app asks the same per-song queries on
// every replay, so this keeps the service light.
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
// An EMPTY answer is almost always a blocked / challenged engine, not "no
// reel exists" - caching it for 30 minutes made every later request for the
// same song return nothing instantly. Empty answers are kept 45 s only.
const EMPTY_CACHE_TTL_MS = 45 * 1000;
const searchCache = new Map(); // query -> { at, results }
const inflight = new Map(); // query -> Promise (same query shares one run)

function b64urlDecode(raw) {
  let s = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function decodeURIComponentSafe(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function cleanText(raw) {
  const noTags = raw.replace(/<[^>]{1,200}>/g, ' ');
  return noTags
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextText(body, index, radius = 400) {
  const from = Math.max(0, index - radius);
  const to = Math.min(body.length, index + radius);
  return body.slice(from, to);
}

// Extract candidate shortcodes + nearby text from one engine page.
// Returns Map<code, { text, isReel }>.
function collectCandidates(body) {
  const out = new Map();
  const spots = [];

  for (const m of body.matchAll(POST_URL_RE)) {
    spots.push(contextText(body, m.index));
  }
  for (const m of body.matchAll(BING_WRAP_RE)) {
    const decoded = b64urlDecode(m[1]);
    if (!/(reel|reels|p)\/[A-Za-z0-9_-]{5,25}/.test(decoded)) continue;
    spots.push(`${decoded} ${contextText(body, m.index)}`);
  }
  for (const m of body.matchAll(DDG_WRAP_RE)) {
    const decoded = decodeURIComponentSafe(m[1]);
    if (!/(reel|reels|p)\/[A-Za-z0-9_-]{5,25}/.test(decoded)) continue;
    spots.push(`${decoded} ${contextText(body, m.index)}`);
  }
  for (const m of body.matchAll(CITE_RE)) {
    spots.push(`https://www.instagram.com/${m[1]}/${m[2]} ${contextText(body, m.index)}`);
  }
  for (const m of body.matchAll(GOOGLE_WRAP_RE)) {
    const decoded = decodeURIComponentSafe(m[1]);
    if (!/(reel|reels|p)\/[A-Za-z0-9_-]{5,25}/.test(decoded)) continue;
    spots.push(`${decoded} ${contextText(body, m.index)}`);
  }

  for (const spot of spots) {
    POST_URL_RE.lastIndex = 0;
    const m = POST_URL_RE.exec(spot) ||
      /instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]{5,25})/.exec(spot);
    if (!m) continue;
    const isReel = m[1].toLowerCase().startsWith('reel');
    const code = m[2];
    if (code.length < 5) continue;

    // Strip the URL itself so the shortcode's base36 noise never lands in
    // the scoring text the app sees.
    const text = cleanText(
      spot
        .replace(
          /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_-]{5,25}/g,
          ' '
        )
        .replace(/instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_-]{5,25}/g, ' ')
    );

    const existing = out.get(code);
    if (!existing) {
      out.set(code, { text, isReel });
    } else {
      // Prefer reel-kind sightings and the richest text for scoring.
      existing.isReel = existing.isReel || isReel;
      if (text.length > existing.text.length) existing.text = text;
    }
  }
  return out;
}

async function fetchEngine(engine, query) {
  let statusCode = 0;
  let body = '';
  try {
    const response = await httpGet(engine.url(query), engine.headers);
    statusCode = response.statusCode;
    body = response.body;
  } catch (_) {
    // fall through to the obscura retry below
  }

  let via = 'plain';
  if (looksChallenged(statusCode, body) && obscuraBinaryPresent()) {
    // Same engine URL re-fetched through the stealth browser: real JS,
    // real Chrome-145 fingerprint, TLS impersonation. Fixes JS-challenge
    // walls (DDG anomaly pages, consent pages) that plain HTTPS cannot pass.
    const rendered = await fetchHtmlViaCli(engine.url(query), 15);
    if (rendered && !looksChallenged(200, rendered)) {
      body = rendered;
      statusCode = 200; // the rendered page IS the new source of truth
      via = 'obscura';
      console.log(`engine '${engine.name}' rescued via obscura (${rendered.length} bytes)`); // eslint-disable-line no-console
    }
  }

  const empty = !body || statusCode !== 200;
  const found = empty ? new Map() : collectCandidates(body);
  // One line per engine per query: shows in the host log WHY a search came
  // back empty (blocked / challenged / simply no instagram links).
  console.log( // eslint-disable-line no-console
    `[engine] ${engine.name} status=${statusCode} len=${(body || '').length} ` +
    `via=${via} challenged=${looksChallenged(statusCode, body)} found=${found.size}`
  );
  if (fetchEngine.debugSink) {
    fetchEngine.debugSink.push({
      engine: engine.name,
      status: statusCode,
      length: (body || '').length,
      via,
      challenged: looksChallenged(statusCode, body),
      found: found.size,
      igMentions: ((body || '').match(/instagram\.com/g) || []).length,
      bingLinks: ((body || '').match(/[?&;]u=a1/g) || []).length,
      head: (body || '').replace(/\s+/g, ' ').slice(0, 160),
    });
  }
  return found;
}

// Cheap heuristics for challenge/bot walls and junk responses.
function looksChallenged(statusCode, body) {
  if (statusCode !== 200) return true;
  if (!body || body.length < 3000) return true;
  // Scan the WHOLE body - challenge markers (Google's "unusual traffic",
  // DDG's anomaly page) often sit deep behind megabytes of page chrome.
  if (/anomaly|are you a human|unusual traffic|captcha|verify you are/i.test(body)) return true;
  if (body.includes('anomaly-detection') || body.includes('id="challenge')) return true;
  return false;
}

// ── Instagram hashtag search with the IG_COOKIE session ──────────────────
// The song title becomes a hashtag (#aanewalastar); Instagram's own
// web_info endpoint returns the top + recent media for it, with the
// shortcode and caption of every post. Needs a logged-in cookie.

function cookieHeaders() {
  const cookie = process.env.IG_COOKIE || '';
  const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookie);
  return {
    'user-agent': BROWSER_UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    cookie,
    'x-ig-app-id': '936619743392459',
    'x-requested-with': 'XMLHttpRequest',
    referer: 'https://www.instagram.com/',
    ...(csrf ? { 'x-csrftoken': csrf[1] } : {}),
  };
}

function tagCandidates(title) {
  const words = String(title)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tags = [];
  const full = words.join('');
  if (full.length >= 4 && full.length <= 40) tags.push(full);
  if (words.length > 2) {
    const firstTwo = words.slice(0, 2).join('');
    if (firstTwo.length >= 5 && !tags.includes(firstTwo)) tags.push(firstTwo);
  }
  return tags.slice(0, 2);
}

function collectMedia(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectMedia(n, out, depth + 1));
    return;
  }
  if (typeof node.code === 'string' && node.code.length >= 5 &&
      (node.media_type === 2 || Array.isArray(node.video_versions))) {
    out.push(node);
    return;
  }
  Object.values(node).forEach((v) => collectMedia(v, out, depth + 1));
}

async function searchViaCookie(title) {
  const found = new Map();
  for (const tag of tagCandidates(title)) {
    const url = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`;
    let response;
    try {
      response = await httpGet(url, cookieHeaders());
    } catch (e) {
      console.log(`[cookie-search] #${tag} error: ${e.message}`); // eslint-disable-line no-console
      continue;
    }
    console.log(`[cookie-search] #${tag} status=${response.statusCode} len=${response.body.length}`); // eslint-disable-line no-console
    if (response.statusCode !== 200) continue;
    let json;
    try {
      json = JSON.parse(response.body);
    } catch (_) {
      continue;
    }
    const medias = [];
    collectMedia(json, medias);
    for (const m of medias) {
      if (found.has(m.code)) continue;
      const caption = (m.caption && m.caption.text) ? String(m.caption.text) : '';
      found.set(m.code, {
        code: m.code,
        // The post is under this song's hashtag, so the title is part of
        // its text for the app-side scoring.
        text: `${title} ${caption}`.replace(/\s+/g, ' ').slice(0, 200),
        isReel: m.product_type === 'clips',
      });
    }
    if (found.size >= 12) break;
  }
  return Array.from(found.values());
}

// Run all engines in parallel for one query and merge their candidates.
// Returns [{ code, text, isReel }] — empty when every engine failed or
// found nothing (the app then tries its own on-device engines).
async function searchReels(query, title) {
  const normalized = String(query || '').trim();
  if (normalized.length < 3) {
    return [];
  }

  const cached = searchCache.get(normalized);
  if (cached) {
    const ttl = cached.results.length > 0 ? SEARCH_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.results;
  }

  // Identical queries arriving together (several app sessions / retries)
  // share one engine run instead of each hammering the engines.
  const running = inflight.get(normalized);
  if (running) return running;
  const job = runSearch(normalized, title).finally(() => inflight.delete(normalized));
  inflight.set(normalized, job);
  return job;
}

async function runSearch(normalized, title) {
  const settled = await Promise.allSettled(
    ENGINES.map((engine) => fetchEngine(engine, normalized))
  );

  const merged = new Map(); // code -> { text, isReel }
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') continue;
    for (const [code, cand] of entry.value) {
      const existing = merged.get(code);
      if (!existing) {
        merged.set(code, { ...cand });
      } else {
        existing.isReel = existing.isReel || cand.isReel;
        if (cand.text.length > existing.text.length) existing.text = cand.text;
      }
    }
  }

  let results = Array.from(merged.entries()).map(([code, cand]) => ({
    code,
    text: cand.text.slice(0, 200),
    isReel: cand.isReel,
  }));

  // Web engines blocked / empty -> ask Instagram itself with the session
  // cookie (IG_COOKIE). Only runs when a cookie is configured.
  if (results.length === 0 && process.env.IG_COOKIE && title) {
    try {
      results = await searchViaCookie(String(title));
    } catch (e) {
      console.log(`[cookie-search] failed: ${e.message}`); // eslint-disable-line no-console
    }
  }

  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(normalized, { at: Date.now(), results });

  return results;
}

// Diagnostic: run every engine once for [query] (no cache) and report what
// each really answered. Used by GET /api/search-debug.
async function debugEngines(query) {
  const sink = [];
  fetchEngine.debugSink = sink;
  try {
    await Promise.allSettled(ENGINES.map((e) => fetchEngine(e, String(query))));
  } finally {
    fetchEngine.debugSink = null;
  }
  return sink;
}

module.exports = { searchReels, debugEngines };
