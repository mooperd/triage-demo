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

let browser = null;
let selectedPageIndex = 0;
let nextConsoleId = 1;
let nextRequestId = 1;
let activeTrace = null;

const pageLogs = new WeakMap();
const observedPages = new WeakSet();
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

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isValidUid(uid) {
  return typeof uid === 'string' && /^[a-zA-Z0-9:_-]+$/.test(uid);
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
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(v => {
      clearTimeout(timer);
      resolve(v);
    }).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function ensureBrowser() {
  if (browser?.connected) return browser;

  const connected = await withTimeout(
    puppeteer.connect({ browserURL: BROWSER_URL, protocolTimeout: CONNECT_TIMEOUT_MS }),
    CONNECT_TIMEOUT_MS,
    'Connecting to Chrome DevTools',
  );

  connected.once('disconnected', () => {
    if (browser === connected) {
      browser = null;
      activeTrace = null;
    }
  });

  browser = connected;
  return browser;
}

function ensurePageObservers(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);

  pageLogs.set(page, { console: [], network: [] });

  page.on('console', msg => {
    const logs = pageLogs.get(page);
    if (!logs) return;
    logs.console.push({ id: nextConsoleId++, type: msg.type(), text: msg.text(), location: msg.location(), timestamp: nowIso() });
    if (logs.console.length > 500) logs.console.shift();
  });

  page.on('dialog', dialog => {
    pendingDialogs.set(page, dialog);
  });

  page.on('requestfinished', async req => {
    const response = req.response();
    let responseBody = null;
    try {
      responseBody = response ? await response.text() : null;
    } catch {
      responseBody = null;
    }

    const detail = {
      id: nextRequestId++,
      event: 'finished',
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: response?.status() ?? null,
      timestamp: nowIso(),
      requestHeaders: req.headers(),
      responseHeaders: response?.headers() ?? null,
      requestBody: req.postData() || null,
      responseBody,
    };

    requestDetailsById.set(detail.id, detail);
    const logs = pageLogs.get(page);
    if (!logs) return;
    logs.network.push(detail);
    if (logs.network.length > 1000) logs.network.shift();
  });

  page.on('requestfailed', req => {
    const detail = {
      id: nextRequestId++,
      event: 'failed',
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: null,
      failureText: req.failure()?.errorText || 'unknown',
      timestamp: nowIso(),
      requestHeaders: req.headers(),
      responseHeaders: null,
      requestBody: req.postData() || null,
      responseBody: null,
    };

    requestDetailsById.set(detail.id, detail);
    const logs = pageLogs.get(page);
    if (!logs) return;
    logs.network.push(detail);
    if (logs.network.length > 1000) logs.network.shift();
  });
}

async function getPages() {
  const b = await ensureBrowser();
  const pages = await b.pages();
  pages.forEach(ensurePageObservers);

  if (!pages.length) {
    const p = await b.newPage();
    ensurePageObservers(p);
    return [p];
  }

  if (selectedPageIndex >= pages.length) selectedPageIndex = pages.length - 1;
  if (selectedPageIndex < 0) selectedPageIndex = 0;
  return pages;
}

async function getSelectedPage() {
  const pages = await getPages();
  return pages[selectedPageIndex] || pages[0];
}

function uidSelector(uid) {
  if (!isValidUid(uid)) throw new Error(`Invalid uid: ${uid}`);
  return `[data-mcp-uid="${uid}"]`;
}

