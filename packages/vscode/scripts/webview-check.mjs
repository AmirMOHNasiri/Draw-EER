/**
 * Loads the real preview page in headless Chrome or Chromium and checks that
 * it draws a diagram:
 *
 *   npm run check:webview [-- --screenshot out/preview.png]
 *
 * The page is the one the extension builds (src/html.ts), Content Security
 * Policy included, with the built scripts, HarfBuzz and the fonts inlined as
 * data: URLs in place of the webview's resource URLs, and a stand-in for
 * VS Code's `acquireVsCodeApi` that sends the library fixture. The browser is
 * driven over a pipe (--remote-debugging-pipe), so no network port is opened.
 *
 * This caught a bug no other test could: the worker inherits the page's
 * policy, and compiling WebAssembly needs 'wasm-unsafe-eval'.
 *
 * Skips (and succeeds) when no Chrome or Chromium is installed, unless
 * --require is given.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { dist, root } from './options.mjs';

const args = process.argv.slice(2);
const screenshot = args.includes('--screenshot') ? args[args.indexOf('--screenshot') + 1] : null;
const browser = findBrowser();
if (!browser) {
  console.log('No Chrome or Chromium found (set CHROME_PATH); skipping the webview check.');
  process.exit(args.includes('--require') ? 1 : 0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'draw-eer-webview-'));
try {
  // The page exactly as the extension builds it.
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
  const nonce = 'webviewcheck';
  const source = await readFile(path.join(root, '../core/test/fixtures/library.eer'), 'utf8');
  let page = previewHtml({
    cspSource: 'data:',
    asset: (file) => inline[file],
    nonce,
    document: 'file:///library.eer',
  });
  // What VS Code provides: theme variables on <body>, and the webview API.
  const stub = `<script nonce="${nonce}">
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    if (m.type === 'ready')
      setTimeout(() => window.postMessage({ type: 'source', text: ${JSON.stringify(source)}, version: 1 }, '*'), 0);
  },
  getState() { return undefined; },
  setState(state) { window.__state = state; },
});
</script>`;
  page = page
    .replace(
      '<body>',
      '<body class="vscode-dark" style="--vscode-editor-foreground:#d4d4d4;--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-foreground:#cccccc">',
    )
    .replace(`<script nonce="${nonce}" src=`, `${stub}\n<script nonce="${nonce}" src=`);
  const pagePath = path.join(temp, 'preview.html');
  await writeFile(pagePath, page);

  const result = await inspect(pathToFileURL(pagePath).href, screenshot);
  const failures = [];
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  check(result.svg, 'the preview draws the diagram');
  check(result.persian, 'Persian names are in the drawing');
  check(result.font, 'the Vazirmatn font is loaded');
  check(
    result.status === '',
    `no error is shown${result.status ? ` (shows "${result.status}")` : ''}`,
  );
  check(
    result.scale > 0 && result.scale <= 1,
    `the diagram is fitted to the window (scale ${result.scale.toFixed(2)})`,
  );
  check(result.interaction?.zoomedIn, 'the mouse wheel zooms in');
  check(result.interaction?.panned, 'dragging pans');
  check(result.interaction?.refitted, 'double-click fits the diagram again');
  if (screenshot) console.log(`screenshot: ${screenshot}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}

function findBrowser() {
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

/** Opens `url`, waits until a diagram is shown (or 20 s pass), and reports on the page. */
async function inspect(url, screenshotPath) {
  const chrome = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--remote-debugging-pipe',
      '--window-size=1400,800',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const [toChrome, fromChrome] = [chrome.stdio[3], chrome.stdio[4]];
  let id = 0;
  let buffer = '';
  const waiting = new Map();
  fromChrome.on('data', (data) => {
    buffer += data;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message.result);
      waiting.delete(message.id);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      toChrome.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.navigate', { url }, sessionId);
    const evaluate = async (expression) =>
      (
        await send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
      ).result.value;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await evaluate("!!document.querySelector('#canvas svg')"))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const report = await evaluate(`(async () => {
      await document.fonts.ready;
      const svg = document.querySelector('#canvas svg');
      return {
        svg: !!svg,
        persian: !!svg && svg.textContent.includes('کتابخانه'),
        font: document.fonts.check("16px 'Vazirmatn'", 'کتابخانه'),
        status: document.getElementById('status').textContent,
        scale: window.__state ? window.__state.view.scale : 0,
      };
    })()`);
    // Zoom with the wheel, drag to pan, then double-click to fit again.
    report.interaction = await evaluate(`(() => {
      const viewport = document.getElementById('viewport');
      const fitted = window.__state.view.scale;
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 700, clientY: 400, cancelable: true }));
      const zoomed = window.__state.view;
      const at = (type, x, y) => viewport.dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true }));
      viewport.setPointerCapture = () => {};
      at('pointerdown', 500, 400); at('pointermove', 560, 430); at('pointerup', 560, 430);
      const panned = window.__state.view;
      viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const refitted = window.__state.view;
      return {
        zoomedIn: zoomed.scale > fitted && !zoomed.fitted,
        panned: Math.abs(panned.x - zoomed.x - 60) < 0.01 && Math.abs(panned.y - zoomed.y - 30) < 0.01,
        refitted: refitted.fitted && Math.abs(refitted.scale - fitted) < 1e-9,
      };
    })()`);
    if (screenshotPath) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(screenshotPath, Buffer.from(data, 'base64'));
    }
    return report;
  } finally {
    chrome.kill();
  }
}
