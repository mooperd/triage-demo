import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer';

function getArg(name, fallback) {
  const key = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(key));
  if (!match) return fallback;
  return match.slice(key.length);
}

const targetUrl = getArg('url', 'http://127.0.0.1:8000/nuclide-chart.html');
const outputDir = getArg('out', path.resolve(process.cwd(), 'debug'));
const timeoutMs = Number(getArg('timeout', '45000'));

await fs.mkdir(outputDir, { recursive: true });

const consoleEntries = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') {
      return;
    }

    const location = msg.location();
    consoleEntries.push({
      ts: new Date().toISOString(),
      source: 'console',
      level: type,
      text: msg.text(),
      url: location?.url || null,
      lineNumber: location?.lineNumber ?? null,
      columnNumber: location?.columnNumber ?? null
    });
  });

  page.on('pageerror', (err) => {
    consoleEntries.push({
      ts: new Date().toISOString(),
      source: 'pageerror',
      level: 'error',
      text: err?.stack || err?.message || String(err),
      url: null,
      lineNumber: null,
      columnNumber: null
    });
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure();
    consoleEntries.push({
      ts: new Date().toISOString(),
      source: 'network',
      level: 'error',
      text: `Request failed: ${request.url()} (${failure?.errorText || 'unknown'})`,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      lineNumber: null,
      columnNumber: null
    });
  });

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: timeoutMs });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const html = await page.evaluate(() => document.documentElement.outerHTML);

  const htmlPath = path.join(outputDir, 'page.html');
  const jsonPath = path.join(outputDir, 'console-errors.json');
  const txtPath = path.join(outputDir, 'console-errors.txt');

  await fs.writeFile(htmlPath, html, 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(consoleEntries, null, 2), 'utf8');

  const textReport = [
    `URL: ${targetUrl}`,
    `Captured at: ${new Date().toISOString()}`,
    `Entries: ${consoleEntries.length}`,
    ''
  ];

  for (const [index, entry] of consoleEntries.entries()) {
    textReport.push(`#${index + 1} [${entry.level}] [${entry.source}]`);
    textReport.push(entry.text);
    if (entry.url) {
      textReport.push(`at ${entry.url}${entry.lineNumber != null ? `:${entry.lineNumber}` : ''}`);
    }
    textReport.push('');
  }

  await fs.writeFile(txtPath, textReport.join('\n'), 'utf8');

  console.log(`Saved HTML: ${htmlPath}`);
  console.log(`Saved error JSON: ${jsonPath}`);
  console.log(`Saved error report: ${txtPath}`);
  console.log(`Total error/warning entries: ${consoleEntries.length}`);
} finally {
  await browser.close();
}
