const express = require('express');
const cors = require('cors')
const createError = require('http-errors');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const helmet = require('helmet');

const indexRouter = require('./routes/index');

const scraperHandler = require('./middleware/scraperHandler');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Health + diagnostics endpoints - registered BEFORE the scraper middleware
// so platform checks and debugging never pay the Chromium startup cost.
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'insta-video-scraper' });
});

app.get('/api/diag', async (req, res) => {
  const fs = require('fs');
  const puppeteer = require('puppeteer');
  const { obscuraStatus, ensureObscuraServe } = require('./lib/obscura_client');

  let chromiumPath = null;
  let chromiumPresent = false;
  let chromiumPathError = null;
  try {
    chromiumPath = puppeteer.executablePath();
    chromiumPresent = fs.existsSync(chromiumPath);
  } catch (pathError) {
    chromiumPathError = pathError.message;
  }

  let launchTest = 'skipped (add ?launch=1)';
  if (req.query.launch === '1') {
    try {
      const browser = await puppeteer.launch(scraperHandler.browserOptions);
      await browser.close();
      launchTest = 'ok';
    } catch (launchError) {
      launchTest = `failed: ${launchError.message}`;
    }
  }

  // Obscura (stealth Rust browser): report presence; start the CDP server
  // only when ?obscura=1 is passed, so plain health checks stay instant.
  const obscura = obscuraStatus();
  obscura.serveUp = false;
  if (req.query.obscura === '1') {
    const serveUrl = await ensureObscuraServe();
    obscura.serveUp = Boolean(serveUrl);
    obscura.serveUrl = serveUrl;
  }

  res.status(200).json({
    node: process.version,
    chromiumPath,
    chromiumPresent,
    chromiumPathError,
    launchTest,
    obscura,
    igCookieSet: Boolean(process.env.IG_COOKIE),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Tolerate clients whose base URL ends with '/' (requests like
// //api/search used to 404): collapse leading duplicate slashes.
app.use((req, res, next) => {
  if (req.url.startsWith('//')) req.url = req.url.replace(/^\/{2,}/, '/');
  next();
});

app.use(cors());
app.use(helmet()); // https://expressjs.com/en/advanced/best-practice-security.html#use-helmet
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(scraperHandler);

app.use('/api', indexRouter);

// catch 404 and forward to error handler
app.use((req, res, next) => {
  next(createError.NotFound());
});

// pass any unhandled errors to the error handler
app.use(errorHandler);

module.exports = app;
