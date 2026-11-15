// Obscura (Rust single-binary headless browser) integration.
//
// Why: full Chromium (puppeteer's bundled download) fails to install or run
// on small serverless VMs, and JS-challenged pages (search engines, IG
// checkpoints) cannot be fetched with plain HTTPS. Obscura is ONE static
// binary (~63 MB, zero system deps) that renders pages with real JS and
// exposes the Chrome DevTools Protocol - so puppeteer.connect() works
// against `obscura serve` exactly like against Chrome.
//
// Public surface:
//   obscuraBinaryPresent()          -> boolean (no download attempted)
//   ensureObscuraBinary()           -> path | null (downloads when allowed)
//   ensureObscuraServe()            -> 'http://127.0.0.1:PORT' | null
//   fetchHtmlViaCli(url, timeoutSec)-> html string ('' on any failure)
//   obscuraStatus()                 -> { enabled, binaryPath, present,
//                                       autoDownload, port, serveUp }
//
// Everything here is fail-soft: any failure returns null/'' and the caller
// falls back to its previous path. The service never depends on Obscura.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const https = require('https');

const OBSCURA_ENABLED = process.env.OBSCURA_ENABLED !== '0';
const OBSCURA_VERSION = process.env.OBSCURA_VERSION || 'v0.2.6';
const OBSCURA_AUTO_DOWNLOAD = process.env.OBSCURA_AUTO_DOWNLOAD !== '0'; // on by default
const OBSCURA_PORT = parseInt(process.env.OBSCURA_PORT, 10) || 9222;
const OBSCURA_SERVE_TIMEOUT_MS = parseInt(process.env.OBSCURA_SERVE_TIMEOUT_MS, 10) || 15000;
const OBSCURA_DIR = process.env.OBSCURA_DIR || path.join(os.tmpdir(), 'obscura-bin');

const RELEASE_URL_TEMPLATE =
  'https://github.com/h4ckf0r0day/obscura/releases/download/{ver}/obscura-{arch}-linux-no-render-stealth.tar.gz';

// Candidate locations, in order.
function binaryCandidates() {
  const list = [];
  if (process.env.OBSCURA_PATH) list.push(process.env.OBSCURA_PATH);
  list.push(path.join(process.cwd(), 'bin', 'obscura'));
  list.push(path.join(process.cwd(), 'obscura'));
  list.push(path.join(OBSCURA_DIR, 'obscura'));
  return list;
}

function findBinary() {
  if (!OBSCURA_ENABLED) return null;
  for (const candidate of binaryCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function obscuraBinaryPresent() {
  return findBinary() !== null;
}

// Download the release tarball and extract ONLY the main binary (the worker
// binary is not needed for `fetch` or `serve` - verified on v0.2.6).
function ensureObscuraBinary() {
  if (!OBSCURA_ENABLED) return Promise.resolve(null);

  const found = findBinary();
  if (found) return Promise.resolve(found);
  if (!OBSCURA_AUTO_DOWNLOAD) return Promise.resolve(null);

  if (!ensureObscuraBinary._promise) {
    ensureObscuraBinary._promise = downloadAndExtract()
      .then((p) => p)
      .catch((error) => {
        console.log(`Obscura auto-download failed (non-fatal): ${error.message}`); // eslint-disable-line no-console
        return null;
      })
      .then((result) => {
        ensureObscuraBinary._promise = null; // allow a later retry
        return result;
      });
  }
  return ensureObscuraBinary._promise;
}

function downloadAndExtract() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const url = RELEASE_URL_TEMPLATE
    .replace('{ver}', OBSCURA_VERSION)
    .replace('{arch}', arch);

  fs.mkdirSync(OBSCURA_DIR, { recursive: true });
  const tarball = path.join(OBSCURA_DIR, `obscura-${OBSCURA_VERSION}.tar.gz`);

  return downloadFile(url, tarball, 180000).then(() => new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', tarball, '-C', OBSCURA_DIR, 'obscura'], {
      stdio: 'ignore',
    });
    tar.on('error', reject);
    tar.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited ${code}`));
        return;
      }
      const bin = path.join(OBSCURA_DIR, 'obscura');
      try {
        fs.chmodSync(bin, 0o755);
      } catch (chmodError) {
        reject(chmodError);
        return;
      }
      resolve(fs.existsSync(bin) ? bin : null);
    });
  }));
}

function downloadFile(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = (target, redirectsLeft) => {
      const req = https.get(target, { headers: { 'User-Agent': 'insta-video-scraper' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          request(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`download status ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('download timed out')));
    };
    request(url, 3);
  });
}

function probeServe() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: OBSCURA_PORT, path: '/json/version', timeout: 900 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Lazy, concurrency-safe CDP server for puppeteer.connect().
// Returns the browserURL string, or null when Obscura is unavailable.
function ensureObscuraServe() {
  if (!OBSCURA_ENABLED) return Promise.resolve(null);

  if (!ensureObscuraServe._promise) {
    ensureObscuraServe._promise = (async () => {
      try {
        if (await probeServe()) {
          return `http://127.0.0.1:${OBSCURA_PORT}`; // already running (externally started)
        }
        const bin = await ensureObscuraBinary();
        if (!bin) return null;

        const child = spawn(bin, ['--stealth', 'serve', '--port', String(OBSCURA_PORT)], {
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        child.on('error', () => { /* handled by the probe below */ });

        const deadline = Date.now() + OBSCURA_SERVE_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (await probeServe()) {
            return `http://127.0.0.1:${OBSCURA_PORT}`;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      } catch (_) {
        return null;
      } finally {
        // Keep a short-lived cache: clear the promise so a later call can
        // retry if the server died in the meantime.
        setTimeout(() => { ensureObscuraServe._promise = null; }, 30000).unref();
      }
    })();
  }
  return ensureObscuraServe._promise;
}

// One-shot stealth render of a page through the CLI (`obscura fetch`).
// Returns the rendered HTML string, or '' on any failure. Never throws.
function fetchHtmlViaCli(targetUrl, timeoutSec = 20) {
  if (!OBSCURA_ENABLED) return Promise.resolve('');
  return ensureObscuraBinary().then((bin) => new Promise((resolve) => {
    if (!bin) { resolve(''); return; }
    let stdout = '';
    let done = false;
    const finish = (value) => {
      if (!done) { done = true; resolve(value); }
    };
    let child;
    try {
      child = spawn(bin, ['--stealth', 'fetch', targetUrl, '--dump', 'html', '--timeout', String(timeoutSec)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (_) {
      finish('');
      return;
    }
    const cap = 5 * 1024 * 1024;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(''));
    child.on('exit', () => finish(stdout));
    // Hard wall: CLI timeout + startup margin.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(stdout); }, (timeoutSec + 10) * 1000).unref();
  }));
}

function obscuraStatus() {
  return {
    enabled: OBSCURA_ENABLED,
    binaryPath: findBinary(),
    present: obscuraBinaryPresent(),
    autoDownload: OBSCURA_AUTO_DOWNLOAD,
    version: OBSCURA_VERSION,
    port: OBSCURA_PORT,
  };
}

module.exports = {
  obscuraBinaryPresent,
  ensureObscuraBinary,
  ensureObscuraServe,
  fetchHtmlViaCli,
  obscuraStatus,
};
