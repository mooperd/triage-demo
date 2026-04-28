import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const HOST = process.env.UI_HOST || '127.0.0.1';
const PORT = Number(process.env.UI_PORT || 8787);
const BROWSER_URL = process.env.CHROME_BROWSER_URL || 'http://127.0.0.1:9222';
const CONNECT_TIMEOUT_MS = Number(process.env.UI_CONNECT_TIMEOUT_MS || 6000);
const UI_FILE = path.join(rootDir, 'ui', 'attached-bot-ui.html');
const SHOT_DIR = path.join(rootDir, 'debug', 'screenshots');
const TRACE_DIR = path.join(rootDir, 'debug', 'traces');
let nextConsoleId = 1;
let nextRequestId = 1;
let activeTrace = null;
const pendingDialogs = new WeakMap();
const requestDetailsById = new Map();

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function toPublicError(err) {
  return err instanceof Error ? err.message : String(err);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function ensureBrowser() {
  if (browser?.connected) return browser;

  const connectedBrowser = await withTimeout(
    puppeteer.connect({
      browserURL: BROWSER_URL,
      protocolTimeout: CONNECT_TIMEOUT_MS,
    }),
    CONNECT_TIMEOUT_MS,
    'Connecting to Chrome DevTools',
  );

  connectedBrowser.once('disconnected', () => {
    if (browser === connectedBrowser) {
      browser = null;
      activeTrace = null;
    }
  });

  browser = connectedBrowser;
  return browser;
}

function pageMeta(pages) {
  return Promise.all(
    pages.map(async (p, index) => ({
      index,
      url: p.url(),
      title: await p.title().catch(() => ''),
      selected: index === selectedPageIndex,
    })),
  );
}

function ensurePageObservers(page) {
  if (observedPages.has(page)) return;

  observedPages.add(page);
  pageLogs.set(page, { console: [], network: [], snapshots: [] });

  const pushConsole = entry => {
    const logs = pageLogs.get(page);
    if (!logs) return;
    logs.console.push(entry);
    if (logs.console.length > 800) logs.console.shift();
  };

  const pushNetwork = entry => {
    const logs = pageLogs.get(page);
    if (!logs) return;
    logs.network.push(entry);
    if (logs.network.length > 1200) logs.network.shift();
  };

  page.on('console', msg => {
    const entry = {
      id: nextConsoleId++,
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      timestamp: nowIso(),
    };
    pushConsole(entry);
  });

  page.on('dialog', dialog => {
    pendingDialogs.set(page, dialog);
    const entry = {
      id: nextConsoleId++,
      type: 'dialog',
      text: `${dialog.type()}: ${dialog.message()}`,
      location: null,
      timestamp: nowIso(),
    };
    pushConsole(entry);
  });

  page.on('requestfinished', async req => {
    const response = req.response();
    const reqId = nextRequestId++;

}

async function serveUi(res) {
  const html = await fs.readFile(UI_FILE, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    const url = new URL(req.url || '/', 'http://local');

    if (url.pathname === '/api/status' && req.method === 'GET') {
      let connected = false;
      let message = 'not connected';
      try {
        await ensureBrowser();
        connected = true;
        message = 'connected';
      } catch (err) {
        message = toPublicError(err);
      }
      return json(res, 200, { ok: true, connected, browserURL: BROWSER_URL, message });
    }

    if (url.pathname === '/api/pages' && req.method === 'GET') {
      try {
        const pages = await getPages();
        return json(res, 200, {
          ok: true,
          selectedIndex: selectedPageIndex,
          pages: await pageMeta(pages),
          connected: true,
        });
      } catch (err) {
        return json(res, 200, {
          ok: true,
          selectedIndex: -1,
          pages: [],
          connected: false,
          error: toPublicError(err),
        });
      }
    }

    if (url.pathname === '/api/select-page' && req.method === 'POST') {
      const body = await readBody(req);
      const pages = await getPages();
      const idx = Number(body.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
        return json(res, 400, { ok: false, error: `Invalid page index: ${body.index}` });
      }
      selectedPageIndex = idx;
      return json(res, 200, { ok: true, selectedIndex: selectedPageIndex });
    }

    if (url.pathname === '/api/new-page' && req.method === 'POST') {
      const body = await readBody(req);
      const targetUrl = String(body.url || 'about:blank');
      const b = await ensureBrowser();
      const page = await b.newPage();
      ensurePageObservers(page);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const pages = await getPages();
      selectedPageIndex = pages.findIndex(p => p === page);
      return json(res, 200, { ok: true, selectedIndex: selectedPageIndex, url: page.url() });
    }

    if (url.pathname === '/api/close-page' && req.method === 'POST') {
      const body = await readBody(req);
      const pages = await getPages();
      const idx = Number(body.index ?? selectedPageIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
        return json(res, 400, { ok: false, error: `Invalid page index: ${idx}` });
      }
      if (pages.length <= 1) {
        return json(res, 400, { ok: false, error: 'Cannot close the last page.' });
      }
      await pages[idx].close();
      selectedPageIndex = Math.max(0, Math.min(selectedPageIndex, pages.length - 2));
      return json(res, 200, { ok: true, selectedIndex: selectedPageIndex });
    }

    if (url.pathname === '/api/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const targetUrl = String(body.url || '').trim();
      if (!targetUrl) return json(res, 400, { ok: false, error: 'Missing url.' });
      const page = await getSelectedPage();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return json(res, 200, { ok: true, url: page.url() });
    }

    if (url.pathname === '/api/history' && req.method === 'POST') {
      const body = await readBody(req);
      const direction = body.direction === 'forward' ? 'forward' : 'back';
      const page = await getSelectedPage();
      const fn = direction === 'back' ? page.goBack.bind(page) : page.goForward.bind(page);
      await fn({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      return json(res, 200, { ok: true, direction, url: page.url() });
    }

    if (url.pathname === '/api/reload' && req.method === 'POST') {
      const page = await getSelectedPage();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return json(res, 200, { ok: true, url: page.url() });
    }

    if (url.pathname === '/api/wait-for' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const timeout = Number(body.timeout || 10000);
      if (!text) return json(res, 400, { ok: false, error: 'Missing text.' });
      const page = await getSelectedPage();
      await page.waitForFunction(
        value => document.body?.innerText?.includes(value),
        { timeout: Number.isFinite(timeout) ? timeout : 10000 },
        text,
      );
      return json(res, 200, { ok: true, text, found: true });
    }

    if (url.pathname === '/api/evaluate' && req.method === 'POST') {
      const body = await readBody(req);
      const code = String(body.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'Missing code.' });
      const page = await getSelectedPage();
      const result = await page.evaluate(new Function(code));
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/screenshot' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      await fs.mkdir(SHOT_DIR, { recursive: true });
      const fileName = `shot-${Date.now()}.png`;
      const filePath = path.join(SHOT_DIR, fileName);
      await page.screenshot({ path: filePath, fullPage: body.fullPage !== false });
      return json(res, 200, {
        ok: true,
        filePath,
        relativePath: path.relative(rootDir, filePath),
      });
    }

    if (url.pathname === '/api/console' && req.method === 'GET') {
      const page = await getSelectedPage();
      const logs = pageLogs.get(page) || { console: [] };
      return json(res, 200, { ok: true, messages: logs.console.slice(-200) });
    }

    if (url.pathname === '/api/network' && req.method === 'GET') {
      const page = await getSelectedPage();
      const logs = pageLogs.get(page) || { network: [] };
      return json(res, 200, { ok: true, requests: logs.network.slice(-300) });
    }

    if (url.pathname === '/api/clear-logs' && req.method === 'POST') {
      const page = await getSelectedPage();
      const logs = pageLogs.get(page);
      if (logs) {
        logs.console.length = 0;
        logs.network.length = 0;
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    return json(res, 500, { ok: false, error: toPublicError(err) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://local');

  if (url.pathname === '/') {
    return serveUi(res);
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[attached-ui] Listening on http://${HOST}:${PORT}`);
  console.log(`[attached-ui] Target browser URL: ${BROWSER_URL}`);
  console.log('[attached-ui] Start Chrome with remote debugging if not already running:');
  console.log('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable');
});