async function takeSnapshot(page) {
  return page.evaluate(() => {
    const root = document.body || document.documentElement;
    const nodes = [];
    if (!root) return { title: document.title, url: location.href, nodes, total: 0 };

    const seed = `m${Date.now().toString(36)}`;
    let index = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!(el instanceof Element)) continue;
      let uid = el.getAttribute('data-mcp-uid');
      if (!uid) {
        uid = `${seed}-${++index}`;
        el.setAttribute('data-mcp-uid', uid);
      }
      nodes.push({
        uid,
        tag: el.tagName.toLowerCase(),
        idAttr: el.id || null,
        typeAttr: el.getAttribute('type') || null,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }

    return { title: document.title, url: location.href, nodes, total: nodes.length };
  });
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
      try {
        await ensureBrowser();
        return json(res, 200, { ok: true, connected: true, browserURL: BROWSER_URL });
      } catch (err) {
        return json(res, 200, { ok: true, connected: false, browserURL: BROWSER_URL, message: toPublicError(err) });
      }
    }

    if (url.pathname === '/api/pages' && req.method === 'GET') {
      const pages = await getPages();
      const meta = await Promise.all(pages.map(async (p, index) => ({ index, url: p.url(), title: await p.title().catch(() => ''), selected: index === selectedPageIndex })));
      return json(res, 200, { ok: true, selectedIndex: selectedPageIndex, pages: meta, connected: true });
    }

    if (url.pathname === '/api/select-page' && req.method === 'POST') {
      const body = await readBody(req);
      const pages = await getPages();
      const idx = Number(body.index ?? body.pageId);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) return json(res, 400, { ok: false, error: `Invalid page index: ${body.index}` });
      selectedPageIndex = idx;
      return json(res, 200, { ok: true, selectedIndex: idx });
    }

    if (url.pathname === '/api/new-page' && req.method === 'POST') {
      const body = await readBody(req);
      const p = await (await ensureBrowser()).newPage();
      ensurePageObservers(p);
      await p.goto(String(body.url || 'about:blank'), { waitUntil: 'domcontentloaded', timeout: clampInt(body.timeout, 1, 120000, 20000) });
      const pages = await getPages();
      selectedPageIndex = pages.findIndex(x => x === p);
      return json(res, 200, { ok: true, selectedIndex: selectedPageIndex, url: p.url() });
    }

    if (url.pathname === '/api/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      const type = String(body.type || 'url');
      const timeout = clampInt(body.timeout, 1, 120000, 30000);
      if (type === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout }).catch(() => null);
      else if (type === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout }).catch(() => null);
      else if (type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout });
      else {
        const target = String(body.url || '').trim();
        if (!target) return json(res, 400, { ok: false, error: 'Missing url.' });
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      }
      return json(res, 200, { ok: true, url: page.url(), type });
    }

    if (url.pathname === '/api/wait-for' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.text) ? body.text : [body.text];
      const values = items.map(v => String(v || '').trim()).filter(Boolean);
      if (!values.length) return json(res, 400, { ok: false, error: 'Missing text.' });
      const page = await getSelectedPage();
      await page.waitForFunction((arr) => arr.some(v => (document.body?.innerText || '').includes(v)), { timeout: clampInt(body.timeout, 1, 120000, 10000) }, values);
      return json(res, 200, { ok: true, found: true, text: values });
    }

    if (url.pathname === '/api/evaluate' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      if (body.function) {
        const fn = new Function(`return (${String(body.function)});`)();
        const result = await page.evaluate(fn, ...(Array.isArray(body.args) ? body.args : []));
        return json(res, 200, { ok: true, result });
      }
      const code = String(body.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'Missing code or function.' });
      const result = await page.evaluate(new Function(code));
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/snapshot' && req.method === 'POST') {
      const page = await getSelectedPage();
      const snapshot = await takeSnapshot(page);
      return json(res, 200, { ok: true, snapshot });
    }

    if (url.pathname === '/api/click' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      const el = await page.$(uidSelector(String(body.uid || '')));
      if (!el) return json(res, 404, { ok: false, error: 'Element not found.' });
      await el.click({ clickCount: body.dblClick ? 2 : 1 });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/fill' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      const selector = uidSelector(String(body.uid || ''));
      await page.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Element not found.');
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          el.value = String(value ?? '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          throw new Error('Element is not fillable.');
        }
      }, { selector, value: body.value });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/press-key' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      await page.keyboard.press(String(body.key || 'Enter'));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/type-text' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      await page.keyboard.type(String(body.text || ''));
      if (body.submitKey) await page.keyboard.press(String(body.submitKey));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/handle-dialog' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      const dialog = pendingDialogs.get(page);
      if (!dialog) return json(res, 200, { ok: true, handled: false });
      if (body.action === 'dismiss') await dialog.dismiss();
      else await dialog.accept(typeof body.promptText === 'string' ? body.promptText : undefined);
      pendingDialogs.delete(page);
      return json(res, 200, { ok: true, handled: true });
    }

    if (url.pathname === '/api/emulate' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      if (body.viewport) {
        const m = String(body.viewport).match(/^(\d+)x(\d+)(?:x([\d.]+))?/);
        if (m) {
          await page.setViewport({ width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: Number(m[3] || 1) });
        }
      }
      if (body.colorScheme === 'dark' || body.colorScheme === 'light') {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: body.colorScheme }]);
      }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/resize-page' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      const width = clampInt(body.width, 100, 5000, 1280);
      const height = clampInt(body.height, 100, 5000, 800);
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      return json(res, 200, { ok: true, width, height });
    }

    if (url.pathname === '/api/performance/start-trace' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      if (activeTrace?.page === page) return json(res, 400, { ok: false, error: 'Trace already active.' });
      await fs.mkdir(TRACE_DIR, { recursive: true });
      const filePath = body.filePath ? (path.isAbsolute(body.filePath) ? body.filePath : path.join(rootDir, body.filePath)) : path.join(TRACE_DIR, `trace-${Date.now()}.json`);
      await page.tracing.start({ path: filePath, screenshots: false });
      activeTrace = { page, filePath, startedAt: Date.now() };
      if (body.autoStop) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.tracing.stop();
        const out = activeTrace;
        activeTrace = null;
        return json(res, 200, { ok: true, autoStopped: true, filePath: out.filePath });
      }
      return json(res, 200, { ok: true, started: true, filePath });
    }

    if (url.pathname === '/api/performance/stop-trace' && req.method === 'POST') {
      const page = await getSelectedPage();
      if (!activeTrace || activeTrace.page !== page) return json(res, 400, { ok: false, error: 'No active trace.' });
      const out = activeTrace;
      await page.tracing.stop();
      activeTrace = null;
      return json(res, 200, { ok: true, filePath: out.filePath, durationMs: Date.now() - out.startedAt });
    }

    if (url.pathname === '/api/console' && req.method === 'GET') {
      const logs = pageLogs.get(await getSelectedPage()) || { console: [] };
      return json(res, 200, { ok: true, messages: logs.console.slice(-200) });
    }

    if (url.pathname === '/api/console-message' && req.method === 'GET') {
      const id = Number(url.searchParams.get('msgid'));
      const logs = pageLogs.get(await getSelectedPage()) || { console: [] };
      const hit = logs.console.find(x => x.id === id);
      if (!hit) return json(res, 404, { ok: false, error: 'Message not found.' });
      return json(res, 200, { ok: true, message: hit });
    }

    if (url.pathname === '/api/network' && req.method === 'GET') {
      const logs = pageLogs.get(await getSelectedPage()) || { network: [] };
      return json(res, 200, { ok: true, requests: logs.network.slice(-300) });
    }

    if (url.pathname === '/api/network-request' && req.method === 'GET') {
      const reqid = Number(url.searchParams.get('reqid'));
      if (!Number.isInteger(reqid)) {
        const logs = pageLogs.get(await getSelectedPage()) || { network: [] };
        const latest = logs.network[logs.network.length - 1];
        if (!latest) return json(res, 404, { ok: false, error: 'No requests.' });
        return json(res, 200, { ok: true, request: latest });
      }
      const hit = requestDetailsById.get(reqid);
      if (!hit) return json(res, 404, { ok: false, error: 'Request not found.' });
      return json(res, 200, { ok: true, request: hit });
    }

    if (url.pathname === '/api/screenshot' && req.method === 'POST') {
      const body = await readBody(req);
      const page = await getSelectedPage();
      await fs.mkdir(SHOT_DIR, { recursive: true });
      const out = body.filePath ? (path.isAbsolute(body.filePath) ? body.filePath : path.join(rootDir, body.filePath)) : path.join(SHOT_DIR, `shot-${Date.now()}.png`);
      if (body.uid) {
        const el = await page.$(uidSelector(String(body.uid)));
        if (!el) return json(res, 404, { ok: false, error: 'Element not found.' });
        await el.screenshot({ path: out });
      } else {
        await page.screenshot({ path: out, fullPage: body.fullPage !== false });
      }
      return json(res, 200, { ok: true, filePath: out, relativePath: path.relative(rootDir, out) });
    }

    if (url.pathname === '/api/clear-logs' && req.method === 'POST') {
      const logs = pageLogs.get(await getSelectedPage());
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
  if (url.pathname === '/') return serveUi(res);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[attached-ui] Listening on http://${HOST}:${PORT}`);
  console.log(`[attached-ui] Target browser URL: ${BROWSER_URL}`);
  console.log('[attached-ui] Start Chrome with remote debugging if not already running:');
  console.log('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable');
});
