/**
 * The real preview page in headless Chrome or Chromium, shared by the
 * webview check (webview-check.mjs) and the demo recording (demo.mjs).
 *
 * The page is the one the extension builds (src/html.ts), Content Security
 * Policy included, with the built scripts, HarfBuzz and the fonts inlined as
 * data: URLs in place of the webview's resource URLs, and a stand-in for
 * VS Code's `acquireVsCodeApi`. The browser is driven over a pipe
 * (--remote-debugging-pipe), so no network port is opened.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { dist, root } from './options.mjs';

/** Chrome or Chromium on this computer (CHROME_PATH first), or null. */
export function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // not installed
    }
  }
  return null;
}

export const NONCE = 'browserharness';

/** Dark theme colors as VS Code puts them on the webview's <body>. */
const DARK_BODY =
  '<body class="vscode-dark" style="--vscode-editor-foreground:#d4d4d4;--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-foreground:#cccccc;--vscode-font-family:system-ui,sans-serif">';

/**
 * Writes the preview page to `temp`/preview.html and returns its file URL.
 * When the page says it is ready, it is sent `source`. Messages the page
 * sends are collected in `window.__messages`, its saved state in
 * `window.__state`. `head` is extra markup for the page's <head>.
 */
export async function writePreviewPage(temp, { source, document, head = '' }) {
  const htmlModule = path.join(temp, 'html.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/html.ts')],
    outfile: htmlModule,
    format: 'esm',
    platform: 'node',
    bundle: true,
    logLevel: 'warning',
  });
  const { previewHtml } = await import(pathToFileURL(htmlModule).href);
  const types = {
    js: 'text/javascript',
    css: 'text/css',
    wasm: 'application/wasm',
    ttf: 'font/ttf',
  };
  const inline = {};
  for (const file of [
    'worker.js',
    'preview.js',
    'preview.css',
    'harfbuzz.wasm',
    'fonts/Vazirmatn-Regular.ttf',
    'fonts/Vazirmatn-Bold.ttf',
  ]) {
    const type = types[file.split('.').pop()];
    inline[file] =
      `data:${type};base64,${(await readFile(path.join(dist, file))).toString('base64')}`;
  }
  let page = previewHtml({
    cspSource: 'data:',
    asset: (file) => inline[file],
    nonce: NONCE,
    document,
  });
  // What VS Code provides: theme variables on <body>, and the webview API.
  const stub = `<script nonce="${NONCE}">
window.__messages = [];
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__messages.push(m);
    if (m.type === 'ready')
      setTimeout(() => window.postMessage({ type: 'source', text: ${JSON.stringify(source)}, version: 1 }, '*'), 0);
  },
  getState() { return undefined; },
  setState(state) { window.__state = state; },
});
</script>`;
  page = page
    .replace('</head>', `${head}\n</head>`)
    .replace('<body>', DARK_BODY)
    .replace(`<script nonce="${NONCE}" src=`, `${stub}\n<script nonce="${NONCE}" src=`);
  const pagePath = path.join(temp, 'preview.html');
  await writeFile(pagePath, page);
  return pathToFileURL(pagePath).href;
}

/**
 * Starts the browser on `url` (with a window of `width` × `height`) and
 * returns helpers to drive it. Rejects with the browser's own output if it
 * quits or refuses a command.
 */
export async function openPage(browser, url, { width = 1400, height = 800 } = {}) {
  const chrome = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      // Ubuntu 23.10 and later (GitHub's ubuntu-latest runners) block the user
      // namespaces Chrome's sandbox needs, and Chrome then quits at once. The
      // sandbox guards against hostile web pages; this only loads our own page
      // from a temporary file, with no network access.
      '--no-sandbox',
      '--remote-debugging-pipe',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const [toChrome, fromChrome] = [chrome.stdio[3], chrome.stdio[4]];
  // The browser's messages, shown only if something goes wrong.
  let log = '';
  chrome.stderr.on('data', (data) => (log = (log + data).slice(-4000)));

  let id = 0;
  let buffer = '';
  /** Pending commands by id: [resolve, reject]. */
  const waiting = new Map();
  let failure = null;
  let closing = false;
  const fail = (what) => {
    failure ??= new Error(`${what}${log.trim() ? `\nChrome's output:\n${log.trim()}` : ''}`);
    for (const [, reject] of waiting.values()) reject(failure);
    waiting.clear();
  };
  chrome.on('error', (error) => fail(`could not start ${browser}: ${error.message}`));
  chrome.on('exit', (code, signal) => {
    // Give stderr a moment to arrive, so the message says why it quit.
    if (!closing)
      setTimeout(() => fail(`Chrome quit early (exit code ${code}, signal ${signal})`), 100);
  });
  // A closed pipe means the browser is gone; 'exit' explains why.
  toChrome.on('error', () => {});
  fromChrome.on('error', () => {});

  fromChrome.on('data', (data) => {
    buffer += data;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const [resolve, reject] = waiting.get(message.id) ?? [];
      waiting.delete(message.id);
      if (message.error) reject?.(new Error(`${message.error.message} (${message.error.code})`));
      else resolve?.(message.result);
    }
  });
  const command = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting.set(++id, [resolve, reject]);
      toChrome.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });

  try {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await command('Page.navigate', { url }, sessionId);
    const send = (method, params = {}) => command(method, params, sessionId);
    return {
      send,
      /** Runs `expression` in the page and returns its (awaited) value. */
      async evaluate(expression) {
        const { result, exceptionDetails } = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        // An exception in the script itself must not pass for a result.
        if (exceptionDetails) {
          const error = exceptionDetails.exception?.description ?? exceptionDetails.text;
          throw new Error(`the script failed in the page: ${error}`);
        }
        return result.value;
      },
      /** A PNG of the page as shown. */
      async screenshot() {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        return Buffer.from(data, 'base64');
      },
      close() {
        closing = true;
        chrome.kill();
      },
    };
  } catch (error) {
    closing = true;
    chrome.kill();
    throw error;
  }
}
